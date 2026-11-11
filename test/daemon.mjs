/**
 * 常驻进程模式回归（DSH_MCP_DAEMON=1；离线：假 ACP 进程，不调用模型、不花 token）。
 *
 * 守的不变量：
 *   1. 客户端拉起的是转发进程，MCP 握手经它转到常驻进程，照常能用；
 *   2. ★ 转发进程被强杀（客户端关掉 / 重连 / 崩溃）后，常驻进程里正在跑的回合照常跑完、写出哨兵；
 *   3. 第二个客户端连到同一个常驻进程；配置不同的客户端不会共用一个常驻进程；
 *   4. 没带令牌 / 令牌不对的连接被直接断开，拿不到任何应答；
 *   5. 没有客户端、没有回合时，空闲一段时间后常驻进程自己退出并删掉信息文件。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.mjs';
import { cleanupSuite } from './residue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-daemon-'));
const stateDir = join(root, 'state');
const baseEnv = {
  DSH_MCP_DAEMON: '1',
  DSH_MCP_DAEMON_IDLE_MS: '2000',
  DSH_MCP_STATE: join(stateDir, 'conversations.json'),
  DSH_HOME: join(root, 'home'),
  DSH_MCP_LIVE_DIR: join(root, 'live'),
  DSH_MCP_GIT_STATUS: '0',
  DSH_BIN: join(HERE, 'fake-acp.mjs'),
  FAKE_ACP_DIR: join(root, 'fake-acp'),
  FAKE_ACP_PROMPT_MS: '1500',
  DSH_MCP_LOG: 'silent',
};

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const infoFiles = () => (existsSync(stateDir) ? readdirSync(stateDir).filter((f) => /^daemon-[0-9a-f]+\.json$/.test(f)) : []);
const readInfo = (f) => JSON.parse(readFileSync(join(stateDir, f), 'utf8'));
const daemonPids = () => infoFiles().map((f) => readInfo(f).pid);

/** 不带 / 带错令牌直接连常驻进程，看能不能拿到 initialize 的应答。 */
function rawProbe(path, firstLine) {
  return new Promise((resolve) => {
    const s = net.connect(path);
    let got = '';
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on('connect', () => {
      if (firstLine) s.write(firstLine + '\n');
      s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
    });
    s.on('data', (d) => (got += d));
    s.on('close', () => done(got));
    s.on('error', () => done(got));
    setTimeout(() => done(got), 2000);
  });
}

const clients = [];
/** 建过的全部客户端（clients 在 [5] 里会被清空；收尾清理要用它们记下的会话 id）。 */
const allClients = [];
const track = (cl) => (clients.push(cl), allClients.push(cl), cl);
try {
  console.log('\n[1] 经转发进程握手');
  const a = track(new McpClient({ env: baseEnv }).start());
  const init = await a.initialize();
  await check('initialize 经常驻进程应答', () => init?.serverInfo?.name === 'dsh-any-agent');
  await check('工具清单完整', async () => (await a.listTools()).some((t) => t.name === 'dsh_send'));
  const [info] = infoFiles();
  const daemonPid = info ? readInfo(info).pid : null;
  await check('常驻进程已起来、写了信息文件', () => Boolean(daemonPid) && alive(daemonPid));
  await check('常驻进程不是转发进程本身', () => daemonPid !== a.pid);

  console.log('\n[2] ★ 转发进程被强杀，回合照常跑完、写出哨兵');
  const started = await a.callTool('dsh_start', { cwd: root });
  const convId = started?.structuredContent?.conversation_id;
  await check('dsh_start 成功', () => typeof convId === 'string', McpClient.text(started));
  const sent = await a.callTool('dsh_send', { conversation_id: convId, prompt: '跑一个 1.5 秒的回合' });
  const sentinel = sent?.structuredContent?.sentinel_file;
  await check('dsh_send 立刻返回收据', () => typeof sentinel === 'string' && sent.structuredContent.still_running === true, McpClient.text(sent));
  process.kill(a.pid, 'SIGKILL');
  for (let i = 0; i < 80 && !(sentinel && existsSync(sentinel)); i++) await sleep(100);
  await check('★ 哨兵照常写出、回合是正常结束的', () => {
    const s = JSON.parse(readFileSync(sentinel, 'utf8'));
    return s.status === 'done' && s.result?.stop_reason === 'end_turn' && /fake answer/.test(s.result?.answer ?? '');
  });
  await check('常驻进程还活着', () => alive(daemonPid));

  console.log('\n[3] 第二个客户端连到同一个常驻进程；配置不同则各用各的');
  const b = track(new McpClient({ env: baseEnv, clientInfo: { name: 'second-client', version: '1' } }).start());
  await b.initialize();
  await check('同一配置：没有起第二个常驻进程', () => daemonPids().length === 1 && daemonPids()[0] === daemonPid, JSON.stringify(daemonPids()));
  const got = await b.callTool('dsh_get', { conversation_id: convId });
  await check('新连接看得到上一个客户端派的回合结果', () => got?.structuredContent?.run?.status === 'done', McpClient.text(got).slice(0, 200));
  const c = track(new McpClient({ env: { ...baseEnv, DSH_MCP_REVIEW: 'off' } }).start());
  await c.initialize();
  await check('配置不同（DSH_MCP_REVIEW=off）：另起一个常驻进程', () => new Set(daemonPids()).size === 2, JSON.stringify(daemonPids()));
  // 同配置的第三个客户端后连上来。客户端名以前是进程级的一个值，会被它顶掉，b 派的活就记到它名下了。
  const d = track(new McpClient({ env: baseEnv, clientInfo: { name: 'third-client', version: '1' } }).start());
  await d.initialize();
  const bStarted = await b.callTool('dsh_start', { cwd: root });
  const bConv = bStarted?.structuredContent?.conversation_id;
  // 假 ACP 的会话 id 固定是 fake-session，a、b 的会话写进同一个事件文件：按先后取各自那条 conv.open。
  const openClients = (conv) => {
    try {
      const lines = readFileSync(join(baseEnv.DSH_MCP_LIVE_DIR, conv, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
      return lines.map((l) => JSON.parse(l)).filter((e) => e.type === 'conv.open').map((e) => e.client ?? null);
    } catch {
      return [];
    }
  };
  await check('b 在常驻进程里建了会话', () => typeof bConv === 'string');
  await check('★ live 事件按连接记客户端：b 建会话记在 b 名下，后连上来的 d 顶不掉', () => openClients(bConv).at(-1) === 'second-client');
  await check('a 早先建会话记在 a 名下', () => openClients(convId)[0] === 'dsh-any-agent-test');

  console.log('\n[4] 认证');
  // 地址按 daemon.mjs 的命名规则从信息文件名推出来（测试进程自己的环境和客户端不同，不能重算）。
  // 最后一条"令牌对就能应答"是对照：保证前两条探的确实是这个常驻进程，而不是一个不存在的地址。
  const id = info.match(/^daemon-([0-9a-f]+)\.json$/)[1];
  const sock = join(stateDir, `daemon-${id}.sock`);
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-any-agent-${id}`
      : Buffer.byteLength(sock) > 100
        ? join(tmpdir(), `dsh-any-agent-${id}.sock`)
        : sock;
  await check('没带令牌：拿不到任何应答', async () => (await rawProbe(path, null)) === '');
  await check('令牌不对：拿不到任何应答', async () => (await rawProbe(path, JSON.stringify({ dsh_any_agent_auth: 'wrong' }))) === '');
  const token = readInfo(info).token;
  await check('令牌对：正常应答（对照）', async () => /dsh-any-agent/.test(await rawProbe(path, JSON.stringify({ dsh_any_agent_auth: token }))));

  console.log('\n[5] 空闲退出');
  for (const cl of clients.splice(0)) await cl.close();
  const pids = daemonPids();
  for (let i = 0; i < 100 && pids.some(alive); i++) await sleep(100);
  await check('没有客户端、没有回合：空闲后常驻进程退出', () => !pids.some(alive), JSON.stringify(pids.filter(alive)));
  await check('信息文件随之删除', () => infoFiles().length === 0, JSON.stringify(infoFiles()));
} catch (e) {
  failed += 1;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  for (const cl of clients) await cl.close().catch(() => {});
  for (const pid of daemonPids()) {
    try {
      process.kill(pid);
    } catch {}
  }
  await sleep(300);
  cleanupSuite({ clients: allClients, roots: [root] });
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n===== daemon: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
