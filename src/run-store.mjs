/** Durable run receipts, results and crash recovery.
 * The paths argument supplies runSentinelPath and runMarkerPath. The caller
 * provides the interrupted result when recovery needs session permission data.
 */
import {
  existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { REVIEWS_DIR, RUNS_DIR, SENTINEL_TTL_MS } from './config.mjs';
import { writeJsonAtomic } from './fs-atomic.mjs';
import { assertSafeId } from './ids.mjs';
import { L } from './lang.mjs';
import { isPidAlive, processStartTime } from './locks.mjs';
import { sanitizeApprovalContext } from './redact.mjs';
import { keyedRunId, laterStartedRun } from './run-ledger.mjs';
import { SENTINEL_SCHEMA, pruneDirTree, sanitizeResultForSentinel } from './sentinel.mjs';

/** 本进程的启动时刻：回合标记里记下它，下次启动据此识别"PID 被别的进程复用了"。 */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
/** 标记里的启动时刻与实际进程启动时刻相差多少以内算同一个进程。 */
const OWNER_START_TOLERANCE_MS = 2 * 60 * 1000;

// ── 异步完成哨兵 ────────────────────────────────────────────────
//
// 一个 run 终止（done/error/cancelled）时写一个独立小文件，让调用方能用
// 文件系统等待完成（Bash run_in_background + `until [ -f ]`），无需轮询 MCP 工具。
//
// 并发正确性要点：
//   - 路径按 conversation_id 分目录 → 不同会话即使同毫秒生成同名 run_id 也不串台；
//     同一会话内 dsh_send 忙时直接拒绝、run 序号单调递增，故会话内 run_id 唯一。
//   - 从临时文件用硬链接首次发布终态，替换运行标记时用 rename。两种操作都让读者看到完整文件；
//     每个 run 用自己带 pid/随机后缀的 tmp，绝不共用同一个 tmp（避免并发写互相覆盖）。
//   - 闩锁语义 → 文件写一次并保留：即便 run 在等待方启动前就已完成，`[ -f ]` 立刻为真。
//   - 文件内含最终 result → 收活可直接读文件，不依赖内存里的 run 记录
//     （内存只留最近 MAX_RUNS 条，并发多 run 时旧记录会被挤掉；文件不受此限，还扛服务重启）。

/** 某个 run 的完成哨兵文件路径。 */
export function runSentinelPath(conversationId, runId) {
  assertSafeId(conversationId, 'conversation_id');
  assertSafeId(runId, 'run_id');
  return join(RUNS_DIR, conversationId, `${runId}.json`);
}

/**
 * 写完成哨兵（原子）。
 * @returns {string|null} 成功返回文件路径；失败返回 null，并把原因记进 run.sentinel_error。
 *
 * 失败不阻断回合收尾，但**必须让调用方看得见**：以前只记 silent 日志，
 * 调用方会拿着一个永远不会出现的路径一直等。
 */
export function writeRunSentinel(paths, conversationId, run, log) {
  const file = paths.runSentinelPath(conversationId, run.run_id);
  try {
    publishRunSentinel(file, paths.runMarkerPath(conversationId, run.run_id), runSentinelPayload(conversationId, run));
    return file;
  } catch (e) {
    const msg = L(`写完成哨兵失败（${file}）: ${e.message}`, `Failed to write completion sentinel (${file}): ${e.message}`);
    run.sentinel_error = msg;
    log.info(`[hub] ${msg}`);
    return null;
  }
}

export function setRunApprovalPending(paths, conversationId, runId, pending, log) {
  const file = paths.runSentinelPath(conversationId, runId) + '.approval';
  try {
    if (pending) writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    else rmSync(file, { force: true });
  } catch (error) {
    if (!(pending && error.code === 'EEXIST')) log.info(`[hub] Approval wake-up file: ${error.message}`);
  }
}

function publishRunSentinel(file, marker, payload) {
  // Keep the key before the result becomes visible and before releasing the running marker.
  if (payload.client_run_id) {
    retainRunKey(dirname(file), keyedRunId(payload.client_run_id), payload.run_id);
  }
  try {
    writeRunJson(file, payload, { exclusive: true });
  } catch (e) {
    // 正常收尾和并发恢复都保留第一个落地的终态。
    if (e.code !== 'EEXIST') throw e;
  }
  try { rmSync(file + '.approval', { force: true }); } catch {}
  try { rmSync(marker, { force: true }); } catch {}
}

// ── 持久化回合收据 ───────────────────────────────────────────────
//
// 接单前写 `<RUNS_DIR>/<会话>/<run_id>.running`，记录幂等键、状态及所属进程。
// 写出哨兵时删除收据。恢复时用收据补写取消或中断终态，避免重新执行带副作用的任务。

export function runMarkerPath(conversationId, runId) {
  assertSafeId(conversationId, 'conversation_id');
  assertSafeId(runId, 'run_id');
  return join(RUNS_DIR, conversationId, `${runId}.running`);
}

/** 先持久化收据，再接单。硬链接原子占位，同时阻止另一个进程接受同一个幂等键。
 * @param {import('./types.mjs').RunRecord} run
 */
export function reserveRun(paths, conversationId, run) {
  const marker = paths.runMarkerPath(conversationId, run.run_id);
  const sentinel = paths.runSentinelPath(conversationId, run.run_id);
  const duplicate = () => new Error(L(
    `回合 ${run.run_id} 已被接收，请用原 client_run_id 重试或用 dsh_get 查询。`,
    `Run ${run.run_id} was already accepted. Retry with the same client_run_id or look it up with dsh_get.`,
  ));
  const keyFile = run.client_run_id ? join(dirname(sentinel), keyedRunId(run.client_run_id) + '.key') : null;
  const completed = () => existsSync(sentinel) || (keyFile && existsSync(keyFile));
  if (completed()) throw duplicate();
  try {
    writeRunMarker(marker, conversationId, run, { exclusive: true });
  } catch (e) {
    if (e.code === 'EEXIST') throw duplicate();
    throw e;
  }
  // 旧主人可能在第一次检查后写完哨兵并释放了占位。
  if (completed()) {
    rmSync(marker, { force: true });
    throw duplicate();
  }
}

function writeRunMarker(file, conversationId, run, { checkpoint = undefined, exclusive = false, mtime = undefined } = {}) {
  writeRunJson(file, {
    conversation_id: conversationId,
    run_id: run.run_id,
    client_run_id: run.client_run_id ?? null,
    prompt_preview: sanitizeApprovalContext(run.prompt_preview ?? null, 'prompt_preview'),
    review_mode: run.review_mode ?? null,
    status: run.status,
    started_at: run.started_at ?? null,
    start_order: run.start_order ?? null,
    owner_pid: process.pid,
    owner_started_at: PROCESS_STARTED_AT,
    ...(checkpoint ? { checkpoint } : {}),
  }, { exclusive, mtime });
}

export function markRunStarted(paths, conversationId, run) {
  writeRunMarker(paths.runMarkerPath(conversationId, run.run_id), conversationId, run);
}

/** ACP 已结束，先把脱敏终态写进收据。最终哨兵仍在 Git 快照完成后发布。 */
export function checkpointRunResult(paths, conversationId, run, result, status, endedAt, log) {
  try {
    const marker = paths.runMarkerPath(conversationId, run.run_id);
    if (!existsSync(marker)) return; // 关闭流程可能已经写出了中断哨兵。
    const checkpoint = runSentinelPayload(conversationId, { ...run, status, ended_at: endedAt, result });
    writeRunMarker(marker, conversationId, run, { checkpoint });
  } catch (e) {
    log.info(`[hub] 回合 ${run.run_id} 的终态暂存失败: ${e.message}`);
  }
}

export function readStoredRun(paths, conversationId, runId) {
  const sentinel = paths.runSentinelPath(conversationId, runId);
  const marker = paths.runMarkerPath(conversationId, runId);
  const terminal = () => {
    const saved = readRunJson(sentinel);
    if (!saved) return null;
    return storedSentinel(saved, sentinel);
  };
  // 哨兵可能在两次读之间替换标记。再读一次，避免把已接单回合误报成不存在。
  const saved = terminal();
  if (saved) return saved;
  const pending = readRunJson(marker);
  if (!pending) {
    const completed = terminal();
    if (completed || !KEYED_RUN.test(runId)) return completed;
    const key = readRunJson(join(dirname(sentinel), runId + '.key'));
    if (!key) return null;
    // Older versions used an unkeyed filename. Its result may still be present.
    if (LEGACY_RUN.test(key.run_id)) {
      const legacy = readStoredRun(paths, conversationId, key.run_id);
      if (legacy) return legacy;
    }
    return { conversation_id: conversationId, run_id: key.run_id, source: 'receipt',
      status: 'result_unavailable', result_available: false, result: null };
  }
  const { checkpoint: _checkpoint, ...receipt } = pending;
  return { ...receipt, status: receipt.status ?? 'running', source: 'receipt', result: null };
}

export async function readLatestStoredRun(paths, conversationId) {
  const dir = dirname(paths.runSentinelPath(conversationId, 'run'));
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let latest = null;
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== '.json' && ext !== '.running') continue;
    const runId = entry.name.slice(0, -ext.length);
    try { assertSafeId(runId, 'run_id'); } catch { continue; }
    const file = join(dir, entry.name);
    let saved;
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' && ext === '.running') {
        // It may have finished since readdir and published its sentinel.
        saved = readStoredRun(paths, conversationId, runId);
      } else if (e.code === 'ENOENT' || e instanceof SyntaxError) continue;
      else throw e;
    }
    if (saved?.conversation_id !== conversationId || saved.run_id !== runId) continue;
    if (ext === '.running' && !saved.result) {
      if (saved.status !== 'running' || !Number.isFinite(saved.started_at)) continue;
      const { checkpoint: _checkpoint, ...receipt } = saved;
      saved = { ...receipt, source: 'receipt', result: null };
    } else if (!saved.result || !Number.isFinite(saved.ended_at)) continue;
    if (latest?.run_id === runId) {
      if (saved.result) latest = saved;
    } else latest = laterStartedRun(latest, saved);
  }
  if (latest?.source === 'receipt') return latest;
  return latest ? storedSentinel(latest, paths.runSentinelPath(conversationId, latest.run_id)) : null;
}

export function findRunByClientId(paths, conversationId, clientRunId) {
  if (!clientRunId) return null;
  const exact = readStoredRun(paths, conversationId, keyedRunId(clientRunId));
  if (exact) return exact.result_available === false ? { ...exact, client_run_id: clientRunId } : exact;
  // 0.7.0 及以前的哨兵和活跃标记已存幂等键，但文件名是普通 run_id。
  const dir = dirname(paths.runSentinelPath(conversationId, 'run'));
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    const match = /^(run-[a-z0-9]+-\d+)\.(?:json|running)$/.exec(file);
    if (!match) continue;
    const legacy = readStoredRun(paths, conversationId, match[1]);
    if (legacy?.client_run_id === clientRunId) return legacy;
  }
  return null;
}

/**
 * 启动时：恢复已暂存的 ACP 结果，或给未完成的回合补写中断/取消哨兵。
 *
 * 只认领主人确实不在了的标记：PID 不存在，或 PID 还在但启动时刻对不上（被别的进程复用了）。
 * 读不到启动时刻时按"还活着"处理 —— 宁可不补，也不能给另一个实例正在跑的回合写一个假的终态。
 * @returns 补写了哪些 `[{conversation_id, run_id, sentinel_file}]`
 */
export function recoverInterruptedRuns(paths, writeInterrupted, log, { alive = isPidAlive, startTimeOf = processStartTime } = {}) {
  const recovered = [];
  // 读启动时刻要起一个子进程（Windows 上是 PowerShell）：同一个主人的多个标记只查一次。
  const startTimes = new Map();
  const startTime = (pid) => {
    if (!startTimes.has(pid)) startTimes.set(pid, startTimeOf(pid));
    return startTimes.get(pid);
  };
  let convDirs = [];
  try {
    convDirs = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  } catch {
    return recovered;
  }
  for (const dir of convDirs) {
    let files = [];
    try {
      files = readdirSync(join(RUNS_DIR, dir.name));
    } catch {
      continue;
    }
    backfillRunKeys(join(RUNS_DIR, dir.name), files, log);
    for (const f of files.filter(name => name.endsWith('.running'))) {
      const markerFile = join(RUNS_DIR, dir.name, f);
      let m;
      try {
        m = JSON.parse(readFileSync(markerFile, 'utf8'));
        assertSafeId(m.conversation_id, 'conversation_id');
        assertSafeId(m.run_id, 'run_id');
        if (m.conversation_id !== dir.name || `${m.run_id}.running` !== f) throw new Error('marker path mismatch');
      } catch {
        continue; // 看不懂的文件不碰（也不删：不是我们能确认的东西）
      }
      if (alive(m.owner_pid)) {
        const actual = startTime(m.owner_pid);
        const reused = Number.isFinite(actual) && Number.isFinite(m.owner_started_at) &&
          Math.abs(actual - m.owner_started_at) > OWNER_START_TOLERANCE_MS;
        if (!reused) continue; // 主人还在跑这个回合
      }
      const sentinel = paths.runSentinelPath(m.conversation_id, m.run_id);
      if (existsSync(sentinel)) {
        try { rmSync(sentinel + '.approval', { force: true }); } catch {}
        try { rmSync(markerFile, { force: true }); } catch {}
        continue;
      }
      let file;
      if (m.checkpoint?.schema === SENTINEL_SCHEMA && m.checkpoint.conversation_id === m.conversation_id &&
          m.checkpoint.run_id === m.run_id && m.checkpoint.result) {
        try {
          publishRunSentinel(sentinel, markerFile, m.checkpoint);
          file = sentinel;
        } catch (e) {
          log.info(`[hub] 恢复回合 ${m.run_id} 的终态失败: ${e.message}`);
        }
      } else {
        file = writeInterrupted(m.conversation_id, m);
      }
      if (file) recovered.push({ conversation_id: m.conversation_id, run_id: m.run_id, sentinel_file: file });
    }
  }
  return recovered;
}

/**
 * 把调用方的审核裁决回写进该 run 的哨兵文件（best-effort）。
 *
 * 为什么回写：异步调用方收活主要靠读哨兵。若审核后哨兵仍写着 `review.status=pending`，
 * 下一次读文件会得到一个与事实相反的状态。原子重写不破坏闩锁语义：文件始终存在，
 * 内容要么是旧的完整版本，要么是新的完整版本。
 */
export function updateRunSentinelReview(paths, conversationId, runId, review, log) {
  const file = paths.runSentinelPath(conversationId, runId);
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
    result.review = {
      ...(result.review && typeof result.review === 'object' ? result.review : {}),
      ...review,
    };
    payload.result = result;
    payload.reviewed_at = review.reviewed_at ?? null;
    writeRunJson(file, payload);
    return true;
  } catch (e) {
    log.info(`[hub] 回写哨兵审核状态失败（${file}）: ${e.message}`);
    return false;
  }
}

/**
 * 启动时清理过期哨兵（默认 7 天前）与崩溃残留的 .tmp 文件。
 *
 * 哨兵内含完整正文，不清理会无声堆积。设为 DSH_MCP_SENTINEL_TTL_MS=0 可关闭。
 * 只在服务启动时做一次，因此绝不会删掉"当前正在等待的"哨兵（那时它还不需要存在）。
 */
export function pruneSentinels({ ttlMs = SENTINEL_TTL_MS } = {}) {
  const runs = pruneDirTree(RUNS_DIR, ttlMs);
  // 审核记录同样含正文/理由，按同一 TTL 清理；目录分开是为了语义清晰，
  // 也避免一次清理把"刚提交的裁决"和"已完成的哨兵"混为一谈。
  const reviews = pruneDirTree(REVIEWS_DIR, ttlMs);
  return {
    pruned: runs.pruned,
    dirs_removed: runs.dirs_removed,
    reviews_pruned: reviews.pruned,
    review_dirs_removed: reviews.dirs_removed,
  };
}

/** 删除某个 run 的哨兵（起跑前防御性清残留；调用方消费后也可自行删）。 */
export function clearRunSentinel(paths, conversationId, runId) {
  try {
    rmSync(paths.runSentinelPath(conversationId, runId), { force: true });
  } catch {
    /* 忽略：清理失败不影响任何主流程 */
  }
}

/** @returns {import('./types.mjs').SentinelPayload} */
function runSentinelPayload(conversationId, run) {
  return {
    schema: SENTINEL_SCHEMA,
    conversation_id: conversationId,
    run_id: run.run_id,
    client_run_id: run.client_run_id ?? null,
    status: run.status ?? 'unknown',
    started_at: run.started_at ?? null,
    start_order: run.start_order ?? null,
    ended_at: run.ended_at ?? Date.now(),
    error: sanitizeApprovalContext(run.error ?? run.result?.error ?? null, 'error'),
    result: sanitizeResultForSentinel(run.result ?? null),
  };
}

function storedSentinel(saved, file) {
  return {
    ...saved,
    source: 'sentinel',
    elapsed_ms: saved.result?.elapsed_ms ?? null,
    prompt_preview: saved.prompt_preview ?? null,
    result: saved.result ? { ...saved.result, sentinel_file: file } : null,
  };
}

const KEYED_RUN = /^run-key-[a-f0-9]{64}$/;
const LEGACY_RUN = /^run-[a-z0-9]+-\d+$/;

function retainRunKey(dir, keyId, runId, mtime) {
  try {
    writeRunJson(join(dir, keyId + '.key'), { run_id: runId }, { exclusive: true, mtime });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// On upgrade protect retained sentinels, including those read directly from disk.
// Preserve their age so restarting never extends the retention period.
function backfillRunKeys(dir, files, log) {
  const known = new Set(files);
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -5);
    if (known.has(runId + '.key')) continue;
    const file = join(dir, name);
    try {
      let keyId = runId;
      if (!KEYED_RUN.test(runId)) {
        if (!LEGACY_RUN.test(runId)) continue;
        const saved = readRunJson(file);
        if (typeof saved?.client_run_id !== 'string' || !saved.client_run_id || saved.run_id !== runId) continue;
        keyId = keyedRunId(saved.client_run_id);
        if (known.has(keyId + '.key')) continue;
      }
      const stat = statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) retainRunKey(dir, keyId, runId, stat.mtime);
    } catch (error) {
      log.info(`[hub] Could not migrate the idempotency receipt for ${file}: ${error.message}. Keep the result file and retry on restart.`);
    }
  }
}

function writeRunJson(file, value, { exclusive = false, mtime = undefined } = {}) {
  writeJsonAtomic(file, value, { mode: 0o600, exclusive, mtime });
}

function readRunJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
    throw e;
  }
}
