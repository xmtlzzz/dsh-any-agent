/**
 * 调用方审核（caller review）回归：**不调用模型、不拉起 DSH**。
 *
 * 守住的核心承诺：
 *   1) 默认 advisory：每个完成的 run 都带审核单（清单/证据/dsh_review 入口）；
 *   2) dsh_review 把裁决落到 `<state>/reviews/<conv>/<run>.review.json`，并回写内存 run 与哨兵；
 *   3) fail/partial 必须说明理由；未完成的回合不能审核；
 *   4) 服务重启 / run 记录被挤出内存后，仍能凭哨兵文件提交审核；
 *   5) 审核记录与哨兵都套用凭证脱敏，思考内容仍然不落盘。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-review-'));
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_HOME = join(root, 'dsh-home');
process.env.DSH_MCP_REVIEW = '';
delete process.env.DSH_MCP_REVIEWS_DIR;
delete process.env.DSH_MCP_RUNS_DIR;

const cfg = await import('../src/config.mjs');
const { Hub, Conversation, sanitizeResultForSentinel } = await import('../src/hub.mjs');
const { createHandlers } = await import('../src/tools.mjs');
const { buildReviewChecklist, buildReviewTicket, normalizeReviewMode, readReviewRecord } = await import('../src/review.mjs');

let pass = 0;
let failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const log = { info() {}, debug() {} };
const hub = new Hub({ log });
const conv = new Conversation(
  { id: 'review-test-conv', cwd: root, permission: 'workspace-write', review: 'advisory' },
  hub,
);
hub.conversations.set(conv.id, conv);
const handlers = createHandlers(hub);

/**
 * 造一个"已完成"的 run。真实的完成路径在 Conversation.prompt 的 finalize 里，
 * 这里只复制它挂审核单的那一步 —— 测试目标是审核单及 dsh_review，而不是 ACP 回合。
 */
function completedRun(prompt, { review = 'advisory', overrides = {} } = {}) {
  const run = conv.createRun(prompt, { review });
  run.status = 'done';
  run.started_at = Date.now() - 1234;
  run.ended_at = Date.now();
  run.elapsed_ms = 1234;
  run.result = {
    conversation_id: conv.id,
    run_id: run.run_id,
    stop_reason: 'end_turn',
    error: null,
    answer: '完成',
    thinking_stats: { hidden: true, chars: 10, chunks: 2, ms: 100 },
    tools_used: [{ name: 'pwsh', title: 'pwsh', input: { command: 'npm test' } }],
    usage: null,
    workspace_changed: true,
    diff_stat: { changed_files: 2, files: ['a.js', 'b.js'] },
    elapsed_ms: 1234,
    ...overrides,
  };
  if (run.review_mode !== 'off') {
    run.result.review = buildReviewTicket({
      conversationId: conv.id,
      runId: run.run_id,
      promptPreview: run.prompt_preview,
      result: run.result,
      mode: run.review_mode,
      permission: conv.permission,
    });
  }
  hub.writeRunSentinel(conv.id, run);
  return run;
}

try {
  console.log('\n[1] 默认策略与纯函数');
  check('★ 默认审核策略是 advisory', cfg.DEFAULT_REVIEW === 'advisory', cfg.DEFAULT_REVIEW);
  check('REVIEW_MODES 包含 off/advisory', cfg.REVIEW_MODES.join(',') === 'off,advisory', cfg.REVIEW_MODES.join(','));
  check('normalize("off") = off', normalizeReviewMode('off') === 'off');
  check('normalize(false) = off', normalizeReviewMode(false) === 'off');
  check('normalize("bogus") 回落 advisory', normalizeReviewMode('bogus') === 'advisory');
  check('normalize("on") = advisory', normalizeReviewMode('on') === 'advisory');

  const checklist = buildReviewChecklist({
    result: {
      tools_used: [{ name: 'pwsh' }],
      workspace_changed: true,
      diff_stat: { changed_files: 2 },
      stop_reason: 'end_turn',
    },
    permission: 'workspace-write',
  });
  check('清单要求独立核验', checklist.some((x) => /独立核验/.test(x)), JSON.stringify(checklist));
  check('清单包含改动范围', checklist.some((x) => /改动范围/.test(x)));
  check('清单包含权限档', checklist.some((x) => /workspace-write/.test(x)));

  const failedChecklist = buildReviewChecklist({
    result: { stop_reason: 'error', error: 'boom' },
    permission: null,
  });
  check('异常回合的清单包含失败项', failedChecklist.some((x) => /没有正常结束/.test(x) && /boom/.test(x)), JSON.stringify(failedChecklist));
  check('没有权限档时不提权限', !failedChecklist.some((x) => /权限档/.test(x)));

  const pureTicket = buildReviewTicket({
    conversationId: 'c1',
    runId: 'run-x',
    promptPreview: 'do it',
    result: { tools_used: [{ name: 'pwsh' }], workspace_changed: true, diff_stat: { changed_files: 2 } },
    mode: 'advisory',
    permission: 'read-only',
  });
  check('ticket.review_id 由 run_id 派生', pureTicket.review_id === 'review-run-x', pureTicket.review_id);
  check('ticket 初始为 pending', pureTicket.status === 'pending' && pureTicket.verdict === null);
  check('ticket 带 dsh_review 入口', pureTicket.submit.tool === 'dsh_review' && pureTicket.submit.arguments.run_id === 'run-x');
  check('ticket 证据含工具与改动文件', pureTicket.evidence.tools.includes('pwsh') && pureTicket.evidence.changed_files === 2);

  console.log('\n[2] 完成回合：结果、dsh_get 与哨兵都带审核单');
  const run = completedRun('实现功能 X');
  const sentinelPath = hub.runSentinelPath(conv.id, run.run_id);
  const got = await handlers.dsh_get({ conversation_id: conv.id, run_id: run.run_id });
  check('dsh_get structured 带审核单', got.structured.run.review?.status === 'pending', JSON.stringify(got.structured.run.review));
  check('dsh_get 正文含审核块', /调用方审核/.test(got.text), got.text.slice(-500));
  check('dsh_get 正文给出 dsh_review 调用', /dsh_review\(/.test(got.text), got.text.slice(-300));
  check('dsh_get 正文含核验清单', /独立核验/.test(got.text));
  const sentinelPending = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  check('★ 哨兵带审核单', sentinelPending.result?.review?.status === 'pending', JSON.stringify(sentinelPending.result?.review));
  check('★ 哨兵审核单 id 与 run 对应', sentinelPending.result?.review?.review_id === `review-${run.run_id}`);

  console.log('\n[3] 提交 pass：落盘、内存、哨兵三处一致');
  const reviewed = await handlers.dsh_review({
    conversation_id: conv.id,
    run_id: run.run_id,
    verdict: 'pass',
    notes: '已看 git diff 并跑过测试',
  });
  check('返回 status=pass', reviewed.structured.status === 'pass' && reviewed.structured.verdict === 'pass', JSON.stringify(reviewed.structured));
  check('返回审核记录路径', typeof reviewed.structured.review_file === 'string' && existsSync(reviewed.structured.review_file));
  const record = JSON.parse(readFileSync(reviewed.structured.review_file, 'utf8'));
  check('★ 审核记录含裁决与理由', record.verdict === 'pass' && /git diff/.test(record.notes), JSON.stringify(record));
  check('审核记录含清单与证据', Array.isArray(record.checklist) && record.evidence?.changed_files === 2);
  check('审核记录是合法 JSON 且带 run_id', record.run_id === run.run_id);
  const gotReviewed = await handlers.dsh_get({ conversation_id: conv.id, run_id: run.run_id });
  check('dsh_get 显示已审核', /调用方审核 · pass/.test(gotReviewed.text), gotReviewed.text.slice(-300));
  check('内存 run.review 同步更新', gotReviewed.structured.run.review?.status === 'pass');
  const sentinelReviewed = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  check('★ 哨兵被回写为 pass', sentinelReviewed.result?.review?.status === 'pass', JSON.stringify(sentinelReviewed.result?.review));
  check('哨兵回写保留理由', /git diff/.test(String(sentinelReviewed.result?.review?.notes)));

  console.log('\n[4] fail/partial 必须说明理由；可修订裁决');
  await assert.rejects(
    () => handlers.dsh_review({ conversation_id: conv.id, run_id: run.run_id, verdict: 'fail' }),
    /notes/,
  );
  check('fail 无理由被拒绝', true);
  const partial = await handlers.dsh_review({
    conversation_id: conv.id,
    run_id: run.run_id,
    verdict: 'partial',
    findings: ['缺少边界测试', '没有更新文档'],
  });
  check('partial 可凭 findings 提交', partial.structured.status === 'partial', JSON.stringify(partial.structured));
  check('partial 保留 findings', partial.structured.findings.length === 2);
  check('修订裁决覆盖旧记录', readReviewRecord(conv.id, run.run_id)?.verdict === 'partial');

  console.log('\n[5] 未完成 / 未知 run');
  const running = conv.createRun('还在跑的任务', { review: 'advisory' });
  running.status = 'running';
  await assert.rejects(
    () => handlers.dsh_review({ conversation_id: conv.id, run_id: running.run_id, verdict: 'pass', notes: 'x' }),
    /还没结束/,
  );
  check('running 的 run 不能审核', true);
  await assert.rejects(
    () => handlers.dsh_review({ conversation_id: conv.id, run_id: 'run-does-not-exist', verdict: 'pass', notes: 'x' }),
    /未知 run_id/,
  );
  check('未知 run_id 给出明确错误', true);

  console.log('\n[6] review=off：不自动生成，但仍可显式审核');
  const offRun = completedRun('关闭审核的任务', { review: 'off' });
  check('off run 的结果不带审核单', !offRun.result.review);
  check('off run 的 pendingReviewTicket 为 null', conv.pendingReviewTicket(offRun.run_id) === null);
  const offReviewed = await handlers.dsh_review({
    conversation_id: conv.id,
    run_id: offRun.run_id,
    verdict: 'pass',
    notes: '手动补审核',
  });
  check('off run 仍可显式审核', offReviewed.structured.status === 'pass');

  console.log('\n[7] 服务重启 / run 被挤出内存：按哨兵审核');
  const restartRun = completedRun('重启后审核的任务');
  const hub2 = new Hub({ log });
  const conv2 = new Conversation(
    { id: conv.id, cwd: root, permission: 'workspace-write', review: 'advisory' },
    hub2,
  );
  hub2.conversations.set(conv.id, conv2);
  const handlers2 = createHandlers(hub2);
  check('新实例内存里没有 run 记录', conv2.runs.length === 0);
  const restartReviewed = await handlers2.dsh_review({
    conversation_id: conv.id,
    run_id: restartRun.run_id,
    verdict: 'pass',
    notes: '从哨兵文件审核',
  });
  check('★ 重启后仍可审核', restartReviewed.structured.status === 'pass', JSON.stringify(restartReviewed.structured));
  const sentinelRestart = JSON.parse(readFileSync(hub.runSentinelPath(conv.id, restartRun.run_id), 'utf8'));
  check('★ 重启路径也回写哨兵', sentinelRestart.result?.review?.status === 'pass');

  console.log('\n[8] 脱敏：审核记录与哨兵都不落明文凭证');
  const secretRun = completedRun('please use token=PROMPTLEAK12345');
  const secretReviewed = await handlers.dsh_review({
    conversation_id: conv.id,
    run_id: secretRun.run_id,
    verdict: 'fail',
    notes: 'api_key=NOTESLEAK12345 仍然不对',
  });
  const recordText = readFileSync(secretReviewed.structured.review_file, 'utf8');
  check('★ 审核记录不含 prompt 里的凭证', !recordText.includes('PROMPTLEAK12345'), recordText);
  check('★ 审核记录不含 notes 里的凭证', !recordText.includes('NOTESLEAK12345'), recordText);
  check('审核记录保留脱敏标记', recordText.includes('[REDACTED]'));

  const safe = sanitizeResultForSentinel({
    answer: 'x',
    thinking: 'THINK_SECRET',
    review: {
      prompt_preview: 'token=SENTINELPROMPT12345',
      notes: 'password: SENTINELNOTES12345',
      checklist: ['独立核验'],
      evidence: { error: 'Bearer SENTINELEVIDENCE12345' },
    },
  });
  check('哨兵保留审核单结构', Array.isArray(safe.review?.checklist) && safe.review.checklist[0] === '独立核验');
  check('★ 哨兵里的审核单已脱敏', !JSON.stringify(safe.review).includes('SENTINEL'));
  check('思考内容仍被剥掉', safe.thinking === undefined && safe.thinking_omitted === true);

  console.log('\n[9] 待审核收据与状态持久化');
  const pendingRun = conv.createRun('后台任务', { review: 'advisory' });
  const pendingTicket = conv.pendingReviewTicket(pendingRun.run_id);
  check('pending ticket 状态为 pending', pendingTicket?.status === 'pending');
  check('pending ticket 提示等回合结束', /后台/.test(String(pendingTicket?.instructions)), pendingTicket?.instructions);
  check('toState 持久化 review 策略', conv.toState().review === 'advisory');
  check('构造函数尊重 off', new Conversation({ id: 'x1', cwd: root, review: 'off' }, hub).review === 'off');
  check('构造函数对非法值回落 advisory', new Conversation({ id: 'x2', cwd: root, review: 'bogus' }, hub).review === 'advisory');

  console.log('\n[10] 0.5.0 派发面：队列与幂等重放也带审核单');
  const queued = conv.enqueue('排队任务', { clientRunId: 'q-review-1', review: 'advisory' });
  check('入队的 run 带审核策略', queued.run.review_mode === 'advisory', JSON.stringify(queued));
  check('入队后可取待审核单', conv.pendingReviewTicket(queued.run.run_id)?.status === 'pending');
  conv.queueRemove(queued.run.run_id);
  const queuedSentinel = JSON.parse(readFileSync(hub.runSentinelPath(conv.id, queued.run.run_id), 'utf8'));
  check('取消排队也写审核单', queuedSentinel.result?.review?.status === 'pending', JSON.stringify(queuedSentinel.result?.review));

  const replayRunRecord = conv.createRun('幂等任务', { clientRunId: 'replay-review-1', review: 'advisory' });
  replayRunRecord.status = 'done';
  replayRunRecord.ended_at = Date.now();
  replayRunRecord.elapsed_ms = 10;
  replayRunRecord.result = {
    conversation_id: conv.id,
    run_id: replayRunRecord.run_id,
    stop_reason: 'end_turn',
    error: null,
    answer: '完成',
    tools_used: [],
    workspace_changed: false,
    elapsed_ms: 10,
  };
  replayRunRecord.result.review = buildReviewTicket({
    conversationId: conv.id,
    runId: replayRunRecord.run_id,
    promptPreview: replayRunRecord.prompt_preview,
    result: replayRunRecord.result,
    mode: replayRunRecord.review_mode,
    permission: conv.permission,
  });
  const replayed = await handlers.dsh_send({
    conversation_id: conv.id,
    prompt: '幂等任务',
    client_run_id: 'replay-review-1',
    wait: false,
  });
  check('幂等重放标记 replayed', replayed.structured.replayed === true, JSON.stringify(replayed.structured));
  check('重放结果仍带审核单', replayed.structured.review?.status === 'pending');
  check('重放文本含审核块', /调用方审核/.test(replayed.text), replayed.text.slice(-400));

  const runningReplay = conv.createRun('仍在跑的任务', { clientRunId: 'replay-review-2', review: 'advisory' });
  runningReplay.status = 'running';
  const runningReply = await handlers.dsh_send({
    conversation_id: conv.id,
    prompt: '仍在跑的任务',
    client_run_id: 'replay-review-2',
    wait: false,
  });
  check('运行中重放带待审核单', runningReply.structured.review?.status === 'pending', JSON.stringify(runningReply.structured.review));

  console.log('\n[11] 审核记录与哨兵共享 TTL');
  const oldReview = join(cfg.REVIEWS_DIR, 'conv-prune-test', 'run-old.review.json');
  const freshReview = join(cfg.REVIEWS_DIR, 'conv-prune-test', 'run-fresh.review.json');
  mkdirSync(dirname(oldReview), { recursive: true });
  writeFileSync(oldReview, JSON.stringify({ verdict: 'pass' }), 'utf8');
  writeFileSync(freshReview, JSON.stringify({ verdict: 'pass' }), 'utf8');
  const tenDaysAgo = Date.now() / 1000 - 10 * 24 * 3600;
  utimesSync(oldReview, tenDaysAgo, tenDaysAgo);
  const pruned = hub.pruneSentinels({ ttlMs: 7 * 24 * 3600 * 1000 });
  check('★ 过期审核记录被清理', !existsSync(oldReview), oldReview);
  check('★ 新鲜审核记录保留', existsSync(freshReview), freshReview);
  check('prune 返回 reviews_pruned', pruned.reviews_pruned >= 1, JSON.stringify(pruned));
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log(`\n===== 调用方审核测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);
