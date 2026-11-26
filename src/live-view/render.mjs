/**
 * 终端渲染与原地刷新（watch）：列宽裁切、帧差分、双语文案、控制字符清洗与文本树渲染。
 */

import { fmtTokens, tokenInputTotal } from './state.mjs';

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** 单个码点在终端里占几列：CJK / 全角 / emoji 记 2，其余 1。 */
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

/** 把一行截到 `cols` 列以内（保留颜色序列，超出时末尾放 `…`）。 */
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

/** watch / dashboard 命令行界面的两份文案。 */
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

const T = (lang) => TEXT[lang] ?? TEXT.zh;

/** 把一帧文本排成"适合这个终端"的行：截宽、截高。 */
export function layoutFrame(text, { cols = 120, rows = 40, lang = 'zh' } = {}) {
  let lines = String(text).split('\n').map((l) => clipLine(l, cols));
  if (rows > 2 && lines.length > rows) {
    const hidden = lines.length - (rows - 1);
    lines = lines.slice(0, rows - 1);
    lines.push(clipLine(`\x1b[2m${T(lang).hiddenRows(hidden)}\x1b[0m`, cols));
  }
  return lines;
}

/** 计算从上一帧到这一帧要写的终端序列：只重写变化的行，多出来的旧行清掉。 */
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

const STATUS_MARK = {
  running: '▶',
  queued: '…',
  done: '✓',
  error: '✗',
  cancelled: '■',
  interrupted: '!',
};

const shortId = (id) => String(id ?? '').slice(0, 8);

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

/** 深拷贝 view，剥掉所有字符串里的 C0/C1 控制字符，防 OSC 52 等终端注入。 */
function scrubView(v) {
  if (typeof v === 'string') return v.replace(/[\t\n\r\v\f]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  if (Array.isArray(v)) return v.map(scrubView);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrubView(x);
    return o;
  }
  return v;
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

/** 把调用链快照渲染成纯文本树（watch 用）。 */
export function renderText(view, { conv = null, runs = 3, items = 12, color = false, lang = 'zh' } = {}) {
  view = scrubView(view);
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
