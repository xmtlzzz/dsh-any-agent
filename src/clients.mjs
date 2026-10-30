/**
 * 客户端 MCP 配置的「只改自己那一条」写入引擎。
 *
 * 为什么要单独一个模块：这段代码改的是别人（Claude Code、Codex、Cursor、Zed……）
 * 的配置文件。一个会重排缩进、丢注释、把 CRLF 换成 LF 的写入器，即使「值都对」，
 * 也是在毁用户的东西 —— 那些文件里还躺着用户手写的注释、别的 MCP 服务器、
 * 顶层设置和几十个项目条目。
 *
 * 因此这里的写入全部是**文本级定点编辑**，不是「解析成对象再整体序列化」：
 *   - 只替换/插入/删除我们那一个条目所占的字符区间；
 *   - 缩进（2 空格 / 4 空格 / Tab）、键顺序、行尾（LF/CRLF）、UTF-8 BOM、
 *     有无末尾换行，全部原样保留；
 *   - 删除后再写回，能把文件还原成写入前的字节（JSON 全程可逆）。
 *
 * 解析仍然要真做：只有先把 JSON/JSONC 扫成一棵带区间的树，才知道「我们那条」
 * 从哪里到哪里。扫描器容忍注释与尾随逗号（JSONC），因为 Zed / VS Code 的
 * 配置文件允许它们。
 */

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';

/** 写进每个客户端的条目名。同时也是 --remove 唯一的识别依据。 */
export const ENTRY_NAME = 'dsh-any-agent';

export const IS_WIN = platform() === 'win32';
export const IS_MAC = platform() === 'darwin';

// ── 文件读写：备份 + 原子写 ─────────────────────────────────────────

/** 写入前的备份文件名：<file>.bak-dsh-<时间戳>。 */
export function backupSuffix(stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  return '.bak-dsh-' + stamp;
}

/**
 * 备份一个文件，返回备份路径。
 * 同一毫秒内对同一文件备份两次会撞名：撞了就加序号，绝不覆盖已有备份 ——
 * 覆盖掉的那一份可能正是用户唯一能回滚到的状态。
 */
export function backupFile(file, stamp) {
  const base = file + backupSuffix(stamp);
  let dst = base;
  for (let i = 2; existsSync(dst); i++) dst = base + '-' + i;
  copyFileSync(file, dst);
  return dst;
}

/**
 * 先写临时文件再改名，避免崩溃时留下半截配置。
 * 临时名带 pid + 随机后缀：同名会在并发运行时互相覆盖。
 * 任何一步失败都必须删掉临时文件 —— 曾经有版本在 rename 失败后
 * 把 mcp.json.tmp-dsh-<pid> 留在了客户端目录里。
 */
export function atomicWrite(file, text) {
  const tmp = file + '.tmp-dsh-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 尽力而为 */ }
    throw e;
  }
}

/**
 * 这个文件现在能不能被我们写。
 *
 * 为什么不能只靠 rename 的报错：写入是「先写临时文件再 rename」，
 * 而 rename 只要求**目录**可写，不要求目标文件可写。于是 POSIX 上
 * 一个 0444 的配置会被静默替换掉 —— 用户明明把它设成只读，我们照写。
 * Windows 上 rename 撞到只读属性会 EPERM，所以在那边看起来是好的。
 * 显式查一次写权限，两个平台行为才一致。
 *
 * root 无视权限位，access 会返回成功 —— 那是对的，root 确实能写。
 */
export function isWritable(file) {
  if (!existsSync(file)) return true;
  try {
    accessSync(file, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读一个配置文件，把 BOM 拆出来单独记着。
 * 直接 JSON.parse 带 BOM 的文本会抛 —— 真实存在的编辑器配置里就有 BOM。
 */
export function readConfigFile(file) {
  const raw = readFileSync(file, 'utf8');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  return { raw, bom, text: bom ? raw.slice(1) : raw };
}

// ── JSON 扫描器：容忍注释与尾随逗号，返回带字符区间的树 ──────────────

const NL = String.fromCharCode(10);
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * 把 JSON/JSONC 文本扫成节点树。每个节点都带 [start, end) 区间，
 * 对象的每个条目还带 key 与 value 的区间 —— 定点编辑全靠它们。
 * 不构造值对象（除了 key 字符串），所以大文件也不会解析两遍。
 */
export function scanJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    const err = new Error(msg + ' at offset ' + i);
    err.code = 'EJSONSCAN';
    throw err;
  };

  function skipTrivia() {
    for (;;) {
      while (i < n && isWs(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i = Math.min(i + 2, n);
        continue;
      }
      return;
    }
  }

  function scanString() {
    const start = i;
    i++;
    while (i < n) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') {
        i++;
        let value;
        try { value = JSON.parse(text.slice(start, i)); } catch { value = text.slice(start + 1, i - 1); }
        return { type: 'string', start, end: i, value };
      }
      i++;
    }
    fail('unterminated string');
  }

  function scanValue() {
    skipTrivia();
    const c = text[i];
    if (c === undefined) fail('unexpected end of input');
    if (c === '{') return scanObject();
    if (c === '[') return scanArray();
    if (c === '"') return scanString();
    const start = i;
    while (i < n && !isWs(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
    if (i === start) fail('unexpected character ' + JSON.stringify(c));
    return { type: 'literal', start, end: i, raw: text.slice(start, i) };
  }

  function scanObject() {
    const start = i;
    i++; // {
    const entries = [];
    for (;;) {
      skipTrivia();
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, entries }; }
      if (text[i] === undefined) fail('unterminated object');
      if (text[i] !== '"') fail('expected a quoted key');
      const key = scanString();
      skipTrivia();
      if (text[i] !== ':') fail('expected ":"');
      i++;
      const value = scanValue();
      entries.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
      skipTrivia();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, entries }; }
      fail('expected "," or "}"');
    }
  }

  function scanArray() {
    const start = i;
    i++; // [
    const items = [];
    for (;;) {
      skipTrivia();
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
      const value = scanValue();
      items.push(value);
      skipTrivia();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
      fail('expected "," or "]"');
    }
  }

  const root = scanValue();
  skipTrivia();
  if (i !== n) fail('trailing content');
  return root;
}
// ── 缩进/行尾探测 ───────────────────────────────────────────────────

/** 某一位置所在行的前导空白。 */
function leadingWsOfLine(text, pos) {
  let s = pos;
  while (s > 0 && text[s - 1] !== '\n' && text[s - 1] !== '\r') s--;
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

/** 若 pos 只被空白推到行首，返回这段空白；否则 null（说明前面还有别的内容）。 */
function lineIndentBefore(text, pos) {
  let s = pos;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (s === 0 || text[s - 1] === '\n' || text[s - 1] === '\r') return text.slice(s, pos);
  return null;
}

/** 文件用什么行尾：出现过 CRLF 就按 CRLF 写，否则 LF。 */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 探测一个缩进单位：取根对象里最浅那一层键的缩进（2 空格 / 4 空格 / Tab）。
 * 认不出来时返回 null，由调用方退回两空格。
 */
export function detectIndentUnit(text, root) {
  if (!root || root.type !== 'object') return null;
  let best = null;
  for (const e of root.entries) {
    const ind = lineIndentBefore(text, e.keyStart);
    if (ind === null || ind === '') continue;
    if (best === null || ind.length < best.length || (ind.length === best.length && ind.includes('\t'))) best = ind;
  }
  return best;
}

/** 把值渲染成 JSON 文本，再按 pos 处的缩进把后续行补齐。 */
export function renderValue(value, { unit, eol, indent }) {
  const raw = JSON.stringify(value, null, unit);
  if (!raw.includes('\n')) return raw;
  return raw.replace(/\n/g, eol + indent);
}

// ── 定点编辑：插入 / 替换 / 删除一个对象的键 ───────────────────────

function indexOfEntry(obj, key) {
  return obj.entries.findIndex((e) => e.key === key);
}

/** 在对象 obj 里插入 key；valueJson 是已渲染好的 JSON 文本。 */
function insertKey(text, obj, key, valueJson, { unit, eol }) {
  const keyJson = JSON.stringify(key);
  const slice = text.slice(obj.start, obj.end);
  const multiline = slice.includes('\n');

  if (!obj.entries.length) {
    if (!multiline) {
      const inner = text.slice(obj.start + 1, obj.end - 1);
      const pad = inner.trim() === '' ? (inner === '' ? '' : inner) : ' ';
      return text.slice(0, obj.start + 1) + pad + keyJson + ': ' + valueJson + pad + text.slice(obj.end - 1);
    }
    const baseIndent = leadingWsOfLine(text, obj.start);
    const indent = baseIndent + unit;
    const body = eol + indent + keyJson + ': ' + valueJson + eol + baseIndent;
    return text.slice(0, obj.start + 1) + body + text.slice(obj.end - 1);
  }

  const last = obj.entries[obj.entries.length - 1];
  const at = last.value.end;
  if (!multiline) {
    return text.slice(0, at) + ', ' + keyJson + ': ' + valueJson + text.slice(at);
  }
  const indent = lineIndentBefore(text, last.keyStart) ?? (leadingWsOfLine(text, last.keyStart) + unit);
  const body = ',' + eol + indent + keyJson + ': ' + valueJson;
  return text.slice(0, at) + body + text.slice(at);
}

function replaceValue(text, entry, valueJson) {
  return text.slice(0, entry.value.start) + valueJson + text.slice(entry.value.end);
}

/**
 * 从对象 obj 里删掉 key 所在条目，并吃掉一个相邻逗号，
 * 保证不会留下孤立的逗号，也不动别人条目的缩进。
 */
function removeKey(text, obj, key) {
  const idx = indexOfEntry(obj, key);
  if (idx < 0) return null;
  const entry = obj.entries[idx];

  // 只有这一个条目：还原成空对象，保留它原本的写法（单行/多行）。
  if (obj.entries.length === 1) {
    const slice = text.slice(obj.start, obj.end);
    const eol = detectEol(text);
    if (!slice.includes('\n')) return text.slice(0, obj.start) + '{}' + text.slice(obj.end);
    const baseIndent = leadingWsOfLine(text, obj.start);
    return text.slice(0, obj.start) + '{' + eol + baseIndent + '}' + text.slice(obj.end);
  }

  // 优先吃掉自己前面那个逗号（后面条目的缩进保持不动）。
  const start = entry.keyStart;
  let p = start - 1;
  while (p >= obj.start && isWs(text[p])) p--;
  if (text[p] === ',') {
    let e = entry.value.end;
    while (e < obj.end && (text[e] === ' ' || text[e] === '\t')) e++;
    return text.slice(0, p) + text.slice(e);
  }

  // 自己是第一个条目：吃掉后面那个逗号与随后的空白。
  let e = entry.value.end;
  let q = e;
  while (q < obj.end && isWs(text[q])) q++;
  if (text[q] === ',') {
    e = q + 1;
    while (e < obj.end && (text[e] === ' ' || text[e] === '\t')) e++;
    return text.slice(0, start) + text.slice(e);
  }
  return text.slice(0, start) + text.slice(e);
}

/**
 * 在 JSON/JSONC 文本里设置（value 为 null 时删除）containerKey -> entryKey 这一条。
 * 返回 { changed, text }。不解析、不重排任何其它内容。
 */
export function editJsonEntry(rawText, containerKey, entryKey, value, options = {}) {
  // BOM 不属于 JSON 正文，但必须原样保留：先把它们拆开，最后再拼回去。
  const bom = rawText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = bom ? rawText.slice(1) : rawText;
  const result = editJsonEntryBody(text, containerKey, entryKey, value, options);
  return { changed: result.changed, text: bom + result.text };
}

/**
 * 摘掉最后一条之后容器是空的：空容器不带任何信息，一并收掉。
 * 这样「装一次再卸掉」能把文件还原成安装前的样子，而不是留下一个
 * "mcpServers": {} 的脚印。只在容器确实变空时动手，别人的空容器不碰。
 */
function dropContainerIfEmpty(text, containerKey) {
  let root;
  try { root = scanJson(text); } catch { return text; }
  const idx = indexOfEntry(root, containerKey);
  if (idx < 0) return text;
  const cont = root.entries[idx];
  if (cont.value.type !== 'object' || cont.value.entries.length !== 0) return text;
  const without = removeKey(text, root, containerKey);
  if (without === null) return text;
  // 丢容器只允许让文件更短，且必须仍然可解析；否则宁可留着空容器。
  try { scanJson(without); } catch { return text; }
  return without;
}

function editJsonEntryBody(text, containerKey, entryKey, value, options) {
  const eol = detectEol(text);
  const root = scanJson(text);
  if (root.type !== 'object') throw new Error('the top level of this config is not a JSON object');

  const unit = detectIndentUnit(text, root) ?? '  ';
  const contIdx = indexOfEntry(root, containerKey);

  if (value === null) {
    if (contIdx < 0) return { changed: false, text };
    const cont = root.entries[contIdx];
    if (cont.value.type !== 'object') throw new Error('"' + containerKey + '" is not an object');
    if (indexOfEntry(cont.value, entryKey) < 0) return { changed: false, text };
    const next = removeKey(text, cont.value, entryKey);
    if (next === null) return { changed: false, text };
    const repaired = options.dropEmptyContainer ? dropContainerIfEmpty(next, containerKey) : next;
    return { changed: repaired !== text, text: repaired };
  }

  if (contIdx >= 0) {
    const cont = root.entries[contIdx];
    if (cont.value.type !== 'object') {
      throw new Error('"' + containerKey + '" exists but is not an object, refusing to touch it');
    }
    const entryIdx = indexOfEntry(cont.value, entryKey);
    if (entryIdx >= 0) {
      const existing = cont.value.entries[entryIdx];
      const currentText = text.slice(existing.value.start, existing.value.end);
      const indent = lineIndentBefore(text, existing.keyStart);
      const compact = indent === null || !text.slice(cont.value.start, cont.value.end).includes(NL);
      const desired = compact ? JSON.stringify(value) : renderValue(value, { unit, eol, indent });
      if (stripWs(currentText) === stripWs(desired)) return { changed: false, text };
      return { changed: true, text: replaceValue(text, existing, desired) };
    }
    const indent = leadingWsOfLine(text, cont.keyStart);
    const childIndent = indent + unit;
    // 单行容器里塞一个多行值会把用户的一行配置拆散：跟着容器的写法走。
    const compact = !text.slice(cont.value.start, cont.value.end).includes(NL);
    const rendered = compact ? JSON.stringify(value) : renderValue(value, { unit, eol, indent: childIndent });
    return { changed: true, text: insertKey(text, cont.value, entryKey, rendered, { unit, eol }) };
  }

  // 连容器键都还没有：把容器连同条目一起插进去。
  const indent = leadingWsOfLine(text, root.start);
  const contIndent = indent + unit;
  const compact = !text.includes('\n');
  const renderedCont = compact
    ? JSON.stringify({ [entryKey]: value })
    : renderValue({ [entryKey]: value }, { unit, eol, indent: contIndent });
  return { changed: true, text: insertKey(text, root, containerKey, renderedCont, { unit, eol }) };
}

/** 去掉字符串字面量之外的空白，用来判断「除空白外是否等价」。 */
export function stripWs(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of String(text)) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (isWs(ch) || ch === '\uFEFF') continue;
    out += ch;
  }
  return out;
}
// ── TOML（Codex）：按行编辑，保留注释/顶层键/CRLF ────────────────────

const TOML_HEADER = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

/** 这个表头是不是我们的（[mcp_servers.dsh-any-agent] 及其子表）。 */
function isOurTable(name) {
  const bare = name.trim();
  const m = /^mcp_servers\s*\.\s*(?:"dsh-any-agent"|'dsh-any-agent'|dsh-any-agent)(?:\s*\.\s*.+)?$/.exec(bare);
  return Boolean(m);
}

/** 找出 Codex 配置里属于我们的行区间。 */
function findTomlRanges(lines) {
  const ranges = [];
  let cur = null;
  for (let k = 0; k < lines.length; k++) {
    const m = TOML_HEADER.exec(lines[k]);
    if (m) {
      // 关闭上一个区间时必须把 end 定在「这张表的最后一行」，
      // 而不是文件末尾 —— 否则我们这段会一路吞掉后面所有的表。
      if (cur) { cur.end = k; ranges.push(cur); cur = null; }
      if (isOurTable(m[1])) cur = { start: k, end: lines.length };
      continue;
    }
    if (/^\s*(?:"dsh-any-agent"|'dsh-any-agent'|dsh-any-agent)\s*=/.test(lines[k])) {
      ranges.push({ start: k, end: k + 1, inline: true });
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

/** 去掉一个区间时顺带收掉多出来的空行，避免越删越空。 */
function trimRanges(lines, ranges) {
  return ranges.map((r) => {
    let { start, end } = r;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    if (!r.inline && start > 0 && lines[start - 1].trim() === '') start -= 1;
    return { start, end };
  }).sort((a, b) => b.start - a.start);
}

/**
 * 在 Codex 的 config.toml 里写入或删除我们的表。
 * 只碰 [mcp_servers.dsh-any-agent] 与它的子表；顶层键、注释、其它表、
 * 行尾全部原样。block 为 null 表示删除。
 */
export function editTomlBlock(text, block) {
  const eol = detectEol(text);
  // 结尾的空行数量也是文件的一部分：记下来，删除时原样还回去。
  const trailing = (text.match(/(?:\r?\n)+$/) || [''])[0];
  const body = trailing ? text.slice(0, text.length - trailing.length) : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);

  const ranges = findTomlRanges(lines);
  const hadOurs = ranges.length > 0;
  const finish = (outLines) => (outLines.length ? outLines.join(eol) : '') + trailing;

  if (block === null) {
    if (!hadOurs) return { changed: false, text };
    const kept = lines.slice();
    for (const r of trimRanges(kept, ranges)) kept.splice(r.start, r.end - r.start);
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    const out = finish(kept);
    return { changed: out !== text, text: out };
  }

  const blockLines = block.split('\n');
  if (hadOurs) {
    // 已经一模一样就不动：幂等的关键。
    const current = lines.slice(ranges[0].start, ranges[ranges.length - 1].end)
      .filter((l) => l.trim() !== '');
    if (current.join('\n') === blockLines.filter((l) => l.trim() !== '').join('\n')) {
      return { changed: false, text };
    }
  }

  const kept = lines.slice();
  for (const r of trimRanges(kept, ranges)) kept.splice(r.start, r.end - r.start);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const out = finish(kept.length ? kept.concat([''], blockLines) : blockLines.slice());
  return { changed: true, text: out };
}

// ── 各客户端的配置形状 ──────────────────────────────────────────────

/** 各客户端写 MCP 配置用的容器键。 */
export const CONTAINER_KEY = {
  'claude-desktop': 'mcpServers',
  cursor: 'mcpServers',
  windsurf: 'mcpServers',
  gemini: 'mcpServers',
  zed: 'context_servers',
  vscode: 'servers',
  opencode: 'mcp',
};

/**
 * 每种客户端对「一条 stdio MCP 服务器」的写法都不同，这里不猜：
 *   zed      -> command 是对象 { path, args, env }
 *   vscode   -> 需要 type: "stdio"
 *   opencode -> command 是数组，环境变量叫 environment
 * 其余（claude-desktop / cursor / windsurf / gemini）是 { command, args, env }。
 */
export function entryShape(shape, launch, env, shapeMode) {
  switch (shape) {
    case 'zed': {
      // Zed 自己的文档写的是 { command: { path, args, env } }，但真实机器上
      // 也可能是扁平的 { command, args, env }（历史版本/手工编辑留下的）。
      // 覆盖既有条目时跟随文件里已有的写法，新建时用文档写法。
      if (shapeMode === 'flat') return { command: launch.command, args: launch.args, env };
      return { command: { path: launch.command, args: launch.args, env } };
    }
    case 'vscode':
      return { type: 'stdio', command: launch.command, args: launch.args, env };
    case 'opencode':
      return { type: 'local', command: [launch.command, ...launch.args], enabled: true, environment: env };
    default:
      return { command: launch.command, args: launch.args, env };
  }
}

/** 从既有条目里取出可比较的形状（用于 --status 与幂等判断）。 */
export function describeEntry(shape, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (shape === 'opencode') {
    const cmd = Array.isArray(entry.command) ? entry.command : null;
    if (!cmd || !cmd.length) return null;
    return { command: cmd[0], args: cmd.slice(1), env: entry.environment ?? entry.env ?? {} };
  }
  if (shape === 'zed') {
    const c = entry.command;
    if (c && typeof c === 'object') return { command: c.path, args: c.args ?? [], env: c.env ?? {} };
    if (typeof c === 'string') return { command: c, args: entry.args ?? [], env: entry.env ?? {} };
    return null;
  }
  if (typeof entry.command !== 'string') return null;
  return { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], env: entry.env ?? {} };
}
// ── 客户端注册表 ────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 解析出本次要用的 home 与 appdata（--home / 环境变量 / 平台默认）。 */
export function resolveDirs(homeOverride) {
  // Windows 上优先 USERPROFILE、POSIX 上优先 HOME：MSYS/Git-Bash 会把 HOME
  // 指向别处，那会让配置写到客户端根本不会读的位置。
  const envHome = IS_WIN
    ? (process.env.USERPROFILE || process.env.HOME)
    : (process.env.HOME || process.env.USERPROFILE);
  const home = homeOverride ? resolve(homeOverride) : (envHome ? resolve(envHome) : homedir());
  let appData;
  if (homeOverride || !process.env.APPDATA) {
    // --home 必须把「所有」路径都带走：环境里的 APPDATA 还指着真实用户目录，
    // 沿用它会让我们去改真机的 Claude Desktop / Zed / VS Code 配置。
    appData = IS_WIN
      ? join(home, 'AppData', 'Roaming')
      : (IS_MAC ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  } else appData = resolve(process.env.APPDATA);
  return { home, appData };
}

export function which(cmd) {
  const probe = spawnSync(IS_WIN ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    shell: IS_WIN,
    windowsHide: true,
  });
  return probe.status === 0;
}

function jsonClient(id, label, shape, containerKey, pathOf) {
  return { id, label, kind: 'json', shape, containerKey, pathOf };
}

/**
 * 受支持的客户端。
 *
 * 注意三处形状差异，它们不是笔误：
 *   - VS Code 的 mcp.json 用 servers，不是 mcpServers；
 *   - opencode 用容器 mcp，且 command 是一个数组；
 *   - Zed 的 context_servers 里 command 是对象 { path, args, env }。
 * Claude Code 不走文件：它的用户级配置在 ~/.claude.json，那个文件的 projects
 * 映射里存在大小写不同的重复键，朴素 JSON.parse 会直接失败 —— 重写它等于
 * 毁掉用户的项目列表。所以只经它自己的 claude mcp 子命令。
 */
/** 既有条目用的是什么写法（只对形状有多种合法写法的客户端有意义）。 */
export function existingShapeMode(client, file) {
  if (client.shape !== 'zed' || !existsSync(file)) return undefined;
  try {
    const { raw } = readConfigFile(file);
    const root = scanJson(raw);
    const cont = root.entries.find((e) => e.key === client.containerKey);
    if (!cont || cont.value.type !== 'object') return undefined;
    const ours = cont.value.entries.find((e) => e.key === ENTRY_NAME);
    if (!ours || ours.value.type !== 'object') return undefined;
    const front = raw.slice(ours.value.start, ours.value.end);
    // command 后面是不是紧跟一个 ":" —— 是的话就是扁平写法。
    const cmdIdx = front.indexOf('"command"');
    if (cmdIdx < 0) return undefined;
    const afterCmd = front.slice(cmdIdx + 9).trimStart();
    if (afterCmd.startsWith(':') && afterCmd.slice(1).trimStart().startsWith('"')) return 'flat';
    return 'nested';
  } catch { return undefined; }
}

export function clientList(dirs) {
  const { home, appData } = dirs;
  return [
    { ...jsonClient('claude-code', 'Claude Code', 'vscode', 'mcpServers', () => join(home, '.claude.json')), verifyCli: 'claude' },
    jsonClient(
      'claude-desktop', 'Claude Desktop', 'default', 'mcpServers',
      () => IS_WIN || IS_MAC
        ? join(appData, 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    ),
    { id: 'codex', label: 'Codex', kind: 'toml', pathOf: () => join(home, '.codex', 'config.toml') },
    jsonClient('cursor', 'Cursor', 'default', 'mcpServers', () => join(home, '.cursor', 'mcp.json')),
    jsonClient('windsurf', 'Windsurf', 'default', 'mcpServers',
      () => join(home, '.codeium', 'windsurf', 'mcp_config.json')),
    jsonClient('zed', 'Zed', 'zed', 'context_servers',
      () => IS_WIN || IS_MAC ? join(appData, 'Zed', 'settings.json') : join(home, '.config', 'zed', 'settings.json')),
    jsonClient('gemini', 'Gemini CLI', 'default', 'mcpServers', () => join(home, '.gemini', 'settings.json')),
    jsonClient('opencode', 'opencode', 'opencode', 'mcp', () => join(home, '.config', 'opencode', 'opencode.json')),
    jsonClient('vscode', 'VS Code', 'vscode', 'servers',
      () => IS_WIN || IS_MAC
        ? join(appData, 'Code', 'User', 'mcp.json')
        : join(home, '.config', 'Code', 'User', 'mcp.json')),
  ];
}

/** 让每个客户端「能被检测到」的依据各不相同，但都不写盘。 */
export function isPresent(client, dirs) {
  if (client.kind === 'cli') return which(client.cli);
  return existsSync(client.pathOf(dirs));
}

// ── 计划 / 执行 ─────────────────────────────────────────────────────

export function defaultLaunch() {
  // 与本模块相邻的 bin/dsh-any-agent.mjs 优先；否则退回 PATH 上的命令。
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const sibling = join(here, '..', 'bin', 'dsh-any-agent.mjs');
  if (existsSync(sibling)) return { command: process.execPath, args: [sibling], style: 'node + sibling entry' };
  return { command: ENTRY_NAME, args: [], style: 'PATH command' };
}

export function codexBlock(launch, env) {
  return [
    '[mcp_servers.' + ENTRY_NAME + ']',
    'command = ' + JSON.stringify(launch.command),
    'args = ' + JSON.stringify(launch.args),
    'startup_timeout_sec = 20.0',
    'tool_timeout_sec = 120.0',
    '',
    '[mcp_servers.' + ENTRY_NAME + '.env]',
    ...Object.keys(env).map((k) => k + ' = ' + JSON.stringify(env[k])),
  ].join('\n');
}

/** 我们期望写进去的 env。只有显式设置的项，不塞密钥，也不继承整份环境。 */
export function desiredEnv(permission, extra = {}) {
  const env = { DSH_MCP_PERMISSION: permission ?? 'workspace-write', DSH_MCP_LOG: 'silent' };
  if (process.env.DSH_BIN) env.DSH_BIN = process.env.DSH_BIN;
  return { ...env, ...extra };
}

/**
 * 对单个客户端算出「要不要动、动什么」。不写盘。
 * 返回的 next 是把要写入的完整文件内容（没有就不带 next）。
 */
export function planClient(client, ctx) {
  const { dirs, remove, launch, env } = ctx;
  const file = client.pathOf(dirs);
  const base = { id: client.id, label: client.label, path: file };

  if (client.kind === 'cli') {
    // 计划模式绝不调用会立刻写盘的 add/remove：只做只读探测。
    if (!which(client.cli)) {
      return { ...base, status: 'skipped', changed: false, summary: client.cli + ' CLI not found; its file is never edited by hand' };
    }
    const probe = spawnSync(client.cli, ['mcp', 'get', ENTRY_NAME], {
      encoding: 'utf8', shell: IS_WIN, windowsHide: true,
    });
    const registered = probe.status === 0;
    if (remove) {
      return registered
        ? { ...base, status: 'planned', changed: true, cliAction: 'remove', summary: 'would unregister via ' + client.cli + ' mcp remove' }
        : { ...base, status: 'absent', changed: false, summary: 'not registered' };
    }
    return {
      ...base,
      status: 'planned',
      changed: true,
      cliAction: 'add',
      summary: registered ? 'would re-register (replacing the existing entry)' : 'would register via ' + client.cli + ' mcp add',
    };
  }

  if (client.kind === 'toml') {
    const block = remove ? null : codexBlock(launch, env);
    if (!existsSync(file)) {
      if (remove) return { ...base, status: 'absent', changed: false, summary: 'config file does not exist' };
      return { ...base, status: 'planned', changed: true, next: editTomlBlock('', block).text, summary: 'would create the config file with our table' };
    }
    const { raw, text } = readConfigFile(file);
    void raw;
    const r = editTomlBlock(text, block);
    if (!r.changed) {
      return { ...base, status: 'unchanged', changed: false, summary: remove ? 'not present' : 'already up to date' };
    }
    return { ...base, status: 'planned', changed: true, next: r.text, summary: remove ? 'TOML block would be removed' : 'TOML block would be written' };
  }

  // JSON / JSONC
  const desired = remove ? null : entryShape(client.shape, launch, env, existingShapeMode(client, file));
  if (!existsSync(file)) {
    if (remove) return { ...base, status: 'absent', changed: false, summary: 'config file does not exist' };
    const seeded = editJsonEntry('{}\n', client.containerKey, ENTRY_NAME, desired);
    return { ...base, status: 'planned', changed: true, next: seeded.text, summary: 'would create the config file with our entry' };
  }

  const { raw } = readConfigFile(file);
  let r;
  try {
    r = editJsonEntry(raw, client.containerKey, ENTRY_NAME, desired, { dropEmptyContainer: remove === true });
  } catch (e) {
    // 已经有了一个解析不了的文件：拒绝，并且说清楚是「文件本身坏了」，
    // 而不是我们写坏了 —— 一个把坏 JSON 重写掉的上手工具比没有更糟。
    const summary = e.code === 'EJSONSCAN'
      ? 'existing file is not valid JSON (' + e.message + '); it was left untouched'
      : 'refusing to edit: ' + e.message;
    return { ...base, status: 'failed', changed: false, summary };
  }
  if (!r.changed) {
    return { ...base, status: 'unchanged', changed: false, summary: remove ? 'not present' : 'already up to date' };
  }
  return { ...base, status: 'planned', changed: true, next: r.text, summary: remove ? 'entry would be removed' : 'entry would be written' };
}

/**
 * 把计划落到磁盘。write 为假时只返回计划；
 * 任何一次写入都以 .bak-dsh-<stamp> 备份为前提。
 */
export function applyClient(plan, ctx, stamp) {
  if (!plan || !plan.changed || !ctx.write) return plan;

  const { remove, launch, env } = ctx;
  const client = ctx.byId.get(plan.id);

  if (client.kind === 'cli') {
    const run = (a) => spawnSync(client.cli, a, { encoding: 'utf8', shell: IS_WIN, windowsHide: true });
    const textOf = (r) => ((r.stdout || '') + (r.stderr || '')).toLowerCase();

    if (plan.cliAction === 'remove') {
      const r = run(['mcp', 'remove', ENTRY_NAME, '-s', 'user']);
      if (r.status !== 0) {
        const msg = textOf(r);
        if (msg.includes('no mcp server named')) return { ...plan, status: 'absent', changed: false, summary: 'not registered' };
        return { ...plan, status: 'failed', changed: false, summary: msg.trim().split('\n')[0] || client.cli + ' exited ' + r.status };
      }
      return { ...plan, status: 'removed', summary: 'removed via ' + client.cli + ' mcp remove (user scope)' };
    }

    // add 不会覆盖既有条目，所以先删再建；缺条目不是错误。
    run(['mcp', 'remove', ENTRY_NAME, '-s', 'user']);
    // Windows 上子进程经 cmd 拉起，含空格的参数不加引号会被拆开：
    // "C:\Program Files\nodejs\node.exe" 会变成 "C:\Program" + 一个多余参数，
    // 写出来的配置看着没错，客户端却报 CONNECTION_CLOSED。
    const quote = (s) => (IS_WIN && /\s/.test(s) ? '"' + s + '"' : s);
    const envs = [];
    for (const [k, v] of Object.entries(env)) envs.push('-e', k + '=' + v);
    const r = run(['mcp', 'add', ENTRY_NAME, '-s', 'user', ...envs, '--', quote(launch.command), ...launch.args.map(quote)]);
    if (r.status !== 0) {
      return { ...plan, status: 'failed', changed: false, summary: textOf(r).trim().split('\n')[0] || client.cli + ' exited ' + r.status };
    }
    return { ...plan, status: 'applied', summary: 'registered via ' + client.cli + ' mcp add (user scope)' };
  }

  if (typeof plan.next !== 'string') return plan;

  // 只读文件不覆盖：用户把配置设成只读，通常就是不想让程序动它。
  // --force 是显式的「我知道，照做」。
  if (!ctx.force && !isWritable(plan.path)) {
    return {
      ...plan,
      status: 'failed',
      changed: false,
      summary: 'config file is read-only, refusing to overwrite it (use --force to override)',
    };
  }

  // 只读文件默认不覆盖：用户把它设成只读，通常就是不想让程序动它。
  // --force 是显式的「我知道，照做」—— 临时去掉只读位，写完再把权限还回去，
  // 不留一个被悄悄改了属性的文件。
  let originalMode = null;
  if (!isWritable(plan.path)) {
    if (!ctx.force) {
      return {
        ...plan,
        status: 'failed',
        changed: false,
        summary: 'config file is read-only, refusing to overwrite it (use --force to override)',
      };
    }
    try {
      originalMode = statSync(plan.path).mode;
      chmodSync(plan.path, 0o644);
    } catch (e) {
      return { ...plan, status: 'failed', changed: false, summary: 'could not clear the read-only bit: ' + e.message };
    }
  }

  try {
    // 两个方向都备份：注册前备份，是为了「装错了能退回原样」；
    // 删除前同样备份，是为了「删错了还能装回来」。备份内容一律是操作前的原始字节。
    let backup;
    if (existsSync(plan.path)) backup = backupFile(plan.path, stamp);
    mkdirSync(dirname(plan.path), { recursive: true });
    atomicWrite(plan.path, plan.next);
    if (originalMode !== null) {
      try { chmodSync(plan.path, originalMode); } catch { /* 尽力而为 */ }
    }
    const base = {
      ...plan,
      status: remove ? 'removed' : 'applied',
      summary: (remove ? 'entry removed' : 'entry written') + (originalMode !== null ? ' (read-only file overridden by --force)' : ''),
      backup,
    };
    // 有的客户端自己维护这份文件（Claude Code 会缓存并回写 ~/.claude.json）。
    // 有 CLI 时用它做一次只读确认，除了状态行不产生任何副作用。
    if (client.verifyCli && which(client.verifyCli)) {
      const probe = spawnSync(client.verifyCli, ['mcp', 'get', ENTRY_NAME], {
        encoding: 'utf8', shell: IS_WIN, windowsHide: true,
      });
      const registered = probe.status === 0;
      base.summary += registered
        ? ' (confirmed by ' + client.verifyCli + ' mcp get)'
        : ' (note: ' + client.verifyCli + ' mcp get does not see it yet; restart the client)';
    }
    return base;
  } catch (e) {
    if (originalMode !== null) {
      try { chmodSync(plan.path, originalMode); } catch { /* 尽力而为 */ }
    }
    return { ...plan, status: 'failed', changed: false, summary: 'write failed: ' + e.message };
  }
}