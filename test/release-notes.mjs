/**
 * scripts/release-notes.mjs 回归：GitHub Release 说明取自 CHANGELOG 的对应一节。
 * 纯字符串处理 + 读一次仓库自己的 CHANGELOG，不联网、不需要 DSH。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { extractSection, previousVersion, buildNotes } = await import('../scripts/release-notes.mjs');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const ok = fn();
    if (ok === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.2.0] — 2026-01-02',
  '',
  '### Added',
  '',
  '- **New thing.** It does stuff.',
  '',
  '## [1.1.10] — 2026-01-01',
  '',
  '### Fixed',
  '',
  '- A bug.',
  '',
  '## [1.1.1] — 2025-12-31',
  '',
  '## [1.0.0] — 2025-12-01',
  '',
  '- First.',
  '',
  '[Unreleased]: https://example.test/compare/v1.2.0...HEAD',
  '[1.2.0]: https://example.test/compare/v1.1.10...v1.2.0',
  '',
].join('\n');

console.log('\n[1] 取节');
check('取出对应一节，不含标题行', () => extractSection(SAMPLE, '1.2.0') === '### Added\n\n- **New thing.** It does stuff.');
check('接受 v 前缀', () => extractSection(SAMPLE, 'v1.2.0') === extractSection(SAMPLE, '1.2.0'));
check('1.1.1 不会误匹配到 1.1.10', () => extractSection(SAMPLE, '1.1.1') === '');
check('最后一节到链接定义区为止', () => extractSection(SAMPLE, '1.0.0') === '- First.');
check('不存在的版本返回 null', () => extractSection(SAMPLE, '9.9.9') === null);

console.log('\n[2] 上一个版本与完整说明');
check('上一个版本按 CHANGELOG 顺序', () => previousVersion(SAMPLE, '1.2.0') === '1.1.10' && previousVersion(SAMPLE, '1.0.0') === null);
const notes = buildNotes(SAMPLE, 'v1.2.0');
check('说明 = 这一节 + 安装命令 + compare 链接', () =>
  notes.startsWith('### Added') &&
  notes.includes('npm install -g dsh-any-agent@1.2.0') &&
  notes.includes('/compare/v1.1.10...v1.2.0'));
check('空的一节直接报错（不发空说明）', () => {
  try {
    buildNotes(SAMPLE, '1.1.1');
    return false;
  } catch (e) {
    return /是空的/.test(e.message);
  }
});
check('不存在的版本报错', () => {
  try {
    buildNotes(SAMPLE, '9.9.9');
    return false;
  } catch (e) {
    return /没有/.test(e.message);
  }
});

console.log('\n[3] 仓库自己的 CHANGELOG 与命令行入口');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const realNotes = buildNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), pkg.version);
check(`当前版本 ${pkg.version} 能生成非空说明`, () => realNotes.length > 200 && realNotes.includes(`dsh-any-agent@${pkg.version}`));
const cli = spawnSync(process.execPath, ['scripts/release-notes.mjs', pkg.version], { cwd: root, encoding: 'utf8' });
check('命令行输出到 stdout、退出码 0', () => cli.status === 0 && cli.stdout === realNotes);
const miss = spawnSync(process.execPath, ['scripts/release-notes.mjs', '9.9.9'], { cwd: root, encoding: 'utf8' });
check('命令行遇到缺失版本退出码 1', () => miss.status === 1 && miss.stderr.includes('9.9.9'));

console.log(`\n===== release notes：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
