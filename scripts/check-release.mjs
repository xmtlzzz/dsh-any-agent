/**
 * Release gate: the package version, CHANGELOG and docs must agree.
 *
 * Checks for:
 *   - publishing a version whose CHANGELOG section was never written;
 *   - version headings or compare links drifting between changelogs;
 *   - splitting docs and leaving relative links that 404 on GitHub.
 *
 * No network, no DSH, no tokens. Run before `npm publish`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNotes, extractSection } from './release-notes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failed += 1;
  console.log(`  ✗ ${msg}`);
};

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const changelog = read('CHANGELOG.md');

console.log(`\nrelease check: dsh-any-agent ${version}`);

if (changelog.includes(`## [${version}]`)) ok(`CHANGELOG has a ${version} section`);
else bad(`CHANGELOG.md is missing "## [${version}]"`);

if (changelog.includes(`## [${version}]`) && version !== '0.0.0') {
  // ★ 只看这一节自己（到下一个 "## [" 为止）。旧实现取的是"标题之后的全部剩余文本"，
  //   这一节空着也会因为后面还有别的版本而判通过。
  const section = extractSection(changelog, version);
  if (section && section.trim().length > 0) ok('CHANGELOG section is not empty');
  else bad(`CHANGELOG section for ${version} is empty`);
  // Release 说明就是这一节（scripts/release-notes.mjs），这里先确认它能生成。
  try {
    buildNotes(changelog, version);
    ok('release notes can be built from the CHANGELOG section');
  } catch (e) {
    bad(`release notes: ${e.message}`);
  }
  if (changelog.includes(`\n[${version}]: `)) ok(`CHANGELOG has a [${version}] compare link`);
  else bad(`CHANGELOG.md is missing the "[${version}]: …/compare/…" link at the bottom`);
  if (new RegExp(`\\n\\[Unreleased\\]: \\S+/compare/v${version.replace(/\./g, '\\.')}\\.\\.\\.HEAD`).test(changelog)) {
    ok('[Unreleased] compares from this version');
  } else bad(`CHANGELOG.md "[Unreleased]:" link should compare v${version}...HEAD`);
}

// 中文更新日志逐版本对应英文版：版本标题（含日期）、顺序和文末链接都必须一致，
// 免得发版时只改了一份。
const headingsOf = (text) => text.split(/\r?\n/).filter((line) => /^## \[/.test(line));
const linksOf = (text) => text.split(/\r?\n/).filter((line) => /^\[[^\]]+\]: /.test(line)).join('\n');
const hasChineseChangelog = fs.existsSync(path.join(ROOT, 'CHANGELOG.zh.md'));
if (!hasChineseChangelog) bad('CHANGELOG.zh.md is missing');
else {
  const changelogZh = read('CHANGELOG.zh.md');
  const en = headingsOf(changelog);
  const zh = headingsOf(changelogZh);
  let d = 0;
  while (d < Math.max(en.length, zh.length) && en[d] === zh[d]) d++;
  if (d === en.length && d === zh.length) ok(`CHANGELOG.zh.md lists the same ${en.length} version headings`);
  else bad(`CHANGELOG.zh.md headings differ from CHANGELOG.md at #${d + 1}: en "${en[d] ?? '(none)'}", zh "${zh[d] ?? '(none)'}"`);
  if (linksOf(changelog) === linksOf(changelogZh)) ok('CHANGELOG.zh.md has the same compare links');
  else bad('CHANGELOG.zh.md compare links differ from CHANGELOG.md');
}

// MCP Registry：server.json 与 package.json 必须一致（registry 用 npm 包里的 mcpName 验证归属，
// 而 release.yml 会在 npm 发布之后把这份 server.json 登记上去）。
if (fs.existsSync(path.join(ROOT, 'server.json'))) {
  let srv = null;
  try {
    srv = JSON.parse(read('server.json'));
  } catch (e) {
    bad(`server.json is not valid JSON: ${e.message}`);
  }
  if (srv) {
    const npmPkg = (srv.packages ?? []).find((p) => p.registryType === 'npm');
    if (srv.version === version && npmPkg?.version === version) ok(`server.json version is ${version}`);
    else bad(`server.json version (${srv.version} / npm ${npmPkg?.version}) must equal package.json ${version}`);
    if (pkg.mcpName && srv.name === pkg.mcpName) ok(`server.json name matches package.json mcpName (${pkg.mcpName})`);
    else bad(`server.json name (${srv.name}) must equal package.json mcpName (${pkg.mcpName})`);
    if (npmPkg?.identifier === pkg.name) ok('server.json npm identifier matches the package name');
    else bad(`server.json npm identifier (${npmPkg?.identifier}) must equal ${pkg.name}`);
    if (typeof srv.description === 'string' && srv.description.length <= 100) ok('server.json description fits 100 characters');
    else bad('server.json description must be a string of at most 100 characters');
  }
}

const docFiles = [
  'README.zh.md',
  'README.md',
  'CHANGELOG.md',
  ...(hasChineseChangelog ? ['CHANGELOG.zh.md'] : []),
  '.github/SECURITY.md',
  '.github/CONTRIBUTING.md',
  'docs/history/design-v0.2.md',
  ...fs.readdirSync(path.join(ROOT, 'docs/zh')).map((f) => `docs/zh/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'docs/en')).map((f) => `docs/en/${f}`),
];

let links = 0;
for (const file of docFiles) {
  const text = read(file);
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1];
    if (/^(https?:|#|mailto:)/.test(link)) continue;
    const [target] = link.split('#');
    if (!target) continue;
    links += 1;
    if (!fs.existsSync(path.resolve(ROOT, path.dirname(file), target))) {
      bad(`${file}: missing link target ${link}`);
    }
  }
}
if (links > 0) ok(`${links} relative links resolve`);

for (const required of ['docs/zh/team.md', 'docs/en/team.md', 'docs/zh/compatibility.md', 'docs/en/compatibility.md']) {
  if (fs.existsSync(path.join(ROOT, required))) ok(`${required} exists`);
  else bad(`${required} is missing`);
}

// npm 包应包含 README 链接到的用户文档和中文版更新日志。
for (const entry of ['docs/zh/', 'docs/en/', 'CHANGELOG.zh.md']) {
  if (pkg.files?.includes(entry)) ok(`package.json ships ${entry}`);
  else bad(`package.json "files" does not include ${entry}`);
}

console.log(`\n${failed === 0 ? 'release check: 通过 ✅' : `release check: ${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
