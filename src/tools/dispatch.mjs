/**
 * 任务派发、插话、中断与队列管理类 MCP 工具：dsh_send、dsh_interject、dsh_interrupt、dsh_queue。
 */

import { DEFAULT_REASONING, toPosixPath } from '../config.mjs';
import { audit } from '../audit.mjs';
import { L } from '../lang.mjs';
import { normalizeReviewMode } from '../review.mjs';
import {
  backgroundReceipt,
  queuedReceipt,
  renderSendResult,
  replayRun,
} from '../tool-render.mjs';

function parseTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(L('timeout_ms 必须是 >= 0 的有限数字', 'timeout_ms must be a finite number >= 0'));
  if (n > 2_147_483_647) throw new Error(L('timeout_ms 最大为 2147483647', 'timeout_ms must not exceed 2147483647'));
  return n;
}

export function createDispatchHandlers(hub) {
  return {
    async dsh_send(args, { signal } = {}) {
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error(L('prompt 不能为空：至少包含一个非空白字符', 'prompt must not be empty: it needs at least one non-whitespace character'));
      }
      const conv = await hub.get(args.conversation_id);
      signal?.throwIfAborted();
      const review = args.review === undefined ? undefined : normalizeReviewMode(args.review, conv.review);
      const opts = { reasoning: args.reasoning ?? DEFAULT_REASONING, waitSignal: signal };
      if (review !== undefined) opts.review = review;
      if (args.timeout_ms !== undefined && args.timeout_ms !== null) opts.timeoutMs = parseTimeoutMs(args.timeout_ms);

      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error(L('client_run_id 最长 128 字符', 'client_run_id may be at most 128 characters'));
        const existing = conv.getRunByClientId(args.client_run_id);
        if (existing) {
          audit('send_replay', {
            conversation_id: conv.id,
            run_id: existing.run_id,
            client_run_id: args.client_run_id,
          });
          return replayRun(hub, conv, existing, args.wait === true);
        }
      }

      const teamHint = args.team !== false;

      if (conv.busy) {
        if (args.queue === true && args.wait !== true) {
          const { run, position, deduped } = conv.enqueue(args.prompt, {
            reasoning: opts.reasoning,
            clientRunId: args.client_run_id ?? null,
            teamHint,
            review: review ?? conv.review,
          });
          if (deduped) return replayRun(hub, conv, run, false);
          audit('send_queued', {
            conversation_id: conv.id,
            run_id: run.run_id,
            position,
            client_run_id: args.client_run_id ?? null,
          });
          return queuedReceipt(hub, conv, run, position);
        }
        throw new Error(L(
          '会话正在跑另一个回合，无法再排一个。可以：dsh_interject（插话）、dsh_interrupt（打断）后重试，' +
            '或 dsh_send(queue=true) 入队。',
          'The conversation is running another turn, so this one cannot start. Use dsh_interject (stop and redirect), ' +
            'dsh_interrupt (stop) and retry, or dsh_send(queue=true) to enqueue.',
        ));
      }

      const wait = args.wait === true;
      const run = conv.createRun(args.prompt, {
        clientRunId: args.client_run_id ?? null,
        review: review ?? conv.review,
      });
      const r = await conv.prompt(args.prompt, { ...opts, run, wait, teamHint });
      conv.lastResult = r;
      audit('send', {
        conversation_id: conv.id,
        run_id: r?.run_id ?? run.run_id,
        wait,
        still_running: Boolean(r?.still_running),
        client_run_id: args.client_run_id ?? null,
      });
      if (r?.still_running) return backgroundReceipt(hub, conv, r);
      return { structured: r, text: renderSendResult(r) };
    },

    async dsh_interject(args, { signal } = {}) {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error(L('message 不能为空：至少包含一个非空白字符', 'message must not be empty: it needs at least one non-whitespace character'));
      }
      const conv = await hub.get(args.conversation_id);
      signal?.throwIfAborted();
      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error(L('client_run_id 最长 128 字符', 'client_run_id may be at most 128 characters'));
        const existing = conv.getRunByClientId(args.client_run_id);
        if (existing) {
          audit('interject_replay', {
            conversation_id: conv.id,
            run_id: existing.run_id,
            client_run_id: args.client_run_id,
          });
          return replayRun(hub, conv, existing, true);
        }
      }
      const opts = {
        mode: args.mode ?? 'interject',
        reasoning: args.reasoning ?? DEFAULT_REASONING,
        clientRunId: args.client_run_id ?? null,
        waitSignal: signal,
      };
      if (args.review !== undefined) opts.review = normalizeReviewMode(args.review, conv.review);
      if (args.timeout_ms !== undefined && args.timeout_ms !== null) opts.timeoutMs = parseTimeoutMs(args.timeout_ms);
      const r = await conv.interject(args.message, opts);
      conv.lastResult = r;
      audit('interject', {
        conversation_id: conv.id,
        run_id: r?.run_id ?? null,
        mode: r?.interjected ?? opts.mode,
        client_run_id: args.client_run_id ?? null,
      });
      const waitedSec = (r.waited_ms / 1000).toFixed(1);
      const head =
        r.interjected === 'idle'
          ? L('会话当时空闲，已按普通回合执行。', 'The conversation was idle, so this ran as an ordinary turn.')
          : r.interjected === 'queue'
            ? L(
                `已排队：等了 ${waitedSec}s 让上一轮跑完，然后说了这句。`,
                `Queued: waited ${waitedSec}s for the previous turn to finish, then said this.`,
              )
            : L(
                `已打断上一轮，改口说了这句（上一轮耗时 ${waitedSec}s 处被打断）。`,
                `Stopped the previous turn and said this instead (it took ${waitedSec}s to stop).`,
              );
      if (r.still_running && conv.onApproval === 'ask') {
        const receipt = backgroundReceipt(hub, conv, r);
        return { structured: { ...r, ...receipt.structured }, text: head + '\n\n' + receipt.text };
      }
      const sentinel = r?.run_id ? hub.runSentinelPath(conv.id, r.run_id) : null;
      return {
        structured: sentinel ? { ...r, sentinel_file: sentinel, sentinel_file_posix: toPosixPath(sentinel) } : r,
        text:
          `${head}\n\n${renderSendResult(r)}` +
          (sentinel
            ? L(
                '\n\n完成通知文件（本轮结束时原子写出，含最终结果）：\n',
                '\n\nCompletion file (written atomically when this turn ends, with the final result):\n',
              ) + `  ${sentinel}\n  ${toPosixPath(sentinel)}`
            : ''),
      };
    },

    async dsh_interrupt(args) {
      const conv = await hub.get(args.conversation_id);
      const r = await conv.interrupt();
      audit('interrupt', { conversation_id: conv.id, interrupted: Boolean(r.interrupted) });
      return {
        structured: r,
        text: r.interrupted ? L('已发送中断请求。', 'Interrupt request sent.') : L(`未中断：${r.reason}`, `Not interrupted: ${r.reason}`),
      };
    },

    async dsh_queue(args) {
      const conv = await hub.get(args.conversation_id);
      switch (args.action) {
        case 'list': {
          const items = conv.queueList();
          return {
            structured: { count: items.length, queue: items },
            text: items.length
              ? L(`${items.length} 条排队：\n`, `${items.length} queued:\n`) +
                items.map((i) => `- #${i.position} ${i.run_id} | ${i.preview}`).join('\n')
              : L('(队列为空)', '(the queue is empty)'),
          };
        }
        case 'remove': {
          if (!args.run_id) throw new Error(L('remove 需要 run_id', 'remove needs run_id'));
          const r = conv.queueRemove(args.run_id);
          audit('queue_remove', { conversation_id: conv.id, run_id: args.run_id });
          return {
            structured: r,
            text: L(
              `已从队列移除 ${args.run_id}（已写 cancelled 哨兵，等待方不会空等）`,
              `Removed ${args.run_id} from the queue (a cancelled sentinel was written, so a waiter is not left hanging)`,
            ),
          };
        }
        case 'update': {
          if (!args.run_id) throw new Error(L('update 需要 run_id', 'update needs run_id'));
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new Error(L('update 需要非空 text', 'update needs a non-empty text'));
          }
          const r = conv.queueUpdate(args.run_id, args.text);
          audit('queue_update', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: L(`已更新 ${args.run_id} 的排队文本`, `Updated the queued text of ${args.run_id}`) };
        }
        case 'promote': {
          if (!args.run_id) throw new Error(L('promote 需要 run_id', 'promote needs run_id'));
          const r = conv.queuePromote(args.run_id);
          audit('queue_promote', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: L(`已把 ${args.run_id} 提到队首`, `Moved ${args.run_id} to the front of the queue`) };
        }
        default:
          throw new Error(L(`未知 action: ${args.action}`, `Unknown action: ${args.action}`));
      }
    },
  };
}
