/**
 * forget 墓碑的纯内存回归（不花 token、不拉 DSH）。
 *
 * `release(forget=true)` 必须让按 id 的查询**明确失败**，而不是下一次
 * dsh_status/dsh_get 把它从 DSH 会话存储里复活。墓碑只含 id 与时间；
 * 删除 `.state/forgotten/<id>.json` 才恢复按 id 找回。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-forget-test-'));
process.env.DSH_MCP_STATE = join(root, 'state.json');
// 墓碑存放在 DSH_HOME 下；测试必须隔离，绝不能写进真实 ~/.dsh。
process.env.DSH_HOME = join(root, 'dsh-home');
const { Hub, Conversation } = await import('../src/hub.mjs');

const hub = new Hub({ log: { info() {}, debug() {} } });
const conv = new Conversation(
  { id: 'forget-test', cwd: root, permission: 'workspace-write', onApproval: 'auto-allow', titleHint: 'forget-me' },
  hub,
);
hub.conversations.set(conv.id, conv);
hub.save();

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const tombstone = join(root, 'dsh-home', '.dsh-any-agent-forgotten', 'forget-test.json');

console.log('\n[1] forget 写墓碑并从注册表移除');
await conv.close({ forget: true });
check('注册表里已移除', !hub.conversations.has('forget-test'));
check('墓碑已写入', existsSync(tombstone), tombstone);

console.log('\n[1b] 会话文件在但头读不出来：墓碑必须保留');
{
  const sessionDir = join(root, 'dsh-home', 'sessions', 'bucket', 'forget-test');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.from('not-a-zstd-frame'));
  await hub.load();
  check('★ 会话头损坏时不删除 forget 墓碑', existsSync(tombstone), tombstone);
  // 故意保留损坏会话文件：后面的 [1c] 再 load 时，forget-test 仍应是 error 而不是 missing。
}

console.log('\n[1c] 会话文件确实不存在：启动清理才删除墓碑');
{
  const gone = new Conversation({ id: 'prune-missing', cwd: root, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  hub.conversations.set(gone.id, gone);
  await gone.close({ forget: true });
  const goneTomb = join(root, 'dsh-home', '.dsh-any-agent-forgotten', 'prune-missing.json');
  check('prune-missing 墓碑已写入', existsSync(goneTomb), goneTomb);
  await hub.load();
  check('会话文件不存在时墓碑被清理', !existsSync(goneTomb), goneTomb);
}

console.log('\n[2] 按 id 查询明确失败（不再复活）');
let err = null;
try {
  await hub.get('forget-test');
} catch (e) {
  err = e;
}
check('get 报“已被 forget”', /已被 forget/.test(err?.message ?? ''), String(err?.message));
check('错误里给出删除墓碑的恢复路径', String(err?.message).includes(tombstone));

console.log('\n[3] 列表不展示被 forget 的会话');
const listed = await hub.list({ includeClosed: false });
check('内存列表为空', !listed.some((c) => c.conversation_id === 'forget-test'), JSON.stringify(listed));

console.log('\n[4] 删除墓碑 → 回到常规“未知会话”路径');
rmSync(tombstone, { force: true });
// 移除 [1b] 故意留下的损坏会话文件，回到“文件确实不存在”的常规路径。
rmSync(join(root, 'dsh-home', 'sessions', 'bucket', 'forget-test'), { recursive: true, force: true });
let err2 = null;
try {
  await hub.get('forget-test');
} catch (e) {
  err2 = e;
}
check('墓碑删除后不再报“已被 forget”', !/已被 forget/.test(err2?.message ?? ''), String(err2?.message));
check('而是常规未知会话（说明墓碑才是之前的拦截者）', /未知会话/.test(err2?.message ?? ''), String(err2?.message));

try {
  rmSync(root, { recursive: true, force: true });
} catch {}

console.log(`\n===== forget 墓碑回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
