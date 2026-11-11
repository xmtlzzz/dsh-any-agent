/**
 * 会话级 git worktree 隔离（`dsh_start(isolation='worktree')`，默认不开）。
 *
 * 解决的问题：DSH 在后台跑的时候，调用方 agent 往往还在同一个仓库里继续改文件，
 * 两边互相覆盖，workspace_changed 和审核证据里也会混进对方的改动。给会话一个独立的
 * worktree，DSH 的沙箱可写根就是它，主检出不受影响。
 *
 * 取舍（所以默认不开）：
 *   - 新 worktree 里没有 node_modules / 虚拟环境 / 构建产物，DSH 往往要重装依赖；
 *   - 基于主检出当前的 HEAD 提交，主检出里**未提交**的改动不会带过去（结果里会提示）；
 *   - 改动留在分支 `dsh/<时间戳>-<随机>` 上，由调用方审核后自己合并，本服务从不自动合并。
 *
 * 位置：放在本服务的状态目录下（`<状态目录>/worktrees/`），不放进仓库里，
 * 免得在主检出里多出一个未跟踪目录。
 *
 * 安全：`git worktree add` 会触发仓库的 post-checkout 钩子，而仓库可能不可信（同
 * git-snapshot.mjs 关掉 fsmonitor 的理由）。这里把 core.hooksPath 指到一个空目录，
 * 不跑仓库的任何钩子；代价是像 husky 这类在 checkout 时装东西的钩子也不会跑。
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { STATE_FILE } from './config.mjs';
import { L } from './lang.mjs';

const execFileAsync = promisify(execFile);

/** dsh_start 的 isolation 取值：none（默认，用原目录）/ worktree。 */
export const ISOLATION_MODES = ['none', 'worktree'];

/** worktree 默认放在这里（与注册表同一个状态目录）。 */
export const WORKTREES_DIR = process.env.DSH_MCP_WORKTREES_DIR ?? join(dirname(STATE_FILE), 'worktrees');

/** 一个保证为空的钩子目录：让 git 不跑仓库自带的任何钩子。 */
function noHooksDir(root) {
  const dir = join(root, '.no-hooks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(cwd, args, root) {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksDir(root)}`, ...args],
    { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
  );
  return stdout.trim();
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'repo';

/**
 * 为 cwd 所在的 git 仓库新建一个 worktree 和分支。
 * @returns {Promise<{path, branch, base, repo, cwd, main_dirty, created_at}>}
 *   cwd 是会话该用的工作目录：原 cwd 若是仓库的子目录，就映射到 worktree 里同一个子目录。
 */
export async function createWorktree(cwd, { root = WORKTREES_DIR } = {}) {
  mkdirSync(root, { recursive: true });
  let repo;
  try {
    repo = resolve(await git(cwd, ['rev-parse', '--show-toplevel'], root));
  } catch {
    throw new Error(L(
      `isolation=worktree 需要 cwd 在一个 git 仓库里：${cwd} 不是（或本机没有 git）。`,
      `isolation=worktree needs cwd inside a git repository: ${cwd} is not one (or git is not installed).`,
    ));
  }
  let base;
  try {
    base = await git(repo, ['rev-parse', 'HEAD'], root);
  } catch {
    throw new Error(L(
      `isolation=worktree 需要仓库至少有一个提交：${repo} 还没有。`,
      `isolation=worktree needs at least one commit in the repository: ${repo} has none yet.`,
    ));
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const slug = `${stamp}-${randomBytes(2).toString('hex')}`;
  const branch = `dsh/${slug}`;
  const path = join(root, `${safeName(basename(repo))}-${slug}`);
  await git(repo, ['worktree', 'add', '-b', branch, path, base], root);
  const mainDirty = (await git(repo, ['status', '--porcelain'], root).catch(() => '')) !== '';
  const rel = relative(repo, resolve(cwd));
  const sub = rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(path, rel) : path;
  return {
    path,
    branch,
    base,
    repo,
    // 子目录在主检出里是未跟踪的（worktree 里没有）时，退回 worktree 根。
    cwd: existsSync(sub) ? sub : path,
    main_dirty: mainDirty,
    created_at: new Date().toISOString(),
  };
}

/**
 * forget 时收尾：worktree 干净才删目录（分支始终保留，提交不会丢）；有未提交改动就留着。
 * 永不抛错。
 */
export async function removeWorktree(wt, { root = WORKTREES_DIR } = {}) {
  if (!wt?.path) return { removed: false, reason: 'none' };
  const info = { path: wt.path, branch: wt.branch ?? null };
  if (!existsSync(wt.path)) return { removed: false, reason: 'missing', ...info };
  try {
    const dirty = (await git(wt.path, ['status', '--porcelain'], root)) !== '';
    if (dirty) return { removed: false, reason: 'dirty', ...info };
    await git(wt.repo ?? wt.path, ['worktree', 'remove', wt.path], root);
    return { removed: true, ...info };
  } catch (e) {
    return { removed: false, reason: `error: ${e.message.split('\n')[0]}`, ...info };
  }
}

/** 建会话失败时撤销刚建的 worktree 和分支（它们还没有任何改动）。永不抛错。 */
export async function discardWorktree(wt, { root = WORKTREES_DIR } = {}) {
  if (!wt?.path) return;
  try {
    await git(wt.repo, ['worktree', 'remove', '--force', wt.path], root);
  } catch {
    /* 目录可能已经没了 */
  }
  try {
    await git(wt.repo, ['branch', '-D', wt.branch], root);
  } catch {
    /* 分支可能已经没了 */
  }
}
