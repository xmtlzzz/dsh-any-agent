/**
 * 测试残留清理：一个测试会话留下的**全部**东西，一次清干净。
 *
 * 一个会话在磁盘上会留下两类东西：
 *
 *   DSH 侧（`~/.dsh`，由 `workspace.mjs` 的 purgeTestSessions 负责）
 *     - sessions/<桶>/<id>/            会话日志
 *     - storages/session_projcache/    投影缓存 <id>.json
 *     - storages/workspace.json        工作区登记里的 id
 *     - .dsh-any-agent-forgotten/      forget 墓碑
 *
 *   本项目侧（状态目录，默认 `~/.dsh/.dsh-any-agent/`；本文件负责）
 *     - conversations.json 里的注册表条目
 *     - meta/<id>.json                 元数据侧车（forget 后**特意**保留，所以必须显式清）
 *     - runs/<id>/                     完成哨兵
 *     - reviews/<id>/                  调用方审核记录
 *     - locks/<id>.json                写锁持有者登记
 *
 * ★ 护栏（和 purgeTestSessions 同一条）：只清"能证明是测试会话"的。证据按可信度：
 *     会话头里的 cwd > 元数据侧车里的 cwd > 注册表条目里的 cwd。
 *   任何一处证据指向非测试目录 → 拒绝；完全没有证据 → 只有"调用方亲手造的 id"
 *   （trusted）才清，扫荡出来的不清。
 *
 * 为什么不是 `test/` 下的帮助文件：`bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`
 * 与全局 `test/cleanup.mjs` 也要用，而且要能在沙箱 DSH_HOME 里做离线回归。
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { REVIEWS_DIR, RUNS_DIR, STATE_FILE } from './config.mjs';
import { LOCKS_DIR } from './locks.mjs';
import { isTestSessionCwd, pruneTestWorkspaces, purgeOrphanProjcache, purgeTestSessions } from './workspace.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]{4,80}$/;

/**
 * 一份"状态目录规格"。字符串 = 注册表文件路径（meta/runs/reviews/locks 取它的同级目录）；
 * 对象可逐项覆盖（`DSH_MCP_RUNS_DIR` 之类环境变量改过位置时用）。
 */
function resolveState(spec) {
  const s = typeof spec === 'string' ? { stateFile: spec } : spec;
  const stateFile = s.stateFile ?? (s.dir ? join(s.dir, 'conversations.json') : null);
  if (!stateFile) throw new Error('状态目录规格缺少 stateFile/dir');
  const dir = dirname(stateFile);
  return {
    stateFile,
    metaDir: s.metaDir ?? join(dir, 'meta'),
    runsDir: s.runsDir ?? join(dir, 'runs'),
    reviewsDir: s.reviewsDir ?? join(dir, 'reviews'),
    locksDir: s.locksDir ?? join(dir, 'locks'),
  };
}

/** 当前进程配置的状态目录（= MCP 服务默认用的那份，通常是 `~/.dsh/.dsh-any-agent`）。 */
export function defaultState() {
  return { stateFile: STATE_FILE, runsDir: RUNS_DIR, reviewsDir: REVIEWS_DIR, locksDir: LOCKS_DIR };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** 读注册表；文件不存在 → null；坏了 → 抛错（调用方 fail-closed，绝不覆盖）。 */
function readRegistry(stateFile) {
  if (!existsSync(stateFile)) return null;
  const doc = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('注册表结构异常');
  return doc;
}

/** 这个 id 在这份状态目录里的 cwd 证据（元数据侧车 + 注册表条目）。 */
function stateCwds(st, id, registry) {
  const out = [];
  const meta = readJson(join(st.metaDir, `${id}.json`));
  if (typeof meta?.cwd === 'string' && meta.cwd) out.push(meta.cwd);
  const entry = (registry?.conversations ?? []).find((c) => c?.id === id);
  if (typeof entry?.cwd === 'string' && entry.cwd) out.push(entry.cwd);
  return out;
}

/** 删一个文件/目录；返回是否真的存在过并已删除。 */
function removePath(p, dryRun) {
  if (!existsSync(p)) return false;
  if (!dryRun) rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return true;
}

/**
 * 清掉一批会话 id 在若干状态目录里的 per-run 数据。
 *
 * @param {object} opts
 * @param {string[]} opts.ids 要清的会话 id
 * @param {Array<string|object>} [opts.states] 状态目录规格；缺省 = 当前进程配置的那份
 * @param {Map<string,string>|Record<string,string>} [opts.headerCwds] 已核实的会话头 cwd（id → cwd）
 * @param {boolean|string[]} [opts.trusted] 这些 id 是调用方亲手造的（没证据也清）。true = 全部。
 * @param {boolean} [opts.dryRun]
 */
export function purgeProjectState({ ids, states, headerCwds = new Map(), trusted = false, dryRun = false }) {
  const header = headerCwds instanceof Map ? headerCwds : new Map(Object.entries(headerCwds));
  const trustedSet = trusted === true ? null : new Set(Array.isArray(trusted) ? trusted : []);
  const isTrusted = (id) => trusted === true || (trustedSet?.has(id) ?? false);
  const specs = (states?.length ? states : [defaultState()]).map(resolveState);
  const res = { removed: { registry: 0, meta: 0, runs: 0, reviews: 0, locks: 0 }, refused: [], errors: [] };
  const wanted = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && SAFE_ID.test(x)))];

  for (const st of specs) {
    let registry = null;
    let registryBroken = false;
    try {
      registry = readRegistry(st.stateFile);
    } catch (e) {
      registryBroken = true;
      res.errors.push(`${st.stateFile}: ${e.message}（注册表不动；其余产物仍按元数据证据清理）`);
    }

    const allowed = [];
    for (const id of wanted) {
      const cwds = [header.get(id), ...stateCwds(st, id, registry)].filter(Boolean);
      if (cwds.some((c) => !isTestSessionCwd(c))) {
        res.refused.push({ id, state: st.stateFile, reason: 'cwd 证据指向非测试目录' });
      } else if (!cwds.length && !isTrusted(id)) {
        res.refused.push({ id, state: st.stateFile, reason: '没有任何 cwd 证据' });
      } else {
        allowed.push(id);
      }
    }

    for (const id of allowed) {
      if (removePath(join(st.runsDir, id), dryRun)) res.removed.runs++;
      if (removePath(join(st.reviewsDir, id), dryRun)) res.removed.reviews++;
      if (removePath(join(st.locksDir, `${id}.json`), dryRun)) res.removed.locks++;
      if (removePath(join(st.metaDir, `${id}.json`), dryRun)) res.removed.meta++;
      // 侧车写到一半崩溃会留 `<id>.json.tmp.<pid>.<rand>`
      try {
        for (const f of existsSync(st.metaDir) ? readdirSync(st.metaDir) : []) {
          if (f.startsWith(`${id}.json.tmp.`)) removePath(join(st.metaDir, f), dryRun);
        }
      } catch {
        /* 读不了就算了 */
      }
    }

    // 注册表：只摘 allowed 里的条目；其它条目与顶层字段原样保留；没变化不写盘。
    if (registry && !registryBroken && Array.isArray(registry.conversations)) {
      const drop = new Set(allowed);
      const kept = registry.conversations.filter((c) => !drop.has(c?.id));
      const n = registry.conversations.length - kept.length;
      if (n > 0) {
        res.removed.registry += n;
        if (!dryRun) {
          const tmp = `${st.stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
          try {
            writeFileSync(tmp, JSON.stringify({ ...registry, conversations: kept }, null, 2), 'utf8');
            renameSync(tmp, st.stateFile);
          } catch (e) {
            rmSync(tmp, { force: true });
            res.errors.push(`${st.stateFile}: 写注册表失败: ${e.message}`);
          }
        }
      }
    }
  }
  return res;
}

/**
 * 测试套件收尾用的一站式清理：先清 DSH 侧会话，再清本项目 per-run 数据。
 *
 * 套件只会在自己的 `finally` 里调它，所以只传**自己造的**：`ids`（dsh_start 返回的）
 * 与 `roots`（自己的临时根，用来兜住没来得及记 id、以及 DSH 自己派出的子代理会话）。
 * 永远是点名模式，不会扫荡别人的会话。
 *
 * @param {object} opts
 * @param {string[]} [opts.ids]
 * @param {string[]} [opts.roots]
 * @param {Array<string|object>} [opts.stateFiles] 这次测试起的 MCP 服务用的状态目录规格
 *   （`DSH_MCP_STATE`）；缺省 = 当前进程配置的那份
 * @param {boolean} [opts.dryRun]
 */
export function purgeTestResidue({ ids = [], roots = [], stateFiles, dryRun = false } = {}) {
  const sessions = purgeTestSessions({ ids, roots, idsOnly: true, dryRun });
  const refused = new Set(sessions.skipped.map((s) => s.id));
  const headerCwds = new Map(sessions.victims.map((v) => [v.id, v.cwd]));
  const all = [...new Set([...ids, ...sessions.victims.map((v) => v.id)])].filter((id) => !refused.has(id));
  // 调用方点名的 id 是它亲手造的：会话目录已不在（比如测试中途特意删过）时，
  // 没有头 cwd 也没有侧车，仍然算可清；有任何非测试证据则照样拒绝。
  const project = purgeProjectState({ ids: all, states: stateFiles, headerCwds, trusted: ids.filter((id) => !refused.has(id)), dryRun });
  return { sessions, project };
}

/**
 * 扫荡一份状态目录：把里面**有证据证明是测试会话**的 per-run 数据清掉。
 *
 * 和 purgeProjectState 的区别：这里的 id 是从目录内容里收集来的（不是调用方点名的），
 * 所以一律按"没证据不清"处理——别人的会话、没有侧车的孤儿条目原样留着。
 *
 * @param {object} opts
 * @param {string|object} opts.state 状态目录规格
 * @param {boolean} [opts.removeEmptyDirs] 清空后把 runs/reviews/locks/meta 这几个空目录也收掉
 */
export function sweepStateDir({ state, dryRun = false, removeEmptyDirs = false }) {
  const spec = resolveState(state);
  const ids = new Set();
  const collect = (d, stripJson) => {
    try {
      for (const f of readdirSync(d)) ids.add(stripJson ? f.replace(/\.json$/, '') : f);
    } catch {
      /* 目录不存在 */
    }
  };
  collect(spec.runsDir, false);
  collect(spec.reviewsDir, false);
  collect(spec.locksDir, true);
  collect(spec.metaDir, true);
  try {
    for (const c of readRegistry(spec.stateFile)?.conversations ?? []) if (c?.id) ids.add(c.id);
  } catch {
    /* 注册表坏了：purgeProjectState 会再报一次，这里不重复 */
  }
  const purged = purgeProjectState({ ids: [...ids], states: [spec], trusted: false, dryRun });
  const dirsRemoved = [];
  if (removeEmptyDirs && !dryRun) {
    for (const d of [spec.runsDir, spec.reviewsDir, spec.locksDir, spec.metaDir]) {
      try {
        if (existsSync(d) && readdirSync(d).length === 0) {
          rmdirSync(d);
          dirsRemoved.push(d);
        }
      } catch {
        /* 占用就算了 */
      }
    }
  }
  return { ...purged, dirsRemoved };
}

/**
 * 清理 `%TEMP%` 根下遗留的扁平状态目录。
 *
 * 历史包袱：好几个套件把 `DSH_MCP_STATE` 设成 `%TEMP%/dsh-any-agent-xxx-state-<ts>.json`，
 * 而 runs/reviews/locks/meta 是按"注册表同级目录"推导的，于是它们全落在 `%TEMP%/runs`、
 * `%TEMP%/meta`…… 里，没有任何一个 `dsh-any-agent-*` 目录兜着，永远不会被清掉。
 * 现在各套件的状态都收进自己的临时根里了；这里只负责清旧版本留下的，也兜住
 * 还在跑旧版测试的分支。
 *
 * 这些目录名很通用（runs/meta…），所以**必须有证据**：只清元数据侧车证明 cwd 是测试目录的 id。
 */
export function sweepLegacyTmpState({ dir = tmpdir(), dryRun = false } = {}) {
  return sweepStateDir({ state: { dir }, dryRun, removeEmptyDirs: true });
}

/**
 * 全局扫荡（`test/cleanup.mjs` 的核心，也是各套件 finally 之外的兜底）：
 *   1) 磁盘上 cwd 是测试目录的会话（含 DSH 侧产物、子会话）
 *   2) 这些会话在**当前进程配置的状态目录**里的 per-run 数据
 *   3) `%TEMP%` 根下遗留的扁平状态目录（旧版套件）
 *   4) 投影缓存里的测试孤儿（会话早没了、缓存还在）
 *   5) 测试工作区登记
 */
export function sweepTestResidue({ dryRun = false, tmpRoot = tmpdir(), minOrphanAgeMs = 60_000 } = {}) {
  const sessions = purgeTestSessions({ dryRun });
  const headerCwds = new Map(sessions.victims.map((v) => [v.id, v.cwd]));
  // 被扫荡会话的 per-run 数据 + 状态目录里其它有证据的测试条目（会话目录早没了的那种）。
  const project = purgeProjectState({ ids: sessions.victims.map((v) => v.id), headerCwds, dryRun });
  const stale = sweepStateDir({ state: defaultState(), dryRun });
  for (const k of Object.keys(project.removed)) project.removed[k] += stale.removed[k];
  project.refused.push(...stale.refused);
  project.errors.push(...stale.errors);
  const legacy = sweepLegacyTmpState({ dir: tmpRoot, dryRun });
  const orphans = purgeOrphanProjcache({ dryRun, minAgeMs: minOrphanAgeMs });
  const workspaces = pruneTestWorkspaces({ dryRun });
  return { sessions, project, legacy, orphans, workspaces };
}
