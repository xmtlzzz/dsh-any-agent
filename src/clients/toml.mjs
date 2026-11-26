/**
 * Codex TOML（config.toml）行级编辑与启动路径修复：保留注释、顶层键、其它表与行尾。
 */

import { ENTRY_NAME, IS_WIN, managedEnvKey } from './io.mjs';
import { detectEol, stripWs } from './jsonc.mjs';

const TOML_STRING = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;
const TOML_KEY = `(?:[A-Za-z0-9_-]+|${TOML_STRING})`;
const TOML_TABLE_NAME = String.raw`${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*`;
const TOML_HEADER = new RegExp(String.raw`^\s*\[\s*(${TOML_TABLE_NAME})\s*\]\s*(?:#.*)?$`);
const TOML_ARRAY_HEADER = new RegExp(String.raw`^\s*\[\[\s*(${TOML_TABLE_NAME})\s*\]\]\s*(?:#.*)?$`);
const TOML_ASSIGNMENT = new RegExp('^\\s*(' + TOML_TABLE_NAME + ')\\s*=');
const COMMENT_OR_BLANK = /^\s*(?:#.*)?$/;

function multilineMask(lines) {
  const mask = new Array(lines.length);
  let open = null;
  for (let k = 0; k < lines.length; k++) {
    mask[k] = open !== null;
    const s = lines[k];
    let i = 0;
    while (i < s.length) {
      if (open) {
        if (open === '"""' && s[i] === '\\') { i += 2; continue; }
        if (s.startsWith(open, i)) {
          i += 3;
          for (let extra = 0; extra < 2 && s[i] === open[0]; extra++) i++;
          open = null;
          continue;
        }
        i++;
        continue;
      }
      if (s[i] === '#') break;
      if (s.startsWith('"""', i) || s.startsWith("'''", i)) { open = s.slice(i, i + 3); i += 3; continue; }
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        let j = i + 1;
        while (j < s.length && s[j] !== q) j += q === '"' && s[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      i++;
    }
  }
  return mask;
}

function tomlKeys(name) {
  return name.match(new RegExp(TOML_KEY, 'g')).map((key) => {
    if (key.startsWith("'")) return key.slice(1, -1);
    if (!key.startsWith('"')) return key;
    return key.slice(1, -1).replace(/\\(?:u([\da-fA-F]{4})|U([\da-fA-F]{8})|(.))/g,
      (escape, short, long, char) => {
        if (char) return char === '\\' || char === '"' ? char : escape;
        const code = parseInt(short ?? long, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
      });
  });
}

function findTomlRanges(lines) {
  /** @type {Array<{start: number, end: number, main?: boolean, env?: boolean, envChild?: boolean, inline?: boolean}>} */
  const ranges = [];
  const mask = multilineMask(lines);
  let cur = null;
  let unsupported = null;
  let table = [];
  const close = (k) => {
    let end = k;
    while (end > cur.start + 1 && !mask[end - 1] && COMMENT_OR_BLANK.test(lines[end - 1])) end--;
    cur.end = end;
    ranges.push(cur);
    cur = null;
  };
  for (let k = 0; k < lines.length; k++) {
    if (mask[k]) continue;
    const arr = TOML_ARRAY_HEADER.exec(lines[k]);
    const m = arr ? null : TOML_HEADER.exec(lines[k]);
    if (arr || m) {
      if (cur) close(k);
      table = tomlKeys((arr ?? m)[1]);
      if (table[0] === 'mcp_servers' && table[1] === ENTRY_NAME) {
        if (arr) unsupported ??= 'array table on line ' + (k + 1);
        else cur = { start: k, end: lines.length, main: table.length === 2, env: table.length === 3 && table[2] === 'env', envChild: table.length > 3 && table[2] === 'env' };
      }
      if (arr) table = null;
      continue;
    }
    if (!table || table.length > 1 || (table.length && table[0] !== 'mcp_servers')) continue;
    const field = TOML_ASSIGNMENT.exec(lines[k]);
    if (!field) continue;
    const path = [...table, ...tomlKeys(field[1])];
    if (path[0] !== 'mcp_servers') continue;
    if (table.length === 1 && path.length === 2 && path[1] === ENTRY_NAME) {
      ranges.push({ start: k, end: k + 1, inline: true });
    } else if (path[1] === ENTRY_NAME) unsupported ??= 'dotted key on line ' + (k + 1);
    else if (path.length === 1) unsupported ??= 'inline mcp_servers table on line ' + (k + 1);
  }
  if (cur) close(lines.length);
  return { ranges, unsupported };
}

function trimRanges(lines, ranges) {
  return ranges.map((r) => {
    let { start, end } = r;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    if (!r.inline && start > 0 && lines[start - 1].trim() === '') start -= 1;
    return { start, end };
  }).sort((a, b) => b.start - a.start);
}

function inlineTomlFields(raw) {
  const first = raw.indexOf('{');
  if (first < 0 || raw.slice(0, first).trim()) throw new Error('expected an inline TOML environment; use --repair or --reset-env');
  let start = first + 1;
  let depth = 0;
  const fields = [];
  for (const token of raw.slice(start).matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[{},[\]#]/g)) {
    const symbol = token[0];
    const index = first + 1 + token.index;
    if (symbol === '#' || (symbol === ']' && depth === 0)) break;
    if (!depth && (symbol === ',' || symbol === '}')) {
      const field = raw.slice(start, index).trim();
      if (field) {
        const match = TOML_ASSIGNMENT.exec(field);
        if (!match) break;
        fields.push({ keys: tomlKeys(match[1]), raw: field, value: field.slice(match[0].length) });
      }
      if (symbol === '}') return fields;
      start = index + 1;
    } else if (symbol === '[' || symbol === '{') depth++;
    else if (symbol === ']' || symbol === '}') depth--;
  }
  throw new Error('cannot preserve the inline TOML environment; use --repair or --reset-env');
}

function assertTomlEnvString(value, allowMultiline = false) {
  if (allowMultiline && /^\s*(?:"""|''')/.test(value)) return;
  if (!/^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.test(value)) {
    throw new Error('expected a string for the TOML environment key; use --repair or --reset-env');
  }
}

function copyTomlEnv(block, lines, ranges, envPolicy) {
  const mask = multilineMask(lines);
  const envStart = block.findIndex((l) => l.trim() === `[mcp_servers.${ENTRY_NAME}.env]`);
  const upsert = (key, raw) => {
    const norm = IS_WIN ? key.toUpperCase() : key;
    const idx = envStart >= 0
      ? block.findIndex((line, pos) => {
        if (pos <= envStart) return false;
        const m = TOML_ASSIGNMENT.exec(line);
        if (!m) return false;
        const ks = tomlKeys(m[1]);
        return ks.length === 1 && (IS_WIN ? ks[0].toUpperCase() : ks[0]) === norm;
      })
      : -1;
    if (idx >= 0) block[idx] = raw;
    else block.push(raw);
  };
  const copy = (key, raw, value) => {
    if (managedEnvKey(key, envPolicy)) return;
    assertTomlEnvString(value);
    upsert(key, raw);
  };
  const copyField = ({ keys, value }) => {
    if (keys[0] !== 'env') return;
    if (keys.length === 2) {
      return copy(keys[1], JSON.stringify(keys[1]) + ' = ' + value.trim(), value);
    }
    if (keys.length !== 1) throw new Error('nested TOML environment; use --repair or --reset-env');
    for (const entry of inlineTomlFields(value)) {
      if (entry.keys.length !== 1) throw new Error('nested TOML environment; use --repair or --reset-env');
      copy(entry.keys[0], entry.raw, entry.value);
    }
  };
  for (const r of ranges) {
    if (r.envChild) throw new Error('nested TOML environment; use --repair or --reset-env');
    if (r.inline) {
      const row = lines[r.start];
      inlineTomlFields(row.slice(TOML_ASSIGNMENT.exec(row)[0].length)).forEach(copyField);
      continue;
    }
    let keep = false;
    let activeKey = null;
    for (let i = r.start + 1; i < r.end; i++) {
      const field = !mask[i] && TOML_ASSIGNMENT.exec(lines[i]);
      if (field) {
        const keys = tomlKeys(field[1]);
        if (r.main && keys[0] === 'env') {
          if (mask[i + 1]) throw new Error('multiline dotted TOML environment; use --repair or --reset-env');
          copyField({ keys, value: lines[i].slice(field[0].length) });
        }
        if (r.env && keys.length !== 1) throw new Error('nested TOML environment; use --repair or --reset-env');
        keep = r.env && !managedEnvKey(keys[0], envPolicy);
        activeKey = keep ? keys[0] : null;
        if (keep) {
          assertTomlEnvString(lines[i].slice(field[0].length), true);
          upsert(activeKey, lines[i]);
          continue;
        }
      }
      if (r.env && keep) block.push(lines[i]);
    }
  }
}

/** 在 Codex 的 config.toml 里写入或删除我们的表（block 为 null 表示删除）。 */
export function editTomlBlock(text, block, { preserveEnv = false, replaceBin = false, replaceDaemon = true } = {}) {
  const eol = detectEol(text);
  const trailing = (text.match(/(?:\r?\n)+$/) || [''])[0];
  const body = trailing ? text.slice(0, text.length - trailing.length) : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);

  const { ranges, unsupported } = findTomlRanges(lines);
  if (unsupported) {
    throw new Error(
      'the existing ' + ENTRY_NAME + ' entry uses a TOML form setup cannot edit safely (' + unsupported +
        '); file left untouched, edit it by hand',
    );
  }
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
    if (preserveEnv) copyTomlEnv(blockLines, lines, ranges, { replaceBin, replaceDaemon });
    const keyLines = (ls) => ls.filter((l) => !COMMENT_OR_BLANK.test(l));
    const current = ranges.flatMap((r) => lines.slice(r.start, r.end));
    if (keyLines(current).join('\n') === keyLines(blockLines).join('\n')) {
      return { changed: false, text };
    }
  }

  const kept = lines.slice();
  for (const r of trimRanges(kept, ranges)) kept.splice(r.start, r.end - r.start);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const out = finish(kept.length ? kept.concat([''], blockLines) : blockLines.slice());
  return { changed: true, text: out };
}

const TOML_LAUNCH_FIELD = /^(\s*(?:"(command|args)"|'(command|args)'|(command|args))\s*=\s*)(.*)$/;
const TOML_LAUNCH_VALUE = {
  command: new RegExp('^(' + TOML_STRING + ')(\\s*(?:#.*)?)$'),
  args: new RegExp('^(\\[\\s*(?:' + TOML_STRING + '\\s*,\\s*)*(?:' + TOML_STRING + '\\s*)?\\])(\\s*(?:#.*)?)$'),
};

/** 只更新已有 Codex TOML 表的 command 与 args，保留其余设置。 */
export function repairTomlLaunch(text, launch) {
  const lines = text.split(/\r?\n/);
  const eols = text.match(/\r?\n/g) ?? [];
  const { ranges, unsupported } = findTomlRanges(lines);
  if (!ranges.length && !unsupported) return null;
  const tables = ranges.filter((range) => range.main);
  if (unsupported || ranges.some((r) => r.inline) || tables.length !== 1) {
    throw new Error('repair requires one [mcp_servers.dsh-any-agent] table; update custom TOML forms by hand');
  }
  const { start, end } = tables[0];
  const mask = multilineMask(lines);
  const fields = new Map();
  for (let i = start + 1; i < end; i++) {
    if (mask[i]) continue;
    const match = TOML_LAUNCH_FIELD.exec(lines[i]);
    if (!match) continue;
    const [, prefix, quoted, literal, bare, raw] = match;
    const key = quoted ?? literal ?? bare;
    const value = TOML_LAUNCH_VALUE[key].exec(raw);
    if (!value || fields.has(key)) throw new Error('repair requires a single-line ' + key + ' setting with a unique key');
    fields.set(key, i);
    const encoded = JSON.stringify(launch[key]);
    if (stripWs(value[1]) !== encoded) lines[i] = prefix + encoded + value[2];
  }
  if (!fields.has('command')) throw new Error('an existing stdio command is required');
  if (!fields.has('args') && launch.args.length) {
    const row = fields.get('command');
    lines[row] += (eols[row] ?? detectEol(text)) + 'args = ' + JSON.stringify(launch.args);
  }
  return lines.map((line, i) => line + (eols[i] ?? '')).join('');
}
