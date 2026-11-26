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
 * 身份：同一个状态目录 + 同一版本 + 同一组 DSH_* / 语言 / 凭据（`*_KEY` / `*_TOKEN` / `*_SECRET`）/ 代理环境变量 → 同一个常驻进程。
 * 配置不同的两个客户端（例如一个 full access、一个 read-only）不会共用一个常驻进程；
 * 升级后的新版本也会起一个新的，旧的空闲后自己退出。
 *
 * 安全：常驻进程启动时生成随机令牌，写进状态目录里只有当前用户能读的信息文件；
 * 连接后第一行必须带对令牌，否则直接断开。本机别的用户、别的程序连上管道也派不了活。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DAEMON_IDLE_MS, STATE_FILE, TEAM_SETTINGS_FILE } from './config.mjs';
import { SERVER_VERSION } from './mcp.mjs';
import { serveMcp, startHub, warmDshDiscovery } from './boot.mjs';

const STATE_DIR = dirname(STATE_FILE);
const BIN = fileURLToPath(new URL('../bin/dsh-any-agent.mjs', import.meta.url));
/** 常驻进程日志（它的 stderr）的滚动阈值。 */
const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** 认证行最长多少字节（防止一个不发换行的连接把内存撑大）。 */
const MAX_AUTH_LINE = 4096;
const AUTH_ACK = 'OK\n';
const AUTH_TIMEOUT_MS = 3000;

/**
 * 影响服务行为的环境变量：这些不同就不能共用一个常驻进程。
 * 常驻进程的环境原样传给 DSH 子进程（acp.mjs），所以除了 DSH_* / 语言，还要算上 DSH 会用到的
 * 凭据与代理：名字以 `_KEY`、`_TOKEN` 或 `_SECRET` 结尾的（`DEEPSEEK_API_KEY`、profile 里 `apiKeyEnv` 指的变量）和
 * `*_PROXY`。不能整个环境都算：客户端环境里有每个会话都不同的变量（会话 id、管道名），
 * 那样每次重连都会另起一个常驻进程。钥匙是高熵随机串，截断的哈希反推不出来。
 */
const IDENTITY_ENV = (key) =>
  key.startsWith('DSH_') || key === 'LANG' || key === 'LC_ALL' || key === 'LC_MESSAGES' || /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PROXY)$/i.test(key);

/** `dsh-any-agent team on/off` 写的设置文件内容（读不到为空）。 */
function teamSettingsText() {
  try {
    return readFileSync(TEAM_SETTINGS_FILE, 'utf8');
  } catch {
    return '';
  }
}

function endpointPath(id) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-any-agent-${id}`;
  // Unix socket 路径有长度上限（macOS 104 字节）。状态目录太深时改放系统临时目录
  // （macOS 上是每个用户自己的 /var/folders/…）；有令牌把关，放哪里都派不了活。
  const sock = join(STATE_DIR, `daemon-${id}.sock`);
  return Buffer.byteLength(sock) > 100 ? join(tmpdir(), `dsh-any-agent-${id}.sock`) : sock;
}

/** 常驻进程的地址与信息文件。 */
export function daemonEndpoint(env = process.env) {
  const h = createHash('sha256');
  // Keep proxies that require the acknowledgement separate from older daemons.
  h.update(`auth-v2\0${SERVER_VERSION}\0${STATE_DIR}`);
  const identity = new Map();
  for (const name of Object.keys(env).sort()) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (IDENTITY_ENV(key) && !identity.has(key)) identity.set(key, env[name]);
  }
  for (const key of [...identity.keys()].sort()) h.update(`\0${key}=${identity.get(key)}`);
  // team 开关存在设置文件里，config.mjs 只在进程启动时读一次，常驻进程不会重读：
  // 文件内容也算身份，切换后重连的客户端会用一个按新设置启动的常驻进程（旧的空闲后自己退出）。
  h.update(`\0team-settings=${teamSettingsText()}`);
  const id = h.digest('hex').slice(0, 16);
  return {
    id,
    path: endpointPath(id),
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

/** 连接管道/socket 并完成令牌握手（MCP 会话和控制指令共用）。 */
function connectAuth(path, payload, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const socket = net.connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, timeoutMs);
    socket.once('connect', () => {
      socket.write(JSON.stringify(payload) + '\n');
    });
    let received = 0;
    const ack = Buffer.from(AUTH_ACK);
    const onData = (chunk) => {
      const count = Math.min(chunk.length, ack.length - received);
      if (!chunk.subarray(0, count).equals(ack.subarray(received, received + count))) {
        socket.destroy();
        return done(null);
      }
      received += count;
      if (received < ack.length) return;
      socket.pause();
      socket.off('data', onData);
      if (count < chunk.length) socket.unshift(chunk.subarray(count));
      done(socket);
    };
    socket.on('data', onData);
    socket.once('error', () => {
      socket.destroy();
      done(null);
    });
    socket.once('close', () => done(null));
  });
}

/** 试着连一次；连不上（没有常驻进程 / 信息文件过期）返回 null。 */
function tryConnect(ep, timeoutMs = 2000) {
  const info = readInfo(ep);
  if (!info?.token) return Promise.resolve(null);
  return connectAuth(ep.path, { dsh_any_agent_auth: info.token }, timeoutMs);
}

/** 以 detached 方式拉起常驻进程：它不属于客户端的进程树，客户端退出时不会被连带杀掉。 */
function spawnDaemon(ep) {
  mkdirSync(STATE_DIR, { recursive: true });
  // 日志每次启动都追加：超过 10 MB 先滚动成 .1（只留一份旧档，同 audit.mjs）。
  try {
    if (statSync(ep.logFile).size > LOG_MAX_BYTES) renameSync(ep.logFile, `${ep.logFile}.1`);
  } catch {
    /* 没有旧日志，或滚不动：照旧追加 */
  }
  /** @type {'ignore' | number} */
  let err = 'ignore';
  try {
    err = openSync(ep.logFile, 'a');
  } catch {
    /* 日志写不了就不要日志 */
  }
  try {
    const child = spawn(process.execPath, [BIN, '--daemon'], {
      detached: true,
      stdio: ['ignore', 'ignore', err],
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    return child;
  } finally {
    if (typeof err === 'number') closeSync(err);
  }
}

/**
 * 转发进程：连上（必要时拉起）常驻进程，把客户端的 stdio 原样接过去。
 * @returns {Promise<boolean>} false = 常驻进程起不来，调用方应退回普通 stdio 模式。
 */
export async function runProxy({ log, startTimeoutMs = 6_000, onFallback = null }) {
  const ep = daemonEndpoint();
  let socket = await tryConnect(ep);
  let reason = null;
  if (!socket) {
    let failed = false;
    try {
      const child = spawnDaemon(ep);
      child.once('error', (e) => { failed = true; reason = e.message; });
      // A clean exit can mean a concurrent launcher already owns the endpoint.
      child.once('exit', (code) => {
        if (code !== 0) {
          failed = true;
          reason ??= `daemon exited with code ${code}`;
        }
      });
    } catch (error) {
      reason = error.message;
      log.info(`[dsh-any-agent] Could not launch daemon: ${error.message}`);
      onFallback?.({ reason, endpointId: ep.id, logFile: ep.logFile });
      return false;
    }
    const startedAt = Date.now();
    const deadline = startedAt + startTimeoutMs;
    while (!socket && !failed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Date.now() - startedAt < 1000 ? 80 : 200));
      socket = await tryConnect(ep, 1000);
    }
    if (!socket) reason ??= `timed out after ${startTimeoutMs}ms`;
  }
  if (!socket) {
    log.info(`[dsh-any-agent] 常驻进程 ${ep.id} 起不来（日志见 ${ep.logFile}），退回普通模式`);
    onFallback?.({ reason, endpointId: ep.id, logFile: ep.logFile });
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

/** 等第一行（认证行），识别控制指令或把之后的字节原样交给 MCP 会话。 */
function authenticate(socket, token, onAuthed) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
  socket.once('close', () => clearTimeout(timer));
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > MAX_AUTH_LINE) socket.destroy();
      return;
    }
    socket.off('data', onData);
    clearTimeout(timer);
    if (nl > MAX_AUTH_LINE) return socket.destroy();
    let msg = null;
    try {
      msg = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    } catch {
      /* 不是 JSON 就当作没带令牌 */
    }
    if (!sameToken(msg?.dsh_any_agent_auth, token)) {
      socket.destroy();
      return;
    }
    if (typeof msg?.control === 'string') {
      onAuthed(null, msg.control);
      return;
    }
    const input = new PassThrough();
    socket.write(AUTH_ACK);
    const rest = buf.subarray(nl + 1);
    if (rest.length) input.write(rest);
    socket.pipe(input);
    onAuthed(input, null);
  };
  socket.on('data', onData);
}

/** 原子写信息文件（只有当前用户能读：令牌在里面）。 */
function writeInfo(ep, info) {
  const tmp = `${ep.infoFile}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, ep.infoFile);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
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
  let hub = null;
  let stopDaemon = null;

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    if (!hub) return socket.destroy();
    authenticate(socket, token, (input, control) => {
      if (control === 'shutdown') {
        socket.end(AUTH_ACK);
        setImmediate(() => stopDaemon?.('daemon stop'));
        return;
      }
      if (control) {
        socket.destroy();
        return;
      }
      connections += 1;
      lastActive = Date.now();
      socket.once('close', () => {
        connections -= 1;
        lastActive = Date.now();
      });
      serveMcp({ hub, log, input, output: socket });
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

  let stopping = false;
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    log.info(`[dsh-any-agent] 常驻进程退出：${reason}`);
    server.close();
    try {
      await hub.shutdown();
    } catch (e) {
      process.stderr.write(`[dsh-any-agent] 收尾异常: ${e.message}\n`);
      process.exitCode = 1;
    }
    // 只删自己的信息文件：期间如果另一个常驻进程接了班，别把它的删了。
    if (readInfo(ep)?.pid === process.pid) rmSync(ep.infoFile, { force: true });
    process.exit(process.exitCode ?? 0);
  }
  stopDaemon = (reason) => void stop(reason);

  try {
    // The listener owns this address. Discard any previous discovery file before startup.
    rmSync(ep.infoFile, { force: true });
    hub = await startHub(log);
    hub.runtime = { mode: 'daemon', endpointId: ep.id, pid: process.pid, logFile: ep.logFile };
    writeInfo(ep, { pid: process.pid, token, path: ep.path, version: SERVER_VERSION, started_at: new Date().toISOString() });
    lastActive = Date.now();
    warmDshDiscovery();
  } catch (error) {
    // Node unlinks its own Unix socket when it closes the listening server.
    server.close();
    if (hub) await hub.shutdown().catch(() => {});
    throw error;
  }
  log.info(`[dsh-any-agent] 常驻进程 ${ep.id} 已启动（pid ${process.pid}，注册表载入 ${hub.conversations.size} 个会话）`);
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 列出状态目录下所有登记过的常驻进程信息（附存活状态）。 */
export function listDaemons() {
  if (!existsSync(STATE_DIR)) return [];
  const out = [];
  for (const name of readdirSync(STATE_DIR).sort()) {
    const m = /^daemon-([0-9a-f]+)\.json$/.exec(name);
    if (!m) continue;
    const infoFile = join(STATE_DIR, name);
    try {
      const info = JSON.parse(readFileSync(infoFile, 'utf8'));
      out.push({
        id: m[1],
        pid: info.pid ?? null,
        alive: pidAlive(info.pid),
        version: info.version ?? null,
        started_at: info.started_at ?? null,
        infoFile,
      });
    } catch {
      /* 损坏的旧文件忽略 */
    }
  }
  return out;
}

async function requestShutdown(info, id, timeoutMs) {
  if (!info?.token) return false;
  const socket = await connectAuth(
    info.path || endpointPath(id),
    { dsh_any_agent_auth: info.token, control: 'shutdown' },
    Math.min(timeoutMs, 1500),
  );
  if (!socket) return false;
  socket.destroy();
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(info.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(info.pid);
}

/**
 * 停止所有存活的常驻进程并清理已死进程残留的信息文件。
 * 优先走带令牌的本机控制通道优雅关闭（Windows 上 SIGTERM 等价于强杀，会跳过 hub.shutdown）；
 * 超时或连不上时再回退到 SIGTERM。
 */
export async function stopDaemons({ timeoutMs = 3_000 } = {}) {
  const stopped = [];
  const cleaned = [];
  for (const d of listDaemons()) {
    if (d.alive) {
      let info = null;
      try {
        info = JSON.parse(readFileSync(d.infoFile, 'utf8'));
      } catch {}
      if (await requestShutdown(info, d.id, timeoutMs)) {
        stopped.push({ ...d, graceful: true });
        continue;
      }
      try {
        process.kill(d.pid, 'SIGTERM');
        stopped.push({ ...d, graceful: false });
        const deadline = Date.now() + 500;
        while (pidAlive(d.pid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!pidAlive(d.pid)) rmSync(d.infoFile, { force: true });
      } catch {}
    } else {
      try {
        rmSync(d.infoFile, { force: true });
        cleaned.push(d);
      } catch {}
    }
  }
  return { stopped, cleaned };
}
