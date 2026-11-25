#!/usr/bin/env node
/**
 * 工作区注册表维护 + 测试会话清理。
 *
 * 背景：DSH 的 GUI 按工作区分组显示会话，归属完全由 `workspace.json` 里各工作区的
 * `sessionIds` 决定；不登记就落到"未分组"。
 * ⚠️ 正在运行的 DSH 服务把注册表缓存在内存里——**改完文件需要重启 DSH 才会生效**，
 *    而且在重启前若在 GUI 里操作工作区，服务可能用内存状态把文件覆盖回去。
 *
 * 用法：
 *   node bin/dsh-any-agent-workspaces.mjs --list
 *   node bin/dsh-any-agent-workspaces.mjs --backfill [--include-temp] [--dry-run]
 *   node bin/dsh-any-agent-workspaces.mjs --prune-temp [--dry-run]
 *   node bin/dsh-any-agent-workspaces.mjs --prune-empty [--dry-run]
 *   node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions [--dry-run] [--ids=a,b]
 *
 * 只有 --purge-test-sessions 会动磁盘上的会话文件，且规则很死：只删
 * "cwd 在 tmpdir()/dsh-any-agent-* 下"、"cwd 在 Desktop\dsh-any-agent-test-A|B" 或本仓库
 * ".state/ws-probe-*" 的会话。**不会**删除用户在 %TEMP% 里自己的真实项目会话。
 * --ids=a,b 只清点名的那几个，但**点名也绕不过护栏**：cwd 不是测试目录的会被拒绝并列出。
 * 每个被删会话的全部产物一并清掉（日志、投影缓存、工作区登记、墓碑，以及本项目的
 * 注册表/元数据/哨兵/审核/锁登记）；另外清掉投影缓存里的测试孤儿。
 */

import {
  backfillWorkspaces,
  listWorkspaces,
  pruneEmptyWorkspaces,
  pruneTempWorkspaces,
  WORKSPACE_FILE,
  SESSIONS_ROOT,
} from '../src/workspace.mjs';
import { L } from '../src/lang.mjs';
import { purgeTestResidue, sweepTestResidue } from '../src/residue.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const help = [
  L('用法：dsh-any-agent-workspaces [操作] [选项]', 'Usage: dsh-any-agent-workspaces [actions] [options]'),
  '  --list                 ' + L('列出已登记的工作区（默认）', 'List registered workspaces (default)'),
  '  --backfill             ' + L('登记磁盘上已有会话的工作区', 'Register workspaces for sessions found on disk'),
  '  --include-temp         ' + L('回填时包含临时工作区', 'Include temporary workspaces during backfill'),
  '  --prune-temp           ' + L('移除临时工作区登记', 'Remove temporary workspace entries'),
  '  --prune-empty          ' + L('移除路径已不存在且无会话的工作区登记', 'Remove empty entries whose workspace directory is gone'),
  '  --purge-test-sessions  ' + L('清理符合条件的测试会话及其数据', 'Remove eligible test sessions and their stored data'),
  '  --ids=a,b              ' + L('只清理指定 ID 的测试会话', 'Limit test-session cleanup to these IDs'),
  '  --dry-run              ' + L('预览改动', 'Preview changes'),
  '  -h, --help             ' + L('显示此帮助', 'Show this help'),
].join('\n');
if (has('--help') || has('-h')) {
  console.log(help);
  process.exit(0);
}
const flags = new Set(['--list', '--backfill', '--include-temp', '--prune-temp', '--prune-empty', '--purge-test-sessions', '--dry-run']);
const invalid = argv.find(arg => {
  if (arg.startsWith('--ids=')) return arg.slice('--ids='.length).split(',').some(id => !id.trim());
  return !flags.has(arg);
});
if (invalid !== undefined) {
  console.error(L('无效参数：', 'Invalid argument: ') + invalid + '\n' + help);
  process.exit(2);
}
const dryRun = has('--dry-run');
const flag = dryRun ? L('[预演] ', '[dry run] ') : '';

console.log(L(`注册表:   ${WORKSPACE_FILE}`, `Registry: ${WORKSPACE_FILE}`));
console.log(L(`会话目录: ${SESSIONS_ROOT}`, `Sessions: ${SESSIONS_ROOT}`));
console.log(L('模式: ', 'Mode: ') + (dryRun ? L('预演', 'dry run') : L('实际执行', 'apply')) + '\n');

const ids = (val('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// ── 清理测试会话（唯一会删文件的动作） ──────────────────────
if (has('--purge-test-sessions')) {
  // 点名（--ids）= 只清这几个；否则全盘扫荡。两条路都会连带清本项目侧的 per-run 数据。
  const full = ids.length ? purgeTestResidue({ ids, dryRun }) : sweepTestResidue({ dryRun });
  const res = full.sessions;
  console.log(L(`${flag}清理测试会话：${res.count} 个`, `${flag}Test sessions selected for cleanup: ${res.count}`));
  for (const v of res.victims) {
    console.log(`  - ${v.id}  [${v.reason}]${v.origin ? ` origin=${v.origin}` : ''}  cwd=${v.cwd}`);
    if (v.error) console.log(L(`      ⚠️ 删除失败: ${v.error}`, `      Removal failed: ${v.error}`));
  }
  for (const s of res.skipped ?? []) console.log(L(`  ✗ 拒绝 ${s.id}：${s.reason}  cwd=${s.cwd}`, `  Skipped ${s.id}: ${s.reason}  cwd=${s.cwd}`));
  if (!res.count) console.log(L('  （没有命中任何会话）', 'No matching sessions.'));
  if (!dryRun) console.log(L('  已同步清掉这些会话的投影缓存、工作区登记、墓碑与本项目 per-run 数据', 'Removed associated projection caches, workspace entries, tombstones and run data.'));
  if (full.orphans) console.log(L(`${flag}  投影缓存测试孤儿：${full.orphans.count} 个`, `${flag}  Orphaned test projection caches: ${full.orphans.count}`));
  console.log('');
}

// ── 回填 ────────────────────────────────────────────────────
if (has('--backfill')) {
  const stats = backfillWorkspaces({ includeTemp: has('--include-temp'), dryRun });
  if (stats.error) {
    console.error(L(`${flag}回填失败（未写盘）：${stats.error}`, `${flag}Backfill failed before saving: ${stats.error}`));
    process.exitCode = 1;
  }
  console.log(L(`${flag}回填：`, `${flag}Backfill:`));
  console.log(L(`  扫描到会话            ${stats.sessions_scanned}`, `  Sessions scanned: ${stats.sessions_scanned}`));
  console.log(L(`  新建工作区            ${stats.workspaces_created}`, `  Workspaces created: ${stats.workspaces_created}`));
  console.log(L(`  已存在工作区          ${stats.workspaces_existing}`, `  Existing workspaces: ${stats.workspaces_existing}`));
  console.log(L(`  新挂到工作区下的会话  ${stats.sessions_added}`, `  Sessions associated: ${stats.sessions_added}`));
  console.log(L(`  摘除已消失的会话 id   ${stats.sessions_pruned}`, `  Missing session IDs removed: ${stats.sessions_pruned}`));
  if (stats.temp_skipped_workspaces) {
    console.log(L(`  跳过临时目录工作区    ${stats.temp_skipped_workspaces}（含 ${stats.temp_skipped_sessions} 个会话）`, `  Skipped temporary workspaces: ${stats.temp_skipped_workspaces} (${stats.temp_skipped_sessions} sessions)`));
  }
  console.log('');
}

// ── 清理临时工作区 ──────────────────────────────────────────
if (has('--prune-temp')) {
  const res = pruneTempWorkspaces({ dryRun });
  if (res.error) {
    console.error(L(`${flag}清理失败（未写盘）：${res.error}`, `${flag}Cleanup failed before saving: ${res.error}`));
    process.exitCode = 1;
  }
  console.log(L(`${flag}清理临时工作区条目：${res.removed.length} 个`, `${flag}Temporary workspace entries selected: ${res.removed.length}`));
  for (const r of res.removed) console.log(L(`  - ${r.path}（含 ${r.sessions} 个会话条目）`, `  - ${r.path} (${r.sessions} session entries)`));
  console.log('');
}

// ── 清理空工作区 ────────────────────────────────────────────
if (has('--prune-empty')) {
  const res = pruneEmptyWorkspaces({ dryRun });
  if (res.error) {
    console.error(L(`${flag}清理失败（未写盘）：${res.error}`, `${flag}Cleanup failed before saving: ${res.error}`));
    process.exitCode = 1;
  }
  console.log(L(`${flag}清理"无会话且路径已不存在"的工作区：${res.removed.length} 个`, `${flag}Missing empty workspaces selected: ${res.removed.length}`));
  for (const r of res.removed) console.log(`  - ${r.path}`);
  console.log('');
}

// ── 列表（或什么都不传时默认） ──────────────────────────────
if (has('--list') || argv.length === 0 || argv.every((a) => a === '--dry-run')) {
  let list;
  try {
    list = listWorkspaces();
  } catch (e) {
    console.error(L(`读取工作区注册表失败: ${e.message}`, `Could not read the workspace registry: ${e.message}`));
    process.exit(1);
  }
  const temp = list.filter((w) => w.is_temp);
  console.log(L(`共 ${list.length} 个工作区（临时目录 ${temp.length} 个）——**这是文件里的内容**：`, `Registered workspaces: ${list.length} (${temp.length} temporary)`));
  for (const w of list.sort((a, b) => Number(a.is_temp) - Number(b.is_temp))) {
    console.log(`  ${w.is_temp ? L('[临时] ', '[temp] ') : ''}${w.path}   ${L('会话', 'sessions')} ${w.sessions}`);
  }
}

if (has('--backfill') || has('--prune-temp') || has('--prune-empty') || has('--purge-test-sessions')) {
  console.log(L('提示：DSH 服务把注册表缓存在内存里 —— **需要重启 DSH** 才会读到这里的结果。', 'Restart DSH to reload the workspace registry after applying changes.'));
}
