/**
 * 会话（Conversation）与注册表（Hub）。
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
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  lstatSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ALLOW_FULL_ACCESS,
  APPROVAL_POLICIES,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  IDLE_TTL_MS,
  LIST_PROBE_TTL_MS,
  MAX_LIVE,
  MAX_RSS_MB,
  PERMISSION_TIERS,
  PROMPT_TIMEOUT_MS,
  REAP_INTERVAL_MS,
  REASONING_EFFORTS,
  REVIEWS_DIR,
  REVIEW_MODES,
  RUNS_DIR,
  SENTINEL_INCLUDE_REASONING,
  SENTINEL_TTL_MS,
  SHARED_PROCESS,
  STATE_FILE,
  LEGACY_STATE_FILE,
  USING_DEFAULT_STATE,
  DSH_HOME,
  assertWritableDir,
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
import { SessionHost } from './host.mjs';
import { rssMb } from './procstat.mjs';
import { readConversationMeta } from './titles.mjs';
import { registerWorkspace, findSessionHeaderStatus } from './workspace.mjs';
import {
  LOCKS_DIR,
  classifyHolder,
  describeLeaseConflict,
  heartbeat as lockHeartbeat,
  isLeaseError,
  isPidAlive,
  killHolderChild,
  removeMarker,
  writeMarker,
} from './locks.mjs';

const now = () => Date.now();
const NOOP_LOG = { info: () => {}, debug: () => {}, dshStderr: () => {} };

/**
 * 会话元数据侧车（`.state/meta/<id>.json`）。
 *
 * 为什么需要：`forget=true` 只从注册表移除；之后按 id 查询时，`Hub.get()` 会从
 * DSH 会话存储重建会话（这是多实例恢复的刻意设计）。但 DSH 的会话记录里**没有**
 * 本服务选择的 `onApproval` / `reasoning_effort` / `title_hint` / 轮数，
 * 重建就会悄悄回落到默认值（实测 auto-allow→ask、low→max）。这个侧车保存
 * **仅元数据**（不含任何对话/思考正文），让重建后仍与原会话一致。
 */
const META_DIR = join(dirname(STATE_FILE), 'meta');
const metaFilePath = (id) => join(META_DIR, `${id}.json`);

function writeConversationMeta(conv) {
  try {
    mkdirSync(META_DIR, { recursive: true });
    const file = metaFilePath(conv.id);
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(conv.toMeta(), null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 元数据侧车只是辅助信息，写失败不影响主流程 */
  }
}

function readConversationMetaFile(id) {
  try {
    return JSON.parse(readFileSync(metaFilePath(id), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * forget 墓碑：`release(forget=true)` 之后，按 id 查询必须**明确失败**，
 * 而不是从 DSH 会话存储里悄悄复活。墓碑只含 id 与时间，不含任何内容；
 * 删除 `.state/forgotten/<id>.json` 即可恢复按 id 找回（手动、可审计）。
 */
// 墓碑放在 DSH home 下而不是注册表旁边：不同实例即使注册表路径不同，
// 也应该对同一个会话的 forget 达成一致（forget 是会话级终态，不是注册表级）。
const FORGOTTEN_DIR = process.env.DSH_MCP_FORGOTTEN_DIR ?? join(DSH_HOME, '.dsh-any-agent-forgotten');
const forgottenPath = (id) => join(FORGOTTEN_DIR, `${id}.json`);

function writeTombstone(id) {
  try {
    mkdirSync(FORGOTTEN_DIR, { recursive: true });
    const file = forgottenPath(id);
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify({ id, forgottenAt: Date.now() }, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 墓碑写失败时 forget 仍从注册表移除；下次 get 可能仍会复活，但不影响主流程 */
  }
}

function isForgotten(id) {
  try {
    return existsSync(forgottenPath(id));
  } catch {
    return false;
  }
}

/**
 * 启动时清掉“会话文件已经不存在”的墓碑：它们不再阻止任何 resurrection，
 * 留着只会让测试/临时会话在 `$DSH_HOME/.dsh-any-agent-forgotten` 里堆积。
 * 会话文件还在的墓碑必须保留 —— 那正是 forget 的效力所在。
 */
async function pruneStaleTombstones(log = NOOP_LOG) {
  let removed = 0;
  try {
    if (!existsSync(FORGOTTEN_DIR)) return 0;
    for (const f of readdirSync(FORGOTTEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      // 异步读会话头：启动路径不能被大日志的同步解压卡住。
      // ★ 只有确认会话文件不存在时才删墓碑；读超时/损坏时保留，
      //   否则一次慢盘/挂载异常就会让 forget 失效。
      const found = await findSessionHeaderStatus(id);
      if (found.status === 'found' || found.status === 'error') {
        if (found.status === 'error') log.info(`[hub] 墓碑 ${id} 暂不清理：${found.reason}`);
        continue;
      }
      try {
        rmSync(join(FORGOTTEN_DIR, f), { force: true });
        removed++;
      } catch {}
    }
  } catch {
    /* 清理失败不影响启动 */
  }
  return removed;
}

/** 运行期输出环形缓冲的条目上限（仅内存，超出丢最旧的）。 */
const MAX_OUT_ENTRIES = 500;
/** 单条输出正文的字符上限；超出保留尾部，避免一条超长输出把内存撑爆。 */
const MAX_OUT_TEXT = 200_000;
/** 记录用户发话时的截断长度（避免一条把缓冲撑爆）。 */
const MAX_PROMPT_ECHO = 4000;
/** 保留的回合记录条数（run 结果含正文，所以只留最近若干条，仅内存）。 */
const MAX_RUNS = 20;
/** 回合记录里 prompt 预览的长度。 */
const MAX_RUN_PREVIEW = 200;
/** 每个回合最多保留多少条"自动放行审批"摘要（总数另计，不受此限）。 */
const MAX_AUTO_APPROVALS_KEPT = 20;
/** 自动放行审批里命令预览的长度。 */
const MAX_AUTO_APPROVAL_PREVIEW = 200;

/**
 * 清掉 `dir` 下超过 TTL 的文件与空会话目录；`.tmp` 残留不论年龄都按同一 cutoff 清。
 * 只遍历一层会话目录，绝不递归进别处 —— 调用方（哨兵/审核目录）都是本服务自己的。
 */
function pruneDirTree(dir, ttlMs) {
  if (!ttlMs || !existsSync(dir)) return { pruned: 0, dirs_removed: 0 };
  let pruned = 0;
  let dirsRemoved = 0;
  const cutoff = Date.now() - ttlMs;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const fp = join(sub, f.name);
        try {
          if (statSync(fp).mtimeMs < cutoff) {
            rmSync(fp, { force: true });
            pruned++;
          }
        } catch {
          /* 单个文件失败就跳过 */
        }
      }
      try {
        if (readdirSync(sub).length === 0) {
          rmSync(sub, { recursive: true, force: true });
          dirsRemoved++;
        }
      } catch {
        /* 目录清理失败无所谓 */
      }
    }
  } catch {
    /* 目录读不了就跳过 */
  }
  return { pruned, dirs_removed: dirsRemoved };
}

/** 按 ACP 权限应答的规范形状挑选项。 */
function pickOption(options, want) {
  const list = Array.isArray(options) ? options : [];
  const match = list.find((o) => typeof o?.kind === 'string' && o.kind.startsWith(want));
  return match?.optionId;
}

function approvalContext(params, toolCall, desc, options) {
  const input = toolCall.rawInput ?? toolCall.input ?? null;
  return sanitizeApprovalContext({
    tool: toolCall.name ?? desc,
    title: desc,
    tool_call_id: toolCall.toolCallId ?? null,
    kind: toolCall.kind ?? null,
    description: input?.description ?? null,
    reason: params?.reason ?? input?.justification ?? input?.reason ?? null,
    input,
    locations: toolCall.locations ?? [],
    options,
  });
}

/**
 * 把会话级配置套到 ACP 会话上。
 *
 * 两件必须知道的事：
 *   1) ACP 的 `reasoning_effort` 默认值是**空串**（Provider default），不是最大档，
 *      所以要显式设。传 'default' 即还原成空串（不设置）。
 *   2) **新进程不会记住**这些选择，因此 session/new 之后、以及每次 resume 之后都要重套一遍。
 *
 * 失败不致命：记进 applied/failed 供上层展示，避免因为某个模型不支持某一项而整个建会话失败。
 */
async function applySessionConfig(proc, sessionId, cfg) {
  const applied = [];
  const failed = [];
  const set = async (configId, value, label) => {
    if (value === undefined || value === null || value === '') return;
    try {
      // 注意方法名是 ACP 的 snake_case：session/set_config_option
      // （写成 session/setConfigOption 会得到 -32601 Method not found，且很容易被忽略）
      await proc.request('session/set_config_option', { sessionId, configId, value }, 30_000);
      applied.push(label);
    } catch (e) {
      failed.push(`${label} 设置失败: ${e.message}`);
    }
  };
  const effort = cfg.reasoningEffort === 'default' ? '' : cfg.reasoningEffort;
  // Selecting a model resets its dependent reasoning option in ACP. Apply effort last.
  if (cfg.provider && cfg.model) {
    await set('model', JSON.stringify([cfg.provider, cfg.model]), `模型=${cfg.provider}/${cfg.model}`);
  }
  await set('reasoning_effort', effort, `思考深度=${effort}`);
  return { applied, failed };
}

/**
 * 哨兵文件里的 result 是否要剥离思考内容。
 * 默认剥离以维持"思考不落盘"的保证，并留下 thinking_omitted 标记，
 * 免得调用方以为字段是意外丢失的。
 */
export function sanitizeResultForSentinel(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const { thinking, ...rest } = result;
  // ★ 即使 DSH_MCP_SENTINEL_INCLUDE_REASONING=1，也只额外保留 thinking；
  //   answer/error/title/tools_used 仍然必须脱敏（以前这个开关会跳过整段清洗）。
  // 正文/错误/标题同样可能夹带密钥；哨兵是落盘副本，统一套脱敏。
  for (const key of ['answer', 'error', 'title']) {
    if (typeof rest[key] === 'string') rest[key] = sanitizeApprovalContext(rest[key], key);
  }
  // 工具输入里会有完整命令、路径，甚至写入的文件内容。哨兵会保留 7 天，
  // 所以按审批上下文同一套规则脱敏（密钥/令牌/密码类字段与常见内联字面量）。
  if (Array.isArray(rest.tools_used)) {
    rest.tools_used = rest.tools_used.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const { input, ...meta } = t;
      const safeMeta = sanitizeApprovalContext(meta);
      return input === undefined ? safeMeta : { ...safeMeta, input: sanitizeApprovalContext(input) };
    });
  }
  // 自动放行审批摘要记录时已脱敏；落盘前再过一遍，防止将来有人加字段漏掉。
  if (Array.isArray(rest.auto_approvals)) {
    rest.auto_approvals = rest.auto_approvals.map((a) => (a && typeof a === 'object' ? sanitizeApprovalContext(a) : a));
  }
  // 审核单里可能有原任务预览、审核理由与证据摘要；哨兵会保留 7 天，同样要脱敏。
  if (rest.review && typeof rest.review === 'object') {
    const rv = { ...rest.review };
    for (const key of ['prompt_preview', 'notes']) {
      if (typeof rv[key] === 'string') rv[key] = sanitizeApprovalContext(rv[key], key);
    }
    if (Array.isArray(rv.checklist)) rv.checklist = rv.checklist.map((x) => sanitizeApprovalContext(x));
    if (Array.isArray(rv.findings)) rv.findings = rv.findings.map((x) => sanitizeApprovalContext(x));
    if (rv.evidence) rv.evidence = sanitizeApprovalContext(rv.evidence);
    rest.review = rv;
  }
  // 始终给出布尔值：调用方才能区分“思考被剥离”与“本来没有思考”。
  const out = { ...rest, thinking_omitted: Boolean(thinking) && !SENTINEL_INCLUDE_REASONING };
  if (SENTINEL_INCLUDE_REASONING && thinking !== undefined) out.thinking = thinking;
  return out;
}

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

    /**
     * 运行期输出环形缓冲（**仅内存、有界、不落盘**），供"查看正在跑的会话输出"用。
     * 只记三类：用户发的话、agent 的正文、工具调用状态；**思考内容一律不进这里**。
     */
    this.out = [];
    this.outSeq = 0;
    /** 输出缓冲的**修订号**：每次追加（含合并进已有条目）都 +1，供游标式增量读使用。 */
    this.outRev = 0;
    this.turnOutChars = 0;
    this.currentTurn = 0;
    this.turnStartedAt = 0;
    this.currentTool = null;

    /**
     * 回合记录（run）：让"先派活、回头再验收"成为一等公民。
     * 每条含 {run_id, status, 时间, prompt 预览, result}——**仅内存**，只留最近 MAX_RUNS 条。
     */
    this.runs = [];
    this.runSeq = 0;
    /** 调用方提供的幂等键 → run_id（与 runs 同步淘汰）。 */
    this.clientRuns = new Map();
    /** 忙时入队的待执行任务（仅内存；重启丢失）。 */
    this.queue = [];
    this.draining = false;
    /** 最近一次回合结果，仅内存（进程退出即消失），不落盘。 */
    this.lastResult = null;
  }

  #hub;

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

  /** 确保有一个可用的 DSH 进程；必要时新建并 resume 回该会话。 */
  async ensureAlive() {
    // ★ 上一代进程正在回收时必须先等它停完：否则会为同一会话再拉起一个进程，
    //   去抢一个**尚未释放**的写锁（reaper/release 里 await stop() 的那个窗口）。
    if (this.recycling) await this.recycling;
    if (this.proc?.alive) return this.proc;
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
        break;
      }
      case 'usage_update':
        c.usage = u;
        break;
      case 'plan':
      case 'plan_update':
        c.plan = u;
        break;
      default:
        c.otherUpdates.push(u.sessionUpdate);
    }
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

    // ★ read-only 是硬边界：即使会话被旧版本/显式参数配成 auto-allow，
    //   这里也绝不放行任何审批 —— DSH 会借审批把 sandbox 提权到可写。
    if (this.permission === 'read-only') {
      this.#hub.log.info(`[conv ${this.id}] read-only 强制拒绝审批: ${desc}`);
      return rejectId
        ? { outcome: { outcome: 'selected', optionId: rejectId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    if (this.onApproval === 'auto-allow') {
      this.#hub.log.info(`[conv ${this.id}] 审批放行: ${desc}`);
      // ★ 自动放行必须对调用方可见：DSH 会借审批把沙箱提升到 danger-full-access，
      //   不记下来的话 workspace-write 会话事后看起来像从未越界（实测一轮 6 次提权无人知晓）。
      if (allowId) this.#recordAutoApproval(params, toolCall, desc, options);
      return allowId
        ? { outcome: { outcome: 'selected', optionId: allowId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    if (this.onApproval === 'auto-deny') {
      this.#hub.log.info(`[conv ${this.id}] 审批拒绝: ${desc}`);
      return rejectId
        ? { outcome: { outcome: 'selected', optionId: rejectId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = `ap-${Math.random().toString(36).slice(2, 10)}`;
    this.#hub.log.info(`[conv ${this.id}] 审批待裁决: ${approvalId}`);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(approvalId)) {
          this.#hub.log.info(`[conv ${this.id}] 审批 ${approvalId} 超时，按拒绝处理`);
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
    const input = toolCall.rawInput ?? toolCall.input ?? null;
    const escalation =
      input && typeof input === 'object' && typeof input.sandbox_permissions === 'string'
        ? input.sandbox_permissions
        : null;
    if (escalation) c.autoEscalationTotal = (c.autoEscalationTotal ?? 0) + 1;
    if (!Array.isArray(c.autoApprovals)) c.autoApprovals = [];
    if (c.autoApprovals.length >= MAX_AUTO_APPROVALS_KEPT) return;
    const ctx = approvalContext(params, toolCall, desc, options);
    const cmd = input && typeof input === 'object' ? input.command ?? input.cmd ?? null : null;
    c.autoApprovals.push({
      tool: ctx.tool ?? desc,
      tool_call_id: ctx.tool_call_id ?? null,
      escalation,
      reason: typeof ctx.reason === 'string' ? ctx.reason.slice(0, 300) : null,
      command_preview:
        typeof cmd === 'string' ? sanitizeApprovalContext(cmd, 'command').slice(0, MAX_AUTO_APPROVAL_PREVIEW) : null,
      at: new Date().toISOString(),
    });
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
  #settleFailedRun(runRecord, error) {
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
    runRecord.status = 'error';
    runRecord.error = error?.message ?? String(error);
    runRecord.elapsed_ms = 0;
    runRecord.result = {
      conversation_id: this.id,
      run_id: runRecord.run_id,
      stop_reason: 'error',
      error: runRecord.error,
      answer: '',
      thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
      tools_used: [],
      workspace_changed: false,
      elapsed_ms: 0,
    };
    const reviewMode = runRecord.review_mode ?? this.review;
    if (reviewMode !== 'off') {
      runRecord.result.review = buildReviewTicket({
        conversationId: this.id,
        runId: runRecord.run_id,
        promptPreview: runRecord.prompt_preview,
        result: runRecord.result,
        mode: reviewMode,
        permission: this.permission,
      });
    }
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
  async prompt(text, { reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, run, wait = true, review } = {}) {
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
    const beforePromise = gitStatus(this.cwd);
    try {
      // 快照与拉起进程并行：快照只是读盘，不改变生命周期，早取晚取语义一致。
      const [beforeSnap, liveProc] = await Promise.all([beforePromise, this.ensureAlive()]);
      before = beforeSnap;
      proc = liveProc;
    } catch (e) {
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
    this.currentTurn += 1;
    this.turnStartedAt = now();
    this.turnOutChars = 0;
    this.currentTool = null;
    this.pushOut('user', text.length > MAX_PROMPT_ECHO ? `${text.slice(0, MAX_PROMPT_ECHO)}…（已截断）` : text);
    this.pushOut('turn', `第 ${this.currentTurn} 轮开始`, { phase: 'start' });
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

    /**
     * 把"调用方审核单"挂到回合结果上。
     *
     * 审核单必须随结果一起返回（正文、structuredContent、哨兵都是同一份 result），
     * 否则调用方在异步收活时只会看到一段自述，很容易直接把它当成完成事实。
     */
    const attachReview = (result) => {
      if (reviewMode !== 'off') {
        result.review = buildReviewTicket({
          conversationId: this.id,
          runId: runRecord.run_id,
          promptPreview: runRecord.prompt_preview,
          result,
          mode: reviewMode,
          permission: this.permission,
        });
      }
      return result;
    };

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
          for (const [, p] of this.pendingApprovals) {
            try {
              p.resolve({ outcome: { outcome: 'cancelled' } });
            } catch {}
          }
          this.pendingApprovals.clear();
          this.pushOut('turn', `第 ${this.currentTurn} 轮结束（${stopReason ?? 'unknown'}）`, {
            phase: 'end',
            stop_reason: stopReason,
            error: failure ?? undefined,
          });
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
          attachReview(result);
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
          const fallback = {
            conversation_id: this.id,
            run_id: runRecord.run_id,
            stop_reason: 'error',
            error: `回合收尾异常: ${e.message}`,
            answer: c.answer ?? '',
            thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
            tools_used: [...(c.tools?.values?.() ?? [])],
            workspace_changed: false,
            elapsed_ms: now() - t0,
          };
          attachReview(fallback);
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
          runRecord.result = {
            conversation_id: this.id,
            run_id: runRecord.run_id,
            stop_reason: 'error',
            error: `回合收尾异常: ${e.message}`,
            answer: c.answer ?? '',
            thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
            tools_used: [],
            workspace_changed: false,
            elapsed_ms: now() - t0,
          };
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
    if (!this.proc?.alive) return { interrupted: false, reason: 'DSH 进程未运行' };
    this.proc.notify('session/cancel', { sessionId: this.id });
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

  /** 追加一条输出记录；同类相邻文本会合并，避免每个 token 一条。 */
  pushOut(kind, text, extra = {}) {
    const last = this.out[this.out.length - 1];
    const cap = (s) => (s.length > MAX_OUT_TEXT ? `…[已截断，保留尾部 ${MAX_OUT_TEXT} 字]…\n${s.slice(-MAX_OUT_TEXT)}` : s);
    // 工具更新是**快照**（`read [completed]`），不是增量：同一个 tool_call_id 原地替换，
    // 不同的工具调用各占一条。旧实现按 kind 拼接，三个工具会挤成
    // `read [in_progress]read [completed]pwsh …` 一条，且只剩第一个工具的 id。
    if (kind === 'tool' && extra.tool_call_id) {
      const same = this.#findToolEntry(extra.tool_call_id);
      if (same) {
        same.text = cap(text ?? '');
        same.at = now();
        same.rev = ++this.outRev;
        return;
      }
    }
    // 只有正文是流式增量，才需要合并；user/turn/tool 都是独立事件，合并会把
    // “第 N 轮开始”与“第 N 轮结束”拼成一条（空回合时）。
    if (kind === 'text' && last && last.kind === kind && last.turn === this.currentTurn && text) {
      last.text = cap(last.text + text);
      last.at = now();
      // ★ 合并进已有条目也必须推进修订号。否则游标已经读过这条的调用方
      //   会永远看不到后续追加的正文（旧实现用 seq 当游标，seq 不变 = 漏读）。
      last.rev = ++this.outRev;
    } else {
      this.out.push({ seq: ++this.outSeq, rev: ++this.outRev, kind, turn: this.currentTurn, text: cap(text ?? ''), at: now(), ...extra });
      if (this.out.length > MAX_OUT_ENTRIES) this.out.shift();
    }
    if (kind === 'text') this.turnOutChars += text?.length ?? 0;
  }

  /** 本轮里同一 tool_call_id 的工具条目（从尾部往回找，跨轮不复用）。 */
  #findToolEntry(toolCallId) {
    for (let i = this.out.length - 1; i >= 0; i--) {
      const e = this.out[i];
      if (e.turn !== this.currentTurn) return null;
      if (e.kind === 'tool' && e.tool_call_id === toolCallId) return e;
    }
    return null;
  }

  /** 读输出：**按修订号**的游标式增量。条目被追加时会再次返回（按 seq 替换全文）。 */
  readOut({ cursor = 0, includeReasoning = false, limit = 200 } = {}) {
    const cur = Number.isFinite(cursor) ? cursor : 0;
    // limit 必须清洗：负数会被 slice 解释成“从头到尾少一条”，0 会让调用方原地空转。
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), MAX_OUT_ENTRIES)) : 200;
    const revOf = (e) => (typeof e.rev === 'number' ? e.rev : e.seq);
    const entries = this.out.filter((e) => revOf(e) > cur).slice(0, n);
    const next = entries.length ? revOf(entries[entries.length - 1]) : cur;
    const res = {
      conversation_id: this.id,
      state: this.state(),
      busy: this.busy,
      current_tool: this.currentTool,
      entries,
      cursor: next,
      has_more: this.out.some((e) => revOf(e) > next),
      /** 缓冲被环形覆盖时会为 true，表示你错过了中间一段。 */
      gap: entries.length > 0 && this.out.length > 0 && revOf(this.out[0]) > cur + 1,
    };
    // 思考内容只在显式要求时、且只针对"当前正在跑的回合"返回；不保留、不进缓冲
    if (includeReasoning && this.collector?.reasoning) {
      res.live_thinking = this.collector.reasoning;
    }
    return res;
  }

  /** 建一条回合记录。派活时先建，好让调用方立刻拿到 run_id（异步模式的关键）。 */
  createRun(text, { clientRunId = null, review = this.review } = {}) {
    const run = {
      run_id: `run-${Date.now().toString(36)}-${++this.runSeq}`,
      conversation_id: this.id,
      client_run_id: clientRunId ?? null,
      prompt_preview: text.length > MAX_RUN_PREVIEW ? `${text.slice(0, MAX_RUN_PREVIEW)}…` : text,
      status: 'queued',
      /** 本回合的审核策略（off / advisory）；由 dsh_send / dsh_interject 或会话默认决定。 */
      review_mode: normalizeReviewMode(review, this.review),
      started_at: null,
      ended_at: null,
      elapsed_ms: null,
      result: null,
    };
    this.runs.push(run);
    if (clientRunId) this.clientRuns.set(clientRunId, run.run_id);
    if (this.runs.length > MAX_RUNS) {
      const evicted = this.runs.shift();
      // 幂等键必须跟着 run 记录一起淘汰，否则会指向一个已经查不到的 run。
      for (const [k, v] of this.clientRuns) {
        if (v === evicted.run_id) this.clientRuns.delete(k);
      }
    }
    // 防御性清残留：正常情况下该 run_id 从未用过，但确保等待方不会被历史哨兵误触发。
    this.#hub.clearRunSentinel(this.id, run.run_id);
    return run;
  }

  /** 按调用方幂等键取 run（不存在/已淘汰返回 null）。 */
  getRunByClientId(clientRunId) {
    if (!clientRunId) return null;
    const runId = this.clientRuns.get(clientRunId);
    if (!runId) return null;
    return this.runs.find((r) => r.run_id === runId) ?? null;
  }

  // ── 会话级队列（忙时非阻塞入队）────────────────────────────────

  /** 入队；返回 run 记录与 1-based 位置。队列只在内存，重启丢失。 */
  enqueue(text, { reasoning = 'hide', clientRunId = null, preview = null, review = this.review } = {}) {
    const MAX_QUEUE = 8;
    if (clientRunId) {
      const existing = this.getRunByClientId(clientRunId);
      if (existing) return { run: existing, position: 0, deduped: true };
    }
    if (this.queue.length >= MAX_QUEUE) {
      throw new Error(`队列已满（最多 ${MAX_QUEUE} 条）；先用 dsh_queue list 清理，或等当前回合结束`);
    }
    // 预览用调用方原文，执行用可能已注入团队前缀的 text。
    const run = this.createRun(preview ?? text, { clientRunId, review });
    run.status = 'queued';
    this.queue.push({ run, text, reasoning, clientRunId, enqueued_at: now() });
    return { run, position: this.queue.length, deduped: false };
  }

  queueList() {
    // 防御：snapshot 可能被测试用 prototype 替身调用（没有构造器初始化 queue）。
    return (this.queue ?? []).map((item, i) => ({
      position: i + 1,
      run_id: item.run.run_id,
      preview: item.run.prompt_preview,
      enqueued_at: item.enqueued_at,
      client_run_id: item.clientRunId ?? null,
    }));
  }

  queueRemove(runId, { cancel = true } = {}) {
    const i = this.queue.findIndex((x) => x.run.run_id === runId);
    if (i < 0) throw new Error(`队列里没有 ${runId}`);
    const [item] = this.queue.splice(i, 1);
    if (cancel) {
      const run = item.run;
      run.status = 'cancelled';
      run.ended_at = now();
      run.elapsed_ms = 0;
      run.result = {
        conversation_id: this.id,
        run_id: run.run_id,
        stop_reason: 'cancelled',
        error: 'queued run cancelled before it started',
        answer: '',
        thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
        tools_used: [],
        workspace_changed: false,
        elapsed_ms: 0,
      };
      if (run.review_mode !== 'off') {
        run.result.review = buildReviewTicket({
          conversationId: this.id,
          runId: run.run_id,
          promptPreview: run.prompt_preview,
          result: run.result,
          mode: run.review_mode,
          permission: this.permission,
        });
      }
      // 取消也是终态 → 写哨兵，避免等待方永远空等。
      const file = this.#hub.writeRunSentinel(this.id, run);
      run.result.sentinel_file = file ?? this.#hub.runSentinelPath(this.id, run.run_id);
    }
    return { removed: true, run_id: runId };
  }

  queueUpdate(runId, text) {
    const item = this.queue.find((x) => x.run.run_id === runId);
    if (!item) throw new Error(`队列里没有 ${runId}`);
    item.text = text;
    item.run.prompt_preview =
      text.length > MAX_RUN_PREVIEW ? `${text.slice(0, MAX_RUN_PREVIEW)}…` : text;
    return { updated: true, run_id: runId };
  }

  queuePromote(runId) {
    const i = this.queue.findIndex((x) => x.run.run_id === runId);
    if (i < 0) throw new Error(`队列里没有 ${runId}`);
    const [item] = this.queue.splice(i, 1);
    this.queue.unshift(item);
    return { promoted: true, run_id: runId, position: 1 };
  }

  /** 空闲时取队首执行。失败也要继续下一条（否则一条坏任务卡死整条队列）。 */
  #scheduleDrain() {
    if (this.busy || this.draining || this.queue.length === 0) return;
    this.draining = true;
    const timer = setTimeout(() => {
      this.draining = false;
      if (this.busy || this.queue.length === 0) return;
      const item = this.queue.shift();
      const run = item.run;
      run.status = 'running';
      this.prompt(item.text, { reasoning: item.reasoning, run, wait: false })
        .catch(() => {})
        .finally(() => this.#scheduleDrain());
    }, 0);
    timer.unref?.();
  }

  /** 取回合记录；不传 run_id 就是最近一条。 */
  getRun(runId) {
    if (runId) {
      const r = this.runs.find((x) => x.run_id === runId);
      if (!r) {
        throw new Error(`未知 run_id: ${runId}（回合记录只在内存、只留最近 ${MAX_RUNS} 条；也可用 dsh_read 读输出缓冲）`);
      }
      return r;
    }
    return this.runs.length ? this.runs[this.runs.length - 1] : null;
  }

  /**
   * 异步收据里的"待审核"审核单：回合还没结束，只有清单和 run_id，
   * 告诉调用方"拿到哨兵结果后先审核，再当完成"。
   */
  pendingReviewTicket(runId) {
    const run = this.runs.find((x) => x.run_id === runId) ?? null;
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

    const run = this.runs.find((x) => x.run_id === runId) ?? null;
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
      const r = await this.prompt(message, { reasoning, timeoutMs, run });
      return { ...r, interjected: 'idle', waited_ms: 0 };
    }
    const t0 = now();
    if (mode === 'interject') {
      this.proc?.notify('session/cancel', { sessionId: this.id });
    }
    // 排队等待的时长跟随调用方的 timeoutMs（0 = 一直等），不再固定 30 分钟。
    const idle = await this.waitIdle(timeoutMs);
    const waited = now() - t0;
    if (!idle) {
      const err = new Error('等待当前回合结束超时，插话未发送');
      err.runId = run.run_id;
      run.status = 'cancelled';
      run.ended_at = now();
      run.elapsed_ms = 0;
      run.result = {
        conversation_id: this.id,
        run_id: run.run_id,
        stop_reason: 'cancelled',
        error: err.message,
        answer: '',
        thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
        tools_used: [],
        workspace_changed: false,
        elapsed_ms: 0,
      };
      // 取消同样是一次终态结果：审核单照挂，调用方仍可记录"这次没跑成"。
      if (run.review_mode !== 'off') {
        run.result.review = buildReviewTicket({
          conversationId: this.id,
          runId: run.run_id,
          promptPreview: run.prompt_preview,
          result: run.result,
          mode: run.review_mode,
          permission: this.permission,
        });
      }
      const file = this.#hub.writeRunSentinel?.(this.id, run);
      run.result.sentinel_file = file ?? this.#hub.runSentinelPath?.(this.id, run.run_id) ?? null;
      throw err;
    }
    const r = await this.prompt(message, { reasoning, timeoutMs, run });
    return { ...r, interjected: mode, waited_ms: waited };
  }

  /** 关闭会话（进程收尾；会话本体留在磁盘上，可再次 resume）。 */
  async close({ forget = false } = {}) {
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
    for (const [, p] of this.pendingApprovals) {
      try {
        p.resolve({ outcome: { outcome: 'cancelled' } });
      } catch {}
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
      writeTombstone(this.id);
      this.#hub.remove(this.id);
    } else this.#hub.save();
    return { closed: stopped, forgotten: forget, ...(stopped ? {} : { error: '进程未能确认退出，登记已保留' }) };
  }
}

/**
 * 两次 workspace 快照是否表示同一组工作区变更。
 *
 * 优先比较 `fingerprint`（覆盖**全量**条目：状态行 + 每个路径的 size/mtime，
 * 未跟踪目录递归展开）。只比较前 40 条 entries 会把"同一状态行但内容变了"
 * 和第 41 条之后的改动都漏掉（workspace_changed 假阴性）。
 */
export function sameWorkspaceSnapshot(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (typeof a.fingerprint === 'string' && typeof b.fingerprint === 'string') {
    return a.fingerprint === b.fingerprint;
  }
  // 兼容旧快照/测试里手写的 { changed_files, entries }。
  return JSON.stringify(a.entries ?? []) === JSON.stringify(b.entries ?? []);
}

const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_DIR_ENTRIES = 2000;
const execFileAsync = promisify(execFile);

/**
 * 安全 git 参数（放 subcommand 之前）。
 *
 * `--no-optional-locks` 是 **git 全局选项**，放在 `status` 之后会被 git 当成
 * 未知参数直接退出 129 —— 那样快照永远是 null，workspace_changed 恒为 false。
 */
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
}

/** 异步跑一次 git 并取 stdout；非 git 目录/超时/输出过大都抛给调用方。 */
async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: gitEnv(),
  });
  return stdout;
}

/** 解析 porcelain v1 -z 状态行；rename/copy 的“原路径”是下一个 NUL 段。 */
function parsePorcelainZ(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    // 形如 "XY path"；posix 允许路径里有空格，所以只切前三个字符。
    if (token.length < 4 || token[2] !== ' ') continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    let orig = null;
    if (/[RC]/.test(status)) orig = tokens[++i] || null;
    rows.push({ status, path, orig });
  }
  return rows;
}

/**
 * 把一个路径的当前状态（类型 + size + mtimeMs）混进指纹。
 *
 * - 普通文件：size + mtimeMs 足以识别"状态行没变、内容变了"；
 * - 未跟踪目录（`?? dir/`）：目录 mtime 只在直接子项增删时变，光看它不够，
 *   所以递归展开（只用 lstat，不跟随符号链接/不钻 .git，且有预算上限）；
 * - 已跟踪的目录条目（子模块）：只看它自己的 lstat，避免把子模块整个走一遍。
 */
function hashPathStat(hash, full, label, budget) {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    hash.update(`${label}\0missing\0`);
    return;
  }
  if (st.isDirectory() && budget) {
    hash.update(`${label}\0dir\0${st.mtimeMs}\0`);
    let entries;
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch {
      hash.update('unreadable\0');
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      if (budget.left <= 0) {
        hash.update(`${label}\0truncated\0`);
        return;
      }
      budget.left -= 1;
      hashPathStat(hash, join(full, ent.name), `${label}/${ent.name}`, budget);
    }
    return;
  }
  const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  hash.update(`${label}\0${kind}\0${st.size}\0${st.mtimeMs}\0`);
}

/**
 * 收集当前工作区的 git 变更摘要（非 git 目录返回 null）。
 *
 * 异步实现：`execFile` 不占用事件循环 —— 一个 MCP 服务进程承载多个会话，
 * 同步 `spawnSync` 最长 8s 会把所有会话的 ACP 消息/审批一起卡住。
 *
 * 返回对象向后兼容：`changed_files` = 全量状态条目数，`entries` = 前 40 条
 * 展示用状态行；新增 `fingerprint` 覆盖**全量**条目（含逐路径 size/mtime），
 * 供 `sameWorkspaceSnapshot` 判断"内容是否真的变了"。
 */
export async function gitStatus(cwd) {
  if (process.env.DSH_MCP_GIT_STATUS === '0') return null;
  try {
    // ★ 在不可信仓库里 `git status` 可能触发仓库配置的 fsmonitor/filter；这些
    //   命令发生在 DSH 沙箱与审批层之外。禁用可选锁与 fsmonitor，并允许用
    //   DSH_MCP_GIT_STATUS=0 完全关掉。
    // porcelain 的路径相对 **仓库根**（cwd 是子目录时也是），所以同时取 top-level。
    const [statusOut, rootOut] = await Promise.all([
      gitOutput(cwd, [...GIT_SAFE, 'status', '--porcelain', '-z']),
      gitOutput(cwd, [...GIT_SAFE, 'rev-parse', '--show-toplevel']),
    ]);
    const rows = parsePorcelainZ(statusOut);
    if (!rows.length) return null;
    // git 输出的是 `C:/...` 风格，统一成原生分隔符，后面 startsWith 才不会误判越界。
    const root = resolve(String(rootOut ?? '').trim() || cwd);

    // 状态行按路径排序后参与指纹，避免依赖 git 的输出顺序。
    const sorted = rows
      .slice()
      .sort((a, b) =>
        a.path === b.path
          ? a.status < b.status
            ? -1
            : a.status > b.status
              ? 1
              : 0
          : a.path < b.path
            ? -1
            : 1,
      );

    const hash = createHash('sha256');
    const budget = { left: MAX_UNTRACKED_DIR_ENTRIES };
    const entries = [];
    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    for (const row of sorted) {
      const display = row.orig ? `${row.status} ${row.orig} -> ${row.path}` : `${row.status} ${row.path}`;
      if (entries.length < 40) entries.push(display);
      hash.update(display);
      hash.update('\0');

      const cleanPath = row.path.endsWith('/') ? row.path.slice(0, -1) : row.path;
      const full = resolve(root, cleanPath);
      if (full !== root && !full.startsWith(rootPrefix)) {
        hash.update('outside-worktree\0');
        continue;
      }
      // 只有未跟踪目录需要递归；已跟踪条目（含子模块）看 lstat 即可。
      hashPathStat(hash, full, cleanPath, row.status === '??' ? budget : null);
    }

    return {
      changed_files: rows.length,
      entries,
      fingerprint: hash.digest('hex'),
    };
  } catch {
    return null;
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

// ── 注册表 ────────────────────────────────────────────────────────

/**
 * 工作区能不能用在家目录本身？
 *
 * DSH 自己的 ACL 沙箱要求临时目录在工作区**之外**。Windows 上 %TEMP% 是
 * C:/Users/<name>/AppData/Local/Temp，正好在用户家目录里面，所以把家目录
 * 当作工作区时，沙箱初始化会失败：
 *   Windows ACL: temp root must be outside the workspace
 * 症状出现在第一次起 shell 的时候，看起来像这个服务坏了，其实只是 cwd
 * 选得太大。read-only 档不写盘、也不起 ACL 沙箱，所以不受影响。
 *
 * @returns {string|null} null 表示没问题，否则返回一段可直接抛出的说明。
 */
/**
 * 当前文件系统是否大小写不敏感（缓存一次）。
 *
 * 不能按平台猜：GitHub 的 `macos-latest` 是**大小写敏感的 APFS**，而普通 macOS
 * 默认又不敏感；Windows 一定不敏感；Linux 一定敏感。用临时文件探针最稳。
 */
let caseInsensitiveCache = null;
export function fsCaseInsensitive() {
  if (caseInsensitiveCache !== null) return caseInsensitiveCache;
  if (process.platform === 'win32') {
    caseInsensitiveCache = true;
    return true;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-any-agent-case-'));
    writeFileSync(join(dir, 'probe'), '');
    caseInsensitiveCache = existsSync(join(dir, 'PROBE'));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    caseInsensitiveCache = false;
  }
  return caseInsensitiveCache;
}

export function homeWorkspaceProblem(cwd, permission) {
  if (permission === 'read-only') return null;
  const home = homedir();
  if (!home) return null;
  const caseInsensitive = process.platform === 'win32' || fsCaseInsensitive();
  const norm = (p) => {
    // 解析 symlink：一个指向家目录/根目录的软链不能绕过这两个边界。
    // 路径不存在时（测试里的 "some-project"）回落到 resolve。
    let r;
    try {
      r = realpathSync(p);
    } catch {
      r = resolve(p);
    }
    return caseInsensitive ? r.toLowerCase() : r;
  };
  // 根目录 = 整个磁盘。workspace-write 的沙箱根会跟着 cwd 走，
  // 于是“只写工作区”退化成“可写全盘”，必须显式要求 danger-full-access。
  const fsRoot = resolve(parse(cwd).root);
  if (norm(cwd) === norm(fsRoot)) {
    return [
      'cwd 不能是文件系统根目录: ' + cwd,
      '  workspace-write 的沙箱根会变成整个磁盘，等于绕过“只写工作区”的权限档。',
      '  请传一个具体的项目目录；确实要全盘访问请显式用 permission=danger-full-access。',
    ].join('\n');
  }
  if (norm(cwd) !== norm(home)) return null;

  const temp = tmpdir();
  const tempInside = norm(temp) === norm(home) || norm(temp).startsWith(norm(home) + sep);
  const lines = ['cwd 不能是用户家目录本身: ' + cwd];
  if (tempInside) lines.push('  临时目录 ' + temp + ' 就在它里面，');
  lines.push(
    '  DSH 的 ACL 沙箱要求临时目录在工作区之外，否则第一次起 shell 就会报:',
    '    Windows ACL: temp root must be outside the workspace',
    '',
    '  换个具体项目目录最省事，或者改权限档：',
    '    permission=read-only           不写盘，不需要该沙箱',
    '    permission=danger-full-access  不受该沙箱约束',
  );
  return lines.join('\n');
}

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
  /** 同一 id 的磁盘接管 in-flight Promise，防止并发请求各自构造一个 Conversation。 */
  #adopting = new Map();
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
      const doc = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations: [...this.conversations.values()].map((c) => c.toState()),
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
      const payload = {
        conversation_id: conversationId,
        run_id: run.run_id,
        client_run_id: run.client_run_id ?? null,
        status: run.status ?? 'unknown',
        ended_at: run.ended_at ?? Date.now(),
        error: sanitizeApprovalContext(run.error ?? run.result?.error ?? null, 'error'),
        result: sanitizeResultForSentinel(run.result ?? null),
      };
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, file);
      return file;
    } catch (e) {
      const msg = `写完成哨兵失败（${file}）: ${e.message}`;
      run.sentinel_error = msg;
      this.log.info(`[hub] ${msg}`);
      return null;
    }
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
      throw new Error(
        `会话已被 forget（永久移除）: ${id}\n` +
          `  它不会再被按 id 自动恢复。确实要恢复的话，删除墓碑文件 ${forgottenPath(id)} 后重试。`,
      );
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
        throw new Error(`无法读取会话 ${id} 的会话头：${found.reason}`);
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
      throw new Error(
        `未知会话: ${id}（用 dsh_list 查看可用会话；也可能是 id 写错了）`,
      );
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
  async create({ cwd, permission = DEFAULT_PERMISSION, onApproval, titleHint, reasoningEffort, provider, model, keepAlive = false, review } = {}) {
    if (!cwd) {
      throw new Error(
        '没有可用的工作目录。你既没传 cwd，客户端也没有提供当前打开的项目（MCP roots）。\n' +
          '  传一个项目目录即可，例如 cwd: "D:/code/my-project"。\n' +
          '  不要传用户家目录本身 —— 那会让 DSH 的 ACL 沙箱起不来。',
      );
    }
    if (!isAbsolute(cwd)) throw new Error(`cwd 必须是绝对路径: ${cwd}`);
    if (!existsSync(cwd)) {
      throw new Error(`工作区不存在或不是目录: ${cwd}（请先创建这个目录）`);
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`工作区不存在或不是目录: ${cwd}（这是一个文件路径，请传目录）`);
    }
    if (!PERMISSION_TIERS.includes(permission)) {
      throw new Error(`permission 必须是 ${PERMISSION_TIERS.join(' | ')} 之一`);
    }
    // title_hint 会写进注册表与侧车，每一轮 save() 都会重复落盘；不设上限就是一个
    // 稳定的磁盘/内存放大点（调用方可以传任意长度）。可读标签 200 字足够。
    if (titleHint !== undefined && titleHint !== null) {
      if (typeof titleHint !== 'string') throw new Error('title_hint 必须是字符串');
      if (titleHint.length > 200) throw new Error('title_hint 最长 200 字符');
    }
    // ★ 0.5.0：danger-full-access 不再默认可用。它把整机写权限交给调用方，
    //   而本服务可能被任何 MCP 客户端拉起；必须由机器所有者显式放行。
    if (permission === 'danger-full-access' && !ALLOW_FULL_ACCESS) {
      throw new Error(
        'permission=danger-full-access 需要机器侧显式允许：设置 DSH_MCP_ALLOW_FULL_ACCESS=1 后重试。' +
          ' 默认请用 workspace-write（写入限制在工作区内）或 read-only。',
      );
    }
    const policy = onApproval ?? defaultApprovalPolicy(permission);
    if (!APPROVAL_POLICIES.includes(policy)) {
      throw new Error(`on_approval 必须是 ${APPROVAL_POLICIES.join(' | ')} 之一`);
    }
    // ★ read-only 是硬边界：显式 auto-allow/ask 会放行 DSH 的 sandbox 提权，
    //   实测能把文件写进工作区而会话记录仍显示 read-only。直接拒绝这个组合。
    if (permission === 'read-only' && policy !== 'auto-deny') {
      throw new Error(
        'permission=read-only 强制要求 on_approval=auto-deny（或不传）。' +
          ' auto-allow/ask 会放行 DSH 的 sandbox 提权，使只读档失效。',
      );
    }
    const effort = reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoning_effort 必须是 ${REASONING_EFFORTS.join(' | ')} 之一`);
    }
    const reviewMode = normalizeReviewMode(review ?? DEFAULT_REVIEW);
    if (!REVIEW_MODES.includes(reviewMode)) {
      throw new Error(`review 必须是 ${REVIEW_MODES.join(' | ')} 之一`);
    }
    if (model && !provider) {
      throw new Error('指定 model 时必须同时给 provider（ACP 的模型标识是 [provider, model] 二元组）');
    }
    // 家目录当选工作区 → DSH 的 ACL 沙箱起不来，第一次起 shell 才暴露。
    // 与其让用户以为服务坏了，不如在这里把原因和出路一起说清楚。
    const homeProblem = homeWorkspaceProblem(cwd, permission);
    if (homeProblem) throw new Error(homeProblem);
    const shared = SHARED_PROCESS;
    const proc = shared
      ? this.acquireHost(cwd, permission)
      : new AcpProcess({
          cwd,
          permission,
          log: this.log,
          onNotification: () => {},
          onPermissionRequest: () => ({ outcome: { outcome: 'cancelled' } }),
        });
    if (!shared) proc.start();
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
        throw new Error(
          `指定的 provider/model 无效，会话未创建：${modelFailure}\n` +
            `  请检查 ${provider}/${model} 是否在 profile 中声明；不传这两个参数可使用 profile 默认模型。`,
        );
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
   *   理由（实测，见 USAGE-NOTES §3.10~3.12）：空闲回收是写锁**唯一**会变空的时刻，
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
    this.#reaper = setInterval(async () => {
      // ★ 整个回收周期必须自带防护：这里抛出的异常会变成 unhandled rejection，
      //   在 Node ≥15 上直接**杀掉进程** —— 而那会连带丢掉所有会话的活进程。
      try {
        const cutoff = now() - IDLE_TTL_MS;
        // 哪些会话可以回收：进程活着、不在跑回合
        const reapable = [];
        for (const c of this.conversations.values()) {
          if (!c.proc?.alive) continue;
          // ★ 先续心跳，**包括正在跑回合的**：否则长回合（>90 秒）期间心跳不刷新，
          //   别的实例会把我们判成失联并抢占，直接把这一轮杀掉。
          lockHeartbeat(c.id);
          if (c.busy) continue;
          reapable.push(c);
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
        if (MAX_RSS_MB > 0) {
          // 按实际 RSS 而不是会话数：上下文大小差异很大，按个数限制经常低估。
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
          if (total > MAX_RSS_MB) {
            // 先收非 keep_alive 的最久未用者；仍然超预算才动 keep_alive。
            const pool = reapable
              .filter((c) => !victims.has(c))
              .sort((a, b) =>
                a.keepAlive === b.keepAlive ? a.lastUsedAt - b.lastUsedAt : a.keepAlive ? 1 : -1,
              );
            for (const c of pool) {
              victims.add(c);
              total -= rss.get(c) ?? 0;
              if (total <= MAX_RSS_MB) break;
            }
          }
        }

        for (const c of victims) {
          if (c.recycling) await c.recycling;
          if (!c.proc?.alive) continue;
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
    }, REAP_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  /**
   * 释放**所有**活着的会话进程（腾内存用，无损：会话日志都在磁盘上，之后照样 resume）。
   *
   * 场景：默认"永不回收"下每个用过的会话会常驻一个 DSH 进程（实测约 300-480MB ✗）。
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

  async shutdown() {
    if (this.#reaper) clearInterval(this.#reaper);
    this.#reaper = null;
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
    this.save();
  }
}
