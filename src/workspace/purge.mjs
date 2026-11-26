/**
 * 测试会话与孤儿投影缓存的受保护清理（唯一会删除磁盘会话文件的模块）。
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { L } from '../lang.mjs';
import {
  DESKTOP_TEST_SESSION_RE,
  FORGOTTEN_DIR,
  PROJCACHE_DIR,
  SAFE_SESSION_ID,
  SESSIONS_ROOT,
  isInside,
  isTestSessionCwd,
} from './paths.mjs';
import { listSessionEntries } from './sessions.mjs';
import { unregisterSessions } from './store.mjs';

/**
 * 删除测试会话（硬护栏：只有 cwd 是测试目录的会话才允许删，点名也绕不过）。
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
      refuse(e, L('cwd 不是测试目录，拒绝删除', 'The working directory is outside the test directories'));
      continue;
    }
    if (!eligibleShape(e)) {
      refuse(e, L('会话 id 与目录名不一致或形状非法', 'The session ID is invalid or does not match the directory name'));
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
        refuse(e, L('子会话的 cwd 不是测试目录，拒绝删除', 'The child session is outside the test directories'));
        continue;
      }
      if (!eligibleShape(e)) {
        refuse(e, L('会话 id 与目录名不一致或形状非法', 'The session ID is invalid or does not match the directory name'));
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
        rmSync(v.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        v.error = e.message;
        continue;
      }
      removedIds.push(v.id);
      touchedBuckets.add(v.bucketPath);
      try {
        rmSync(join(PROJCACHE_DIR, `${v.id}.json`), { force: true });
      } catch (e) {
        v.projcache_error = e.message;
      }
      try {
        rmSync(join(FORGOTTEN_DIR, `${v.id}.json`), { force: true });
      } catch {}
    }
    for (const bp of touchedBuckets) {
      try {
        if (readdirSync(bp).length === 0) rmSync(bp, { recursive: true, force: true });
      } catch {}
    }
    const reg = unregisterSessions(removedIds);
    return { count: list.length, victims: list, skipped, registry: reg };
  }
  return { count: list.length, victims: list, skipped, registry: null };
}

/** 清理投影缓存里的孤儿（只删 cwd 是测试目录且超出 minAgeMs 的条目；目录不可读时 fail-closed）。 */
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
        return { ...res, error: L(`分桶不可读: ${bucket}`, `Unreadable session bucket: ${bucket}`) };
      }
    }
  } catch (e) {
    return { ...res, error: L(`会话目录不可读: ${e.message}`, `Unreadable sessions directory: ${e.message}`) };
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
    } catch {}
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
      } catch {}
    }
  }
  return res;
}
