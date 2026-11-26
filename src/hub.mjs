/**
 * 注册表（Hub）：持有全部会话、共享进程池、哨兵/审核记录的读写与回收。
 *
 * 会话本体（Conversation）在 conversation.mjs；从这里拆出的纯函数模块（git 快照、
 * 哨兵脱敏、cwd 边界、元数据侧车/墓碑、ACP 线格式）也都在本文件里重新导出，
 * 所以外部一直写的 `from '../src/hub.mjs'` 仍然成立。
 *
 * 同一工作区、同一权限的会话默认共用 DSH ACP 进程。每个会话有独立的 sessionId。
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

import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  ALLOW_FULL_ACCESS,
  APPROVAL_POLICIES,
  DAEMON_MODE,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  IDLE_TTL_MS,
  MAX_LIVE,
  PERMISSION_TIERS,
  REAP_INTERVAL_MS,
  REASONING_EFFORTS,
  REVIEWS_DIR,
  REVIEW_MODES,
  RUNS_DIR,
  SHARED_PROCESS,
  STATE_FILE,
  LEGACY_STATE_FILE,
  USING_DEFAULT_STATE,
  assertWritableDir,
  defaultApprovalPolicy,
  effectiveApprovalPolicy,
} from './config.mjs';
import { normalizeReviewMode } from './review.mjs';
import { assertSafeId } from './ids.mjs';
import { L } from './lang.mjs';
import { AcpProcess } from './acp.mjs';
import { applySessionConfig } from './acp-session.mjs';
import { SessionHost } from './host.mjs';
import { Conversation } from './conversation.mjs';
import * as runStore from './run-store.mjs';
import { adoptConversationFromDisk, listConversations } from './hub/discovery.mjs';
import { reapOnce as runReapOnce, releaseAll as runReleaseAll } from './hub/reaper.mjs';
import { pruneRegistryStages, readRegistry, withRegistryLock, writeRegistry } from './registry.mjs';
import { emitLive, livePreview } from './live.mjs';
import { homeWorkspaceProblem } from './workspace-guard.mjs';
import { registerWorkspace } from './workspace.mjs';
import { ISOLATION_MODES, createWorktree, discardWorktree } from './worktree.mjs';
import {
  META_DIR,
  NOOP_LOG,
  forgottenPath,
  isForgotten,
  pruneStaleTombstones,
  writeConversationMeta,
} from './hub-store.mjs';
import { LOCKS_DIR, removeMarker } from './locks.mjs';
import { attachReview, terminalResult } from './run-result.mjs';

// 外部（测试、bin）一直从 hub.mjs 取这些函数；拆出去之后导入路径保持不变。
export { Conversation, formatReasoning } from './conversation.mjs';
export { fsCaseInsensitive, homeWorkspaceProblem } from './workspace-guard.mjs';
export { gitStatus, sameWorkspaceSnapshot } from './git-snapshot.mjs';
export { sanitizeResultForSentinel } from './sentinel.mjs';

const now = () => Date.now();
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
  /** `dsh_list` 磁盘探测的短缓存容器。 */
  #probeState = { cache: null };

  async load() {
    // ★ 启动即确认三个关键目录可写。以前"写失败只记 silent 日志"会让服务
    //   看起来正常，但注册表/哨兵/锁登记全部丢失，异步等待永远醒不过来。
    assertWritableDir(dirname(STATE_FILE), L('状态目录', 'State directory'));
    assertWritableDir(RUNS_DIR, L('哨兵目录', 'Sentinel directory'), { hardlink: true });
    assertWritableDir(REVIEWS_DIR, L('审核记录目录', 'Reviews directory'));
    assertWritableDir(LOCKS_DIR, L('锁登记目录', 'Lock markers directory'));
    try { pruneRegistryStages(STATE_FILE); }
    catch (error) { this.log.info(`[hub] Registry staging cleanup: ${error.message}`); }

    // 旧版本的默认状态文件在包安装目录里；一次性迁移到新的用户可写目录。
    // 只在没有显式设置 DSH_MCP_STATE 时做，避免覆盖用户指定的路径。
    if (USING_DEFAULT_STATE && !existsSync(STATE_FILE) && existsSync(LEGACY_STATE_FILE)) {
      await withRegistryLock(STATE_FILE, () => {
        if (readRegistry(STATE_FILE)) return;
        const legacy = readRegistry(LEGACY_STATE_FILE);
        if (!legacy) return;
        // 侧车元数据（审批策略/思考深度/标题/轮数）也一并搬过来；
        // 否则旧会话按 id 重建时会悄悄回落到默认值。
        const legacyMeta = join(dirname(LEGACY_STATE_FILE), 'meta');
        if (existsSync(legacyMeta) && !existsSync(META_DIR)) {
          cpSync(legacyMeta, META_DIR, { recursive: true });
          this.log.info(`[hub] 已迁移旧元数据侧车: ${legacyMeta} → ${META_DIR}`);
        }
        writeRegistry(STATE_FILE, legacy);
        this.log.info(`[hub] 已迁移旧状态文件: ${LEGACY_STATE_FILE} → ${STATE_FILE}`);
      });
    }

    const stale = await pruneStaleTombstones(this.log);
    if (stale) this.log.info(`[hub] 清理 ${stale} 个失效的 forget 墓碑`);
    this.adoptNewFromDisk();
    this.log.info(`[hub] 载入 ${this.conversations.size} 个会话`);
  }

  /** 原子保存。**tmp 名必须唯一**：多个 dsh-any-agent 实例共用同一份注册表时，
   * 固定名（`<STATE_FILE>.tmp`）会让并发保存互相踩踏 —— 先写的被后写的覆盖，
   * rename 甚至可能发布出别人的内容或半截文件。哨兵那边早就是这么做的。 */
  async save() {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    await withRegistryLock(STATE_FILE, () => {
      // ★ 多实例共用一份注册表：只写自己内存里的会话，会把另一个实例刚加进去的条目覆盖掉，
      //   并把它跑出来的轮数写回旧值（审计 C03）。所以先读盘上的版本合并：
      //   - 盘上有、内存里没有、也没被 forget 的条目原样保留；
      //   - 轮数与最近使用时间只增不减。
      const previous = readRegistry(STATE_FILE);
      const onDisk = previous?.conversations ?? [];
      const extra = [];
      for (const s of onDisk) {
        const mine = this.conversations.get(s.id);
        if (mine) {
          if (Number.isFinite(s.turnCount) && s.turnCount > mine.turnCount) mine.turnCount = s.turnCount;
          if (Number.isFinite(s.lastUsedAt) && s.lastUsedAt > mine.lastUsedAt) mine.lastUsedAt = s.lastUsedAt;
        } else if (!this.#removed.has(s.id) && !isForgotten(s.id)) {
          extra.push(s);
        }
      }
      const registered = [...this.conversations.values()].filter((c) => !isForgotten(c.id));
      const doc = {
        ...previous,
        version: 1,
        savedAt: new Date().toISOString(),
        conversations: [...registered.map((c) => c.toState()), ...extra],
      };
      writeRegistry(STATE_FILE, doc);
      // 侧车元数据独立于注册表：forget 移除注册表条目后仍然保留，
      // 让按 id 重建的会话不会丢掉审批策略/思考深度/标题/轮数。
      for (const c of registered) writeConversationMeta(c);
    });
  }

  runSentinelPath(conversationId, runId) {
    return runStore.runSentinelPath(conversationId, runId);
  }

  setRunApprovalPending(conversationId, runId, pending) {
    runStore.setRunApprovalPending(this, conversationId, runId, pending, this.log);
  }

  writeRunSentinel(conversationId, run) {
    return runStore.writeRunSentinel(this, conversationId, run, this.log);
  }

  runMarkerPath(conversationId, runId) {
    return runStore.runMarkerPath(conversationId, runId);
  }

  reserveRun(conversationId, run) {
    return runStore.reserveRun(this, conversationId, run);
  }

  markRunStarted(conversationId, run) {
    return runStore.markRunStarted(this, conversationId, run);
  }

  checkpointRunResult(conversationId, run, result, status, endedAt) {
    return runStore.checkpointRunResult(this, conversationId, run, result, status, endedAt, this.log);
  }

  readStoredRun(conversationId, runId) {
    return runStore.readStoredRun(this, conversationId, runId);
  }

  async readLatestStoredRun(conversationId) {
    return runStore.readLatestStoredRun(this, conversationId);
  }

  findRunByClientId(conversationId, clientRunId) {
    return runStore.findRunByClientId(this, conversationId, clientRunId);
  }

  recoverInterruptedRuns(options) {
    return runStore.recoverInterruptedRuns(this, (id, run) => this.#writeInterruptedSentinel(id, run), this.log, options);
  }

  updateRunSentinelReview(conversationId, runId, review) {
    return runStore.updateRunSentinelReview(this, conversationId, runId, review, this.log);
  }

  pruneSentinels(options) {
    return runStore.pruneSentinels(options);
  }

  clearRunSentinel(conversationId, runId) {
    return runStore.clearRunSentinel(this, conversationId, runId);
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
      start_order: run.start_order ?? null,
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
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      this.#adopting.set(id, gate);
      try {
        c = await adoptConversationFromDisk(this, id);
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
    const doc = readRegistry(STATE_FILE);
    if (!doc) return 0;
    let added = 0;
    for (const s of doc.conversations) {
      if (isForgotten(s.id) || this.conversations.has(s.id)) continue;
      this.conversations.set(s.id, new Conversation(s, this));
      added++;
    }
    return added;
  }

  async remove(id) {
    this.conversations.delete(id);
    // save() 会合并盘上的条目；本实例主动移除的不能被合并回来。
    this.#removed.add(id);
    // 注意：**不删侧车元数据**。forget 的语义是“从注册表移除”，
    // 之后按 id 重建（多实例恢复）时，侧车让审批策略/思考深度/标题/轮数不漂移。
    await this.save();
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
      // ★ 新建会话的进程也要登记持有者 —— 走的是 Hub.create 这条独立路径，
      //   不登记的话 dsh_takeover 会把"本服务自己持有的会话"误判成 none 而拒绝抢占。
      await conv.recordChildProcess(proc);
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
      const modelIdx = (conv.lastConfigApplied.failedKeys ?? []).indexOf('model');
      const modelFailure = modelIdx >= 0
        ? conv.lastConfigApplied.failed?.[modelIdx]
        : (conv.lastConfigApplied.failed ?? []).find((f) => /^(?:模型|model)=/i.test(String(f)));
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
      await this.save();
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
      if (conv && this.conversations.get(conv.id) === conv) this.conversations.delete(conv.id);
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
  async list(options = {}) {
    return listConversations(this, options, this.#probeState);
  }

  startReaper() {
    if (this.#reaper) return;
    if (IDLE_TTL_MS === 0) {
      this.log.info(
        '[hub] DSH_MCP_IDLE_TTL_MS=0：不按空闲回收进程（一直握着写锁，GUI 抢不走）' +
          (MAX_LIVE > 0 ? `；超过保活上限 ${MAX_LIVE} 时回收最久没用过的` : '；未设保活上限，进程会一直留着'),
      );
    }
    this.#reaper = setInterval(() => this.reapOnce(), REAP_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  async reapOnce(options) {
    return runReapOnce(this, options);
  }

  async releaseAll(options) {
    return runReleaseAll(this, options);
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
      await this.save();
    }
  }
}
