/**
 * 会话审批桥接：只读硬拒绝、自动放行提权记录、`ask` 挂起与调用方裁决。
 */

import { L } from '../lang.mjs';
import { sanitizeApprovalContext } from '../redact.mjs';
import { approvalContext, pickOption } from '../acp-session.mjs';
import { MAX_AUTO_APPROVALS_KEPT, approvalDecision, autoApprovalSummary, escalationOf } from '../approval-policy.mjs';

const now = () => Date.now();

function recordAutoApproval(conv, params, toolCall, desc, options) {
  const c = conv.collector;
  if (!c) return;
  c.autoApprovalTotal = (c.autoApprovalTotal ?? 0) + 1;
  if (escalationOf(toolCall.rawInput ?? toolCall.input ?? null)) c.autoEscalationTotal = (c.autoEscalationTotal ?? 0) + 1;
  if (!Array.isArray(c.autoApprovals)) c.autoApprovals = [];
  if (c.autoApprovals.length >= MAX_AUTO_APPROVALS_KEPT) return;
  c.autoApprovals.push(autoApprovalSummary(params, toolCall, desc, options));
}

/** @param {import('../types.mjs').ConversationContext} ctx */
export async function handlePermissionRequest(conv, ctx, params) {
  const { hub, activity } = ctx;
  const options = params?.options ?? [];
  const rawToolCall = params?.toolCall ?? {};
  const known = conv.collector?.tools?.get(rawToolCall.toolCallId) ?? null;
  const toolCall = known
    ? {
        ...rawToolCall,
        name: rawToolCall.name ?? known.name,
        title: rawToolCall.title ?? known.title,
        kind: rawToolCall.kind ?? known.kind,
        rawInput: rawToolCall.rawInput ?? rawToolCall.input ?? known.input,
        locations: rawToolCall.locations ?? known.locations,
      }
    : rawToolCall;
  const desc = sanitizeApprovalContext(
    String(toolCall.title ?? toolCall.name ?? toolCall.toolCallId ?? L('未知操作', 'unknown operation')),
  );
  const allowId = pickOption(options, 'allow');
  const rejectId = pickOption(options, 'reject');
  const liveApproval = (mode, extra) => activity.approvalRequested(toolCall, desc, mode, extra);
  const reject = () =>
    rejectId ? { outcome: { outcome: 'selected', optionId: rejectId } } : { outcome: { outcome: 'cancelled' } };

  const decision = approvalDecision({ permission: conv.permission, onApproval: conv.onApproval });
  if (decision === 'deny') {
    const readOnly = conv.permission === 'read-only';
    hub.log.info(`[conv ${conv.id}] ${readOnly ? 'read-only 强制拒绝审批' : '审批拒绝'}: ${desc}`);
    liveApproval(readOnly ? 'read-only-deny' : 'auto-deny');
    return reject();
  }
  if (decision === 'allow') {
    hub.log.info(`[conv ${conv.id}] 审批放行: ${desc}`);
    if (allowId) recordAutoApproval(conv, params, toolCall, desc, options);
    liveApproval('auto-allow');
    return allowId
      ? { outcome: { outcome: 'selected', optionId: allowId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  const approvalId = `ap-${Math.random().toString(36).slice(2, 10)}`;
  const runId = conv.currentRun?.run_id;
  hub.log.info(`[conv ${conv.id}] 审批待裁决: ${approvalId}`);
  liveApproval('ask', { approval_id: approvalId });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (conv.pendingApprovals.delete(approvalId)) {
        hub.log.info(`[conv ${conv.id}] 审批 ${approvalId} 超时，按拒绝处理`);
        activity.approvalDecided(approvalId, 'timeout', 'reject', 'cancelled');
        resolve({ outcome: { outcome: 'cancelled' } });
      }
    }, hub.approvalTimeoutMs);
    conv.pendingApprovals.set(approvalId, {
      runId,
      params: { tool: desc, details: approvalContext(params, toolCall, desc, options) },
      createdAt: now(),
      allowId,
      rejectId,
      resolve: (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
    });
    if (runId) hub.setRunApprovalPending?.(conv.id, runId, true);
  }).finally(() => {
    if (runId && ![...conv.pendingApprovals.values()].some((p) => p.runId === runId)) {
      hub.setRunApprovalPending?.(conv.id, runId, false);
    }
  });
}

/** @param {import('../types.mjs').ConversationContext} ctx */
export function decideApproval(conv, ctx, approvalId, decision) {
  const { activity } = ctx;
  const p = conv.pendingApprovals.get(approvalId);
  if (!p) throw new Error(L(`没有待决审批: ${approvalId}`, `No pending approval: ${approvalId}`));
  conv.pendingApprovals.delete(approvalId);
  const chosen = decision === 'allow' ? p.allowId : p.rejectId;
  const effective = chosen ? 'selected' : 'cancelled';
  p.resolve(chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } });
  activity.approvalDecided(approvalId, 'caller', decision, effective);
  return {
    approval_id: approvalId,
    decision,
    effective,
    ...(chosen ? {} : { reason: 'no_option' }),
  };
}
