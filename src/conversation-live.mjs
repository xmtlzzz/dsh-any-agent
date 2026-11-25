/** Per-conversation live events and token samples for watch and dashboard. */
import { toolNameFromTitle } from './acp-session.mjs';
import { escalationOf } from './approval-policy.mjs';
import { emitLive, livePreview, liveSettings, summarizeToolInput } from './live.mjs';
import { readConversationMeta } from './titles.mjs';

export class ConversationLive {
  /**
   * live 事件流用的工具跟踪：tool_call_id → {at, status, hasInput}。
   * 单独放在这里而不是回合收集器里：收集器的 tools 会原样进 tools_used，不能混入新字段。
   */
  #liveTools = new Map();

  constructor(conversationId, context) {
    this.id = conversationId;
    this.context = context;
  }

  emit(type, fields = {}, detail = null) {
    emitLive(this.id, type, { ...this.context(), ...fields }, detail);
  }

  startTurn(runId, text, fields) {
    const { turn } = this.context();
    this.#liveTools.clear();
    // live 关闭时不读投影缓存（emitLive 会直接丢弃，读了也白读）。
    this.#liveUsage = liveSettings().level === 'off'
      ? null
      : { runId, turn, base: this.#readTokenUsage()?.totals ?? null, at: 0, last: '' };
    this.emit('run.start', fields, { prompt_preview: livePreview(text, 200) });
  }

  finishUsage(runId, { flush = true } = {}) {
    // A newer turn may already have started while the previous Git snapshot was pending.
    if (this.#liveUsage?.runId !== runId) return;
    if (flush) this.usageTick({ force: true });
    this.#liveUsage = null;
  }

  /**
   * live 事件流的 token 跟踪：`{runId, base, at, last}`。
   * DSH 在投影缓存里维护**会话累计**的 tokenUsage.totals，并在回合中每个模型步之后更新
   * （真机实测）；回合开始时记下基线，之后发的是"本回合增量"。
   */
  #liveUsage = null;

  /** 读 DSH 投影缓存里的 token 累计与上下文压力；读不到返回 null。 */
  #readTokenUsage() {
    try {
      const meta = readConversationMeta(this.id);
      const t = meta?.usage?.totals;
      const p = meta?.pressure;
      if (!t && !p) return null;
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      return {
        totals: t
          ? { input: n(t.uncachedInputTokens), output: n(t.outputTokens), cache_read: n(t.cacheReadTokens), cache_write: n(t.cacheWriteTokens) }
          : null,
        context: p && Number.isFinite(p.contextWindow) ? { used: n(p.pressureTokens ?? p.surfaceTokens), window: p.contextWindow } : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 发一条 `usage` 事件（本回合 token 增量 + 会话累计 + 上下文占用）。
   * 回合中节流到 2 秒一次、且只在数字变化时发；回合结束后 force 再发一次最终值。
   */
  usageTick({ force = false } = {}) {
    const u = this.#liveUsage;
    if (!u) return;
    const t = Date.now();
    if (!force && t - u.at < 2000) return;
    u.at = t;
    const cur = this.#readTokenUsage();
    if (!cur?.totals && !cur?.context) return;
    const base = u.base ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const tokens = cur.totals
      ? Object.fromEntries(Object.keys(base).map((k) => [k, Math.max(0, cur.totals[k] - base[k])]))
      : null;
    const sig = JSON.stringify([tokens, cur.context]);
    if (!force && sig === u.last) return;
    u.last = sig;
    emitLive(this.id, 'usage', {
      run: u.runId,
      turn: u.turn,
      tokens,
      session_tokens: cur.totals,
      context: cur.context,
      final: force || undefined,
    });
  }

  /** 审批裁决事件（decide / 超时 / 回合结束 / 关闭 统一走这里）。 */
  approvalDecided(approvalId, by, decision = null, effective = null) {
    this.emit('approval.decided', { approval_id: approvalId, by, decision, effective });
  }

  /**
   * 工具状态 → live 事件。DSH 的工具更新是快照、会重复推同一状态，所以只在
   * "第一次出现 / 状态变化 / 第一次拿到输入"时写，避免刷屏。
   */
  tool(id, merged) {
    const seen = this.#liveTools.get(id);
    const hasInput = merged.input !== undefined && merged.input !== null;
    const status = merged.status ?? null;
    if (seen && seen.status === status && (seen.hasInput || !hasInput)) return;
    const at = seen?.at ?? Date.now();
    this.#liveTools.set(id, { at, status, hasInput });
    const terminal = status === 'completed' || status === 'failed';
    // 带空格等可能含命令原文的 title 只进 detail；像标识符的才当名字写进 meta 级字段（见 toolNameFromTitle）。
    this.emit(
      'tool',
      {
        tool_call_id: id,
        name: merged.name ?? toolNameFromTitle(merged.title),
        kind: merged.kind ?? null,
        status,
        elapsed_ms: terminal ? Date.now() - at : undefined,
      },
      { title: livePreview(merged.title, 200), input_preview: summarizeToolInput(merged.input) },
    );
    this.usageTick();
  }

  approvalRequested(toolCall, description, mode, extra = {}) {
    const input = toolCall.rawInput ?? toolCall.input ?? null;
    this.emit(
      'approval',
      { tool_call_id: toolCall.toolCallId ?? null, tool: toolCall.name ?? null, mode, escalation: escalationOf(input), ...extra },
      { title: livePreview(description, 200), command_preview: summarizeToolInput(input) },
    );
  }

  endRun(runId, fields, error) {
    this.emit('run.end', { run: runId, ...fields }, { error: livePreview(error, 300) });
  }
}
