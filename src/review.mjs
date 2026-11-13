/**
 * 调用方审核（caller review）。
 *
 * 背景：dsh-any-agent 返回的是**另一个 agent 的自述**（"我改好了 / 测试通过了"）。
 * 调用方（Claude Code、Codex、Cursor…）最常见的失败模式是把它直接转述给用户，
 * 而不做任何独立核验。这个模块把"审核"变成返回载荷的一部分：
 *
 *   - 每个回合结束时生成一张审核单（review ticket）：核验清单 + 证据摘要 + dsh_review 入口；
 *   - 审核单随结果正文、structuredContent、异步哨兵一起返回；
 *   - 调用方用 dsh_review 提交 pass / partial / fail，裁决落盘并回写到内存 run 与哨兵。
 *
 * 设计边界（刻意保持简单、可预测）：
 *   - 默认 advisory：审核单很显眼，但**不阻塞**后续 dsh_send；
 *   - 只记录裁决，**不自动**把审核意见回灌给 DSH（是否重派由调用方决定）；
 *   - 审核单不含思考正文；落盘前套用与审批上下文相同的凭证脱敏。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_REVIEW, REVIEWS_DIR, REVIEW_MODES } from './config.mjs';
import { sanitizeApprovalContext } from './redact.mjs';
import { assertSafeId } from './ids.mjs';
import { L } from './lang.mjs';

/** dsh_review 允许的裁决。 */
export const REVIEW_VERDICTS = ['pass', 'partial', 'fail'];

const MAX_NOTES = 8_000;
const MAX_FINDING = 2_000;
const MAX_FINDINGS = 50;
const MAX_PROMPT_PREVIEW = 200;

/** 把来自参数/环境变量的审核模式收敛到受支持的值；非法值回落到 fallback。 */
export function normalizeReviewMode(value, fallback = DEFAULT_REVIEW) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) return 'advisory';
  if (value === false) return 'off';
  const v = String(value).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === '1' || v === 'true' || v === 'on' || v === 'advisory' || v === 'yes') return 'advisory';
  return REVIEW_MODES.includes(v) ? v : fallback;
}

export function reviewIdForRun(runId) {
  return `review-${runId}`;
}

/** 审核记录的落盘路径（按会话分目录，与哨兵同样的命名空间思路）。 */
export function reviewFilePath(conversationId, runId) {
  assertSafeId(conversationId, 'conversation_id');
  assertSafeId(runId, 'run_id');
  return join(REVIEWS_DIR, conversationId, `${runId}.review.json`);
}

function toolNames(result) {
  return [...new Set((result?.tools_used ?? []).map((t) => t?.name ?? t?.title).filter(Boolean))];
}

/**
 * 生成审核清单。清单是**通用的**，因为服务端不知道调用方能用哪些工具；
 * 但它会随结果形状变化（有没有改动、有没有错误、用了哪些工具）。
 */
export function buildReviewChecklist({ result = {}, permission = null } = {}) {
  const tools = toolNames(result);
  const items = [
    L(
      '逐条对照原任务：答复是真正完成了要求，还是只描述计划 / 只完成了一部分？',
      'Compare against the original task item by item: did the answer really do what was asked, or only describe a plan / do part of it?',
    ),
    L(
      '不要只复述 DSH 的答复：至少做一项独立核验（读改动的文件、查看 git diff、运行相关测试或命令）。',
      "Do not just relay DSH's answer: do at least one independent check (read the changed files, look at git diff, run the relevant tests or commands).",
    ),
  ];
  if (tools.length) {
    items.push(L(
      `核对工具执行结果：本轮用到 [${tools.join(', ')}]，确认关键命令/写入的退出状态与产出符合预期。`,
      `Check what the tools did: this turn used [${tools.join(', ')}]; confirm the exit status and output of the key commands and writes are what you expect.`,
    ));
  }
  if (result.git_snapshot_incomplete) {
    items.push(L(
      '最终 Git 快照未完成，请检查工作区，确认本轮实际改动。',
      'The final Git snapshot was incomplete. Inspect the workspace to verify the changes from this turn.',
    ));
  } else if (result.workspace_changed) {
    const n = result.diff_stat?.changed_files;
    items.push(L(
      `检查改动范围：工作区发生了变化${Number.isFinite(n) ? `（当前有 ${n} 个文件有改动）` : ''}，确认都在预期内，没有越界修改。`,
      `Check the scope of the changes: the workspace changed${Number.isFinite(n) ? ` (${n} files currently modified)` : ''}; confirm every change is expected and nothing outside the task was touched.`,
    ));
  } else if (tools.length) {
    items.push(L(
      '如果 DSH 声称做了修改，确认工作区确实发生了变化（workspace_changed=false 可能意味着没有真正落地）。',
      'If DSH claims it made changes, confirm the workspace really changed (workspace_changed=false may mean nothing landed).',
    ));
  }
  if (result.error || (result.stop_reason && result.stop_reason !== 'end_turn')) {
    items.push(L(
      `回合没有正常结束（stop_reason=${result.stop_reason ?? 'null'}${
        result.error ? `；error=${String(result.error).slice(0, 160)}` : ''
      }），确认影响并决定是否重派。`,
      `The turn did not end normally (stop_reason=${result.stop_reason ?? 'null'}${
        result.error ? `; error=${String(result.error).slice(0, 160)}` : ''
      }); work out the impact and decide whether to dispatch again.`,
    ));
  }
  if (result.watchdog && typeof result.watchdog === 'object') {
    const w = result.watchdog;
    const min = (ms) => Math.round((Number(ms) || 0) / 60000);
    items.push(L(
      (w.reason === 'max_duration'
        ? `本轮跑满总时长上限（${min(w.limit_ms)} 分钟），被看门狗中断`
        : `本轮 ${min(w.since_progress_ms)} 分钟没有任何进展${w.current_tool ? `（卡在工具 ${w.current_tool}）` : ''}，被看门狗中断`) +
        '：正文可能不完整，已改动的文件不会回滚。先看清做到了哪一步，再决定是接着派活还是重来。',
      (w.reason === 'max_duration'
        ? `This turn hit the total duration cap (${min(w.limit_ms)} min) and was interrupted by the watchdog`
        : `This turn made no progress for ${min(w.since_progress_ms)} min${w.current_tool ? ` (stuck in tool ${w.current_tool})` : ''} and was interrupted by the watchdog`) +
        ': the answer may be incomplete and changed files are not rolled back. Find out how far it got before deciding whether to continue or start over.',
    ));
  }
  const autoTotal = Number(result.auto_approvals_total) || 0;
  if (autoTotal > 0) {
    const esc = Number(result.auto_escalations_total) || 0;
    items.push(L(
      `本轮有 ${autoTotal} 次审批被自动放行（on_approval=auto-allow）` +
        (esc > 0 ? `，其中 ${esc} 次申请了沙箱提权（如 danger-full-access），这些操作已在 ${permission ?? '权限档'} 之外执行` : '') +
        '：对照 result.auto_approvals 逐条确认是否在预期内；需要逐次把关就用 on_approval=ask 新建会话。',
      `${autoTotal} approvals were auto-allowed this turn (on_approval=auto-allow)` +
        (esc > 0 ? `, ${esc} of them sandbox escalations (such as danger-full-access) that ran outside ${permission ?? 'the permission tier'}` : '') +
        ': go through result.auto_approvals and confirm each was expected; to decide each one yourself, create a conversation with on_approval=ask.',
    ));
  }
  if (permission) {
    items.push(L(
      `确认操作没有超出会话权限档（${permission}）。`,
      `Confirm nothing went beyond the conversation's permission tier (${permission}).`,
    ));
  }
  items.push(L(
    '裁决：pass（可直接采用）/ partial（部分可用，需补充）/ fail（不可用，需重做）；fail/partial 必须在 notes 里说明理由。',
    'Verdict: pass (usable as is) / partial (partly usable, needs more work) / fail (unusable, redo); fail and partial must give the reason in notes.',
  ));
  return items;
}

/**
 * 构造审核单。回合结束时带完整 result；wait=false 的收据里带 pending 版本
 * （此时还不知道结果，只提示"跑完后要审核"）。
 */
export function buildReviewTicket({
  conversationId,
  runId,
  promptPreview = null,
  result = null,
  mode = 'advisory',
  permission = null,
  pending = false,
} = {}) {
  const evidence = {
    stop_reason: result?.stop_reason ?? null,
    error: result?.error ? String(result.error).slice(0, 500) : null,
    workspace_changed: result?.git_snapshot_incomplete ? null : result?.workspace_changed ?? null,
    changed_files: result?.diff_stat?.changed_files ?? null,
    tools: toolNames(result),
    auto_approvals: Number.isFinite(result?.auto_approvals_total) ? result.auto_approvals_total : null,
    auto_escalations: Number.isFinite(result?.auto_escalations_total) ? result.auto_escalations_total : null,
    elapsed_ms: result?.elapsed_ms ?? null,
  };
  return {
    review_id: reviewIdForRun(runId),
    mode,
    status: 'pending',
    verdict: null,
    run_id: runId,
    conversation_id: conversationId,
    prompt_preview: promptPreview ? String(promptPreview).slice(0, MAX_PROMPT_PREVIEW) : null,
    checklist: buildReviewChecklist({ result: result ?? {}, permission }),
    evidence,
    submit: {
      tool: 'dsh_review',
      arguments: {
        conversation_id: conversationId,
        run_id: runId,
        verdict: 'pass|partial|fail',
        notes: L('审核理由', 'reason'),
      },
    },
    instructions: pending
      ? L(
          '回合还在后台跑。等哨兵文件出现、拿到结果后，先按清单独立核验，再调用 dsh_review 提交裁决。',
          'The turn is still running in the background. Once the sentinel file exists and you have the result, verify it against the checklist, then submit a verdict with dsh_review.',
        )
      : L(
          '在把这次结果当作完成之前，先按清单独立核验，再调用 dsh_review 提交裁决。建议式审核：不阻塞后续 dsh_send，但未审核的结果不应直接当作完成。',
          'Before treating this result as done, verify it against the checklist, then submit a verdict with dsh_review. Reviews are advisory: they do not block later dsh_send calls, but an unreviewed result should not be taken as done.',
        ),
  };
}

function clampText(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings
    .slice(0, MAX_FINDINGS)
    .map((f) => clampText(f, MAX_FINDING))
    .filter((f) => typeof f === 'string' && f.trim() !== '');
}

/**
 * 写审核记录（原子落盘）。
 *
 * 失败会抛出：审核本身就是这次操作的目的，静默失败比报错更糟 ——
 * 调用方会以为裁决已经记录，而磁盘上什么都没有。
 */
export function writeReviewRecord({ ticket, verdict, notes, findings, reviewedAt }) {
  const file = reviewFilePath(ticket.conversation_id, ticket.run_id);
  const payload = {
    version: 1,
    review_id: ticket.review_id ?? reviewIdForRun(ticket.run_id),
    conversation_id: ticket.conversation_id,
    run_id: ticket.run_id,
    mode: ticket.mode ?? 'advisory',
    verdict,
    status: verdict,
    notes: sanitizeApprovalContext(clampText(notes, MAX_NOTES), 'notes'),
    findings: sanitizeApprovalContext(cleanFindings(findings)),
    reviewed_at: reviewedAt,
    review_file: file,
    prompt_preview: sanitizeApprovalContext(ticket.prompt_preview ?? null, 'prompt_preview'),
    // 清单里可能拼进 result.error（例如 `error=... token=sk-...`），落盘前必须逐项脱敏。
    // 哨兵走的是 sanitizeResultForSentinel，这里若漏掉，审核记录会成为第二个明文泄漏点。
    checklist: Array.isArray(ticket.checklist)
      ? ticket.checklist.map((item) => sanitizeApprovalContext(item))
      : [],
    evidence: sanitizeApprovalContext(ticket.evidence ?? null),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    throw new Error(L(`写审核记录失败（${file}）: ${e.message}`, `Could not write the review record (${file}): ${e.message}`));
  }
  return { file, payload };
}

/** 读已有审核记录；不存在/损坏时返回 null（由调用方决定是否继续）。 */
export function readReviewRecord(conversationId, runId) {
  try {
    return JSON.parse(readFileSync(reviewFilePath(conversationId, runId), 'utf8'));
  } catch {
    return null;
  }
}
