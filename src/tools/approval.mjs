/**
 * 审批收件箱与裁决类 MCP 工具：dsh_inbox、dsh_approval_decide。
 */

import { audit } from '../audit.mjs';
import { L } from '../lang.mjs';

export function createApprovalHandlers(hub) {
  return {
    async dsh_approval_decide(args) {
      const conv = await hub.get(args.conversation_id);
      const r = conv.decideApproval(args.approval_id, args.decision);
      audit('approval_decide', {
        conversation_id: conv.id,
        approval_id: r.approval_id,
        decision: r.decision,
        effective: r.effective,
      });
      const ok = r.effective === 'selected';
      return {
        structured: r,
        text: ok
          ? L(`审批 ${r.approval_id} 已裁决为 ${r.decision}。`, `Approval ${r.approval_id} decided: ${r.decision}.`)
          : L(
              `审批 ${r.approval_id} 未生效：DSH 没有提供 ${r.decision} 对应的选项，已按取消处理（effective=cancelled）。`,
              `Approval ${r.approval_id} did not take effect: DSH offered no option matching ${r.decision}, so it was treated as cancelled (effective=cancelled).`,
            ),
      };
    },

    async dsh_inbox(args) {
      const convs = args.conversation_id
        ? [await hub.get(args.conversation_id)]
        : [...hub.conversations.values()];
      const items = [];
      for (const conv of convs) {
        const snap = conv.snapshot();
        for (const d of snap.pending_approval_details ?? []) {
          items.push({
            conversation_id: snap.conversation_id,
            title: snap.title ?? null,
            cwd: snap.cwd,
            approval_id: d.approval_id,
            tool: d.tool ?? null,
            reason: d.reason ?? d.description ?? null,
            created_at: d.created_at ?? null,
            age_ms: d.created_at ? Date.now() - d.created_at : null,
            options: (d.options ?? []).map((o) => ({
              option_id: o.optionId,
              kind: o.kind,
              name: o.name,
            })),
            ...(args.include_input === false ? {} : { input: d.input ?? null }),
          });
        }
      }
      items.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
      const lines = items.map(
        (i) =>
          `- [${i.conversation_id}] ${i.title ?? L('(无标题)', '(untitled)')} | ${i.approval_id} | ${i.tool ?? '?'} | ` +
          `${i.reason ?? ''} | ${L('等待', 'waiting')}=${i.age_ms == null ? '?' : `${Math.round(i.age_ms / 1000)}s`}`,
      );
      return {
        structured: { count: items.length, approvals: items },
        text: items.length
          ? L(`${items.length} 个待决审批：\n`, `${items.length} pending approvals:\n`) + `${lines.join('\n')}\n\n` +
            L('裁决：', 'Decide: ') + 'dsh_approval_decide(conversation_id, approval_id, decision)'
          : L('(没有待决审批)', '(no pending approvals)'),
      };
    },
  };
}
