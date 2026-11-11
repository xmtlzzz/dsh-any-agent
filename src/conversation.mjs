/**
 * 会话（Conversation）：一个会话 = 一个 DSH ACP 进程。
 *
 * 从 hub.mjs 拆出来：Conversation 只拿到 `hub` 的引用（登记 / 哨兵 / 共享宿主），
 * 不 import Hub，所以两个模块之间没有环。hub.mjs 仍然重新导出 `Conversation` 与
 * `formatReasoning`，外部的导入路径不变。
 *
 * 进程只是"缓存"，不是"身份"——对话的身份是 DSH 的 sessionId，落盘在 DSH 的会话目录里。
 * 因此进程死掉/被回收/整体重启后，用 session/resume 就能接着聊。
 *
 * 持久化红线同 hub.mjs 文件头：只存元数据；思考内容不写日志、默认也不落盘。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOW_FULL_ACCESS,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  PERMISSION_TIERS,
  PROMPT_TIMEOUT_MS,
  REVIEW_MODES,
  SHARED_PROCESS,
  DSH_HOME,
  defaultApprovalPolicy,
} from './config.mjs';
import {
  REVIEW_VERDICTS,
  buildReviewTicket,
  normalizeReviewMode,
  readReviewRecord,
  reviewIdForRun,
  writeReviewRecord,
} from './review.mjs';
import { sanitizeApprovalContext } from './redact.mjs';
import { assertSafeId } from './ids.mjs';
import { AcpProcess } from './acp.mjs';
import { applySessionConfig, approvalContext, pickOption } from './acp-session.mjs';
import { rssMb } from './procstat.mjs';
import { readConversationMeta } from './titles.mjs';
import { gitStatus, sameWorkspaceSnapshot } from './git-snapshot.mjs';
import { forgottenPath, isForgotten, writeTombstone } from './hub-store.mjs';
import { emitLive, livePreview, liveSettings, removeLive, summarizeToolInput } from './live.mjs';
import {
  classifyHolder,
  describeLeaseConflict,
  isLeaseError,
  isPidAlive,
  killHolderChild,
  removeMarker,
  writeMarker,
} from './locks.mjs';
import { attachReview, terminalResult } from './run-result.mjs';
import { MAX_AUTO_APPROVALS_KEPT, approvalDecision, autoApprovalSummary, escalationOf } from './approval-policy.mjs';
import { OutBuffer } from './out-buffer.mjs';
import { MAX_RUNS, RunLedger } from './run-ledger.mjs';

const now = () => Date.now();

/** 记录用户发话时的截断长度（避免一条把缓冲撑爆）。 */
const MAX_PROMPT_ECHO = 4000;

export class Conversation {
  constructor(state, hub) {
    this.id = state.id;
    this.cwd = state.cwd;
    this.permission = state.permission ?? DEFAULT_PERMISSION;
    this.onApproval = state.onApproval ?? defaultApprovalPolicy(this.permission);
    this.createdAt = state.createdAt ?? now();
    this.lastUsedAt = state.lastUsedAt ?? now();
    this.turnCount = state.turnCount ?? 0;
    /** 建会话时给的提示词（仅在 DSH 还没生成原生标题前当兜底显示）。 */
    this.titleHint = state.titleHint ?? null;
    /** true = 不受空闲 TTL / MAX_LIVE 回收（用于"必须一直握住写锁"的长期会话）。 */
    this.keepAlive = state.keepAlive === true;
    /** 会话级 ACP 配置（思考深度 / 模型）。新进程不记得，resume 后要重套。 */
    this.cfg = {
      reasoningEffort: state.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      provider: state.provider ?? null,
      model: state.model ?? null,
    };
    /** 调用方审核策略（off / advisory）。可在 dsh_send 单次覆盖。 */
    this.review = REVIEW_MODES.includes(state.review) ? state.review : DEFAULT_REVIEW;
    this.lastConfigApplied = null;
    /** 是否已回读并确认会话记录的权限档（null=尚未核对，true/false=结果）。 */
    this.permissionVerified = null;
    /** 工作区登记结果（决定你的 DSH GUI 里能不能看到这个会话）。 */
    this.workspace = state.workspace ?? null;
    this.#hub = hub;

    this.proc = null;
    this.busy = false;
    /** 正在进行的进程回收（`proc.stop()` 的 promise）。非 null 时不得为同一会话再拉起进程。 */
    this.recycling = null;
    /** 本进程为这个会话拉起过的最后一个子进程 PID（登记被删后仍能归因锁的归属）。 */
    this.lastChildPid = null;
    /** 最近一次撞写锁的记录 `{at, holder_kind, reason, hint}`（见 snapshot()）。 */
    this.lockConflict = null;
    this.pendingApprovals = new Map();
    /** 正在跑的 run 记录（进程意外退出时要用它写 error 哨兵）。 */
    this.currentRun = null;
    /** 等待"当前回合结束"的回调队列，供插话排队使用。 */
    this.idleWaiters = [];

    /** 运行期输出环形缓冲（仅内存、有界；思考内容不进去），见 out-buffer.mjs。 */
    this.outBuf = new OutBuffer();
    this.turnOutChars = 0;
    this.currentTurn = 0;
    this.turnStartedAt = 0;
    this.currentTool = null;

    /** 回合记录与忙时队列（仅内存；重启后以哨兵为准），见 run-ledger.mjs。 */
    this.ledger = new RunLedger();
    this.draining = false;
    /** 最近一次回合结果，仅内存（进程退出即消失），不落盘。 */
    this.lastResult = null;
  }

  #hub;

  // 只读视图（测试与快照在用）。`?.` 兜住用 Object.create(Conversation.prototype) 做的替身。
  /** 输出缓冲里的条目。 */
  get out() {
    return this.outBuf?.entries ?? [];
  }
  /** 内存里的回合记录。 */
  get runs() {
    return this.ledger?.runs ?? [];
  }
  /** 忙时排队的任务。 */
  get queue() {
    return this.ledger?.queue ?? [];
  }

  /** 已置 busy、但 session/prompt 还没发出的回合（冷启动窗口）。 */
  #undispatched = null;
  /** 冷启动窗口里收到了 dsh_interrupt：发 session/prompt 之前放弃这个回合。 */
  #cancelBeforeDispatch = false;

  /** 墓碑存在（本实例或另一个实例 forget 过）时拒绝派活。 */
  #assertNotForgotten() {
    if (isForgotten(this.id)) {
      throw new Error(`会话已被 forget（永久移除）: ${this.id}，不再派活。确实要恢复请删除墓碑 ${forgottenPath(this.id)}。`);
    }
  }

  /**
   * live 事件流用的工具跟踪：tool_call_id → {at, status, hasInput}。
   * 单独放在这里而不是回合收集器里：收集器的 tools 会原样进 tools_used，不能混入新字段。
   */
  #liveTools = new Map();

  /** 当前 run_id（live 事件用；回合外为 null）。 */
  #liveRunId() {
    return this.currentRun?.run_id ?? null;
  }

  /** 写一条 live 事件（永不抛错，见 live.mjs）。 */
  #live(type, fields = {}, detail = null) {
    emitLive(this.id, type, { run: this.#liveRunId(), turn: this.currentTurn, ...fields }, detail);
  }

  /**
   * live 事件流的 token 跟踪：`{runId, base, at, last}`。
   * DSH 在投影缓存里维护**会话累计**的 tokenUsage.totals，并在回合中每个模型步之后更新
   * （真机实测）；回合开始时记下基线，之后发的是"本回合增量"。
   */
  #liveUsage = null;

  /** 读 DSH 投影缓存里的 token 累计与上下文压力；读不到返回 null。 */
  #readTokenUsage() {
    try {
      const meta = readConversationMeta(this.id);
      const t = meta?.usage?.totals;
      const p = meta?.pressure;
      if (!t && !p) return null;
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      return {
        totals: t
          ? { input: n(t.uncachedInputTokens), output: n(t.outputTokens), cache_read: n(t.cacheReadTokens), cache_write: n(t.cacheWriteTokens) }
          : null,
        context: p && Number.isFinite(p.contextWindow) ? { used: n(p.pressureTokens ?? p.surfaceTokens), window: p.contextWindow } : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 发一条 `usage` 事件（本回合 token 增量 + 会话累计 + 上下文占用）。
   * 回合中节流到 2 秒一次、且只在数字变化时发；回合结束后 force 再发一次最终值。
   */
  #liveUsageTick({ force = false } = {}) {
    const u = this.#liveUsage;
    if (!u) return;
    const t = now();
    if (!force && t - u.at < 2000) return;
    u.at = t;
    const cur = this.#readTokenUsage();
    if (!cur?.totals && !cur?.context) return;
    const base = u.base ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const tokens = cur.totals
      ? Object.fromEntries(Object.keys(base).map((k) => [k, Math.max(0, cur.totals[k] - base[k])]))
      : null;
    const sig = JSON.stringify([tokens, cur.context]);
    if (!force && sig === u.last) return;
    u.last = sig;
    emitLive(this.id, 'usage', {
      run: u.runId,
      turn: u.turn,
      tokens,
      session_tokens: cur.totals,
      context: cur.context,
      final: force || undefined,
    });
  }

  /** 审批裁决事件（decide / 超时 / 回合结束 / 关闭 统一走这里）。 */
  #liveApprovalDecided(approvalId, by, decision = null, effective = null) {
    this.#live('approval.decided', { approval_id: approvalId, by, decision, effective });
  }

  /** 序列化进注册表的最小状态——**只有元数据，没有对话内容**。 */
  toState() {
    return {
      id: this.id,
      cwd: this.cwd,
      permission: this.permission,
      onApproval: this.onApproval,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      turnCount: this.turnCount,
      titleHint: this.titleHint,
      keepAlive: this.keepAlive,
      reasoningEffort: this.cfg.reasoningEffort,
      provider: this.cfg.provider,
      model: this.cfg.model,
      review: this.review,
      workspace: this.workspace,
    };
  }

  /** 侧车元数据：与注册表同字段，但独立落盘，forget 之后仍可恢复。 */
  toMeta() {
    return { version: 1, ...this.toState() };
  }

  /** 合规的公开快照（含磁盘上的元信息）。 */
  snapshot() {
    const meta = readConversationMeta(this.id);
    const nativeTitle = meta?.title ?? null;
    const holder = this.proc?.alive
      ? { kind: 'self', reason: '本进程持有该会话的写锁' }
      : classifyHolder(this.id, { knownChildPid: this.lastChildPid });
    return {
      conversation_id: this.id,
      /** 对话名来自 DSH 的 session/title 事件（自动生成）；未生成时用建会话提示兜底。 */
      title: nativeTitle ?? this.titleHint ?? null,
      /** native = DSH 自动标题；title_hint = 建会话时给的提示；null = 还没有名字。 */
      title_source: nativeTitle ? 'native' : this.titleHint ? 'title_hint' : null,
      /**
       * DSH 自动生成的标题是**首条消息的截断前缀**（实测 13–15 个字符，
       * 例如「这是一次连通性冒烟测试，请」），信息量很低。
       * 所以调用方给了 title_hint 时，把两者分开返回，由调用方自己选：
       * 想按 DSH 原生标题认会话就看 title，想要可读标签就看 title_hint。
       */
      title_hint: this.titleHint ?? null,
      cwd: this.cwd,
      permission: this.permission,
      /** 会话默认审核策略；单次 dsh_send 可以覆盖。 */
      review: this.review,
      /** true=已回读会话记录且一致；false/null=缓存暂时没有记录（read-only 仍由审批层兜底）。 */
      permission_verified: this.permissionVerified,
      on_approval: this.onApproval,
      alive: !!this.proc?.alive,
      busy: this.busy,
      keep_alive: this.keepAlive,
      /** 子进程 RSS（MB）；量不到就是 null，不影响任何决策。 */
      rss_mb: rssMb(this.proc?.pid),
      /** running = 正在跑回合；idle = 进程活着但空闲；detached = 进程未打开（可 resume）。 */
      state: this.state(),
      current_tool: this.currentTool,
      out_chars: this.turnOutChars,
      running_ms: this.busy && this.turnStartedAt ? now() - this.turnStartedAt : 0,
      turns: this.turnCount,
      created_at: new Date(this.createdAt).toISOString(),
      last_used_at: new Date(this.lastUsedAt).toISOString(),
      model: meta?.model ?? null,
      reasoning_effort: this.cfg.reasoningEffort,
      model_config: this.cfg.provider ? `${this.cfg.provider}/${this.cfg.model}` : null,
      config_applied: this.lastConfigApplied?.applied ?? null,
      config_failed: this.lastConfigApplied?.failed?.length ? this.lastConfigApplied.failed : null,
      workspace_registered: this.workspace?.registered ?? null,
      usage: meta?.usage?.totals ?? null,
      context_pressure: meta?.pressure ?? null,
      pending_approvals: [...this.pendingApprovals.keys()],
      /** 忙时排队的任务（仅内存；重启丢失）。 */
      queue_length: this.queue?.length ?? 0,
      queue: this.queueList(),
      // Keep the ID list compatible; details are ephemeral and excluded from toState().
      pending_approval_details: [...this.pendingApprovals].map(([approvalId, pending]) => ({
        approval_id: approvalId,
        created_at: pending.createdAt ?? null,
        ...pending.params.details,
      })),
      /**
       * 不在本进程手里时，写锁在谁手上：
       * self / stale-mcp / live-mcp / none。none 只表示"没有本服务可识别的持有者"，
       * 可能是空闲/已释放，也可能被 GUI 持有；原因见 lock_holder_reason。
       */
      lock_holder: holder.kind,
      lock_holder_reason: holder.reason ?? null,
      /** ★ 最近一次"撞写锁"的持久记录。
       *  只报一次错是不够的：撞锁往往**一次就长期成立**（实测：在 GUI 里点开一次，
       *  dsh web 会一直持有写锁，切走/等待都不释放），所以要把"谁占用、怎么解"留在状态里，
       *  否则用户下次只会看到一句没有上下文的报错。 */
      lock_conflict: this.lockConflict,
    };
  }

  // ── 进程生命周期 ────────────────────────────────────────────────

  /**
   * 确保有一个可用的 DSH 进程；必要时新建并 resume 回该会话。
   *
   * ★ 冷启动 resume 的"请求超时"最多**自动重试一次**（`retried` 仅供内部递归使用）。
   *
   * 排查记录（test/multi.mjs [3] 偶发 `ACP 请求超时: session/resume`，已知一次、复现不出来）：
   *   - 排除写锁：DSH 的写锁是 Windows 命名内核信号量，`WaitForSingleObject(handle, 0)` **零超时**，
   *     被占用时**立刻**回 SessionAlreadyOwnedError，绝不会挂着等；而且 `dsh_release` 要等持有者
   *     进程真的退出才返回，内核在进程死亡时同步释放它。所以"A 还没放锁 → B 的 resume 挂住"不成立
   *     （撞锁走的是下面 isLeaseError 那条快速失败分支，报错文本也完全不同）。
   *   - 冷 resume 的固定成本：DSH 0.2.2 在 session/new 与 session/resume 的**响应里**同步等待模型目录
   *     刷新（deepseek-account / deepseek-api-key 两个 provider 各请求一次 api.deepseek.com/models，
   *     截止 5 秒，并行）。本机该端点常年不可达，于是每个新进程的第一次 new/resume 稳定要 ~5.2 秒
   *     再加 ~1.3s 的 Electron 冷启动。它是**有界**的（5s deadline），不会单独吃满 60s。
   *   - 排除注册表 / 共享宿主：走读 SessionHost、AcpProcess、LineDecoder 与 B 的 adopt 路径没有"回包丢失"
   *     或"请求被吞"的分支；resume 的每一步在 DSH 侧都是有界 I/O（目录扫描、读日志、零超时拿锁）。
   *   - 复现不出来：同一场景（A 建会话 → A 释放 → 新进程 resume）顺序 30 次、5 路并发 40 次
   *     （同时还有整套 multi.mjs 在跑），resume 一直 4.3–5.4s，没有一次离群；另外整套 multi.mjs 连跑 6 次全过。
   *   - 所以 60s 的"无响应"最可能是 DSH 进程自身的**偶发停滞**（杀软/磁盘/系统调度、同机并发的其它
   *     DSH 进程……），**具体触发点没有找到**，这里不假装知道。超时当下的 DSH stderr 尾部现在会经
   *     dshStderr 记下（DSH_MCP_LOG_STDERR=1 时可见），下次撞上就有证据。
   * 对策不是单纯把超时调大（真卡死了等再久也没用），而是利用 resume 的两个性质：
   *   ① 幂等 —— 会话本体在磁盘上，resume 失败不改变它；
   *   ② 失败路径已经杀掉并等到这个进程退出（写锁随之释放），重建进程是干净的重来。
   * 所以只对 `ACP_TIMEOUT`（DSH 没回话）且确认旧进程已退出时重试一次；撞写锁、参数错误、DSH 明确拒绝
   * 都不重试（重试只会重复同一个错误）。第二次仍超时就照旧报错，不无限循环。
   */
  async ensureAlive({ retried = false } = {}) {
    // ★ 上一代进程正在回收时必须先等它停完：否则会为同一会话再拉起一个进程，
    //   去抢一个**尚未释放**的写锁（reaper/release 里 await stop() 的那个窗口）。
    if (this.recycling) await this.recycling;
    if (this.proc?.alive) return this.proc;
    // ★ 机器侧开关同样管 resume：Hub.create 只挡住了“新建”，注册表/侧车里已有的
    //   danger-full-access 会话照样能被拉起（审计 A02）。
    if (this.permission === 'danger-full-access' && !ALLOW_FULL_ACCESS) {
      throw new Error(
        `会话 ${this.id} 的权限档是 danger-full-access，而本机未设置 DSH_MCP_ALLOW_FULL_ACCESS=1，拒绝恢复。` +
          ' 设置该开关后重试，或改用 workspace-write / read-only 新建会话。',
      );
    }
    const shared = SHARED_PROCESS;
    let proc;
    if (shared) {
      proc = this.#hub.acquireHost(this.cwd, this.permission);
      proc.attach(this);
      this.proc = proc;
    } else {
      proc = new AcpProcess({
        cwd: this.cwd,
        permission: this.permission,
        log: this.#hub.log,
        onNotification: (params) => this.onUpdate(params),
        onPermissionRequest: (params) => this.onPermissionRequest(params),
      });
      proc.start();
      this.proc = proc;
    }
    // ★ lastChildPid **推迟到 resume 真正成功后**再写（见 writeMarker 处）。
    //   若在这里就覆盖，一次注定撞锁失败的 resume 会把"上一代还活着的子进程"
    //   这条抢占线索换成刚拉起、注定失败的新进程，takeover 就归因不到真正的持有者。
    // ★ 登记**推迟到真正拿到写锁之后**（见下面 resume 成功处）。
    //   登记的含义是"我正持有这个会话的写锁"，不是"我拉起了一个进程"。
    //   若在这里就写，一次注定撞锁失败的 resume 会先把"谁持有"的线索覆盖掉、
    //   失败路径再把它删掉 —— 抢占逻辑就只能看到 none，无法判定持有者（真实 bug）。
    try {
      await proc.initialize();
      // 能走到这里说明本会话刚新建了一个 DSH 进程（Hub.create 之后进程一直活着，不会进这个分支），
      // 而会话本体已经存在于磁盘上，所以必须 resume 把它接回来。
      await proc.request('session/resume', {
        sessionId: this.id,
        cwd: this.cwd,
        mcpServers: [],
      });
      // 新进程不记得会话级配置（思考深度/模型），resume 后必须重套
      this.lastConfigApplied = await applySessionConfig(proc, this.id, this.cfg);
      for (const f of this.lastConfigApplied.failed) this.#hub.log.info(`[conv ${this.id}] ${f}`);
      // ★ 回读会话自己的权限记录，防止 profile defaultPreset 无声提权。
      await this.verifyPermissionRecorded();
      // 锁到手了，这时才登记；从此别人能查到"锁在我们手上"
      writeMarker(this.id, { childPid: proc.pid, cwd: this.cwd });
      // 只有真正拿到写锁后才更新"我拉起的最后一个子进程"：失败路径需要保留上一代的 PID。
      this.lastChildPid = proc.pid;
      this.lockConflict = null; // 拿到锁了，之前的撞锁记录作废
      this.#hub.log.info(`[conv ${this.id}] 已 resume`);
      return proc;
    } catch (e) {
      // 超时当下 DSH 在 stderr 说了什么，是下次再撞上这个偶发停滞时唯一的证据；
      // stop() 之后共享宿主就拿不到它了，所以先取。只走 dshStderr（默认静默，
      // DSH_MCP_LOG_STDERR=1 才打印 —— DSH 的 stderr 可能夹带模型输出，不能默认外泄）。
      if (e?.code === 'ACP_TIMEOUT') {
        const tail = proc.stderrTail;
        if (tail) this.#hub.log.dshStderr?.(`[conv ${this.id}] ${e.method} 超时时 DSH stderr 尾部:\n${tail}`);
      }
      // ★ 半死的进程必须作废：它 alive 但**没有加载这个会话**，一旦留在 this.proc 上，
      //   下次调用会走上面 `this.proc?.alive` 的快路径，把 session/prompt 发给一个
      //   不认识该会话的进程 —— 会话就永久卡死了（重派也不会自愈）。
      // 只作废**自己这一次**拉起的进程：窄窗口里另一个调用可能已经换上了新一代。
      if (this.proc === proc) this.proc = null;
      // ★ 必须 **await**：不等它真的退出，紧接着的 classifyHolder 就会把"正在退出的自己人"
      //   当成持锁者（表现为"上一代子进程还活着并握着锁"），于是每次失败都误报锁冲突 ——
      //   更糟的是旧代码没有 lastChildPid 兜底，会把这种自伤报成"多半是你自己的 GUI"，
      //   而 dsh_takeover 对 none 又拒绝接管，会话就卡住了（test/cycle.mjs 实测抓到）。
      const stopped = shared
        ? await proc.detach(this).catch(() => false)
        : await proc.stop().catch(() => false);
      // 只删**自己的**登记（removeMarker 会校验 token）；进程没确认退出时保留登记，
      // 让 classifyHolder/takeover 仍能归因。
      if (stopped) removeMarker(this.id);
      // 写锁冲突是最常见也最需要"说人话"的失败：DSH 的 SessionAlreadyOwnedError 会被
      // ACP 包成 -32603 "Internal error"，只说这句调用方根本不知道该怎么办。
      if (isLeaseError(e.message)) {
        const holder = classifyHolder(this.id, { knownChildPid: this.lastChildPid });
        // ★ 留下持久记录（snapshot().lock_conflict）。撞锁常常**一次就长期成立**：
        //   实测在 GUI 里点开一次，dsh web 就会一直持有写锁（切走、等十几分钟都不释放）。
        //   只报一次错的话，用户下次只会看到一句没有上下文的失败。
        this.lockConflict = {
          at: now(),
          holder_kind: holder.kind,
          holder: holder.marker ?? null,
          reason: holder.reason,
          hint:
            holder.kind === 'none'
              ? '持有者不是本服务拉起的进程 —— 多半是你自己的 DSH GUI。解法（无损、可逆）：在那个会话的菜单里点「归档会话」让它释放 reference，需要时再「取消归档」；实在不行就重启 dsh web。'
              : holder.kind === 'stale-mcp'
                ? '持有者已失联（心跳过期）或是本进程的残留子进程 —— 直接 dsh_takeover，无需 force。'
                : holder.kind === 'live-mcp'
                  ? '另一个活着的 dsh-any-agent 实例持有它：在那边 dsh_release，或用 dsh_takeover(force=true) 夺过来。'
                  : '稍后重试。',
        };
        const err = new Error(describeLeaseConflict(this.id, holder));
        err.code = 'session-writer-held';
        err.holder = holder;
        throw err;
      }
      // ★ 瞬时停滞：DSH 没回话，且那个进程已经确认退出（写锁随之释放）→ 重建进程重来一次。
      //   共享宿主上还挂着别的会话时 `proc.alive` 仍为真（detach 只摘掉本会话），那个进程里
      //   可能还有这条 resume 在跑，重试会撞上它自己 —— 此时不重试，照旧报错。
      if (e?.code === 'ACP_TIMEOUT' && !retried && stopped && !proc.alive) {
        this.#hub.log.info(
          `[conv ${this.id}] ${e.method ?? 'ACP'} 超时（${e.timeoutMs ?? '?'}ms），已回收该进程；重建进程重试一次`,
        );
        return this.ensureAlive({ retried: true });
      }
      throw new Error(`恢复会话失败（已作废该进程，下次调用会重建）：${e.message}`);
    }
  }

  /**
   * 核对**会话自己记录**的权限档是否与请求一致。
   *
   * 为什么不能只信入参：DSH profile 里的 `permission.defaultPreset` 会在
   * session/new 时覆盖 `DSH_PERMISSION_MODE`（test/permission.mjs 实测抓到过
   * read-only 被静默提升）。投影缓存可能稍后才刷盘；read-only 必须 fail-closed：
   * 等待至少一个刷盘周期，仍读不到就拒绝继续，不能依赖“审批层兜底”
   * （danger sandbox 下根本不会产生审批请求）。
   */
  async verifyPermissionRecorded({ attempts, delayMs = 250 } = {}) {
    // read-only 需要覆盖 DSH 约 5 秒的投影缓存刷新周期；其它档位保持较短等待。
    const tries = Number.isFinite(attempts) ? attempts : this.permission === 'read-only' ? 40 : 6;
    for (let i = 0; i < tries; i++) {
      const meta = readConversationMeta(this.id);
      const recorded = meta?.permissions?.preset;
      if (recorded) {
        if (!PERMISSION_TIERS.includes(recorded) || recorded !== this.permission) {
          throw new Error(
            `会话实际权限档为 ${JSON.stringify(recorded)}，与请求的 ${this.permission} 不一致。\n` +
              '  这通常意味着 DSH profile 里写了 permission.defaultPreset，覆盖了启动时传入的权限档。\n' +
              `  请检查 ${join(DSH_HOME, 'profiles', process.env.DSH_MCP_PROFILE ?? 'dsh-mcp', 'cordis.patch.yml')}，` +
              '删掉 permission.defaultPreset 后重试。',
          );
        }
        // ★ 预设名只是标签，真正生效的是沙箱：profile 可以把名为 read-only 的预设定义成
        //   danger-full-access 沙箱（审计 C01）。DSH 记录的 sandbox 值与档位同名，
        //   有记录就必须一致；read-only 还必须真的有沙箱记录（fail closed）。
        const sandboxes = [meta.permissions.sandbox, meta.sandboxMode].filter((v) => v !== undefined && v !== null);
        if (sandboxes.some((s) => s !== this.permission) || (this.permission === 'read-only' && !sandboxes.length)) {
          throw new Error(
            `会话权限预设为 ${recorded}，但实际沙箱记录为 ${JSON.stringify(sandboxes)}，与请求的 ${this.permission} 不一致。\n` +
              '  这通常意味着 DSH profile 改写了该预设的 sandbox。请检查 ' +
              `${join(DSH_HOME, 'profiles', process.env.DSH_MCP_PROFILE ?? 'dsh-mcp', 'cordis.patch.yml')} 里的 permission.presets。`,
          );
        }
        this.permissionVerified = true;
        return recorded;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.permissionVerified = false;
    if (this.permission === 'read-only') {
      throw new Error(
        `无法在 ${(tries * delayMs) / 1000}s 内确认会话实际为 read-only（投影缓存无权限记录）。\n` +
          '  为避免 profile 的 defaultPreset 把只读会话静默提升为完全访问，本次调用已拒绝。\n' +
          '  请确认 DSH 会话存储可读，或稍后重试；非只读档位不受此限制。',
      );
    }
    this.#hub.log.info(
      `[conv ${this.id}] 投影缓存里暂时没有权限记录，跳过运行期核对（非只读档）`,
    );
    return null;
  }

  /**
   * 抢占写锁。
   *
   * 为什么需要"杀进程"：DSH 的写锁是跨进程内核信号量，**没有 API 能从活着的持有者手里夺走**。
   * 所以抢锁 == 杀掉持有者，然后重新 resume。既然要杀，就必须先确认那是谁：
   *
   *   - `stale-mcp`（本服务自己实例的孤儿残留）→ **自动杀**，安全；
   *   - `live-mcp`（另一个活着的 dsh-any-agent 实例）→ 默认拒绝，`force=true` 才杀；
   *   - `none`（没有登记，多半是你自己的 DSH GUI）→ **绝不杀**（会连你的界面和正在看的对话一起杀掉），只报告。
   */
  async takeover({ force = false } = {}) {
    const report = { conversation_id: this.id, ok: false, holder_kind: null, killed_pid: null, message: '' };

    if (this.proc?.alive) {
      report.ok = true;
      report.message = '本进程已经持有该会话，无需抢占。';
      return report;
    }

    // 1) 先走正常路径：原持有者可能早已释放
    try {
      await this.ensureAlive();
      report.ok = true;
      report.message = '无需抢占：正常 resume 就成功了（锁是空的，原持有者已释放）。';
      return report;
    } catch (e) {
      if (e.code !== 'session-writer-held') {
        report.message = `不是写锁问题，抢占帮不上忙：${e.message}`;
        return report;
      }
    }

    // 2) 分类处置
    const holder = classifyHolder(this.id, { knownChildPid: this.lastChildPid });
    report.holder_kind = holder.kind;
    report.holder = holder.marker;
    // 登记可能已随回收被删，但"我们自己的残留子进程"仍可归因（见 locks.classifyHolder）
    const markerChild = holder.marker?.child_pid ?? null;
    const killTarget = isPidAlive(markerChild) ? markerChild : (holder.known_child_pid ?? markerChild);

    if (holder.kind === 'none' || !holder.childAlive) {
      report.message =
        `抢占未执行：${holder.reason}\n` +
        '本服务**不会**杀非本服务拉起的进程（那可能是你的 DSH GUI，杀它会连你正在看的对话一起没）。\n' +
        '请在那个窗口里关掉该会话（或切走），然后重试。';
      return report;
    }
    if (holder.kind === 'live-mcp' && !force) {
      report.message =
        `抢占被拒绝：${holder.reason}\n` +
        '如果确认那边已经不用它了，重试时带 force=true 强行夺过来。';
      return report;
    }

    // 3) 共享进程：杀它会连坐同组会话，先把代价说清楚，别让对方在不知情下按下去。
    //    共享进程池（0.5.0 默认开启）让一个 PID 载着多个会话，takeover 只看"谁握着锁"
    //    会做出一个很贵的决定 —— 杀掉持有者 = 同组所有会话的进行中回合一起断。
    const sharedVictims = this.#hub.hostVictimsOf(killTarget, this.id);
    if (sharedVictims.length > 0) {
      report.shared_sessions = sharedVictims;
      if (!force) {
        report.message =
          `抢占被拒绝：PID ${killTarget} 是共享进程，上面还挂着 ${sharedVictims.length} 个其它会话` +
          `（${sharedVictims.map((id) => id.slice(0, 8)).join(', ')}）。\n` +
          '杀掉它会连坐这些会话：各自进行中的回合会中断（会话本体无损，之后照常 resume）。\n' +
          '确认可以接受就带 force=true 重试；不想连坐就先 dsh_release 那些会话，或等它们空闲。';
        return report;
      }
    }

    // 4) 杀 + 重试（内核在持有者进程退出时释放信号量）
    const kill = killHolderChild(killTarget, { expectedSpawnedAt: holder.marker?.spawned_at });
    report.killed_pid = killTarget;
    report.kill = kill;
    if (!kill.killed) {
      report.message = `抢占失败：${kill.reason}`;
      return report;
    }
    removeMarker(this.id, { force: true });
    // 等它**真的**退出再接管：只发 kill 就立刻 resume 会撞上尚未释放的锁
    // （进程退出与内核回收信号量之间有一小段窗口）。
    for (let i = 0; i < 20; i++) {
      if (!isPidAlive(killTarget)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      await this.ensureAlive();
      report.ok = true;
      report.message =
        `已抢占：杀掉持有者 PID ${killTarget}（${holder.reason}），并成功接管会话。` +
        `\n⚠️ 如果那个进程当时正在跑回合，那一轮的工作会中断（会话日志会记为 interrupted）。` +
        (sharedVictims.length > 0
          ? `\n⚠️ 它是共享进程，另外 ${sharedVictims.length} 个会话也被一起断掉了（各自 resume 即可）。`
          : '');
    } catch (e) {
      report.message = `杀掉 PID ${killTarget} 之后仍无法接管：${e.message}`;
    }
    return report;
  }

  // ── 流式更新收集 ────────────────────────────────────────────────

  onUpdate(params) {
    const c = this.collector;
    if (!c) return;
    const u = params?.update;
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = u.content?.text ?? '';
        // ★ 被工具调用隔开的两段正文是两条消息，不能首尾相接：以前会拼成
        //   “…where possible.1) package.json…”。在新一段开头补一个空行
        //   （上一段已以换行结尾就不重复补）。dsh_read 里它们本来就是两条，不受影响。
        if (chunk && c.answerBreak) {
          if (c.answer && !/\n\s*$/.test(c.answer) && !/^\s*\n/.test(chunk)) c.answer += '\n\n';
          c.answerBreak = false;
        }
        c.answer += chunk;
        this.pushOut('text', chunk);
        break;
      }
      case 'agent_thought_chunk':
        // 思考内容只进这条回合的临时收集器（用于统计/可选返回），**不进环形缓冲**
        c.reasoning += u.content?.text ?? '';
        c.reasoningChunks += 1;
        if (c.reasoningStartedAt === 0) c.reasoningStartedAt = now();
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = u.toolCallId ?? 'unknown';
        const prev = c.tools.get(id) ?? {};
        const merged = {
          ...prev,
          id,
          title: u.title ?? prev.title,
          status: u.status ?? prev.status,
          kind: u.kind ?? prev.kind,
          name: u.name ?? prev.name,
          input: u.rawInput !== undefined ? u.rawInput : prev.input,
        };
        c.tools.set(id, merged);
        if (c.answer) c.answerBreak = true;
        const label = merged.name ?? merged.title ?? id;
        this.currentTool = merged.status === 'completed' || merged.status === 'failed' ? null : label;
        const tag = merged.status ? ` [${merged.status}]` : '';
        if (u.title !== undefined || u.status !== undefined || u.name !== undefined) {
          this.pushOut('tool', `${label}${tag}`, { tool_call_id: id });
        }
        this.#liveTool(id, merged);
        break;
      }
      case 'usage_update':
        c.usage = u;
        this.#liveUsageTick();
        break;
      case 'plan':
      case 'plan_update':
        c.plan = u;
        break;
      default:
        c.otherUpdates.push(u.sessionUpdate);
    }
  }

  /**
   * 工具状态 → live 事件。DSH 的工具更新是快照、会重复推同一状态，所以只在
   * "第一次出现 / 状态变化 / 第一次拿到输入"时写，避免刷屏。
   */
  #liveTool(id, merged) {
    const seen = this.#liveTools.get(id);
    const hasInput = merged.input !== undefined && merged.input !== null;
    const status = merged.status ?? null;
    if (seen && seen.status === status && (seen.hasInput || !hasInput)) return;
    const at = seen?.at ?? now();
    this.#liveTools.set(id, { at, status, hasInput });
    const terminal = status === 'completed' || status === 'failed';
    // 真实 DSH 的 tool_call 不带 name，工具名在 title 里（"read" / "pwsh"）。title 是纯标识符时
    // 当作名字写进 meta 级字段；带空格等可能含命令原文的 title 只进 detail。
    const titleAsName =
      typeof merged.title === 'string' && /^[\w.:-]{1,40}$/.test(merged.title) ? merged.title : null;
    this.#live(
      'tool',
      {
        tool_call_id: id,
        name: merged.name ?? titleAsName,
        kind: merged.kind ?? null,
        status,
        elapsed_ms: terminal ? now() - at : undefined,
      },
      { title: livePreview(merged.title, 200), input_preview: summarizeToolInput(merged.input) },
    );
    this.#liveUsageTick();
  }

  async onPermissionRequest(params) {
    const options = params?.options ?? [];
    const rawToolCall = params?.toolCall ?? {};
    // 真实 DSH 的 request_permission 只带 toolCallId，不带 rawInput；
    // 同一 toolCallId 的参数通常已经在 tool_call 更新里记录过，按 id 关联回来，
    // 否则审批详情里没有命令/路径，调用方无法裁决。
    const known = this.collector?.tools?.get(rawToolCall.toolCallId) ?? null;
    const toolCall = known
      ? {
          ...rawToolCall,
          name: rawToolCall.name ?? known.name,
          title: rawToolCall.title ?? known.title,
          kind: rawToolCall.kind ?? known.kind,
          rawInput: rawToolCall.rawInput ?? rawToolCall.input ?? known.input,
          locations: rawToolCall.locations ?? known.locations,
        }
      : rawToolCall;
    const desc = sanitizeApprovalContext(String(toolCall.title ?? toolCall.name ?? toolCall.toolCallId ?? '未知操作'));
    const allowId = pickOption(options, 'allow');
    const rejectId = pickOption(options, 'reject');
    const liveApproval = (mode, extra = {}) => {
      const input = toolCall.rawInput ?? toolCall.input ?? null;
      this.#live(
        'approval',
        { tool_call_id: toolCall.toolCallId ?? null, tool: toolCall.name ?? null, mode, escalation: escalationOf(input), ...extra },
        { title: livePreview(desc, 200), command_preview: summarizeToolInput(input) },
      );
    };
    const reject = () =>
      rejectId ? { outcome: { outcome: 'selected', optionId: rejectId } } : { outcome: { outcome: 'cancelled' } };

    // 规则见 approval-policy.mjs（read-only 永远拒绝；其余按 on_approval）。
    const decision = approvalDecision({ permission: this.permission, onApproval: this.onApproval });
    if (decision === 'deny') {
      const readOnly = this.permission === 'read-only';
      this.#hub.log.info(`[conv ${this.id}] ${readOnly ? 'read-only 强制拒绝审批' : '审批拒绝'}: ${desc}`);
      liveApproval(readOnly ? 'read-only-deny' : 'auto-deny');
      return reject();
    }
    if (decision === 'allow') {
      this.#hub.log.info(`[conv ${this.id}] 审批放行: ${desc}`);
      // ★ 自动放行必须对调用方可见：DSH 会借审批把沙箱提升到 danger-full-access，
      //   不记下来的话 workspace-write 会话事后看起来像从未越界（实测一轮 6 次提权无人知晓）。
      if (allowId) this.#recordAutoApproval(params, toolCall, desc, options);
      liveApproval('auto-allow');
      return allowId
        ? { outcome: { outcome: 'selected', optionId: allowId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = `ap-${Math.random().toString(36).slice(2, 10)}`;
    this.#hub.log.info(`[conv ${this.id}] 审批待裁决: ${approvalId}`);
    liveApproval('ask', { approval_id: approvalId });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(approvalId)) {
          this.#hub.log.info(`[conv ${this.id}] 审批 ${approvalId} 超时，按拒绝处理`);
          this.#liveApprovalDecided(approvalId, 'timeout', 'reject', 'cancelled');
          resolve({ outcome: { outcome: 'cancelled' } });
        }
      }, this.#hub.approvalTimeoutMs);
      this.pendingApprovals.set(approvalId, {
        params: { tool: desc, details: approvalContext(params, toolCall, desc, options) },
        createdAt: now(),
        allowId,
        rejectId,
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
    });
  }

  /**
   * 记一条"被自动放行的审批"到本回合收集器（只记摘要，且先脱敏）。
   * 回合外到来的审批（没有收集器）不记 —— 没有结果可挂。
   */
  #recordAutoApproval(params, toolCall, desc, options) {
    const c = this.collector;
    if (!c) return;
    c.autoApprovalTotal = (c.autoApprovalTotal ?? 0) + 1;
    if (escalationOf(toolCall.rawInput ?? toolCall.input ?? null)) c.autoEscalationTotal = (c.autoEscalationTotal ?? 0) + 1;
    if (!Array.isArray(c.autoApprovals)) c.autoApprovals = [];
    if (c.autoApprovals.length >= MAX_AUTO_APPROVALS_KEPT) return;
    c.autoApprovals.push(autoApprovalSummary(params, toolCall, desc, options));
  }

  /** 调用方裁决一个待决审批。 */
  decideApproval(approvalId, decision) {
    const p = this.pendingApprovals.get(approvalId);
    if (!p) throw new Error(`没有待决审批: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    const chosen = decision === 'allow' ? p.allowId : p.rejectId;
    // ★ 没有对应 option 时实际发出的是 cancelled。必须把 effective 如实告诉调用方，
    //   否则 dsh_approval_decide 会渲染成"已裁决为 allow"，而 DSH 收到的是取消（假成功）。
    const effective = chosen ? 'selected' : 'cancelled';
    p.resolve(chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } });
    this.#liveApprovalDecided(approvalId, 'caller', decision, effective);
    return {
      approval_id: approvalId,
      decision,
      effective,
      ...(chosen ? {} : { reason: 'no_option' }),
    };
  }

  /**
   * 起不来时的统一收尾：唤醒所有等本轮结束的插话请求，并落一条 error 哨兵。
   *
   * 这两件事必须都做、且互相独立：
   *   - 只写哨兵救不了 `dsh_interject`——它等的是 idleWaiters，不是文件；
   *   - 只唤醒不写哨兵，调用方事后 `dsh_get(run_id)` 就永远找不到这次失败。
   */
  #settleFailedRun(runRecord, error, { status = 'error' } = {}) {
    const stopReason = status === 'cancelled' ? 'cancelled' : 'error';
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) {
      try {
        w();
      } catch {}
    }
    this.#scheduleDrain();
    if (this.currentRun === runRecord) this.currentRun = null;
    runRecord.ended_at = now();
    runRecord.status = stopReason;
    runRecord.error = error?.message ?? String(error);
    runRecord.elapsed_ms = 0;
    if (this.#liveUsage?.runId === runRecord.run_id) this.#liveUsage = null;
    emitLive(
      this.id,
      'run.end',
      { run: runRecord.run_id, turn: this.currentTurn, status: stopReason, stop_reason: stopReason },
      { error: livePreview(runRecord.error, 300) },
    );
    runRecord.result = attachReview(
      terminalResult({ conversationId: this.id, runId: runRecord.run_id, stopReason, error: runRecord.error }),
      { conversationId: this.id, run: runRecord, mode: runRecord.review_mode ?? this.review, permission: this.permission },
    );
    try {
      if (typeof this.#hub.writeRunSentinel === 'function') {
        const file = this.#hub.writeRunSentinel(this.id, runRecord);
        runRecord.result.sentinel_file = file ?? this.#hub.runSentinelPath?.(this.id, runRecord.run_id) ?? null;
        if (!file) runRecord.result.sentinel_error = runRecord.sentinel_error ?? '哨兵文件写入失败';
      }
    } catch (e) {
      runRecord.result.sentinel_error = `写完成哨兵失败: ${e.message}`;
    }
    try {
      this.#hub.save?.();
    } catch {}
    return runRecord.result;
  }

  /**
   * 共享进程池的进程意外退出：把本会话在跑的回合标成失败并落哨兵，
   * 然后解除 proc 引用，下次调用会重新 acquireHost + resume。
   */
  onProcessExit(reason) {
    this.proc = null;
    this.recycling = null;
    if (this.busy && this.currentRun) {
      this.busy = false;
      this.#settleFailedRun(this.currentRun, new Error(String(reason)));
    }
  }

  // ── 跑任务 ──────────────────────────────────────────────────────

  /** 发一个回合并等到结束。 */
  /**
   * 派一个回合。
   *
   * **超时语义（这里曾经把会话跑挂，改之前务必读完）**
   *
   *   - **ACP 请求本身不设超时**：超时只决定"我们等不等"，永远不掐断回合。
   *     旧实现给 ACP 请求设超时，一到期就本地放弃并把 `busy` 置 false —— 那是在
   *     **谎报回合结束**：结果丢了、token 照烧，而且 reaper 看到 `busy=false` 就会
   *     把一个**正在干活**的进程回收掉 → 回合变 `interrupted` → 该会话此后 resume 失败、
   *     永久卡死（真实事故）。
   *   - `wait=false`：压根不等，立即返回 `run_id`；回合真正结束时写哨兵通知调用方。
   *   - `wait=true` ：最多等 `timeoutMs`（`<=0` 表示一直等）。到期**不报错、不丢结果**，
   *     返回 `{still_running:true, run_id, sentinel_file}` —— 即把 wait=true 降级成 wait=false：
   *     回合继续跑，结束时照常写哨兵，调用方拿 `run_id` 事后验收。
   *
   * @returns 等到回合结束 → 完整 result；没等到（wait=false 或等超时）→ 收据对象
   */
  async prompt(text, { reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, run, wait = true, review, via = 'send' } = {}) {
    if (this.busy) {
      throw new Error(
        `会话 ${this.id} 正在跑另一个回合。可以：dsh_interject 插话（打断并改口 / 排队），或 dsh_interrupt 打断。`,
      );
    }
    const runRecord = run ?? this.createRun(text, { review });
    const reviewMode = runRecord.review_mode ?? normalizeReviewMode(review ?? this.review);
    runRecord.review_mode = reviewMode;
    runRecord.status = 'running';
    runRecord.started_at = now();
    this.currentRun = runRecord;
    let before = null;
    let proc;
    // ★ `busy` 必须在 ensureAlive **之前**置位。
    //   否则"把进程拉起来"这段（spawn + initialize + resume，可能好几秒）是一个**裸奔窗口**：
    //     ① reaper 看到 busy=false 且 lastUsedAt 还是上一轮的时刻（已过期），会把这个**刚拉起来**
    //        的进程当空闲回收掉 → 紧接着 resume 就报"DSH 进程未运行"（test/cycle.mjs 实测抓到）；
    //     ② 第二个 dsh_send 同样能通过 busy 检查，于是为同一会话再拉一个子进程 → 互相撞锁 + 泄漏。
    //   ★ 同理，git 快照的 await 也必须放在 busy 置位**之后**（见下面的 Promise.all）。
    this.busy = true;
    this.lastUsedAt = now();
    // 冷启动窗口（拉进程 + resume）里 dsh_interrupt 只能记一笔，session/prompt 发出前再看。
    this.#undispatched = runRecord;
    this.#cancelBeforeDispatch = false;
    let cancelledBeforeDispatch = false;
    try {
      // ★ forget 是终态：本实例的排队任务、或另一个实例写了墓碑之后，这里都不能再派活。
      //   拉进程前后各看一次（冷启动期间墓碑可能刚落地）（审计 B04 / C03）。
      this.#assertNotForgotten();
      const beforePromise = gitStatus(this.cwd);
      // 快照与拉起进程并行：快照只是读盘，不改变生命周期，早取晚取语义一致。
      const [beforeSnap, liveProc] = await Promise.all([beforePromise, this.ensureAlive()]);
      before = beforeSnap;
      proc = liveProc;
      this.#assertNotForgotten();
      cancelledBeforeDispatch = this.#cancelBeforeDispatch;
    } catch (e) {
      this.#undispatched = null;
      // 起不来（撞写锁 / 会话损坏）就**必须放开 busy**，否则这个会话被永久占住；
      // 同时别留一条永远 "running" 的幽灵记录。
      // ★ 与 finalize 对齐：失败也必须给等待者一个终态——唤醒插话队列 + 落 error 哨兵。
      //   只写哨兵救不了 dsh_interject：它等的是 idleWaiters，不是文件（默认 timeout=0 无 timer）。
      this.busy = false;
      this.#settleFailedRun(runRecord, e);
      e.runId = runRecord.run_id;
      e.status = 'error';
      e.sentinelFile = runRecord.result?.sentinel_file ?? null;
      throw e;
    }
    this.#undispatched = null;
    if (cancelledBeforeDispatch) {
      // ★ 冷启动期间已被 dsh_interrupt 中断：不再发 session/prompt，回合以 cancelled 收尾（审计 C02）。
      this.busy = false;
      return this.#settleFailedRun(runRecord, new Error('回合在发出前被中断（dsh_interrupt）'), { status: 'cancelled' });
    }
    this.currentTurn += 1;
    this.turnStartedAt = now();
    this.turnOutChars = 0;
    this.currentTool = null;
    this.pushOut('user', text.length > MAX_PROMPT_ECHO ? `${text.slice(0, MAX_PROMPT_ECHO)}…（已截断）` : text);
    this.pushOut('turn', `第 ${this.currentTurn} 轮开始`, { phase: 'start' });
    this.#liveTools.clear();
    // live 关闭时不读投影缓存（emitLive 会直接丢弃，读了也白读）。
    this.#liveUsage = liveSettings().level === 'off'
      ? null
      : { runId: runRecord.run_id, turn: this.currentTurn, base: this.#readTokenUsage()?.totals ?? null, at: 0, last: '' };
    this.#live(
      'run.start',
      { via, permission: this.permission, on_approval: this.onApproval, cwd: this.cwd },
      { prompt_preview: livePreview(text, 200) },
    );
    const c = {
      answer: '',
      /** 上一段正文之后出现过工具调用：下一段正文前要补段落分隔（见 onUpdate）。 */
      answerBreak: false,
      reasoning: '',
      reasoningChunks: 0,
      reasoningStartedAt: 0,
      tools: new Map(),
      usage: null,
      plan: null,
      otherUpdates: [],
      /** 本回合被 auto-allow 放行的审批摘要（最多 MAX_AUTO_APPROVALS_KEPT 条）与总数。 */
      autoApprovals: [],
      autoApprovalTotal: 0,
      autoEscalationTotal: 0,
    };
    this.collector = c;
    const t0 = now();
    let settled = false;

    /** 把"调用方审核单"挂到回合结果上（见 run-result.mjs）。 */
    const withReview = (result) =>
      attachReview(result, { conversationId: this.id, run: runRecord, mode: reviewMode, permission: this.permission });

    /**
     * 回合真正结束时收尾。无论有没有人在等，都**只执行一次**。
     *
     * 现在是异步的（git 快照走异步子进程），但保持了三个不变量：
     *   1. 幂等：重复调用返回同一个 Promise，不会重复写哨兵；
     *   2. 不拖累生命周期：`busy=false`、唤醒 idleWaiters、#scheduleDrain
     *      都在**第一个 await 之前**同步完成，git 最慢 8s 也影响不到 reaper/插话；
     *   3. 防弹：内部异常一律兜底成 error 结果 + 哨兵，返回的 Promise 不会 reject
     *      （wait=false 的调用方不会 await 它，不能让 unhandled rejection 杀掉服务）。
     */
    let finalizePromise = null;
    const finalize = (stopReason, failure) => {
      if (finalizePromise) return finalizePromise;
      settled = true;
      finalizePromise = (async () => {
        // ★ 先启动 after 快照：调用 gitStatus 时子进程立刻 spawn，但**不 await**；
        //   这样 snapshot 的时间点仍贴近回合结束，而 busy 释放/唤醒不必等 git。
        const afterPromise = gitStatus(this.cwd);
        try {
          this.busy = false;
          if (this.currentRun === runRecord) this.currentRun = null;
          this.collector = null;
          this.currentTool = null;
          // 回合结束后，任何仍挂着的审批都已失效：统一取消并清空，避免状态里
          // 留下一个 dsh_approval_decide 只会回"没有待决审批"的幽灵。
          for (const [apId, p] of this.pendingApprovals) {
            try {
              p.resolve({ outcome: { outcome: 'cancelled' } });
            } catch {}
            this.#liveApprovalDecided(apId, 'turn_end', null, 'cancelled');
          }
          this.pendingApprovals.clear();
          this.pushOut('turn', `第 ${this.currentTurn} 轮结束（${stopReason ?? 'unknown'}）`, {
            phase: 'end',
            stop_reason: stopReason,
            error: failure ?? undefined,
          });
          emitLive(
            this.id,
            'run.end',
            {
              run: runRecord.run_id,
              turn: this.currentTurn,
              status: failure ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'done',
              stop_reason: stopReason ?? null,
              duration_ms: now() - t0,
              tool_count: c.tools.size,
              auto_approvals: c.autoApprovalTotal,
              auto_escalations: c.autoEscalationTotal,
            },
            { error: livePreview(failure, 300) },
          );
          this.turnCount += 1;
          this.lastUsedAt = now();
          this.#hub.save();
          // 唤醒所有"等本轮结束"的插话请求（busy 已置 false，它们可以安全地发下一轮）
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
          this.#scheduleDrain();
          // 到这里才允许被 git 拖慢；结果/审核单/哨兵必须等快照完成后再落。
          const after = await afterPromise;
          // 回合结束后 DSH 的 token 累计已经落盘（真机实测在哨兵之前）：发一次最终值。
          // 只发给本回合自己的跟踪器——下一回合可能已经在 git 快照期间开始了。
          if (this.#liveUsage?.runId === runRecord.run_id) {
            this.#liveUsageTick({ force: true });
            this.#liveUsage = null;
          }
          const result = {
            conversation_id: this.id,
            run_id: runRecord.run_id,
            stop_reason: stopReason,
            error: failure,
            answer: c.answer,
            thinking: formatReasoning(c, reasoning),
            thinking_stats: {
              hidden: reasoning === 'hide' || reasoning === 'marker',
              chars: c.reasoning.length,
              chunks: c.reasoningChunks,
              ms: c.reasoningStartedAt ? now() - c.reasoningStartedAt : 0,
            },
            tools_used: [...c.tools.values()],
            usage: c.usage,
            auto_approvals_total: c.autoApprovalTotal,
            auto_escalations_total: c.autoEscalationTotal,
            auto_approvals: c.autoApprovals,
            workspace_changed: !sameWorkspaceSnapshot(before, after),
            diff_stat: after,
            elapsed_ms: now() - t0,
          };
          withReview(result);
          runRecord.ended_at = now();
          runRecord.elapsed_ms = result.elapsed_ms;
          runRecord.status = failure ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'done';
          runRecord.result = result;
          // ★ 无条件写哨兵：**一个回合 = 一个哨兵文件**，没有例外。
          //   之前只在"调用方没在原地等"时才写，于是插话那一轮没有哨兵 —— 调用方的
          //   等待逻辑（等文件出现）就永远空等，即使 run 早已 status=done（真实事故）。
          //   统一规则也消除了整类"有 run_id 却没有哨兵"的坑。
          const sentinelFile = this.#hub.writeRunSentinel(this.id, runRecord);
          result.sentinel_file = sentinelFile ?? this.#hub.runSentinelPath(this.id, runRecord.run_id);
          if (!sentinelFile) result.sentinel_error = runRecord.sentinel_error ?? '哨兵文件写入失败';
          return result;
        } catch (e) {
          this.#hub.log.info(`[conv ${this.id}] 回合收尾异常（已兜底）: ${e.message}`);
          this.busy = false;
          if (this.currentRun === runRecord) this.currentRun = null;
          this.collector = null;
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
          this.#scheduleDrain();
          const fallback = withReview(
            terminalResult({
              conversationId: this.id,
              runId: runRecord.run_id,
              stopReason: 'error',
              error: `回合收尾异常: ${e.message}`,
              answer: c.answer ?? '',
              toolsUsed: [...(c.tools?.values?.() ?? [])],
              elapsedMs: now() - t0,
            }),
          );
          runRecord.ended_at = now();
          runRecord.status = 'error';
          runRecord.error = fallback.error;
          runRecord.result = fallback;
          const sentinelFile = this.#hub.writeRunSentinel(this.id, runRecord);
          fallback.sentinel_file = sentinelFile ?? this.#hub.runSentinelPath(this.id, runRecord.run_id);
          if (!sentinelFile) fallback.sentinel_error = runRecord.sentinel_error ?? '哨兵文件写入失败';
          return fallback;
        }
      })().catch((e) => {
        // 最后一层保险：收尾连兜底都失败时也绝不把 rejection 丢给事件循环。
        this.#hub.log.info(`[conv ${this.id}] 回合收尾二次异常（已忽略）: ${e.message}`);
        if (!runRecord.result) {
          runRecord.result = terminalResult({
            conversationId: this.id,
            runId: runRecord.run_id,
            stopReason: 'error',
            error: `回合收尾异常: ${e.message}`,
            answer: c.answer ?? '',
            elapsedMs: now() - t0,
          });
          runRecord.status = 'error';
        }
        return runRecord.result;
      });
      return finalizePromise;
    };

    /** 没等到结果时给调用方的收据（它靠 run_id + 哨兵文件事后验收）。 */
    const receipt = (waitedMs) => ({
      conversation_id: this.id,
      run_id: runRecord.run_id,
      status: 'running',
      still_running: true,
      accepted: true,
      background: true,
      sentinel_file: this.#hub.runSentinelPath(this.id, runRecord.run_id),
      waited_ms: waitedMs ?? 0,
    });

    // 关键：第三个参数传 0 = **不设超时**。回合只能由它自己结束，或由 session/cancel 结束。
    const acp = proc.request('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] }, 0);
    // 这个 Promise 在 finalize **真正完成**（含 workspace_changed、审核单、哨兵）后才 settle。
    // 等待方必须等它，而不是只等 acp —— 否则会拿到还没填完的 runRecord.result。
    const finished = acp
      .then(
        (res) => {
          if (res?.usage) c.usage = c.usage ?? res.usage;
          return finalize(res?.stopReason ?? null, null);
        },
        (e) => finalize('error', e.message),
      )
      .catch((e) => {
        // finalize 自己是防弹的；这里只兜住同步抛出的极端情况。
        this.#hub.log.info(`[conv ${this.id}] 回合回调异常（已兜底）: ${e.message}`);
        return runRecord.result ?? null;
      });

    if (!wait) {
      // 同步走到这里时 finalize 还没开始（ACP 回调在微任务里），返回收据即可。
      // 若极端情况下已经收尾，则等它给出完整结果，不要返回半成品。
      return settled ? await (finalizePromise ?? runRecord.result) : receipt(0);
    }
    if (timeoutMs <= 0) {
      await finished;
      return runRecord.result;
    }
    const timedOut = await Promise.race([
      finished.then(
        () => false,
        () => false,
      ),
      new Promise((r) => setTimeout(() => r(true), timeoutMs)),
    ]);
    // 超时发生在 finalize 完成之前（包括 git 快照还在跑）：给收据，不返回半成品结果。
    if (timedOut) return receipt(timeoutMs);
    return runRecord.result;
  }

  /** 中断当前回合（ACP 原生，走的就是用户手动停止那条路径）。 */
  async interrupt() {
    // ★ 冷启动窗口：回合已占住会话但 session/prompt 还没发。此时发 session/cancel 没有可取消的东西，
    //   回合随后照常派发（审计 C02）。改为记一笔，由 prompt() 在发出前放弃这个回合。
    if (this.busy && this.#undispatched) {
      this.#cancelBeforeDispatch = true;
      this.#live('interrupt', { busy: true, before_dispatch: true });
      return { interrupted: true, before_dispatch: true };
    }
    if (!this.proc?.alive) return { interrupted: false, reason: 'DSH 进程未运行' };
    this.proc.notify('session/cancel', { sessionId: this.id });
    this.#live('interrupt', { busy: this.busy });
    if (!this.busy) {
      return { interrupted: false, reason: '当前没有进行中的回合（已发送 cancel，用于清空排队输入）' };
    }
    return { interrupted: true };
  }

  /** 运行状态：running（在跑回合）/ idle（进程活着但空闲）/ detached（进程未打开，可 resume）。 */
  state() {
    if (this.busy) return 'running';
    return this.proc?.alive ? 'idle' : 'detached';
  }

  /** 追加一条输出记录（规则见 out-buffer.mjs）；正文同时计入本轮输出字数。 */
  pushOut(kind, text, extra = {}) {
    this.outBuf.push(kind, text, extra, this.currentTurn);
    if (kind === 'text') this.turnOutChars += text?.length ?? 0;
  }

  /** 读输出：**按修订号**的游标式增量。条目被追加时会再次返回（按 seq 替换全文）。 */
  readOut({ cursor = 0, includeReasoning = false, limit = 200 } = {}) {
    const page = this.outBuf.read({ cursor, limit });
    const res = {
      conversation_id: this.id,
      state: this.state(),
      busy: this.busy,
      current_tool: this.currentTool,
      ...page,
    };
    // 思考内容只在显式要求时、且只针对"当前正在跑的回合"返回；不保留、不进缓冲
    if (includeReasoning && this.collector?.reasoning) {
      res.live_thinking = this.collector.reasoning;
    }
    return res;
  }

  /** 建一条回合记录。派活时先建，好让调用方立刻拿到 run_id（异步模式的关键）。 */
  createRun(text, { clientRunId = null, review = this.review } = {}) {
    const run = this.ledger.create(text, { conversationId: this.id, clientRunId, review, sessionReview: this.review });
    // 防御性清残留：正常情况下该 run_id 从未用过，但确保等待方不会被历史哨兵误触发。
    this.#hub.clearRunSentinel(this.id, run.run_id);
    return run;
  }

  /** 按调用方幂等键取 run（不存在/已淘汰返回 null）。 */
  getRunByClientId(clientRunId) {
    return this.ledger.byClientId(clientRunId);
  }

  /**
   * 一个还没发出就被取消的 run（队列里被移除、插话等不到上一轮结束）的终态：
   * 结果 + 审核单 + live 事件 + 哨兵。取消也是终态，必须写哨兵，否则等待方永远空等。
   */
  #cancelUnstartedRun(run, message) {
    run.status = 'cancelled';
    run.ended_at = now();
    run.elapsed_ms = 0;
    // 取消同样是一次终态结果：审核单照挂，调用方仍可记录"这次没跑成"。
    run.result = attachReview(
      terminalResult({ conversationId: this.id, runId: run.run_id, stopReason: 'cancelled', error: message }),
      { conversationId: this.id, run, mode: run.review_mode, permission: this.permission },
    );
    emitLive(
      this.id,
      'run.end',
      { run: run.run_id, turn: this.currentTurn, status: 'cancelled', stop_reason: 'cancelled' },
      { error: livePreview(message, 300) },
    );
    const file = this.#hub.writeRunSentinel?.(this.id, run);
    run.result.sentinel_file = file ?? this.#hub.runSentinelPath?.(this.id, run.run_id) ?? null;
  }

  // ── 会话级队列（忙时非阻塞入队）────────────────────────────────

  /** 入队；返回 run 记录与 1-based 位置。队列只在内存，重启丢失。 */
  enqueue(text, { reasoning = 'hide', clientRunId = null, preview = null, review = this.review } = {}) {
    if (clientRunId) {
      const existing = this.getRunByClientId(clientRunId);
      if (existing) return { run: existing, position: 0, deduped: true };
    }
    this.ledger.assertRoom();
    // 预览用调用方原文，执行用可能已注入团队前缀的 text。
    const run = this.createRun(preview ?? text, { clientRunId, review });
    run.status = 'queued';
    const position = this.ledger.enqueue({ run, text, reasoning, clientRunId, enqueued_at: now() });
    emitLive(
      this.id,
      'run.queued',
      { run: run.run_id, turn: this.currentTurn, position, cwd: this.cwd },
      { prompt_preview: livePreview(run.prompt_preview, 200) },
    );
    return { run, position, deduped: false };
  }

  queueList() {
    // 防御：snapshot 可能被测试用 prototype 替身调用（没有构造器初始化 ledger）。
    return this.ledger?.list() ?? [];
  }

  queueRemove(runId, { cancel = true } = {}) {
    const item = this.ledger.take(runId);
    if (cancel) this.#cancelUnstartedRun(item.run, 'queued run cancelled before it started');
    return { removed: true, run_id: runId };
  }

  queueUpdate(runId, text) {
    this.ledger.update(runId, text);
    return { updated: true, run_id: runId };
  }

  queuePromote(runId) {
    this.ledger.promote(runId);
    return { promoted: true, run_id: runId, position: 1 };
  }

  /** 空闲时取队首执行。失败也要继续下一条（否则一条坏任务卡死整条队列）。 */
  #scheduleDrain() {
    if (this.busy || this.draining || this.queue.length === 0) return;
    this.draining = true;
    const timer = setTimeout(() => {
      this.draining = false;
      if (this.busy || this.queue.length === 0) return;
      const item = this.ledger.shift();
      const run = item.run;
      run.status = 'running';
      this.prompt(item.text, { reasoning: item.reasoning, run, wait: false, via: 'queue' })
        .catch(() => {})
        .finally(() => this.#scheduleDrain());
    }, 0);
    timer.unref?.();
  }

  /** 取回合记录；不传 run_id 就是最近一条。 */
  getRun(runId) {
    if (runId) {
      const r = this.ledger.find(runId);
      if (!r) {
        throw new Error(`未知 run_id: ${runId}（回合记录只在内存、只留最近 ${MAX_RUNS} 条；也可用 dsh_read 读输出缓冲）`);
      }
      return r;
    }
    return this.ledger.latest();
  }

  /**
   * 异步收据里的"待审核"审核单：回合还没结束，只有清单和 run_id，
   * 告诉调用方"拿到哨兵结果后先审核，再当完成"。
   */
  pendingReviewTicket(runId) {
    const run = this.ledger.find(runId);
    const mode = run?.review_mode ?? this.review;
    if (mode === 'off') return null;
    return buildReviewTicket({
      conversationId: this.id,
      runId,
      promptPreview: run?.prompt_preview ?? null,
      result: null,
      mode,
      permission: this.permission,
      pending: true,
    });
  }

  /**
   * 记录调用方对某个已完成回合的审核裁决。
   *
   * 三种来源按优先级取事实：
   *   1) 内存里的 run（含完整 result）；
   *   2) 哨兵文件（服务重启 / run 记录被挤出内存后仍然可审核）；
   *   3) 已有的审核记录（允许修订裁决）。
   *
   * 注意：**不阻塞后续派活，也不自动回灌给 DSH**。审核只是把"调用方已经看过并给出结论"
   * 这件事落成可审计的事实；要修就由调用方再 dsh_send。
   */
  submitReview(runId, { verdict, notes, findings } = {}) {
    if (typeof runId !== 'string' || runId.trim() === '') {
      throw new Error('run_id 不能为空');
    }
    assertSafeId(runId, 'run_id');
    if (!REVIEW_VERDICTS.includes(verdict)) {
      throw new Error(`verdict 必须是 ${REVIEW_VERDICTS.join(' | ')} 之一`);
    }
    const cleanNotes = typeof notes === 'string' ? notes.trim() : '';
    const cleanFindings = Array.isArray(findings)
      ? findings.filter((f) => typeof f === 'string' && f.trim() !== '').map((f) => f.trim())
      : [];
    if (verdict !== 'pass' && !cleanNotes && !cleanFindings.length) {
      throw new Error('verdict=fail/partial 时必须提供 notes（或 findings）说明理由');
    }

    const run = this.ledger.find(runId);
    let result = run?.result ?? null;
    let promptPreview = run?.prompt_preview ?? null;
    let mode = run?.review_mode ?? this.review;

    if (run) {
      if (run.status === 'running' || run.status === 'queued') {
        throw new Error(`回合 ${runId} 还没结束，不能审核（等哨兵文件出现或 dsh_get 显示完成后重试）`);
      }
      if (!result) throw new Error(`回合 ${runId} 没有可用结果，无法审核`);
    } else {
      // 内存里没有这条 run：以哨兵为准。它只在回合终止时写入，所以天然是"已完成"。
      let sentinel = null;
      try {
        sentinel = JSON.parse(readFileSync(this.#hub.runSentinelPath(this.id, runId), 'utf8'));
      } catch {
        /* 下面的审核记录回退会给出更准确的错误 */
      }
      if (sentinel) {
        result = sentinel.result ?? null;
        if (result?.review && typeof result.review === 'object') {
          promptPreview = result.review.prompt_preview ?? promptPreview;
          mode = result.review.mode ?? mode;
        }
      }
    }

    const existing = readReviewRecord(this.id, runId);
    if (!result && !existing) {
      throw new Error(
        `未知 run_id: ${runId}（内存里没有、也没有哨兵/审核记录；请确认 run_id 是否正确，` +
          `或先用 dsh_get / 哨兵文件取回结果）`,
      );
    }

    const ticket =
      result?.review && typeof result.review === 'object'
        ? { ...result.review }
        : existing
          ? { ...existing }
          : buildReviewTicket({
              conversationId: this.id,
              runId,
              promptPreview,
              result: result ?? {},
              mode,
              permission: this.permission,
            });
    if (!ticket.review_id) ticket.review_id = reviewIdForRun(runId);
    ticket.conversation_id = ticket.conversation_id ?? this.id;
    ticket.run_id = ticket.run_id ?? runId;
    ticket.mode = ticket.mode ?? mode;

    const reviewedAt = new Date().toISOString();
    const { file, payload } = writeReviewRecord({
      ticket,
      verdict,
      notes: cleanNotes,
      findings: cleanFindings,
      reviewedAt,
    });
    const review = {
      ...ticket,
      status: verdict,
      verdict,
      notes: payload.notes,
      findings: payload.findings,
      reviewed_at: reviewedAt,
      review_file: file,
    };
    if (run) {
      run.review = review;
      if (run.result && typeof run.result === 'object') run.result.review = review;
    }
    // 哨兵是调用方异步收活的来源；把裁决回写进去，避免它一直显示 pending。
    this.#hub.updateRunSentinelReview(this.id, runId, {
      status: review.status,
      verdict: review.verdict,
      notes: review.notes,
      findings: review.findings,
      reviewed_at: reviewedAt,
      review_file: file,
    });
    return {
      ...review,
      review_file: file,
      sentinel_file: this.#hub.runSentinelPath(this.id, runId),
    };
  }

  /** 等到当前回合结束（不忙则立即返回 true；`timeoutMs <= 0` 一直等；超时返回 false）。 */
  async waitIdle(timeoutMs = 30 * 60 * 1000) {
    if (!this.busy) return true;
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = this.idleWaiters.indexOf(done);
          if (i >= 0) this.idleWaiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
      }
      this.idleWaiters.push(done);
    });
  }

  /**
   * 插话。
   *
   * ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`），
   * 所以做不到"把消息塞进正在跑的回合里让模型即时改向"——DSH 的 agent 本身有 steering
   * 队列，但被 ACP 桥接层挡住了。这里提供的是它的实用等价物：
   *
   *   interject —— 打断当前回合，随即把新消息作为新回合发出（"停一下，听我说"）
   *   queue     —— 不打断，等当前回合自然结束后紧接着发出（"你先把这轮干完，然后…"）
   *
   * 之所以无竞态：dsh-acp 在让 prompt 请求返回**之前**就清空了 inflight 槽位，
   * 且只在 agent 完全 idle 后才 settle（lib/index.js:1003-1011）。
   */
  async interject(message, { mode = 'interject', reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, clientRunId = null, review } = {}) {
    // 先建 run：幂等键要在"等待上一轮"之前就登记，否则重试会造出第二个 run。
    const run = this.createRun(message, { clientRunId, review });
    if (!this.busy) {
      const r = await this.prompt(message, { reasoning, timeoutMs, run, via: 'interject' });
      return { ...r, interjected: 'idle', waited_ms: 0 };
    }
    const t0 = now();
    if (mode === 'interject') {
      // 冷启动窗口里 session/cancel 没东西可取消（同 interrupt，审计 C02）。
      if (this.#undispatched) this.#cancelBeforeDispatch = true;
      else this.proc?.notify('session/cancel', { sessionId: this.id });
    }
    this.#live('interject', { mode, pending_run: run.run_id }, { text_preview: livePreview(message, 200) });
    // 排队等待的时长跟随调用方的 timeoutMs（0 = 一直等），不再固定 30 分钟。
    // ★ 被唤醒时会话可能已被同时等待的另一条插话/队列抢先占住：继续等，而不是撞上
    //   “正在跑另一个回合”失败、留下一条永远 queued 且没有哨兵的 run（审计 C04）。
    let idle = await this.waitIdle(timeoutMs);
    while (idle && this.busy) {
      const left = timeoutMs > 0 ? timeoutMs - (now() - t0) : 0;
      idle = timeoutMs > 0 && left <= 0 ? false : await this.waitIdle(left);
    }
    const waited = now() - t0;
    if (!idle) {
      const err = new Error('等待当前回合结束超时，插话未发送');
      err.runId = run.run_id;
      this.#cancelUnstartedRun(run, err.message);
      throw err;
    }
    const r = await this.prompt(message, { reasoning, timeoutMs, run, via: mode === 'queue' ? 'queue' : 'interject' });
    return { ...r, interjected: mode, waited_ms: waited };
  }

  /** 关闭会话（进程收尾；会话本体留在磁盘上，可再次 resume）。 */
  async close({ forget = false } = {}) {
    if (forget) {
      // ★ 另一个活着的实例正握着写锁、还在用这个会话：这边写墓碑并报“已 forget”，
      //   那边照样继续跑（审计 C03）。先让持有者释放。
      const holder = this.proc?.alive ? null : classifyHolder(this.id, { knownChildPid: this.lastChildPid });
      if (holder?.kind === 'live-mcp') {
        return {
          closed: false,
          forgotten: false,
          error: `另一个活着的 dsh-any-agent 实例（PID ${holder.marker?.mcp_pid ?? '?'}）正持有该会话的写锁：先在那边 dsh_release，再 forget。`,
        };
      }
      // ★ forget 之前先撤掉排队任务（各自落 cancelled 哨兵）：否则停进程时在跑的回合一结束，
      //   队首就会被 drain 发出去，把已经 forget 的会话又 resume 回来（审计 B04）。
      for (const item of [...this.queue]) this.queueRemove(item.run.run_id);
    }
    if (this.recycling) await this.recycling;
    const proc = this.proc;
    let stopped = true;
    if (proc?.alive) {
      if (typeof proc.detach === 'function') {
        // 共享进程：只把本会话摘出去（detach 内会 session/close）；最后一个走了才停进程。
        this.recycling = proc.detach(this).finally(() => {
          if (this.proc === proc) this.proc = null;
          this.recycling = null;
        });
        stopped = await this.recycling;
      } else {
        try {
          await proc.request('session/close', { sessionId: this.id }, 10_000);
        } catch {}
        // 与 reaper 相同：stop 期间保持 proc 可见并登记 recycling，
        // 落定后再置空——否则并发 dsh_send 会拿到垂死进程或去抢尚未释放的锁。
        this.recycling = proc
          .stop()
          .catch(() => false)
          .finally(() => {
            if (this.proc === proc) this.proc = null;
            this.recycling = null;
          });
        stopped = await this.recycling;
      }
    } else if (this.proc === proc) {
      this.proc = null;
    }
    // 回合已经结束/进程正在关闭，任何仍挂着的审批都不再可裁决。
    for (const [apId, p] of this.pendingApprovals) {
      try {
        p.resolve({ outcome: { outcome: 'cancelled' } });
      } catch {}
      this.#liveApprovalDecided(apId, 'close', null, 'cancelled');
    }
    this.pendingApprovals.clear();
    // 只有确认进程退出后才删登记；否则把登记留着，让 takeover/classifyHolder
    // 还能把这个仍握着写锁的孤儿归因出来。
    if (stopped) removeMarker(this.id);
    else {
      this.#hub.log.info(`[conv ${this.id}] 进程未能确认退出，保留写锁登记以便后续归因`);
      // 进程还活着时不能 forget：墓碑会让按 id 查询直接失败，而活着的进程
      // 仍握着写锁，之后连 takeover 都无法归因/接管。
      if (forget) return { closed: false, forgotten: false, error: '进程未能确认退出，拒绝 forget' };
    }
    if (forget) {
      // 先写墓碑再从注册表移除：之后按 id 查询会明确报"已 forget"，
      // 而不是从 DSH 会话存储把它重建回来（否则 forget 形同虚设）。
      // ★ 墓碑写不进去就不能报“已 forget”，也不从注册表移除（审计 B04）。
      const tombErr = writeTombstone(this.id);
      if (tombErr) {
        this.#hub.save();
        return { closed: stopped, forgotten: false, error: `forget 墓碑写入失败（会话未移除，可修复后重试）：${tombErr}` };
      }
      this.#hub.remove(this.id);
      // forget 是"永久移除"：事件流也一并删掉，查看器里不再出现这个会话。
      removeLive(this.id);
    } else {
      this.#hub.save();
      this.#live('conv.close', { stopped });
    }
    return { closed: stopped, forgotten: forget, ...(stopped ? {} : { error: '进程未能确认退出，登记已保留' }) };
  }
}

/** 按档位渲染思考内容。 */
export function formatReasoning(c, mode) {
  if (mode === 'full') return c.reasoning;
  if (mode === 'summary') {
    const t = c.reasoning.trim();
    if (!t) return '';
    if (t.length <= 400) return t;
    return `${t.slice(0, 240)}\n…\n${t.slice(-120)}`;
  }
  if (mode === 'marker') {
    return c.reasoning ? `[思考已隐藏：${c.reasoning.length} 字]` : '';
  }
  return ''; // hide
}
