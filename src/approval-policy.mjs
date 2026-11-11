/**
 * 审批策略（纯函数）：一次 session/request_permission 该放行、拒绝还是挂起给调用方。
 *
 * 从 conversation.mjs 拆出来，把"规则"和"挂起/超时/live 事件这些副作用"分开：
 * 规则可以单测，副作用留在会话里。
 */

import { approvalContext } from './acp-session.mjs';
import { sanitizeApprovalContext } from './redact.mjs';

/** 每个回合最多保留多少条"自动放行审批"摘要（总数另计，不受此限）。 */
export const MAX_AUTO_APPROVALS_KEPT = 20;
/** 自动放行审批里命令预览的长度。 */
const MAX_AUTO_APPROVAL_PREVIEW = 200;

/**
 * 决定怎么处理一次审批：'deny' | 'allow' | 'ask'。
 *
 * ★ read-only 是硬边界：即使会话被旧版本/显式参数配成 auto-allow，也绝不放行 ——
 *   DSH 会借审批把 sandbox 提权到可写。
 */
export function approvalDecision({ permission, onApproval }) {
  if (permission === 'read-only') return 'deny';
  if (onApproval === 'auto-allow') return 'allow';
  if (onApproval === 'auto-deny') return 'deny';
  return 'ask';
}

/** 这次审批申请的沙箱提权档（DSH 的 `sandbox_permissions`），没有则 null。 */
export function escalationOf(input) {
  return input && typeof input === 'object' && typeof input.sandbox_permissions === 'string'
    ? input.sandbox_permissions
    : null;
}

/**
 * 一条"被自动放行的审批"摘要（只含摘要、且已脱敏），挂进回合结果的 `auto_approvals`。
 */
export function autoApprovalSummary(params, toolCall, desc, options) {
  const input = toolCall.rawInput ?? toolCall.input ?? null;
  const ctx = approvalContext(params, toolCall, desc, options);
  const cmd = input && typeof input === 'object' ? input.command ?? input.cmd ?? null : null;
  return {
    tool: ctx.tool ?? desc,
    tool_call_id: ctx.tool_call_id ?? null,
    escalation: escalationOf(input),
    reason: typeof ctx.reason === 'string' ? ctx.reason.slice(0, 300) : null,
    command_preview:
      typeof cmd === 'string' ? sanitizeApprovalContext(cmd, 'command').slice(0, MAX_AUTO_APPROVAL_PREVIEW) : null,
    at: new Date().toISOString(),
  };
}
