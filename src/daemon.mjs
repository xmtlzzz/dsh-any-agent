/**
 * 常驻进程模式（`DSH_MCP_DAEMON=1`，默认关）。
 *
 * 为什么需要：MCP 客户端按规范关闭服务的顺序是"关 stdin → 等一会儿 → 强杀"，而且在 Windows 上
 * 客户端用作业对象（job object）拉起服务，客户端一退出，服务连同它拉起的 DSH 子进程一起被杀
 * （实测：Node/libuv 客户端，崩溃与规范关闭两种情况都是）。于是"关掉客户端 = 正在跑的回合断掉、
 * 哨兵不落地"。只有以 detached 方式拉起的进程能活下来。
 *
 * 结构：
 *   客户端 ──stdio──▶ 转发进程（客户端拉起的那个，很薄） ──本机管道/socket──▶ 常驻进程（detached）
 *                                                                          └─ Hub、会话、DSH 进程、回合
 *   - 常驻进程每个连接跑一个 MCP 会话（各自的 roots / 能力），共用同一个 Hub；
 *   - 转发进程只搬字节：客户端关掉它，常驻进程里的回合照常跑完、照常写哨兵；
 *   - 没有客户端连着、也没有回合在跑，空闲 DSH_MCP_DAEMON_IDLE_MS（默认 10 分钟）后自己退出。
 *
 * 身份：同一个状态目录 + 同一版本 + 同一组 DSH_* / 语言环境变量 → 同一个常驻进程。
 * 配置不同的两个客户端（例如一个 full access、一个 read-only）不会共用一个常驻进程；
 * 升级后的新版本也会起一个新的，旧的空闲后自己退出。
 *
 * 安全：常驻进程启动时生成随机令牌，写进状态目录里只有当前用户能读的信息文件；
 * 连接后第一行必须带对令牌，否则直接断开。本机别的用户、别的程序连上管道也派不了活。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DAEMON_IDLE_MS, STATE_FILE } from './config.mjs';
import { SERVER_VERSION } from './mcp.mjs';
import { serveMcp, startHub } from './boot.mjs';

const STATE_DIR = dirname(STATE_FILE);
const BIN = fileURLToPath(new URL('../bin/dsh-any-agent.mjs', import.meta.url));
/** 认证行最长多少字节（防止一个不发换行的连接把内存撑大）。 */
const MAX_AUTH_LINE = 4096;

/** 影响服务行为的环境变量：这些不同就不能共用一个常驻进程。 */
const IDENTITY_ENV = (key) => key.startsWith('DSH_') || key === 'LANG' || key === 'LC_ALL' || key === 'LC_MESSAGES';

/** 常驻进程的地址与信息文件。 */
export function daemonEndpoint(env = process.env) {
  const h = createHash('sha256');
  h.update(`${SERVER_VERSION}\0${STATE_DIR}`);
  for (const key of Object.keys(env).filter(IDENTITY_ENV).sort()) h.update(`\0${key}=${env[key]}`);
  const id = h.digest('hex').slice(0, 16);
  // Unix socket 路径有长度上限（macOS 104 字节）。状态目录太深时改放系统临时目录
  // （macOS 上是每个用户自己的 /var/folders/…）；有令牌把关，放哪里都派不了活。
  let sock = join(STATE_DIR, `daemon-${id}.sock`);
  if (Buffer.byteLength(sock) > 100) sock = join(tmpdir(), `dsh-any-agent-${id}.sock`);
  return {
    id,
    path: process.platform === 'win32' ? `\\\\.\\pipe\\dsh-any-agent-${id}` : sock,
    infoFile: join(STATE_DIR, `daemon-${id}.json`),
    logFile: join(STATE_DIR, `daemon-${id}.log`),
  };
}

function readInfo(ep) {
  try {
    return JSON.parse(readFileSync(ep.infoFile, 'utf8'));
  } catch {
    return null;
  }
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** 试着连一次；连不上（没有常驻进程 / 信息文件过期）返回 null。 */
function tryConnect(ep, timeoutMs = 2000) {
  const info = readInfo(ep);
  if (!info?.token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.connect(ep.path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.write(JSON.stringify({ dsh_any_agent_auth: info.token }) + '\n');
      resolve(socket);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** 以 detached 方式拉起常驻进程：它不属于客户端的进程树，客户端退出时不会被连带杀掉。 */
function spawnDaemon(ep) {
  mkdirSync(STATE_DIR, { recursive: true });
  let err = 'ignore';
  try {
    err = openSync(ep.logFile, 'a');
  } catch {
    /* 日志写不了就不要日志 */
  }
  const child = spawn(process.execPath, [BIN, '--daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', err],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

/**
 * 转发进程：连上（必要时拉起）常驻进程，把客户端的 stdio 原样接过去。
 * @returns {Promise<boolean>} false = 常驻进程起不来，调用方应退回普通 stdio 模式。
 */
export async function runProxy({ log, startTimeoutMs = 15_000 }) {
  const ep = daemonEndpoint();
  let socket = await tryConnect(ep);
  if (!socket) {
    spawnDaemon(ep);
    const deadline = Date.now() + startTimeoutMs;
    while (!socket && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      socket = await tryConnect(ep, 1000);
    }
  }
  if (!socket) {
    log.info(`[dsh-any-agent] 常驻进程 ${ep.id} 起不来（日志见 ${ep.logFile}），退回普通模式`);
    return false;
  }
  log.info(`[dsh-any-agent] 已连上常驻进程 ${ep.id}`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  // 客户端关掉 stdin：只断开自己这条连接，常驻进程里的回合不受影响。
  process.stdin.on('end', () => socket.end());
  socket.on('close', () => process.exit(0));
  socket.on('error', (e) => log.info(`[dsh-any-agent] 与常驻进程的连接出错: ${e.message}`));
  return true;
}

/** 等第一行（认证行），之后的字节原样交给 MCP 会话。 */
function authenticate(socket, token, onAuthed) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > MAX_AUTH_LINE) socket.destroy();
      return;
    }
    socket.off('data', onData);
    let given = null;
    try {
      given = JSON.parse(buf.subarray(0, nl).toString('utf8'))?.dsh_any_agent_auth;
    } catch {
      /* 不是 JSON 就当作没带令牌 */
    }
    if (!sameToken(given, token)) {
      socket.destroy();
      return;
    }
    const input = new PassThrough();
    const rest = buf.subarray(nl + 1);
    if (rest.length) input.write(rest);
    socket.pipe(input);
    onAuthed(input);
  };
  socket.on('data', onData);
}

/** 原子写信息文件（只有当前用户能读：令牌在里面）。 */
function writeInfo(ep, info) {
  const tmp = `${ep.infoFile}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, ep.infoFile);
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * 常驻进程主体（`dsh-any-agent --daemon`，由转发进程以 detached 方式拉起）。
 * 已经有同一身份的常驻进程在跑时直接退出。
 */
export async function runDaemon({ log }) {
  const ep = daemonEndpoint();
  mkdirSync(STATE_DIR, { recursive: true });
  const token = randomBytes(24).toString('hex');
  let connections = 0;
  let lastActive = Date.now();
  // 先占住地址再起 Hub：同一身份的常驻进程已经在跑时，不该再去碰注册表、起回收器。
  // 连接可能在 Hub 起好之前到达：认证后等 hubReady 再接 MCP 会话（期间的字节在 PassThrough 里排队）。
  let hub = null;
  let resolveHub;
  const hubReady = new Promise((r) => (resolveHub = r));

  const server = net.createServer((socket) => {
    connections += 1;
    lastActive = Date.now();
    socket.on('error', () => {});
    socket.on('close', () => {
      connections -= 1;
      lastActive = Date.now();
    });
    authenticate(socket, token, async (input) => {
      const h = await hubReady;
      serveMcp({ hub: h, log, input, output: socket });
    });
  });

  try {
    await listen(server, ep.path);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    // POSIX 上可能是上一个常驻进程崩溃留下的 socket 文件：连不上就删掉重来；连得上说明它还在。
    if (process.platform !== 'win32' && existsSync(ep.path)) {
      const alive = await new Promise((r) => {
        const s = net.connect(ep.path);
        s.once('connect', () => (s.destroy(), r(true)));
        s.once('error', () => r(false));
      });
      if (!alive) {
        rmSync(ep.path, { force: true });
        await listen(server, ep.path);
      } else return;
    } else return; // 同一身份的常驻进程已经在跑（两个客户端同时拉起时会撞上）
  }
  writeInfo(ep, { pid: process.pid, token, version: SERVER_VERSION, started_at: new Date().toISOString() });
  hub = await startHub(log);
  resolveHub(hub);
  log.info(`[dsh-any-agent] 常驻进程 ${ep.id} 已启动（pid ${process.pid}，注册表载入 ${hub.conversations.size} 个会话）`);

  let stopping = false;
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    log.info(`[dsh-any-agent] 常驻进程退出：${reason}`);
    server.close();
    try {
      await hub.shutdown();
    } catch (e) {
      log.info(`[dsh-any-agent] 收尾异常: ${e.message}`);
    }
    // 只删自己的信息文件：期间如果另一个常驻进程接了班，别把它的删了。
    if (readInfo(ep)?.pid === process.pid) rmSync(ep.infoFile, { force: true });
    process.exit(0);
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  if (DAEMON_IDLE_MS > 0) {
    const busy = () => [...hub.conversations.values()].some((c) => c.busy || c.queue.length > 0);
    const timer = setInterval(() => {
      if (connections > 0 || busy()) {
        lastActive = Date.now();
        return;
      }
      if (Date.now() - lastActive >= DAEMON_IDLE_MS) stop(`空闲 ${Math.round(DAEMON_IDLE_MS / 1000)}s`);
    }, Math.max(200, Math.min(30_000, Math.floor(DAEMON_IDLE_MS / 3))));
    timer.unref?.();
  }
}
