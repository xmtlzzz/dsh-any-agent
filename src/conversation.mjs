/**
 * 会话（Conversation）：状态容器与协调门面（具体流程按职责拆在 ./conversation/*）。
 *
 * Conversation 只持有 `hub` 引用，不 import Hub，保证无循环依赖；
 * hub.mjs 继续重新导出 `Conversation` 与 `formatReasoning`。
 */

import { L } from './lang.mjs';
import {
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  PROMPT_TIMEOUT_MS,
  REVIEW_MODES,
  effectiveApprovalPolicy,
} from './config.mjs';
import { toolNameFromTitle } from './acp-session.mjs';
import { rssMb } from './procstat.mjs';
import { readConversationMeta } from './titles.mjs';
import { forgottenPath, isForgotten } from './hub-store.mjs';
import { liveClient, livePreview, withLiveClient } from './live.mjs';
import { classifyHolder, writeMarker } from './locks.mjs';
import { OutBuffer } from './out-buffer.mjs';
import { ConversationLive } from './conversation-live.mjs';
import { RunLedger } from './run-ledger.mjs';
import { decideApproval as decideApprovalFlow, handlePermissionRequest } from './conversation/approval.mjs';
import { closeConversation, ensureAlive as ensureAliveFlow, takeover as takeoverFlow, verifyPermissionRecorded as verifyPermFlow } from './conversation/lifecycle.mjs';
import { pendingReviewTicket as pendingReviewTicketFlow, submitReview as submitReviewFlow } from './conversation/review-flow.mjs';
import { cancelUnstartedRun, formatReasoning, runTurn } from './conversation/turn.mjs';

export { formatReasoning };

const now = () => Date.now();

export class Conversation {
  #lastChildStartedAt = null;
  #hub;
  #activity;
  #undispatched = null;
  #cancelBeforeDispatch = false;

  constructor(state, hub) {
    this.id = state.id;
    this.cwd = state.cwd;
    this.permission = state.permission ?? DEFAULT_PERMISSION;
    this.onApproval = effectiveApprovalPolicy(this.permission, state.onApproval);
    this.createdAt = state.createdAt ?? now();
    this.lastUsedAt = state.lastUsedAt ?? now();
    this.turnCount = state.turnCount ?? 0;
    this.titleHint = state.titleHint ?? null;
    this.keepAlive = state.keepAlive === true;
    this.cfg = {
      reasoningEffort: state.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      provider: state.provider ?? null,
      model: state.model ?? null,
    };
    this.review = REVIEW_MODES.includes(state.review) ? state.review : DEFAULT_REVIEW;
    this.lastConfigApplied = null;
    this.permissionVerified = null;
    this.workspace = state.workspace ?? null;
    this.worktree = state.worktree ?? null;
    this.#hub = hub;
    this.#activity = new ConversationLive(this.id, () => ({
      run: this.currentRun?.run_id ?? null, turn: this.currentTurn,
    }));

    this.proc = null;
    this.busy = false;
    this.recycling = null;
    this.lastChildPid = null;
    this.lockConflict = null;
    this.pendingApprovals = new Map();
    this.currentRun = null;
    this.collector = null;
    this.idleWaiters = [];

    this.outBuf = new OutBuffer();
    this.turnOutChars = 0;
    this.currentTurn = 0;
    this.turnStartedAt = 0;
    this.lastProgressAt = 0;
    this.currentTool = null;

    this.ledger = new RunLedger();
    this.draining = false;
    this.lastResult = null;
  }

  #ctx() {
    return {
      hub: this.#hub,
      activity: this.#activity,
      getLastChildStartedAt: () => this.#lastChildStartedAt,
      assertNotForgotten: () => this.#assertNotForgotten(),
      scheduleDrain: () => this.#scheduleDrain(),
      setUndispatched: (r) => { this.#undispatched = r; },
      resetCancelBeforeDispatch: () => { this.#cancelBeforeDispatch = false; },
      isCancelledBeforeDispatch: () => this.#cancelBeforeDispatch,
    };
  }

  async recordChildProcess(proc) {
    const pid = proc.pid;
    const startedAt = await proc.startTime;
    if (this.proc !== proc || proc.pid !== pid || !proc.alive) {
      throw new Error(L('登记写锁时 DSH 进程已退出', 'The DSH process exited while registering its write lock'));
    }
    writeMarker(this.id, { childPid: pid, childStartedAt: startedAt, cwd: this.cwd });
    this.lastChildPid = pid;
    this.#lastChildStartedAt = startedAt;
  }

  get out() { return this.outBuf?.entries ?? []; }
  get runs() { return this.ledger?.runs ?? []; }
  get queue() { return this.ledger?.queue ?? []; }

  #assertNotForgotten() {
    if (isForgotten(this.id)) {
      throw new Error(L(
        `会话已被 forget（永久移除）: ${this.id}，不再派活。确实要恢复请删除墓碑 ${forgottenPath(this.id)}。`,
        `Conversation was forgotten (removed permanently): ${this.id}. To restore it, delete tombstone ${forgottenPath(this.id)}.`,
      ));
    }
  }

  toState() {
    return {
      id: this.id,
      cwd: this.cwd,
      permission: this.permission,
      onApproval: this.onApproval,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      turnCount: this.turnCount,
      titleHint: this.titleHint,
      keepAlive: this.keepAlive,
      reasoningEffort: this.cfg.reasoningEffort,
      provider: this.cfg.provider,
      model: this.cfg.model,
      review: this.review,
      workspace: this.workspace,
      worktree: this.worktree,
    };
  }

  toMeta() { return { version: 1, ...this.toState() }; }

  snapshot() {
    const meta = readConversationMeta(this.id);
    const nativeTitle = meta?.title ?? null;
    const holder = this.proc?.alive
      ? { kind: 'self', reason: L('本进程持有该会话的写锁', 'This server holds the write lock for this conversation') }
      : classifyHolder(this.id, { knownChildPid: this.lastChildPid });
    return {
      conversation_id: this.id,
      title: nativeTitle ?? this.titleHint ?? null,
      title_source: nativeTitle ? 'native' : this.titleHint ? 'title_hint' : null,
      title_hint: this.titleHint ?? null,
      cwd: this.cwd,
      permission: this.permission,
      review: this.review,
      permission_verified: this.permissionVerified,
      on_approval: this.onApproval,
      alive: !!this.proc?.alive,
      busy: this.busy,
      keep_alive: this.keepAlive,
      rss_mb: rssMb(this.proc?.pid),
      state: this.state(),
      current_tool: this.currentTool,
      out_chars: this.turnOutChars,
      running_ms: this.busy && this.turnStartedAt ? now() - this.turnStartedAt : 0,
      since_progress_ms: this.busy && this.lastProgressAt ? now() - this.lastProgressAt : null,
      turns: this.turnCount,
      created_at: new Date(this.createdAt).toISOString(),
      last_used_at: new Date(this.lastUsedAt).toISOString(),
      model: meta?.model ?? null,
      reasoning_effort: this.cfg.reasoningEffort,
      model_config: this.cfg.provider ? `${this.cfg.provider}/${this.cfg.model}` : null,
      config_applied: this.lastConfigApplied?.applied ?? null,
      config_failed: this.lastConfigApplied?.failed?.length ? this.lastConfigApplied.failed : null,
      workspace_registered: this.workspace?.registered ?? null,
      worktree: this.worktree ?? null,
      usage: meta?.usage?.totals ?? null,
      context_pressure: meta?.pressure ?? null,
      pending_approvals: [...this.pendingApprovals.keys()],
      queue_length: this.queue?.length ?? 0,
      queue: this.queueList(),
      pending_approval_details: [...this.pendingApprovals].map(([approvalId, pending]) => ({
        approval_id: approvalId,
        created_at: pending.createdAt ?? null,
        ...pending.params.details,
      })),
      lock_holder: holder.kind,
      lock_holder_reason: holder.reason ?? null,
      lock_conflict: this.lockConflict,
    };
  }

  async ensureAlive(opts) { return ensureAliveFlow(this, this.#ctx(), opts); }
  async verifyPermissionRecorded(opts) { return verifyPermFlow(this, this.#ctx(), opts); }
  async takeover(opts) { return takeoverFlow(this, this.#ctx(), opts); }
  async close(opts) { return closeConversation(this, this.#ctx(), opts); }

  onUpdate(params) {
    const c = this.collector;
    if (!c) return;
    const u = params?.update;
    if (!u) return;
    this.lastProgressAt = now();
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = u.content?.text ?? '';
        if (chunk && c.answerBreak) {
          if (c.answer && !/\n\s*$/.test(c.answer) && !/^\s*\n/.test(chunk)) c.answer += '\n\n';
          c.answerBreak = false;
        }
        c.answer += chunk;
        this.pushOut('text', chunk);
        break;
      }
      case 'agent_thought_chunk':
        c.reasoning += u.content?.text ?? '';
        c.reasoningChunks += 1;
        if (c.reasoningStartedAt === 0) c.reasoningStartedAt = now();
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = u.toolCallId ?? 'unknown';
        const prev = c.tools.get(id) ?? {};
        const merged = {
          ...prev,
          id,
          title: u.title ?? prev.title,
          status: u.status ?? prev.status,
          kind: u.kind ?? prev.kind,
          name: u.name ?? prev.name ?? toolNameFromTitle(u.title),
          input: u.rawInput !== undefined ? u.rawInput : prev.input,
        };
        c.tools.set(id, merged);
        if (c.answer) c.answerBreak = true;
        const label = merged.name ?? merged.title ?? id;
        this.currentTool = merged.status === 'completed' || merged.status === 'failed' ? null : label;
        const tag = merged.status ? ` [${merged.status}]` : '';
        if (u.title !== undefined || u.status !== undefined || u.name !== undefined) {
          this.pushOut('tool', `${label}${tag}`, { tool_call_id: id });
        }
        this.#activity.tool(id, merged);
        break;
      }
      case 'usage_update':
        c.usage = u;
        this.#activity.usageTick();
        break;
      case 'plan':
      case 'plan_update':
        c.plan = u;
        break;
      default:
        c.otherUpdates.push(u.sessionUpdate);
    }
  }

  async onPermissionRequest(params) { return handlePermissionRequest(this, this.#ctx(), params); }
  decideApproval(approvalId, decision) { return decideApprovalFlow(this, this.#ctx(), approvalId, decision); }

  onProcessExit() {
    this.proc = null;
    this.recycling = null;
  }

  async prompt(text, opts) { return runTurn(this, this.#ctx(), text, opts); }

  async interrupt() {
    if (this.busy && this.#undispatched) {
      this.#cancelBeforeDispatch = true;
      this.#activity.emit('interrupt', { busy: true, before_dispatch: true });
      return { interrupted: true, before_dispatch: true };
    }
    if (!this.proc?.alive) return { interrupted: false, reason: L('DSH 进程未运行', 'DSH process is not running') };
    this.proc.notify('session/cancel', { sessionId: this.id });
    this.#activity.emit('interrupt', { busy: this.busy });
    if (!this.busy) {
      return {
        interrupted: false,
        reason: L('当前没有进行中的回合（已发送 cancel，用于清空排队输入）', 'No turn is currently running (cancel sent to clear pending input)'),
      };
    }
    return { interrupted: true };
  }

  state() {
    if (this.busy) return 'running';
    return this.proc?.alive ? 'idle' : 'detached';
  }

  pushOut(kind, text, extra = {}) {
    this.outBuf.push(kind, text, extra, this.currentTurn);
    if (kind === 'text') this.turnOutChars += text?.length ?? 0;
  }

  readOut({ cursor = 0, includeReasoning = false, limit = 200 } = {}) {
    const page = this.outBuf.read({ cursor, limit });
    /** @type {Record<string, any>} */
    const res = {
      conversation_id: this.id,
      state: this.state(),
      busy: this.busy,
      current_tool: this.currentTool,
      ...page,
    };
    if (includeReasoning && this.collector?.reasoning) res.live_thinking = this.collector.reasoning;
    return res;
  }

  createRun(text, { clientRunId = null, review = this.review } = {}) {
    if (this.#hub.shuttingDown) throw new Error('Service is shutting down');
    return this.ledger.create(text, {
      conversationId: this.id,
      clientRunId,
      review,
      sessionReview: this.review,
      reserve: (run) => this.#hub.reserveRun?.(this.id, run),
    });
  }

  getRunByClientId(clientRunId) {
    return this.ledger.byClientId(clientRunId) ?? this.#hub.findRunByClientId?.(this.id, clientRunId) ?? null;
  }

  enqueue(text, { reasoning = 'hide', clientRunId = null, teamHint = false, review = this.review } = {}) {
    if (clientRunId) {
      const existing = this.getRunByClientId(clientRunId);
      if (existing) return { run: existing, position: 0, deduped: true };
    }
    this.ledger.assertRoom();
    const run = this.createRun(text, { clientRunId, review });
    run.status = 'queued';
    const position = this.ledger.enqueue({ run, text, reasoning, clientRunId, teamHint, enqueued_at: now(), client: liveClient() });
    this.#activity.emit(
      'run.queued',
      { run: run.run_id, position, cwd: this.cwd },
      { prompt_preview: livePreview(run.prompt_preview, 200) },
    );
    return { run, position, deduped: false };
  }

  queueList() { return this.ledger?.list() ?? []; }

  queueRemove(runId, { cancel = true } = {}) {
    const item = this.ledger.take(runId);
    if (cancel) cancelUnstartedRun(this, this.#ctx(), item.run, 'queued run cancelled before it started');
    return { removed: true, run_id: runId };
  }

  queueUpdate(runId, text) {
    this.ledger.update(runId, text);
    return { updated: true, run_id: runId };
  }

  queuePromote(runId) {
    this.ledger.promote(runId);
    return { promoted: true, run_id: runId, position: 1 };
  }

  #scheduleDrain() {
    if (this.#hub.shuttingDown || this.busy || this.draining || this.queue.length === 0) return;
    this.draining = true;
    const timer = setTimeout(() => {
      this.draining = false;
      if (this.#hub.shuttingDown || this.busy || this.queue.length === 0) return;
      const item = this.ledger.shift();
      const run = item.run;
      run.status = 'running';
      withLiveClient(item.client, () => this.prompt(item.text, {
        reasoning: item.reasoning, run, wait: false, via: 'queue', teamHint: item.teamHint,
      }))
        .catch(() => {})
        .finally(() => this.#scheduleDrain());
    }, 0);
    timer.unref?.();
  }

  getRun(runId) {
    if (runId) {
      const r = this.ledger.find(runId) ?? this.#hub.readStoredRun?.(this.id, runId);
      if (!r) throw new Error(L(`未知 run_id: ${runId}`, `Unknown run_id: ${runId}`));
      return r;
    }
    return this.currentRun ?? this.ledger.latestStarted();
  }

  pendingReviewTicket(runId) { return pendingReviewTicketFlow(this, runId); }
  submitReview(runId, opts) { return submitReviewFlow(this, this.#ctx(), runId, opts); }

  async waitIdle(timeoutMs = 30 * 60 * 1000, signal) {
    if (signal?.aborted) return false;
    if (!this.busy) return true;
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(true);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        const i = this.idleWaiters.indexOf(done);
        if (i >= 0) this.idleWaiters.splice(i, 1);
        resolve(false);
      };
      if (timeoutMs > 0) timer = setTimeout(cancel, timeoutMs);
      this.idleWaiters.push(done);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  async interject(message, { mode = 'interject', reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, clientRunId = null, review = undefined, waitSignal = undefined } = {}) {
    const run = this.createRun(message, { clientRunId, review });
    if (!this.busy) {
      const r = await this.prompt(message, { reasoning, timeoutMs, run, via: 'interject', waitSignal });
      return { ...r, interjected: 'idle', waited_ms: 0 };
    }
    const t0 = now();
    if (mode === 'interject') {
      if (this.#undispatched) this.#cancelBeforeDispatch = true;
      else this.proc?.notify('session/cancel', { sessionId: this.id });
    }
    this.#activity.emit('interject', { mode, pending_run: run.run_id }, { text_preview: livePreview(message, 200) });
    let idle = await this.waitIdle(timeoutMs, waitSignal);
    while (idle && this.busy) {
      const left = timeoutMs > 0 ? timeoutMs - (now() - t0) : 0;
      idle = timeoutMs > 0 && left <= 0 ? false : await this.waitIdle(left, waitSignal);
    }
    const waited = now() - t0;
    if (!idle || waitSignal?.aborted) {
      const err = Object.assign(
        new Error(
          waitSignal?.aborted
            ? L('插话请求已取消，未发送', 'Interject request was cancelled before sending')
            : L('等待当前回合结束超时，插话未发送', 'Timed out waiting for the current turn to end; interject not sent'),
        ),
        { runId: run.run_id },
      );
      cancelUnstartedRun(this, this.#ctx(), run, err.message);
      throw err;
    }
    const r = await this.prompt(message, { reasoning, timeoutMs, run, via: mode === 'queue' ? 'queue' : 'interject', waitSignal });
    return { ...r, interjected: mode, waited_ms: waited };
  }
}
