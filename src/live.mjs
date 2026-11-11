/**
 * live 事件流：把"DSH 在做什么"写成按会话分的 JSONL，给用户旁路查看。
 *
 * 为什么是文件而不是端口：本服务是 MCP 客户端拉起的 stdio 子进程，可能同时有好几个实例
 * （Claude Code / Codex / Cursor 各一个），彼此内存不通。文件天然跨实例、跨重启；同一会话
 * 同一时刻只有一个写者（写锁保证），所以"一会话一文件、单写者追加"不需要再加锁。
 * 查看端（`dsh-any-agent watch` / `dashboard`，见 live-view.mjs）只读这些文件。
 *
 * 纪律（与 audit.mjs 相同）：
 *   - 同步追加一行；**所有异常吞掉**，写失败绝不影响派活。
 *   - 思考内容在事件格式里**没有位置**：没有任何事件类型接收它，任何级别都不落盘。
 *   - 字符串一律先过 sanitizeApprovalContext 脱敏，再截断。
 *
 * 布局：`<LIVE_DIR>/<conversation_id>/events.jsonl`（满了滚动成 `events.jsonl.1`，只留一份）。
 * 按会话分目录是为了直接复用 pruneDirTree 做 TTL 清理。
 * 数据契约见 docs/zh/live-view-design.md §6。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LIVE_DIR, LIVE_LEVEL, LIVE_LEVELS } from './config.mjs';
import { sanitizeApprovalContext } from './redact.mjs';
import { pruneDirTree } from './sentinel.mjs';

export const LIVE_SCHEMA = 1;
export const LIVE_FILE = 'events.jsonl';
/** 单文件上限；超过就滚动成 `.1`（只留一份旧档）。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 单行上限；超过先丢掉 detail 字段，仍超就不写。 */
const MAX_LINE_BYTES = 4096;
/** 会话 id 会拼进路径：只认安全字符（同 ids.mjs 的约束，宽松到能放下 DSH 的 uuid）。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** 这些事件带上客户端名，查看端用它把会话挂到"谁派的"下面。 */
const CLIENT_TYPES = new Set(['conv.open', 'run.queued', 'run.start']);

/** 写者标识：进程 pid + 本次启动的随机串。查看端用 pid 判断写者是否还活着。 */
export const WRITER = `${process.pid}:${randomBytes(4).toString('hex')}`;

const settings = { dir: LIVE_DIR, level: LIVE_LEVEL };
/** 进程级的客户端（setLiveClient）：只在没有调用链级客户端时用（测试、单客户端的旧调用方）。 */
let client = null;
/**
 * 调用链级的客户端：常驻进程模式下一个进程同时服务好几个客户端，进程级的一个值会把所有
 * 事件都记到最后连上来的那个名下。mcp.mjs 把每个 tools/call 包在 withLiveClient 里，
 * 这条异步调用链上写出的事件就记在发起它的客户端名下。
 */
const clientScope = new AsyncLocalStorage();
let seq = 0;
/** 本进程已知的文件大小（首次写时 stat 一次，之后自己累加），用于滚动判断。 */
const sizes = new Map();

/** 测试 / 工具用：覆盖目录与级别。 */
export function configureLive({ dir, level } = {}) {
  if (typeof dir === 'string' && dir) settings.dir = dir;
  if (LIVE_LEVELS.includes(level)) settings.level = level;
  sizes.clear();
  return { ...settings };
}

export function liveSettings() {
  return { ...settings };
}

/** MCP initialize 里的 clientInfo（Claude Code / Codex / …）→ `{name, version}`；无效返回 null。 */
function normalizeClient(info) {
  if (!info || typeof info !== 'object') return null;
  const name = typeof info.name === 'string' ? info.name.slice(0, 80) : null;
  const version = typeof info.version === 'string' ? info.version.slice(0, 40) : null;
  return name ? { name, version } : null;
}

export function setLiveClient(info) {
  const c = normalizeClient(info);
  if (c) client = c;
}

/** 在 fn 的整条异步调用链上把客户端记成 info（不影响别的调用链；info 无效时这条链上就是没有客户端）。 */
export function withLiveClient(info, fn) {
  return clientScope.run({ client: normalizeClient(info) }, fn);
}

function currentClient() {
  const scoped = clientScope.getStore();
  return scoped ? scoped.client : client;
}

export function liveClient() {
  const c = currentClient();
  return c ? { ...c } : null;
}

export function liveConvDir(convId, dir = settings.dir) {
  return join(dir, convId);
}

export function liveFilePath(convId, dir = settings.dir) {
  return join(dir, convId, LIVE_FILE);
}

/** 脱敏 + 截断成一行预览。对象先逐字段脱敏再序列化。 */
export function livePreview(value, max = 300) {
  if (value === undefined || value === null) return null;
  let s;
  try {
    if (typeof value === 'string') s = sanitizeApprovalContext(value);
    else s = JSON.stringify(sanitizeApprovalContext(value));
  } catch {
    return null;
  }
  if (typeof s !== 'string' || !s) return null;
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 工具输入摘要：优先取最能说明"做了什么"的字段（命令、路径、搜索词），否则整体序列化。
 * 返回值已脱敏、已截断。
 */
export function summarizeToolInput(input, max = 300) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object') return livePreview(String(input), max);
  const pick = (...keys) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(' ');
    }
    return null;
  };
  const cmd = pick('command', 'cmd', 'script');
  if (cmd) return livePreview(cmd, max);
  const path = pick('path', 'file_path', 'filePath', 'file', 'paths', 'target');
  const query = pick('pattern', 'query', 'glob', 'regex', 'url');
  if (path || query) return livePreview([path, query].filter(Boolean).join(' · '), max);
  return livePreview(input, max);
}

/**
 * 写一条事件。永不抛错；返回是否真的写了。
 *
 * @param {string} convId 会话 id
 * @param {string} type   事件类型（run.start / tool / approval / …）
 * @param {object} fields meta 级字段（任何级别都写）
 * @param {object} [detail] detail 级字段（仅 level=detail 时写；调用方负责先脱敏/截断）
 */
export function emitLive(convId, type, fields = {}, detail = null) {
  if (settings.level === 'off') return false;
  if (typeof convId !== 'string' || !SAFE_ID.test(convId)) return false;
  try {
    const ev = { v: LIVE_SCHEMA, ts: new Date().toISOString(), conv: convId, w: WRITER, n: ++seq, type };
    const c = CLIENT_TYPES.has(type) ? currentClient() : null;
    if (c) ev.client = c.name;
    for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) ev[k] = v;
    let line = JSON.stringify(ev);
    if (settings.level === 'detail' && detail) {
      const withDetail = { ...ev };
      for (const [k, v] of Object.entries(detail)) if (v !== undefined && v !== null) withDetail[k] = v;
      const full = JSON.stringify(withDetail);
      if (Buffer.byteLength(full) <= MAX_LINE_BYTES) line = full;
      else line = JSON.stringify({ ...ev, truncated: true });
    }
    line += '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES + 1) return false;

    const dir = liveConvDir(convId);
    const file = join(dir, LIVE_FILE);
    mkdirSync(dir, { recursive: true });
    let size = sizes.get(file);
    if (size === undefined) {
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    if (size + bytes > MAX_FILE_BYTES && size > 0) {
      try {
        renameSync(file, `${file}.1`);
      } catch {
        /* 被占用就继续往原文件写，下次再滚 */
      }
      size = 0;
    }
    appendFileSync(file, line, 'utf8');
    sizes.set(file, size + bytes);
    return true;
  } catch {
    return false;
  }
}

/** forget 时删掉该会话的事件目录。 */
export function removeLive(convId) {
  if (typeof convId !== 'string' || !SAFE_ID.test(convId)) return false;
  try {
    const dir = liveConvDir(convId);
    for (const k of [...sizes.keys()]) if (k.startsWith(dir)) sizes.delete(k);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 启动时按 TTL 清理过期事件文件（与哨兵同一 TTL）。 */
export function pruneLive(ttlMs) {
  return pruneDirTree(settings.dir, ttlMs);
}
