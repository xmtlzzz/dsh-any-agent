/**
 * DSH `workspace.json` 注册表读写、登记、回填、定向摘除与漂移检测。
 */

import { DSH_WORKSPACE_SCHEMA_VERSION } from '../dsh-contract.mjs';
import { writeJsonAtomic } from '../fs-atomic.mjs';
import { pruneRegistryStages, withRegistryLockSync } from '../registry.mjs';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DSH_HOME, REGISTER_WORKSPACE } from '../config.mjs';
import { L } from '../lang.mjs';
import {
  WORKSPACE_FILE,
  canonicalPath,
  isTempPath,
  isTestDesktopPath,
  isTestScratchPath,
  isTestTempPath,
  normPath,
  shouldRegister,
} from './paths.mjs';
import { scanSessions } from './sessions.mjs';

const WORKSPACE_LOCK_FILE = join(DSH_HOME, '.dsh-any-agent', 'workspace-registry');

export function pruneWorkspaceLockStages() {
  try {
    if (existsSync(dirname(WORKSPACE_LOCK_FILE))) pruneRegistryStages(WORKSPACE_LOCK_FILE);
  } catch {
    // Workspace registration is optional. An unreadable directory must not prevent startup.
  }
}

function emptyDoc() {
  return {
    unit: { name: 'workspace', version: DSH_WORKSPACE_SCHEMA_VERSION },
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

/** 读取工作区注册表。解析失败 fail-closed，绝不覆盖 GUI 列表。 */
function readDoc() {
  if (!existsSync(WORKSPACE_FILE)) return emptyDoc();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
  } catch (e) {
    throw new Error(L(`workspace.json 无法解析，已保持原样不写入: ${WORKSPACE_FILE}（${e.message}）`, `Could not parse workspace.json at ${WORKSPACE_FILE} (${e.message})`));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(L(`workspace.json 结构异常（不是对象），已保持原样不写入: ${WORKSPACE_FILE}`, `Expected an object in workspace.json at ${WORKSPACE_FILE}`));
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
  try {
    if (existsSync(WORKSPACE_FILE)) copyFileSync(WORKSPACE_FILE, `${WORKSPACE_FILE}.bak-dsh`);
  } catch {
    /* 备份失败不阻断写入 */
  }
  writeJsonAtomic(WORKSPACE_FILE, doc);
}

function workspaceTransaction(dryRun, action) {
  if (dryRun) return action();
  mkdirSync(dirname(WORKSPACE_FILE), { recursive: true });
  mkdirSync(dirname(WORKSPACE_LOCK_FILE), { recursive: true });
  return withRegistryLockSync(WORKSPACE_LOCK_FILE, action);
}

function dropWorkspace(doc, id) {
  delete doc.tables.workspaces[id];
  doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
  if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
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
      path: canon,
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
      error: L(
        `按登记模式跳过（${REGISTER_WORKSPACE}${isTempPath(cwd) ? '，且该路径在系统临时目录下' : ''}）`,
        `Skipped by registration mode (${REGISTER_WORKSPACE}${isTempPath(cwd) ? ', path is inside the system temp directory' : ''})`,
      ),
    };
  }
  try {
    return workspaceTransaction(false, () => {
      const doc = readDoc();
      const nowIso = new Date().toISOString();
      const { wsId, ws, created } = ensureWorkspace(doc, cwd, nowIso);
      if (sessionId && !ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId);
      ws.updatedAt = nowIso;
      writeDoc(doc);
      return { registered: true, workspace_id: wsId, workspace_created: created };
    });
  } catch (e) {
    return { registered: false, error: e.message };
  }
}

/** 回填：按磁盘上的会话头把所有工作区补登记一遍。 */
export function backfillWorkspaces({ includeTemp = false, dryRun = false, pruneMissing = true } = {}) {
  const stats = {
    workspaces_created: 0,
    workspaces_existing: 0,
    sessions_added: 0,
    sessions_scanned: 0,
    temp_skipped_sessions: 0,
    temp_skipped_workspaces: 0,
    sessions_pruned: 0,
    error: null,
  };
  try {
    return workspaceTransaction(dryRun, () => {
      const byCwd = scanSessions();
      const doc = readDoc();
      const nowIso = new Date().toISOString();
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
    });
  } catch (e) {
    return { ...stats, error: e.message };
  }
}

/** 把会话 id 从 DSH 的工作区注册表里定点摘掉，不重新扫描磁盘。 */
export function unregisterSessions(ids, { dryRun = false } = {}) {
  const set = new Set((ids ?? []).filter((x) => typeof x === 'string' && x));
  const res = { changed: false, sessions_removed: 0, workspaces_dropped: [], error: null };
  if (!set.size) return res;
  try {
    return workspaceTransaction(dryRun, () => {
      const doc = readDoc();
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
          dropWorkspace(doc, wsId);
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
        writeDoc(doc);
      }
      return res;
    });
  } catch (e) {
    return { ...res, error: e.message };
  }
}

function pruneWorkspacesBy(predicate, { dryRun = false, withCount = true } = {}) {
  try {
    return workspaceTransaction(dryRun, () => {
      const doc = readDoc();
      const removed = [];
      for (const id of Object.keys(doc.tables.workspaces)) {
        const ws = doc.tables.workspaces[id];
        if (!predicate(ws)) continue;
        removed.push(withCount ? { id, path: ws.path, sessions: ws?.sessionIds?.length ?? 0 } : { id, path: ws.path });
        dropWorkspace(doc, id);
      }
      if (!dryRun) writeDoc(doc);
      return { removed };
    });
  } catch (e) {
    return { removed: [], error: e.message };
  }
}

/** 清掉"没有会话且路径已不存在"的空工作区条目。 */
export function pruneEmptyWorkspaces({ dryRun = false } = {}) {
  return pruneWorkspacesBy(
    (ws) => (ws?.sessionIds?.length ?? 0) === 0 && !existsSync(ws?.path ?? ''),
    { dryRun, withCount: false },
  );
}

/** 清理：把测试用的工作区条目从注册表移除（临时的 + 桌面测试目录 + `.state/ws-probe-*`）。 */
export function pruneTestWorkspaces({ dryRun = false } = {}) {
  return pruneWorkspacesBy((ws) => {
    const p = ws?.path ?? '';
    return Boolean(p) && (isTestTempPath(p) || isTestDesktopPath(p) || isTestScratchPath(p));
  }, { dryRun });
}

/** 清理：把系统临时目录下的工作区条目从注册表移除（不动磁盘上的会话）。 */
export function pruneTempWorkspaces({ dryRun = false } = {}) {
  return pruneWorkspacesBy((ws) => isTempPath(ws?.path), { dryRun });
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

/** 检查已登记的项目会话是否仍出现在 DSH workspace.json 中（用于识别被 GUI 内存覆盖丢失的登记）。 */
export function missingRegisteredSessions(conversations) {
  if (REGISTER_WORKSPACE === false) return { checked: 0, missing: [], skipped: true };
  const candidates = conversations.filter((c) => c?.id && c?.cwd && shouldRegister(c.cwd));
  if (!candidates.length) return { checked: 0, missing: [], skipped: false };
  const doc = readDoc();
  const seen = new Set();
  for (const w of Object.values(doc.tables.workspaces)) {
    for (const id of w.sessionIds ?? []) seen.add(id);
  }
  return {
    checked: candidates.length,
    missing: candidates.filter((c) => !seen.has(c.id)).map((c) => c.id),
    skipped: false,
  };
}
