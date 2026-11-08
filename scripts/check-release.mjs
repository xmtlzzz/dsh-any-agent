/**
 * Release gate: the package version, CHANGELOG and docs must agree.
 *
 * Catches the two drifts that actually happened in this repo:
 *   - publishing a version whose CHANGELOG section was never written;
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

const docFiles = [
  'README.zh.md',
  'README.md',
  'USAGE-NOTES.md',
  'USAGE-NOTES.en.md',
  ...(fs.existsSync(path.join(ROOT, 'SECURITY.md')) ? ['SECURITY.md'] : []),
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

if (pkg.files?.includes('docs/')) ok('package.json ships docs/');
else bad('package.json "files" does not include docs/');

console.log(`\n${failed === 0 ? 'release check: 通过 ✅' : `release check: ${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
