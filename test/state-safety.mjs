/**
 * 状态/哨兵/锁目录的安全边界（纯文件系统，不花 token）。
 *
 *   [1] 默认状态目录在用户可写位置（$DSH_HOME/.dsh-any-agent），不在包安装目录
 *   [2] 目录不可写时启动明确失败，而不是静默降级
 *   [3] 哨兵写失败会返回 null + sentinel_error，调用方有机会看到
 *   [4] 非法数值环境变量落到安全侧（负 TTL 不清空哨兵；空串权限/思考档回落默认）
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, truncateSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

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
  cfg.probeWritableDir(normal, { hardlink: true });
  check('hard-link probe removes both names', readdirSync(normal).length === 0);
  const unsupported = runNode(`import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let cleanup = 0;
    fs.linkSync = () => { throw Object.assign(new Error('unsupported hard links'), { code: 'ENOTSUP' }); };
    fs.rmSync = () => { cleanup++; throw new Error('cleanup denied'); };
    syncBuiltinESMExports();
    const cfg = await import(${JSON.stringify(CONFIG)});
    try { cfg.probeWritableDir(process.env.PROBE_DIR, { hardlink: true }); }
    catch (e) { console.log(JSON.stringify({ code: e.code, cleanup })); }`, { PROBE_DIR: normal });
  check('unsupported hard links retain the original failure even when probe cleanup also fails',
    unsupported.value?.code === 'ENOTSUP' && unsupported.value?.cleanup === 1, unsupported.stderr);
  const blocked = join(root, 'not-a-dir');
  writeFileSync(blocked, 'x');
  let threw = null;
  try { cfg.assertWritableDir(join(blocked, 'child'), '测试目录'); } catch (e) { threw = e; }
  check('★ 不可写时抛出可读错误', Boolean(threw) && /不可写/.test(String(threw.message)), String(threw?.message));

  const atomicModule = new URL('../src/fs-atomic.mjs', import.meta.url).href;
  const atomicFile = join(normal, 'atomic');
  const { writeFileAtomic } = await import(atomicModule);
  writeFileAtomic(atomicFile, Buffer.from([0xff, 0]), { mode: 0o600, mtime: 0, exclusive: true });
  let duplicate;
  try { writeFileAtomic(atomicFile, 'replacement', { exclusive: true }); } catch (e) { duplicate = e.code; }
  check('Exclusive publication preserves the first bytes and requested mtime, and clears staging files',
    duplicate === 'EEXIST' && readFileSync(atomicFile).equals(Buffer.from([0xff, 0])) &&
    statSync(atomicFile).mtimeMs === 0 && !readdirSync(normal).some((name) => name.includes('.tmp.')));
  const failedWrite = runNode(`import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.renameSync = () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); };
    fs.rmSync = () => { throw new Error('cleanup failed'); };
    syncBuiltinESMExports();
    const { writeFileAtomic } = await import(${JSON.stringify(atomicModule)});
    try { writeFileAtomic(process.env.TARGET, 'replacement'); }
    catch (e) { console.log(JSON.stringify(e.code)); }`, { TARGET: atomicFile });
  check('A temp cleanup failure preserves the rename error and original file',
    failedWrite.value === 'EIO' && readFileSync(atomicFile).equals(Buffer.from([0xff, 0])));
  const blockedTarget = join(root, 'existing-dir');
  mkdirSync(blockedTarget);
  let writeFailed = false;
  try { writeFileAtomic(blockedTarget, 'content'); } catch { writeFailed = true; }
  check('Failed replacement cleans temporary files', writeFailed && !readdirSync(root).some((f) => f.startsWith('existing-dir.tmp.')));

  const { audit } = await import('../src/audit.mjs');
  const auditFile = join(root, 'audit.jsonl');
  const auditSize = 10 * 1024 * 1024 + 1;
  writeFileSync(auditFile, '');
  truncateSync(auditFile, auditSize);
  mkdirSync(auditFile + '.1'); // Blocks rotation on both Windows and POSIX.
  process.env.DSH_MCP_AUDIT_FILE = auditFile;
  audit('rotation-blocked');
  delete process.env.DSH_MCP_AUDIT_FILE;
  check('The current audit event is appended when rotation fails',
    JSON.parse(readFileSync(auditFile).subarray(auditSize).toString() || 'null')?.event === 'rotation-blocked');

  const { readConversationMeta } = await import('../src/titles.mjs');
  const { DSH_PROJCACHE_REL } = await import('../src/dsh-contract.mjs');
  const cache = join(home, ...DSH_PROJCACHE_REL);
  mkdirSync(cache, { recursive: true });
  const record = JSON.stringify({ record: { rows: { title: { val: 'fixture' } } } });
  writeFileSync(join(cache, 'valid-id.json'), record);
  writeFileSync(join(dirname(cache), 'outside.json'), record);
  check('Only safe single-segment session IDs can read projection metadata',
    readConversationMeta('valid-id')?.title === 'fixture' &&
    ['../outside', '..\\outside', '.', '..', 'x'.repeat(129), null].every((id) => readConversationMeta(id) === null));

  console.log('\n[3] Hub.load 创建三个目录');
  const hub = new Hub({ log: { info() {}, debug() {} } });
  await hub.load();
  check('状态目录已创建', existsSync(dirname(cfg.STATE_FILE)));
  check('哨兵目录已创建', existsSync(cfg.RUNS_DIR));
  check('锁登记目录已创建', existsSync(join(dirname(cfg.STATE_FILE), 'locks')));

  const entry = { id: 'legacy-session', cwd: root };
  writeFileSync(cfg.STATE_FILE, '\uFEFF' + JSON.stringify({ version: 1, conversations: [entry] }));
  await hub.load();
  await hub.shutdown();
  check('带 BOM 的注册表重启后保留原会话', JSON.parse(readFileSync(cfg.STATE_FILE, 'utf8')).conversations[0]?.id === entry.id);

  const corrupt = '{"conversations":[';
  writeFileSync(cfg.STATE_FILE, corrupt);
  let loadError, saveError;
  try { await new Hub().load(); } catch (error) { loadError = error; }
  try { await hub.save(); } catch (error) { saveError = error; }
  check('启动时明确报告损坏注册表的位置', loadError?.message.includes(cfg.STATE_FILE));
  check('运行中读到坏注册表时保存失败且原件完整', saveError?.message.includes(cfg.STATE_FILE) &&
    readFileSync(cfg.STATE_FILE, 'utf8') === corrupt);
  rmSync(cfg.STATE_FILE);

  const registryModule = new URL('../src/registry.mjs', import.meta.url).href;
  const crash = runNode(`import { withRegistryLock } from ${JSON.stringify(registryModule)};
    await withRegistryLock(process.env.REGISTRY, () => process.exit(17));`, { REGISTRY: cfg.STATE_FILE });
  const markerName = readdirSync(cfg.STATE_FILE + '.lock')[0];
  const deadPid = markerName.split('-')[0];
  const abandoned = mkdtempSync(cfg.STATE_FILE + '.lock-' + deadPid + '-');
  const active = mkdtempSync(cfg.STATE_FILE + '.lock-' + process.pid + '-');
  const workspaceStage = (pid) => join(home, '.dsh-any-agent', `workspace-registry.lock-${pid}-abcdef`);
  mkdirSync(workspaceStage(deadPid));
  mkdirSync(workspaceStage(process.pid));
  await hub.load();
  check('startup removes an abandoned staging directory and preserves a live writer staging its marker',
    !existsSync(abandoned) && existsSync(active));
  check('startup prunes only the dead workspace registry writer’s stage',
    !existsSync(workspaceStage(deadPid)) && existsSync(workspaceStage(process.pid)));
  await hub.save();
  check('持锁进程退出后仍可保存注册表', crash.code === 17 && !existsSync(cfg.STATE_FILE + '.lock'));
  const { inspectRegistryLock, withRegistryLockSync } = await import(registryModule);
  const lockDir = cfg.STATE_FILE + '.lock';
  mkdirSync(lockDir);
  const ownerFile = join(lockDir, process.pid + '-00000000-0000-0000-0000-000000000000');
  const old = new Date(Date.now() - 120000);
  writeFileSync(ownerFile, String(Math.round(Date.now() - process.uptime() * 1000)));
  utimesSync(ownerFile, old, old);
  check('a live owner retains an old lock', inspectRegistryLock(cfg.STATE_FILE).state === 'held');
  writeFileSync(ownerFile, '1');
  utimesSync(ownerFile, old, old);
  check('process identity identifies a reused PID', inspectRegistryLock(cfg.STATE_FILE).state === 'reused');
  withRegistryLockSync(cfg.STATE_FILE, () => {});
  check('the next writer recovers the stale lock', !existsSync(lockDir));

  // All four processes load the same snapshot before any writer can proceed.
  const writer = `import { Hub, Conversation } from ${JSON.stringify(HUB)};
    const hub = new Hub();
    await hub.load();
    process.once('message', async () => {
      const id = 'writer-' + process.pid;
      hub.conversations.set(id, new Conversation({ id, cwd: process.cwd() }, hub));
      await hub.save();
      process.disconnect();
    });
    process.send('ready');`;
  let ready = 0;
  const children = [];
  try {
    const exits = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', writer], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'], timeout: 15_000, windowsHide: true,
      });
      children.push(child);
      child.once('message', () => {
        if (++ready === 4) for (const peer of children) peer.send('save');
      });
      return once(child, 'exit');
    });
    const statuses = await Promise.all(exits);
    const persisted = new Set(JSON.parse(readFileSync(cfg.STATE_FILE, 'utf8')).conversations.map((c) => c.id));
    check('四个进程同时新增会话时保留每一条登记', statuses.every(([code]) => code === 0) &&
      persisted.has(entry.id) && children.every(({ pid }) => persisted.has('writer-' + pid)));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  }

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

  console.log('\n[7b] 接管核对操作系统记录的进程身份');
  const { isPidAlive, killHolderChild, readProcessStartTime, processStartTime } = await import('../src/locks.mjs');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  try {
    await once(child, 'spawn');
    const startedAt = await readProcessStartTime(child.pid);
    writeMarker('marker-verified-child', { childPid: child.pid, childStartedAt: startedAt, cwd: root });
    const marker = JSON.parse(readFileSync(markerPath('marker-verified-child'), 'utf8'));
    check('登记保存操作系统提供的启动时间', Number.isFinite(startedAt) && marker.child_started_at === processStartTime(child.pid));
    const legacy = killHolderChild(child.pid);
    check('仅有旧登记时间或 PID 时不终止进程', !legacy.killed && isPidAlive(child.pid));
    const mismatch = killHolderChild(child.pid, { expectedStartedAt: startedAt - 60_000 });
    check('启动时间相差一分钟也拒绝终止', !mismatch.killed && isPidAlive(child.pid));
    const matched = killHolderChild(child.pid, { expectedStartedAt: marker.child_started_at });
    check('成功核对身份后可以终止原进程', matched.killed, matched.reason);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }

  const { createMcpServer } = await import('../src/mcp.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = [];
  output.on('data', (chunk) => errors.push(JSON.parse(chunk)));
  createMcpServer({ input, output, handlers: {} }).start();
  input.end('{\n{"jsonrpc":"2.0"}\n{"jsonrpc":"2.0","id":{}}\n');
  await new Promise((done) => setImmediate(done));
  check('Malformed JSON and invalid requests return null IDs', errors.length === 3 &&
    errors.every((e) => e.id === null) && errors.map((e) => e.error.code).join(',') === '-32700,-32600,-32600');
  const { schemaIssue } = await import('../src/tool-schema.mjs');
  check('Nullable strings and numbers ignore inapplicable bounds',
    schemaIssue({ type: ['string', 'null'], maxLength: 1 }, null, 'x') === null &&
    schemaIssue({ type: ['number', 'null'], minimum: 1 }, null, 'x') === null);
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/check-docs-sync.mjs', import.meta.url))]);
  check('Documentation contract check succeeds', true);
  const { inspectDshStorageLayout } = await import('../src/dsh-contract.mjs');
  const formatHome = join(root, 'formats');
  const workspace = join(formatHome, 'storages', 'workspace.json');
  mkdirSync(dirname(workspace), { recursive: true });
  writeFileSync(workspace, '{"unit":{"version":2}}');
  check('Known workspace schema passes inspection', inspectDshStorageLayout(formatHome).status === 'ok');
  writeFileSync(workspace, '{"unit":{"version":3}}');
  check('Unknown workspace schema warns without rewriting it',
    inspectDshStorageLayout(formatHome).status === 'warn' && readFileSync(workspace, 'utf8') === '{"unit":{"version":3}}');
  const sessionDir = join(home, 'sessions', 'bucket', 'future');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.v5.jsonl'), '');
  writeFileSync(join(dirname(cfg.STATE_FILE), 'daemon-aaaa.json'), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(dirname(cfg.STATE_FILE), 'daemon-bbbb.json'), JSON.stringify({ pid: process.ppid }));
  process.env.DSH_MCP_UPDATE_CHECK = '0';
  const { runDoctor } = await import('../src/doctor.mjs');
  const doctor = await runDoctor(new Hub());
  const storage = doctor.structured.checks.find((c) => c.id === 'dsh_storage');
  check('Doctor warns about a newer session log version', storage?.status === 'warn' && /5/.test(storage.detail));
  const daemon = doctor.structured.checks.find((c) => c.id === 'daemon');
  check('Doctor reports multiple active daemons with a configuration hint',
    daemon?.status === 'warn' && /2/.test(daemon.detail) && /DSH_MCP_DAEMON_IGNORE_ENV/.test(daemon.fix));

  const { metaFilePath } = await import('../src/hub-store.mjs');
  const dirtyHub = new Hub();
  const persisted = new Conversation({ id: 'dirty-meta', cwd: root }, dirtyHub);
  dirtyHub.conversations.set(persisted.id, persisted);
  const sidecar = metaFilePath(persisted.id);
  await dirtyHub.save();
  utimesSync(sidecar, 1000000, 1000000);
  await dirtyHub.save();
  check('Unchanged metadata keeps the original sidecar', statSync(sidecar).mtimeMs === 1000000000);
  persisted.titleHint = 'changed';
  await dirtyHub.save();
  check('Changed metadata is persisted', JSON.parse(readFileSync(sidecar, 'utf8')).titleHint === 'changed');
  rmSync(sidecar);
  await dirtyHub.save();
  check('Missing sidecar is recreated', existsSync(sidecar));

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
