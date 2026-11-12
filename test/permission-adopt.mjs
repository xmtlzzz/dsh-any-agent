/**
 * 接管会话 / 运行期权限核对的安全边界（纯内存 + 文件系统，不拉 DSH）。
 *
 * 守两件事：
 *   [1] 外部会话没有权限记录时，绝不能落到 danger-full-access（fail-closed 到 read-only）
 *   [2] 会话自己记录的 read-only 不能被侧车"提升"为可写档
 *   [3] 建会话/resume 后的回读核对：记录与请求不一致必须失败，读不到则不阻断
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-permission-adopt-'));
const home = join(root, 'dsh-home');
process.env.DSH_HOME = home;
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_MCP_FORGOTTEN_DIR = join(home, 'forgotten');
// 本套件不该拉起任何 DSH；万一守卫失效，拉起的也只是一个不存在的路径。
process.env.DSH_BIN = join(root, 'no-such-dsh.js');
process.env.DSH_MCP_BOOTSTRAP = '0';
delete process.env.DSH_MCP_ALLOW_FULL_ACCESS;
delete process.env.DSH_MCP_APPROVAL;

const { Hub, Conversation } = await import('../src/hub.mjs');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

function seedSession(id, cwd) {
  const dir = join(home, 'sessions', 'bk', id);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', id, cwd, createdAt: Date.now() }) + '\n';
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(header, 'utf8')));
}

function seedProj(id, preset) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ record: { rows: { permissions: { val: { preset, sandbox: preset } } } } }), 'utf8');
}

function seedMeta(id, permission) {
  const file = join(dirname(process.env.DSH_MCP_STATE), 'meta', `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, id, cwd: join(root, 'ws'), permission }), 'utf8');
}

try {
  console.log('\n[1] 外部会话没有任何权限记录 → fail-closed');
  seedSession('session-no-record', join(root, 'ws'));
  const hub = new Hub({ log: { info() {}, debug() {} } });
  const c1 = await hub.get('session-no-record');
  check('★ 权限档回落 read-only', c1.permission === 'read-only', c1.permission);
  check('审批策略随之 auto-deny', c1.onApproval === 'auto-deny', c1.onApproval);

  console.log('\n[2] 会话自己记录 workspace-write → 尊重记录');
  seedSession('session-write-record', join(root, 'ws'));
  seedProj('session-write-record', 'workspace-write');
  const c2 = await hub.get('session-write-record');
  check('权限档 = workspace-write', c2.permission === 'workspace-write', c2.permission);
  check('workspace-write 默认拒绝越界审批', c2.onApproval === 'auto-deny', c2.onApproval);
  for (const [ceiling, requested] of [['auto-deny', 'ask'], ['auto-deny', 'auto-allow'], ['ask', 'auto-allow']]) {
    process.env.DSH_MCP_APPROVAL = ceiling;
    const error = await hub.create({ cwd: root, permission: 'workspace-write', onApproval: requested }).catch((e) => e);
    check(`机器侧 ${ceiling} 拒绝调用方请求 ${requested}`, /审批上限|approval ceiling/.test(error?.message));
  }
  const clamped = new Conversation({ id: 'old-approval-policy', cwd: root, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  check('已保存的宽松审批策略服从当前机器上限', clamped.onApproval === 'ask');
  delete process.env.DSH_MCP_APPROVAL;

  console.log('\n[3] 记录 read-only 不能被侧车提升');
  seedSession('session-readonly', join(root, 'ws'));
  seedProj('session-readonly', 'read-only');
  seedMeta('session-readonly', 'danger-full-access');
  const c3 = await hub.get('session-readonly');
  check('★ 仍为 read-only', c3.permission === 'read-only', c3.permission);
  check('审批策略仍 auto-deny', c3.onApproval === 'auto-deny', c3.onApproval);

  console.log('\n[4] 没有投影缓存时，本服务侧车是可信来源');
  seedSession('session-meta-only', join(root, 'ws'));
  seedMeta('session-meta-only', 'workspace-write');
  const c4 = await hub.get('session-meta-only');
  check('权限档取侧车的 workspace-write', c4.permission === 'workspace-write', c4.permission);

  console.log('\n[5] 运行期回读核对');
  const c5 = new Conversation({ id: 'session-verify', cwd: join(root, 'ws'), permission: 'read-only', onApproval: 'auto-deny' }, hub);
  seedProj('session-verify', 'read-only');
  const got5 = await c5.verifyPermissionRecorded({ attempts: 1, delayMs: 0 });
  check('记录一致时返回 read-only', got5 === 'read-only', String(got5));
  check('permissionVerified = true', c5.permissionVerified === true, String(c5.permissionVerified));

  const c6 = new Conversation({ id: 'session-mismatch', cwd: join(root, 'ws'), permission: 'read-only', onApproval: 'auto-deny' }, hub);
  seedProj('session-mismatch', 'danger-full-access');
  let mismatch = null;
  try { await c6.verifyPermissionRecorded({ attempts: 1, delayMs: 0 }); } catch (e) { mismatch = e; }
  check('★ 记录不一致时抛错', Boolean(mismatch), 'no error');
  check('错误信息点明 defaultPreset', /defaultPreset/.test(String(mismatch?.message)), String(mismatch?.message));

  const c7 = new Conversation({ id: 'session-no-proj', cwd: join(root, 'ws'), permission: 'read-only', onApproval: 'auto-deny' }, hub);
  let requiredErr = null;
  try { await c7.verifyPermissionRecorded({ attempts: 1, delayMs: 0 }); } catch (e) { requiredErr = e; }
  check('★ read-only 读不到权限记录时 fail-closed', Boolean(requiredErr), 'no error');
  check('错误信息说明拒绝原因', /无法.*确认.*read-only|read-only.*拒绝/.test(String(requiredErr?.message)), String(requiredErr?.message));
  check('permissionVerified = false', c7.permissionVerified === false, String(c7.permissionVerified));

  const c8 = new Conversation({ id: 'session-no-proj-write', cwd: join(root, 'ws'), permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  const got8 = await c8.verifyPermissionRecorded({ attempts: 1, delayMs: 0 });
  check('非只读档缓存缺失时仍返回 null', got8 === null, String(got8));

  console.log('\n[5b] ★ 预设名对、沙箱不对 → 必须失败（审计 C01）');
  const c9 = new Conversation({ id: 'session-preset-lies', cwd: join(root, 'ws'), permission: 'read-only', onApproval: 'auto-deny' }, hub);
  {
    const file = join(home, 'storages', 'session_projcache', 'sessions', 'session-preset-lies.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ record: { rows: { permissions: { val: { preset: 'read-only', sandbox: 'danger-full-access', approval: 'never' } } } } }), 'utf8');
  }
  let liesErr = null;
  try { await c9.verifyPermissionRecorded({ attempts: 1, delayMs: 0 }); } catch (e) { liesErr = e; }
  check('★ sandbox=danger-full-access 的 "read-only" 记录被拒绝', /实际沙箱/.test(String(liesErr?.message)), String(liesErr?.message));
  check('permissionVerified 不为 true', c9.permissionVerified !== true, String(c9.permissionVerified));

  const c10 = new Conversation({ id: 'session-no-sandbox', cwd: join(root, 'ws'), permission: 'read-only', onApproval: 'auto-deny' }, hub);
  {
    const file = join(home, 'storages', 'session_projcache', 'sessions', 'session-no-sandbox.json');
    writeFileSync(file, JSON.stringify({ record: { rows: { permissions: { val: { preset: 'read-only' } } } } }), 'utf8');
  }
  let noSandboxErr = null;
  try { await c10.verifyPermissionRecorded({ attempts: 1, delayMs: 0 }); } catch (e) { noSandboxErr = e; }
  check('★ read-only 记录缺沙箱字段 → fail closed', Boolean(noSandboxErr), 'no error');

  console.log('\n[5c] ★ 机器侧未允许 full access 时，恢复既有 danger-full-access 会话被拒绝（审计 A02）');
  const c11 = new Conversation({ id: 'session-full-resume', cwd: join(root, 'ws'), permission: 'danger-full-access', onApproval: 'auto-allow' }, hub);
  let fullErr = null;
  try { await c11.ensureAlive(); } catch (e) { fullErr = e; }
  check('★ ensureAlive 拒绝并点名开关', /DSH_MCP_ALLOW_FULL_ACCESS/.test(String(fullErr?.message)), String(fullErr?.message));
  check('没有拉起进程', !c11.proc, String(c11.proc?.pid));

  console.log('\n[6] 并发接管同一磁盘会话只构造一个 Conversation');
  seedSession('session-adopt-race', join(root, 'ws'));
  const [a, b] = await Promise.all([hub.get('session-adopt-race'), hub.get('session-adopt-race')]);
  check('★ 两次并发 get 返回同一个对象', a === b, `${a?.id} / ${b?.id}`);
  check('注册表里只有一个实例', hub.conversations.get('session-adopt-race') === a, String(hub.conversations.size));
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== permission adopt 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
