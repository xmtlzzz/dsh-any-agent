/**
 * 回合结果的构造（纯函数，不碰进程、文件或会话状态）。
 *
 * 从 conversation.mjs 拆出来：同一个"没有正文的终态结果"对象以前在五处手写
 * （起不来、收尾异常、收尾二次异常、队列里被取消、插话等超时），审核单的挂载
 * 也重复了四次。字段一处漏改，哨兵与 dsh_get 的形状就会悄悄分叉。
 */

import { buildReviewTicket } from './review.mjs';

/**
 * 一个回合在没有（完整）正文时的终态结果：起不来、被取消、收尾异常。
 * 形状与正常收尾的 result 兼容（缺省的是正常收尾才有的 usage / diff_stat 等）。
 */
export function terminalResult({ conversationId, runId, stopReason, error, answer = '', toolsUsed = [], elapsedMs = 0 }) {
  return {
    conversation_id: conversationId,
    run_id: runId,
    stop_reason: stopReason,
    error,
    answer,
    thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
    tools_used: toolsUsed,
    workspace_changed: false,
    elapsed_ms: elapsedMs,
  };
}

/**
 * 按回合的审核策略把审核单挂到结果上（`mode === 'off'` 时不挂）。原地修改并返回 result。
 *
 * 审核单必须随结果一起返回（正文、structuredContent、哨兵都是同一份 result），
 * 否则调用方在异步收活时只会看到一段自述，很容易直接把它当成完成事实。
 */
export function attachReview(result, { conversationId, run, mode, permission }) {
  if (mode !== 'off') {
    result.review = buildReviewTicket({
      conversationId,
      runId: run.run_id,
      promptPreview: run.prompt_preview,
      result,
      mode,
      permission,
    });
  }
  return result;
}
