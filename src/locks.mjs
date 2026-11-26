/**
 * 会话写锁的"持有者登记" + 安全抢占。
 *
 * ## 为什么需要这个模块
 *
 * DSH 的写锁 `SessionWriteLease` 是**跨进程的 Windows 命名内核信号量**
 * （`Local\dsh-session-lock-<sha256>`），语义是"持有者活着就永不过期"。
 * **没有 API 能从活的持有者手里把锁夺走** —— 所以"抢锁"唯一的手段是
 * **杀掉持有者进程**。既然要杀，就必须先知道那是谁，否则可能把用户自己的
 * DSH GUI（连同他正在看的对话）一起杀掉。
 *
 * 于是我们只登记**自己拉起的** DSH 子进程：一个会话一个文件
 *   `<状态文件同目录>/locks/<conversation_id>.json`
 *     { conversation_id, mcp_pid, mcp_token, child_pid, child_started_at, cwd, spawned_at, heartbeat_at }
 *
 * ## 三类持有者，三种处置
 *
 * | 分类 | 判据 | 处置 |
 * |---|---|---|
 * | `none` | 没有登记文件 | 直接尝试；失败则报"未知持有者（多半是你的 DSH GUI）"，**绝不杀** |
 * | `self` | mcp_pid/token 都是自己 | 正常路径，无需抢占 |
 * | `stale-mcp` | 登记在，但 mcp_pid 已死**或**心跳过期 | 核实子进程身份后可接管 |
 * | `live-mcp` | 登记在且心跳新鲜 | 默认拒绝（另一个宿主可能在用），`force` 才杀 |
 *
 * `mcp_token` 是每个 MCP 进程启动时生成的随机串，用来防 PID 复用误判；
 * `heartbeat_at` 由 reaper 周期刷新，保证"活着但卡死"的实例最终会被判为过期。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { processListExecutable, windowsSystemExecutable } from './host-executable.mjs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPidAlive, validPid } from './procstat.mjs';
export { isPidAlive } from './procstat.mjs';
import { STATE_FILE, REAP_INTERVAL_MS, numEnv } from './config.mjs';
import { L } from './lang.mjs';

/** 每个 MCP 进程一个身份串（防 PID 复用误判）。 */
export const MCP_TOKEN = randomUUID();

/**
 * 心跳超过这个时长就认为那个 MCP 实例已经死了或卡死了。
 *
 * ★ 守卫：**下限 30 秒**。设成 0/负数（有人会以为那是"关闭判定"）会让所有持锁登记
 *   立刻显示为"过期"，于是别的实例会**合法地抢占并杀掉我们的子进程** ✗ —— 这是
 *   最不能靠"用户猜对语义"的一个开关，所以把奇怪输入统一压到安全侧。
 */
const rawStale = numEnv('DSH_MCP_LOCK_STALE_MS', 3 * REAP_INTERVAL_MS);
export const STALE_MS = Number.isFinite(rawStale) && rawStale >= 30_000 ? rawStale : Math.max(30_000, 3 * REAP_INTERVAL_MS);

export const LOCKS_DIR = process.env.DSH_MCP_LOCKS_DIR ?? join(dirname(STATE_FILE), 'locks');

/** 某个会话的持有者登记文件路径。 */
export const markerPath = (conversationId) => join(LOCKS_DIR, `${conversationId}.json`);

const validStartTime = (time) => Number.isSafeInteger(time) && time > 0 && time <= 8.64e15;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写（tmp + rename），避免读到半截。**写失败绝不影响主流程**（登记只是辅助信息）。 */
function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    // 磁盘满 / 目录被占 / 权限问题都不该让 MCP 服务出问题
    return false;
  }
}

/** 登记"我这个 MCP 进程为这个会话拉起了哪个 DSH 子进程"。 */
export function writeMarker(conversationId, { childPid, childStartedAt, cwd }) {
  const p = markerPath(conversationId);
  const prev = readJson(p);
  // ★ 绝不覆盖"别人**还活着**的"登记。
  //   理由：这次 spawn 十有八九正要因撞锁而失败，失败后我们还要靠这条记录判断
  //   "锁在谁手上"。一旦被自己的登记盖掉、又在失败路径里删掉，线索就没了 ——
  //   于是抢占逻辑会把持有者误判成 none（真实 bug：两个实例互相抓瞎）。
  if (prev && prev.mcp_token !== MCP_TOKEN) {
    const holderLive =
      isPidAlive(prev.child_pid) &&
      isPidAlive(prev.mcp_pid) &&
      typeof prev.heartbeat_at === 'number' &&
      Date.now() - prev.heartbeat_at <= STALE_MS;
    if (holderLive) return false;
  }
  const now = Date.now();
  writeJson(p, {
    conversation_id: conversationId,
    mcp_pid: process.pid,
    mcp_token: MCP_TOKEN,
    child_pid: childPid ?? null,
    child_started_at: validStartTime(childStartedAt) ? childStartedAt : null,
    cwd: cwd ?? null,
    // 保留旧登记时间字段供旧客户端读取，接管只信 OS 返回的 child_started_at。
    spawned_at:
      prev && prev.child_pid === childPid && Number.isFinite(prev.spawned_at)
        ? prev.spawned_at
        : now,
    heartbeat_at: now,
  });
  return true;
}

/** 刷新心跳（reaper 周期调用）。 */
export function heartbeat(conversationId) {
  const p = markerPath(conversationId);
  const m = readJson(p);
  if (!m) return;
  // 只刷新自己的登记：别人的登记不该由我们续命，否则过期判定就失效了
  if (m.mcp_token !== MCP_TOKEN) return;
  m.heartbeat_at = Date.now();
  writeJson(p, m);
}

/** 删掉登记（进程收尾 / 会话关闭时）。只删自己的。 */
export function removeMarker(conversationId, { force = false } = {}) {
  const p = markerPath(conversationId);
  const m = readJson(p);
  if (m && !force && m.mcp_token !== MCP_TOKEN) return false;
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readMarker(conversationId) {
  return readJson(markerPath(conversationId));
}

/**
 * 判定当前持有者属于哪一类。
 * @returns {{kind:'none'|'self'|'stale-mcp'|'live-mcp', marker:object|null, childAlive:boolean, mcpAlive:boolean, ageMs:number|null, reason:string}}
 */
export function classifyHolder(conversationId, { knownChildPid = null } = {}) {
  const marker = readMarker(conversationId);
  const knownAlive = isPidAlive(knownChildPid);
  if (!marker) {
    // ★ 兜底归因：这个会话本进程曾经拉起过子进程（knownChildPid），它可能还活着握着锁，
    //   而登记已经随回收被删掉了。若不认它，就只能判成 none → 连 dsh_takeover 都拒绝，
    //   会话卡死到那个残留进程自己退出为止（而租约**没有过期机制**）。
    //   "异步派活 → 等 task → 回头再进" 正好会撞上这个窗口。
    if (knownAlive) {
      return {
        kind: 'stale-mcp',
        marker: null,
        childAlive: true,
        mcpAlive: true,
        ageMs: 0,
        known_child_pid: knownChildPid,
        reason: L(
          `本进程**上一代**子进程（PID ${knownChildPid}）还活着并握着锁，但它的登记已随回收被删除`,
          `this process's **previous** child (PID ${knownChildPid}) is still alive and holding the lock, but its registration was deleted when it was reaped`,
        ),
      };
    }
    return {
      kind: 'none',
      marker: null,
      childAlive: false,
      mcpAlive: false,
      ageMs: null,
      reason: L(
        '没有登记文件：持有者不是本 MCP 拉起的进程（多半是你自己的 DSH GUI）',
        'no registration file: the holder is not a process this MCP started (most likely your own DSH GUI)',
      ),
    };
  }
  const childAlive = isPidAlive(marker.child_pid);
  const mcpAlive = isPidAlive(marker.mcp_pid);
  const ageMs = typeof marker.heartbeat_at === 'number' ? Date.now() - marker.heartbeat_at : null;
  const isSelf = marker.mcp_pid === process.pid && marker.mcp_token === MCP_TOKEN;

  if (!childAlive) {
    if (knownAlive) {
      return {
        kind: 'stale-mcp',
        marker,
        childAlive: true,
        mcpAlive,
        ageMs,
        known_child_pid: knownChildPid,
        reason: L(
          `登记里的子进程已退出，但**本进程上一代子进程**（PID ${knownChildPid}）还活着并握着锁`,
          `the registered child has exited, but **this process's previous child** (PID ${knownChildPid}) is still alive and holding the lock`,
        ),
      };
    }
    return {
      kind: 'none', marker, childAlive, mcpAlive, ageMs,
      reason: L('登记还在，但它记录的 DSH 子进程已经退出（锁已释放）', 'the registration is still there, but the DSH child it names has exited (the lock is free)'),
    };
  }
  if (isSelf) {
    return { kind: 'self', marker, childAlive, mcpAlive, ageMs, reason: L('是本进程自己拉起的子进程', 'a child this process started itself') };
  }
  const stale = !mcpAlive || (ageMs !== null && ageMs > STALE_MS);
  if (stale) {
    return {
      kind: 'stale-mcp',
      marker,
      childAlive,
      mcpAlive,
      ageMs,
      reason: mcpAlive
        ? L(
            `持有者 MCP 进程（PID ${marker.mcp_pid}）还在，但心跳已过期 ${Math.round(ageMs / 1000)}s（判定为卡死）`,
            `the holder MCP process (PID ${marker.mcp_pid}) is still there, but its heartbeat expired ${Math.round(ageMs / 1000)}s ago (treated as wedged)`,
          )
        : L(
            `持有者 MCP 进程（PID ${marker.mcp_pid}）已经退出，留下孤儿子进程 PID ${marker.child_pid}`,
            `the holder MCP process (PID ${marker.mcp_pid}) has exited and left the orphan child PID ${marker.child_pid}`,
          ),
    };
  }
  return {
    kind: 'live-mcp',
    marker,
    childAlive,
    mcpAlive,
    ageMs,
    reason: L(
      `另一个**活着**的 dsh-any-agent 实例（PID ${marker.mcp_pid}）正持有它，心跳 ${Math.round(ageMs / 1000)}s 前`,
      `another **live** dsh-any-agent instance (PID ${marker.mcp_pid}) holds it; last heartbeat ${Math.round(ageMs / 1000)}s ago`,
    ),
  };
}

/**
 * 杀掉一个 DSH 子进程。**只允许对 classification 判定为 `stale-mcp` / `live-mcp(force)`
 * 的、由本 MCP 登记过的进程调用** —— 调用方负责先做分类。
 */
export function killHolderChild(pid, { expectedStartedAt } = {}) {
  if (pid === process.pid || !isPidAlive(pid)) {
    return { killed: false, reason: L('目标进程不可用', 'the target process is unavailable') };
  }
  const unverified = {
    killed: false,
    reason: L('无法核实持锁进程的启动时间。请在原宿主释放或关闭会话后重试。',
      'Could not verify when the lock holder started. Release or close the session in its original host and retry.'),
  };
  const mismatch = {
    killed: false,
    reason: L(`PID ${pid} 的启动时间与登记不符，拒绝接管。`, `PID ${pid} started at a different time than registered. Takeover refused.`),
  };
  if (!validStartTime(expectedStartedAt)) return unverified;
  try {
    if (process.platform === 'win32') {
      const powershell = windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!powershell) return unverified;
      // Accessing Handle pins the process object. StartTime and Kill use that same handle.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$target = [System.Diagnostics.Process]::GetProcessById(${pid})`,
        'try {',
        '  $null = $target.Handle',
        "  $started = $target.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)",
        `  if ($started -ne '${new Date(expectedStartedAt).toISOString()}') { exit 2 }`,
        '  $target.Kill()',
        '} finally { $target.Dispose() }',
      ].join('\n');
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 3000, stdio: 'ignore', windowsHide: true,
      });
      if (result.status === 2) return mismatch;
      if (result.status !== 0) return unverified;
    } else {
      const actual = processStartTime(pid);
      if (actual === null) return unverified;
      if (actual !== expectedStartedAt) return mismatch;
      process.kill(pid, 'SIGKILL');
    }
  } catch (e) {
    return { killed: false, reason: L(`杀不掉: ${e.message}`, `could not kill it: ${e.message}`) };
  }
  return { killed: true, reason: L(`已向 PID ${pid} 发送 SIGKILL`, `sent SIGKILL to PID ${pid}`) };
}

/**
 * Windows 用 Get-Process.StartTime，POSIX 用固定语言和时区的 ps -o lstart=。
 */
function startTimeQuery(pid) {
  if (!validPid(pid)) return null;
  const win = process.platform === 'win32';
  const command = win
    ? windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe')
    : processListExecutable();
  if (!command) return null;
  const args = win
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]
    : ['-o', 'lstart=', '-p', String(pid)];
  const env = win ? process.env : { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  return { command, args, options: { env, encoding: 'utf8', timeout: 3000, windowsHide: true } };
}

function parseStartTime(stdout) {
  const text = stdout.trim();
  const startedAt = Date.parse(process.platform === 'win32' ? text : `${text} UTC`);
  return validStartTime(startedAt) ? startedAt : null;
}

/** 毫秒时间戳，系统无法核实时返回 null。 */
export function processStartTime(pid) {
  const query = startTimeQuery(pid);
  if (!query) return null;
  try {
    const r = spawnSync(query.command, query.args, query.options);
    return r.status === 0 ? parseStartTime(r.stdout) : null;
  } catch {
    return null;
  }
}

/** 新建 ACP 进程时在后台读一次启动时间，握手可以并行进行。 */
export async function readProcessStartTime(pid) {
  const query = startTimeQuery(pid);
  if (!query) return null;
  try {
    return await new Promise((resolve) => {
      execFile(query.command, query.args, query.options, (err, stdout) => resolve(err ? null : parseStartTime(stdout)));
    });
  } catch {
    return null;
  }
}

/**
 * 启动清理：删掉"MCP 已死 + 子进程也死了"的登记文件。
 * 注意**不删**那些子进程还活着的登记 —— 那正是后面抢占要用的线索。
 */
export function pruneDeadMarkers() {
  if (!existsSync(LOCKS_DIR)) return { removed: 0, orphans: 0 };
  let removed = 0;
  let orphans = 0;
  for (const f of readdirSync(LOCKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const p = join(LOCKS_DIR, f);
    const m = readJson(p);
    if (!m) {
      rmSync(p, { force: true });
      removed++;
      continue;
    }
    const childAlive = isPidAlive(m.child_pid);
    const mcpAlive = isPidAlive(m.mcp_pid);
    const age = typeof m.heartbeat_at === 'number' ? Date.now() - m.heartbeat_at : Infinity;
    const stale = !mcpAlive || age > STALE_MS;
    if (!childAlive && stale) {
      rmSync(p, { force: true });
      removed++;
    } else if (childAlive && stale) {
      orphans++;
    }
  }
  return { removed, orphans };
}

/** 列出所有"孤儿持有者"（MCP 已死/卡死，但子进程还活着握着锁）—— 可安全抢占的目标。 */
export function listOrphans() {
  if (!existsSync(LOCKS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(LOCKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const m = readJson(join(LOCKS_DIR, f));
    if (!m) continue;
    if (!isPidAlive(m.child_pid)) continue;
    const mcpAlive = isPidAlive(m.mcp_pid);
    const age = typeof m.heartbeat_at === 'number' ? Date.now() - m.heartbeat_at : Infinity;
    if (!mcpAlive || age > STALE_MS) {
      out.push({ conversation_id: m.conversation_id, child_pid: m.child_pid, mcp_pid: m.mcp_pid, age_ms: age === Infinity ? null : age });
    }
  }
  return out;
}

/** 判断一个错误是不是"写锁被占用"。DSH 的原文 + ACP 包装后的形态都要认。 */
export function isLeaseError(message) {
  const s = String(message ?? '');
  return (
    /already owned/i.test(s) ||
    /active write handle/i.test(s) ||
    /writer-held/i.test(s) ||
    /SessionAlreadyOwned/.test(s) ||
    /已被占用/.test(s)
  );
}

/** 把锁错误翻译成调用方能照做的中文说明。 */
export function describeLeaseConflict(conversationId, holder) {
  const lines = [
    L(
      `会话 ${conversationId} 的写锁被别的 DSH 进程占用，本服务无法接管。`,
      `The write lock of conversation ${conversationId} is held by another DSH process, so this server cannot take the conversation.`,
    ),
    L(`判定：${holder.reason}`, `Why: ${holder.reason}`),
  ];
  if (holder.kind === 'stale-mcp') {
    lines.push(L(
      '→ 调用 dsh_takeover 可尝试接管（无需 force）。服务会先核实进程身份。',
      '→ Try dsh_takeover (no force needed). The server verifies the holder’s process identity first.',
    ));
  } else if (holder.kind === 'live-mcp') {
    lines.push(L(
      '→ 另一个活着的 dsh-any-agent 实例正在用它（可能是你另一个宿主窗口）。',
      '→ Another live dsh-any-agent instance is using it (perhaps another of your host windows).',
    ));
    lines.push(L(
      '  建议：在那边用 dsh_release 交还；确实要夺过来再调 dsh_takeover(force=true)。',
      '  Suggested: dsh_release on that side; call dsh_takeover(force=true) only if you really must take it.',
    ));
  } else {
    lines.push(L(
      '→ 持有者不是本服务拉起的进程，**多半是你自己的 DSH GUI 正开着这个会话**。',
      '→ The holder is not a process this server started; **most likely your own DSH GUI has this conversation open**.',
    ));
    lines.push(L(
      '  本服务**不会**去杀它（那会连你的界面和正在看的对话一起杀掉）。',
      '  This server will **not** kill it (that would take your UI and the conversation you are reading down with it).',
    ));
    lines.push(L(
      '  注意：DSH GUI 点开会话后，**切走或归档也不会释放写锁**。',
      '  Note: once opened in DSH GUI, **switching away or archiving does not release the write lock**.',
    ));
    lines.push(L(
      '  恢复：重启 DSH 桌面端 / dsh web 即可归还写锁（历史与产物无损）。',
      '  To recover: restart the DSH desktop app / dsh web to release the lock (history and files stay intact).',
    ));
    lines.push(L(
      '  预防：查看实时进度请用 dsh-any-agent watch 或 dsh-any-agent dashboard --open（只读、不碰写锁）。',
      '  To prevent this: watch progress with dsh-any-agent watch or dsh-any-agent dashboard --open (read-only, never takes the lock).',
    ));
  }
  return lines.join('\n');
}
