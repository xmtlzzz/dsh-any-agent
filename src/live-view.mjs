/**
 * live 事件流的读取与归并：`dsh-any-agent watch` 与 `dashboard` 共用。
 *
 * 只读 `<LIVE_DIR>/<会话>/events.jsonl`（以及注册表 / DSH 投影缓存里的标题），
 * 从不写任何东西、从不碰写锁。把事件归并成一棵"调用链"：
 *
 *   客户端（谁派的） → 会话 → 回合（send / queue / interject） → 工具调用 / 审批
 *
 * 读取是按字节偏移的增量 tail：只消费到最后一个换行，末尾写到一半的行留到下一次。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_FILE } from './live.mjs';

/** 每个会话保留的回合数、每个回合保留的工具 / 审批数（只影响查看器内存）。 */
const MAX_RUNS_PER_CONV = 30;
const MAX_ITEMS_PER_RUN = 300;
/** 标题读 DSH 投影缓存，别每次轮询都读。 */
const TITLE_TTL_MS = 10_000;
const NEWLINE = 0x0a;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

export function writerPid(w) {
  const n = Number.parseInt(String(w ?? '').split(':')[0], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 从 buffer 里切出完整的行；返回 {lines, rest}。rest 是末尾没有换行的半行（原样留着）。
 * 按字节找换行，不会把多字节 UTF-8 字符切坏。
 */
export function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) {
      if (i > start) lines.push(buf.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  return { lines, rest: buf.subarray(start) };
}

/** 解析一行；坏行 / 未知结构返回 null（查看器绝不因为一行坏数据崩掉）。 */
export function parseEvent(line) {
  try {
    const ev = JSON.parse(line);
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || typeof ev.conv !== 'string') return null;
    return ev;
  } catch {
    return null;
  }
}

function newConv(id) {
  return {
    id,
    cwd: null,
    title: null,
    title_hint: null,
    client: null,
    permission: null,
    on_approval: null,
    model: null,
    writer: null,
    opened_at: null,
    last_ts: null,
    closed: false,
    /** DSH 会话累计 token（含不在 live 里的更早回合）。 */
    session_tokens: null,
    context: null,
    runs: [],
  };
}

function newRun(id) {
  return {
    run: id,
    turn: null,
    via: null,
    client: null,
    status: 'running',
    queued_at: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    prompt_preview: null,
    stop_reason: null,
    error: null,
    tool_count: null,
    auto_approvals: null,
    auto_escalations: null,
    writer: null,
    /** 本回合 token 增量 {input, output, cache_read, cache_write}（来自 usage 事件）。 */
    tokens: null,
    /** 上下文窗口占用 {used, window}。 */
    context: null,
    items: [],
  };
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write'];

/** 规整一组 token 计数；不是对象时返回 null。 */
function cleanTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of TOKEN_KEYS) out[k] = Number.isFinite(t[k]) && t[k] > 0 ? t[k] : 0;
  return out;
}

/** 输入总量（未命中缓存 + 缓存读 + 缓存写）。 */
export function tokenInputTotal(t) {
  return t ? t.input + t.cache_read + t.cache_write : 0;
}

/** 缓存命中率（缓存读 / 输入总量），没有输入时为 null。 */
export function cacheHitRate(t) {
  const all = tokenInputTotal(t);
  return all > 0 ? t.cache_read / all : null;
}

/** 1234 → 1.2k，1500000 → 1.5M。 */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

/**
 * 事件归并器。纯内存、与文件无关，方便单测。
 * `apply(ev)` 吃一条事件；`view()` 给出可序列化的调用链快照。
 */
export class LiveState {
  constructor() {
    /** @type {Map<string, ReturnType<typeof newConv>>} */
    this.convs = new Map();
  }

  #conv(id) {
    let c = this.convs.get(id);
    if (!c) {
      c = newConv(id);
      this.convs.set(id, c);
    }
    return c;
  }

  #run(conv, runId, { create = true } = {}) {
    if (!runId) return null;
    let r = conv.runs.find((x) => x.run === runId);
    if (!r && create) {
      r = newRun(runId);
      conv.runs.push(r);
      if (conv.runs.length > MAX_RUNS_PER_CONV) conv.runs.shift();
    }
    return r;
  }

  #push(run, item) {
    run.items.push(item);
    if (run.items.length > MAX_ITEMS_PER_RUN) run.items.shift();
  }

  apply(ev) {
    const c = this.#conv(ev.conv);
    c.last_ts = ev.ts ?? c.last_ts;
    if (ev.w) c.writer = ev.w;
    if (ev.client) c.client = ev.client;
    if (ev.cwd) c.cwd = ev.cwd;
    switch (ev.type) {
      case 'conv.open':
        c.opened_at = ev.ts;
        c.permission = ev.permission ?? c.permission;
        c.on_approval = ev.on_approval ?? c.on_approval;
        c.model = ev.model ?? c.model;
        if (ev.title_hint) c.title_hint = ev.title_hint;
        c.closed = false;
        break;
      case 'conv.close':
        c.closed = true;
        break;
      case 'run.queued': {
        const r = this.#run(c, ev.run);
        r.status = 'queued';
        r.queued_at = ev.ts;
        r.via = 'queue';
        r.client = ev.client ?? r.client;
        if (ev.prompt_preview) r.prompt_preview = ev.prompt_preview;
        r.writer = ev.w ?? r.writer;
        break;
      }
      case 'run.start': {
        const r = this.#run(c, ev.run);
        r.status = 'running';
        r.started_at = ev.ts;
        r.turn = ev.turn ?? r.turn;
        r.via = ev.via ?? r.via;
        r.client = ev.client ?? r.client;
        r.writer = ev.w ?? r.writer;
        if (ev.prompt_preview) r.prompt_preview = ev.prompt_preview;
        c.permission = ev.permission ?? c.permission;
        c.on_approval = ev.on_approval ?? c.on_approval;
        c.closed = false;
        break;
      }
      case 'run.end': {
        const r = this.#run(c, ev.run);
        r.status = ev.status ?? 'done';
        r.ended_at = ev.ts;
        r.duration_ms = ev.duration_ms ?? r.duration_ms;
        r.stop_reason = ev.stop_reason ?? r.stop_reason;
        r.error = ev.error ?? r.error;
        r.tool_count = ev.tool_count ?? r.tool_count;
        r.auto_approvals = ev.auto_approvals ?? r.auto_approvals;
        r.auto_escalations = ev.auto_escalations ?? r.auto_escalations;
        // 回合结束时还没收尾的工具：标记成未完成，别一直显示"进行中"。
        for (const it of r.items) if (it.kind === 'tool' && !isTerminalTool(it.status)) it.status = 'unfinished';
        break;
      }
      case 'tool': {
        const r = this.#run(c, ev.run);
        if (!r) break;
        let it = r.items.find((x) => x.kind === 'tool' && x.id === ev.tool_call_id);
        if (!it) {
          it = { kind: 'tool', id: ev.tool_call_id, at: ev.ts, name: null, tool_kind: null, status: null, title: null, input_preview: null, elapsed_ms: null };
          this.#push(r, it);
        }
        it.name = ev.name ?? it.name;
        it.tool_kind = ev.kind ?? it.tool_kind;
        it.status = ev.status ?? it.status;
        it.title = ev.title ?? it.title;
        it.input_preview = ev.input_preview ?? it.input_preview;
        if (ev.elapsed_ms !== undefined) it.elapsed_ms = ev.elapsed_ms;
        it.last_at = ev.ts;
        break;
      }
      case 'approval': {
        const r = this.#run(c, ev.run);
        if (!r) break;
        this.#push(r, {
          kind: 'approval',
          at: ev.ts,
          approval_id: ev.approval_id ?? null,
          tool_call_id: ev.tool_call_id ?? null,
          tool: ev.tool ?? null,
          mode: ev.mode ?? null,
          escalation: ev.escalation ?? null,
          title: ev.title ?? null,
          command_preview: ev.command_preview ?? null,
          decided: null,
        });
        break;
      }
      case 'approval.decided': {
        if (!ev.approval_id) break;
        for (const r of c.runs) {
          const it = r.items.find((x) => x.kind === 'approval' && x.approval_id === ev.approval_id);
          if (it) {
            it.decided = { by: ev.by ?? null, decision: ev.decision ?? null, effective: ev.effective ?? null, at: ev.ts };
            break;
          }
        }
        break;
      }
      case 'usage': {
        const r = this.#run(c, ev.run);
        if (r) {
          const t = cleanTokens(ev.tokens);
          if (t) r.tokens = t;
          if (ev.context && Number.isFinite(ev.context.window)) r.context = { used: ev.context.used ?? 0, window: ev.context.window };
        }
        const s = cleanTokens(ev.session_tokens);
        if (s) c.session_tokens = s;
        if (ev.context && Number.isFinite(ev.context.window)) c.context = { used: ev.context.used ?? 0, window: ev.context.window };
        break;
      }
      case 'interject': {
        const r = this.#run(c, ev.run, { create: false });
        if (r) this.#push(r, { kind: 'interject', at: ev.ts, mode: ev.mode ?? null, text_preview: ev.text_preview ?? null, pending_run: ev.pending_run ?? null });
        break;
      }
      case 'interrupt': {
        const r = this.#run(c, ev.run, { create: false });
        if (r) this.#push(r, { kind: 'interrupt', at: ev.ts });
        break;
      }
      default:
        // 未知类型（更新的 schema）：只更新公共字段，不报错。
        break;
    }
  }

  removeConv(id) {
    this.convs.delete(id);
  }

  /**
   * 调用链快照（可直接 JSON 序列化）。
   * `alive(pid)` 可注入，便于测试；写者已退出而回合仍"running"的，标成 interrupted。
   */
  view({ alive = pidAlive, titles = new Map() } = {}) {
    const aliveCache = new Map();
    const isAlive = (w) => {
      const pid = writerPid(w);
      if (pid === null) return false;
      if (!aliveCache.has(pid)) aliveCache.set(pid, alive(pid));
      return aliveCache.get(pid);
    };
    const convs = [...this.convs.values()].map((c) => {
      const runs = c.runs.map((r) => {
        let status = r.status;
        if ((status === 'running' || status === 'queued') && !isAlive(r.writer ?? c.writer)) status = 'interrupted';
        const current = status === 'running' ? [...r.items].reverse().find((x) => x.kind === 'tool' && !isTerminalTool(x.status)) : null;
        const pending = r.items.filter((x) => x.kind === 'approval' && x.mode === 'ask' && !x.decided);
        return {
          ...r,
          status,
          items: r.items.map((x) => ({ ...x })),
          current_tool: current ? current.name ?? current.title ?? current.id : null,
          pending_approvals: status === 'running' ? pending.length : 0,
          escalations: r.items.filter((x) => x.kind === 'approval' && x.escalation).length,
        };
      });
      const latest = runs[runs.length - 1] ?? null;
      // 运行中的回合优先于排队的（排队的回合总是排在运行中的后面）。
      const state = runs.some((r) => r.status === 'running')
        ? 'running'
        : runs.some((r) => r.status === 'queued')
          ? 'queued'
          : c.closed
            ? 'closed'
            : 'idle';
      return {
        id: c.id,
        title: titles.get(c.id) ?? c.title ?? c.title_hint ?? null,
        cwd: c.cwd,
        client: c.client ?? latest?.client ?? null,
        writer: c.writer,
        writer_alive: isAlive(c.writer),
        permission: c.permission,
        on_approval: c.on_approval,
        model: c.model,
        opened_at: c.opened_at,
        last_ts: c.last_ts,
        state,
        /** 会话累计（DSH 自己记的，含更早的回合）；没有就用 live 里各回合之和。 */
        tokens: c.session_tokens ?? sumTokens(runs.map((r) => r.tokens)),
        context: c.context,
        runs,
      };
    });
    convs.sort((a, b) => rank(a.state) - rank(b.state) || String(b.last_ts ?? '').localeCompare(String(a.last_ts ?? '')));

    // 调用链的第一层：按"哪个客户端、哪个服务实例"分组。
    const groups = new Map();
    for (const c of convs) {
      const pid = writerPid(c.writer);
      const key = `${c.client ?? 'unknown'}|${pid ?? '-'}`;
      if (!groups.has(key)) groups.set(key, { client: c.client ?? null, pid, alive: c.writer_alive, conversations: [] });
      groups.get(key).conversations.push(c);
    }
    const running = convs.filter((c) => c.state === 'running').length;
    return {
      generated_at: new Date().toISOString(),
      totals: {
        conversations: convs.length,
        running,
        queued: convs.reduce((n, c) => n + c.runs.filter((r) => r.status === 'queued').length, 0),
        pending_approvals: convs.reduce((n, c) => n + c.runs.reduce((m, r) => m + r.pending_approvals, 0), 0),
        escalations: convs.reduce((n, c) => n + c.runs.reduce((m, r) => m + r.escalations, 0), 0),
        tokens: sumTokens(convs.map((c) => c.tokens)),
      },
      groups: [...groups.values()],
    };
  }
}

/** 把若干组 token 计数相加；全是空时返回 null。 */
export function sumTokens(list) {
  let any = false;
  const out = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const t of list) {
    if (!t) continue;
    any = true;
    for (const k of TOKEN_KEYS) out[k] += t[k] ?? 0;
  }
  return any ? out : null;
}

function rank(state) {
  return state === 'running' ? 0 : state === 'queued' ? 1 : state === 'idle' ? 2 : 3;
}

export function isTerminalTool(status) {
  return status === 'completed' || status === 'failed' || status === 'unfinished';
}

/**
 * 增量 tail 一个 live 目录。`poll()` 返回本次是否有变化。
 * 只读文件；目录不存在时安静地什么也不做（服务可能还没写过任何事件）。
 */
export class LiveTail {
  constructor(dir, { state = new LiveState(), stateFile = null, readTitle = null } = {}) {
    this.dir = dir;
    this.state = state;
    this.stateFile = stateFile;
    this.readTitle = readTitle;
    /** file → {offset, rest: Buffer, ino} */
    this.files = new Map();
    this.titles = new Map();
    this.titlesAt = 0;
  }

  #readFrom(file, track) {
    let st;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (st.size < track.offset) {
      // 被滚动（rename 成 .1 后重新开始）：从头读新文件。
      track.offset = 0;
      track.rest = Buffer.alloc(0);
    }
    if (st.size === track.offset) return false;
    const len = st.size - track.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = openSync(file, 'r');
      const n = readSync(fd, buf, 0, len, track.offset);
      track.offset += n;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
    const { lines, rest } = splitLines(Buffer.concat([track.rest, buf]));
    track.rest = Buffer.from(rest);
    let changed = false;
    for (const line of lines) {
      const ev = parseEvent(line);
      if (ev) {
        this.state.apply(ev);
        changed = true;
      }
    }
    return changed;
  }

  poll() {
    let changed = false;
    let names = [];
    try {
      names = existsSync(this.dir) ? readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    } catch {
      names = [];
    }
    const present = new Set(names);
    // 会话目录被删（forget）：从视图里移除。
    for (const id of [...this.state.convs.keys()]) {
      if (!present.has(id)) {
        this.state.removeConv(id);
        for (const k of [...this.files.keys()]) if (k.startsWith(join(this.dir, id))) this.files.delete(k);
        changed = true;
      }
    }
    for (const id of names) {
      const file = join(this.dir, id, LIVE_FILE);
      let track = this.files.get(file);
      if (!track) {
        track = { offset: 0, rest: Buffer.alloc(0) };
        this.files.set(file, track);
        // 第一次见到这个会话：先读滚动出去的旧档，时间线才完整。
        const old = `${file}.1`;
        if (existsSync(old)) {
          const oldTrack = { offset: 0, rest: Buffer.alloc(0) };
          if (this.#readFrom(old, oldTrack)) changed = true;
        }
      }
      if (this.#readFrom(file, track)) changed = true;
    }
    if (this.#refreshTitles()) changed = true;
    return changed;
  }

  /**
   * 标题：调用方给的 title_hint（注册表 > conv.open 事件）> DSH 原生标题（投影缓存）。
   * DSH 原生标题只是首条 prompt 的截断前缀（"在当前目录做一个简易的、可"），
   * 有显式 title_hint 时它更可读。
   */
  #refreshTitles() {
    const t = Date.now();
    if (t - this.titlesAt < TITLE_TTL_MS) return false;
    this.titlesAt = t;
    const hints = new Map();
    if (this.stateFile) {
      try {
        const doc = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        for (const c of doc?.conversations ?? []) if (c?.id && typeof c.titleHint === 'string') hints.set(c.id, c.titleHint);
      } catch {
        /* 注册表读不了就算了 */
      }
    }
    let changed = false;
    for (const [id, conv] of this.state.convs) {
      let title = hints.get(id) ?? conv.title_hint ?? null;
      if (!title && this.readTitle) {
        try {
          title = this.readTitle(id) ?? null;
        } catch {
          title = null;
        }
      }
      if (title && this.titles.get(id) !== title) {
        this.titles.set(id, title);
        changed = true;
      }
    }
    return changed;
  }

  view(opts = {}) {
    return this.state.view({ titles: this.titles, ...opts });
  }
}

// ── 终端原地刷新（watch） ───────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** 单个码点在终端里占几列：CJK / 全角 / emoji 记 2，其余 1（框线字符在主流终端里是 1）。 */
export function charWidth(cp) {
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 可见宽度（忽略 ANSI 颜色序列）。 */
export function displayWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; ) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m) {
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i);
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/**
 * 把一行截到 `cols` 列以内（保留颜色序列，超出时末尾放 `…`）。
 * 不截的话长行会折到下一行，原地刷新时整棵树就错位了。
 */
export function clipLine(s, cols) {
  if (!(cols > 1) || displayWidth(s) <= cols) return s;
  let w = 0;
  let out = '';
  for (let i = 0; i < s.length; ) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i);
    const cw = charWidth(cp);
    if (w + cw > cols - 1) break;
    out += String.fromCodePoint(cp);
    w += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out + '…\x1b[0m';
}

// ── 界面语言 ────────────────────────────────────────────────

/** watch / dashboard 命令行界面的两份文案。函数式条目负责插值。 */
export const TEXT = {
  zh: {
    header: (c, r) => `DSH live · ${c} 会话 · ${r} 运行中`,
    queued: (n) => `${n} 排队`,
    pending: (n) => `${n} 待审批`,
    escalations: (n) => `⚠ ${n} 次提权`,
    tokens: (i, o) => `token 入 ${i} / 出 ${o}`,
    unknownClient: '未知客户端',
    exited: ' (已退出)',
    running: '运行中',
    queuedState: '排队',
    closed: '已释放',
    idle: '空闲',
    total: (i, o) => ` · 累计 ${i}/${o}`,
    context: (p) => ` · 上下文 ${p}%`,
    untitled: '(无标题)',
    tools: (n) => `${n} 工具`,
    runEscalations: (n) => `⚠${n} 提权`,
    earlier: (n) => `…前面还有 ${n} 条`,
    noMatch: (q) => `没有匹配 ${q} 的会话。`,
    empty: '还没有任何事件。派一次活（dsh_send）之后这里就会出现。',
    approval: '审批',
    waiting: ' → 等待裁决',
    interject: '插话',
    interrupt: '■ 中断',
    hiddenRows: (n) => `…还有 ${n} 行没显示（给会话 id 前缀、或用 --runs / --items 收窄）`,
    footer: (time, dir) => `更新于 ${time} · live 目录: ${dir} · Ctrl+C 退出`,
  },
  en: {
    header: (c, r) => `DSH live · ${c} conversation${c === 1 ? '' : 's'} · ${r} running`,
    queued: (n) => `${n} queued`,
    pending: (n) => `${n} awaiting approval`,
    escalations: (n) => `⚠ ${n} escalation${n === 1 ? '' : 's'}`,
    tokens: (i, o) => `tokens in ${i} / out ${o}`,
    unknownClient: 'unknown client',
    exited: ' (exited)',
    running: 'running',
    queuedState: 'queued',
    closed: 'released',
    idle: 'idle',
    total: (i, o) => ` · total ${i}/${o}`,
    context: (p) => ` · context ${p}%`,
    untitled: '(untitled)',
    tools: (n) => `${n} tool${n === 1 ? '' : 's'}`,
    runEscalations: (n) => `⚠${n} escalation${n === 1 ? '' : 's'}`,
    earlier: (n) => `…${n} earlier`,
    noMatch: (q) => `No conversation matches ${q}.`,
    empty: 'No events yet. Dispatch something (dsh_send) and it shows up here.',
    approval: 'approval',
    waiting: ' → awaiting decision',
    interject: 'interject',
    interrupt: '■ interrupted',
    hiddenRows: (n) => `…${n} more line${n === 1 ? '' : 's'} hidden (pass a conversation id prefix, or narrow with --runs / --items)`,
    footer: (time, dir) => `updated ${time} · live dir: ${dir} · Ctrl+C to quit`,
  },
};

/**
 * 界面语言：显式 `zh` / `en` 优先；否则看 DSH_MCP_LANG，再看 LC_ALL / LC_MESSAGES / LANG，
 * 最后看系统区域设置（Windows 上通常没有 LANG）。以 zh 开头 → 中文，其余 → 英文。
 */
export function detectLang(explicit = null, env = process.env, locale = null) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
  const norm = (v) => (v.startsWith('zh') ? 'zh' : 'en');
  const direct = pick(explicit) ?? pick(env.DSH_MCP_LANG);
  if (direct === 'zh' || direct === 'en') return direct;
  if (direct) return norm(direct);
  const fromEnv = pick(env.LC_ALL) ?? pick(env.LC_MESSAGES) ?? pick(env.LANG);
  if (fromEnv && fromEnv !== 'c' && fromEnv !== 'posix') return norm(fromEnv);
  let sys = locale;
  if (!sys) {
    try {
      sys = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      sys = 'en';
    }
  }
  return norm(String(sys).toLowerCase());
}

const T = (lang) => TEXT[lang] ?? TEXT.zh;

/**
 * 把一帧文本排成"适合这个终端"的行：截宽、截高（超出的行数在最后一行说明）。
 * 纯函数，方便测试。
 */
export function layoutFrame(text, { cols = 120, rows = 40, lang = 'zh' } = {}) {
  let lines = String(text).split('\n').map((l) => clipLine(l, cols));
  if (rows > 2 && lines.length > rows) {
    const hidden = lines.length - (rows - 1);
    lines = lines.slice(0, rows - 1);
    lines.push(clipLine(`\x1b[2m${T(lang).hiddenRows(hidden)}\x1b[0m`, cols));
  }
  return lines;
}

/**
 * 计算从上一帧到这一帧要写的终端序列：只重写变化的行，多出来的旧行清掉。
 * 第一帧（prev 为 null）整屏重画。返回要写出的字符串（无变化时为空串）。
 */
export function diffFrame(prev, next) {
  let out = '';
  if (!prev) out += '\x1b[H\x1b[2J';
  for (let i = 0; i < next.length; i++) {
    if (prev && prev[i] === next[i]) continue;
    out += `\x1b[${i + 1};1H${next[i]}\x1b[0m\x1b[K`;
  }
  if (prev && prev.length > next.length) out += `\x1b[${next.length + 1};1H\x1b[J`;
  return out;
}

// ── 终端渲染（watch） ───────────────────────────────────────────

const STATUS_MARK = {
  running: '▶',
  queued: '…',
  done: '✓',
  error: '✗',
  cancelled: '■',
  interrupted: '!',
};

function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function clip(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * 把调用链快照渲染成纯文本树（watch 用）。
 * @param {object} view LiveState.view() 的返回
 * @param {object} [opts]
 * @param {string} [opts.conv] 只看某个会话（id 前缀即可）
 * @param {number} [opts.runs] 每个会话显示最近几轮（默认 3）
 * @param {number} [opts.items] 每轮显示最后几条工具/审批（默认 12）
 * @param {boolean} [opts.color] ANSI 颜色
 * @param {'zh'|'en'} [opts.lang] 界面语言（默认中文）
 */
export function renderText(view, { conv = null, runs = 3, items = 12, color = false, lang = 'zh' } = {}) {
  const L = T(lang);
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s) => c('2', s);
  const warn = (s) => c('33', s);
  const bad = (s) => c('31', s);
  const good = (s) => c('32', s);
  const out = [];
  const t = view.totals;
  out.push(
    L.header(t.conversations, t.running) +
      (t.queued ? ` · ${L.queued(t.queued)}` : '') +
      (t.pending_approvals ? ` · ${warn(L.pending(t.pending_approvals))}` : '') +
      (t.escalations ? ` · ${warn(L.escalations(t.escalations))}` : '') +
      (t.tokens ? ` · ${L.tokens(fmtTokens(tokenInputTotal(t.tokens)), fmtTokens(t.tokens.output))}` : ''),
  );
  let shown = 0;
  for (const g of view.groups) {
    const convs = conv ? g.conversations.filter((x) => x.id.startsWith(conv)) : g.conversations;
    if (!convs.length) continue;
    out.push('');
    out.push(`${g.client ?? L.unknownClient}  ${dim(`pid ${g.pid ?? '?'}${g.alive ? '' : L.exited}`)}`);
    convs.forEach((cv, ci) => {
      shown++;
      const lastConv = ci === convs.length - 1;
      const p1 = lastConv ? '└─ ' : '├─ ';
      const p1c = lastConv ? '   ' : '│  ';
      const stateTxt = cv.state === 'running' ? good(L.running) : cv.state === 'queued' ? warn(L.queuedState) : dim(cv.state === 'closed' ? L.closed : L.idle);
      const ctx = cv.context && cv.context.window ? L.context(Math.round((cv.context.used / cv.context.window) * 100)) : '';
      const tok = cv.tokens ? L.total(fmtTokens(tokenInputTotal(cv.tokens)), fmtTokens(cv.tokens.output)) : '';
      out.push(`${p1}${shortId(cv.id)}  ${clip(cv.title ?? L.untitled, 40)}  ${stateTxt}${dim(tok + ctx)}  ${dim(`${cv.permission ?? ''} · ${clip(cv.cwd ?? '', 50)}`)}`);
      const rs = cv.runs.slice(-runs);
      rs.forEach((r, ri) => {
        const lastRun = ri === rs.length - 1;
        const p2 = p1c + (lastRun ? '└─ ' : '├─ ');
        const p2c = p1c + (lastRun ? '   ' : '│  ');
        const mark = STATUS_MARK[r.status] ?? '?';
        const markC = r.status === 'error' || r.status === 'interrupted' ? bad(mark) : r.status === 'running' ? good(mark) : mark;
        const meta = [
          r.via ? `[${r.via}]` : null,
          r.status,
          r.duration_ms != null ? fmtMs(r.duration_ms) : null,
          r.tool_count != null ? L.tools(r.tool_count) : null,
          r.tokens ? `${fmtTokens(tokenInputTotal(r.tokens))}↑ ${fmtTokens(r.tokens.output)}↓ tok` : null,
          r.escalations ? warn(L.runEscalations(r.escalations)) : null,
          r.pending_approvals ? warn(L.pending(r.pending_approvals)) : null,
        ].filter(Boolean);
        out.push(`${p2}${markC} ${r.run}  ${meta.join(' · ')}${r.prompt_preview ? `  ${dim(`“${clip(r.prompt_preview, 60)}”`)}` : ''}`);
        if (r.error) out.push(`${p2c}   ${bad(clip(r.error, 100))}`);
        const its = r.items.slice(-items);
        if (r.items.length > its.length) out.push(`${p2c}   ${dim(L.earlier(r.items.length - its.length))}`);
        for (const it of its) out.push(p2c + '   ' + renderItem(it, { warn, bad, good, dim }, cv.cwd, L));
      });
    });
  }
  if (!shown) out.push('', dim(conv ? L.noMatch(conv) : L.empty));
  return out.join('\n');
}

/** 去掉会话目录前缀，把路径显示成相对路径。 */
export function relToCwd(text, cwd) {
  if (!text || !cwd) return text ?? '';
  const root = String(cwd).replace(/[\\/]+$/, '');
  let out = String(text);
  for (const sep of ['\\', '/']) out = out.split(root + sep).join('');
  return out.split(root).join('.');
}

function renderItem(it, { warn, bad, good, dim }, cwd, L = TEXT.zh) {
  if (it.kind === 'tool') {
    const st = it.status === 'completed' ? good('✓') : it.status === 'failed' ? bad('✗') : it.status === 'unfinished' ? dim('·') : warn('▶');
    const what = relToCwd(it.input_preview ?? (it.title !== it.name ? it.title : '') ?? '', cwd);
    return `${st} ${it.name ?? it.title ?? it.id ?? 'tool'}${what ? `  ${dim(clip(what, 70))}` : ''}${it.elapsed_ms != null ? `  ${dim(fmtMs(it.elapsed_ms))}` : ''}`;
  }
  if (it.kind === 'approval') {
    const decided = it.decided ? ` → ${it.decided.decision ?? it.decided.effective ?? ''}${it.decided.by ? `(${it.decided.by})` : ''}` : it.mode === 'ask' ? warn(L.waiting) : '';
    const esc = it.escalation ? warn(` ⚠ ${it.escalation}`) : '';
    return `${warn('◆')} ${L.approval} ${it.mode ?? ''}${esc}${decided}${it.command_preview ? `  ${dim(clip(relToCwd(it.command_preview, cwd), 60))}` : ''}`;
  }
  if (it.kind === 'interject') return `${warn('↪')} ${L.interject}(${it.mode ?? ''})${it.text_preview ? `  ${dim(clip(it.text_preview, 60))}` : ''}`;
  if (it.kind === 'interrupt') return bad(L.interrupt);
  return dim(it.kind);
}
