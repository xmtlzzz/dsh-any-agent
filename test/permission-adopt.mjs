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
  const c1 = hub.get('session-no-record');
  check('★ 权限档回落 read-only', c1.permission === 'read-only', c1.permission);
  check('审批策略随之 auto-deny', c1.onApproval === 'auto-deny', c1.onApproval);

  console.log('\n[2] 会话自己记录 workspace-write → 尊重记录');
  seedSession('session-write-record', join(root, 'ws'));
  seedProj('session-write-record', 'workspace-write');
  const c2 = hub.get('session-write-record');
  check('权限档 = workspace-write', c2.permission === 'workspace-write', c2.permission);
  check('审批策略 = auto-allow', c2.onApproval === 'auto-allow', c2.onApproval);

  console.log('\n[3] 记录 read-only 不能被侧车提升');
  seedSession('session-readonly', join(root, 'ws'));
  seedProj('session-readonly', 'read-only');
  seedMeta('session-readonly', 'danger-full-access');
  const c3 = hub.get('session-readonly');
  check('★ 仍为 read-only', c3.permission === 'read-only', c3.permission);
  check('审批策略仍 auto-deny', c3.onApproval === 'auto-deny', c3.onApproval);

  console.log('\n[4] 没有投影缓存时，本服务侧车是可信来源');
  seedSession('session-meta-only', join(root, 'ws'));
  seedMeta('session-meta-only', 'workspace-write');
  const c4 = hub.get('session-meta-only');
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
  const got7 = await c7.verifyPermissionRecorded({ attempts: 1, delayMs: 0 });
  check('投影缓存缺失时不假失败（返回 null）', got7 === null, String(got7));
  check('permissionVerified = false', c7.permissionVerified === false, String(c7.permissionVerified));
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== permission adopt 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
