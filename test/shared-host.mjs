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

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionHost } from '../src/host.mjs';
import { Hub } from '../src/hub.mjs';
import { SHARED_PROCESS } from '../src/config.mjs';
import { rssMb, readRssMap } from '../src/procstat.mjs';

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
check('能读到本进程的 RSS', () => assert.ok(rssMb(process.pid) > 0, String(rssMb(process.pid))));
check('读不到返回 null（不是 0）', () => assert.equal(rssMb(99999999), null));
check('RSS 表是 Map', () => assert.ok(readRssMap() instanceof Map));

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

console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
