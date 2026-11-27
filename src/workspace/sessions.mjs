/**
 * DSH 磁盘会话头读取与扫描（同步解压用于 CLI/清理，流式异步用于 MCP 热路径）。
 */

import { DSH_SESSION_LOG_FILE } from '../dsh-contract.mjs';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { L } from '../lang.mjs';
import { SAFE_SESSION_ID, SESSIONS_ROOT, isInside } from './paths.mjs';

/** 读取一个会话头的第一个 zstd 帧（就是头行）。仅用于 CLI/测试清理，不用于 MCP 热路径。 */
export function readHeader(file) {
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    return JSON.parse(text.split(/\r?\n/).find(Boolean));
  } catch {
    return null;
  }
}

/**
 * 异步读取会话头：流式解压，拿到第一行就销毁流，避免超大日志阻塞事件循环。
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
 * 扫描磁盘上所有会话，按 header.cwd 归组。会话根目录不可读时抛错（fail-closed）。
 */
export function scanSessions() {
  const byCwd = new Map();
  if (!existsSync(SESSIONS_ROOT)) {
    throw new Error(L(`会话目录不存在或不可读: ${SESSIONS_ROOT}`, `Could not read the sessions directory: ${SESSIONS_ROOT}`));
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
      const header = readHeader(join(bucketPath, d.name, DSH_SESSION_LOG_FILE));
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

/** 按会话 id 在会话存储里找到它的头（跨所有分桶扫描）。 */
export async function findSessionHeaderStatus(sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) {
    return { status: 'missing', header: null, reason: L('id 形状非法', 'invalid id format') };
  }
  if (!existsSync(SESSIONS_ROOT)) return { status: 'missing', header: null, reason: L('会话目录不存在', 'sessions directory does not exist') };
  let buckets;
  try {
    buckets = readdirSync(SESSIONS_ROOT);
  } catch (e) {
    return { status: 'error', header: null, reason: L(`会话目录不可读: ${e.message}`, `sessions directory is not readable: ${e.message}`) };
  }
  for (const bucket of buckets) {
    const f = join(SESSIONS_ROOT, bucket, sessionId, DSH_SESSION_LOG_FILE);
    if (!existsSync(f)) continue;
    const header = await readHeaderAsync(f);
    if (header?.id === sessionId) return { status: 'found', header, file: f };
    if (header === null) {
      // 文件存在但头读不出来（超时/损坏/IO）：不能当成“会话不存在”。
      return { status: 'error', header: null, reason: L(`无法读取会话头: ${f}`, `could not read session header: ${f}`), file: f };
    }
  }
  return { status: 'missing', header: null, reason: L('会话文件不存在', 'session file does not exist') };
}

export async function findSessionHeader(sessionId) {
  return (await findSessionHeaderStatus(sessionId)).header;
}

/**
 * 列出磁盘上所有会话（带会话头里的 id/cwd/父会话）。
 * 头读不出来的目录直接略过：认不出 cwd 的会话绝不当成测试会话。
 */
export function listSessionEntries() {
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
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const dir = join(bucketPath, d.name);
      if (!isInside(SESSIONS_ROOT, dir)) continue;
      const header = readHeader(join(dir, DSH_SESSION_LOG_FILE));
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
