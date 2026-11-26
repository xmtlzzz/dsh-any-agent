/**
 * live 事件流的解析、token 计算与纯内存归并器（LiveState）。
 */

const MAX_RUNS_PER_CONV = 30;
const MAX_ITEMS_PER_RUN = 300;
const NEWLINE = 0x0a;
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write'];

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

/** 按字节找换行，不会把多字节 UTF-8 字符切坏；末尾半行原样留在 rest。 */
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

/** 解析一行；坏行 / 未知结构返回 null。 */
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
    tokens: null,
    context: null,
    items: [],
  };
}

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

/** 事件归并器。纯内存、与文件无关，方便单测。 */
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
        break;
    }
  }

  removeConv(id) {
    this.convs.delete(id);
  }

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
        tokens: c.session_tokens ?? sumTokens(runs.map((r) => r.tokens)),
        context: c.context,
        runs,
      };
    });
    convs.sort((a, b) => rank(a.state) - rank(b.state) || String(b.last_ts ?? '').localeCompare(String(a.last_ts ?? '')));

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
