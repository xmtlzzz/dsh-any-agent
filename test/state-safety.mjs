/**
 * 状态/哨兵/锁目录的安全边界（纯文件系统，不花 token）。
 *
 *   [1] 默认状态目录在用户可写位置（$DSH_HOME/.dsh-any-agent），不在包安装目录
 *   [2] 目录不可写时启动明确失败，而不是静默降级
 *   [3] 哨兵写失败会返回 null + sentinel_error，调用方有机会看到
 *   [4] 非法数值环境变量落到安全侧（负 TTL 不清空哨兵；空串权限/思考档回落默认）
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-state-safety-'));
const home = join(root, 'home');
process.env.DSH_HOME = home;
delete process.env.DSH_MCP_STATE;
delete process.env.DSH_MCP_RUNS_DIR;
delete process.env.DSH_MCP_LOCKS_DIR;

const cfg = await import('../src/config.mjs');
const { Hub } = await import('../src/hub.mjs');

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

const CONFIG = new URL('../src/config.mjs', import.meta.url).href;
const HUB = new URL('../src/hub.mjs', import.meta.url).href;

function runNode(script, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let value = null;
  try { value = JSON.parse(lines[lines.length - 1]); } catch {}
  return { value, code: r.status, stderr: r.stderr };
}

try {
  console.log('\n[1] 默认路径在用户可写目录');
  check('★ STATE_FILE 在 $DSH_HOME/.dsh-any-agent 下', cfg.STATE_FILE.startsWith(join(home, '.dsh-any-agent')), cfg.STATE_FILE);
  check('★ RUNS_DIR 跟着状态目录走', cfg.RUNS_DIR.startsWith(join(home, '.dsh-any-agent')), cfg.RUNS_DIR);
  check('USING_DEFAULT_STATE = true', cfg.USING_DEFAULT_STATE === true);
  check('旧默认位置仍被记住用于迁移', cfg.LEGACY_STATE_FILE.endsWith(join('.state', 'conversations.json')), cfg.LEGACY_STATE_FILE);

  console.log('\n[2] 目录不可写时明确失败');
  const normal = join(root, 'writable');
  cfg.assertWritableDir(normal, '测试目录');
  check('可写目录被创建', existsSync(normal));
  const blocked = join(root, 'not-a-dir');
  writeFileSync(blocked, 'x');
  let threw = null;
  try { cfg.assertWritableDir(join(blocked, 'child'), '测试目录'); } catch (e) { threw = e; }
  check('★ 不可写时抛出可读错误', Boolean(threw) && /不可写/.test(String(threw.message)), String(threw?.message));

  console.log('\n[3] Hub.load 创建三个目录');
  const hub = new Hub({ log: { info() {}, debug() {} } });
  await hub.load();
  check('状态目录已创建', existsSync(dirname(cfg.STATE_FILE)));
  check('哨兵目录已创建', existsSync(cfg.RUNS_DIR));
  check('锁登记目录已创建', existsSync(join(dirname(cfg.STATE_FILE), 'locks')));

  console.log('\n[4] 哨兵写成功/失败都可见');
  const run = { run_id: 'run-sentinel-test', status: 'done', ended_at: Date.now(), result: { answer: 'ok' } };
  const sentinel = hub.writeRunSentinel('conv-sentinel-test', run);
  check('成功时返回路径', typeof sentinel === 'string' && existsSync(sentinel), String(sentinel));
  check('文件内容是合法 JSON', sentinel ? JSON.parse(readFileSync(sentinel, 'utf8')).status === 'done' : false);

  const badRuns = join(root, 'runs-is-a-file');
  writeFileSync(badRuns, 'x');
  const failScript =
    `const { Hub } = await import(${JSON.stringify(HUB)});\n` +
    'const hub = new Hub({ log: { info() {}, debug() {} } });\n' +
    "const run = { run_id: 'r1', status: 'done', result: { answer: 'x' } };\n" +
    "const p = hub.writeRunSentinel('c1', run);\n" +
    'console.log(JSON.stringify({ path: p, error: run.sentinel_error || null }));';
  const fail = runNode(failScript, { DSH_HOME: join(root, 'bad-home'), DSH_MCP_RUNS_DIR: badRuns });
  check('★ 写失败返回 null', fail.value?.path === null, JSON.stringify(fail.value || fail.stderr));
  check('★ 写失败把原因记在 sentinel_error', /写完成哨兵失败/.test(String(fail.value?.error)), String(fail.value?.error));

  console.log('\n[5] 非法数值环境变量落到安全侧');
  const envScript =
    `const cfg = await import(${JSON.stringify(CONFIG)});\n` +
    'console.log(JSON.stringify({ ttl: cfg.SENTINEL_TTL_MS, permission: cfg.DEFAULT_PERMISSION, effort: cfg.DEFAULT_REASONING_EFFORT, usingDefault: cfg.USING_DEFAULT_STATE }));';
  const neg = runNode(envScript, { DSH_HOME: join(root, 'env-home'), DSH_MCP_SENTINEL_TTL_MS: '-1', DSH_MCP_PERMISSION: '', DSH_MCP_REASONING_EFFORT: '' });
  check('负 SENTINEL_TTL 压到 0（关闭清理）', neg.value?.ttl === 0, JSON.stringify(neg.value || neg.stderr));
  check('空 PERMISSION 回落 workspace-write（0.5.0 起）', neg.value?.permission === 'workspace-write', JSON.stringify(neg.value));
  check('空 REASONING_EFFORT 回落 max', neg.value?.effort === 'max', JSON.stringify(neg.value));
  const explicit = runNode(envScript, { DSH_HOME: join(root, 'env-home-2'), DSH_MCP_STATE: join(root, 'explicit.json') });
  check('显式 DSH_MCP_STATE 时不做默认迁移', explicit.value?.usingDefault === false, JSON.stringify(explicit.value || explicit.stderr));

  console.log('\n[6] releaseAll 默认跳过 busy 会话');
  const { Conversation } = await import('../src/hub.mjs');
  const hub2 = new Hub({ log: { info() {}, debug() {} } });
  const stopped = [];
  const fake = (id, busy) => {
    const c = new Conversation({ id, cwd: root, permission: 'read-only', onApproval: 'auto-deny' }, hub2);
    c.proc = { alive: true, stop: async () => { stopped.push(id); return true; } };
    c.busy = busy;
    hub2.conversations.set(id, c);
    return c;
  };
  fake('release-idle-1', false);
  fake('release-busy-2', true);
  const r1 = await hub2.releaseAll();
  check('默认只释放空闲会话', r1.released === 1 && r1.conversations[0] === 'release-idle-1', JSON.stringify(r1));
  check('★ busy 会话被跳过而不是中断', r1.skipped_busy.includes('release-busy-2') && !stopped.includes('release-busy-2'), JSON.stringify({ r1, stopped }));
  const r2 = await hub2.releaseAll({ force: true });
  check('force=true 才停 busy', r2.released === 1 && stopped.includes('release-busy-2'), JSON.stringify({ r2, stopped }));
  check('返回值区分 released 与 skipped_busy', Array.isArray(r1.skipped_busy) && Array.isArray(r2.skipped_busy));

  console.log('\n[7] 锁登记 spawned_at 不跨子进程复用');
  const { writeMarker, markerPath } = await import('../src/locks.mjs');
  writeMarker('marker-spawn-test', { childPid: 11111, cwd: root });
  const m1 = JSON.parse(readFileSync(markerPath('marker-spawn-test'), 'utf8'));
  await new Promise((r) => setTimeout(r, 5));
  writeMarker('marker-spawn-test', { childPid: 22222, cwd: root });
  const m2 = JSON.parse(readFileSync(markerPath('marker-spawn-test'), 'utf8'));
  check('★ 子进程 PID 变化时 spawned_at 重置', typeof m2.spawned_at === 'number' && m2.spawned_at > m1.spawned_at, `${m1.spawned_at} -> ${m2.spawned_at}`);
  writeMarker('marker-spawn-test', { childPid: 22222, cwd: root });
  const m3 = JSON.parse(readFileSync(markerPath('marker-spawn-test'), 'utf8'));
  check('同一子进程时沿用 spawned_at', m3.spawned_at === m2.spawned_at, `${m2.spawned_at} -> ${m3.spawned_at}`);

  console.log('\n[8] workspace_changed 用快照内容比较');
  const { sameWorkspaceSnapshot } = await import('../src/hub.mjs');
  const snapA = { changed_files: 1, entries: [' M a.js'] };
  check('相同 entries 视为未变化', sameWorkspaceSnapshot(snapA, { changed_files: 1, entries: [' M a.js'] }));
  check('不同 entries 视为变化', !sameWorkspaceSnapshot(snapA, { changed_files: 1, entries: [' M b.js'] }));
  check('都为空视为未变化', sameWorkspaceSnapshot(null, null));
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== state safety 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
