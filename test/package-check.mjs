/**
 * 打包前自检：这些错误 source-tree 测试看不见，只有 npm 包会暴露。
 *
 * 写这个文件是因为踩过：一次发布的 bin 字段因为路径少了 "./" 前缀被 npm
 * 静默删掉，包发上去了但 npm install -g 装不出任何命令。
 *
 * 用法：node test/package-check.mjs
 * 退出码非 0 表示不能发布。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
const ok = (s) => console.log('  \u2713 ' + s);
const bad = (s) => { console.log('  \u2717 ' + s); failures++; };

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('\npackage.json');
if (pkg.name === 'dsh-any-agent') ok('name is ' + pkg.name); else bad('name is ' + pkg.name);
if (/^\d+\.\d+\.\d+/.test(pkg.version)) ok('version is ' + pkg.version); else bad('version looks wrong: ' + pkg.version);
if (pkg.license) ok('license is ' + pkg.license); else bad('license is missing');
if (pkg.private) bad('private:true would block publishing'); else ok('not marked private');

console.log('\nbin');
const bins = pkg.bin || {};
const names = Object.keys(bins);
if (names.length) ok('bin has ' + names.length + ' entry: ' + names.join(', '));
else bad('no bin field -- npm install -g would create no command');

for (const n of names) {
  const rel = bins[n];
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { bad(n + ' -> ' + rel + ' does not exist'); continue; }
  const first = readFileSync(abs, 'utf8').split(/\r?\n/)[0];
  if (first.startsWith('#!')) ok(n + ' has a shebang');
  else bad(n + ' -> ' + rel + ' has no shebang; the shim would not run');
}

console.log('\nfiles whitelist');
const files = pkg.files || [];
for (const need of ['LICENSE', 'README.md']) {
  if (files.includes(need)) ok(need + ' is published');
  else bad(need + ' is missing from files');
}
for (const never of ['test/', 'state/', '.state/', '.birdview', '.npmrc', '.env']) {
  if (files.some((f) => f === never || f.startsWith(never))) bad(never + ' must not be published');
}
ok('no test/state/secret paths in the whitelist');

console.log('\nzero dependencies');
const runtimeDeps = Object.keys(pkg.dependencies || {});
if (runtimeDeps.length === 0) ok('no runtime dependencies');
else bad('runtime dependencies appeared: ' + runtimeDeps.join(', '));

console.log('\n' + (failures ? failures + ' problem(s) -- do not publish' : 'all checks passed'));
process.exit(failures ? 1 : 0);
