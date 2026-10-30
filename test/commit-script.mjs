/**
 * scripts/commit.mjs 的回归。
 *
 * 由来：发布时几次把 _cm.txt / _msg.cjs 这类临时文件一起提交进仓库，因为
 * 老办法是「先把提交信息写进文件，再 git commit -F 那个文件」。文件落盘之后，
 * 任何一条 git add -A 都会把它卷进去。
 *
 * 这个脚本把信息走 stdin（git commit -F -），磁盘上不存在信息文件。这里的
 * 断言就是盯着这件事，外加它自带的防呆：索引里有临时文件时应当拒绝提交。
 *
 * 全部在临时 git 仓库里跑，不碰真实仓库、不产生网络访问，可以进 CI。
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'commit.mjs');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

/** 一个干净的临时仓库。 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-test-'));
  const run = (args, opts = {}) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV, ...opts });
  run(['init', '-q']);
  run(['config', 'user.name', 'test']);
  run(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8');
  run(['add', 'a.txt']);
  return { dir, run };
}

const runScript = (dir, args, input) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: dir,
  encoding: 'utf8',
  env: GIT_ENV,
  input,
});

// ── 1. 提交信息走 stdin，磁盘上不留任何文件 ──────────────────────────

console.log('\n[1] 提交信息通过 stdin 进入 git，不产生临时文件');

{
  const { dir, run } = repo();
  const before = readdirSync(dir).sort().join(',');

  const r = runScript(dir, ['-m', '标题行', '-m', '正文第一段', '-m', '正文第二段']);
  check('脚本退出码 0', r.status === 0, 'exit ' + r.status + ' ' + (r.stderr || '').slice(0, 120));

  const after = readdirSync(dir).sort().join(',');
  check('仓库里没有新增任何文件', after === before, before + ' -> ' + after);

  const log = run(['log', '-1', '--pretty=format:%s%n%n%b']).stdout || '';
  check('标题行正确', log.startsWith('标题行'), JSON.stringify(log.slice(0, 60)));
  check('多段之间有空行', log.includes('正文第一段\n\n正文第二段'), JSON.stringify(log.slice(0, 160)));
  check('正文两段都在', log.includes('正文第一段') && log.includes('正文第二段'));

  rmSync(dir, { recursive: true, force: true });
}

// ── 2. 索引里有临时文件时必须拒绝 ────────────────────────────────────

console.log('\n[2] 索引里有临时文件时拒绝提交（这才是当初的病根）');

{
  const { dir, run } = repo();
  writeFileSync(join(dir, '_cm.txt'), 'scratch', 'utf8');
  run(['add', '-A']);

  const r = runScript(dir, ['-m', '不该成功']);
  check('退出码非 0', r.status !== 0, 'exit ' + r.status);
  check('报错点名了那个文件', (r.stderr || '').includes('_cm.txt'), (r.stderr || '').slice(0, 120));

  const count = (run(['rev-list', '--count', 'HEAD']).stdout || '0').trim();
  check('没有产生提交', count === '0', 'commits=' + count);

  // 显式放行后可以提交（给确实要提交下划线文件的场景留出口）
  const r2 = runScript(dir, ['-m', '真的需要', '--allow-staged-temp']);
  check('--allow-staged-temp 后可以提交', r2.status === 0, 'exit ' + r2.status);

  rmSync(dir, { recursive: true, force: true });
}

// ── 3. --dry-run 不落任何提交 ───────────────────────────────────────

console.log('\n[3] --dry-run 只打印，不提交');

{
  const { dir, run } = repo();
  const r = runScript(dir, ['-m', '不该发生', '--dry-run']);
  check('退出码 0', r.status === 0, 'exit ' + r.status);
  check('打印了将要执行的命令', (r.stdout || '').includes('[dry-run]'), (r.stdout || '').slice(0, 100));
  const count = (run(['rev-list', '--count', 'HEAD']).stdout || '0').trim();
  check('没有产生提交', count === '0', 'commits=' + count);
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. --file - 从 stdin 读整段信息 ─────────────────────────────────

console.log('\n[4] --file - 从 stdin 读取整段提交信息');

{
  const { dir, run } = repo();
  const r = runScript(dir, ['--file', '-'], '第一行\n\n第二段\n');
  check('退出码 0', r.status === 0, 'exit ' + r.status + ' ' + (r.stderr || '').slice(0, 100));
  const log = run(['log', '-1', '--pretty=format:%s']).stdout || '';
  check('标题取自 stdin 第一行', log.trim() === '第一行', JSON.stringify(log));
  const full = run(['log', '-1', '--pretty=format:%B']).stdout || '';
  check('第二段也在', full.includes('第二段'), JSON.stringify(full.slice(0, 80)));
  // git 自己会在 %B 输出末尾补一个换行，所以判断「有没有残留空行」要先去掉它。
  const body = full.replace(/\n+$/, '');
  check('信息里没有残留的空行', !/\n\s*$/.test(body), JSON.stringify(full));
  rmSync(dir, { recursive: true, force: true });
}

// ── 5. 打附注标签同样不落盘 ──────────────────────────────────────────

console.log('\n[5] --tag 打附注标签，信息同样走 stdin');

{
  const { dir, run } = repo();
  const c = runScript(dir, ['-m', '先提交']);
  check('前置提交成功', c.status === 0, 'exit ' + c.status);
  const before = readdirSync(dir).sort().join(',');

  const r = runScript(dir, ['--tag', 'v0.0.1-test', '-m', '标签说明', '-m', '第二段']);
  check('打标签退出码 0', r.status === 0, 'exit ' + r.status + ' ' + (r.stderr || '').slice(0, 120));
  check('仓库里仍没有新增文件', readdirSync(dir).sort().join(',') === before);

  const tagMsg = run(['tag', '-l', '-n99', 'v0.0.1-test']).stdout || '';
  check('标签信息包含正文', tagMsg.includes('标签说明'), tagMsg.slice(0, 120));
  rmSync(dir, { recursive: true, force: true });
}

// ── 6. 空信息被拒绝 ─────────────────────────────────────────────────

console.log('\n[6] 空提交信息被拒绝');

{
  const { dir, run } = repo();
  const r = runScript(dir, ['-m', '   ']);
  check('退出码非 0', r.status !== 0, 'exit ' + r.status);
  const count = (run(['rev-list', '--count', 'HEAD']).stdout || '0').trim();
  check('没有产生提交', count === '0', 'commits=' + count);
  rmSync(dir, { recursive: true, force: true });
}

// ── 7. 真实仓库里不存在落盘的信息文件 ───────────────────────────────

console.log('\n[7] 脚本自身不写文件（源码里没有写盘调用）');

{
  const src = readFileSync(SCRIPT, 'utf8');
  check('没有 writeFileSync', !/writeFileSync/.test(src));
  check('没有 appendFileSync', !/appendFileSync/.test(src));
  check('提交命令用 -F -（stdin）', /\[.commit., .-F., .-.\]/.test(src.replace(/'\s*\+\s*'/g, '')), 'check the args array');
  check('脚本文件本身在 scripts/ 下', existsSync(SCRIPT));
}

console.log('\n===== commit script: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);