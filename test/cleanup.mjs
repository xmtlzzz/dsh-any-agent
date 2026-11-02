/**
 * 测试套件收尾清理（也可单独运行）。
 *
 * 只清理**临时目录**里的测试残留：测试会话、临时工作区登记、空分桶、以及崩溃遗留的临时工作区目录。
 *
 * 明确**不碰**：
 *   - 真实项目目录里的会话（例如 Desktop\SF6HACK）—— 那是你的活数据
 *   - 仓库 `.state/`（真实使用 MCP 时的会话注册表与哨兵文件）
 *   - 桌面 `dsh-any-agent-test-*` —— 要删它得显式跑
 *     `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`
 *
 * 用法：node test/cleanup.mjs [--dry-run]
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWorkspaces,
  pruneEmptyWorkspaces,
  pruneTestWorkspaces,
  purgeTestSessions,
} from '../src/workspace.mjs';

const dryRun = process.argv.includes('--dry-run');
const flag = dryRun ? '[预演] ' : '';
const log = (s) => console.log(s);

log(`${flag}测试收尾清理（只针对本仓库测试造出来的目录；不动真实项目与 .state/）\n`);
log('  规则：只删 cwd 在 tmpdir()/dsh-any-agent-* 下、或桌面 dsh-any-agent-test-* 的会话；');
log('        用户在 %TEMP% 里自己的真实项目不会被碰。\n');

// 1) 本仓库测试造的临时会话
const purged = purgeTestSessions({ dryRun, testOnly: true });
log(`  测试会话：删除 ${purged.count} 个`);
for (const v of purged.victims.slice(0, 10)) log(`    - ${v.id}  cwd=${v.cwd}`);
if (purged.victims.length > 10) log(`    …还有 ${purged.victims.length - 10} 个`);

// 2) ★ 测试用的工作区登记（临时 dsh-any-agent-* 与桌面 dsh-conc-* 之类）——
//     只删文件夹不删登记的话，每跑一次全量测试就会在你的 GUI 侧栏里多留几个空壳。
//     不再自动跑 pruneTempWorkspaces：那会把用户在 %TEMP% 里的真实工作区登记也删掉。
const testWs = pruneTestWorkspaces({ dryRun });
log(`  测试工作区登记：删除 ${testWs.removed.length} 个`);
if (testWs.error) log(`    ⚠️ 跳过（${testWs.error}）`);
for (const w of testWs.removed.slice(0, 8)) log(`    - ${w.path}`);

// 3) 空工作区（无会话且路径已不存在）
const emptyWs = pruneEmptyWorkspaces({ dryRun });
log(`  空工作区：删除 ${emptyWs.removed.length} 个`);
if (emptyWs.error) log(`    ⚠️ 跳过（${emptyWs.error}）`);

// 4) 崩溃遗留的临时工作区目录（各测试用 mkdtempSync 造在系统临时目录下，正常路径会自删）
let dirsRemoved = 0;
try {
  for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    // 只认本项目测试的命名前缀，避免误伤别人的临时目录。
    // ★ 用 `dsh-any-agent-` 通配而不是逐个列举：以前是白名单，结果每加一个新套件就漏一个，
    //   临时目录会慢慢堆积（demo/verify/permission/multi/list/prune/cycle/guards 全漏过）。
    if (!/^dsh-any-agent-/.test(e.name)) continue;
    const p = join(tmpdir(), e.name);
    if (!dryRun) rmSync(p, { recursive: true, force: true });
    dirsRemoved++;
  }
} catch {
  /* 临时目录不可读就算了 */
}
log(`  遗留临时工作区目录：删除 ${dirsRemoved} 个`);

// 4b) 桌面上遗留的测试文件夹（`dsh-any-agent-test-A/B`、`dsh-conc-*`）——
//     验收测试与旧版并发测试会在这两个位置造真实工作区。验收测试自己会删；
//     这里默认**不动**，避免误删恰好同名的用户目录；确实要清时设
//     DSH_MCP_PURGE_DESKTOP=1。DSH_MCP_KEEP_EVIDENCE=1 仍优先跳过。
let foldersRemoved = 0;
if (process.env.DSH_MCP_KEEP_EVIDENCE === '1') {
  log('  桌面测试文件夹：已跳过（DSH_MCP_KEEP_EVIDENCE=1）');
} else if (process.env.DSH_MCP_PURGE_DESKTOP !== '1') {
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

// 5) 事后核对
if (!dryRun) {
  const list = listWorkspaces();
  const temp = list.filter((w) => w.is_temp);
  log(`\n  清理后注册表：共 ${list.length} 个工作区，其中临时目录 ${temp.length} 个`);
  if (temp.length) for (const w of temp) log(`    [临时] ${w.path}`);
  log('  （真实项目里的会话与仓库 .state/ 一律未动）');
}