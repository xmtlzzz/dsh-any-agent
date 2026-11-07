#!/usr/bin/env node
/**
 * 零依赖静态检查：`npm run lint`。
 *
 * 为什么自己写而不是装 ESLint：本项目的底线是零依赖（test/package-check.mjs 强制：
 * 没有 dependencies，也不引入 devDependencies）。这里只查"改文件结构时最容易手滑、
 * 且测试不一定覆盖到"的几类错误 —— 拆模块、挪函数、改导入之后，一个漏掉的导出或
 * 一条没删的导入，在没有真实 DSH 的 CI 上往往要到某条冷路径才炸。
 *
 * 检查项（任何一项有问题就退出码 1）：
 *   1. syntax    对 src/ bin/ scripts/ test/ demo/ 下每个 .mjs 跑 `node --check`；
 *   2. resolve   每个相对路径的 import / export ... from / import('...') 必须指向存在的文件
 *                （大小写也要完全一致：Windows/macOS 默认不区分大小写，只有 Linux CI 才会炸）；
 *   3. exports   具名导入必须是目标模块的导出（含 export { a } from、export * from 的传递）；
 *                `const { a } = await import('./x.mjs')` 解构出来的名字同样检查；
 *                node:fs 这类内置模块的具名导入也对照当前 Node 实际导出检查；
 *   4. unused    没有被用到的具名导入（import { a, b } 里的 a 或 b）。
 *
 * 实现是静态词法扫描，不是完整的 JS 解析器：先把注释 / 字符串 / 正则 / 模板字符串里的
 * 纯文本剔掉，再在 token 流上识别 import / export 语句。取舍是宁可漏报也不误报 ——
 * 例如被内层同名参数遮蔽的未用导入会漏掉，但不会把真正在用的导入报成未用。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--root <dir>` 只给 test/lint.mjs 用：在临时目录里造一棵有问题的树，验证每条规则真的会报。
const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag > 0 && process.argv[rootFlag + 1]
    ? resolve(process.argv[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'bin', 'scripts', 'test', 'demo'];
const CHECK_CONCURRENCY = 8;

// ── 词法扫描 ──────────────────────────────────────────────────────

const ID_START = /[\p{L}_$]/u;
const ID_PART = /[\p{L}\p{N}_$\u200c\u200d]/u;
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+n?|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/;
/** 这些关键字后面的 `/` 是正则的开头，不是除号。 */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof',
]);

/**
 * 把源码切成 token：`{ type: 'id' | 'str' | 'punct' | 'num' | 'tpl', value, line }`。
 * 注释丢弃；字符串保留内容（import 的路径要用）；模板字符串只保留 `${ }` 里的代码，
 * 静态文本丢弃 —— 否则模板里写的 "import {" 之类文字会被当成语句。
 */
export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  /** 正在读的模板字符串里，`${` 之后的花括号深度（用来找到配对的 `}`）。 */
  const tplStack = [];

  const push = (type, value, startLine = line) => tokens.push({ type, value, line: startLine });

  // 读模板字符串的静态部分，直到结束的反引号或下一个 `${`
  const readTemplate = () => {
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        tplStack.push({ depth: 0 });
        return;
      }
      if (ch === '\n') line++;
      i++;
    }
  };

  if (src.startsWith('#!')) while (i < n && src[i] !== '\n') i++;

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\ufeff' || /\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          if (src[j + 1] === '\n') line++;
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      push('str', value, startLine);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      push('tpl', '', line);
      i++;
      readTemplate();
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    const numMatch = /[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? '')) ? NUMBER.exec(src.slice(i, i + 80)) : null;
    if (numMatch) {
      push('num', numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    if (c === '/') {
      const prev = tokens[tokens.length - 1];
      const startsRegex =
        !prev ||
        (prev.type === 'punct' && !')]}'.includes(prev.value)) ||
        (prev.type === 'id' && REGEX_AFTER_KEYWORD.has(prev.value));
      if (startsRegex) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          j++;
          while (j < n && ID_PART.test(src[j])) j++;
          push('num', 'regex');
          i = j;
          continue;
        }
      }
    }
    // 标点：只需要区分少数多字符形式
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1].depth === 0) {
      tplStack.pop();
      i++;
      readTemplate();
      continue;
    }
    if (tplStack.length) {
      const top = tplStack[tplStack.length - 1];
      if (c === '{') top.depth++;
      else if (c === '}') top.depth--;
    }
    if (src.startsWith('...', i)) {
      push('punct', '...');
      i += 3;
    } else if (src.startsWith('=>', i)) {
      push('punct', '=>');
      i += 2;
    } else if (src.startsWith('?.', i) && !/[0-9]/.test(src[i + 2] ?? '')) {
      push('punct', '?.');
      i += 2;
    } else {
      push('punct', c);
      i++;
    }
  }
  return tokens;
}

// ── import / export 识别 ─────────────────────────────────────────

const isId = (t, v) => t && t.type === 'id' && (v === undefined || t.value === v);
const isPunct = (t, v) => t && t.type === 'punct' && t.value === v;

/** 读 `{ a, b as c, default as d }` 形式的说明符列表；返回 [说明符, 下一个下标]。 */
function readSpecifiers(tokens, start) {
  // tokens[start] 必须是 '{'
  const specs = [];
  let j = start + 1;
  while (j < tokens.length && !isPunct(tokens[j], '}')) {
    const first = tokens[j];
    if (first.type === 'id' || first.type === 'str') {
      let local = first.value;
      let line = first.line;
      if (isId(tokens[j + 1], 'as') && tokens[j + 2]) {
        local = tokens[j + 2].value;
        j += 2;
      }
      specs.push({ imported: first.value, local, line });
    }
    j++;
  }
  return [specs, j + 1];
}

/**
 * 从 token 流里抽出模块的结构：静态导入、重新导出、本地导出、动态导入，
 * 以及"不算作使用"的 token 区间（导入语句本身、`export ... from` 语句）。
 */
export function parseModule(src) {
  const tokens = tokenize(src);
  const mod = {
    tokens,
    imports: [],
    reExports: [],
    exports: new Set(),
    /** 导出表不完整（出现了解构导出之类无法静态列全的写法）。 */
    openExports: false,
    dynamicImports: [],
    excluded: new Set(),
  };
  const exclude = (a, b) => {
    for (let k = a; k <= b; k++) mod.excluded.add(k);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'id') continue;
    const prev = tokens[i - 1];
    if (isPunct(prev, '.') || isPunct(prev, '?.')) continue;

    if (t.value === 'import') {
      const next = tokens[i + 1];
      if (isPunct(next, '(')) {
        // 动态导入：只处理字面量路径；若是 `const { a, b } = await import(...)`，把解构名字一并取出
        if (tokens[i + 2]?.type === 'str' && isPunct(tokens[i + 3], ')')) {
          const rec = { spec: tokens[i + 2].value, line: t.line, names: null };
          let k = i - 1;
          if (isId(tokens[k], 'await')) k--;
          if (isPunct(tokens[k], '=') && isPunct(tokens[k - 1], '}')) {
            let depth = 0;
            let open = k - 1;
            for (; open >= 0; open--) {
              if (isPunct(tokens[open], '}')) depth++;
              else if (isPunct(tokens[open], '{') && --depth === 0) break;
            }
            if (open > 0 && ['const', 'let', 'var'].includes(tokens[open - 1]?.value)) {
              rec.names = [];
              let d = 0;
              let expectKey = true;
              for (let m = open + 1; m < k - 1; m++) {
                const x = tokens[m];
                if (isPunct(x, '{') || isPunct(x, '[') || isPunct(x, '(')) d++;
                else if (isPunct(x, '}') || isPunct(x, ']') || isPunct(x, ')')) d--;
                else if (d === 0 && isPunct(x, ',')) expectKey = true;
                else if (d === 0 && expectKey) {
                  if (isPunct(x, '...')) {
                    expectKey = false;
                  } else if (x.type === 'id' || x.type === 'str') {
                    rec.names.push({ imported: x.value, line: x.line });
                    expectKey = false;
                  }
                }
              }
            }
          }
          mod.dynamicImports.push(rec);
        }
        continue;
      }
      if (isPunct(next, '.')) continue; // import.meta
      // 静态导入
      const rec = { spec: null, line: t.line, defaultLocal: null, nsLocal: null, names: [] };
      let j = i + 1;
      if (tokens[j]?.type === 'str') {
        rec.spec = tokens[j].value;
      } else {
        while (j < tokens.length && !isId(tokens[j], 'from')) {
          const x = tokens[j];
          if (isPunct(x, '{')) {
            const [specs, nextJ] = readSpecifiers(tokens, j);
            rec.names.push(...specs);
            j = nextJ;
            continue;
          }
          if (isPunct(x, '*')) {
            rec.nsLocal = tokens[j + 2]?.value ?? null;
            j += 3;
            continue;
          }
          if (x.type === 'id' && !rec.defaultLocal) rec.defaultLocal = { local: x.value, line: x.line };
          j++;
        }
        if (tokens[j + 1]?.type === 'str') {
          rec.spec = tokens[j + 1].value;
          j += 1;
        }
      }
      if (rec.spec === null) continue;
      // import attributes: with { type: 'json' }
      if ((isId(tokens[j + 1], 'with') || isId(tokens[j + 1], 'assert')) && isPunct(tokens[j + 2], '{')) {
        j += 2;
        while (j < tokens.length && !isPunct(tokens[j], '}')) j++;
      }
      exclude(i, j);
      mod.imports.push(rec);
      i = j;
      continue;
    }

    if (t.value === 'export') {
      const next = tokens[i + 1];
      if (isPunct(next, '{')) {
        const [specs, afterJ] = readSpecifiers(tokens, i + 1);
        if (isId(tokens[afterJ], 'from') && tokens[afterJ + 1]?.type === 'str') {
          mod.reExports.push({ spec: tokens[afterJ + 1].value, line: t.line, star: false, names: specs });
          exclude(i, afterJ + 1);
          i = afterJ + 1;
        } else {
          for (const s of specs) mod.exports.add(s.local === s.imported ? s.imported : s.local);
          i = afterJ - 1;
        }
        continue;
      }
      if (isPunct(next, '*')) {
        // export * from 'x'  /  export * as ns from 'x'
        let j = i + 2;
        let ns = null;
        if (isId(tokens[j], 'as')) {
          ns = tokens[j + 1]?.value ?? null;
          j += 2;
        }
        if (isId(tokens[j], 'from') && tokens[j + 1]?.type === 'str') {
          if (ns) mod.exports.add(ns);
          mod.reExports.push({ spec: tokens[j + 1].value, line: t.line, star: !ns, names: [] });
          exclude(i, j + 1);
          i = j + 1;
        }
        continue;
      }
      if (isId(next, 'default')) {
        mod.exports.add('default');
        continue;
      }
      let j = i + 1;
      if (isId(tokens[j], 'async')) j++;
      if (isId(tokens[j], 'function')) {
        j++;
        if (isPunct(tokens[j], '*')) j++;
        if (tokens[j]?.type === 'id') mod.exports.add(tokens[j].value);
        continue;
      }
      if (isId(tokens[j], 'class')) {
        if (tokens[j + 1]?.type === 'id') mod.exports.add(tokens[j + 1].value);
        continue;
      }
      if (['const', 'let', 'var'].includes(tokens[j]?.value)) {
        const name = tokens[j + 1];
        if (name?.type === 'id') mod.exports.add(name.value);
        else mod.openExports = true; // export const { a, b } = ... 这类，无法静态列全
        continue;
      }
    }
  }
  return mod;
}

// ── 解析与校验 ────────────────────────────────────────────────────

const parsed = new Map();
function getModule(file) {
  if (!parsed.has(file)) parsed.set(file, parseModule(readFileSync(file, 'utf8')));
  return parsed.get(file);
}

const rel = (file) => relative(ROOT, file).split('\\').join('/');

/** 文件存在且大小写完全一致（最后一段）；目录不算（ESM 不会自动补 index）。 */
function existsExact(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    return readdirSync(dirname(file)).includes(file.slice(dirname(file).length + 1));
  } catch {
    return false;
  }
}

const isScript = (file) => /\.(mjs|js)$/.test(file);

/** 模块导出的全部名字（沿 export * / export { } from 传递）；`open` 表示列不全，不要据此判缺失。 */
function exportsOf(file, seen = new Set()) {
  const out = { names: new Set(), open: false };
  if (seen.has(file)) return out;
  seen.add(file);
  const mod = getModule(file);
  for (const n of mod.exports) out.names.add(n);
  if (mod.openExports) out.open = true;
  for (const re of mod.reExports) {
    if (!re.spec.startsWith('.')) {
      out.open = true;
      continue;
    }
    const target = resolve(dirname(file), re.spec);
    if (re.star) {
      if (!existsExact(target) || !isScript(target)) {
        out.open = true;
        continue;
      }
      const inner = exportsOf(target, seen);
      for (const n of inner.names) if (n !== 'default') out.names.add(n);
      if (inner.open) out.open = true;
    } else {
      for (const s of re.names) out.names.add(s.local);
    }
  }
  return out;
}

const builtinExports = new Map();
async function builtinNames(spec) {
  if (!builtinExports.has(spec)) {
    try {
      builtinExports.set(spec, new Set(Object.keys(await import(spec))));
    } catch {
      builtinExports.set(spec, null);
    }
  }
  return builtinExports.get(spec);
}
const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec);

/** 检查一个说明符：路径存在、具名导出存在。`names` 为 [{imported, line}]，`wantDefault` 表示要求有 default。 */
async function checkTarget(file, spec, line, names, wantDefault, problems) {
  const where = `${rel(file)}:${line}`;
  if (isBuiltin(spec)) {
    const have = await builtinNames(spec);
    if (!have) return;
    for (const n of names) {
      if (n.imported !== 'default' && !have.has(n.imported)) {
        problems.push(`${rel(file)}:${n.line ?? line}: [exports] '${spec}' 没有导出 '${n.imported}'（当前 Node ${process.versions.node}）`);
      }
    }
    return;
  }
  if (!spec.startsWith('.')) return; // 没有第三方依赖；其它裸路径不归这里管
  const target = resolve(dirname(file), spec);
  if (!existsExact(target)) {
    const why = existsSync(target) ? '存在但大小写不一致，或不是文件' : '不存在';
    problems.push(`${where}: [resolve] 导入路径 '${spec}' ${why}`);
    return;
  }
  if (!isScript(target)) return; // .json 等：只检查存在
  const ex = exportsOf(target);
  for (const n of names) {
    if (!ex.open && !ex.names.has(n.imported)) {
      problems.push(`${rel(file)}:${n.line ?? line}: [exports] '${spec}' 没有导出 '${n.imported}'`);
    }
  }
  if (wantDefault && !ex.open && !ex.names.has('default')) {
    problems.push(`${where}: [exports] '${spec}' 没有 default 导出`);
  }
}

/** 具名/默认/命名空间导入里，没有被用到的绑定。 */
function unusedImports(file) {
  const mod = getModule(file);
  const used = new Set();
  mod.tokens.forEach((t, k) => {
    if (t.type !== 'id' || mod.excluded.has(k)) return;
    const prev = mod.tokens[k - 1];
    if (isPunct(prev, '.') || isPunct(prev, '?.')) return; // 属性访问不是对导入绑定的引用
    used.add(t.value);
  });
  const problems = [];
  for (const imp of mod.imports) {
    for (const s of imp.names) {
      if (!used.has(s.local)) problems.push(`${rel(file)}:${s.line}: [unused] 未使用的导入 '${s.local}'（来自 '${imp.spec}'）`);
    }
    if (imp.defaultLocal && !used.has(imp.defaultLocal.local)) {
      problems.push(`${rel(file)}:${imp.defaultLocal.line}: [unused] 未使用的默认导入 '${imp.defaultLocal.local}'（来自 '${imp.spec}'）`);
    }
    if (imp.nsLocal && !used.has(imp.nsLocal)) {
      problems.push(`${rel(file)}:${imp.line}: [unused] 未使用的命名空间导入 '${imp.nsLocal}'（来自 '${imp.spec}'）`);
    }
  }
  return problems;
}

// ── 入口 ──────────────────────────────────────────────────────────

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.mjs')) out.push(full);
    }
  };
  for (const d of DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return out.sort();
}

/** `node --check`：只做语法检查，不执行。限制并发，避免在小机器上一次拉起几十个进程。 */
function syntaxCheck(files) {
  const problems = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      await new Promise((done) => {
        const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => {
          if (code !== 0) {
            const first = stderr.split('\n').find((l) => /Error/.test(l)) ?? stderr.split('\n')[0];
            problems.push(`${rel(file)}: [syntax] ${first.trim()}`);
          }
          done();
        });
      });
    }
  };
  return Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, files.length) }, worker)).then(() => problems);
}

async function main() {
  const files = collectFiles();
  const problems = [];

  problems.push(...(await syntaxCheck(files)));

  for (const file of files) {
    const mod = getModule(file);
    for (const imp of mod.imports) {
      await checkTarget(file, imp.spec, imp.line, imp.names, Boolean(imp.defaultLocal), problems);
    }
    for (const re of mod.reExports) {
      await checkTarget(file, re.spec, re.line, re.names, false, problems);
    }
    for (const dyn of mod.dynamicImports) {
      await checkTarget(file, dyn.spec, dyn.line, dyn.names ?? [], false, problems);
    }
    problems.push(...unusedImports(file));
  }

  problems.sort();
  for (const p of problems) console.log(p);
  console.log(
    problems.length
      ? `\nlint: ${problems.length} 个问题（检查了 ${files.length} 个文件）`
      : `lint: ${files.length} 个文件，语法 / 导入路径 / 具名导出 / 未使用导入均无问题`,
  );
  process.exit(problems.length ? 1 : 0);
}

// 只有直接运行时才执行；被别的脚本 import（复用 tokenize / parseModule）时不做任何事
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('lint 自身出错:', e);
    process.exit(2);
  });
}
