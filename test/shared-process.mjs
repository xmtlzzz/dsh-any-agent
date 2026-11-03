/**
 * 共享 ACP 进程池的真机验证（需要本机 DSH；没有就明确 skip）。
 *
 * 验证：同 (cwd, permission) 的两个会话落在**同一个** DSH 进程上；
 * 关掉一个不影响另一个；最后一个关掉后进程退出。
 *
 * 环境变量必须在 import 之前设置 —— config.mjs 在模块加载期读它们。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const base = mkdtempSync(join(tmpdir(), 'dsh-any-agent-shared-test-'));
process.env.DSH_MCP_SHARED_PROCESS = '1';
process.env.DSH_MCP_STATE = join(base, 'state.json');
process.env.DSH_MCP_RUNS_DIR = join(base, 'runs');
process.env.DSH_MCP_LOCKS_DIR = join(base, 'locks');
process.env.DSH_MCP_LOG = 'silent';

const { resolveDshBin } = await import('../src/config.mjs');
let hasDsh = false;
try {
  hasDsh = Boolean(resolveDshBin());
} catch {
  hasDsh = false;
}
if (!hasDsh) {
  console.log('  skipped: 本机没有可用的 DSH');
  process.exit(0);
}

const { Hub } = await import('../src/hub.mjs');
const { readRssMap } = await import('../src/procstat.mjs');

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

const cwd = mkdtempSync(join(tmpdir(), 'dsh-any-agent-shared-ws-'));
const log = { info() {}, debug() {}, dshStderr() {} };
const hub = new Hub({ log });

console.log('\n[1] 同 cwd + 同权限的 4 个会话共享一个 DSH 进程');
const mk = () => hub.create({ cwd, permission: 'read-only', onApproval: 'auto-deny' });
const a = await mk();
const b = await mk();
const c = await mk();
const d = await mk();

check('四个会话指向同一个宿主对象', () => {
  assert.equal(a.proc, b.proc);
  assert.equal(b.proc, c.proc);
  assert.equal(c.proc, d.proc);
});
check('四个会话的 PID 相同', () => {
  assert.equal(a.proc.pid, b.proc.pid);
  assert.equal(b.proc.pid, c.proc.pid);
  assert.equal(c.proc.pid, d.proc.pid);
});
check('宿主上挂了四个会话', () => assert.equal(a.proc.size, 4));
check('注册表里只有一个宿主', () => assert.equal(hub.hosts.size, 1));

console.log('\n[2] 并发关闭一半不影响另一半，最后一个关掉才停进程');
const pid = a.proc.pid;
await Promise.all([a.close(), b.close()]);
check('并发关闭 a/b 后 c/d 仍活着', () => {
  assert.equal(c.proc?.alive, true);
  assert.equal(d.proc?.alive, true);
});
check('宿主上只剩两个会话', () => assert.equal(c.proc?.size, 2));
await Promise.all([c.close(), d.close()]);
check('全部关闭后宿主被清掉', () => assert.equal(hub.hosts.size, 0));
// 给进程一点退出时间，再确认 PID 从进程表里消失。
await new Promise((r) => setTimeout(r, 500));
check('PID 已退出（RSS 读不到）', () => assert.equal(readRssMap({ force: true }).has(pid), false));

console.log(`\n总结果: ${failed === 0 ? '通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
