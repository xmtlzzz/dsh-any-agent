/**
 * 单回合执行流水线：准备 → 派发与看门狗 → 终态收尾/失败兜底 → 思考内容格式化。
 */

import { L } from '../lang.mjs';
import {
  PROMPT_TIMEOUT_MS,
  STALL_MS,
  TURN_MAX_MS,
  WATCHDOG_AFTER_MS,
  WATCHDOG_GRACE_MS,
} from '../config.mjs';
import { watchdogTickMs, watchdogVerdict } from '../watchdog.mjs';
import { normalizeReviewMode } from '../review.mjs';
import { gitStatus, sameWorkspaceSnapshot } from '../git-snapshot.mjs';
import { attachReview, terminalResult } from '../run-result.mjs';

const now = () => Date.now();
const MAX_PROMPT_ECHO = 4000;

const TEAM_PREFIX = L(
  '【团队】如果这个任务需要并行或多角色协作，先用 spawn_teammate 创建团队再执行；' +
    '不需要就单 agent 完成。不要为简单任务组队。\n\n',
  '[Team] If this task needs parallel or multi-role work, create a team with spawn_teammate first and then do it; ' +
    'otherwise finish it as a single agent. Do not form a team for a simple task.\n\n',
);

/** 按档位渲染思考内容。 */
export function formatReasoning(c, mode) {
  if (mode === 'full') return c.reasoning;
  if (mode === 'summary') {
    const t = c.reasoning.trim();
    if (!t) return '';
    if (t.length <= 400) return t;
    return `${t.slice(0, 240)}\n…\n${t.slice(-120)}`;
  }
  if (mode === 'marker') {
    return c.reasoning ? L(`[思考已隐藏：${c.reasoning.length} 字]`, `[reasoning hidden: ${c.reasoning.length} chars]`) : '';
  }
  return '';
}

function wakeIdleWaiters(conv, scheduleDrain) {
  const waiters = conv.idleWaiters;
  conv.idleWaiters = [];
  for (const w of waiters) {
    try { w(); } catch {}
  }
  scheduleDrain();
}

/** 一个还没发出就被取消的 run（队列移除、插话等待超时等）的终态落盘。 */
export function cancelUnstartedRun(conv, { hub, activity }, run, message) {
  run.status = 'cancelled';
  run.ended_at = now();
  run.elapsed_ms = 0;
  run.result = attachReview(
    terminalResult({ conversationId: conv.id, runId: run.run_id, stopReason: 'cancelled', error: message }),
    { conversationId: conv.id, run, mode: run.review_mode, permission: conv.permission },
  );
  activity.endRun(run.run_id, { status: 'cancelled', stop_reason: 'cancelled' }, message);
  const file = hub.writeRunSentinel?.(conv.id, run);
  run.result.sentinel_file = file ?? hub.runSentinelPath?.(conv.id, run.run_id) ?? null;
}

/** 启动阶段失败或发出前取消时的统一收尾：唤醒等待者 + 写哨兵。 */
export async function settleFailedRun(conv, { hub, activity, scheduleDrain }, runRecord, error, { status = 'error' } = {}) {
  const stopReason = status === 'cancelled' ? 'cancelled' : 'error';
  wakeIdleWaiters(conv, scheduleDrain);
  if (conv.currentRun === runRecord) conv.currentRun = null;
  runRecord.ended_at = now();
  runRecord.status = stopReason;
  runRecord.error = error?.message ?? String(error);
  runRecord.elapsed_ms = 0;
  activity.finishUsage(runRecord.run_id, { flush: false });
  activity.endRun(runRecord.run_id, { status: stopReason, stop_reason: stopReason }, runRecord.error);
  runRecord.result = attachReview(
    terminalResult({ conversationId: conv.id, runId: runRecord.run_id, stopReason, error: runRecord.error }),
    { conversationId: conv.id, run: runRecord, mode: runRecord.review_mode ?? conv.review, permission: conv.permission },
  );
  try {
    if (typeof hub.writeRunSentinel === 'function') {
      const file = hub.writeRunSentinel(conv.id, runRecord);
      runRecord.result.sentinel_file = file ?? hub.runSentinelPath?.(conv.id, runRecord.run_id) ?? null;
      if (!file) runRecord.result.sentinel_error = runRecord.sentinel_error ?? L('哨兵文件写入失败', 'Failed to write sentinel file');
    }
  } catch (e) {
    runRecord.result.sentinel_error = L(`写完成哨兵失败: ${e.message}`, `Failed to write completion sentinel: ${e.message}`);
  }
  try { await hub.save?.(); } catch {}
  return runRecord.result;
}

function startWatchdog(conv, { hub, activity }, runRecord, c, t0, proc, onUnresponsive) {
  if (!(WATCHDOG_AFTER_MS > 0 && STALL_MS > 0) && !(TURN_MAX_MS > 0)) return null;
  let graceTimer;
  const timer = setInterval(() => {
    if (conv.currentRun !== runRecord) return clearInterval(timer);
    const t = now();
    const open = [...c.tools.values()].filter((x) => x.status !== 'completed' && x.status !== 'failed');
    const runningTool = open.length ? (open.at(-1).name ?? open.at(-1).title ?? open.at(-1).id) : null;
    const verdict = watchdogVerdict({
      elapsedMs: t - t0,
      sinceProgressMs: t - conv.lastProgressAt,
      toolRunning: open.length > 0,
      waitingOnCaller: conv.pendingApprovals.size > 0,
      afterMs: WATCHDOG_AFTER_MS,
      stallMs: STALL_MS,
      maxMs: TURN_MAX_MS,
    });
    if (!verdict) return;
    clearInterval(timer);
    c.watchdog = {
      ...verdict,
      elapsed_ms: t - t0,
      since_progress_ms: t - conv.lastProgressAt,
      current_tool: runningTool,
      at: new Date(t).toISOString(),
    };
    hub.log.info(
      `[conv ${conv.id}] 看门狗中断回合 ${runRecord.run_id}：${verdict.reason}` +
        `（已跑 ${Math.round((t - t0) / 1000)}s，距上次进展 ${Math.round((t - conv.lastProgressAt) / 1000)}s）`,
    );
    activity.emit('watchdog', {
      reason: verdict.reason,
      elapsed_ms: c.watchdog.elapsed_ms,
      since_progress_ms: c.watchdog.since_progress_ms,
      tool: runningTool,
    });
    proc.notify?.('session/cancel', { sessionId: conv.id });
    graceTimer = setTimeout(onUnresponsive, WATCHDOG_GRACE_MS);
    graceTimer.unref?.();
  }, watchdogTickMs({ stallMs: STALL_MS, maxMs: TURN_MAX_MS }));
  timer.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(graceTimer);
  };
}

function createCollector() {
  return {
    answer: '',
    answerBreak: false,
    reasoning: '',
    reasoningChunks: 0,
    reasoningStartedAt: 0,
    tools: new Map(),
    usage: null,
    plan: null,
    otherUpdates: [],
    autoApprovals: [],
    autoApprovalTotal: 0,
    autoEscalationTotal: 0,
  };
}

async function finalizeTurnBody(conv, ctx, { runRecord, c, before, t0, reasoning, reviewMode, stopReason, failure }) {
  const { hub, activity, scheduleDrain } = ctx;
  const withReview = (result) =>
    attachReview(result, { conversationId: conv.id, run: runRecord, mode: reviewMode, permission: conv.permission });

  try {
    /** @type {Record<string, any>} */
    const result = {
      conversation_id: conv.id,
      run_id: runRecord.run_id,
      stop_reason: stopReason,
      error: failure,
      answer: c.answer,
      thinking: formatReasoning(c, reasoning),
      thinking_stats: {
        hidden: reasoning === 'hide' || reasoning === 'marker',
        chars: c.reasoning.length,
        chunks: c.reasoningChunks,
        ms: c.reasoningStartedAt ? now() - c.reasoningStartedAt : 0,
      },
      tools_used: [...c.tools.values()],
      usage: c.usage,
      auto_approvals_total: c.autoApprovalTotal,
      auto_escalations_total: c.autoEscalationTotal,
      auto_approvals: c.autoApprovals,
      ...(c.watchdog ? { watchdog: c.watchdog } : {}),
      workspace_changed: false,
      diff_stat: null,
      elapsed_ms: now() - t0,
    };
    const status = failure ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'done';
    if (hub.checkpointRunResult) {
      const checkpoint = {
        ...result,
        ...(process.env.DSH_MCP_GIT_STATUS !== '0' ? { git_snapshot_incomplete: true } : {}),
      };
      hub.checkpointRunResult(conv.id, runRecord, withReview(checkpoint), status, now());
    }
    const afterPromise = gitStatus(conv.cwd);
    conv.busy = false;
    if (conv.currentRun === runRecord) conv.currentRun = null;
    conv.collector = null;
    conv.currentTool = null;
    for (const [apId, p] of conv.pendingApprovals) {
      try { p.resolve({ outcome: { outcome: 'cancelled' } }); } catch {}
      activity.approvalDecided(apId, 'turn_end', null, 'cancelled');
    }
    conv.pendingApprovals.clear();
    conv.pushOut('turn', L(`第 ${conv.currentTurn} 轮结束（${stopReason ?? 'unknown'}）`, `Turn ${conv.currentTurn} ended (${stopReason ?? 'unknown'})`), {
      phase: 'end',
      stop_reason: stopReason,
      error: failure ?? undefined,
    });
    activity.endRun(
      runRecord.run_id,
      {
        status,
        stop_reason: stopReason ?? null,
        duration_ms: now() - t0,
        tool_count: c.tools.size,
        auto_approvals: c.autoApprovalTotal,
        auto_escalations: c.autoEscalationTotal,
        watchdog: c.watchdog?.reason,
      },
      failure,
    );
    conv.turnCount += 1;
    conv.lastUsedAt = now();
    await hub.save();
    wakeIdleWaiters(conv, scheduleDrain);

    const after = await afterPromise;
    activity.finishUsage(runRecord.run_id);
    result.workspace_changed = !sameWorkspaceSnapshot(before, after);
    result.diff_stat = after;
    result.elapsed_ms = now() - t0;
    withReview(result);
    runRecord.ended_at = now();
    runRecord.elapsed_ms = result.elapsed_ms;
    runRecord.status = status;
    runRecord.result = result;
    const sentinelFile = hub.writeRunSentinel(conv.id, runRecord);
    result.sentinel_file = sentinelFile ?? hub.runSentinelPath(conv.id, runRecord.run_id);
    if (!sentinelFile) result.sentinel_error = runRecord.sentinel_error ?? L('哨兵文件写入失败', 'Failed to write sentinel file');
    return result;
  } catch (e) {
    hub.log.info(`[conv ${conv.id}] 回合收尾异常（已兜底）: ${e.message}`);
    conv.busy = false;
    if (conv.currentRun === runRecord) conv.currentRun = null;
    conv.collector = null;
    wakeIdleWaiters(conv, scheduleDrain);
    const fallback = withReview(
      terminalResult({
        conversationId: conv.id,
        runId: runRecord.run_id,
        stopReason: 'error',
        error: L(`回合收尾异常: ${e.message}`, `Turn finalization error: ${e.message}`),
        answer: c.answer ?? '',
        toolsUsed: [...(c.tools?.values?.() ?? [])],
        elapsedMs: now() - t0,
      }),
    );
    runRecord.ended_at = now();
    runRecord.status = 'error';
    runRecord.error = fallback.error;
    runRecord.result = fallback;
    const sentinelFile = hub.writeRunSentinel(conv.id, runRecord);
    fallback.sentinel_file = sentinelFile ?? hub.runSentinelPath(conv.id, runRecord.run_id);
    if (!sentinelFile) fallback.sentinel_error = runRecord.sentinel_error ?? L('哨兵文件写入失败', 'Failed to write sentinel file');
    return fallback;
  }
}

export async function runTurn(
  conv,
  ctx,
  text,
  { reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, run = undefined, wait = true, waitSignal = undefined, review = undefined, via = 'send', teamHint = false } = {},
) {
  const { hub, activity, assertNotForgotten, setUndispatched, resetCancelBeforeDispatch, isCancelledBeforeDispatch } = ctx;
  if (conv.busy) {
    throw new Error(L(
      `会话 ${conv.id} 正在跑另一个回合。可以：dsh_interject 插话（打断并改口 / 排队），或 dsh_interrupt 打断。`,
      `Conversation ${conv.id} is already running a turn. Use dsh_interject (redirect or queue) or dsh_interrupt.`,
    ));
  }
  const runRecord = run ?? conv.createRun(text, { review });
  if (hub.shuttingDown) {
    cancelUnstartedRun(conv, ctx, runRecord, 'service is shutting down');
    return runRecord.result;
  }
  const reviewMode = runRecord.review_mode ?? normalizeReviewMode(review ?? conv.review);
  runRecord.review_mode = reviewMode;
  conv.ledger.start(runRecord);
  conv.currentRun = runRecord;
  let before = null;
  let proc;

  conv.busy = true;
  conv.lastUsedAt = now();
  setUndispatched(runRecord);
  resetCancelBeforeDispatch();
  let cancelledBeforeDispatch = false;
  try {
    hub.markRunStarted?.(conv.id, runRecord);
    assertNotForgotten();
    const beforePromise = gitStatus(conv.cwd);
    const [beforeSnap, liveProc] = await Promise.all([beforePromise, conv.ensureAlive()]);
    before = beforeSnap;
    proc = liveProc;
    assertNotForgotten();
    cancelledBeforeDispatch = isCancelledBeforeDispatch();
  } catch (e) {
    setUndispatched(null);
    conv.busy = false;
    await settleFailedRun(conv, ctx, runRecord, e);
    e.runId = runRecord.run_id;
    e.status = 'error';
    e.sentinelFile = runRecord.result?.sentinel_file ?? null;
    throw e;
  }
  setUndispatched(null);
  if (cancelledBeforeDispatch) {
    conv.busy = false;
    return settleFailedRun(
      conv,
      ctx,
      runRecord,
      new Error(L('回合在发出前被中断（dsh_interrupt）', 'Turn was interrupted before dispatch (dsh_interrupt)')),
      { status: 'cancelled' },
    );
  }

  conv.currentTurn += 1;
  conv.turnStartedAt = now();
  conv.turnOutChars = 0;
  conv.currentTool = null;
  conv.pushOut('user', text.length > MAX_PROMPT_ECHO ? `${text.slice(0, MAX_PROMPT_ECHO)}${L('…（已截断）', '… (truncated)')}` : text);
  conv.pushOut('turn', L(`第 ${conv.currentTurn} 轮开始`, `Turn ${conv.currentTurn} started`), { phase: 'start' });
  activity.startTurn(runRecord.run_id, text, { via, permission: conv.permission, on_approval: conv.onApproval, cwd: conv.cwd });
  const c = createCollector();
  conv.collector = c;
  const t0 = now();
  conv.lastProgressAt = t0;

  let settled = false;
  let watchdogTimer = null;
  let finalizePromise = null;
  const finalize = (stopReason, failure) => {
    if (finalizePromise) return finalizePromise;
    settled = true;
    watchdogTimer?.();
    finalizePromise = finalizeTurnBody(conv, ctx, { runRecord, c, before, t0, reasoning, reviewMode, stopReason, failure })
      .catch((e) => {
        hub.log.info(`[conv ${conv.id}] 回合收尾二次异常（已忽略）: ${e.message}`);
        if (!runRecord.result) {
          runRecord.result = terminalResult({
            conversationId: conv.id,
            runId: runRecord.run_id,
            stopReason: 'error',
            error: L(`回合收尾异常: ${e.message}`, `Turn finalization error: ${e.message}`),
            answer: c.answer ?? '',
            elapsedMs: now() - t0,
          });
          runRecord.status = 'error';
        }
        return runRecord.result;
      });
    finalizePromise = hub.trackRunFinalization?.(runRecord, finalizePromise) ?? finalizePromise;
    return finalizePromise;
  };

  const receipt = (waitedMs) => ({
    conversation_id: conv.id,
    run_id: runRecord.run_id,
    status: 'running',
    still_running: true,
    accepted: true,
    background: true,
    sentinel_file: hub.runSentinelPath(conv.id, runRecord.run_id),
    waited_ms: waitedMs ?? 0,
  });

  const promptText = teamHint && proc.teamProfile?.backend === 'experimental' ? TEAM_PREFIX + text : text;
  const acp = proc.request('session/prompt', { sessionId: conv.id, prompt: [{ type: 'text', text: promptText }] }, 0);
  const watchdogError = L('看门狗取消了超限回合', 'The watchdog stopped this turn after it exceeded its limit');
  const finished = new Promise((resolve) => {
    watchdogTimer = startWatchdog(conv, ctx, runRecord, c, t0, proc, () => {
      c.watchdog.escalated = true;
      const stopping = proc.abort?.() ?? proc.stop?.({ graceMs: 0, signal: 'SIGKILL' });
      const recycling = Promise.resolve(stopping)
        .catch((error) => hub.log.info(`[conv ${conv.id}] ACP abort failed: ${error.message}`))
        .finally(() => {
          if (conv.recycling === recycling) conv.recycling = null;
        });
      conv.recycling = recycling;
      resolve(finalize('watchdog_timeout', watchdogError));
    });
    void acp.then(
      (res) => {
        if (res?.usage) c.usage = c.usage ?? res.usage;
        if (c.watchdog && res?.stopReason !== 'cancelled') resolve(finalize('watchdog_timeout', watchdogError));
        else resolve(finalize(res?.stopReason ?? null, null));
      },
      (e) => resolve(finalize(c.watchdog ? 'watchdog_timeout' : 'error', e.message)),
    );
  });

  if (!wait || waitSignal?.aborted) {
    return settled ? await (finalizePromise ?? runRecord.result) : receipt(0);
  }
  if (timeoutMs <= 0 && !waitSignal) {
    await finished;
    return runRecord.result;
  }
  const stoppedWaiting = await new Promise((resolve) => {
    const done = (stopped) => {
      clearTimeout(timer);
      waitSignal?.removeEventListener('abort', abort);
      resolve(stopped);
    };
    const abort = () => done(true);
    const timer = timeoutMs > 0 ? setTimeout(abort, timeoutMs) : null;
    waitSignal?.addEventListener('abort', abort, { once: true });
    void finished.then(() => done(false));
  });
  if (stoppedWaiting) return receipt(waitSignal?.aborted ? 0 : timeoutMs);
  return runRecord.result;
}
