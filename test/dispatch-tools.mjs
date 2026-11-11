/**
 * 派发面工具（离线，不拉起 DSH）。
 *
 * 覆盖：dsh_inbox 全局待决审批、client_run_id 幂等、会话级队列的增删改提升、
 * dsh_get 的正文预算。所有对象都是本地 Conversation，不调用模型。
 */

import './live-sandbox.mjs'; // 必须是第一条 import：live 事件别写进真实 ~/.dsh
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
// ★ 还没结束的 run（及其幂等键）不会被挤掉（审计 C04：长任务期间取消 20 条队列记录曾挤掉它）。
for (let i = 0; i < 20; i++) conv.createRun(`填充 ${i}`).status = 'cancelled';
check('★ 未结束的 run 被 20 条已结束记录包围时仍在，幂等键仍有效', () => assert.equal(conv.getRunByClientId('idem-1'), r1));
r1.status = 'done';
for (let i = 0; i < 20; i++) conv.createRun(`填充 ${i}`).status = 'done';
check('已结束的 run 被挤出后，幂等键同步失效', () => assert.equal(conv.getRunByClientId('idem-1'), null));
check('run 记录总数仍有上限', () => assert.ok(conv.runs.length <= 20, String(conv.runs.length)));

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
conv.queue.length = 0;

console.log('\n[3b] 派发竞态（假 ACP 进程，不拉 DSH）');

/** 假 ACP 进程：session/prompt 挂起，直到 end() 或 session/cancel。 */
function fakeProc() {
  const pending = [];
  const proc = {
    alive: true,
    prompts: 0,
    log: [],
    request(method) {
      proc.log.push(method);
      if (method !== 'session/prompt') return Promise.resolve({});
      proc.prompts += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
    notify(method) {
      proc.log.push(`notify:${method}`);
      if (method === 'session/cancel') for (const r of pending.splice(0)) r({ stopReason: 'cancelled' });
    },
    end() {
      for (const r of pending.splice(0)) r({ stopReason: 'end_turn' });
    },
  };
  return proc;
}
function raceConv(id, coldMs = 0) {
  const c = new Conversation({ id, cwd: auditDir, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  const proc = fakeProc();
  c.ensureAlive = async () => {
    c.proc = proc;
    if (coldMs) await new Promise((r) => setTimeout(r, coldMs));
    return proc;
  };
  return { c, proc };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
{
  // 审计 C02：冷启动（拉进程 + resume）期间 dsh_interrupt 成功，原任务就不能再发出去。
  const { c, proc } = raceConv('race-cold-interrupt', 200);
  const pending = c.prompt('任务', { wait: false });
  await tick();
  const ir = await c.interrupt();
  const res = await pending;
  await tick(300);
  check('★ 冷启动期间中断：报告 interrupted 且标明 before_dispatch', () => assert.deepEqual(ir, { interrupted: true, before_dispatch: true }));
  check('★ 冷启动期间中断：session/prompt 从未发出', () => assert.equal(proc.prompts, 0, JSON.stringify(proc.log)));
  check('冷启动期间中断：回合以 cancelled 收尾并写哨兵', () => {
    assert.equal(c.getRun(res.run_id).status, 'cancelled');
    assert.ok(sentinels.some((s) => s.run_id === res.run_id && s.status === 'cancelled'));
  });
  check('冷启动期间中断后会话空闲、可再派活', () => assert.equal(c.busy, false));
}
{
  // 审计 C04：两条并发 dsh_interject(mode='queue') 都必须执行，不能一条撞上“正在跑另一个回合”。
  const { c, proc } = raceConv('race-double-queue');
  await c.prompt('长任务', { wait: false });
  for (let i = 0; i < 300 && proc.prompts < 1; i++) await tick(10);
  const settle = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  const a = settle(c.interject('A', { mode: 'queue', clientRunId: 'race-qa' }));
  const b = settle(c.interject('B', { mode: 'queue', clientRunId: 'race-qb' }));
  await tick();
  // 每一轮都等 session/prompt 真的发出再结束它（前面还有 git 快照要跑）。
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i < 300 && proc.prompts < n; i++) await tick(10);
    proc.end();
  }
  const [ra, rb] = await Promise.all([a, b]);
  check('★ 两条排队插话都成功', () => assert.ok(ra.ok && rb.ok, `${ra.e?.message ?? ''} ${rb.e?.message ?? ''}`));
  check('★ 一共发出 3 次 session/prompt', () => assert.equal(proc.prompts, 3));
  check('两条插话的 run 都已完成', () =>
    assert.deepEqual([c.getRunByClientId('race-qa')?.status, c.getRunByClientId('race-qb')?.status], ['done', 'done']));
}
{
  // 审计 C04：长任务期间取消 20 条队列记录，原任务的 run 与 client_run_id 仍然有效。
  const { c, proc } = raceConv('race-evict');
  const first = await c.prompt('长任务', { wait: false, run: c.createRun('长任务', { clientRunId: 'race-long' }) });
  for (let i = 0; i < 300 && proc.prompts < 1; i++) await tick(10);
  for (let i = 0; i < 20; i++) c.queueRemove(c.enqueue(`q${i}`).run.run_id);
  check('★ 原任务的幂等键仍指向在跑的 run', () => assert.equal(c.getRunByClientId('race-long')?.run_id, first.run_id));
  proc.end();
  await tick();
}

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
  tools_used: [
    { id: 't1', title: 'edit', status: 'completed', input: { path: 'a.js', new_string: 'x'.repeat(50_000) } },
    { id: 't2', title: 'pwsh', status: 'completed', input: { command: 'npm test' } },
    { id: 't3', title: 'read', status: 'completed' },
  ],
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
check('★ structured 正文也按预算截断', () => assert.equal(got.structured.run.result.answer, '01234'));
check('★ structured 去掉工具输入，只留 input_chars', () => {
  const tools = got.structured.run.result.tools_used;
  assert.equal(tools.length, 3);
  assert.ok(tools.every((t) => !('input' in t)));
  assert.ok(tools[0].input_chars > 50_000);
  assert.equal(tools[0].title, 'edit');
  assert.ok(!('input_chars' in tools[2]), '本来没有 input 的工具不凭空加字段');
});
check('★ 压缩后整个 structured 远小于工具输入体积', () =>
  assert.ok(JSON.stringify(got.structured).length < 10_000, String(JSON.stringify(got.structured).length)));
check('structured 标记 result_compacted', () => assert.equal(got.structured.run.result_compacted, true));
check('压缩不改动内存里的原始结果', () => {
  assert.equal(long.result.answer, '0123456789');
  assert.equal(long.result.tools_used[0].input.path, 'a.js');
});
const gotFull = await handlers.dsh_get({ conversation_id: conv.id, run_id: long.run_id });
check('max_chars=0 时仍返回完整结果（向后兼容）', () => {
  assert.equal(gotFull.structured.run.result.answer, '0123456789');
  assert.equal(gotFull.structured.run.result.tools_used[0].input.path, 'a.js');
  assert.ok(!('result_compacted' in gotFull.structured.run));
});

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
// 本机/CI 都可能没有 DSH：dsh_bin 失败时不会产出 dsh_version，这是预期。
if (doc.structured.checks.find((c) => c.id === 'dsh_bin')?.status !== 'fail') {
  check('找到 DSH 时附带 dsh_version 检查', () => assert.ok(ids.includes('dsh_version')));
}

console.log('\n[6b] DSH 版本档位与 npx 缓存识别');
{
  const { dshVersionStatus, isNpxCachePath } = await import('../src/config.mjs');
  const lvl = (v) => dshVersionStatus(v).level;
  check('null → unknown/warn', () => assert.equal(dshVersionStatus(null).status, 'warn'));
  check('0.1.4 → unsupported', () => assert.equal(lvl('0.1.4'), 'unsupported'));
  check('0.1.5-rc.1 → partial', () => assert.equal(lvl('0.1.5-rc.1'), 'partial'));
  check('0.1.7-rc.1 → verified/ok', () => {
    assert.equal(lvl('0.1.7-rc.1'), 'verified');
    assert.equal(dshVersionStatus('0.1.7-rc.1').status, 'ok');
  });
  check('0.1.9 → verified', () => assert.equal(lvl('0.1.9'), 'verified'));
  check('★ 0.2.1-rc.5 / 0.2.2-rc.1（全量实测过）→ verified/ok', () => {
    assert.equal(lvl('0.2.1-rc.5'), 'verified');
    assert.equal(lvl('0.2.2-rc.1'), 'verified');
    assert.equal(dshVersionStatus('0.2.2-rc.1').status, 'ok');
  });
  check('★ 只有本发布线重跑过的版本（0.2.1）才说"跑过全量套件"', () => {
    const s = dshVersionStatus('0.2.1-rc.5');
    assert.equal(s.rerun, true);
    assert.match(s.note, /已用 0\.6\.x 跑过全量套件/);
    assert.match(s.noteEn, /passed the full suite on 0\.6\.x/);
  });
  check('★ 区间内但本发布线没重跑的版本（0.1.7 / 0.2.2）如实说明，仍是 ok', () => {
    for (const v of ['0.1.7-rc.1', '0.2.2-rc.1']) {
      const s = dshVersionStatus(v);
      assert.equal(s.status, 'ok');
      assert.equal(s.rerun, false);
      assert.match(s.note, /最近一次全量实测是 0\.5\.x/);
      assert.match(s.noteEn, /last full run was on 0\.5\.x/);
    }
  });
  check('每个档位都带英文说明', () => {
    for (const v of [null, '0.1.4', '0.1.5-rc.1', '0.2.1-rc.5', '0.3.0']) {
      assert.ok(dshVersionStatus(v).noteEn, String(v));
    }
  });
  check('★ 0.2.3-rc.1 → unverified/warn（rc 也算进 0.2.3）', () => {
    assert.equal(lvl('0.2.3-rc.1'), 'unverified');
    assert.equal(dshVersionStatus('0.2.3-rc.1').status, 'warn');
  });
  check('0.3.0 → unverified', () => assert.equal(lvl('0.3.0'), 'unverified'));
  check('unverified 的说明里写明已验证区间（不再写死“只覆盖到 0.1.x”）', () =>
    assert.match(dshVersionStatus('0.3.0').note, /0\.1\.7 ~ 0\.2\.2/));
  check('Windows npx 缓存路径被识别', () =>
    assert.ok(isNpxCachePath('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')));
  check('POSIX npx 缓存路径被识别', () =>
    assert.ok(isNpxCachePath('/home/a/.npm/_npx/abc/node_modules/@deepseek-ai/dsh/lib/bin.js')));
  check('全局安装路径不算 npx 缓存', () =>
    assert.ok(!isNpxCachePath('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')));
  check('名字里含 _npx 但不是目录段时不误判', () =>
    assert.ok(!isNpxCachePath('/opt/my_npx_tools/dsh/lib/bin.js')));
}

console.log('\n[6c] PowerShell 哨兵等待命令');
{
  const { psWaitCommand, psReadCommand } = await import('../src/tools.mjs');
  const cmd = psWaitCommand("C:\\Users\\o'neil\\runs\\a $b `c.json", 30);
  check('单引号转义成两个单引号', () => assert.match(cmd, /o''neil/));
  check('路径放在单引号字面量里（$ 与反引号不展开）', () =>
    assert.match(cmd, /^\$f='C:\\Users\\o''neil\\runs\\a \$b `c\.json';/));
  check('用 -LiteralPath，不按通配符解释路径', () => assert.match(cmd, /Test-Path -LiteralPath \$f/));
  check('超时秒数写进命令', () => assert.match(cmd, /AddSeconds\(30\)/));
  {
    // 默认等待上限跟着回合总时长上限走：上限 + 5 分钟（看门狗到点取消回合也会写哨兵，哨兵一定先到）。
    const { SENTINEL_WAIT_SEC } = await import('../src/tool-render.mjs');
    const { TURN_MAX_MS, PKG_ROOT } = await import('../src/config.mjs');
    check('★ 默认等待上限 = 回合总时长上限 + 300 秒', () => {
      assert.equal(SENTINEL_WAIT_SEC, Math.ceil(TURN_MAX_MS / 1000) + 300);
      assert.match(psWaitCommand('x.json'), new RegExp(`AddSeconds\\(${SENTINEL_WAIT_SEC}\\)`));
    });
    const { spawnSync } = await import('node:child_process');
    const probe = (max) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/tool-render.mjs').then((m) => console.log(m.SENTINEL_WAIT_SEC))"], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DSH_MCP_TURN_MAX_MS: max },
      }).stdout.trim();
    check('上限设成 1 小时 → 3900 秒；关掉（0）→ 35 分钟兜底', () => {
      assert.equal(probe('3600000'), '3900');
      assert.equal(probe('0'), '2100');
    });
  }

  // 真跑一遍：只在 Windows 且有 powershell.exe 时执行（CI 的 windows-latest 会覆盖到）。
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), "dsh-any-agent-ps'wait-"));
    try {
      mkdirSync(join(dir, 'a $b [c]'), { recursive: true });
      const present = join(dir, 'a $b [c]', 'run-1.json');
      writeFileSync(present, '{}');
      const ps = (c) =>
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8', timeout: 30_000 });
      const ok = ps(psWaitCommand(present, 5));
      check('★ 文件已存在（路径含单引号/$/方括号）→ DONE、退出 0', () => {
        assert.equal(ok.status, 0, ok.stderr);
        assert.match(ok.stdout, /DONE/);
      });
      const missing = ps(psWaitCommand(join(dir, 'never.json'), 1));
      check('★ 文件一直不出现 → TIMEOUT、退出 1', () => {
        assert.equal(missing.status, 1, missing.stderr);
        assert.match(missing.stdout, /TIMEOUT/);
      });
      // ★ 读取命令：哨兵是无 BOM 的 UTF-8，PS 5.1 不带 -Encoding UTF8 会把中文读坏、JSON 解析失败。
      const zh = join(dir, 'a $b [c]', 'run-zh.json');
      writeFileSync(zh, JSON.stringify({ status: 'done', result: { answer: '三项冒烟测试全部通过' } }));
      const rd = ps(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; (${psReadCommand(zh)}).result.answer`);
      check('★ 读取命令能正确解析含中文的哨兵（路径含单引号/$/方括号）', () => {
        assert.equal(rd.status, 0, rd.stderr);
        assert.equal(rd.stdout.trim(), '三项冒烟测试全部通过');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log('  skipped: 非 Windows，不执行 PowerShell');
  }
  check('读取命令带 -Encoding UTF8 且用 -LiteralPath', () => {
    const c = psReadCommand("C:\\x\\o'neil.json");
    assert.match(c, /-Encoding UTF8/);
    assert.match(c, /-LiteralPath 'C:\\x\\o''neil\.json'/);
  });
}

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

// 标准汇总行：test/run.mjs 与 scripts/sync-test-counts.mjs 靠它取检查数（别改格式）。
console.log(`\n===== dispatch tools: passed ${passed}, failed ${failed} =====`);
console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
