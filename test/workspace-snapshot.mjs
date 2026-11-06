/**
 * 工作区快照（workspace_changed）与异步 gitStatus 的离线回归。
 *
 * 守住两条已确认的坑：
 *   1) 只比较前 40 条 `git status` 状态行会漏报：
 *        a. 回合前文件已是 ` M foo.js`，回合内再改内容 → 状态行完全相同；
 *        b. 脏文件超过 40 个，改动发生在第 41 条之后 → entries 看不到。
 *      快照的 fingerprint 必须覆盖**全量**条目与逐路径 size/mtime
 *      （未跟踪目录 `?? dir/` 递归展开）。
 *   2) gitStatus 曾经是 spawnSync：一个 MCP 服务进程承载多个会话，最长 8s
 *      会卡住所有 ACP 消息/审批。现在是异步的，git 在跑时定时器必须照常触发。
 *
 * 临时目录一律 os.tmpdir() + mkdtemp，收尾经 sandbox-home 的守卫删除。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSafeSandbox, removeSandbox } from './sandbox-home.mjs';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-workspace-snapshot-'));
assertSafeSandbox(root);
// 只在本临时树里发现仓库；同时保证 not-a-repo 不会被上层仓库“认领”。
process.env.GIT_CEILING_DIRECTORIES = root;
process.env.DSH_HOME = join(root, 'home');
delete process.env.DSH_MCP_STATE;
delete process.env.DSH_MCP_RUNS_DIR;
delete process.env.DSH_MCP_LOCKS_DIR;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.error?.message}`);
  return String(r.stdout ?? '');
}

function makeRepo(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'workspace snapshot test');
  return dir;
}

function commitAll(dir) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

const { gitStatus, sameWorkspaceSnapshot } = await import('../src/hub.mjs');

try {
  console.log('\n[1] 同一状态行但内容变了（回合前已经是 M foo.js）');
  {
    const repo = makeRepo('same-line');
    writeFileSync(join(repo, 'foo.js'), 'export const v = 1;\n');
    commitAll(repo);
    writeFileSync(join(repo, 'foo.js'), 'export const v = 2;\n'); // 回合前已脏
    const before = await gitStatus(repo);
    check('非 git 变更能取到快照', before !== null && before.changed_files === 1, JSON.stringify(before));
    check('条目就是 " M foo.js"', before?.entries?.[0] === ' M foo.js', JSON.stringify(before?.entries));

    writeFileSync(join(repo, 'foo.js'), 'export const v = 3;\n'); // 回合内再改
    const after = await gitStatus(repo);
    check('状态行仍然完全相同', JSON.stringify(before?.entries) === JSON.stringify(after?.entries), JSON.stringify(after?.entries));
    check('★ fingerprint 不同（内容变了）', before?.fingerprint !== after?.fingerprint, `${before?.fingerprint} vs ${after?.fingerprint}`);
    check('★ 判定为 workspace_changed', sameWorkspaceSnapshot(before, after) === false);

    const same = await gitStatus(repo);
    check('★ 什么都不改 → 判定为未变化', sameWorkspaceSnapshot(after, same) === true);
  }

  console.log('\n[2] 脏文件 > 40，改动落在第 41 条之后');
  const repoBig = makeRepo('many-dirty');
  const TOTAL = 1200;
  for (let i = 0; i < TOTAL; i++) {
    writeFileSync(join(repoBig, `f${String(i).padStart(4, '0')}.txt`), `committed ${i}\n`);
  }
  commitAll(repoBig);
  for (let i = 0; i < TOTAL; i++) {
    writeFileSync(join(repoBig, `f${String(i).padStart(4, '0')}.txt`), `dirty ${i}\n`);
  }
  {
    const before = await gitStatus(repoBig);
    check('changed_files 统计全量条目', before?.changed_files === TOTAL, String(before?.changed_files));
    check('entries 仍只展示 40 条', before?.entries?.length === 40, String(before?.entries?.length));

    // f1150 排在第 1151 条，远在展示截断之外。
    writeFileSync(join(repoBig, 'f1150.txt'), 'dirty 1150 changed again\n');
    const after = await gitStatus(repoBig);
    check('★ entries 完全相同（旧比较方式会漏报）', JSON.stringify(before?.entries) === JSON.stringify(after?.entries));
    check('★ fingerprint 覆盖全量，判定为变化', sameWorkspaceSnapshot(before, after) === false);

    const unchanged = await gitStatus(repoBig);
    check('★ 再快照一次（无改动）判定为未变化', sameWorkspaceSnapshot(after, unchanged) === true);
  }

  console.log('\n[3] 未跟踪目录 `?? dir/` 内部内容变化');
  {
    const repo = makeRepo('untracked-dir');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    commitAll(repo);
    mkdirSync(join(repo, 'scratch'));
    writeFileSync(join(repo, 'scratch', 'a.txt'), 'one\n');
    const before = await gitStatus(repo);
    check('目录型未跟踪条目保留尾斜杠', before?.entries?.[0] === '?? scratch/', JSON.stringify(before?.entries));
    writeFileSync(join(repo, 'scratch', 'a.txt'), 'two with a different size\n');
    const after = await gitStatus(repo);
    check('★ 目录 mtime 未变也能识别内部文件变化', sameWorkspaceSnapshot(before, after) === false);
  }

  console.log('\n[3b] ★ 干净的仓库是“0 个改动”的快照，不是 null');
  {
    const repo = makeRepo('clean-after-delete');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    commitAll(repo);
    const clean0 = await gitStatus(repo);
    check('★ 干净仓库 → changed_files=0（不再是 null）', clean0 !== null && clean0.changed_files === 0 && clean0.entries.length === 0, JSON.stringify(clean0));
    mkdirSync(join(repo, '.smoke'));
    writeFileSync(join(repo, '.smoke', 'x.txt'), 'x\n');
    const dirty = await gitStatus(repo);
    rmSync(join(repo, '.smoke'), { recursive: true, force: true });
    const clean1 = await gitStatus(repo);
    check('★ 删掉唯一的改动：有变化，且 after 是 0 个改动（不是 null）', sameWorkspaceSnapshot(dirty, clean1) === false && clean1?.changed_files === 0, JSON.stringify(clean1));
    check('干净 → 干净：没有变化', sameWorkspaceSnapshot(clean0, clean1) === true);
  }

  console.log('\n[4] 非 git 目录与总开关');
  {
    const plain = join(root, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    const snap = await gitStatus(plain);
    check('非 git 目录返回 null', snap === null, JSON.stringify(snap));

    const saved = process.env.DSH_MCP_GIT_STATUS;
    process.env.DSH_MCP_GIT_STATUS = '0';
    const off = await gitStatus(repoBig);
    if (saved === undefined) delete process.env.DSH_MCP_GIT_STATUS;
    else process.env.DSH_MCP_GIT_STATUS = saved;
    check('DSH_MCP_GIT_STATUS=0 完全关闭', off === null, JSON.stringify(off));
  }

  console.log('\n[5] gitStatus 异步，不阻塞事件循环');
  {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    const startedAt = Date.now();
    const pending = gitStatus(repoBig);
    check('gitStatus 返回 Promise（可 await）', typeof pending?.then === 'function', typeof pending);
    const snap = await pending;
    const elapsed = Date.now() - startedAt;
    clearInterval(timer);
    check('异步实现仍返回完整快照', snap?.changed_files === TOTAL && typeof snap?.fingerprint === 'string');
    // 如果 git 真的跑了一会，事件循环必须在这期间继续转；git 太快 (<25ms) 时不强求。
    check(
      '★ gitStatus 运行期间定时器照常触发',
      elapsed < 25 || ticks > 0,
      `elapsed=${elapsed}ms ticks=${ticks}`,
    );
    console.log(`    gitStatus 耗时 ${elapsed}ms，期间定时器触发 ${ticks} 次`);
  }
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try {
    removeSandbox(root);
  } catch {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
}

console.log(`\n===== workspace snapshot 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
