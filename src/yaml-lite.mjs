/**
 * 极简 YAML 读写器（只覆盖 DSH profile patch 用到的子集）。
 *
 * 为什么不用 js-yaml：本包承诺**零运行时依赖**，且发布包不带 `runtime/`
 * （见 package.json 的 files 白名单）。首启 bootstrap 只需要读取
 * `cordis.patch.yml` 里的块映射/块序列、引号、注释、null/bool/number
 * 和少量行内 `[]`/`{}`，自己实现比引入一个 YAML 解析器更可控。
 *
 * 明确**不支持**：锚点/别名、多文档合并、复杂标签、跨行 flow 集合、制表符缩进。
 * 遇到不支持的结构会抛错，由调用方决定是跳过还是报错 —— 绝不"猜一个值"。
 *
 * 导出的 API 与 js-yaml 的 load/dump 同名，bootstrap 只需替换 import。
 */

/** 去掉行内注释；引号内的 # 不算注释。 */
function stripComment(s) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** 解析带引号的标量；单引号只处理 '' 转义，双引号优先走 JSON。 */
function parseQuoted(s) {
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return s.slice(1, -1).replace(/''/g, "'");
}

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUES = new Set(['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', 'on', 'On', 'ON']);
const FALSES = new Set(['false', 'False', 'FALSE', 'no', 'No', 'NO', 'off', 'Off', 'OFF']);

/** 标量：引号、null/bool、数字、行内集合、普通字符串。 */
function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (NULLS.has(s)) return null;
  if (TRUES.has(s)) return true;
  if (FALSES.has(s)) return false;
  if (s.startsWith('"') || s.startsWith("'")) {
    if (!(s.endsWith(s[0]) && s.length >= 2)) throw new Error(`引号未闭合: ${s}`);
    return parseQuoted(s);
  }
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s);
  // 标签与锚点：只处理最常见的一层，不展开别名。
  if (s.startsWith('!!')) {
    const sp = s.indexOf(' ');
    return sp < 0 ? null : parseScalar(s.slice(sp + 1));
  }
  if (s.startsWith('&')) {
    const sp = s.indexOf(' ');
    return sp < 0 ? null : parseScalar(s.slice(sp + 1));
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) {
    // 保留前导 0（例如 08）为字符串，避免 YAML 1.1 的八进制歧义。
    if (!/^[-+]?0\d/.test(s)) return Number(s);
  }
  return s;
}

/** 行内 flow 集合：`[a, b]` / `{k: v}`，支持嵌套与引号。 */
function parseFlow(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const readQuoted = () => {
    const q = text[i];
    let j = i + 1;
    let escaped = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (q === "'") {
        if (c === "'") {
          if (text[j + 1] === "'") j++;
          else break;
        }
      } else if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') break;
    }
    if (j >= text.length) throw new Error(`flow 集合里的引号未闭合: ${text}`);
    const out = parseQuoted(text.slice(i, j + 1));
    i = j + 1;
    return out;
  };
  const readKey = () => {
    ws();
    if (text[i] === '"' || text[i] === "'") return readQuoted();
    const start = i;
    while (i < text.length && text[i] !== ':') i++;
    return text.slice(start, i).trim();
  };
  const value = () => {
    ws();
    if (i >= text.length) throw new Error(`flow 集合不完整: ${text}`);
    if (text[i] === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        throw new Error(`flow 数组缺少 , 或 ]: ${text}`);
      }
    }
    if (text[i] === '{') {
      i++;
      const obj = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        const k = readKey();
        ws();
        if (text[i] !== ':') throw new Error(`flow 对象缺少 : ${text}`);
        i++;
        obj[k] = value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        throw new Error(`flow 对象缺少 , 或 }: ${text}`);
      }
    }
    if (text[i] === '"' || text[i] === "'") return readQuoted();
    const start = i;
    while (i < text.length && !/[,\]}]/.test(text[i])) i++;
    return parseScalar(text.slice(start, i));
  };
  const out = value();
  ws();
  if (i !== text.length) throw new Error(`flow 集合尾部有多余内容: ${text}`);
  return out;
}

/** 找 `key: value` 的分隔冒号（引号外、冒号后是空白或行尾）。 */
function splitKey(text) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      let key = text.slice(0, i).trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = parseQuoted(key);
      }
      return { key, value: text.slice(i + 1).trim() };
    }
  }
  return null;
}

const isSeq = (text) => text === '-' || /^-\s/.test(text);

function parseBlock(tokens, index, indent) {
  if (index >= tokens.length || tokens[index].indent !== indent) {
    throw new Error(`第 ${tokens[index]?.line ?? '?'} 行缩进不一致`);
  }
  return isSeq(tokens[index].text)
    ? parseSequence(tokens, index, indent)
    : parseMapping(tokens, index, indent);
}

function parseSequence(tokens, index, indent) {
  const arr = [];
  let i = index;
  while (i < tokens.length && tokens[i].indent === indent && isSeq(tokens[i].text)) {
    const t = tokens[i];
    const rest = t.text.replace(/^-\s?/, '').trim();
    if (!rest) {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const r = parseBlock(tokens, i + 1, tokens[i + 1].indent);
        arr.push(r.value);
        i = r.next;
      } else {
        arr.push(null);
        i++;
      }
      continue;
    }
    const kv = splitKey(rest);
    if (!kv) {
      arr.push(parseScalar(rest));
      i++;
      continue;
    }
    const obj = {};
    if (kv.value === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const r = parseBlock(tokens, i + 1, tokens[i + 1].indent);
        obj[kv.key] = r.value;
        i = r.next;
      } else {
        obj[kv.key] = null;
        i++;
      }
    } else if (kv.value === '|' || kv.value === '>') {
      const folded = kv.value === '>';
      const parts = [];
      i++;
      while (i < tokens.length && tokens[i].indent > indent) {
        parts.push(tokens[i].text);
        i++;
      }
      obj[kv.key] = parts.join(folded ? ' ' : '\n') + '\n';
      continue;
    } else {
      obj[kv.key] = parseScalar(kv.value);
      i++;
    }
    // `- key: value` 后面的同项字段（缩进大于序列缩进）属于同一个对象。
    if (i < tokens.length && tokens[i].indent > indent && !isSeq(tokens[i].text)) {
      const r = parseMapping(tokens, i, tokens[i].indent);
      Object.assign(obj, r.value);
      i = r.next;
    }
    arr.push(obj);
  }
  return { value: arr, next: i };
}

function parseMapping(tokens, index, indent) {
  const obj = {};
  let i = index;
  while (i < tokens.length && tokens[i].indent === indent && !isSeq(tokens[i].text)) {
    const t = tokens[i];
    const kv = splitKey(t.text);
    if (!kv) throw new Error(`第 ${t.line} 行不是 key: value：${t.text}`);
    if (kv.value === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const r = parseBlock(tokens, i + 1, tokens[i + 1].indent);
        obj[kv.key] = r.value;
        i = r.next;
      } else {
        obj[kv.key] = null;
        i++;
      }
    } else if (kv.value === '|' || kv.value === '>') {
      const folded = kv.value === '>';
      const parts = [];
      i++;
      while (i < tokens.length && tokens[i].indent > indent) {
        parts.push(tokens[i].text);
        i++;
      }
      obj[kv.key] = parts.join(folded ? ' ' : '\n') + '\n';
    } else {
      obj[kv.key] = parseScalar(kv.value);
      i++;
    }
  }
  return { value: obj, next: i };
}

/**
 * 解析一个 YAML 文档。
 * @param {string} text
 * @returns {any}
 */
export function load(text) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/);
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(?:#.*)?$/.test(raw)) continue;
    if (/^\s*(?:---|\.\.\.)\s*(?:#.*)?$/.test(raw)) {
      // 只支持单文档；遇到第二个文档分隔符就停止（DSH patch 只有一个文档）。
      if (tokens.length) break;
      continue;
    }
    if (/^\s*%/.test(raw)) continue;
    const indentText = raw.match(/^[ \t]*/)[0];
    if (indentText.includes('\t')) {
      throw new Error(`第 ${i + 1} 行使用了制表符缩进（YAML 不允许）`);
    }
    const content = stripComment(raw.slice(indentText.length)).trimEnd();
    if (!content) continue;
    tokens.push({ indent: indentText.length, text: content, line: i + 1 });
  }
  if (!tokens.length) return null;
  const r = parseBlock(tokens, 0, tokens[0].indent);
  if (r.next !== tokens.length) {
    throw new Error(`第 ${tokens[r.next]?.line ?? '?'} 行无法归入任何结构`);
  }
  return r.value;
}

const RESERVED = new Set([
  'null', 'Null', 'NULL', '~', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO', 'on', 'On', 'ON', 'off', 'Off', 'OFF',
]);

/** 键名尽量保持可读；含特殊字符时用 JSON 字符串。 */
function dumpKey(k) {
  const s = String(k);
  if (/^[A-Za-z0-9_.-]+$/.test(s) && !RESERVED.has(s) && !/^[-+]?\d/.test(s)) return s;
  return JSON.stringify(s);
}

/** 标量：简单标识符/URL 用裸串，其余用 JSON 双引号（YAML 兼容）。 */
function dumpScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (
    s &&
    !/^\s|\s$/.test(s) &&
    !RESERVED.has(s) &&
    !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s) &&
    /^[A-Za-z0-9_./:@+-]+$/.test(s) &&
    !/^[@`%&*!|>'"#]/.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function dumpNode(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]`;
    return v
      .map((item) => {
        if (!Array.isArray(item) && !isPlainObject(item)) return `${pad}- ${dumpScalar(item)}`;
        if (Array.isArray(item)) return `${pad}-\n${dumpNode(item, indent + 2)}`;
        const entries = Object.entries(item);
        if (!entries.length) return `${pad}- {}`;
        const [k, val] = entries[0];
        let out = isPlainObject(val) || Array.isArray(val)
          ? `${pad}- ${dumpKey(k)}:\n${dumpNode(val, indent + 4)}`
          : `${pad}- ${dumpKey(k)}: ${dumpScalar(val)}`;
        for (const [k2, v2] of entries.slice(1)) {
          out += isPlainObject(v2) || Array.isArray(v2)
            ? `\n${pad}  ${dumpKey(k2)}:\n${dumpNode(v2, indent + 4)}`
            : `\n${pad}  ${dumpKey(k2)}: ${dumpScalar(v2)}`;
        }
        return out;
      })
      .join('\n');
  }
  if (isPlainObject(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return `${pad}{}`;
    return entries
      .map(([k, val]) =>
        isPlainObject(val) || Array.isArray(val)
          ? `${pad}${dumpKey(k)}:\n${dumpNode(val, indent + 2)}`
          : `${pad}${dumpKey(k)}: ${dumpScalar(val)}`,
      )
      .join('\n');
  }
  return `${pad}${dumpScalar(v)}`;
}

/** 序列化为块风格 YAML（根节点为数组/对象时）。 */
export function dump(value) {
  return dumpNode(value, 0) + '\n';
}
