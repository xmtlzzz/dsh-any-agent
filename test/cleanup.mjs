/**
 * 测试套件收尾清理（也可单独运行）。**兜底**：各真机套件自己会在 finally 里精确清理
 * （见 test/residue.mjs）；这里处理"进程被杀、finally 没跑到"以及旧版本留下的残留。
 *
 * 清理对象：测试造出来的会话与它的**全部**产物——
 *   DSH 侧：会话日志、投影缓存（session_projcache）、工作区登记、forget 墓碑；
 *   本项目侧：注册表条目、元数据侧车、哨兵（runs）、审核（reviews）、写锁登记（locks）；
 * 外加：空壳测试工作区登记、投影缓存里的测试孤儿、`%TEMP%` 根下旧版遗留的扁平状态目录、
 * 崩溃遗留的临时工作区目录与状态文件。
 *
 * ★ 只认"cwd 是测试目录"的会话（src/workspace.mjs 的 isTestSessionCwd）：
 *   当前进程 `tmpdir()/dsh-any-agent-*`、桌面 `dsh-any-agent-test-A|B`、本仓库 `.state/ws-probe-*`。
 *   谁的 TMP 指到别处（并行 agent 的 `C:\dsh-agent-tmp\...`），他们的会话对这里就不是测试目录，
 *   一根毫毛都不动 —— 谁造的谁清。
 *
 * 明确**不碰**：
 *   - 真实项目目录里的会话（例如 Desktop\SF6HACK）—— 那是你的活数据
 *   - 仓库 `.state/` 里除 ws-probe-* 以外的内容
 *   - 桌面 `dsh-any-agent-test-*` 文件夹本身 —— 要删它得设 DSH_MCP_PURGE_DESKTOP=1
 *
 * 用法：node test/cleanup.mjs [--dry-run]
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaces } from '../src/workspace.mjs';
import { sweepTestResidue } from '../src/residue.mjs';

const dryRun = process.argv.includes('--dry-run');
const flag = dryRun ? '[预演] ' : '';
const log = (s) => console.log(s);

log(`${flag}测试收尾清理（只针对本仓库测试造出来的目录；不动真实项目与 .state/）\n`);
log('  规则：只删 cwd 在 tmpdir()/dsh-any-agent-*、桌面 dsh-any-agent-test-A|B、本仓库 .state/ws-probe-* 的会话；');
log('        用户在 %TEMP% 里自己的真实项目、别的 agent 的临时根（TMP 指到别处）都不会被碰。\n');

// ★ 保留证据模式必须在**任何**清扫之前生效：acceptance / workspace-effect 在
//   DSH_MCP_KEEP_EVIDENCE=1 时故意留下桌面测试工作区里的会话和 `%TEMP%\dsh-any-agent-*`
//   状态目录供人工查看，而 run.mjs 每次都会在最后调用本脚本。以前这个开关只挡住了第 5b 步
//   （桌面文件夹），第 1 步的会话清扫和第 5 步的临时目录清扫照样把证据删掉了（PR #11 评审）。
//   看完证据后不带这个开关再跑一次 `node test/cleanup.mjs` 即可收尾。
if (process.env.DSH_MCP_KEEP_EVIDENCE === '1') {
  log('  ★ DSH_MCP_KEEP_EVIDENCE=1：整轮清理已跳过，测试会话、状态目录与桌面测试文件夹全部原样保留。');
  log('    看完证据后，不带这个开关再运行一次 node test/cleanup.mjs 收尾。');
  process.exit(0);
}

const r = sweepTestResidue({ dryRun });

// 1) 测试会话（DSH 侧产物随会话一起走：日志、投影缓存、登记、墓碑）
log(`  测试会话：删除 ${r.sessions.count} 个（含投影缓存/工作区登记/墓碑）`);
for (const v of r.sessions.victims.slice(0, 10)) log(`    - ${v.id}  [${v.reason}]  cwd=${v.cwd}`);
if (r.sessions.victims.length > 10) log(`    …还有 ${r.sessions.victims.length - 10} 个`);
for (const v of r.sessions.victims.filter((x) => x.error)) log(`    ⚠️ 删除失败 ${v.id}: ${v.error}`);
for (const s of r.sessions.skipped) log(`    ⚠️ 拒绝删除 ${s.id}：${s.reason}（cwd=${s.cwd}）`);

// 2) 本项目侧 per-run 数据（当前配置的状态目录 + %TEMP% 根下旧版扁平目录）
const removed = { ...r.project.removed };
for (const k of Object.keys(removed)) removed[k] += r.legacy.removed[k];
log(
  `  本项目 per-run 数据：注册表条目 ${removed.registry}、元数据 ${removed.meta}、哨兵目录 ${removed.runs}、` +
    `审核目录 ${removed.reviews}、锁登记 ${removed.locks}、事件流 ${removed.live ?? 0}`,
);
if (r.legacy.dirsRemoved.length) log(`    收掉空的旧版扁平目录 ${r.legacy.dirsRemoved.length} 个（%TEMP% 根下 runs/reviews/locks/meta）`);
for (const e of [...r.project.errors, ...r.legacy.errors]) log(`    ⚠️ ${e}`);

// 3) 投影缓存里的测试孤儿
log(
  `  投影缓存测试孤儿：删除 ${r.orphans.count} 个（${(r.orphans.bytes / 1024).toFixed(1)} KB）；` +
    `认不出是测试的 ${r.orphans.kept_non_test} 个原样保留`,
);
if (r.orphans.error) log(`    ⚠️ 跳过（${r.orphans.error}）`);

// 4) 测试用的工作区登记（临时 dsh-any-agent-* 与桌面 dsh-conc-* 之类）——
//     只删文件夹不删登记的话，每跑一次全量测试就会在你的 GUI 侧栏里多留几个空壳。
//     ★ 不再跑 pruneEmptyWorkspaces：它按"无会话且路径不存在"的启发式删，会误伤
//       用户**真实**的空工作区登记（比如暂时没挂载的盘）；这里只按路径模式删测试的。
log(`  测试工作区登记：删除 ${r.workspaces.removed.length} 个`);
if (r.workspaces.error) log(`    ⚠️ 跳过（${r.workspaces.error}）`);
for (const w of r.workspaces.removed.slice(0, 8)) log(`    - ${w.path}`);

// 5) 崩溃遗留的临时工作区目录与状态文件（各测试用 mkdtempSync 造在系统临时目录下，正常路径会自删）
let dirsRemoved = 0;
let filesRemoved = 0;
try {
  for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
    // 只认本项目测试的命名前缀，避免误伤别人的临时目录。
    // ★ 用 `dsh-any-agent-` 通配而不是逐个列举：以前是白名单，结果每加一个新套件就漏一个，
    //   临时目录会慢慢堆积（demo/verify/permission/multi/list/prune/cycle/guards 全漏过）。
    if (!/^dsh-any-agent-/.test(e.name)) continue;
    const p = join(tmpdir(), e.name);
    if (e.isDirectory()) {
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      dirsRemoved++;
    } else if (e.isFile() && /^dsh-any-agent-[a-z0-9-]+-state-\d+\.json(\.tmp\..+)?$/.test(e.name)) {
      // 旧版套件把注册表直接放在 %TEMP% 根下（`dsh-any-agent-<套件>-state-<毫秒>.json`），
      // 崩溃时不会自删。**只认这个严格形状**：同前缀的 .txt/.md 是别人的提交信息/PR 正文。
      if (!dryRun) rmSync(p, { force: true });
      filesRemoved++;
    }
  }
} catch {
  /* 临时目录不可读就算了 */
}
log(`  遗留临时工作区目录：删除 ${dirsRemoved} 个；遗留状态文件：删除 ${filesRemoved} 个`);

// 5b) 桌面上遗留的测试文件夹（`dsh-any-agent-test-A/B`、`dsh-conc-*`）——
//     验收测试与旧版并发测试会在这两个位置造真实工作区。验收测试自己会删；
//     这里默认**不动**，避免误删恰好同名的用户目录；确实要清时设
//     DSH_MCP_PURGE_DESKTOP=1。（DSH_MCP_KEEP_EVIDENCE=1 时整个脚本在开头就已退出。）
let foldersRemoved = 0;
if (process.env.DSH_MCP_PURGE_DESKTOP !== '1') {
  // ★ 默认不自动删桌面上的固定名字目录：用户的真实项目可能恰好叫这个名字。
  //   验收测试自己会删它创建的那两个目录；这里只保留手动入口。
  log('  桌面遗留测试文件夹：已跳过（需要时设 DSH_MCP_PURGE_DESKTOP=1）');
} else {
  try {
    const desktop = join(homedir(), 'Desktop');
    for (const name of ['dsh-any-agent-test-A', 'dsh-any-agent-test-B', 'dsh-conc-A', 'dsh-conc-B', 'dsh-conc-C']) {
      const p = join(desktop, name);
      if (!existsSync(p)) continue;
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      foldersRemoved++;
    }
  } catch {
    /* 桌面不可读就算了 */
  }
  log(`  桌面遗留测试文件夹：删除 ${foldersRemoved} 个`);
}

// 6) 事后核对
if (!dryRun) {
  const list = listWorkspaces();
  const temp = list.filter((w) => w.is_temp);
  log(`\n  清理后注册表：共 ${list.length} 个工作区，其中临时目录 ${temp.length} 个`);
  if (temp.length) for (const w of temp) log(`    [临时] ${w.path}`);
  log('  （真实项目里的会话与仓库 .state/ 一律未动）');
}
