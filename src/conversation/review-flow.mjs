/**
 * 调用方审核流程：生成待审核单、校验裁决、落盘审核记录并回写内存 run 与完成哨兵。
 */

import { readFileSync } from 'node:fs';
import { L } from '../lang.mjs';
import { assertSafeId } from '../ids.mjs';
import {
  REVIEW_VERDICTS,
  buildReviewTicket,
  readReviewRecord,
  reviewIdForRun,
  writeReviewRecord,
} from '../review.mjs';

export function pendingReviewTicket(conv, runId) {
  const run = conv.ledger.find(runId);
  const mode = run?.review_mode ?? conv.review;
  if (mode === 'off') return null;
  return buildReviewTicket({
    conversationId: conv.id,
    runId,
    promptPreview: run?.prompt_preview ?? null,
    result: null,
    mode,
    permission: conv.permission,
    pending: true,
  });
}

export function submitReview(conv, { hub }, runId, { verdict = undefined, notes = undefined, findings = undefined } = {}) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error(L('run_id 不能为空', 'run_id must not be empty'));
  }
  assertSafeId(runId, 'run_id');
  if (!REVIEW_VERDICTS.includes(verdict)) {
    throw new Error(L(`verdict 必须是 ${REVIEW_VERDICTS.join(' | ')} 之一`, `verdict must be one of ${REVIEW_VERDICTS.join(' | ')}`));
  }
  const cleanNotes = typeof notes === 'string' ? notes.trim() : '';
  const cleanFindings = Array.isArray(findings)
    ? findings.filter((f) => typeof f === 'string' && f.trim() !== '').map((f) => f.trim())
    : [];
  if (verdict !== 'pass' && !cleanNotes && !cleanFindings.length) {
    throw new Error(L(
      'verdict=fail/partial 时必须提供 notes（或 findings）说明理由',
      'notes (or findings) are required when verdict is fail or partial',
    ));
  }

  const run = conv.ledger.find(runId);
  let result = run?.result ?? null;
  let promptPreview = run?.prompt_preview ?? null;
  let mode = run?.review_mode ?? conv.review;

  if (run) {
    if (run.status === 'running' || run.status === 'queued') {
      throw new Error(L(
        `回合 ${runId} 还没结束，不能审核（等哨兵文件出现或 dsh_get 显示完成后重试）`,
        `Run ${runId} has not finished yet and cannot be reviewed (wait for the sentinel file or dsh_get to show completion)`,
      ));
    }
    if (!result) {
      throw new Error(L(`回合 ${runId} 没有可用结果，无法审核`, `Run ${runId} has no result available to review`));
    }
  } else {
    let sentinel = null;
    try {
      sentinel = JSON.parse(readFileSync(hub.runSentinelPath(conv.id, runId), 'utf8'));
    } catch {
      /* 下面的审核记录回退会给出更准确的错误 */
    }
    if (sentinel) {
      result = sentinel.result ?? null;
      if (result?.review && typeof result.review === 'object') {
        promptPreview = result.review.prompt_preview ?? promptPreview;
        mode = result.review.mode ?? mode;
      }
    }
  }

  const existing = readReviewRecord(conv.id, runId);
  if (!result && !existing) {
    throw new Error(L(
      `未知 run_id: ${runId}（内存里没有、也没有哨兵/审核记录；请确认 run_id 是否正确，或先用 dsh_get / 哨兵文件取回结果）`,
      `Unknown run_id: ${runId} (not in memory and no sentinel or review record exists; check the run_id or fetch the result via dsh_get / sentinel first)`,
    ));
  }

  const ticket =
    result?.review && typeof result.review === 'object'
      ? { ...result.review }
      : existing
        ? { ...existing }
        : buildReviewTicket({
            conversationId: conv.id,
            runId,
            promptPreview,
            result: result ?? {},
            mode,
            permission: conv.permission,
          });
  if (!ticket.review_id) ticket.review_id = reviewIdForRun(runId);
  ticket.conversation_id = ticket.conversation_id ?? conv.id;
  ticket.run_id = ticket.run_id ?? runId;
  ticket.mode = ticket.mode ?? mode;

  const reviewedAt = new Date().toISOString();
  const { file, payload } = writeReviewRecord({
    ticket,
    verdict,
    notes: cleanNotes,
    findings: cleanFindings,
    reviewedAt,
  });
  const review = {
    ...ticket,
    status: verdict,
    verdict,
    notes: payload.notes,
    findings: payload.findings,
    reviewed_at: reviewedAt,
    review_file: file,
  };
  if (run) {
    run.review = review;
    if (run.result && typeof run.result === 'object') run.result.review = review;
  }
  hub.updateRunSentinelReview(conv.id, runId, {
    status: review.status,
    verdict: review.verdict,
    notes: review.notes,
    findings: review.findings,
    reviewed_at: reviewedAt,
    review_file: file,
  });
  return {
    ...review,
    review_file: file,
    sentinel_file: hub.runSentinelPath(conv.id, runId),
  };
}
