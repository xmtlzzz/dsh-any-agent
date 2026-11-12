/**
 * 回合记录与会话级执行队列。Hub 持久化收据及终态，队列的任务正文留在内存。
 *
 * 回合记录（run）让"先派活、回头再验收"成为一等公民：每条含
 * {run_id, status, 时间, prompt 预览, result}，只留最近 MAX_RUNS 条。
 * 队列是会话忙时非阻塞入队的待执行任务。
 *
 * 从 conversation.mjs 拆出来，只管簿记；什么时候真正发出一个回合、取消时写哨兵、
 * live 事件，仍由会话负责。
 */

import { normalizeReviewMode } from './review.mjs';
import { createHash, randomBytes } from 'node:crypto';

/** 保留的回合记录条数（run 结果含正文，所以只留最近若干条）。 */
export const MAX_RUNS = 20;
/** 回合记录里 prompt 预览的长度。 */
const MAX_RUN_PREVIEW = 200;
/** 队列上限。 */
export const MAX_QUEUE = 8;

export const previewOf = (text) => (text.length > MAX_RUN_PREVIEW ? `${text.slice(0, MAX_RUN_PREVIEW)}…` : text);

export function keyedRunId(clientRunId) {
  return `run-key-${createHash('sha256').update(clientRunId).digest('hex')}`;
}

export class RunLedger {
  constructor() {
    this.runs = [];
    this.runSeq = 0;
    /** 调用方提供的幂等键 → run_id（与 runs 同步淘汰）。 */
    this.clientRuns = new Map();
    /** 忙时入队的待执行任务：{run, text, reasoning, clientRunId, enqueued_at}。 */
    this.queue = [];
  }

  /** 建一条回合记录。派活时先建，好让调用方立刻拿到 run_id（异步模式的关键）。 */
  create(text, { conversationId, clientRunId = null, review, sessionReview, reserve }) {
    const run = {
      run_id: clientRunId ? keyedRunId(clientRunId) : `run-${Date.now().toString(36)}-${++this.runSeq}-${randomBytes(4).toString('hex')}`,
      conversation_id: conversationId,
      client_run_id: clientRunId ?? null,
      prompt_preview: previewOf(text),
      status: 'queued',
      /** 本回合的审核策略（off / advisory）；由 dsh_send / dsh_interject 或会话默认决定。 */
      review_mode: normalizeReviewMode(review, sessionReview),
      started_at: null,
      ended_at: null,
      elapsed_ms: null,
      result: null,
    };
    reserve?.(run);
    this.runs.push(run);
    if (clientRunId) this.clientRuns.set(clientRunId, run.run_id);
    if (this.runs.length > MAX_RUNS) {
      // ★ 只淘汰已结束的 run：还在跑/在排队的 run 一旦被挤掉，它的 client_run_id 也随之失效，
      //   调用方用同一幂等键重试就会再派一次（审计 C04）。未结束的 run 数量本身有上限（1 个在跑 + 队列）。
      const i = this.runs.findIndex((r) => r.status !== 'running' && r.status !== 'queued');
      const [evicted] = i >= 0 ? this.runs.splice(i, 1) : [];
      // 幂等键必须跟着 run 记录一起淘汰，否则会指向一个已经查不到的 run。
      for (const [k, v] of this.clientRuns) {
        if (v === evicted?.run_id) this.clientRuns.delete(k);
      }
    }
    return run;
  }

  /** 按调用方幂等键取 run（不存在/已淘汰返回 null）。 */
  byClientId(clientRunId) {
    if (!clientRunId) return null;
    const runId = this.clientRuns.get(clientRunId);
    if (!runId) return null;
    return this.runs.find((r) => r.run_id === runId) ?? null;
  }

  /** 按 run_id 取（没有返回 null）。 */
  find(runId) {
    return this.runs.find((r) => r.run_id === runId) ?? null;
  }

  /** 最近一条回合记录（没有返回 null）。 */
  latest() {
    return this.runs.length ? this.runs[this.runs.length - 1] : null;
  }

  /**
   * 最近一条真正开跑过的回合。排队中、没开跑就取消的回合记录建得更晚，但不算"最近一次回合"；
   * 一条都没开跑过时退回 latest()。
   */
  latestStarted() {
    for (let i = this.runs.length - 1; i >= 0; i--) if (this.runs[i].started_at) return this.runs[i];
    return this.latest();
  }

  // ── 队列 ────────────────────────────────────────────────────────

  /** 队列满了就抛错。要在建 run 记录**之前**调用，否则满队列会留下一条永远 queued 的 run。 */
  assertRoom() {
    if (this.queue.length >= MAX_QUEUE) {
      throw new Error(`队列已满（最多 ${MAX_QUEUE} 条）；先用 dsh_queue list 清理，或等当前回合结束`);
    }
  }

  /** 入队；返回 1-based 位置。 */
  enqueue(item) {
    this.queue.push(item);
    return this.queue.length;
  }

  list() {
    return this.queue.map((item, i) => ({
      position: i + 1,
      run_id: item.run.run_id,
      preview: item.run.prompt_preview,
      enqueued_at: item.enqueued_at,
      client_run_id: item.clientRunId ?? null,
    }));
  }

  /** 从队列里取出一条（不存在抛错）。 */
  take(runId) {
    const i = this.queue.findIndex((x) => x.run.run_id === runId);
    if (i < 0) throw new Error(`队列里没有 ${runId}`);
    return this.queue.splice(i, 1)[0];
  }

  update(runId, text) {
    const item = this.queue.find((x) => x.run.run_id === runId);
    if (!item) throw new Error(`队列里没有 ${runId}`);
    item.text = text;
    item.run.prompt_preview = previewOf(text);
  }

  promote(runId) {
    this.queue.unshift(this.take(runId));
  }

  /** 取队首（空队列返回 undefined）。 */
  shift() {
    return this.queue.shift();
  }
}
