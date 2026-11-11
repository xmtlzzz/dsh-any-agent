/**
 * 会话级 worktree 隔离回归（离线：临时 git 仓库，不拉 DSH、不花 token）。
 *
 * 守的不变量：
 *   1. 建出来的 worktree 在状态目录下、不在仓库里；分支名 dsh/…；基于主检出 HEAD；
 *      cwd 是子目录时映射到 worktree 里的同一子目录；
 *   2. 主检出有未提交改动时如实标出（这些改动不会带进 worktree）；
 *   3. 不是 git 仓库、仓库没有提交时明确报错；
 *   4. 不跑仓库自带的钩子（仓库可能不可信）；
 *   5. 收尾：干净才删目录，有未提交改动就保留；分支始终保留；建会话失败时整个撤销；
 *   6. Hub.create(isolation='worktree') 用 worktree 当会话目录，并把它记进注册表。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// .native：把 GitHub Windows runner 临时目录里的 8.3 短名（RUNNER~1）展开成长路径，这样测试里
// 拼出来的仓库路径和 git 给出的写法一致，能直接比较。别名路径本身由 [2] 里的 junction 用例专门覆盖。
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-any-agent-worktree-')));
const wtRoot = join(root, 'worktrees');
process.env.DSH_MCP_STATE = join(root, 'state', 'conversations.json');
process.env.DSH_MCP_WORKTREES_DIR = wtRoot;
process.env.DSH_MCP_LIVE_DIR = join(root, 'live');
process.env.DSH_HOME = join(root, 'dsh-home');
process.env.DSH_MCP_GIT_STATUS = '0';
// Hub.create 要拉 ACP 进程：用假的（test/fake-acp.mjs），只需要 initialize / session/new。
process.env.DSH_BIN = join(HERE, 'fake-acp.mjs');
process.env.FAKE_ACP_DIR = join(root, 'fake-acp');
process.env.DSH_MCP_SHARED_PROCESS = '0';

const { createWorktree, removeWorktree, discardWorktree } = await import('../src/worktree.mjs');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const branches = (repo) => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'pkg', 'sub'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'worktree test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'pkg', 'sub', 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

try {
  console.log('\n[1] 新建 worktree');
  const repo = makeRepo('repo-a');
  const head = git(repo, 'rev-parse', 'HEAD');
  const wt = await createWorktree(repo, { root: wtRoot });
  await check('目录在 worktree 根下、不在仓库里', () => wt.path.startsWith(wtRoot + sep) && !resolve(wt.path).startsWith(repo + sep));
  await check('分支名 dsh/… 且已建出', () => /^dsh\/\d{8}-\d{6}-[0-9a-f]{4}$/.test(wt.branch) && branches(repo).includes(wt.branch), wt.branch);
  await check('基于主检出的 HEAD', () => wt.base === head && git(wt.path, 'rev-parse', 'HEAD') === head);
  await check('主检出干净时 main_dirty=false', () => wt.main_dirty === false);
  await check('从仓库根建：会话目录就是 worktree 根', () => wt.cwd === wt.path);
  await check('主检出不受影响（没有多出未跟踪目录）', () => git(repo, 'status', '--porcelain') === '');

  console.log('\n[2] cwd 是子目录 / 主检出有未提交改动');
  writeFileSync(join(repo, 'README.md'), 'changed in main\n');
  const wtSub = await createWorktree(join(repo, 'pkg', 'sub'), { root: wtRoot });
  await check('子目录映射到 worktree 里的同一子目录', () => wtSub.cwd === join(wtSub.path, 'pkg', 'sub'), wtSub.cwd);
  await check('★ 主检出有未提交改动时 main_dirty=true', () => wtSub.main_dirty === true);
  // 不比行尾：GitHub 的 Windows runner 上 git 默认 core.autocrlf=true，检出的是 CRLF。
  await check('未提交改动不会带进 worktree', () => readFileSync(join(wtSub.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n') === 'hello\n');
  git(repo, 'checkout', '--', 'README.md');
  // 同一个目录的另一种写法（junction / 符号链接；GitHub Windows runner 的 8.3 短名 RUNNER~1 同理）：
  // git 给的仓库根是解析后的路径，子目录不能靠拿它和 cwd 做字符串比较来算。
  const alias = join(root, 'repo-a-alias');
  symlinkSync(repo, alias, 'junction');
  const wtAlias = await createWorktree(join(alias, 'pkg', 'sub'), { root: wtRoot });
  await check('★ cwd 是别名路径（junction / 符号链接）：仍映射到 worktree 里的同一子目录', () => wtAlias.cwd === join(wtAlias.path, 'pkg', 'sub'), wtAlias.cwd);
  mkdirSync(join(repo, 'untracked-dir'));
  const wtUntracked = await createWorktree(join(repo, 'untracked-dir'), { root: wtRoot });
  await check('子目录在主检出里未跟踪（worktree 里没有）→ 退回 worktree 根', () => wtUntracked.cwd === wtUntracked.path);
  rmSync(join(repo, 'untracked-dir'), { recursive: true, force: true });

  console.log('\n[3] 不能建的情况明确报错');
  const plain = join(root, 'not-a-repo');
  mkdirSync(plain);
  await check('不是 git 仓库', async () => {
    try {
      await createWorktree(plain, { root: wtRoot });
      return false;
    } catch (e) {
      return /git/.test(e.message);
    }
  });
  const empty = join(root, 'empty-repo');
  mkdirSync(empty);
  git(empty, 'init', '-q');
  await check('仓库还没有提交', async () => {
    try {
      await createWorktree(empty, { root: wtRoot });
      return false;
    } catch (e) {
      return /提交|commit/.test(e.message);
    }
  });

  console.log('\n[4] ★ 不跑仓库自带的钩子');
  {
    const hooked = makeRepo('repo-hooked');
    const marker = join(root, 'hook-ran.txt');
    const hook = join(hooked, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`);
    try {
      execFileSync('chmod', ['+x', hook]);
    } catch {
      /* Windows 上 git 自带的 sh 不看可执行位 */
    }
    await createWorktree(hooked, { root: wtRoot });
    await check('post-checkout 钩子没有执行', () => !existsSync(marker));
    // 对照：同一个钩子在不屏蔽时确实会执行 —— 否则上一条断言什么也证明不了。
    git(hooked, 'worktree', 'add', '-q', '-b', 'control', join(root, 'hook-control'), 'HEAD');
    await check('对照：不屏蔽时同一个钩子会执行', () => existsSync(marker));
  }

  console.log('\n[5] 收尾');
  {
    const r1 = await removeWorktree(wt, { root: wtRoot });
    await check('干净的 worktree：目录删除', () => r1.removed === true && !existsSync(wt.path));
    await check('分支保留（提交不会丢）', () => branches(repo).includes(wt.branch));
    writeFileSync(join(wtSub.path, 'new-file.txt'), 'work in progress\n');
    const r2 = await removeWorktree(wtSub, { root: wtRoot });
    await check('★ 有未提交改动：不删，原因 dirty', () => r2.removed === false && r2.reason === 'dirty' && existsSync(join(wtSub.path, 'new-file.txt')));
    const r3 = await removeWorktree({ path: join(root, 'gone'), branch: 'x', repo }, { root: wtRoot });
    await check('目录已经不在：报 missing，不抛错', () => r3.removed === false && r3.reason === 'missing');
    const wtTmp = await createWorktree(repo, { root: wtRoot });
    await discardWorktree(wtTmp, { root: wtRoot });
    await check('建会话失败时撤销：目录和分支都删掉', () => !existsSync(wtTmp.path) && !branches(repo).includes(wtTmp.branch));
  }

  console.log('\n[6] Hub.create(isolation=worktree)');
  {
    const { Hub } = await import('../src/hub.mjs');
    const hub = new Hub({ log: { info() {}, debug() {}, dshStderr() {} } });
    const repoB = makeRepo('repo-b');
    let conv = null;
    try {
      conv = await hub.create({ cwd: join(repoB, 'pkg'), permission: 'workspace-write', isolation: 'worktree' });
      await check('会话目录是 worktree 里的同一子目录', () => conv.cwd.startsWith(wtRoot + sep) && conv.cwd.endsWith(join('pkg')), conv.cwd);
      await check('快照里带 worktree 信息', () => {
        const w = conv.snapshot().worktree;
        return w?.branch?.startsWith('dsh/') && w.repo === repoB && w.path && existsSync(w.path);
      });
      hub.save();
      const saved = JSON.parse(readFileSync(process.env.DSH_MCP_STATE, 'utf8'));
      await check('worktree 记进注册表（重启后还知道它在哪）', () =>
        saved.conversations.find((c) => c.id === conv.id)?.worktree?.branch === conv.worktree.branch);
      await check('不传 isolation 时照旧用原目录', async () => {
        const plainConv = await hub.create({ cwd: repoB, permission: 'workspace-write' });
        const ok = plainConv.cwd === repoB && plainConv.worktree === null;
        await plainConv.close();
        return ok;
      });
      await check('isolation 取值不合法时拒绝', async () => {
        try {
          await hub.create({ cwd: repoB, isolation: 'docker' });
          return false;
        } catch (e) {
          return /isolation/.test(e.message);
        }
      });
      const wtPath = conv.worktree.path;
      const r = await conv.close({ forget: true });
      await check('forget：干净的 worktree 随之删除，结果里说明', () => r.forgotten === true && r.worktree?.removed === true && !existsSync(wtPath), JSON.stringify(r.worktree));
      conv = null;
    } finally {
      if (conv) await conv.close().catch(() => {});
      await hub.shutdown().catch(() => {});
    }
  }
} catch (e) {
  failed += 1;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try {
    // 仓库和 worktree 都在这个临时目录里，整个删掉即可（删不掉就留给 cleanup.mjs 按前缀清理）。
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

console.log(`\n===== worktree: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
