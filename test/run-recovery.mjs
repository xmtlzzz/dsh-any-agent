/**
 * 被中断回合的恢复回归（离线：假 ACP 进程，不调用模型、不花 token）。
 *
 * 守的不变量：
 *   1. 回合一开始就写 `<run_id>.running` 标记（记主人 PID 与启动时刻），写出哨兵时删掉；
 *   2. 启动恢复只认领主人确实不在了的标记：PID 不存在、或 PID 被复用（启动时刻对不上）；
 *      主人还活着、或读不到启动时刻时一律不碰；看不懂的文件不碰也不删；
 *   3. 认领到的补写 status=error、stop_reason=interrupted 的哨兵（带审核单），并删掉标记；
 *      哨兵其实已经在了就只删标记，不覆盖；
 *   4. 本进程关闭时，在停任何子进程之前就同步给还在跑的回合写好哨兵；
 *   5. ★ 端到端：服务进程在回合中途被强杀，下一个服务进程启动时补出哨兵，dsh_get 也查得到。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-recovery-'));
const runsDir = join(root, 'runs');
const env = {
  DSH_MCP_STATE: join(root, 'state', 'conversations.json'),
  DSH_MCP_RUNS_DIR: runsDir,
  DSH_MCP_REVIEWS_DIR: join(root, 'reviews'),
  DSH_MCP_LOCKS_DIR: join(root, 'locks'),
  DSH_MCP_LIVE_DIR: join(root, 'live'),
  DSH_HOME: join(root, 'home'),
  DSH_MCP_GIT_STATUS: '0',
  DSH_MCP_SHARED_PROCESS: '0',
  DSH_BIN: join(HERE, 'fake-acp.mjs'),
  FAKE_ACP_DIR: join(root, 'fake-acp'),
  DSH_MCP_LOG: 'silent',
};
Object.assign(process.env, env);
delete process.env.DSH_MCP_DAEMON;

// ★ 项目模块一律在设好环境之后动态导入：config.mjs 在导入时就定下各目录，
//   静态导入（哪怕是间接的，比如 mcp-client.mjs → config.mjs）会让本套件写进真实状态目录。
const config = await import('../src/config.mjs');
if (config.RUNS_DIR !== runsDir || config.STATE_FILE !== env.DSH_MCP_STATE) {
  console.log(`✗ 状态目录没落在临时目录（${config.RUNS_DIR}），拒绝继续`);
  process.exit(1);
}
const { Hub } = await import('../src/hub.mjs');
const { McpClient } = await import('./mcp-client.mjs');
const { cleanupSuite } = await import('./residue.mjs');

let passed = 0;
let failed = 0;
async function check(name, fn, detail = '') {
  try {
    const ok = await fn();
    if (ok === false) throw new Error(`断言为 false ${detail}`);
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, debug() {} };
const markerOf = (conv, run) => join(runsDir, conv, `${run}.running`);
const sentinelOf = (conv, run) => join(runsDir, conv, `${run}.json`);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
function writeMarker(conv, run, extra = {}) {
  mkdirSync(join(runsDir, conv), { recursive: true });
  writeFileSync(
    markerOf(conv, run),
    JSON.stringify({ conversation_id: conv, run_id: run, review_mode: 'advisory', started_at: Date.now(), ...extra }),
  );
}
const DEAD = 2147483000;
const isInterrupted = (s) => s.status === 'error' && s.result?.stop_reason === 'interrupted' && Boolean(s.result?.review);

const allClients = [];
try {
  const hub = new Hub({ log });
  const conv = randomUUID();

  console.log('\n[1] 标记随回合开始写出、随哨兵写出删掉');
  hub.markRunStarted(conv, { run_id: 'run-1', prompt_preview: '做点事', review_mode: 'advisory', started_at: Date.now() });
  await check('回合开始：写出 .running 标记，记下本进程 PID', () => {
    const m = readJson(markerOf(conv, 'run-1'));
    return m.owner_pid === process.pid && Number.isFinite(m.owner_started_at) && m.run_id === 'run-1';
  });
  hub.writeRunSentinel(conv, { run_id: 'run-1', status: 'done', result: { stop_reason: 'end_turn', answer: 'ok' } });
  await check('哨兵写出：标记随之删掉', () => existsSync(sentinelOf(conv, 'run-1')) && !existsSync(markerOf(conv, 'run-1')));

  console.log('\n[2] 启动恢复只认领主人不在了的标记');
  const T = 1_700_000_000_000;
  writeMarker(conv, 'run-dead', { owner_pid: DEAD, owner_started_at: T });
  writeMarker(conv, 'run-live', { owner_pid: 4242, owner_started_at: T });
  writeMarker(conv, 'run-reused', { owner_pid: 4343, owner_started_at: T });
  writeMarker(conv, 'run-unknown', { owner_pid: 4444, owner_started_at: T });
  writeMarker(conv, 'run-1', { owner_pid: DEAD, owner_started_at: T }); // 哨兵已在（[1] 写的）
  mkdirSync(join(runsDir, 'not-a-conv'), { recursive: true });
  writeFileSync(join(runsDir, 'not-a-conv', 'garbage.running'), '{not json');
  writeMarker(conv, 'run-moved', { owner_pid: DEAD, run_id: 'other-run' }); // 内容与路径对不上
  const calls = [];
  const startTimes = { 4242: T + 1000, 4343: T + 10 * 60 * 1000, 4444: null };
  const recovered = hub.recoverInterruptedRuns({
    alive: (pid) => pid !== DEAD,
    startTimeOf: (pid) => (calls.push(pid), startTimes[pid] ?? null),
  });
  const ids = recovered.map((r) => r.run_id).sort();
  await check('恰好认领"主人已死"和"PID 被复用"的两个', () => JSON.stringify(ids) === '["run-dead","run-reused"]', JSON.stringify(ids));
  await check('主人已死：补写中断哨兵（error / interrupted / 带审核单），标记删掉', () =>
    isInterrupted(readJson(sentinelOf(conv, 'run-dead'))) && !existsSync(markerOf(conv, 'run-dead')),
  );
  await check('PID 被复用（启动时刻差 10 分钟）：同样补写', () => isInterrupted(readJson(sentinelOf(conv, 'run-reused'))));
  await check('主人还活着（启动时刻对得上）：不碰', () =>
    existsSync(markerOf(conv, 'run-live')) && !existsSync(sentinelOf(conv, 'run-live')),
  );
  await check('读不到启动时刻：按还活着处理，不碰', () =>
    existsSync(markerOf(conv, 'run-unknown')) && !existsSync(sentinelOf(conv, 'run-unknown')),
  );
  await check('哨兵其实已经在了：只删标记，不覆盖原哨兵', () =>
    !existsSync(markerOf(conv, 'run-1')) && readJson(sentinelOf(conv, 'run-1')).status === 'done',
  );
  await check('看不懂 / 路径对不上的文件：不碰也不删', () =>
    existsSync(join(runsDir, 'not-a-conv', 'garbage.running')) && existsSync(markerOf(conv, 'run-moved')) &&
    !existsSync(sentinelOf(conv, 'other-run')),
  );
  await check('同一主人只查一次启动时刻（Windows 上每查一次要起一个 PowerShell）', () => {
    writeMarker(conv, 'run-live-2', { owner_pid: 4242, owner_started_at: T });
    calls.length = 0;
    hub.recoverInterruptedRuns({ alive: (pid) => pid !== DEAD, startTimeOf: (pid) => (calls.push(pid), startTimes[pid] ?? null) });
    return calls.filter((p) => p === 4242).length === 1;
  }, JSON.stringify(calls));

  console.log('\n[3] 关闭时先给还在跑的回合写好哨兵');
  {
    const h = new Hub({ log });
    await h.load();
    // 假 ACP 进程在 create 时拉起、读的是那时的环境：延时要在这之前设好。
    process.env.FAKE_ACP_PROMPT_MS = '60000';
    const c = await h.create({ cwd: root });
    delete process.env.FAKE_ACP_PROMPT_MS;
    const receipt = await c.prompt('跑一个很长的回合', { wait: false });
    const runId = receipt.run_id;
    await check('回合在跑，标记已写出', () => c.busy && existsSync(markerOf(c.id, runId)));
    const closing = h.shutdown(); // 不 await：同步部分（写哨兵）必须在停任何子进程之前做完
    await check('★ shutdown 一调用（还没停子进程）哨兵就已经在了，且是 interrupted', () => {
      const s = readJson(sentinelOf(c.id, runId));
      return s.status === 'error' && s.result?.stop_reason === 'interrupted';
    });
    await closing;
    await check('关闭后标记不在了', () => !existsSync(markerOf(c.id, runId)));
  }

  console.log('\n[4] ★ 端到端：服务进程在回合中途被强杀，下一个服务进程补出哨兵');
  {
    const a = new McpClient({ env: { ...env, FAKE_ACP_PROMPT_MS: '60000' } }).start();
    allClients.push(a);
    await a.initialize();
    const started = await a.callTool('dsh_start', { cwd: root });
    const convId = started?.structuredContent?.conversation_id;
    const sent = await a.callTool('dsh_send', { conversation_id: convId, prompt: '跑一个很长的回合', client_run_id: 'recovery-active' });
    const runId = sent?.structuredContent?.run_id;
    const sentinel = sent?.structuredContent?.sentinel_file;
    await check('dsh_send 立刻返回收据，标记已写出', () => typeof runId === 'string' && existsSync(markerOf(convId, runId)), McpClient.text(sent).slice(0, 200));
    const queued = (await a.callTool('dsh_send', {
      conversation_id: convId, prompt: '排队回合', client_run_id: 'recovery-queued', queue: true,
    })).structuredContent;
    await check('队列回执返回前已落盘，且不含完整任务正文', () => {
      const receipt = readJson(markerOf(convId, queued.run_id));
      return queued.queued && receipt.status === 'queued' && receipt.started_at === null && !Object.hasOwn(receipt, 'text');
    });
    process.kill(a.pid, 'SIGKILL');
    for (let i = 0; i < 50 && (() => { try { process.kill(a.pid, 0); return true; } catch { return false; } })(); i++) await sleep(100);
    await check('强杀之后没人写哨兵', () => !existsSync(sentinel));

    const b = new McpClient({ env }).start();
    allClients.push(b);
    await b.initialize();
    for (let i = 0; i < 50 && !existsSync(sentinel); i++) await sleep(100);
    await check('★ 新服务进程启动时补出了中断哨兵', () => isInterrupted(readJson(sentinel)));
    await check('标记删掉了', () => !existsSync(markerOf(convId, runId)));
    const got = await b.callTool('dsh_get', { conversation_id: convId, run_id: runId });
    await check('dsh_get 从哨兵查得到这个回合被中断', () => /interrupted/.test(McpClient.text(got)) && !got?.isError, McpClient.text(got).slice(0, 300));
    const afterQueue = await b.callTool('dsh_get', { conversation_id: convId, client_run_id: 'recovery-queued' });
    await check('重启后能按幂等键查到排队回合已取消', () =>
      existsSync(queued.sentinel_file) && afterQueue.structuredContent?.run?.status === 'cancelled' &&
      afterQueue.structuredContent.run.run_id === queued.run_id);
    const retry = await b.callTool('dsh_send', {
      conversation_id: convId, prompt: '重试同一任务', client_run_id: 'recovery-active',
    });
    await check('重启后同一个幂等键返回原终态', () =>
      retry.structuredContent?.replayed === true && retry.structuredContent.run_id === runId &&
      retry.structuredContent.stop_reason === 'interrupted');
    await b.close();
  }
} catch (e) {
  failed += 1;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  for (const cl of allClients) await cl.close().catch(() => {});
  await sleep(200);
  cleanupSuite({ clients: allClients, roots: [root] });
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n===== run-recovery: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
