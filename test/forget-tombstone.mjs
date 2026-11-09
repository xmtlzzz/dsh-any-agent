/**
 * forget 墓碑的纯内存回归（不花 token、不拉 DSH）。
 *
 * `release(forget=true)` 必须让按 id 的查询**明确失败**，而不是下一次
 * dsh_status/dsh_get 把它从 DSH 会话存储里复活。墓碑只含 id 与时间；
 * 删除 `.state/forgotten/<id>.json` 才恢复按 id 找回。
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

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

console.log('\n[5] ★ forget 前已排队的任务不会在 forget 之后被派发（审计 B04）');
{
  const q = new Conversation({ id: 'forget-queue', cwd: root, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  hub.conversations.set(q.id, q);
  const pending = [];
  const proc = {
    alive: true,
    prompts: 0,
    request(method) {
      if (method !== 'session/prompt') return Promise.resolve({});
      proc.prompts += 1;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    notify() {},
    async stop() {
      proc.alive = false;
      for (const p of pending.splice(0)) p.reject(new Error('process exited'));
      return true;
    },
  };
  q.ensureAlive = async () => {
    q.proc = proc;
    return proc;
  };
  await q.prompt('长任务', { wait: false });
  for (let i = 0; i < 300 && proc.prompts < 1; i++) await new Promise((r) => setTimeout(r, 10));
  const queued = q.enqueue('排队任务').run;
  const r = await q.close({ forget: true });
  await new Promise((res) => setTimeout(res, 300));
  check('forget 成功', r.forgotten === true, JSON.stringify(r));
  check('★ 排队任务没有被发出（session/prompt 只有 1 次）', proc.prompts === 1, String(proc.prompts));
  check('排队任务以 cancelled 收尾', queued.status === 'cancelled', queued.status);

  // 另一个实例已经写了墓碑：本实例手里的会话对象也不能再派活（审计 C03 的同一条路径）。
  let refused = null;
  try { await q.prompt('forget 之后', { wait: false }); } catch (e) { refused = e; }
  check('★ 有墓碑时 prompt 直接拒绝', /已被 forget/.test(String(refused?.message)), String(refused?.message));
  check('拒绝时没有再发 session/prompt', proc.prompts === 1, String(proc.prompts));
}

console.log('\n[6] ★ 墓碑写不进去时 forget 不报成功、也不从注册表移除（审计 B04）');
{
  // 墓碑目录在模块加载时定下，所以放到子进程里：让它的父路径是一个文件，mkdir 必然失败。
  writeFileSync(join(root, 'blocker'), 'not a directory');
  const hubUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hub.mjs')).href;
  const code = `
    const { Hub, Conversation } = await import(${JSON.stringify(hubUrl)});
    const hub = new Hub({ log: { info() {}, debug() {} } });
    const c = new Conversation({ id: 'tomb-fail', cwd: process.env.WS, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
    hub.conversations.set(c.id, c);
    const r = await c.close({ forget: true });
    console.log(JSON.stringify({ r, still: hub.conversations.has('tomb-fail') }));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      WS: root,
      DSH_HOME: join(root, 'dsh-home-child'),
      DSH_MCP_STATE: join(root, 'child-state', 'state.json'),
      DSH_MCP_FORGOTTEN_DIR: join(root, 'blocker', 'forgotten'),
    },
  });
  let parsed = null;
  try { parsed = JSON.parse(out.stdout.trim().split('\n').pop()); } catch {}
  check('子进程正常结束', out.status === 0 && parsed !== null, out.stderr || out.stdout);
  check('★ forgotten=false 并给出原因', parsed?.r?.forgotten === false && /墓碑写入失败/.test(parsed?.r?.error ?? ''), JSON.stringify(parsed?.r));
  check('★ 会话仍在注册表里（可修复后重试）', parsed?.still === true, JSON.stringify(parsed));
}

console.log('\n[7] ★ 两个实例共用注册表：后保存的不覆盖对方新增的条目、不把轮数写回旧值（审计 C03）');
{
  const mk = (h, id) => new Conversation({ id, cwd: root, permission: 'workspace-write', onApproval: 'auto-allow' }, h);
  const seedHub = new Hub({ log: { info() {}, debug() {} } });
  await seedHub.load();
  const seeded = mk(seedHub, 'multi-x');
  seeded.lastUsedAt = 1000;
  seedHub.conversations.set(seeded.id, seeded);
  seedHub.save();
  const A = new Hub({ log: { info() {}, debug() {} } });
  await A.load();
  const B = new Hub({ log: { info() {}, debug() {} } });
  await B.load();
  B.conversations.set('multi-y', mk(B, 'multi-y'));
  const bx = B.conversations.get('multi-x');
  bx.turnCount = 5;
  bx.lastUsedAt = Date.now();
  B.save();
  A.conversations.set('multi-z', mk(A, 'multi-z'));
  A.save(); // A 内存里的 multi-x 还是 0 轮
  const doc = JSON.parse(readFileSync(process.env.DSH_MCP_STATE, 'utf8'));
  const ids = doc.conversations.map((c) => c.id);
  check('★ B 新增的条目还在', ids.includes('multi-y'), ids.join(','));
  check('A 自己新增的条目也在', ids.includes('multi-z'), ids.join(','));
  check('★ 注册表里的轮数没有被写回 0', doc.conversations.find((c) => c.id === 'multi-x')?.turnCount === 5);
  const meta = JSON.parse(readFileSync(join(dirname(process.env.DSH_MCP_STATE), 'meta', 'multi-x.json'), 'utf8'));
  check('★ 侧车里的轮数也没有被写回 0', meta.turnCount === 5, String(meta.turnCount));

  A.remove('multi-z');
  check('本实例主动移除的条目不会被合并回来', !JSON.parse(readFileSync(process.env.DSH_MCP_STATE, 'utf8')).conversations.some((c) => c.id === 'multi-z'));

  console.log('\n[8] ★ 另一个活着的实例握着写锁时，这边不能 forget（审计 C03）');
  const locksUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locks.mjs')).href;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { writeMarker } = await import(${JSON.stringify(locksUrl)});
       writeMarker('multi-x', { childPid: process.pid, cwd: process.env.WS });
       process.stdout.write('ready\\n');
       setInterval(() => {}, 1000);`,
    ],
    { env: { ...process.env, WS: root }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await new Promise((res, rej) => {
      holder.stdout.once('data', res);
      holder.once('exit', () => rej(new Error('holder exited early')));
    });
    const r = await A.conversations.get('multi-x').close({ forget: true });
    check('★ forget 被拒绝（forgotten=false）并点名去那边 release', r.forgotten === false && /dsh_release/.test(r.error ?? ''), JSON.stringify(r));
    check('没有写墓碑', !existsSync(join(root, 'dsh-home', '.dsh-any-agent-forgotten', 'multi-x.json')));
  } finally {
    holder.kill();
  }
}

try {
  rmSync(root, { recursive: true, force: true });
} catch {}

console.log(`\n===== forget 墓碑回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
