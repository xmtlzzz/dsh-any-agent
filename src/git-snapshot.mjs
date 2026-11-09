/**
 * 工作区 git 快照：回合前后各取一次，用来回答"这一轮有没有改工作区"（workspace_changed）。
 *
 * 从 hub.mjs 拆出来：这部分只有纯函数与异步 git 子进程调用，不依赖任何会话/注册表状态，
 * 所以能单独加载与测试（test/workspace-snapshot.mjs）。hub.mjs 仍然重新导出
 * `gitStatus` / `sameWorkspaceSnapshot`，外部的导入路径不变。
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 两次 workspace 快照是否表示同一组工作区变更。
 *
 * 优先比较 `fingerprint`（覆盖**全量**条目：状态行 + 每个路径的 size/mtime，
 * 未跟踪目录递归展开）。只比较前 40 条 entries 会把"同一状态行但内容变了"
 * 和第 41 条之后的改动都漏掉（workspace_changed 假阴性）。
 */
export function sameWorkspaceSnapshot(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (typeof a.fingerprint === 'string' && typeof b.fingerprint === 'string') {
    return a.fingerprint === b.fingerprint;
  }
  // 兼容旧快照/测试里手写的 { changed_files, entries }。
  return JSON.stringify(a.entries ?? []) === JSON.stringify(b.entries ?? []);
}

const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_DIR_ENTRIES = 2000;
const execFileAsync = promisify(execFile);

/**
 * 安全 git 参数（放 subcommand 之前）。
 *
 * `--no-optional-locks` 是 **git 全局选项**，放在 `status` 之后会被 git 当成
 * 未知参数直接退出 129 —— 那样快照永远是 null，workspace_changed 恒为 false。
 */
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
}

/** 异步跑一次 git 并取 stdout；非 git 目录/超时/输出过大都抛给调用方。 */
async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: gitEnv(),
  });
  return stdout;
}

/**
 * 把仓库配置里出现的所有 filter 驱动都置空的 `-c` 参数。
 *
 * ★ `git status` 在文件 stat 变了时会对它跑 clean filter（`.gitattributes` 选驱动名，
 *   `.git/config` 定义命令）。快照在宿主机上、DSH 沙箱与审批层之外执行，不可信仓库的
 *   本地配置就能借此执行任意命令（审计 A01）。命令行 `-c` 优先级最高，空值即不跑，
 *   `required=false` 让 git 不因“没有 filter”而报错。
 *   驱动名含 `=` 时 `-c` 无法无歧义地表达，直接拒绝快照（fail closed）。
 */
async function filterOverrides(cwd) {
  let out;
  try {
    out = await gitOutput(cwd, [...GIT_SAFE, 'config', '-z', '--get-regexp', '^filter\\.']);
  } catch (e) {
    if (e?.code === 1) return []; // 没有任何 filter 配置
    throw e;
  }
  const names = new Set();
  for (const entry of String(out ?? '').split('\0')) {
    const key = entry.split('\n', 1)[0];
    const dot = key.lastIndexOf('.');
    if (dot > 'filter.'.length) names.add(key.slice('filter.'.length, dot));
  }
  const args = [];
  for (const name of names) {
    if (name.includes('=')) throw new Error(`refusing filter driver name with '=': ${name}`);
    for (const k of ['clean', 'smudge', 'process']) args.push('-c', `filter.${name}.${k}=`);
    args.push('-c', `filter.${name}.required=false`);
  }
  return args;
}

/** HEAD 的提交号；未出生分支（还没有提交）返回空串。 */
async function headOid(cwd) {
  try {
    return String(await gitOutput(cwd, [...GIT_SAFE, 'rev-parse', '-q', '--verify', 'HEAD'])).trim();
  } catch (e) {
    if (e?.code === 1) return '';
    throw e;
  }
}

/** 解析 porcelain v1 -z 状态行；rename/copy 的“原路径”是下一个 NUL 段。 */
function parsePorcelainZ(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    // 形如 "XY path"；posix 允许路径里有空格，所以只切前三个字符。
    if (token.length < 4 || token[2] !== ' ') continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    let orig = null;
    if (/[RC]/.test(status)) orig = tokens[++i] || null;
    rows.push({ status, path, orig });
  }
  return rows;
}

/**
 * 把一个路径的当前状态（类型 + size + mtimeMs）混进指纹。
 *
 * - 普通文件：size + mtimeMs 足以识别"状态行没变、内容变了"；
 * - 未跟踪目录（`?? dir/`）：目录 mtime 只在直接子项增删时变，光看它不够，
 *   所以递归展开（只用 lstat，不跟随符号链接/不钻 .git，且有预算上限）；
 * - 已跟踪的目录条目（子模块）：只看它自己的 lstat，避免把子模块整个走一遍。
 */
function hashPathStat(hash, full, label, budget) {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    hash.update(`${label}\0missing\0`);
    return;
  }
  if (st.isDirectory() && budget) {
    hash.update(`${label}\0dir\0${st.mtimeMs}\0`);
    let entries;
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch {
      hash.update('unreadable\0');
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      if (budget.left <= 0) {
        hash.update(`${label}\0truncated\0`);
        return;
      }
      budget.left -= 1;
      hashPathStat(hash, join(full, ent.name), `${label}/${ent.name}`, budget);
    }
    return;
  }
  const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  hash.update(`${label}\0${kind}\0${st.size}\0${st.mtimeMs}\0`);
}

/**
 * 收集当前工作区的 git 变更摘要（非 git 目录返回 null）。
 *
 * 异步实现：`execFile` 不占用事件循环 —— 一个 MCP 服务进程承载多个会话，
 * 同步 `spawnSync` 最长 8s 会把所有会话的 ACP 消息/审批一起卡住。
 *
 * 返回对象向后兼容：`changed_files` = 全量状态条目数，`entries` = 前 40 条
 * 展示用状态行；新增 `fingerprint` 覆盖**全量**条目（含逐路径 size/mtime），
 * 供 `sameWorkspaceSnapshot` 判断"内容是否真的变了"。
 */
export async function gitStatus(cwd) {
  if (process.env.DSH_MCP_GIT_STATUS === '0') return null;
  try {
    // ★ 在不可信仓库里 `git status` 可能触发仓库配置的 fsmonitor/filter；这些
    //   命令发生在 DSH 沙箱与审批层之外。禁用可选锁与 fsmonitor，并允许用
    //   DSH_MCP_GIT_STATUS=0 完全关掉。
    // porcelain 的路径相对 **仓库根**（cwd 是子目录时也是），所以同时取 top-level。
    // ★ 先置空仓库配置的 filter 驱动；`--ignore-submodules=dirty` 让 git 不再钻进子模块
    //   跑它们自己的 status（子模块的配置同样不可信，且不受上面那组 `-c` 的驱动名覆盖）。
    const noFilters = await filterOverrides(cwd);
    const [statusOut, rootOut, head] = await Promise.all([
      gitOutput(cwd, [...GIT_SAFE, ...noFilters, 'status', '--porcelain', '-z', '--ignore-submodules=dirty']),
      gitOutput(cwd, [...GIT_SAFE, 'rev-parse', '--show-toplevel']),
      headOid(cwd),
    ]);
    const rows = parsePorcelainZ(statusOut);
    // ★ HEAD 参与指纹：回合内“改完就提交”前后都是干净状态，只看状态行会判成没变（审计 A05）。
    // ★ 干净的仓库返回“0 个改动”的快照，而不是 null：null 专指“拿不到快照”（非 git 目录、
    //   git 不可用、总开关关闭）。以前两者混用，一轮把唯一的改动删干净时就会出现
    //   workspace_changed=true 却 diff_stat=null —— 看不出是“现在干净了”还是“没查成”。
    if (!rows.length) {
      // 干净工作区的指纹只由 HEAD 决定（非空状态的指纹至少多一条状态行，不会与它相同）。
      const fingerprint = createHash('sha256').update(`clean\0${head}\0`).digest('hex');
      return { changed_files: 0, entries: [], fingerprint };
    }
    // git 输出的是 `C:/...` 风格，统一成原生分隔符，后面 startsWith 才不会误判越界。
    const root = resolve(String(rootOut ?? '').trim() || cwd);

    // 状态行按路径排序后参与指纹，避免依赖 git 的输出顺序。
    const sorted = rows
      .slice()
      .sort((a, b) =>
        a.path === b.path
          ? a.status < b.status
            ? -1
            : a.status > b.status
              ? 1
              : 0
          : a.path < b.path
            ? -1
            : 1,
      );

    const hash = createHash('sha256');
    hash.update(`head\0${head}\0`);
    const budget = { left: MAX_UNTRACKED_DIR_ENTRIES };
    const entries = [];
    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    for (const row of sorted) {
      const display = row.orig ? `${row.status} ${row.orig} -> ${row.path}` : `${row.status} ${row.path}`;
      if (entries.length < 40) entries.push(display);
      hash.update(display);
      hash.update('\0');

      const cleanPath = row.path.endsWith('/') ? row.path.slice(0, -1) : row.path;
      const full = resolve(root, cleanPath);
      if (full !== root && !full.startsWith(rootPrefix)) {
        hash.update('outside-worktree\0');
        continue;
      }
      // 只有未跟踪目录需要递归；已跟踪条目（含子模块）看 lstat 即可。
      hashPathStat(hash, full, cleanPath, row.status === '??' ? budget : null);
    }

    return {
      changed_files: rows.length,
      entries,
      fingerprint: hash.digest('hex'),
    };
  } catch {
    return null;
  }
}
