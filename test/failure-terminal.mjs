/**
 * 失败路径的终态（离线，不需要 DSH、不调用模型）。
 *
 * 守三条不变量：
 *   1. ensureAlive 失败时，dsh_interject 的等待者必须被唤醒（否则默认 timeout=0 会永久挂起）；
 *   2. 同一次失败要落一条 error 哨兵，并给错误挂上 runId；
 *   3. 审批没有对应 option 时，effective 必须是 cancelled，不能报"已裁决为 allow"。
 *   4. dsh_get 在内存 run 记录过期后，能从哨兵文件回读。
 */

import './live-sandbox.mjs'; // 必须是第一条 import：live 事件别写进真实 ~/.dsh
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { Conversation } from '../src/hub.mjs';
import { createHandlers } from '../src/tools.mjs';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const log = { info() {}, debug() {}, dshStderr() {} };
const root = process.cwd();
const sentinels = [];
const hub = {
  log,
  approvalTimeoutMs: 300_000,
  save() {},
  clearRunSentinel() {},
  writeRunSentinel(id, run) {
    sentinels.push({ id, status: run.status, run_id: run.run_id, result: run.result });
    return join(tmpdir(), `${run.run_id}.json`);
  },
  runSentinelPath(id, runId) {
    return join(tmpdir(), `dsh-sentinel-${id}`, `${runId}.json`);
  },
};

console.log('\n[1] ensureAlive 失败时唤醒插话等待者，并落 error 哨兵');

const conv = new Conversation({
  id: 'failure-terminal-1',
  cwd: root,
  permission: 'read-only',
  onApproval: 'auto-deny',
}, hub);
conv.ensureAlive = async () => {
  throw new Error('session-writer-held: 另一个进程持有写锁');
};

const sendP = conv.prompt('go', { wait: false }).catch((e) => e);
const steerP = conv.interject('插话', { mode: 'queue', timeoutMs: 0 }).then(
  () => 'resolved',
  (e) => `rejected:${e.message}`,
);
const outcome = await Promise.race([
  steerP,
  new Promise((resolve) => setTimeout(() => resolve('hung'), 800)),
]);
const sendErr = await sendP;

check('interject 不再永久挂起', () => assert.match(outcome, /^rejected:/));
check('错误挂上了 runId', () => assert.ok(sendErr?.runId, `err.runId=${sendErr?.runId}`));
check('失败也写了哨兵', () => assert.ok(sentinels.length >= 1, `sentinels=${sentinels.length}`));
check('哨兵状态为 error', () => assert.equal(sentinels[0].status, 'error'));

console.log('\n[2] 审批没有 allow option 时 effective=cancelled');

const conv2 = new Conversation({
  id: 'failure-terminal-2',
  cwd: root,
  permission: 'workspace-write',
  onApproval: 'ask',
}, hub);
const pendingOutcome = conv2.onPermissionRequest({
  toolCall: { toolCallId: 'call-1', title: 'Run probe' },
  options: [{ optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }],
});
const approvalId = conv2.snapshot().pending_approvals[0];
const decided = conv2.decideApproval(approvalId, 'allow');

check('返回 effective=cancelled', () => assert.equal(decided.effective, 'cancelled'));
check('返回 reason=no_option', () => assert.equal(decided.reason, 'no_option'));
const received = await pendingOutcome;
check('ACP 实际收到 cancelled', () => assert.equal(received.outcome.outcome, 'cancelled'));

console.log('\n[3] dsh_get 在内存记录缺失时回读哨兵');

const dir = mkdtempSync(join(tmpdir(), 'dsh-any-agent-sentinel-'));
const runId = 'run-sentinel-test';
const file = join(dir, `${runId}.json`);
writeFileSync(file, JSON.stringify({
  conversation_id: 'failure-terminal-3',
  run_id: runId,
  status: 'done',
  ended_at: Date.now(),
  error: null,
  result: { answer: '来自哨兵', error: null },
}), 'utf8');

const stubConv = {
  id: 'failure-terminal-3',
  snapshot: () => ({
    conversation_id: 'failure-terminal-3',
    title: null,
    title_source: null,
    title_hint: null,
    cwd: root,
    busy: false,
    alive: false,
    permission: 'read-only',
    on_approval: 'auto-deny',
    turns: 1,
    pending_approvals: [],
  }),
  getRun: () => {
    throw new Error('未知 run_id');
  },
};
const handlers = createHandlers({
  get: async () => stubConv,
  runSentinelPath: () => file,
}, {});
const got = await handlers.dsh_get({
  conversation_id: 'failure-terminal-3',
  run_id: runId,
});

check('run.source=sentinel', () => assert.equal(got.structured.run.source, 'sentinel'));
check('回读到正文', () => assert.equal(got.structured.run.result.answer, '来自哨兵'));
check('返回 sentinel_file', () => assert.equal(got.structured.sentinel_file, file));

rmSync(dir, { recursive: true, force: true });

// 标准汇总行：test/run.mjs 与 scripts/sync-test-counts.mjs 靠它取检查数（别改格式）。
console.log(`\n===== failure terminal: passed ${passed}, failed ${failed} =====`);
console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
