/**
 * 派发面工具（离线，不拉起 DSH）。
 *
 * 覆盖：dsh_inbox 全局待决审批、client_run_id 幂等、会话级队列的增删改提升、
 * dsh_get 的正文预算。所有对象都是本地 Conversation，不调用模型。
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const auditDir = mkdtempSync(join(tmpdir(), 'dsh-any-agent-audit-'));
process.env.DSH_MCP_AUDIT_FILE = join(auditDir, 'audit.jsonl');
// 这一套要覆盖"团队提示注入"，所以在本进程显式启用团队模式；
// config 在动态 import 时读取 env（静态 import 会被提升到赋值之前）。
process.env.DSH_MCP_TEAM = '1';
const { Conversation, Hub } = await import('../src/hub.mjs');
const { createHandlers } = await import('../src/tools.mjs');
const { TEAM_ACTIVE } = await import('../src/config.mjs');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const log = { info() {}, debug() {}, dshStderr() {} };
const sentinels = [];
const hub = {
  log,
  approvalTimeoutMs: 300_000,
  conversations: new Map(),
  save() {},
  clearRunSentinel() {},
  writeRunSentinel(id, run) {
    sentinels.push({ id, run_id: run.run_id, status: run.status });
    return `/tmp/${run.run_id}.json`;
  },
  runSentinelPath(id, runId) {
    return `/tmp/${runId}.json`;
  },
  async get(id) {
    return this.conversations.get(id);
  },
};

const conv = new Conversation({
  id: 'dispatch-tools-1',
  cwd: process.cwd(),
  permission: 'workspace-write',
  onApproval: 'ask',
}, hub);
hub.conversations.set(conv.id, conv);
const handlers = createHandlers(hub, {});

console.log('\n[1] dsh_inbox 跨会话汇总待决审批');

const options = [
  { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
];
const pa = conv.onPermissionRequest({
  toolCall: { toolCallId: 'call-a', title: 'Run probe A' },
  options,
});
const pb = conv.onPermissionRequest({
  toolCall: { toolCallId: 'call-b', title: 'Run probe B' },
  options,
});

const inbox = await handlers.dsh_inbox({});
check('汇总到 2 个待决审批', () => assert.equal(inbox.structured.count, 2));
check('每一项都带 conversation_id', () =>
  assert.ok(inbox.structured.approvals.every((x) => x.conversation_id === conv.id)));
check('每一项都带 approval_id', () =>
  assert.ok(inbox.structured.approvals.every((x) => typeof x.approval_id === 'string')));
check('文本里给出裁决入口', () => assert.match(inbox.text, /dsh_approval_decide/));

for (const id of conv.snapshot().pending_approvals) {
  await handlers.dsh_approval_decide({
    conversation_id: conv.id,
    approval_id: id,
    decision: 'deny',
  });
}
await Promise.all([pa, pb]);
check('裁决后收件箱清空', () => assert.equal(conv.snapshot().pending_approvals.length, 0));
const empty = await handlers.dsh_inbox({});
check('没有待决审批时返回空列表', () => assert.equal(empty.structured.count, 0));

console.log('\n[2] client_run_id 幂等');

const r1 = conv.createRun('任务一', { clientRunId: 'idem-1' });
check('按键能取回同一个 run', () => assert.equal(conv.getRunByClientId('idem-1'), r1));
for (let i = 0; i < 20; i++) conv.createRun(`填充 ${i}`);
check('run 记录被挤出后，幂等键同步失效', () => assert.equal(conv.getRunByClientId('idem-1'), null));

console.log('\n[3] 会话级队列');

conv.busy = true; // 阻止自动 drain
const q1 = conv.enqueue('排队一', { clientRunId: 'q-1' });
const q2 = conv.enqueue('排队二');
check('第一条位置 = 1', () => assert.equal(q1.position, 1));
check('第二条位置 = 2', () => assert.equal(q2.position, 2));
check('队列列出两条', () => assert.equal(conv.queueList().length, 2));

conv.queueUpdate(q1.run.run_id, '排队一（改）');
check('update 改写了预览', () => assert.equal(conv.queueList()[0].preview, '排队一（改）'));

conv.queuePromote(q2.run.run_id);
check('promote 提到队首', () => assert.equal(conv.queueList()[0].run_id, q2.run.run_id));

const before = sentinels.length;
await handlers.dsh_queue({ conversation_id: conv.id, action: 'remove', run_id: q1.run.run_id });
check('remove 后 run 标记为 cancelled', () => assert.equal(q1.run.status, 'cancelled'));
check('remove 写了 cancelled 哨兵', () => assert.equal(sentinels.length, before + 1));
check('remove 后队列只剩一条', () => assert.equal(conv.queueList().length, 1));

conv.busy = false;
conv.queue = [];

console.log('\n[4] dsh_get 正文预算');

const long = conv.createRun('长输出');
long.status = 'done';
long.ended_at = Date.now();
long.elapsed_ms = 10;
long.result = {
  conversation_id: conv.id,
  run_id: long.run_id,
  stop_reason: 'end_turn',
  error: null,
  answer: '0123456789',
  thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
  tools_used: [],
  workspace_changed: false,
  elapsed_ms: 10,
};
const got = await handlers.dsh_get({
  conversation_id: conv.id,
  run_id: long.run_id,
  max_chars: 5,
});
check('text 只显示前 5 个字符', () => assert.match(got.text, /01234/));
check('text 不显示后半段', () => assert.ok(!got.text.includes('56789')));
check('structured 标记已截断', () => assert.equal(got.structured.run.answer_truncated, true));
check('structured 给出 next_offset', () => assert.equal(got.structured.run.next_offset, 5));
check('structured 保留完整正文', () => assert.equal(got.structured.run.result.answer, '0123456789'));

console.log('\n[5] 审计日志（只记元数据）');

const auditRaw = readFileSync(process.env.DSH_MCP_AUDIT_FILE, 'utf8');
check('记录了 approval_decide', () => assert.match(auditRaw, /"event":"approval_decide"/));
check('记录了 queue_remove', () => assert.match(auditRaw, /"event":"queue_remove"/));
check('不记录工具标题/命令/正文', () => assert.ok(!auditRaw.includes('Run probe A')));

console.log('\n[6] dsh_doctor');

const doc = await handlers.dsh_doctor();
const ids = doc.structured.checks.map((c) => c.id);
check('返回 checks 数组', () => assert.ok(Array.isArray(doc.structured.checks)));
check('包含关键检查项', () => {
  for (const id of ['dsh_bin', 'profile', 'state', 'runs_dir', 'locks_dir', 'sessions', 'config']) {
    assert.ok(ids.includes(id), `缺少 ${id}`);
  }
});
check('verdict 是 ok 或 fail', () => assert.ok(['ok', 'fail'].includes(doc.structured.verdict)));
check('text 逐项列出结果', () => assert.match(doc.text, /dsh_bin/));

console.log('\n[7] 团队提示注入');

if (TEAM_ACTIVE) {
  const captured = [];
  const fakeConv = {
    id: 'fake-team',
    busy: false,
    lastResult: null,
    createRun: (t) => ({ run_id: 'run-fake', prompt_preview: t }),
    prompt: async (t) => {
      captured.push(t);
      return { still_running: true, run_id: 'run-fake' };
    },
  };
  const fakeHub = {
    get: async () => fakeConv,
    runSentinelPath: () => '/tmp/run-fake.json',
    conversations: new Map(),
  };
  const h2 = createHandlers(fakeHub, {});
  await h2.dsh_send({ conversation_id: 'fake-team', prompt: 'do it' });
  check('默认在 prompt 前注入团队提示', () => assert.match(captured[0], /^【团队】/));
  check('注入不吞掉原任务', () => assert.match(captured[0], /do it$/));
  await h2.dsh_send({ conversation_id: 'fake-team', prompt: 'do it', team: false });
  check('team=false 不注入', () => assert.equal(captured[1], 'do it'));
} else {
  console.log('  skipped: 当前 DSH 版本不启用团队模式');
}

console.log('\n[8] danger-full-access 需要机器侧显式放行');

if (!process.env.DSH_MCP_ALLOW_FULL_ACCESS) {
  const guardHub = new Hub({ log });
  let guardErr = null;
  try {
    await guardHub.create({ cwd: process.cwd(), permission: 'danger-full-access' });
  } catch (e) {
    guardErr = e;
  }
  check('默认拒绝 danger-full-access', () =>
    assert.match(String(guardErr?.message), /DSH_MCP_ALLOW_FULL_ACCESS/));
} else {
  console.log('  skipped: 当前进程已放行 danger-full-access');
}

rmSync(auditDir, { recursive: true, force: true });

console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
