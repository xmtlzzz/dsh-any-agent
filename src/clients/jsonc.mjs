/**
 * JSON / JSONC 文本级定点编辑引擎：保留注释、缩进、键顺序、行尾与 BOM。
 */

import { ENTRY_NAME, managedEnvKey } from './io.mjs';

const NL = String.fromCharCode(10);
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * 把 JSON/JSONC 文本扫成带 [start, end) 字符区间的节点树。
 * 不构造值对象（除 key 字符串外），因此大文件或大小写重复键都能安全扫描。
 */
export function scanJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    throw Object.assign(new Error(msg + ' at offset ' + i), { code: 'EJSONSCAN' });
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
    while (i < n && !isWs(text[i]) && !',}]/'.includes(text[i])) i++;
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
      skipTrivia();
      entries.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value, comma: text[i] === ',' ? i : null });
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

function leadingWsOfLine(text, pos) {
  let s = pos;
  while (s > 0 && text[s - 1] !== '\n' && text[s - 1] !== '\r') s--;
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

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

/** 探测根对象最浅一层键的缩进单位（2 空格 / 4 空格 / Tab）。 */
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

/** 把值渲染成 JSON 文本，并按目标缩进补齐后续行。 */
export function renderValue(value, { unit, eol, indent }) {
  const raw = JSON.stringify(value, null, unit);
  if (!raw.includes('\n')) return raw;
  return raw.replace(/\n/g, eol + indent);
}

function indexOfEntry(obj, key) {
  return obj.entries.findIndex((e) => e.key === key);
}

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

function removeKey(text, obj, key) {
  const idx = indexOfEntry(obj, key);
  if (idx < 0) return null;
  const entry = obj.entries[idx];

  if (obj.entries.length === 1) {
    const slice = text.slice(obj.start, obj.end);
    const before = text.slice(obj.start + 1, entry.keyStart);
    const after = text.slice(entry.value.end, obj.end - 1);
    if (/\/[/*]/.test(before + after)) {
      const tail = entry.comma === null ? text.slice(entry.value.end)
        : text.slice(entry.value.end, entry.comma) + text.slice(entry.comma + 1);
      return text.slice(0, entry.keyStart) + tail;
    }
    const eol = detectEol(text);
    if (!slice.includes('\n')) return text.slice(0, obj.start) + '{}' + text.slice(obj.end);
    const baseIndent = leadingWsOfLine(text, obj.start);
    return text.slice(0, obj.start) + '{' + eol + baseIndent + '}' + text.slice(obj.end);
  }

  const start = entry.keyStart;
  if (idx > 0) {
    const p = obj.entries[idx - 1].comma;
    const trivia = text.slice(p + 1, start);
    let e = entry.value.end;
    while (e < obj.end && (text[e] === ' ' || text[e] === '\t')) e++;
    return text.slice(0, p) + (trivia.trim() ? trivia : '') + text.slice(e);
  }

  const trivia = text.slice(entry.value.end, entry.comma);
  let end = entry.comma + 1;
  while (end < obj.end && (text[end] === ' ' || text[end] === '\t')) end++;
  return text.slice(0, start) + (trivia.trim() ? trivia : '') + text.slice(end);
}

function dropContainerIfEmpty(text, containerKey) {
  let root;
  try { root = scanJson(text); } catch { return text; }
  const idx = indexOfEntry(root, containerKey);
  if (idx < 0) return text;
  const cont = root.entries[idx];
  if (cont.value.type !== 'object' || cont.value.entries.length !== 0) return text;
  if (/\/[/*]/.test(text.slice(cont.value.start, cont.value.end))) return text;
  const without = removeKey(text, root, containerKey);
  if (without === null) return text;
  try { scanJson(without); } catch { return text; }
  return without;
}

function assertUniqueKey(obj, key) {
  if (obj.entries.filter((e) => e.key === key).length > 1) {
    throw new Error('"' + key + '" appears more than once in this config; remove the duplicates first');
  }
}

function jsonProperty(object, key) {
  if (object.type !== 'object') throw new Error('expected an object containing ' + key);
  assertUniqueKey(object, key);
  return object.entries[indexOfEntry(object, key)];
}

function sameJsonArgs(node, args) {
  return node.items.length === args.length && node.items.every((item, i) => item.value === args[i]);
}

function editJsonEntryBody(text, containerKey, entryKey, value, options) {
  const eol = detectEol(text);
  const root = scanJson(text);
  if (root.type !== 'object') throw new Error('the top level of this config is not a JSON object');

  const unit = detectIndentUnit(text, root) ?? '  ';
  assertUniqueKey(root, containerKey);
  const contIdx = indexOfEntry(root, containerKey);
  if (contIdx >= 0 && root.entries[contIdx].value.type === 'object') assertUniqueKey(root.entries[contIdx].value, entryKey);

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
      if (options.preserveEnvFor && existing.value.type === 'object') {
        const shape = options.preserveEnvFor;
        const command = jsonProperty(existing.value, 'command')?.value;
        const owner = shape === 'zed' && command?.type === 'object' ? command : existing.value;
        const envKey = shape === 'opencode' ? 'environment' : 'env';
        const old = jsonProperty(owner, envKey)?.value ?? (shape === 'opencode' && jsonProperty(owner, 'env')?.value);
        if (old) {
          if (old.type !== 'object') throw new Error('expected an environment object; use --reset-env to replace it');
          const custom = old.entries.filter(({ key }) =>
            !managedEnvKey(key, { replaceBin: options.replaceBin, replaceDaemon: options.replaceDaemon }));
          const destination = shape === 'zed' && typeof value.command === 'object' ? value.command : value;
          for (const { key, value: item } of custom) {
            assertUniqueKey(old, key);
            if (item.type !== 'string') throw new Error('custom environment values must be strings; use --reset-env to replace them');
          }
          destination[envKey] = { ...destination[envKey], ...Object.fromEntries(custom.map(e => [e.key, e.value.value])) };
        }
      }
      const currentText = text.slice(existing.value.start, existing.value.end);
      const indent = lineIndentBefore(text, existing.keyStart);
      const compact = indent === null || !text.slice(cont.value.start, cont.value.end).includes(NL);
      const desired = compact ? JSON.stringify(value) : renderValue(value, { unit, eol, indent });
      if (stripWs(currentText) === stripWs(desired)) return { changed: false, text };
      return { changed: true, text: replaceValue(text, existing, desired) };
    }
    const indent = leadingWsOfLine(text, cont.keyStart);
    const childIndent = indent + unit;
    const compact = !text.slice(cont.value.start, cont.value.end).includes(NL);
    const rendered = compact ? JSON.stringify(value) : renderValue(value, { unit, eol, indent: childIndent });
    return { changed: true, text: insertKey(text, cont.value, entryKey, rendered, { unit, eol }) };
  }

  const indent = leadingWsOfLine(text, root.start);
  const contIndent = indent + unit;
  const compact = !text.includes('\n');
  const renderedCont = compact
    ? JSON.stringify({ [entryKey]: value })
    : renderValue({ [entryKey]: value }, { unit, eol, indent: contIndent });
  return { changed: true, text: insertKey(text, root, containerKey, renderedCont, { unit, eol }) };
}

/** 在 JSON/JSONC 文本里设置（value 为 null 时删除）containerKey -> entryKey 这一条。 */
export function editJsonEntry(rawText, containerKey, entryKey, value, options = {}) {
  const bom = rawText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = bom ? rawText.slice(1) : rawText;
  const result = editJsonEntryBody(text, containerKey, entryKey, value, options);
  if (result.changed) scanJson(result.text);
  return { changed: result.changed, text: bom + result.text };
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

/** 只更新已有 JSON 条目的启动命令与参数，保留注释、环境变量和其它字段。 */
export function repairJsonLaunch(text, client, launch) {
  const root = scanJson(text);
  const container = jsonProperty(root, client.containerKey)?.value;
  const entry = container && jsonProperty(container, ENTRY_NAME)?.value;
  if (!entry) return null;
  const topCommand = jsonProperty(entry, 'command');
  const nested = client.shape === 'zed' && topCommand?.value.type === 'object';
  const owner = nested ? topCommand.value : entry;
  const command = nested ? jsonProperty(owner, 'path') : topCommand;
  if (client.shape === 'opencode') {
    if (command?.value.type !== 'array' || command.value.items[0]?.type !== 'string') {
      throw new Error('an existing local command array is required');
    }
    const argv = [launch.command, ...launch.args];
    return sameJsonArgs(command.value, argv) ? text : replaceValue(text, command, JSON.stringify(argv));
  }
  if (command?.value.type !== 'string') throw new Error('an existing stdio command is required');
  const args = jsonProperty(owner, 'args');
  if (args && args.value.type !== 'array') throw new Error('the existing args must be an array');
  let next = text;
  if (!args && launch.args.length) {
    next = insertKey(text, owner, 'args', JSON.stringify(launch.args), {
      eol: detectEol(text),
      unit: detectIndentUnit(text, root) ?? '  ',
    });
  }
  const fields = [];
  if (command.value.value !== launch.command) fields.push([command, launch.command]);
  if (args && !sameJsonArgs(args.value, launch.args)) fields.push([args, launch.args]);
  for (const [field, value] of fields.sort((a, b) => b[0].value.start - a[0].value.start)) {
    next = replaceValue(next, field, JSON.stringify(value));
  }
  return next;
}
