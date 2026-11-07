/**
 * 把 MCP 创建的会话登记进 DSH 的工作区注册表。
 *
 * 为什么需要：DSH 的 GUI 是**按工作区分组**展示会话的，而 `workspace.json` 里只记
 * 已经被登记过的工作区。不登记的话，MCP 建出来的会话在磁盘上存在、却**在你的 DSH
 * GUI 里根本看不到**。
 *
 * 三个能力：
 *   registerWorkspace()      —— 建会话时登记单个工作区（默认跳过系统临时目录）
 *   backfillWorkspaces()     —— 回填：扫描磁盘上所有会话头，按 header.cwd 归组补登记
 *                                （用于修复本功能上线前创建的历史会话）
 *   pruneTempWorkspaces()    —— 清理：把临时目录那些工作区条目从注册表移除
 *
 * 风险说明：`workspace.json` 是单文件共享存储（原子写、后写覆盖）。本模块只在建会话
 * 或手动执行回填时做一次读-改-写，窗口很小；但仍与 GUI 存在理论上的覆盖可能。
 */

import { copyFileSync, createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { DSH_HOME, PKG_ROOT, REGISTER_WORKSPACE } from './config.mjs';

const WORKSPACE_FILE = join(DSH_HOME, 'storages', 'workspace.json');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
/**
 * DSH 的会话投影缓存：每个会话一个 `<id>.json`（标题/用量/cwd 等折叠结果）。
 * ★ 删会话目录**不会**连带删它 —— 实测测试跑多了这里会攒出几百个孤儿文件
 *   （磁盘上的会话早没了，缓存还在），所以清理会话必须一并删它。
 */
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
/** forget 墓碑目录（存 id+时间，不含内容）；清掉测试会话时一并清掉其墓碑。 */
const FORGOTTEN_DIR = process.env.DSH_MCP_FORGOTTEN_DIR ?? join(DSH_HOME, '.dsh-any-agent-forgotten');

/** 路径比较用：Windows 下大小写不敏感，且忽略结尾分隔符。 */
const normPath = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * DSH 在 create 时把 `path` 存成 `fs.realpath` 的规范形式（见 workspace spec 注释），
 * 所以我们也必须存 realpath，否则同一个目录可能出现两条不等价的记录。
 */
export function canonicalPath(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return p;
  }
}

/** `child` 是否真的在 `parent` 里面（按路径分段，不能用字符串前缀）。 */
function isInside(parent, child) {
  try {
    const rel = relative(parent, child);
    if (!rel) return true;
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * 路径是否位于系统临时目录下（这类"工作区"不该出现在 GUI 里）。
 *
 * ★ 必须按路径分段判断，不能用 `startsWith(tmpdir())`：那样
 *   `/tmpfoo`、`%LOCALAPPDATA%\Temporary\proj` 都会被当成临时目录，
 *   而清理逻辑会据此**递归删除真实会话目录**（真实数据丢失级 bug）。
 */
export function isTempPath(p) {
  try {
    return Boolean(p) && isInside(tmpdir(), p);
  } catch {
    return false;
  }
}

/**
 * 是否是本仓库测试自己造的临时工作区。
 *
 * 只认系统临时目录下、第一段目录名以 `dsh-any-agent-` 开头的路径
 * （测试统一用 `mkdtempSync(join(tmpdir(), 'dsh-any-agent-...'))`）。
 * 这不是"所有临时目录"——用户完全可能把真实项目放在 %TEMP% 的同级目录里。
 */
export function isTestTempPath(p) {
  try {
    if (!p || !isTempPath(p)) return false;
    const rel = relative(tmpdir(), p);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
    const first = rel.split(/[\\/]/).filter(Boolean)[0] ?? '';
    return /^dsh-any-agent-/.test(first);
  } catch {
    return false;
  }
}

/**
 * 是否是"测试用桌面目录"。
 *
 * 覆盖两类命名（都是本仓库测试自己造的，绝不会碰到真实项目）：
 *   - `Desktop\dsh-any-agent-test-A|B`（验收/工作区效果测试）
 *   - `Desktop\dsh-conc-A|B|C`（并发测试）
 */
export function isTestDesktopPath(p) {
  return /[\\/]Desktop[\\/](dsh-any-agent-test-[AB]|dsh-conc-[ABC])([\\/]|$)/i.test(String(p ?? ''));
}

/**
 * 边界测试（boundary.mjs）为了验证"非临时目录会被登记"，在**本仓库自己的** `.state/` 下
 * 造一个 `ws-probe-<毫秒时间戳>` 目录。它不在系统临时目录里，所以单独认这一种。
 *
 * ★ 绑定 PKG_ROOT（当前进程跑的这份代码所在的仓库/worktree）而不是任意 `.state`：
 *   并行跑测试的别的 worktree 有它们自己的 `.state/ws-probe-*`，那是人家还活着的会话，
 *   这里的清理绝不能动。
 */
export function isTestScratchPath(p) {
  try {
    if (!p || !isAbsolute(String(p))) return false;
    const rel = relative(join(PKG_ROOT, '.state'), String(p));
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
    return /^ws-probe-\d+$/.test(rel.split(/[\\/]/).filter(Boolean)[0] ?? '');
  } catch {
    return false;
  }
}

/** 会话清理只认这个：桌面 `dsh-any-agent-test-A|B`（注意不含 `dsh-conc-*`，那只用于清工作区登记）。 */
const DESKTOP_TEST_SESSION_RE = /[\\/]Desktop[\\/]dsh-any-agent-test-[AB]([\\/]|$)/i;

/**
 * ★ 清理会话的**唯一护栏**：只有 cwd 满足下面三种之一的会话才允许被删，
 *   不论是被"扫描命中"、被 `ids` 点名还是被 `roots` 圈中 —— 点名也绕不过。
 *     1) 当前进程 `os.tmpdir()/dsh-any-agent-*`（各测试套件自己的临时根）
 *     2) 桌面 `dsh-any-agent-test-A|B`（验收/工作区效果测试）
 *     3) 本仓库 `.state/ws-probe-*`（边界测试的登记探针）
 *   别的 agent / 别的 worktree 把 TMP 指到 `C:\dsh-agent-tmp\...` 时，它们的会话对本进程
 *   就**不是**测试目录 —— 这正是想要的：谁造的谁清。
 */
export function isTestSessionCwd(p) {
  const s = String(p ?? '');
  return isTestTempPath(s) || DESKTOP_TEST_SESSION_RE.test(s) || isTestScratchPath(s);
}

/**
 * 是否该登记这个工作区。
 * 模式（DSH_MCP_REGISTER_WORKSPACE）：project（默认，跳过系统临时目录）| all | 0（关闭）
 */
export function shouldRegister(cwd) {
  if (REGISTER_WORKSPACE === false) return false;
  if (REGISTER_WORKSPACE === 'all') return true;
  return !isTempPath(cwd);
}

function emptyDoc() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: null,
    },
    tables: { workspaces: {} },
  };
}

/**
 * 读取工作区注册表。
 *
 * ★ 解析失败必须 **fail-closed**：以前会静默回落到空结构，下一次 register/prune
 *   就会把 GUI 的整个工作区列表覆盖掉（不可恢复）。现在抛错，并且绝不写盘；
 *   调用方（register/backfill/prune）各自把错误返回给上层。
 */
function readDoc() {
  if (!existsSync(WORKSPACE_FILE)) return emptyDoc();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`workspace.json 无法解析，已保持原样不写入: ${WORKSPACE_FILE}（${e.message}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`workspace.json 结构异常（不是对象），已保持原样不写入: ${WORKSPACE_FILE}`);
  }
  const doc = parsed;
  doc.global ??= emptyDoc().global;
  doc.global.workspaceIds ??= [];
  doc.global.archivedSessionIds ??= [];
  doc.global.pinnedSessionIds ??= [];
  doc.tables ??= { workspaces: {} };
  doc.tables.workspaces ??= {};
  return doc;
}

function writeDoc(doc) {
  mkdirSync(dirname(WORKSPACE_FILE), { recursive: true });
  // 保留上一份**可解析**的注册表：逻辑写坏时用户还能手工回滚。
  try {
    if (existsSync(WORKSPACE_FILE)) copyFileSync(WORKSPACE_FILE, `${WORKSPACE_FILE}.bak-dsh`);
  } catch {
    /* 备份失败不阻断写入 */
  }
  // 临时文件名必须唯一：固定 `.dshmcp.tmp` 会让两个实例/CLI 并发写互相覆盖。
  const tmp = `${WORKSPACE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(tmp, WORKSPACE_FILE);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

/** 在已读入的 doc 里找到（或新建）某路径对应的工作区条目。 */
function ensureWorkspace(doc, cwd, nowIso) {
  const canon = canonicalPath(cwd);
  const target = normPath(canon);
  let wsId = Object.keys(doc.tables.workspaces).find(
    (k) => normPath(doc.tables.workspaces[k]?.path) === target,
  );
  let created = false;
  if (!wsId) {
    wsId = randomUUID();
    doc.tables.workspaces[wsId] = {
      path: canon, // 与 DSH 自身一致：存 realpath 规范形式
      title: basename(canon) || canon,
      sessionIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (!doc.global.workspaceIds.includes(wsId)) doc.global.workspaceIds.push(wsId);
    created = true;
  }
  const ws = doc.tables.workspaces[wsId];
  ws.sessionIds ??= [];
  return { wsId, ws, created };
}

/**
 * 登记单个工作区并把会话挂上去（建会话时调用）。
 * @returns {{registered:boolean, workspace_id?:string, workspace_created?:boolean, error?:string}}
 */
export function registerWorkspace(cwd, sessionId) {
  if (!shouldRegister(cwd)) {
    return {
      registered: false,
      error: `按登记模式跳过（${REGISTER_WORKSPACE}${isTempPath(cwd) ? '，且该路径在系统临时目录下' : ''}）`,
    };
  }
  try {
    const doc = readDoc();
    const nowIso = new Date().toISOString();
    const { wsId, ws, created } = ensureWorkspace(doc, cwd, nowIso);
    if (sessionId && !ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId);
    ws.updatedAt = nowIso;
    writeDoc(doc);
    return { registered: true, workspace_id: wsId, workspace_created: created };
  } catch (e) {
    return { registered: false, error: e.message };
  }
}

/** 读取一个会话头的第一个 zstd 帧（就是头行）。仅用于 CLI/测试清理，不用于 MCP 热路径。 */
function readHeader(file) {
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    return JSON.parse(text.split(/\r?\n/).find(Boolean));
  } catch {
    return null;
  }
}

/**
 * 异步读取会话头：流式解压，拿到第一行就销毁流。
 *
 * 为什么需要它：MCP 服务在 `Hub.get()` 里找回磁盘会话时必须读头；
 * `readHeader()` 会把整份日志同步解压，超大日志会阻塞事件循环、停掉
 * 心跳（多实例下可能被误判 stale-mcp）。这里只解到第一个换行，
 * 不把整份日志读进内存，也不阻塞事件循环。
 *
 * 超时/读失败返回 null；调用方按“找不到会话头”处理。
 */
export async function readHeaderAsync(file, { timeoutMs = 5000, maxHeaderBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    let timer = null;
    const decoder = new StringDecoder('utf8');
    const rs = createReadStream(file);
    const zs = createZstdDecompress();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { rs.destroy(); } catch {}
      try { zs.destroy(); } catch {}
      resolve(value);
    };
    const parseLine = (line) => {
      try {
        const value = JSON.parse(String(line).trim());
        finish(value && typeof value === 'object' ? value : null);
      } catch {
        finish(null);
      }
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    rs.on('error', () => finish(null));
    zs.on('error', () => finish(null));
    zs.on('data', (chunk) => {
      // 用 StringDecoder 处理跨 chunk 的多字节 UTF-8（中文/emoji 路径），
      // 避免 chunk.toString() 把字符截成乱码。
      buf += decoder.write(chunk);
      const nl = buf.search(/\r?\n/);
      if (nl >= 0) parseLine(buf.slice(0, nl));
      else if (buf.length > maxHeaderBytes) finish(null);
    });
    zs.on('end', () => {
      buf += decoder.end();
      const line = buf.split(/\r?\n/).find(Boolean);
      if (line) parseLine(line);
      else finish(null);
    });
    rs.pipe(zs);
  });
}

/**
 * 扫描磁盘上所有会话，按 header.cwd 归组。数据源是会话头，不是目录名（目录名有损）。
 *
 * 会话根目录**不可读时抛错**，而不是返回空 Map —— 否则 backfill 的
 * `pruneMissing` 会以为"所有会话都消失了"，把工作区注册表里的 sessionIds 清空。
 */
export function scanSessions() {
  const byCwd = new Map();
  if (!existsSync(SESSIONS_ROOT)) {
    throw new Error(`会话目录不存在或不可读: ${SESSIONS_ROOT}`);
  }
  for (const bucket of readdirSync(SESSIONS_ROOT)) {
    const bucketPath = join(SESSIONS_ROOT, bucket);
    let dirs;
    try {
      dirs = readdirSync(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const header = readHeader(join(bucketPath, d.name, 'session.v4.jsonl.zstd'));
      if (!header?.cwd || !header?.id) continue;
      if (!byCwd.has(header.cwd)) byCwd.set(header.cwd, []);
      byCwd.get(header.cwd).push({
        id: header.id,
        origin: header.origin ?? null,
        parent: header.parentSession ?? null,
      });
    }
  }
  return byCwd;
}

/**
 * 按会话 id 在会话存储里找到它的头（跨所有分桶扫描）。
 *
 * 用于"注册表里没有、但会话其实在磁盘上"的场景：别的 dsh-any-agent 实例建的、注册表被并发写覆盖丢的、
 * 或者根本是别的 profile / GUI 建的。**会话存储才是权威，注册表只是缓存。**
 *
 * 会对 id 做形状校验（只允许 UUID / `session-` 前缀那类字符），避免 `..` 之类逃出会话目录。
 */
export async function findSessionHeaderStatus(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{4,80}$/.test(sessionId)) {
    return { status: 'missing', header: null, reason: 'id 形状非法' };
  }
  if (!existsSync(SESSIONS_ROOT)) return { status: 'missing', header: null, reason: '会话目录不存在' };
  let buckets;
  try {
    buckets = readdirSync(SESSIONS_ROOT);
  } catch (e) {
    return { status: 'error', header: null, reason: `会话目录不可读: ${e.message}` };
  }
  for (const bucket of buckets) {
    const f = join(SESSIONS_ROOT, bucket, sessionId, 'session.v4.jsonl.zstd');
    if (!existsSync(f)) continue;
    const header = await readHeaderAsync(f);
    if (header?.id === sessionId) return { status: 'found', header, file: f };
    if (header === null) {
      // 文件存在但头读不出来（超时/损坏/IO）：不能当成“会话不存在”，
      // 否则 forget 墓碑会被误删、按 id 查询也会误报未知会话。
      return { status: 'error', header: null, reason: `无法读取会话头: ${f}`, file: f };
    }
  }
  return { status: 'missing', header: null, reason: '会话文件不存在' };
}

export async function findSessionHeader(sessionId) {
  return (await findSessionHeaderStatus(sessionId)).header;
}

/**
 * 回填：按磁盘上的会话头把所有工作区补登记一遍。
 * 用于修复"本功能上线前创建的会话在 GUI 里看不到"。
 */
export function backfillWorkspaces({ includeTemp = false, dryRun = false, pruneMissing = true } = {}) {
  const stats = {
    workspaces_created: 0,
    workspaces_existing: 0,
    sessions_added: 0,
    sessions_scanned: 0,
    temp_skipped_sessions: 0,
    temp_skipped_workspaces: 0,
    /** 磁盘上已不存在、被从注册表摘掉的 sessionId 数量。 */
    sessions_pruned: 0,
    /** 读取失败时的说明；非空表示**没有写盘**。 */
    error: null,
  };
  let byCwd;
  let doc;
  try {
    byCwd = scanSessions();
    doc = readDoc();
  } catch (e) {
    // 看不到会话存储 / 注册表坏了时绝不做对账：那会把所有 sessionIds 清空。
    return { ...stats, error: e.message };
  }
  const nowIso = new Date().toISOString();

  /** 磁盘上真实存在的会话 id 全集。 */
  const live = new Set();
  for (const sessions of byCwd.values()) for (const s of sessions) live.add(s.id);

  for (const [cwd, sessions] of byCwd) {
    stats.sessions_scanned += sessions.length;
    if (!includeTemp && isTempPath(cwd)) {
      stats.temp_skipped_sessions += sessions.length;
      stats.temp_skipped_workspaces += 1;
      continue;
    }
    const { ws, created } = ensureWorkspace(doc, cwd, nowIso);
    created ? stats.workspaces_created++ : stats.workspaces_existing++;
    for (const s of sessions) {
      if (!ws.sessionIds.includes(s.id)) {
        ws.sessionIds.push(s.id);
        stats.sessions_added++;
      }
    }
    ws.updatedAt = nowIso;
  }

  // 对账：摘掉磁盘上已经不存在的会话（例如刚被清理掉的测试会话）
  if (pruneMissing) {
    for (const id of Object.keys(doc.tables.workspaces)) {
      const ws = doc.tables.workspaces[id];
      if (!Array.isArray(ws?.sessionIds)) continue;
      const kept = ws.sessionIds.filter((sid) => live.has(sid));
      stats.sessions_pruned += ws.sessionIds.length - kept.length;
      ws.sessionIds = kept;
    }
    doc.global.archivedSessionIds = (doc.global.archivedSessionIds ?? []).filter((sid) => live.has(sid));
    doc.global.pinnedSessionIds = (doc.global.pinnedSessionIds ?? []).filter((sid) => live.has(sid));
  }

  if (!dryRun) writeDoc(doc);
  return stats;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{4,80}$/;

/**
 * 列出磁盘上所有会话（带会话头里的 id/cwd/父会话）。
 * 头读不出来的目录直接略过：认不出 cwd 的会话**绝不当成测试会话**。
 */
function listSessionEntries() {
  const entries = [];
  if (!existsSync(SESSIONS_ROOT)) return entries;
  for (const bucket of readdirSync(SESSIONS_ROOT)) {
    const bucketPath = join(SESSIONS_ROOT, bucket);
    let dirs;
    try {
      dirs = readdirSync(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      // 符号链接一律不碰：rmSync 对链接的行为依赖平台，且链接目标可能不在会话目录内。
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const dir = join(bucketPath, d.name);
      // 兜底：只允许删 SESSIONS_ROOT 下面的目录（结构上已经如此，防未来改动）。
      if (!isInside(SESSIONS_ROOT, dir)) continue;
      const header = readHeader(join(dir, 'session.v4.jsonl.zstd'));
      if (!header?.id) continue;
      entries.push({
        id: header.id,
        dirName: d.name,
        dir,
        bucketPath,
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        origin: header.origin ?? null,
        parent: header.parentSession ?? null,
      });
    }
  }
  return entries;
}

/**
 * 把会话 id 从 DSH 的工作区注册表里摘掉（**定点**：只动这些 id，不重新扫描磁盘）。
 *
 * 为什么不再用 `backfillWorkspaces({ includeTemp: true })` 来"对账"：回填会把磁盘上
 * **所有**会话重新登记一遍（连别的进程/别的 agent 还活着的临时会话都会被登记成工作区，
 * 出现在 GUI 侧栏里）——实测并行跑测试时真实 workspace.json 里就多出了别人的测试工作区。
 *
 * 规则：
 *   - 从各工作区的 sessionIds、archivedSessionIds、pinnedSessionIds 摘掉这些 id；
 *   - 摘完变空、且路径是测试目录的工作区条目一并删掉（真实项目的工作区条目绝不删）；
 *   - 没有任何变化就**不写盘**（临时目录的测试会话根本没登记过，这是常态）；
 *   - 注册表坏了 fail-closed：返回 error，不写。
 */
export function unregisterSessions(ids, { dryRun = false } = {}) {
  const set = new Set((ids ?? []).filter((x) => typeof x === 'string' && x));
  const res = { changed: false, sessions_removed: 0, workspaces_dropped: [], error: null };
  if (!set.size) return res;
  let doc;
  try {
    doc = readDoc();
  } catch (e) {
    return { ...res, error: e.message };
  }
  for (const wsId of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[wsId];
    if (!Array.isArray(ws?.sessionIds)) continue;
    const kept = ws.sessionIds.filter((sid) => !set.has(sid));
    const removed = ws.sessionIds.length - kept.length;
    if (!removed) continue;
    res.sessions_removed += removed;
    ws.sessionIds = kept;
    const isTestWs = isTestTempPath(ws.path) || isTestDesktopPath(ws.path) || isTestScratchPath(ws.path);
    if (kept.length === 0 && isTestWs) {
      res.workspaces_dropped.push({ id: wsId, path: ws.path });
      delete doc.tables.workspaces[wsId];
      doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== wsId);
      if (doc.global.defaultWorkspaceId === wsId) doc.global.defaultWorkspaceId = null;
    }
  }
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    const before = doc.global[key] ?? [];
    const after = before.filter((sid) => !set.has(sid));
    if (after.length !== before.length) {
      res.sessions_removed += before.length - after.length;
      doc.global[key] = after;
    }
  }
  res.changed = res.sessions_removed > 0;
  if (res.changed && !dryRun) {
    try {
      writeDoc(doc);
    } catch (e) {
      res.error = e.message;
    }
  }
  return res;
}

/**
 * 删除测试会话（**这是唯一会动磁盘会话文件的函数**，所以规则写得很死）。
 *
 * ★ 硬护栏：无论怎么选中，一个会话只有在它**记录的 cwd** 是测试目录时才会被删
 *   （见 `isTestSessionCwd`）。`ids` 点名、`roots` 圈定都绕不过这条；cwd 不是测试目录的
 *   会被列进 `skipped` 并拒绝。以前 `ids` 可以删任意 cwd 的会话，写错一个 id 就是事故。
 *
 * 选中方式：
 *   - 默认（扫荡）：磁盘上所有 cwd 是测试目录的会话，外加 `ids` 点名的。
 *   - `idsOnly` 或给了 `roots`（点名模式）：只删 `ids` 点名的、以及 cwd 落在 `roots` 里的。
 *     测试套件收尾用这个——只清自己造的，不会把并行进程的会话一起带走。
 *   - 无论哪种，被选中会话的**子会话**（`parentSession` 指向它，DSH 派子代理时产生）
 *     会级联带走（同样要过 cwd 护栏）：测试不知道子会话的 id，不级联就会一直留着。
 *
 * 每个被删会话清掉的 DSH 侧产物：会话目录、投影缓存 `<id>.json`、forget 墓碑、
 * 工作区注册里的登记（定点摘除）、因此变空的分桶目录。
 * 本项目自己的 per-run 数据（注册表/哨兵/审核/锁/元数据）见 `src/residue.mjs`。
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun] 只列清单，不删任何东西
 * @param {string[]} [opts.ids] 点名的会话 id
 * @param {string[]} [opts.roots] 点名模式：cwd 在这些目录里的会话
 * @param {boolean} [opts.idsOnly] 点名模式（只认 ids/roots，不扫荡）
 * @param {boolean} [opts.testOnly] 兼容旧调用，忽略：护栏现在永远开着
 */
export function purgeTestSessions({ dryRun = false, ids = [], roots = [], idsOnly = false } = {}) {
  const explicit = new Set((ids ?? []).filter((x) => typeof x === 'string' && x));
  const rootList = (roots ?? []).filter((r) => typeof r === 'string' && r && isAbsolute(r));
  const scoped = idsOnly || rootList.length > 0;
  const all = listSessionEntries();
  const victims = new Map();
  const skipped = [];
  const skippedIds = new Set();

  const refuse = (e, reason) => {
    if (skippedIds.has(e.id)) return;
    skippedIds.add(e.id);
    skipped.push({ id: e.id, cwd: e.cwd, reason });
  };
  const eligibleShape = (e) => SAFE_SESSION_ID.test(e.id) && e.id === e.dirName;
  const take = (e, reason) =>
    victims.set(e.id, { id: e.id, dir: e.dir, bucketPath: e.bucketPath, cwd: e.cwd, reason, origin: e.origin, parent: e.parent });

  for (const e of all) {
    const named = explicit.has(e.id);
    const inRoot = Boolean(e.cwd) && isAbsolute(e.cwd) && rootList.some((r) => isInside(r, e.cwd));
    const swept = !scoped && isTestSessionCwd(e.cwd);
    if (!named && !inRoot && !swept) continue;
    if (!isTestSessionCwd(e.cwd)) {
      refuse(e, 'cwd 不是测试目录，拒绝删除');
      continue;
    }
    if (!eligibleShape(e)) {
      refuse(e, '会话 id 与目录名不一致或形状非法');
      continue;
    }
    take(e, named ? '显式指定' : inRoot ? '测试根目录' : DESKTOP_TEST_SESSION_RE.test(e.cwd) ? '验收测试目录' : '测试临时目录');
  }

  // 子会话级联（可传递）：父会话被选中，它派出的子代理会话一并算。
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of all) {
      if (victims.has(e.id) || !e.parent || !victims.has(e.parent)) continue;
      if (!isTestSessionCwd(e.cwd)) {
        refuse(e, '子会话的 cwd 不是测试目录，拒绝删除');
        continue;
      }
      if (!eligibleShape(e)) {
        refuse(e, '会话 id 与目录名不一致或形状非法');
        continue;
      }
      take(e, '子会话（随父会话）');
      grew = true;
    }
  }

  const list = [...victims.values()];
  if (!dryRun) {
    const removedIds = [];
    const touchedBuckets = new Set();
    for (const v of list) {
      try {
        // Windows 上刚退出的 DSH 子进程可能还没松手：给几次重试。
        rmSync(v.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        v.error = e.message;
        continue; // 会话目录没删掉就别动它的其它产物，保持一致
      }
      removedIds.push(v.id);
      touchedBuckets.add(v.bucketPath);
      // 投影缓存：删目录不会带走它（见 PROJCACHE_DIR 注释）。
      try {
        rmSync(join(PROJCACHE_DIR, `${v.id}.json`), { force: true });
      } catch (e) {
        v.projcache_error = e.message;
      }
      // 会话文件都没了，墓碑也就没有意义：一起清掉，避免测试残留。
      try {
        rmSync(join(FORGOTTEN_DIR, `${v.id}.json`), { force: true });
      } catch {
        /* 墓碑不存在或删不掉都不影响会话清理 */
      }
    }
    // 只清**我们刚删空**的分桶（每个工作区一个桶）；别的空桶不是我们造的，不碰。
    for (const bp of touchedBuckets) {
      try {
        if (readdirSync(bp).length === 0) rmSync(bp, { recursive: true, force: true });
      } catch {
        /* 桶被占用或权限问题就跳过 */
      }
    }
    // 工作区注册：定点摘除（不再整盘回填，见 unregisterSessions 注释）。
    const reg = unregisterSessions(removedIds);
    return { count: list.length, victims: list, skipped, registry: reg };
  }
  return { count: list.length, victims: list, skipped, registry: null };
}

/**
 * 清理投影缓存里的**孤儿**：`<id>.json` 还在，但磁盘上已经没有这个会话了。
 *
 * 只删 cwd（缓存里 `record.identity.cwd`）是测试目录的孤儿；认不出 cwd 或不是测试目录的
 * 一律保留，只计数。`minAgeMs` 内刚写过的也不动（避免和正在创建会话的进程抢跑）。
 * 会话目录不可读时 fail-closed（什么都不删）。
 */
export function purgeOrphanProjcache({ dryRun = false, minAgeMs = 60_000 } = {}) {
  const res = { count: 0, bytes: 0, victims: [], kept_non_test: 0, error: null };
  if (!existsSync(PROJCACHE_DIR)) return res;
  const onDisk = new Set();
  try {
    for (const bucket of readdirSync(SESSIONS_ROOT)) {
      try {
        for (const d of readdirSync(join(SESSIONS_ROOT, bucket), { withFileTypes: true })) {
          if (d.isDirectory()) onDisk.add(d.name);
        }
      } catch {
        // 单个分桶读不了：保守起见当作"可能含有任何会话"——本次不清孤儿
        return { ...res, error: `分桶不可读: ${bucket}` };
      }
    }
  } catch (e) {
    return { ...res, error: `会话目录不可读: ${e.message}` };
  }
  const now = Date.now();
  for (const f of readdirSync(PROJCACHE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!SAFE_SESSION_ID.test(id) || onDisk.has(id)) continue;
    const file = join(PROJCACHE_DIR, f);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || now - st.mtimeMs < minAgeMs) continue;
    let cwd = '';
    try {
      cwd = JSON.parse(readFileSync(file, 'utf8'))?.record?.identity?.cwd ?? '';
    } catch {
      /* 解析不了：认不出 cwd，保留 */
    }
    if (!isTestSessionCwd(cwd)) {
      res.kept_non_test++;
      continue;
    }
    res.victims.push({ id, file, cwd, bytes: st.size });
    res.count++;
    res.bytes += st.size;
    if (!dryRun) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 删不掉就留着，下次再来 */
      }
    }
  }
  return res;
}

/** 清掉"没有会话且路径已不存在"的空工作区条目。 */
export function pruneEmptyWorkspaces({ dryRun = false } = {}) {
  let doc;
  try {
    doc = readDoc();
  } catch (e) {
    return { removed: [], error: e.message };
  }
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    const empty = (ws?.sessionIds?.length ?? 0) === 0;
    const gone = !existsSync(ws?.path ?? '');
    if (!empty || !gone) continue;
    removed.push({ id, path: ws.path });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/**
 * 清理：把**测试用**的工作区条目从注册表移除（临时的 + 桌面上的测试目录，如 `Desktop\dsh-conc-*`）。
 *
 * 为什么需要它：测试会在桌面和临时目录里造工作区，跑完删掉文件夹，但**注册表条目会留下** ——
 * 于是每跑一次全量测试，你的 GUI 侧栏就多几个空壳 ✗（`pruneEmptyWorkspaces` 靠"无会话且路径不存在"
 * 启发式，实测不一定兜住）。这里按**路径模式**确定性清理，绝不碰真实项目目录。
 */
export function pruneTestWorkspaces({ dryRun = false } = {}) {
  let doc;
  try {
    doc = readDoc();
  } catch (e) {
    return { removed: [], error: e.message };
  }
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    const p = ws?.path ?? '';
    if (!p) continue;
    // ★ 只删测试自己造的临时目录（dsh-any-agent-*）与桌面测试目录。
    //   以前用 isTempPath(p) 会把用户在 %TEMP% 里的真实项目登记也删掉。
    if (!isTestTempPath(p) && !isTestDesktopPath(p) && !isTestScratchPath(p)) continue;
    removed.push({ id, path: p, sessions: ws?.sessionIds?.length ?? 0 });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/** 清理：把系统临时目录下的工作区条目从注册表移除（**不动磁盘上的会话**）。 */
export function pruneTempWorkspaces({ dryRun = false } = {}) {
  let doc;
  try {
    doc = readDoc();
  } catch (e) {
    return { removed: [], error: e.message };
  }
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    if (!isTempPath(ws?.path)) continue;
    removed.push({ id, path: ws.path, sessions: ws.sessionIds?.length ?? 0 });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/** 列出当前注册表里的工作区。解析失败时抛错（由 CLI 显示可操作的错误）。 */
export function listWorkspaces() {
  const doc = readDoc();
  return Object.entries(doc.tables.workspaces).map(([id, w]) => ({
    id,
    path: w.path,
    title: w.title,
    sessions: w.sessionIds?.length ?? 0,
    is_temp: isTempPath(w.path),
  }));
}

export { WORKSPACE_FILE, SESSIONS_ROOT, PROJCACHE_DIR };