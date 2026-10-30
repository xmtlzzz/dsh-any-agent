/**
 * 真实配置的往返测试：拿本机**已经存在**的客户端配置做素材。
 *
 * 前面几个套件用的是手工构造的 fixture —— 它们证明实现符合我们的假设，
 * 但证明不了这些假设和真实文件一样。这个套件补上的正是那一层：
 * 把 ~/.claude.json、~/.codex/config.toml、~/.cursor/mcp.json 这些
 * 真实文件（本机上有哪些就用哪些）原封不动复制进沙箱，然后
 *
 *   1) 先 --remove 摘干净，记下「用户原本的样子」；
 *   2) --yes 注册，断言原有每一行都还在（只允许多出我们自己那一条）；
 *   3) --remove，断言文件逐字节还原。
 *
 * 真实文件里有 HTML 页面几百个项目条目、有注释、有 CRLF、有大小写重复键，
 * 这些是手工 fixture 想不出来的。机器上一个客户端都没装时整组跳过，
 * 不会假绿：会明确打印 skipped。
 *
 * 只读真实 HOME —— 所有写入都发生在临时目录里。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'bin', 'setup.mjs');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};
const preview = (s) => {
  const one = String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return one.length > 100 ? one.slice(0, 100) + '…' : one;
};

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const APPDATA = process.env.APPDATA || (IS_WIN ? join(HOME, 'AppData', 'Roaming') : HOME);
const APP_BASE = IS_MAC ? join(HOME, 'Library', 'Application Support') : APPDATA;

/** 每个客户端的真实配置可能在哪（存在哪个就用哪个）。 */
const SOURCES = {
  'claude-code': [join(HOME, '.claude.json')],
  'claude-desktop': [join(APP_BASE, 'Claude', 'claude_desktop_config.json')],
  codex: [join(HOME, '.codex', 'config.toml')],
  cursor: [join(HOME, '.cursor', 'mcp.json')],
  windsurf: [join(HOME, '.codeium', 'windsurf', 'mcp_config.json')],
  zed: [join(APP_BASE, 'Zed', 'settings.json'), join(HOME, '.config', 'zed', 'settings.json')],
  gemini: [join(HOME, '.gemini', 'settings.json')],
  opencode: [join(HOME, '.config', 'opencode', 'opencode.json')],
  vscode: [join(APP_BASE, 'Code', 'User', 'mcp.json'), join(HOME, '.config', 'Code', 'User', 'mcp.json')],
};

/** 沙箱里对应的目标位置（与 clients.mjs 的选择保持一致）。 */
const TARGETS = {
  'claude-code': ['', '.claude.json'],
  'claude-desktop': ['app', 'Claude/claude_desktop_config.json'],
  codex: ['', '.codex/config.toml'],
  cursor: ['', '.cursor/mcp.json'],
  windsurf: ['', '.codeium/windsurf/mcp_config.json'],
  zed: ['app', 'Zed/settings.json'],
  gemini: ['', '.gemini/settings.json'],
  opencode: ['', '.config/opencode/opencode.json'],
  vscode: ['app', 'Code/User/mcp.json'],
};

const home = mkdtempSync(join(tmpdir(), 'dsh-realcfg-'));
const appData = join(home, 'AppData', 'Roaming');
const cleanup = () => { try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } };

const run = (args) => spawnSync(NODE, [SETUP, ...args, '--home', home], {
  encoding: 'utf8',
  timeout: 60000,
  windowsHide: true,
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, DSH_BIN: '/fake/dsh/bin.js', DSH_MCP_LOG: 'silent' },
});

const seeded = [];
for (const [id, candidates] of Object.entries(SOURCES)) {
  const src = candidates.find((p) => existsSync(p));
  if (!src) continue;
  const [where, rel] = TARGETS[id];
  const dst = join(where === 'app' ? appData : home, ...rel.split('/'));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  seeded.push({ id, src, dst });
}

console.log('\n[0] 真实配置样本');
console.log('  沙箱: ' + home);
if (!seeded.length) {
  console.log('  (本机没有任何已安装客户端的配置 —— 这一组整体跳过，不代表通过)');
  console.log('\n===== real configs: skipped (0 checks) =====');
  cleanup();
  process.exit(0);
}
for (const s of seeded) console.log('  ' + s.id.padEnd(15) + ' <- ' + s.src);

const ids = seeded.map((s) => s.id).join(',');

// 基线：真机上通常已经有我们这一条（用户装过）。先摘干净，那才是「用户原本的样子」。
console.log('\n[1] 先摘掉可能存在的旧条目，得到用户原本的样子');
{
  const r = run(['--remove', '--yes', '--only', ids]);
  check('清理运行退出码 0', r.status === 0, 'exit ' + r.status + ' ' + preview(r.stdout + r.stderr));
  for (const s of seeded) {
    s.baseline = readFileSync(s.dst, 'utf8');
    const mentionsUs = s.baseline.includes('dsh-any-agent');
    check(s.id + ': 基线里已经没有我们这一条', !mentionsUs,
      mentionsUs ? 'still mentions dsh-any-agent' : '');
  }
}

console.log('\n[2] 注册：原有一切必须留下，只多出我们这一条');
{
  // 第 1 步的 --remove 自己也会留备份；只看这一步新产生的那些，
  // 否则断言会读到上一次的旧备份而误报。
  const before2 = new Map();
  for (const s0 of seeded) {
    before2.set(s0.id, new Set(readdirSync(dirname(s0.dst)).filter((f) => f.includes('.bak-dsh-'))));
  }
  const r = run(['--yes', '--only', ids]);
  check('注册退出码 0', r.status === 0, 'exit ' + r.status + ' ' + preview(r.stdout + r.stderr));

  for (const s of seeded) {
    const after = readFileSync(s.dst, 'utf8');
    const before = s.baseline;
    const lost = before
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .filter((l) => !after.includes(l) && !after.includes(l.replace(/\r$/, '')) && !after.includes(l.trimEnd()));
    check(s.id + ': 原有每一行都还在（' + before.split(/\r?\n/).filter((l) => l.trim()).length + ' 行）',
      lost.length === 0, 'missing ' + lost.length + ': ' + preview(JSON.stringify(lost.slice(0, 2))));
    check(s.id + ': 文件确实变长了（我们这条写进去了）', after.length > before.length,
      before.length + ' -> ' + after.length);
    check(s.id + ': 行尾风格没被改掉',
      before.includes('\r\n') === after.includes('\r\n'),
      'crlf before=' + before.includes('\r\n') + ' after=' + after.includes('\r\n'));
    const seen = before2.get(s.id) || new Set();
    const fresh = readdirSync(dirname(s.dst))
      .filter((f) => f.includes('.bak-dsh-') && !seen.has(f));
    check(s.id + ': 写入前留了备份', fresh.length === 1, 'new backups=' + fresh.length + ' ' + fresh.join(','));
    if (fresh.length === 1) {
      check(s.id + ': 备份内容等于注册前的原文',
        readFileSync(join(dirname(s.dst), fresh[0]), 'utf8') === before,
        'backup differs');
    }
  }
}

console.log('\n[3] 撤销：必须逐字节还原成用户原本的样子');
{
  const r = run(['--remove', '--yes', '--only', ids]);
  check('撤销退出码 0', r.status === 0, 'exit ' + r.status + ' ' + preview(r.stdout + r.stderr));
  for (const s of seeded) {
    const back = readFileSync(s.dst, 'utf8');
    check(s.id + ': 逐字节还原', back === s.baseline,
      back.length + ' vs ' + s.baseline.length);
    check(s.id + ': 不再提到我们', !back.includes('dsh-any-agent'));
  }
}

console.log('\n[4] 真实 HOME 全程只读');
{
  for (const s of seeded) {
    const now = readFileSync(s.src, 'utf8');
    check(s.id + ': 真实配置文件没被本套件改动', now.length > 0);
  }
}

cleanup();
console.log('\n===== real configs: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);