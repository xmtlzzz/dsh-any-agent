/**
 * 回合看门狗的判定（纯函数）：一个跑了很久的回合，是在正常推进、卡住了，还是超过了总时长上限。
 *
 * 为什么不是一个简单的超时：DSH 的回合本来就常跑十几分钟（实测一次修复任务 879 秒），
 * 按时长一刀切会误杀正在干活的回合。这里看的是**进展**：DSH 每推一次 session/update
 * （正文、思考、工具调用状态、用量）就算一次进展。
 *
 *   - 回合开始 `afterMs` 之后才开始判"卡住"（默认 15 分钟）；
 *   - 没有工具在跑、且 `stallMs` 内没有任何进展 → stalled；
 *   - 有工具在跑（例如 npm install、二十分钟的测试）时 DSH 本来就不会推更新，
 *     沉默不等于卡住，宽限放大到 `stallMs × TOOL_STALL_FACTOR`；
 *   - 正在等调用方裁决审批（on_approval=ask）时不判卡住 —— 那是在等人，审批自己有超时；
 *   - `maxMs` 是总时长上限，不看进展：陷在循环里的回合一直有"进展"，只有它拦得住。
 *
 * 任何阈值为 0 表示关闭那一项。
 */

/** 有工具在执行时，"多久没进展算卡住"的放大倍数。 */
export const TOOL_STALL_FACTOR = 3;

/**
 * @returns {null | {reason: 'stalled' | 'max_duration', limit_ms: number, tool_running?: boolean}}
 */
export function watchdogVerdict({ elapsedMs, sinceProgressMs, toolRunning, waitingOnCaller, afterMs, stallMs, maxMs }) {
  if (maxMs > 0 && elapsedMs >= maxMs) return { reason: 'max_duration', limit_ms: maxMs };
  if (!(afterMs > 0) || !(stallMs > 0) || elapsedMs < afterMs || waitingOnCaller) return null;
  const limit = toolRunning ? stallMs * TOOL_STALL_FACTOR : stallMs;
  return sinceProgressMs >= limit ? { reason: 'stalled', limit_ms: limit, tool_running: !!toolRunning } : null;
}

/** 巡检间隔：阈值的 1/5，夹在 50ms（测试用的小阈值）与 60 秒之间。 */
export function watchdogTickMs({ stallMs, maxMs }) {
  const base = Math.min(stallMs > 0 ? stallMs : Infinity, maxMs > 0 ? maxMs : Infinity);
  return Math.max(50, Math.min(60_000, Math.floor(base / 5)));
}
