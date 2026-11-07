/**
 * scripts/lint.mjs 的回归：每条规则都必须真的会报，而且不能把"其实在用"的导入报成未使用。
 *
 * 一个只会说"通过"的静态检查比没有更糟 —— 所以这里在临时目录里造一棵有问题的树，
 * 逐条断言报错；再造一棵写法刁钻但完全合法的树，断言零误报。最后断言本仓库自己是干净的
 * （这样 `npm test` 也会顺带把 lint 跑一遍）。
 *
 * 纯文件系统 + node --check，不拉 DSH，不花 token。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModule, tokenize } from '../scripts/lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT = join(HERE, '..', 'scripts', 'lint.mjs');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); failed++; }
};

/** 在临时目录里按 { 'src/a.mjs': '内容' } 造一棵树。 */
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return dir;
}
const lintTree = (dir) => {
  const r = spawnSync(process.execPath, [LINT, '--root', dir], { encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout) + String(r.stderr) };
};
const has = (out, file, rule, needle = '') =>
  out.split('\n').some((l) => l.startsWith(file + ':') && l.includes(`[${rule}]`) && l.includes(needle));

// ── 公共被依赖模块 ─────────────────────────────────────────────
const A = [
  'export function a() { return 1; }',
  'export const b = 2;',
  'export class C {}',
  'export default 5;',
  'const x = 1;',
  'export { x as y };',
  'export async function* g() {}',
  '',
].join('\n');
const B = "export * from './a.mjs';\nexport { a as renamed } from './a.mjs';\n";

console.log('\n[1] 写法刁钻但合法的树：零误报');
{
  const dir = makeTree({
    'src/a.mjs': A,
    'src/b.mjs': B,
    'src/main.mjs': [
      "import { readFileSync } from 'node:fs';",
      "import def, { a, b, C } from './a.mjs';",
      "import * as ns from './a.mjs';",
      "import { renamed, y } from './b.mjs';",
      "import { g as gen } from './a.mjs';",
      '',
      '// import { w } from "./nope-in-comment.mjs";',
      '/* import { v } from "./nope-in-block-comment.mjs"; */',
      "const text = 'import { z } from \"./nope-in-string.mjs\"';",
      // 只在模板字符串的 ${} 里被用到的导入不能报未使用
      'const msg = `value=${b} and ${C.name} ${`nested ${def}`}`;',
      // 正则里带引号：不能把后面的代码吞成字符串
      "const q = text.replace(/'/g, \"''\") + renamed() + ns.y + y + String(gen);",
      // 除号不是正则
      'const half = a() / 2 / 3;',
      "const { a: aa, b: bb } = await import('./a.mjs');",
      "export const used = [readFileSync, msg, q, half, aa, bb];",
      '',
    ].join('\n'),
  });
  const r = lintTree(dir);
  check('退出码 0', r.code === 0, `exit=${r.code}\n${r.out}`);
  check('汇总行写明无问题', /均无问题/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[2] 每条规则都会报');
{
  const dir = makeTree({
    'src/a.mjs': A,
    'src/b.mjs': B,
    'src/bad-syntax.mjs': 'export const = ;\n',
    'src/missing.mjs': "import { x } from './nope.mjs';\nexport const m = x;\n",
    // a.mjs 存在，写成 A.mjs：Linux 上不存在，Windows/macOS 上 existsSync 为真 —— 都必须报
    'src/case.mjs': "import { a } from './A.mjs';\nexport const c = a;\n",
    'src/noexport.mjs': "import { nothere } from './a.mjs';\nexport const n = nothere;\n",
    'src/unused.mjs': "import { a, b } from './a.mjs';\nexport const u = a();\n",
    'src/reexport-bad.mjs': "export { ghost } from './a.mjs';\n",
    'src/dyn.mjs': "const { a, nope } = await import('./a.mjs');\nexport const d = [a, nope];\n",
    'src/builtin.mjs': "import { definitelyNotAnFsExport } from 'node:fs';\nexport const f = definitelyNotAnFsExport;\n",
    // b.mjs 用 export * 转出 a.mjs：export * 不含 default
    'src/default.mjs': "import dflt from './b.mjs';\nexport const df = dflt;\n",
    'src/jsdoc.mjs': "/** uses a() somewhere */\nimport { a } from './a.mjs';\nexport const z = 1;\n",
  });
  const r = lintTree(dir);
  check('退出码 1', r.code === 1, `exit=${r.code}`);
  check('syntax：语法错误', has(r.out, 'src/bad-syntax.mjs', 'syntax'), r.out);
  check('resolve：路径不存在', has(r.out, 'src/missing.mjs', 'resolve', './nope.mjs'), r.out);
  check('resolve：大小写不一致', has(r.out, 'src/case.mjs', 'resolve', './A.mjs'), r.out);
  check('exports：具名导入不存在', has(r.out, 'src/noexport.mjs', 'exports', 'nothere'), r.out);
  check('unused：只用了一个，另一个被报', has(r.out, 'src/unused.mjs', 'unused', "'b'") && !has(r.out, 'src/unused.mjs', 'unused', "'a'"), r.out);
  check('exports：export { x } from 里的名字也要存在', has(r.out, 'src/reexport-bad.mjs', 'exports', 'ghost'), r.out);
  check('exports：await import 解构出来的名字要存在', has(r.out, 'src/dyn.mjs', 'exports', 'nope') && !has(r.out, 'src/dyn.mjs', 'exports', "'a'"), r.out);
  check('exports：内置模块的具名导入也对照实际导出', has(r.out, 'src/builtin.mjs', 'exports', 'definitelyNotAnFsExport'), r.out);
  check('exports：export * 不转出 default', has(r.out, 'src/default.mjs', 'exports', 'default'), r.out);
  check('unused：只在注释里出现不算使用', has(r.out, 'src/jsdoc.mjs', 'unused', "'a'"), r.out);
  check('没有牵连无辜文件', !/^src\/(a|b)\.mjs:/m.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] 词法扫描的边界');
{
  const ids = (src) => tokenize(src).filter((t) => t.type === 'id').map((t) => t.value);
  check('除号不吞后面的代码', ids('x = a / b / c;').join() === 'x,a,b,c');
  check('正则里的引号不开启字符串', ids("x = /'/g; y = z;").join() === 'x,y,z');
  check('模板字符串只保留 ${} 里的代码', ids('x = `static words ${inner} more ${`deep ${leaf}`}`;').join() === 'x,inner,leaf');
  check('注释里的代码被丢弃', ids('// gone\n/* gone too */ keep').join() === 'keep');

  const m = parseModule("import dflt, { y as z, w } from './m.mjs';\nexport const { p, q } = obj;\n");
  check('默认导入 + 具名导入（含 as）', m.imports[0]?.defaultLocal?.local === 'dflt' && m.imports[0].names.map((n) => `${n.imported}>${n.local}`).join() === 'y>z,w>w');
  check('解构导出标记为导出表不完整（宁可漏报）', m.openExports === true);
  const s = parseModule("export * from './a.mjs';\nexport { k as renamed } from './b.mjs';\nexport default function () {}\n");
  check('export * / export { } from / export default', s.reExports.length === 2 && s.reExports[0].star === true && s.exports.has('default'));
}

console.log('\n[4] 本仓库自己是干净的');
{
  const r = spawnSync(process.execPath, [LINT], { encoding: 'utf8' });
  check('npm run lint 退出码 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
}

console.log(`\n===== lint：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
