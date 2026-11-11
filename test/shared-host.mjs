/**
 * 共享 ACP 进程宿主（0.4.0 引入，0.5.0 起默认开启；离线）。
 *
 * 不需要 DSH：用一个假的 AcpProcess 验证五件事——
 *   1. 通知/审批按 sessionId 路由到正确的会话；
 *   2. 进程退出时，所有挂载会话都收到 onProcessExit；
 *   3. 最后一个会话 detach 才停进程，中途 detach 只发 session/close；
 *   4. 默认开启，且 `DSH_MCP_SHARED_PROCESS=0` 能关掉（空串仍按默认处理）；
 *   5. `takeover` 杀共享进程前的连坐检查（hostVictimsOf）。
 */

import './live-sandbox.mjs'; // 必须是第一条 import：live 事件别写进真实 ~/.dsh
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionHost } from '../src/host.mjs';
import { Hub } from '../src/hub.mjs';
import { SHARED_PROCESS } from '../src/config.mjs';
import { rssMb, refreshRssMap } from '../src/procstat.mjs';

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

class FakeAcp {
  constructor(opts) {
    this.opts = opts;
    this.alive = true;
    this.pid = 4242;
    this.requests = [];
    this.stopped = false;
  }
  start() {
    return this;
  }
  async initialize() {}
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve({});
  }
  notify() {
    return true;
  }
  async stop() {
    this.alive = false;
    this.stopped = true;
    return true;
  }
}

function fakeConv(id) {
  return {
    id,
    updates: [],
    approvals: [],
    exits: [],
    onUpdate(params) {
      this.updates.push(params);
    },
    onPermissionRequest(params) {
      this.approvals.push(params);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
    onProcessExit(reason) {
      this.exits.push(reason);
    },
  };
}

const log = { info() {}, debug() {}, dshStderr() {} };
const host = new SessionHost({
  cwd: process.cwd(),
  permission: 'read-only',
  log,
  hub: null,
  AcpProcessClass: FakeAcp,
});

const a = fakeConv('session-a');
const b = fakeConv('session-b');
host.attach(a);
host.attach(b);
await host.initialize();
const proc = host.proc;

console.log('\n[1] 通知与审批按 sessionId 路由');

proc.opts.onNotification({ sessionId: 'session-a', update: { kind: 'text' } });
check('session-a 收到自己的通知', () => assert.equal(a.updates.length, 1));
check('session-b 没收到别人的通知', () => assert.equal(b.updates.length, 0));

const decision = proc.opts.onPermissionRequest({ sessionId: 'session-b', toolCall: {} });
check('session-b 收到审批请求', () => assert.equal(b.approvals.length, 1));
check('审批结果原样返回', () => assert.equal(decision.outcome.optionId, 'allow'));

const unknown = proc.opts.onPermissionRequest({ sessionId: 'session-x' });
check('未知会话的审批一律取消', () => assert.equal(unknown.outcome.outcome, 'cancelled'));

console.log('\n[2] 进程退出通知所有挂载会话');

proc.opts.onExit('boom');
check('session-a 收到退出', () => assert.deepEqual(a.exits, ['boom']));
check('session-b 收到退出', () => assert.deepEqual(b.exits, ['boom']));
check('host 清空会话', () => assert.equal(host.size, 0));
check('host 解除进程引用', () => assert.equal(host.proc, null));

console.log('\n[3] 最后一个会话离开才停进程');

const host2 = new SessionHost({
  cwd: process.cwd(),
  permission: 'read-only',
  log,
  hub: null,
  AcpProcessClass: FakeAcp,
});
const c = fakeConv('session-c');
const d = fakeConv('session-d');
host2.attach(c);
host2.attach(d);
await host2.initialize();
const proc2 = host2.proc;

await host2.detach(c);
check('中途 detach 发了 session/close', () =>
  assert.ok(proc2.requests.some((r) => r.method === 'session/close' && r.params.sessionId === 'session-c')));
check('中途 detach 不停进程', () => assert.equal(proc2.stopped, false));
check('中途 detach 后 host 还活着', () => assert.equal(host2.size, 1));

await host2.detach(d);
check('最后一个 detach 后停进程', () => assert.equal(proc2.stopped, true));
check('停进程后 host 为空', () => assert.equal(host2.size, 0));

console.log('\n[4] 子进程 RSS 读取');
check('★ 缓存还没填时 rssMb 立刻返回 null，不等进程表', () => {
  const t0 = performance.now();
  assert.equal(rssMb(process.pid), null);
  // 同步的 tasklist / ps 至少要几十毫秒（Windows 上约 600ms）；只读缓存远低于这个数。
  assert.ok(performance.now() - t0 < 20, `${performance.now() - t0}ms`);
});
{
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const t0 = performance.now();
  const [m1, m2] = await Promise.all([refreshRssMap({ force: true }), refreshRssMap({ force: true })]);
  const elapsed = performance.now() - t0;
  clearInterval(timer);
  check('RSS 表是 Map', () => assert.ok(m1 instanceof Map));
  check('并发刷新共用同一次读取', () => assert.equal(m1, m2));
  // 读得太快（<25ms）时不强求定时器已经触发过。
  check('★ 刷新进程表期间事件循环照常转', () => assert.ok(elapsed < 25 || ticks > 0, `elapsed=${elapsed}ms ticks=${ticks}`));
}
check('刷新后能读到本进程的 RSS', () => assert.ok(rssMb(process.pid) > 0, String(rssMb(process.pid))));
check('读不到返回 null（不是 0）', () => assert.equal(rssMb(99999999), null));

console.log('\n[5] 共享进程默认开启（0.5.0）');

check('本进程（未设环境变量）默认开启', () => assert.equal(SHARED_PROCESS, true));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfgUrl = pathToFileURL(join(root, 'src', 'config.mjs')).href;
/** 在子进程里读一次 config（模块加载期读环境变量，同进程改 env 不生效）。 */
const sharedWith = (value) =>
  execFileSync(
    process.execPath,
    [
      '-e',
      `import(${JSON.stringify(cfgUrl)}).then((m) => process.stdout.write(String(m.SHARED_PROCESS)))`,
    ],
    { cwd: root, env: { ...process.env, DSH_MCP_SHARED_PROCESS: value }, encoding: 'utf8' },
  ).trim();

check('DSH_MCP_SHARED_PROCESS=0 可以关掉', () => assert.equal(sharedWith('0'), 'false'));
check('DSH_MCP_SHARED_PROCESS=1 显式开启', () => assert.equal(sharedWith('1'), 'true'));
check('空串按"未设置"处理（仍默认开）', () => assert.equal(sharedWith(''), 'true'));

console.log('\n[6] 抢占前检查共享进程连坐');

const bus = new Hub({ log });
bus.hosts.set('a', {
  pid: 4242,
  conversations: new Map([
    ['session-a', {}],
    ['session-b', {}],
  ]),
});

check('列出同 PID 上的其它会话', () =>
  assert.deepEqual(bus.hostVictimsOf(4242, 'session-a'), ['session-b']));
check('换一个会话视角同样列得出', () =>
  assert.deepEqual(bus.hostVictimsOf(4242, 'session-b'), ['session-a']));
check('查不到该 PID 时返回空', () => assert.deepEqual(bus.hostVictimsOf(9999, 'session-a'), []));
check('PID 为空时返回空', () => assert.deepEqual(bus.hostVictimsOf(null, 'session-a'), []));

console.log('\n[7] ★ 并发握手：第二个调用者必须等到 initialize 回包（审计 B05）');
{
  let nextPid = 5000;
  class SlowInitAcp extends FakeAcp {
    constructor(opts) {
      super(opts);
      this.pid = nextPid++;
      this.initialized = false;
    }
    async initialize() {
      await new Promise((r) => setTimeout(r, 80));
      this.initialized = true;
    }
  }
  const h = new SessionHost({ cwd: process.cwd(), permission: 'read-only', log, hub: null, AcpProcessClass: SlowInitAcp });
  const first = h.initialize();
  await h.initialize(); // 并发的第二个调用者
  check('★ 第二个调用者返回时握手已完成', () => assert.equal(h.proc.initialized, true));
  await first;
  const pid = h.proc.pid;
  await h.initialize();
  check('握手完成后再调用不会换进程', () => assert.equal(h.proc.pid, pid));

  console.log('\n[8] ★ session/close 被拒绝时不能报告释放成功（审计 B05）');
  class CloseRejectAcp extends FakeAcp {
    request(method, params) {
      this.requests.push({ method, params });
      return method === 'session/close' ? Promise.reject(new Error('[-32603] Internal error')) : Promise.resolve({});
    }
  }
  const h2 = new SessionHost({ cwd: process.cwd(), permission: 'read-only', log, hub: null, AcpProcessClass: CloseRejectAcp });
  const x = fakeConv('session-x1');
  const y = fakeConv('session-y1');
  h2.attach(x);
  h2.attach(y);
  await h2.initialize();
  const released = await h2.detach(x);
  check('★ 仍有别的会话时，close 被拒 → detach 返回 false', () => assert.equal(released, false));
  check('进程没有被停掉（还载着别的会话）', () => assert.equal(h2.proc.stopped, false));
  const last = await h2.detach(y);
  check('最后一个会话离开时停进程，锁随进程释放 → true', () => assert.equal(last, true));

  console.log('\n[9] ★ 旧进程慢慢停完，不能把同一宿主上新拉起的进程挤出进程池（审计 C05）');
  class SlowStopAcp extends FakeAcp {
    constructor(opts) {
      super(opts);
      this.pid = nextPid++;
    }
    async stop() {
      await new Promise((r) => setTimeout(r, 80));
      return super.stop();
    }
  }
  const pool = new Hub({ log });
  const h3 = new SessionHost({ cwd: process.cwd(), permission: 'read-only', log, hub: pool, AcpProcessClass: SlowStopAcp });
  pool.hosts.set('k', h3);
  const old = fakeConv('session-old');
  h3.attach(old);
  await h3.initialize();
  const stopping = h3.detach(old); // 最后一个会话离开 → 开始停旧进程（很慢）
  await new Promise((r) => setTimeout(r, 10)); // 让 detach 走过 session/close，真正进入 stop
  check('旧进程已进入停止流程', () => assert.ok(h3.stopping && h3.proc === null));
  const n1 = fakeConv('session-n1');
  const n2 = fakeConv('session-n2');
  h3.attach(n1);
  h3.attach(n2);
  await h3.initialize(); // 同一宿主上拉起新进程
  const newPid = h3.pid;
  await stopping;
  check('★ 旧进程停完后宿主仍在进程池里', () => assert.equal(pool.hosts.get('k'), h3));
  check('★ 抢占检查仍能查到新进程上的其它会话', () => assert.deepEqual(pool.hostVictimsOf(newPid, 'session-n1'), ['session-n2']));
  check('新进程还活着', () => assert.equal(h3.alive, true));
}

// 标准汇总行：test/run.mjs 与 scripts/sync-test-counts.mjs 靠它取检查数（别改格式）。
console.log(`\n===== shared host: passed ${passed}, failed ${failed} =====`);
console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
