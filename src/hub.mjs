/**
 * 注册表（Hub）：持有全部会话、共享进程池、哨兵/审核记录的读写与回收。
 *
 * 会话本体（Conversation）在 conversation.mjs；从这里拆出的纯函数模块（git 快照、
 * 哨兵脱敏、cwd 边界、元数据侧车/墓碑、ACP 线格式）也都在本文件里重新导出，
 * 所以外部一直写的 `from '../src/hub.mjs'` 仍然成立。
 *
 * 核心设计：**一个会话 = 一个 DSH ACP 进程**。
 * 进程只是"缓存"，不是"身份"——对话的身份是 DSH 的 sessionId，落盘在 DSH 的会话目录里。
 * 因此进程死掉/被回收/整体重启后，用 session/resume 就能接着聊（ACP 实测支持跨进程恢复）。
 *
 * 日志与持久化红线：
 *   - 会话状态文件只存元数据（id/cwd/权限/别名/计数），**不存任何对话内容**。
 *   - 思考内容不写日志；**默认也不落盘**。
 *     - 唯一的落盘例外是"异步完成哨兵"：它需要带上结果正文（answer）才能让调用方离线收活，
 *       所以正文会写进 `<RUNS_DIR>/...`。但思考内容默认会被**剥掉**
 *       （需 DSH_MCP_SENTINEL_INCLUDE_REASONING=1 才一并写入，那会打破本保证）。
 */

import {
  copyFileSync,
  cpSync,
  mkdirSync,
  linkSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  rmSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  ALLOW_FULL_ACCESS,
  APPROVAL_POLICIES,
  DAEMON_MODE,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  IDLE_TTL_MS,
  LIST_PROBE_TTL_MS,
  MAX_LIVE,
  MAX_RSS_MB,
  PERMISSION_TIERS,
  REAP_INTERVAL_MS,
  REASONING_EFFORTS,
  REVIEWS_DIR,
  REVIEW_MODES,
  RUNS_DIR,
  SENTINEL_TTL_MS,
  SHARED_PROCESS,
  STATE_FILE,
  LEGACY_STATE_FILE,
  USING_DEFAULT_STATE,
  assertWritableDir,
  defaultApprovalPolicy,
  effectiveApprovalPolicy,
} from './config.mjs';
import { normalizeReviewMode } from './review.mjs';
import { sanitizeApprovalContext } from './redact.mjs';
import { assertSafeId } from './ids.mjs';
import { L } from './lang.mjs';
import { AcpProcess } from './acp.mjs';
import { applySessionConfig } from './acp-session.mjs';
import { SessionHost } from './host.mjs';
import { refreshRssMap, rssMb } from './procstat.mjs';
import { readConversationMeta } from './titles.mjs';
import { Conversation } from './conversation.mjs';
import { keyedRunId } from './run-ledger.mjs';
import { SENTINEL_SCHEMA, pruneDirTree, sanitizeResultForSentinel } from './sentinel.mjs';
import { emitLive, livePreview } from './live.mjs';
import { homeWorkspaceProblem } from './workspace-guard.mjs';
import { registerWorkspace, findSessionHeaderStatus } from './workspace.mjs';
import { ISOLATION_MODES, createWorktree, discardWorktree } from './worktree.mjs';
import {
  META_DIR,
  NOOP_LOG,
  forgottenPath,
  isForgotten,
  pruneStaleTombstones,
  readConversationMetaFile,
  writeConversationMeta,
} from './hub-store.mjs';
import {
  LOCKS_DIR,
  heartbeat as lockHeartbeat,
  isPidAlive,
  processStartTime,
  removeMarker,
  writeMarker,
} from './locks.mjs';
import { attachReview, terminalResult } from './run-result.mjs';

// 外部（测试、bin）一直从 hub.mjs 取这些函数；拆出去之后导入路径保持不变。
export { Conversation, formatReasoning } from './conversation.mjs';
export { fsCaseInsensitive, homeWorkspaceProblem } from './workspace-guard.mjs';
export { gitStatus, sameWorkspaceSnapshot } from './git-snapshot.mjs';
export { sanitizeResultForSentinel } from './sentinel.mjs';

const now = () => Date.now();
/** 本进程的启动时刻：回合标记里记下它，下次启动据此识别"PID 被别的进程复用了"。 */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
/** 标记里的启动时刻与实际进程启动时刻相差多少以内算同一个进程。 */
const OWNER_START_TOLERANCE_MS = 2 * 60 * 1000;

// ── 注册表 ────────────────────────────────────────────────────────

export class Hub {
  constructor({ log } = {}) {
    this.conversations = new Map();
    /** 共享 ACP 进程池：key = `${cwd}\0${permission}`（0.5.0 起默认启用，`DSH_MCP_SHARED_PROCESS=0` 关闭）。 */
    this.hosts = new Map();
    this.log = log ?? NOOP_LOG;
    /** 最近一次 dsh_list 磁盘探测的结果：{ok, error, cached, at}。 */
    this.lastProbe = { ok: null, error: null, cached: false, at: 0 };
    const rawApprovalTimeout = Number(process.env.DSH_MCP_APPROVAL_TIMEOUT_MS ?? 5 * 60 * 1000);
    // 空串会变成 0 / NaN → setTimeout(0) 会把 ask 审批立刻取消；统一回落到 5 分钟。
    this.approvalTimeoutMs =
      Number.isFinite(rawApprovalTimeout) && rawApprovalTimeout > 0 ? rawApprovalTimeout : 5 * 60 * 1000;
    this.#reaper = null;
  }

  #reaper;
  /** 已收到 ACP 结果，仍在生成工作区快照及写入哨兵的回合。 */
  #finalizingRuns = new Map();
  /** 同一 id 的磁盘接管 in-flight Promise，防止并发请求各自构造一个 Conversation。 */
  #adopting = new Map();
  /** 本实例从注册表移除过的会话 id（save 合并盘上条目时跳过）。 */
  #removed = new Set();
  /** `dsh_list` 磁盘探测的短缓存（探测要 spawn 一个 DSH 进程，实测约 1 秒）。 */
  #probeCache = null;

  async load() {
    // ★ 启动即确认三个关键目录可写。以前"写失败只记 silent 日志"会让服务
    //   看起来正常，但注册表/哨兵/锁登记全部丢失，异步等待永远醒不过来。
    assertWritableDir(dirname(STATE_FILE), '状态目录');
    assertWritableDir(RUNS_DIR, '哨兵目录');
    assertWritableDir(REVIEWS_DIR, '审核记录目录');
    assertWritableDir(LOCKS_DIR, '锁登记目录');

    // 旧版本的默认状态文件在包安装目录里；一次性迁移到新的用户可写目录。
    // 只在没有显式设置 DSH_MCP_STATE 时做，避免覆盖用户指定的路径。
    if (USING_DEFAULT_STATE && !existsSync(STATE_FILE) && existsSync(LEGACY_STATE_FILE)) {
      try {
        copyFileSync(LEGACY_STATE_FILE, STATE_FILE);
        this.log.info(`[hub] 已迁移旧状态文件: ${LEGACY_STATE_FILE} → ${STATE_FILE}`);
        // 侧车元数据（审批策略/思考深度/标题/轮数）也一并搬过来；
        // 否则旧会话按 id 重建时会悄悄回落到默认值。
        const legacyMeta = join(dirname(LEGACY_STATE_FILE), 'meta');
        if (existsSync(legacyMeta) && !existsSync(META_DIR)) {
          cpSync(legacyMeta, META_DIR, { recursive: true });
          this.log.info(`[hub] 已迁移旧元数据侧车: ${legacyMeta} → ${META_DIR}`);
        }
      } catch (e) {
        this.log.info(`[hub] 旧状态文件迁移失败（继续用新路径）: ${e.message}`);
      }
    }

    const stale = await pruneStaleTombstones(this.log);
    if (stale) this.log.info(`[hub] 清理 ${stale} 个失效的 forget 墓碑`);
    if (!existsSync(STATE_FILE)) return;
    try {
      const doc = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const s of doc.conversations ?? []) {
        if (!s?.id || !s?.cwd) continue;
        if (isForgotten(s.id)) continue;
        this.conversations.set(s.id, new Conversation(s, this));
      }
      this.log.info(`[hub] 载入 ${this.conversations.size} 个会话`);
    } catch (e) {
      this.log.info(`[hub] 状态文件读取失败: ${e.message}`);
    }
  }

  /** 原子保存。**tmp 名必须唯一**：多个 dsh-any-agent 实例共用同一份注册表时，
   * 固定名（`<STATE_FILE>.tmp`）会让并发保存互相踩踏 —— 先写的被后写的覆盖，
   * rename 甚至可能发布出别人的内容或半截文件。哨兵那边早就是这么做的。 */
  save() {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      // ★ 多实例共用一份注册表：只写自己内存里的会话，会把另一个实例刚加进去的条目覆盖掉，
      //   并把它跑出来的轮数写回旧值（审计 C03）。所以先读盘上的版本合并：
      //   - 盘上有、内存里没有、也没被 forget 的条目原样保留；
      //   - 轮数与最近使用时间只增不减。
      let onDisk = [];
      try {
        onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8')).conversations ?? [];
      } catch {
        /* 还没有注册表 / 读不出来：只写自己的 */
      }
      const extra = [];
      for (const s of onDisk) {
        if (!s?.id || !s?.cwd) continue;
        const mine = this.conversations.get(s.id);
        if (mine) {
          if (Number.isFinite(s.turnCount) && s.turnCount > mine.turnCount) mine.turnCount = s.turnCount;
          if (Number.isFinite(s.lastUsedAt) && s.lastUsedAt > mine.lastUsedAt) mine.lastUsedAt = s.lastUsedAt;
        } else if (!this.#removed.has(s.id) && !isForgotten(s.id)) {
          extra.push(s);
        }
      }
      const doc = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations: [...[...this.conversations.values()].map((c) => c.toState()), ...extra],
      };
      const tmp = `${STATE_FILE}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(tmp, STATE_FILE);
      // 侧车元数据独立于注册表：forget 移除注册表条目后仍然保留，
      // 让按 id 重建的会话不会丢掉审批策略/思考深度/标题/轮数。
      for (const c of this.conversations.values()) writeConversationMeta(c);
    } catch (e) {
      this.log.info(`[hub] 状态保存失败: ${e.message}`);
    }
  }

  // ── 异步完成哨兵 ────────────────────────────────────────────────
  //
  // 一个 run 终止（done/error/cancelled）时写一个独立小文件，让调用方能用
  // 文件系统等待完成（Bash run_in_background + `until [ -f ]`），无需轮询 MCP 工具。
  //
  // 并发正确性要点：
  //   - 路径按 conversation_id 分目录 → 不同会话即使同毫秒生成同名 run_id 也不串台；
  //     同一会话内 dsh_send 忙时直接拒绝、run 序号单调递增，故会话内 run_id 唯一。
  //   - tmp + rename 原子落地 → 文件一旦存在，内容必然完整（等待方不会读到半截）；
  //     每个 run 用自己带 pid/随机后缀的 tmp，绝不共用同一个 tmp（避免并发写互相覆盖）。
  //   - 闩锁语义 → 文件写一次并保留：即便 run 在等待方启动前就已完成，`[ -f ]` 立刻为真。
  //   - 文件内含最终 result → 收活可直接读文件，不依赖内存里的 run 记录
  //     （内存只留最近 MAX_RUNS 条，并发多 run 时旧记录会被挤掉；文件不受此限，还扛服务重启）。

  /** 某个 run 的完成哨兵文件路径。 */
  runSentinelPath(conversationId, runId) {
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
  writeRunSentinel(conversationId, run) {
    const file = this.runSentinelPath(conversationId, run.run_id);
    try {
      mkdirSync(dirname(file), { recursive: true });
      this.#publishRunSentinel(file, this.runMarkerPath(conversationId, run.run_id), runSentinelPayload(conversationId, run));
      return file;
    } catch (e) {
      const msg = `写完成哨兵失败（${file}）: ${e.message}`;
      run.sentinel_error = msg;
      this.log.info(`[hub] ${msg}`);
      return null;
    }
  }

  #publishRunSentinel(file, marker, payload) {
    try {
      writeRunJson(file, payload, { exclusive: true });
    } catch (e) {
      // 正常收尾和并发恢复都保留第一个落地的终态。
      if (e.code !== 'EEXIST') throw e;
    }
    try { rmSync(marker, { force: true }); } catch {}
  }

  // ── 持久化回合收据 ───────────────────────────────────────────────
  //
  // 接单前写 `<RUNS_DIR>/<会话>/<run_id>.running`，记录幂等键、状态及所属进程。
  // 写出哨兵时删除收据。恢复时用收据补写取消或中断终态，避免重新执行带副作用的任务。

  runMarkerPath(conversationId, runId) {
    assertSafeId(conversationId, 'conversation_id');
    assertSafeId(runId, 'run_id');
    return join(RUNS_DIR, conversationId, `${runId}.running`);
  }

  /** 先持久化收据，再接单。硬链接原子占位，同时阻止另一个进程接受同一个幂等键。 */
  reserveRun(conversationId, run) {
    const marker = this.runMarkerPath(conversationId, run.run_id);
    const sentinel = this.runSentinelPath(conversationId, run.run_id);
    const duplicate = () => new Error(L(
      `回合 ${run.run_id} 已被接收，请用原 client_run_id 重试或用 dsh_get 查询。`,
      `Run ${run.run_id} was already accepted. Retry with the same client_run_id or look it up with dsh_get.`,
    ));
    if (existsSync(sentinel)) throw duplicate();
    try {
      this.#writeRunMarker(marker, conversationId, run, { exclusive: true });
    } catch (e) {
      if (e.code === 'EEXIST') throw duplicate();
      throw e;
    }
    // 旧主人可能在第一次检查后写完哨兵并释放了占位。
    if (existsSync(sentinel)) {
      rmSync(marker, { force: true });
      throw duplicate();
    }
  }

  #writeRunMarker(file, conversationId, run, { checkpoint, ...options } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    writeRunJson(file, {
      conversation_id: conversationId,
      run_id: run.run_id,
      client_run_id: run.client_run_id ?? null,
      prompt_preview: sanitizeApprovalContext(run.prompt_preview ?? null, 'prompt_preview'),
      review_mode: run.review_mode ?? null,
      status: run.status,
      started_at: run.started_at ?? null,
      owner_pid: process.pid,
      owner_started_at: PROCESS_STARTED_AT,
      ...(checkpoint ? { checkpoint } : {}),
    }, options);
  }

  markRunStarted(conversationId, run) {
    this.#writeRunMarker(this.runMarkerPath(conversationId, run.run_id), conversationId, run);
  }

  /** ACP 已结束，先把脱敏终态写进收据。最终哨兵仍在 Git 快照完成后发布。 */
  checkpointRunResult(conversationId, run, result, status, endedAt) {
    try {
      const marker = this.runMarkerPath(conversationId, run.run_id);
      if (!existsSync(marker)) return; // 关闭流程可能已经写出了中断哨兵。
      const checkpoint = runSentinelPayload(conversationId, { ...run, status, ended_at: endedAt, result });
      this.#writeRunMarker(marker, conversationId, run, { checkpoint });
    } catch (e) {
      this.log.info(`[hub] 回合 ${run.run_id} 的终态暂存失败: ${e.message}`);
    }
  }

  readStoredRun(conversationId, runId) {
    const sentinel = this.runSentinelPath(conversationId, runId);
    const marker = this.runMarkerPath(conversationId, runId);
    const terminal = () => {
      const saved = readRunJson(sentinel);
      if (!saved) return null;
      return storedSentinel(saved, sentinel);
    };
    // 哨兵可能在两次读之间替换标记。再读一次，避免把已接单回合误报成不存在。
    const saved = terminal();
    if (saved) return saved;
    const pending = readRunJson(marker);
    if (!pending) return terminal();
    const { checkpoint: _checkpoint, ...receipt } = pending;
    return { ...receipt, status: receipt.status ?? 'running', source: 'receipt', result: null };
  }

  async readLatestStoredRun(conversationId) {
    const dir = dirname(this.runSentinelPath(conversationId, 'run'));
    let files;
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let latest = null;
    let latestStartedAt = -Infinity;
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const runId = entry.name.slice(0, -'.json'.length);
      try { assertSafeId(runId, 'run_id'); } catch { continue; }
      const file = join(dir, entry.name);
      let saved;
      try {
        saved = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT' || e instanceof SyntaxError) continue;
        throw e;
      }
      if (saved?.conversation_id !== conversationId || saved.run_id !== runId || !saved.result ||
          !Number.isFinite(saved.ended_at)) continue;
      const startedAt = sentinelStartTime(saved);
      if (startedAt === null || startedAt < latestStartedAt) continue;
      if (startedAt === latestStartedAt && saved.ended_at < latest.ended_at) continue;
      if (startedAt === latestStartedAt && saved.ended_at === latest.ended_at && saved.run_id <= latest.run_id) continue;
      latest = saved;
      latestStartedAt = startedAt;
    }
    return latest ? storedSentinel(latest, this.runSentinelPath(conversationId, latest.run_id)) : null;
  }

  findRunByClientId(conversationId, clientRunId) {
    if (!clientRunId) return null;
    const exact = this.readStoredRun(conversationId, keyedRunId(clientRunId));
    if (exact) return exact;
    // 0.7.0 及以前的哨兵和活跃标记已存幂等键，但文件名是普通 run_id。
    const dir = dirname(this.runSentinelPath(conversationId, 'run'));
    if (!existsSync(dir)) return null;
    for (const file of readdirSync(dir)) {
      const match = /^(run-[a-z0-9]+-\d+)\.(?:json|running)$/.exec(file);
      if (!match) continue;
      const legacy = this.readStoredRun(conversationId, match[1]);
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
  recoverInterruptedRuns({ alive = isPidAlive, startTimeOf = processStartTime } = {}) {
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
        files = readdirSync(join(RUNS_DIR, dir.name)).filter((f) => f.endsWith('.running'));
      } catch {
        continue;
      }
      for (const f of files) {
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
        const sentinel = this.runSentinelPath(m.conversation_id, m.run_id);
        if (existsSync(sentinel)) {
          try { rmSync(markerFile, { force: true }); } catch {}
          continue;
        }
        let file;
        if (m.checkpoint?.schema === SENTINEL_SCHEMA && m.checkpoint.conversation_id === m.conversation_id &&
            m.checkpoint.run_id === m.run_id && m.checkpoint.result) {
          try {
            this.#publishRunSentinel(sentinel, markerFile, m.checkpoint);
            file = sentinel;
          } catch (e) {
            this.log.info(`[hub] 恢复回合 ${m.run_id} 的终态失败: ${e.message}`);
          }
        } else {
          file = this.#writeInterruptedSentinel(m.conversation_id, m);
        }
        if (file) recovered.push({ conversation_id: m.conversation_id, run_id: m.run_id, sentinel_file: file });
      }
    }
    return recovered;
  }

  /**
   * 给一个没跑完的回合写"已中断"哨兵（status=error，stop_reason=interrupted）。
   * 启动恢复（读回合标记）与本进程关闭（读内存里的 run）共用；`run` 只需 run_id / client_run_id /
   * prompt_preview / review_mode。
   */
  #writeInterruptedSentinel(conversationId, run) {
    const queued = run.status === 'queued';
    const error = queued ? L(
      '服务退出时任务仍在排队，已取消。请核对后用新的幂等键派发。',
      'The service exited while this run was queued. It was cancelled. Use a new idempotency key if it should run.',
    ) : L(
      '服务进程在回合结束前退出（客户端关闭、重连或崩溃），回合被中断；已改动的文件不会回滚。' +
        (DAEMON_MODE ? '' : '设 DSH_MCP_DAEMON=1 可让回合扛住客户端重启。'),
      'The server process exited before the turn ended (the client closed, reconnected or crashed), so the turn was interrupted; changed files are not rolled back.' +
        (DAEMON_MODE ? '' : ' Set DSH_MCP_DAEMON=1 to keep turns running across client restarts.'),
    );
    const record = {
      run_id: run.run_id,
      client_run_id: run.client_run_id ?? null,
      prompt_preview: run.prompt_preview ?? null,
      review_mode: normalizeReviewMode(run.review_mode, DEFAULT_REVIEW),
      status: queued ? 'cancelled' : 'error',
      error,
      started_at: run.started_at ?? null,
      ended_at: now(),
    };
    record.result = attachReview(
      terminalResult({ conversationId, runId: run.run_id, stopReason: queued ? 'cancelled' : 'interrupted', error }),
      {
        conversationId,
        run: record,
        mode: record.review_mode,
        permission: this.conversations.get(conversationId)?.permission ?? null,
      },
    );
    return this.writeRunSentinel(conversationId, record);
  }

  /**
   * 把调用方的审核裁决回写进该 run 的哨兵文件（best-effort）。
   *
   * 为什么回写：异步调用方收活主要靠读哨兵。若审核后哨兵仍写着 `review.status=pending`，
   * 下一次读文件会得到一个与事实相反的状态。原子重写不破坏闩锁语义：文件始终存在，
   * 内容要么是旧的完整版本，要么是新的完整版本。
   */
  updateRunSentinelReview(conversationId, runId, review) {
    const file = this.runSentinelPath(conversationId, runId);
    try {
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
      result.review = {
        ...(result.review && typeof result.review === 'object' ? result.review : {}),
        ...review,
      };
      payload.result = result;
      payload.reviewed_at = review.reviewed_at ?? null;
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, file);
      return true;
    } catch (e) {
      this.log.info(`[hub] 回写哨兵审核状态失败（${file}）: ${e.message}`);
      return false;
    }
  }

  /**
   * 启动时清理过期哨兵（默认 7 天前）与崩溃残留的 .tmp 文件。
   *
   * 哨兵内含完整正文，不清理会无声堆积。设为 DSH_MCP_SENTINEL_TTL_MS=0 可关闭。
   * 只在服务启动时做一次，因此绝不会删掉"当前正在等待的"哨兵（那时它还不需要存在）。
   */
  pruneSentinels({ ttlMs = SENTINEL_TTL_MS } = {}) {
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
  clearRunSentinel(conversationId, runId) {
    try {
      rmSync(this.runSentinelPath(conversationId, runId), { force: true });
    } catch {
      /* 忽略：清理失败不影响任何主流程 */
    }
  }

  async get(id) {
    // 会话 id 会参与 meta/tombstone/会话存储的路径拼接；先挡住路径分隔符与 `..`。
    assertSafeId(id, 'conversation_id');
    // ★ forget 是终态：墓碑存在时，任何按 id 的查询都必须明确失败，
    //   否则 DSH 会话存储里的记录会让它悄悄复活（"forget 不持久"）。
    if (isForgotten(id)) {
      throw new Error(L(
        `会话已被 forget（永久移除）: ${id}\n` +
          `  它不会再被按 id 自动恢复。确实要恢复的话，删除墓碑文件 ${forgottenPath(id)} 后重试。`,
        `This conversation was forgotten (removed for good): ${id}\n` +
          `  It is no longer restored by id. To bring it back anyway, delete the tombstone file ${forgottenPath(id)} and retry.`,
      ));
    }
    let c = this.conversations.get(id);
    if (!c) {
      // 多实例常见情形：这个会话是**另一个 dsh-any-agent 实例**刚建的，我们内存里的注册表还没有。
      // 先吸收一次磁盘状态再判定 —— 否则会把"别人的会话"误报成"未知会话"，用户一头雾水。
      this.adoptNewFromDisk();
      c = this.conversations.get(id);
    }
    if (!c) {
      // 同一个磁盘态会话的并发查询共用一次 adopt，避免各自构造 Conversation。
      const inflight = this.#adopting.get(id);
      if (inflight) {
        await inflight;
        c = this.conversations.get(id);
      }
    }
    if (!c) {
      // 最后一道：注册表里没有，但会话可能就在磁盘上 —— 别的实例建的、注册表被并发写覆盖丢的、
      // 或者根本是别的 profile / GUI 建的。**会话存储才是权威，注册表只是缓存。**
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      this.#adopting.set(id, gate);
      try {
      const found = await findSessionHeaderStatus(id);
      if (found.status === 'error') {
        throw new Error(L(`无法读取会话 ${id} 的会话头：${found.reason}`, `Cannot read the session header of ${id}: ${found.reason}`));
      }
      const header = found.header;
      if (header?.cwd) {
        // ★ 权限档必须取自**会话自己的记录**，不能一律套默认值：
        //   一个当初用 read-only 建的会话，若注册表丢了、被我们以默认档接管，
        //   resume 时 DSH_PERMISSION_MODE 会把档位写进会话 —— 等于**悄悄提权**。
        const meta = readConversationMeta(id);
        const persisted = readConversationMetaFile(id);
        const recordedPreset = meta?.permissions?.preset;
        const recordedPermission = PERMISSION_TIERS.includes(recordedPreset) ? recordedPreset : null;
        // 安全优先：会话记录说 read-only 就绝不能被侧车“提升”为可写档。
        // ★ 档位未知（没有投影缓存、也没有本服务侧车）时 **fail-closed 到 read-only**。
        //   以前回落到 DEFAULT_PERMISSION（danger-full-access），等于把一个可能是
        //   只读的外部会话悄悄提升为完全访问。宁可让用户显式新建会话，也不要无声提权。
        const permission =
          recordedPermission === 'read-only'
            ? 'read-only'
            : PERMISSION_TIERS.includes(persisted?.permission)
              ? persisted.permission
              : (recordedPermission ?? 'read-only');
        const recordedApproval = meta?.permissions?.approval;
        let onApproval = APPROVAL_POLICIES.includes(persisted?.onApproval)
          ? persisted.onApproval
          : APPROVAL_POLICIES.includes(recordedApproval)
            ? recordedApproval
            : defaultApprovalPolicy(permission);
        if (permission === 'read-only' && onApproval !== 'auto-deny') onApproval = 'auto-deny';
        c = new Conversation(
          {
            id,
            cwd: persisted?.cwd ?? header.cwd,
            permission,
            onApproval,
            titleHint: persisted?.titleHint ?? null,
            reasoningEffort: REASONING_EFFORTS.includes(persisted?.reasoningEffort)
              ? persisted.reasoningEffort
              : DEFAULT_REASONING_EFFORT,
            provider: persisted?.provider ?? null,
            model: persisted?.model ?? null,
            createdAt: persisted?.createdAt,
            lastUsedAt: persisted?.lastUsedAt,
            turnCount: persisted?.turnCount,
            review: REVIEW_MODES.includes(persisted?.review) ? persisted.review : DEFAULT_REVIEW,
            workspace: persisted?.workspace ?? null,
            worktree: persisted?.worktree ?? null,
          },
          this,
        );
        this.conversations.set(id, c);
        this.save();
        this.log.info(`[hub] 从会话存储吸收了 ${id}（注册表里没有，但磁盘上有；权限档沿用 ${permission}）`);
      }
      } finally {
        this.#adopting.delete(id);
        release();
      }
    }
    if (!c) {
      throw new Error(L(
        `未知会话: ${id}（用 dsh_list 查看可用会话；也可能是 id 写错了）`,
        `Unknown conversation: ${id} (use dsh_list to see the available ones; the id may also be mistyped)`,
      ));
    }
    return c;
  }

  /**
   * 只吸收磁盘上"本进程还没有的"会话（多实例场景）。
   * **绝不覆盖**内存里已有的会话 —— 那会把活进程引用与回合状态一起丢掉。
   * @returns {number} 新吸收的数量
   */
  adoptNewFromDisk() {
    if (!existsSync(STATE_FILE)) return 0;
    let added = 0;
    try {
      const doc = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const s of doc.conversations ?? []) {
        if (!s?.id || !s?.cwd) continue;
        if (isForgotten(s.id)) continue;
        if (this.conversations.has(s.id)) continue;
        this.conversations.set(s.id, new Conversation(s, this));
        added++;
      }
      if (added) this.log.info(`[hub] 从磁盘吸收了 ${added} 个别的实例新建的会话`);
    } catch (e) {
      this.log.info(`[hub] 吸收磁盘会话失败: ${e.message}`);
    }
    return added;
  }

  remove(id) {
    this.conversations.delete(id);
    // save() 会合并盘上的条目；本实例主动移除的不能被合并回来。
    this.#removed.add(id);
    // 注意：**不删侧车元数据**。forget 的语义是“从注册表移除”，
    // 之后按 id 重建（多实例恢复）时，侧车让审批策略/思考深度/标题/轮数不漂移。
    this.save();
  }

  /** 取（或建）同 `(cwd, permission)` 的共享 ACP 进程宿主。 */
  acquireHost(cwd, permission) {
    const key = `${cwd}\u0000${permission}`;
    let host = this.hosts.get(key);
    if (!host) {
      host = new SessionHost({ cwd, permission, log: this.log, hub: this });
      this.hosts.set(key, host);
    }
    return host;
  }

  forgetHost(host) {
    for (const [k, v] of this.hosts) {
      if (v === host) this.hosts.delete(k);
    }
  }

  /**
   * 共享进程下，某个子进程 PID 上还挂着哪些**别的**会话。
   *
   * 用途只有一个：`takeover` 要杀这个 PID 之前，先看看会不会连坐 ——
   * 杀一个还载着三个会话的宿主，代价是那三个会话的进行中回合一起断。
   * 只有本服务自己的宿主池查得清这件事；别的实例的宿主编号外部，查不到就只能让调用方
   * 自己用 `force` 承担。
   */
  hostVictimsOf(pid, exceptId) {
    if (!pid) return [];
    for (const host of this.hosts.values()) {
      if (host.pid !== pid) continue;
      return [...host.conversations.keys()].filter((id) => id !== exceptId);
    }
    return [];
  }

  /** 新建一个会话：拉起进程 + ACP 初始化 + session/new。 */
  async create({ cwd, permission = DEFAULT_PERMISSION, onApproval, titleHint, reasoningEffort, provider, model, keepAlive = false, review, isolation } = {}) {
    if (this.shuttingDown) throw new Error('Service is shutting down');
    if (!cwd) {
      throw new Error(L(
        '没有可用的工作目录。你既没传 cwd，客户端也没有提供当前打开的项目（MCP roots）。\n' +
          '  传一个项目目录即可，例如 cwd: "D:/code/my-project"。\n' +
          '  不要传用户家目录本身 —— 那会让 DSH 的 ACL 沙箱起不来。',
        'No working directory. You passed no cwd and the client did not report an open project (MCP roots).\n' +
          '  Pass a project directory, for example cwd: "D:/code/my-project".\n' +
          "  Do not pass the user's home directory itself: DSH's ACL sandbox cannot start there.",
      ));
    }
    if (!isAbsolute(cwd)) throw new Error(L(`cwd 必须是绝对路径: ${cwd}`, `cwd must be an absolute path: ${cwd}`));
    if (!existsSync(cwd)) {
      throw new Error(L(
        `工作区不存在或不是目录: ${cwd}（请先创建这个目录）`,
        `The workspace does not exist or is not a directory: ${cwd} (create the directory first)`,
      ));
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(L(
        `工作区不存在或不是目录: ${cwd}（这是一个文件路径，请传目录）`,
        `The workspace does not exist or is not a directory: ${cwd} (this is a file path; pass a directory)`,
      ));
    }
    const oneOf = (name, values) => L(`${name} 必须是 ${values.join(' | ')} 之一`, `${name} must be one of ${values.join(' | ')}`);
    if (!PERMISSION_TIERS.includes(permission)) {
      throw new Error(oneOf('permission', PERMISSION_TIERS));
    }
    // title_hint 会写进注册表与侧车，每一轮 save() 都会重复落盘；不设上限就是一个
    // 稳定的磁盘/内存放大点（调用方可以传任意长度）。可读标签 200 字足够。
    if (titleHint !== undefined && titleHint !== null) {
      if (typeof titleHint !== 'string') throw new Error(L('title_hint 必须是字符串', 'title_hint must be a string'));
      if (titleHint.length > 200) throw new Error(L('title_hint 最长 200 字符', 'title_hint may be at most 200 characters'));
    }
    // ★ 0.5.0：danger-full-access 不再默认可用。它把整机写权限交给调用方，
    //   而本服务可能被任何 MCP 客户端拉起；必须由机器所有者显式放行。
    if (permission === 'danger-full-access' && !ALLOW_FULL_ACCESS) {
      throw new Error(L(
        'permission=danger-full-access 需要机器侧允许：在客户端配置里把默认档设成它（DSH_MCP_PERMISSION=danger-full-access，' +
          '即 dsh-any-agent-setup --yes --permission danger-full-access），或设置 DSH_MCP_ALLOW_FULL_ACCESS=1，重连后重试。' +
          ' 否则请用 workspace-write（写入限制在工作区内）或 read-only。',
        'permission=danger-full-access must be allowed on this machine: make it the default in the client config ' +
          '(DSH_MCP_PERMISSION=danger-full-access, which dsh-any-agent-setup --yes --permission danger-full-access writes), ' +
          'or set DSH_MCP_ALLOW_FULL_ACCESS=1, then reconnect and retry. Otherwise use workspace-write (writes limited to the workspace) or read-only.',
      ));
    }
    const policy = onApproval ?? defaultApprovalPolicy(permission);
    if (!APPROVAL_POLICIES.includes(policy)) {
      throw new Error(oneOf('on_approval', APPROVAL_POLICIES));
    }
    // ★ read-only 是硬边界：显式 auto-allow/ask 会放行 DSH 的 sandbox 提权，
    //   实测能把文件写进工作区而会话记录仍显示 read-only。直接拒绝这个组合。
    if (permission === 'read-only' && policy !== 'auto-deny') {
      throw new Error(L(
        'permission=read-only 强制要求 on_approval=auto-deny（或不传）。' +
          ' auto-allow/ask 会放行 DSH 的 sandbox 提权，使只读档失效。',
        'permission=read-only requires on_approval=auto-deny (or leaving it unset).' +
          " auto-allow and ask would let DSH's sandbox escalation through and defeat the read-only tier.",
      ));
    }
    if (policy !== effectiveApprovalPolicy(permission, policy)) {
      const ceiling = defaultApprovalPolicy(permission);
      throw new Error(L(
        `on_approval=${policy} 超出本机审批上限 ${ceiling}。请使用更严格的策略，或由用户配置 DSH_MCP_APPROVAL 后重连。`,
        `on_approval=${policy} exceeds the machine's approval ceiling (${ceiling}). Use a stricter policy or set DSH_MCP_APPROVAL in the client configuration and reconnect.`,
      ));
    }
    const effort = reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(effort)) {
      throw new Error(oneOf('reasoning_effort', REASONING_EFFORTS));
    }
    const reviewMode = normalizeReviewMode(review ?? DEFAULT_REVIEW);
    if (!REVIEW_MODES.includes(reviewMode)) {
      throw new Error(oneOf('review', REVIEW_MODES));
    }
    if (model && !provider) {
      throw new Error(L(
        '指定 model 时必须同时给 provider（ACP 的模型标识是 [provider, model] 二元组）',
        "model needs provider as well (ACP identifies a model by the [provider, model] pair)",
      ));
    }
    // 家目录当选工作区 → DSH 的 ACL 沙箱起不来，第一次起 shell 才暴露。
    // 与其让用户以为服务坏了，不如在这里把原因和出路一起说清楚。
    const homeProblem = homeWorkspaceProblem(cwd, permission);
    if (homeProblem) throw new Error(homeProblem);
    if (isolation !== undefined && isolation !== null && !ISOLATION_MODES.includes(isolation)) {
      throw new Error(oneOf('isolation', ISOLATION_MODES));
    }
    // 会话级 worktree（见 worktree.mjs）：参数都校验完了才建，免得一个坏参数留下一个空分支。
    // 之后会话的工作目录、沙箱可写根、共享进程分组都按 worktree 走。
    const worktree = isolation === 'worktree' ? await createWorktree(cwd) : null;
    if (worktree) cwd = worktree.cwd;
    const shared = SHARED_PROCESS;
    let proc;
    try {
      proc = shared
        ? this.acquireHost(cwd, permission)
        : new AcpProcess({
            cwd,
            permission,
            log: this.log,
            onNotification: () => {},
            onPermissionRequest: () => ({ outcome: { outcome: 'cancelled' } }),
          });
      if (!shared) proc.start();
    } catch (e) {
      // 进程都没起来（例如找不到 DSH）：别把刚建的 worktree 留下。
      if (worktree) await discardWorktree(worktree);
      throw e;
    }
    let createdSessionId = null;
    let conv = null;
    try {
      await proc.initialize();
      const res = await proc.request('session/new', { cwd, mcpServers: [] });
      createdSessionId = res.sessionId;
      conv = new Conversation(
        {
          id: res.sessionId,
          cwd,
          permission,
          onApproval: policy,
          titleHint,
          keepAlive: keepAlive === true,
          reasoningEffort: effort,
          provider: provider ?? null,
          model: model ?? null,
          review: reviewMode,
          worktree,
        },
        this,
      );
      conv.proc = proc;
      conv.lastChildPid = proc.pid;
      // ★ 新建会话的进程也要登记持有者 —— 走的是 Hub.create 这条独立路径，
      //   不登记的话 dsh_takeover 会把"本服务自己持有的会话"误判成 none 而拒绝抢占。
      writeMarker(res.sessionId, { childPid: proc.pid, cwd });
      if (shared) proc.attach(conv);
      else {
        proc.attachRoutes({
          onNotification: (params) => conv.onUpdate(params),
          onPermissionRequest: (params) => conv.onPermissionRequest(params),
        });
      }
      // 套用会话级配置（思考深度默认 max；ACP 自己的默认是 Provider default）
      conv.lastConfigApplied = await applySessionConfig(proc, res.sessionId, conv.cfg);
      // ★ 无效的 provider/model 必须 fail fast：旧行为是建出会话、静默回退
      //   profile 默认模型，调用方以为指定模型已生效。这里在外层 catch 停止进程，
      //   不注册会话，直接报错（不传 provider/model 才走 profile 默认）。
      const modelFailure = (conv.lastConfigApplied.failed ?? []).find((f) => String(f).includes('模型='));
      if (modelFailure) {
        throw new Error(L(
          `指定的 provider/model 无效，会话未创建：${modelFailure}\n` +
            `  请检查 ${provider}/${model} 是否在 profile 中声明；不传这两个参数可使用 profile 默认模型。`,
          `The provider/model you gave is not valid, so no conversation was created: ${modelFailure}\n` +
            `  Check that ${provider}/${model} is declared in the profile; leave both out to use the profile's default model.`,
        ));
      }
      // ★ 回读会话自己的权限记录；不一致会在这里失败并走 catch（停进程、删登记）。
      await conv.verifyPermissionRecorded();
      // 登记工作区，否则这些会话在你的 DSH GUI 里看不到。
      // ★ 必须容错：registerWorkspace 会写 workspace.json（磁盘满/被占时会抛），
      //   而它在 this.conversations.set 之前 —— 抛出去就会**丢掉这个会话并泄漏进程**。
      try {
        conv.workspace = registerWorkspace(cwd, res.sessionId);
      } catch (e) {
        conv.workspace = { registered: false, error: e.message };
        this.log.info(`[hub] 工作区登记失败（不影响会话可用）: ${e.message}`);
      }
      this.conversations.set(conv.id, conv);
      this.save();
      emitLive(
        conv.id,
        'conv.open',
        { cwd, permission, on_approval: conv.onApproval, model: conv.cfg?.model ?? null },
        { title_hint: livePreview(conv.titleHint, 120) },
      );
      this.log.info(
        `[hub] 新建会话 ${conv.id}（cwd=${cwd}, 权限=${permission}, 思考深度=${effort}` +
          `${conv.workspace?.registered ? ', 工作区已登记' : `, 工作区登记失败: ${conv.workspace?.error}`}）`,
      );
      return conv;
    } catch (e) {
      // 失败路径也要清掉写锁登记：session/new 可能已经成功、登记已写入，
      // 但会话最终没有注册（例如无效 provider/model 被 fail-fast）。留下 marker
      // 会被 dsh_list/dsh_takeover 误报成“孤儿持有者”，也会在 locks 目录里积垃圾。
      const stopped = shared
        ? conv
          ? await proc.detach(conv).catch(() => false)
          : await proc.stop().catch(() => false)
        : await proc.stop().catch(() => false);
      if (createdSessionId && stopped) removeMarker(createdSessionId);
      // 刚建的 worktree 和分支还没有任何改动，会话没建成就整个撤销。
      if (worktree) await discardWorktree(worktree);
      throw e;
    }
  }

  /** 列出所有会话：本进程持有的 + DSH 磁盘上未打开的。 */
  async list({ cwd, includeClosed = true } = {}) {
    const out = new Map();
    for (const c of this.conversations.values()) {
      if (cwd && c.cwd !== cwd) continue;
      if (isForgotten(c.id)) continue;
      out.set(c.id, c.snapshot());
    }
    if (!includeClosed) {
      this.lastProbe = { ok: null, error: null, cached: false, at: now() };
      return [...out.values()];
    }

    // 磁盘探测要 spawn 一个 DSH 进程（实测约 1 秒），所以同 cwd 的结果缓存一小段时间，
    // 避免"连着列几次会话"就反复拉进程。
    const cacheKey = cwd ?? '';
    const cached =
      this.#probeCache && this.#probeCache.key === cacheKey && now() - this.#probeCache.at < LIST_PROBE_TTL_MS
        ? this.#probeCache.sessions
        : null;

    const probeCwd = cwd ?? [...this.conversations.values()][0]?.cwd ?? process.cwd();
    let sessions = cached;
    if (cached) {
      this.lastProbe = { ok: true, error: null, cached: true, at: this.#probeCache.at };
    } else if (!sessions) {
      let proc = null;
      try {
        proc = new AcpProcess({ cwd: probeCwd, permission: 'read-only' });
        proc.start();
        await proc.initialize();
        const res = await proc.request('session/list', cwd ? { cwd } : {});
        sessions = res?.sessions ?? [];
        this.#probeCache = { key: cacheKey, at: now(), sessions };
        this.lastProbe = { ok: true, error: null, cached: false, at: this.#probeCache.at };
      } catch (e) {
        this.log.info(`[hub] session/list 探测失败: ${e.message}`);
        sessions = []; // 失败不缓存，下次重试
        // ★ 调用方必须能区分"没有别的会话"和"探测失败"，否则会以为会话丢了。
        this.lastProbe = { ok: false, error: e.message, cached: false, at: now() };
      } finally {
        await proc?.stop().catch(() => {});
      }
    }
    for (const s of sessions) {
      if (out.has(s.sessionId)) continue;
      if (isForgotten(s.sessionId)) continue;
      const meta = readConversationMeta(s.sessionId);
      out.set(s.sessionId, {
        conversation_id: s.sessionId,
        title: meta?.title ?? null,
        cwd: s.cwd,
        permission: null,
        alive: false,
        busy: false,
        /** 磁盘上有、但本服务当前没打开 → detached（可用 resume 复活）。 */
        state: 'detached',
        current_tool: null,
        out_chars: 0,
        running_ms: 0,
        turns: meta?.turns ?? null,
        usage: meta?.usage?.totals ?? null,
        context_pressure: meta?.pressure ?? null,
        model: meta?.model ?? null,
      });
    }
    return [...out.values()];
  }

  /** 空闲回收：停掉闲置进程，会话本身保留（可 resume 复活）。
   *
   * ★ `DSH_MCP_IDLE_TTL_MS=0` = **永不回收**（0.4.0 起默认是 10 分钟，不再是默认值）。
   *   理由（实测，见 docs/zh/caveats.md §3.10~3.12）：空闲回收是写锁**唯一**会变空的时刻，
   *   而只要锁一空，你在 web 里点开那条会话，`dsh web` 就会**永久**持有它
   *   （切走 ✗ 等待 ✗ 归档 ✗ 都不释放），本服务之后每一次 resume 都失败 ——
   *   用户看到的正是"任务跑完后接不回去"。不回收 = **本服务一直握着写锁，GUI 抢不走**：
   *   实测你在 GUI 里点开它是**只读打开**（照样能看内容 ✓），写锁仍在我们的 PID 上 ✓ ——
   *   即"**你看得见，我们写得动**"，两边都不受影响。
   *   代价是每个会话常驻一个 DSH 进程（内存）—— 想省内存就把它设成毫秒数（如 300000）。
   *
   * ★ 但**心跳必须一直续**，两种模式都一样：心跳停了，别的实例 90 秒后就会把我们
   *   判成"卡死"，`dsh_takeover` 于是会**杀掉我们正在跑的回合**。
   *
   * ★ `DSH_MCP_MAX_LIVE`（保活上限）：`IDLE_TTL_MS=0` 时进程会永远留着（实测约 300-480MB/个 ✗），
   *   设了上限就在超标时回收**最久没用过**的那个（busy 的绝不回收）—— "内存有界，锁尽量在手"。
   */
  startReaper() {
    if (this.#reaper) return;
    const neverReapByIdle = IDLE_TTL_MS === 0;
    if (neverReapByIdle) {
      this.log.info(
        `[hub] DSH_MCP_IDLE_TTL_MS=0：不按空闲回收进程（一直握着写锁，GUI 抢不走）` +
          (MAX_LIVE > 0 ? `；超过保活上限 ${MAX_LIVE} 时回收最久没用过的` : '；未设保活上限，进程会一直留着'),
      );
    }
    this.#reaper = setInterval(() => this.reapOnce(), REAP_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  /**
   * 一个回收周期（startReaper 定时调用）。永不 reject。
   * `refreshRss` / `maxRssMb` 只供测试注入：要能复现"读 RSS 期间会话开跑了"的竞态。
   */
  async reapOnce({ refreshRss = refreshRssMap, maxRssMb = MAX_RSS_MB } = {}) {
    // ★ 整个回收周期必须自带防护：这里抛出的异常会变成 unhandled rejection，
    //   在 Node ≥15 上直接**杀掉进程** —— 而那会连带丢掉所有会话的活进程。
    try {
      const cutoff = now() - IDLE_TTL_MS;
      // 哪些会话可以回收：进程活着、不在跑回合
      const reapable = [];
      /** 选中时的 lastUsedAt：停之前对一下，被用过就不再按选中时的判断停它（见下面的循环）。 */
      const usedAtPick = new Map();
      for (const c of this.conversations.values()) {
        if (!c.proc?.alive) continue;
        // ★ 先续心跳，**包括正在跑回合的**：否则长回合（>90 秒）期间心跳不刷新，
        //   别的实例会把我们判成失联并抢占，直接把这一轮杀掉。
        lockHeartbeat(c.id);
        if (c.busy) continue;
        reapable.push(c);
        usedAtPick.set(c, c.lastUsedAt);
      }

      // 回收哪些：① 空闲超过 TTL；② 超过 MAX_LIVE；③ 超过全局 RSS 预算。
      // keep_alive 会话不受 ① ② 约束；③ 是系统级硬上限，最后仍可能回收它。
      const victims = new Set();
      const reapableNormal = reapable.filter((c) => !c.keepAlive);
      if (IDLE_TTL_MS > 0) {
        for (const c of reapableNormal) if (c.lastUsedAt <= cutoff) victims.add(c);
      }
      if (MAX_LIVE > 0) {
        // 保活窗口 = 最近用过的 MAX_LIVE 个；超出的按"最久没用"先回收
        const byAge = reapableNormal.slice().sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        const excess = byAge.length - MAX_LIVE;
        for (let i = 0; i < excess; i++) victims.add(byAge[i]);
      }
      if (maxRssMb > 0) {
        // 按实际 RSS 而不是会话数：上下文大小差异很大，按个数限制经常低估。
        // 预算判断要用新数字：先异步刷新一次（不阻塞事件循环），下面的 rssMb 读的就是它。
        await refreshRss();
        let total = 0;
        const rss = new Map();
        const seenPid = new Set();
        for (const c of this.conversations.values()) {
          if (!c.proc?.alive) continue;
          const pid = c.proc.pid;
          const mb = rssMb(pid) ?? 0;
          rss.set(c, mb);
          // 共享进程只算一次
          if (pid && seenPid.has(pid)) continue;
          if (pid) seenPid.add(pid);
          total += mb;
        }
        if (total > maxRssMb) {
          // 先收非 keep_alive 的最久未用者；仍然超预算才动 keep_alive。
          const pool = reapable
            .filter((c) => !victims.has(c))
            .sort((a, b) =>
              a.keepAlive === b.keepAlive ? a.lastUsedAt - b.lastUsedAt : a.keepAlive ? 1 : -1,
            );
          for (const c of pool) {
            victims.add(c);
            total -= rss.get(c) ?? 0;
            if (total <= maxRssMb) break;
          }
        }
      }

      for (const c of victims) {
        if (c.recycling) await c.recycling;
        // ★ 选中之后有 await（刷新 RSS、等上一个会话停完）：这期间 dsh_send 可能已经在这个会话上
        //   开跑（busy），或者跑完了一个短回合（lastUsedAt 变了）。都不能再按选中时的判断停它 ——
        //   前者会打断正在执行的回合；后者已经不空闲了，下个周期再重新判断。
        if (!c.proc?.alive || c.busy || c.lastUsedAt !== usedAtPick.get(c)) continue;
        this.log.info(
          `[hub] 回收会话 ${c.id} 的进程（${IDLE_TTL_MS > 0 && c.lastUsedAt <= cutoff ? '空闲超时' : `保活上限 ${MAX_LIVE}`}；可 resume 复活）`,
        );
        const proc = c.proc;
        // ★ 先把 stop 登记成 recycling，再 await：stop 可能要几秒，这个窗口里到达的
        //   dsh_send 会在 ensureAlive 里 await 它，而不是为同一会话再拉一个进程去抢
        //   **尚未释放**的写锁。proc 也要等 stop 落定后才置空，否则快路径会拿到垂死进程。
        // 共享进程：detach 只摘掉这个会话（内部 session/close），最后一个离开才停进程。
        const stopping = typeof proc.detach === 'function' ? proc.detach(c) : proc.stop();
        c.recycling = stopping
          .catch(() => false)
          .then((stopped) => {
            // ★ 顺序要紧：**先确认子进程真的退出（写锁真的释放），再删登记**。
            //   反过来的话，一旦它没死透，锁的持有者就变成"无登记的未知进程" ——
            //   既报不清是谁，连 dsh_takeover 都会拒绝（判成 none）。
            if (stopped) removeMarker(c.id);
            return stopped;
          })
          .finally(() => {
            if (c.proc === proc) c.proc = null;
            c.recycling = null;
          });
        await c.recycling;
      }
    } catch (e) {
      this.log.info(`[hub] 回收周期异常（已忽略，下个周期继续）: ${e.message}`);
    }
  }

  /**
   * 释放**所有**活着的会话进程（腾内存用，无损：会话日志都在磁盘上，之后照样 resume）。
   *
   * 场景：保活中的会话各常驻一个 DSH 进程（实测约 300-480MB ✗）。
   * 一批活干完了就调它，内存立刻归零 ✓；下次派活按需 resume ✓。
   */
  async releaseAll({ force = false } = {}) {
    const released = [];
    const skippedBusy = [];
    const failed = [];
    for (const c of this.conversations.values()) {
      if (c.recycling) await c.recycling;
      if (!c.proc?.alive) continue;
      // ★ 默认不打断正在跑的回合：all=true 是"腾内存"，不是"取消任务"。
      //   确实要连跑着的也停掉时传 force=true。
      if (c.busy && !force) {
        skippedBusy.push(c.id);
        continue;
      }
      const proc = c.proc;
      // stop 期间保持 proc 可见 + recycling 屏障，落定后再置空。
      const stopping = typeof proc.detach === 'function' ? proc.detach(c) : proc.stop();
      c.recycling = stopping
        .catch(() => false)
        .finally(() => {
          if (c.proc === proc) c.proc = null;
          c.recycling = null;
        });
      const stopped = await c.recycling;
      if (stopped) {
        removeMarker(c.id);
        released.push(c.id);
      } else {
        // 进程没确认退出：保留登记，让 takeover 还能归因这个孤儿。
        failed.push(c.id);
        this.log.info(`[hub] 释放 ${c.id} 时进程未确认退出，保留写锁登记`);
      }
    }
    this.save();
    return { released: released.length, conversations: released, skipped_busy: skippedBusy, failed };
  }

  trackRunFinalization(run, finalization) {
    const pending = finalization.finally(() => this.#finalizingRuns.delete(run));
    this.#finalizingRuns.set(run, pending);
    return pending;
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.#reaper) clearInterval(this.#reaper);
    this.#reaper = null;
    // 还在跑的回合随本进程一起结束：先同步写"已中断"哨兵。不能等下一个实例的启动恢复 ——
    // 客户端重连时新实例往往在本进程还没退完时就起来了，那时它会把这些标记当成"主人还活着"。
    for (const c of this.conversations.values()) {
      for (const run of c.ledger.runs) {
        if (run.status !== 'queued' && run.status !== 'running') continue;
        if (this.#finalizingRuns.has(run)) continue;
        if (!existsSync(this.runSentinelPath(c.id, run.run_id))) this.#writeInterruptedSentinel(c.id, run);
      }
    }
    const finalizing = Promise.allSettled(this.#finalizingRuns.values());
    try {
      for (const c of this.conversations.values()) {
        if (c.recycling) await c.recycling;
        const proc = c.proc;
        if (proc) {
          const stopping = typeof proc.detach === 'function' ? proc.detach(c) : proc.stop();
          c.recycling = stopping
            .catch(() => false)
            .finally(() => {
              if (c.proc === proc) c.proc = null;
              c.recycling = null;
            });
          const stopped = await c.recycling;
          // 只有确认子进程退出、锁真的释放后才删登记；否则留给下个实例归因。
          if (stopped) removeMarker(c.id);
          else this.log.info(`[hub] 关闭 ${c.id} 时进程未确认退出，保留写锁登记`);
        }
      }
    } finally {
      await finalizing;
      this.save();
    }
  }
}

function runSentinelPayload(conversationId, run) {
  return {
    schema: SENTINEL_SCHEMA,
    conversation_id: conversationId,
    run_id: run.run_id,
    client_run_id: run.client_run_id ?? null,
    status: run.status ?? 'unknown',
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? Date.now(),
    error: sanitizeApprovalContext(run.error ?? run.result?.error ?? null, 'error'),
    result: sanitizeResultForSentinel(run.result ?? null),
  };
}

function storedSentinel(saved, file) {
  return {
    ...saved,
    source: 'sentinel',
    started_at: saved.started_at ?? null,
    elapsed_ms: saved.result?.elapsed_ms ?? null,
    prompt_preview: saved.prompt_preview ?? null,
    result: saved.result ? { ...saved.result, sentinel_file: file } : null,
  };
}

function sentinelStartTime(saved) {
  if (Object.hasOwn(saved, 'started_at')) return Number.isFinite(saved.started_at) ? saved.started_at : null;
  // 旧哨兵没有开始时间。未开始即取消的回合耗时为 0。
  const elapsed = saved.result.elapsed_ms;
  if (!Number.isFinite(saved.ended_at) || (saved.status === 'cancelled' && !(elapsed > 0))) return null;
  return saved.ended_at - (Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0);
}

function writeRunJson(file, value, { exclusive = false } = {}) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (exclusive) linkSync(tmp, file);
    else renameSync(tmp, file);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function readRunJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
    throw e;
  }
}
