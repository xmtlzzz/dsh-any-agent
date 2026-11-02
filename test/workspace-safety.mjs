/**
 * 工作区注册表 / 测试会话清理的安全边界（纯文件系统，不花 token）。
 *
 * 这些用例守的是"不可恢复的数据丢失"：
 *   [1] isTempPath 必须按路径分段，不能把 tmpdir()+'Suffix'、/tmpfoo 当临时目录
 *   [2] workspace.json 坏掉时 fail-closed：不覆盖、不返回空结构继续写
 *   [3] 自动清理只删本仓库测试造的目录，绝不碰用户在 %TEMP% 里的真实项目
 *   [4] 会话目录不可读时 backfill 不清空注册表
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-workspace-safety-'));
const home = join(root, 'home');
process.env.DSH_HOME = home;
process.env.DSH_MCP_REGISTER_WORKSPACE = 'all';

const ws = await import('../src/workspace.mjs');

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

const workspaceFile = join(home, 'storages', 'workspace.json');
const sessionsRoot = join(home, 'sessions');

function writeWorkspace(obj) {
  mkdirSync(dirname(workspaceFile), { recursive: true });
  writeFileSync(workspaceFile, JSON.stringify(obj, null, 2), 'utf8');
}

function seedSession(id, cwd, bucket = 'bk') {
  const dir = join(sessionsRoot, bucket, id);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', id, cwd, createdAt: Date.now() }) + '\n';
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(header, 'utf8')));
  return dir;
}

try {
  console.log('\n[1] isTempPath 的路径分段');
  const sibling = join(dirname(tmpdir()), basename(tmpdir()) + 'Suffix', 'proj');
  check('真正的临时目录内为 true', ws.isTempPath(join(tmpdir(), 'dsh-any-agent-x')));
  check('★ 同前缀兄弟目录为 false', ws.isTempPath(sibling) === false, sibling);
  check('★ tmpdir()/../TempSuffix 为 false', ws.isTempPath(join(tmpdir(), '..', 'TempSuffix')) === false);
  check('普通项目目录为 false', ws.isTempPath(join(homedir(), 'dsh-any-agent-not-temp-proj')) === false);
  check('测试临时目录识别为 true', ws.isTestTempPath(join(tmpdir(), 'dsh-any-agent-foo', 'ws')));
  check('★ 用户自己的临时项目不算测试目录', ws.isTestTempPath(join(tmpdir(), 'real-project', 'ws')) === false);

  console.log('\n[2] workspace.json 坏掉时 fail-closed');
  const broken = '{ this is not json';
  mkdirSync(dirname(workspaceFile), { recursive: true });
  writeFileSync(workspaceFile, broken, 'utf8');
  const reg = ws.registerWorkspace(join(root, 'project'), 'session-1');
  check('registerWorkspace 返回失败', reg.registered === false, JSON.stringify(reg));
  check('错误信息说明无法解析', /无法解析/.test(String(reg.error)), String(reg.error));
  check('★ 坏文件字节未被覆盖', readFileSync(workspaceFile, 'utf8') === broken);
  const pr = ws.pruneEmptyWorkspaces();
  check('pruneEmptyWorkspaces 返回 error', Boolean(pr.error), JSON.stringify(pr));
  check('★ prune 之后坏文件仍然原样', readFileSync(workspaceFile, 'utf8') === broken);
  let listThrew = false;
  try { ws.listWorkspaces(); } catch { listThrew = true; }
  check('listWorkspaces 对坏文件抛错（CLI 可显示）', listThrew);

  console.log('\n[3] 会话目录不可读时 backfill 不清空注册表');
  const emptyDoc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['keep'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: null },
    tables: { workspaces: { keep: { path: join(root, 'keep'), title: 'keep', sessionIds: ['s-keep'], createdAt: '', updatedAt: '' } } },
  };
  writeWorkspace(emptyDoc);
  const missingRoot = ws.backfillWorkspaces();
  check('backfill 返回 error（不是空统计）', Boolean(missingRoot.error), JSON.stringify(missingRoot));
  check('★ 注册表里的 sessionIds 没被清空', JSON.parse(readFileSync(workspaceFile, 'utf8')).tables.workspaces.keep.sessionIds.includes('s-keep'));

  console.log('\n[4] 自动清理只删测试造的会话');
  writeWorkspace({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['real'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: null },
    tables: { workspaces: { real: { path: join(root, 'real'), title: 'real', sessionIds: [], createdAt: '', updatedAt: '' } } },
  });
  const testDir = seedSession('session-test', join(tmpdir(), 'dsh-any-agent-purge-ws', 'ws'));
  const realDir = seedSession('session-real', join(tmpdir(), 'real-project', 'ws'));
  const desktopDir = seedSession('session-desktop', join(homedir(), 'Desktop', 'dsh-any-agent-test-A'));
  const dry = ws.purgeTestSessions({ testOnly: true, dryRun: true });
  check('dry-run 命中测试目录与桌面测试目录', dry.victims.some((v) => v.id === 'session-test') && dry.victims.some((v) => v.id === 'session-desktop'), JSON.stringify(dry.victims.map((v) => v.id)));
  check('dry-run 不碰真实临时项目', dry.victims.every((v) => v.id !== 'session-real'), JSON.stringify(dry.victims.map((v) => v.id)));
  check('dry-run 不删任何目录', existsSync(testDir) && existsSync(realDir));
  const purged = ws.purgeTestSessions({ testOnly: true });
  check('实际清理删掉测试会话', !existsSync(testDir), testDir);
  check('★ 用户在 %TEMP% 的真实项目会话保留', existsSync(realDir), realDir);
  check('桌面测试会话被删', !existsSync(desktopDir), desktopDir);

  console.log('\n[5] pruneTestWorkspaces 只删测试工作区');
  writeWorkspace({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['realws', 'testws'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: null },
    tables: {
      workspaces: {
        realws: { path: join(tmpdir(), 'real-project'), title: 'real', sessionIds: [], createdAt: '', updatedAt: '' },
        testws: { path: join(tmpdir(), 'dsh-any-agent-test-ws'), title: 'test', sessionIds: [], createdAt: '', updatedAt: '' },
      },
    },
  });
  const tw = ws.pruneTestWorkspaces();
  const after = JSON.parse(readFileSync(workspaceFile, 'utf8'));
  check('测试工作区登记被删', !after.tables.workspaces.testws, JSON.stringify(after.tables.workspaces));
  check('★ 用户真实临时工作区登记保留', Boolean(after.tables.workspaces.realws), JSON.stringify(after.tables.workspaces));
  check('返回值只包含测试项', tw.removed.length === 1 && tw.removed[0].id === 'testws', JSON.stringify(tw.removed));
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== workspace safety 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
