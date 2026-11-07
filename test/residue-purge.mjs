/**
 * 测试残留清理的离线回归（不拉 DSH、不花 token；DSH_HOME 是经 sandbox-home.mjs 造的沙箱）。
 *
 * 守的是两条底线：
 *   A. 清理一个测试会话时，它在 DSH 侧与本项目侧留下的**每一种**产物都被清掉
 *      （会话日志、投影缓存、工作区登记、墓碑；注册表条目、元数据、哨兵、审核、锁登记）。
 *   B. **非测试会话**的一切（日志、缓存、登记、状态）逐字节不变 —— 点名也不行。
 *
 * 另外钉住：干跑零写入、cwd 护栏、子会话级联、roots 限定、坏文件 fail-closed、
 * 路径穿越、旧版扁平目录的"必须有证据"、以及各真机套件确实接上了收尾清理。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { makeSandboxHome, removeSandbox } from './sandbox-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 沙箱：DSH_HOME 与本项目状态目录都指进去（必须在 import 源码之前设好，config 在加载期读环境）
const sandbox = makeSandboxHome('dsh-any-agent-residue-');
const dshHome = join(sandbox, 'dsh-home');
const stateDir = join(sandbox, 'state');
process.env.DSH_HOME = dshHome;
process.env.DSH_MCP_STATE = join(stateDir, 'conversations.json');
for (const k of ['DSH_MCP_RUNS_DIR', 'DSH_MCP_REVIEWS_DIR', 'DSH_MCP_LOCKS_DIR', 'DSH_MCP_FORGOTTEN_DIR']) delete process.env[k];

const ws = await import('../src/workspace.mjs');
const residue = await import('../src/residue.mjs');
const { cleanupSuite } = await import('./residue.mjs');
const { McpClient } = await import('./mcp-client.mjs');
const { PKG_ROOT } = await import('../src/config.mjs');

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

// ── 路径与工具 ──────────────────────────────────────────────
const sessionsRoot = join(dshHome, 'sessions');
const projcacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions');
const workspaceFile = join(dshHome, 'storages', 'workspace.json');
const forgottenDir = join(dshHome, '.dsh-any-agent-forgotten');
const stateFile = process.env.DSH_MCP_STATE;
// ★ 扫荡的 %TEMP% 根必须指向沙箱：默认是真实 tmpdir()，离线测试绝不能去动真实的 %TEMP%。
const fakeTmpRoot = join(sandbox, 'fake-tmp-root');
mkdirSync(fakeTmpRoot, { recursive: true });
const metaDir = join(stateDir, 'meta');
const runsDir = join(stateDir, 'runs');
const reviewsDir = join(stateDir, 'reviews');
const locksDir = join(stateDir, 'locks');

const bucketOf = (cwd) => `--${cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '').slice(0, 251) || 'root'}--`;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const readText = (p) => readFileSync(p, 'utf8');

/** 目录下所有文件 → { 相对路径: sha256 }。 */
function treeHashes(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
const sameTree = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// ── 固定数据 ────────────────────────────────────────────────
const tmpA = join(tmpdir(), 'dsh-any-agent-fixture-A');
const tmpB = join(tmpdir(), 'dsh-any-agent-fixture-B');
const CWD = {
  testA: join(tmpA, 'ws'),
  testAChild: join(tmpA, 'sub'),
  testB: join(tmpB, 'ws'),
  desktopTest: join(homedir(), 'Desktop', 'dsh-any-agent-test-A'),
  scratch: join(PKG_ROOT, '.state', 'ws-probe-1700000000000'),
  real: join(homedir(), 'Desktop', 'code', 'game'),
  realTmp: join(tmpdir(), 'real-project', 'ws'),
  // 别的 agent 把 TMP 指到别处：名字里有 dsh-any-agent-，但不在**本进程**的 tmpdir() 下
  otherAgent: join(dirname(tmpdir()), 'dsh-agent-tmp-sim', 'dsh-any-agent-multi-X', 'wsA'),
  lookalike: join(homedir(), 'dsh-any-agent-lookalike'),
  otherState: join(PKG_ROOT, '.state', 'not-a-probe'),
  otherWorktreeScratch: join(dirname(PKG_ROOT), 'other-worktree', '.state', 'ws-probe-1700000000001'),
  desktopOther: join(homedir(), 'Desktop', 'dsh-any-agent-test-C'),
};

/** 造一个会话的全部产物。opts.registered = 同时登记进 workspace.json；opts.state = 造本项目侧数据。 */
function seed(id, cwd, { parent = null, origin = null, tombstone = true, state = true, projcache = true } = {}) {
  const dir = join(sessionsRoot, bucketOf(cwd), id);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, ...(parent ? { parentSession: parent } : {}), ...(origin ? { origin } : {}) };
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8')));
  writeFileSync(join(dir, 'extra.bin'), `payload-of-${id}`); // 会话目录里的其它文件也要一起走
  if (projcache) {
    mkdirSync(projcacheDir, { recursive: true });
    writeFileSync(join(projcacheDir, `${id}.json`), JSON.stringify({ version: 7, record: { identity: { cwd }, rows: { title: { val: `t-${id}` } } } }));
  }
  if (tombstone) {
    mkdirSync(forgottenDir, { recursive: true });
    writeFileSync(join(forgottenDir, `${id}.json`), JSON.stringify({ id, forgottenAt: 1 }));
  }
  if (state) seedState(id, cwd);
  return dir;
}

/** 本项目侧：元数据、哨兵、审核、锁登记（注册表条目在 writeRegistry 里统一写）。 */
function seedState(id, cwd) {
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, `${id}.json`), JSON.stringify({ version: 1, id, cwd, permission: 'workspace-write' }));
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, 'run-a-1.json'), JSON.stringify({ conversation_id: id, run_id: 'run-a-1', status: 'done' }));
  mkdirSync(join(reviewsDir, id), { recursive: true });
  writeFileSync(join(reviewsDir, id, 'run-a-1.review.json'), JSON.stringify({ conversation_id: id, run_id: 'run-a-1', verdict: 'pass' }));
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(join(locksDir, `${id}.json`), JSON.stringify({ conversation_id: id, cwd, childPid: 1 }));
}

const readRegistryDoc = () => JSON.parse(readText(stateFile));
const writeRegistryDoc = (entries) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 1, savedAt: 'T0', conversations: entries }, null, 2));
};
const readWs = () => JSON.parse(readText(workspaceFile));

// 会话
const S = {
  a: 'sess-test-a-0001', // tmpA/ws，有子会话
  aChild: 'sess-test-a-child', // tmpA/sub，parent=a（子代理）
  aChildReal: 'sess-test-a-child-real', // parent=a，但 cwd 是真实项目 → 级联也必须拒绝
  b: 'sess-test-b-0001', // tmpB/ws（另一个套件的根）
  desk: 'sess-test-desk-0001', // 桌面测试目录（登记过）
  scratch: 'sess-test-scratch-1', // 仓库 .state/ws-probe-*
  real: 'sess-real-0001', // 真实项目（登记过）
  realGui: 'session-1f3093be-cd81-4637-bd4e-faea3d3f4530', // GUI 风格 id
  realTmp: 'sess-real-tmp-0001', // 用户在 %TEMP% 里的真实项目
  otherAgent: 'sess-other-agent-1', // 别的 agent 的临时根
  lookalike: 'sess-lookalike-001',
  otherState: 'sess-other-state-1',
  otherWt: 'sess-other-wt-0001',
  deskC: 'sess-desk-c-0001', // 桌面 dsh-any-agent-test-C（不在 A|B 规则里）
};
const TEST_IDS = [S.a, S.aChild, S.b, S.desk, S.scratch];
const KEEP_IDS = [S.real, S.realGui, S.realTmp, S.otherAgent, S.lookalike, S.otherState, S.otherWt, S.deskC, S.aChildReal];

seed(S.a, CWD.testA);
seed(S.aChild, CWD.testAChild, { parent: S.a, origin: 'subagent' });
seed(S.aChildReal, CWD.real, { parent: S.a, origin: 'subagent' });
seed(S.b, CWD.testB);
seed(S.desk, CWD.desktopTest);
seed(S.scratch, CWD.scratch);
seed(S.real, CWD.real);
seed(S.realGui, CWD.real, { state: false });
seed(S.realTmp, CWD.realTmp);
seed(S.otherAgent, CWD.otherAgent);
seed(S.lookalike, CWD.lookalike);
seed(S.otherState, CWD.otherState);
seed(S.otherWt, CWD.otherWorktreeScratch);
seed(S.deskC, CWD.desktopOther);

const allIds = [...TEST_IDS, ...KEEP_IDS];
const cwdOf = { [S.a]: CWD.testA, [S.aChild]: CWD.testAChild, [S.aChildReal]: CWD.real, [S.b]: CWD.testB, [S.desk]: CWD.desktopTest, [S.scratch]: CWD.scratch, [S.real]: CWD.real, [S.realGui]: CWD.real, [S.realTmp]: CWD.realTmp, [S.otherAgent]: CWD.otherAgent, [S.lookalike]: CWD.lookalike, [S.otherState]: CWD.otherState, [S.otherWt]: CWD.otherWorktreeScratch, [S.deskC]: CWD.desktopOther };

// 本项目注册表：每个会话一条
writeRegistryDoc(allIds.filter((id) => id !== S.realGui).map((id) => ({ id, cwd: cwdOf[id], permission: 'workspace-write' })));

// DSH 工作区登记：真实/桌面/测试临时目录各一个，外加 archived/pinned
const mkWs = (path, sessionIds) => ({ path, title: path.split(/[\\/]/).pop(), sessionIds, createdAt: 'T0', updatedAt: 'T0' });
const wsDoc = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-real', 'ws-desk', 'ws-tmpA', 'ws-tmpA-sub', 'ws-deskC'],
    archivedSessionIds: [S.a, S.real],
    pinnedSessionIds: [S.aChild, S.realGui],
    defaultWorkspaceId: 'ws-real',
  },
  tables: {
    workspaces: {
      'ws-real': mkWs(CWD.real, [S.real, S.realGui, S.aChildReal]),
      'ws-desk': mkWs(CWD.desktopTest, [S.desk]),
      'ws-tmpA': mkWs(CWD.testA, [S.a]),
      'ws-tmpA-sub': mkWs(CWD.testAChild, [S.aChild]),
      'ws-deskC': mkWs(CWD.desktopOther, [S.deskC]),
    },
  },
};
mkdirSync(dirname(workspaceFile), { recursive: true });
writeFileSync(workspaceFile, JSON.stringify(wsDoc, null, 2));

/** 一个会话在 DSH 侧 + 本项目侧的全部产物路径。 */
const artifacts = (id) => ({
  'DSH 会话目录': join(sessionsRoot, bucketOf(cwdOf[id]), id),
  'DSH 投影缓存': join(projcacheDir, `${id}.json`),
  'DSH forget 墓碑': join(forgottenDir, `${id}.json`),
  '元数据侧车': join(metaDir, `${id}.json`),
  '哨兵目录': join(runsDir, id),
  '审核目录': join(reviewsDir, id),
  '写锁登记': join(locksDir, `${id}.json`),
});
const existsAll = (id) => Object.values(artifacts(id)).every(existsSync);
const survivors = (id) => Object.entries(artifacts(id)).filter(([, p]) => existsSync(p)).map(([k]) => k);
const inRegistry = (id) => readRegistryDoc().conversations.some((c) => c.id === id);
const inWorkspaces = (id) => {
  const d = readWs();
  return Object.values(d.tables.workspaces).some((w) => w.sessionIds.includes(id)) || d.global.archivedSessionIds.includes(id) || d.global.pinnedSessionIds.includes(id);
};

/** 所有"保留类"会话的逐字节快照（所有产物文件）。 */
const keepSnapshot = () => {
  const snap = {};
  for (const id of KEEP_IDS) {
    for (const [k, p] of Object.entries(artifacts(id))) {
      if (!existsSync(p)) {
        snap[`${id}:${k}`] = 'MISSING';
        continue;
      }
      snap[`${id}:${k}`] = statSync(p).isDirectory() ? JSON.stringify(treeHashes(p)) : sha(readFileSync(p));
    }
  }
  return snap;
};
const keepRegistryEntries = () => JSON.stringify(readRegistryDoc().conversations.filter((c) => KEEP_IDS.includes(c.id)));
const keepWorkspaceEntry = () => JSON.stringify(readWs().tables.workspaces['ws-real']) + JSON.stringify(readWs().tables.workspaces['ws-deskC']);

const keepBefore = keepSnapshot();
const keepRegBefore = keepRegistryEntries();
const keepWsBefore = keepWorkspaceEntry();
const assertKeepUntouched = (label) => {
  const now = keepSnapshot();
  const diff = Object.keys(keepBefore).filter((k) => keepBefore[k] !== now[k]);
  check(`★ ${label}：非测试会话的全部产物逐字节不变（${Object.keys(keepBefore).length} 项）`, diff.length === 0, diff.join(', '));
  check(`★ ${label}：非测试会话在本项目注册表里的条目不变`, keepRegistryEntries() === keepRegBefore);
  check(`★ ${label}：真实工作区登记条目不变`, keepWorkspaceEntry() === keepWsBefore);
};

try {
  // ───────────────────────────────────────────────────────────
  console.log('\n[1] 护栏判定：谁算测试 cwd');
  check('tmpdir()/dsh-any-agent-* 是', ws.isTestSessionCwd(CWD.testA));
  check('桌面 dsh-any-agent-test-A 是', ws.isTestSessionCwd(CWD.desktopTest));
  check('本仓库 .state/ws-probe-<时间戳> 是', ws.isTestSessionCwd(CWD.scratch));
  check('★ 真实项目不是', !ws.isTestSessionCwd(CWD.real));
  check('★ 用户 %TEMP% 里的真实项目不是', !ws.isTestSessionCwd(CWD.realTmp));
  check('★ 别的 agent 的临时根（TMP 指到别处）不是', !ws.isTestSessionCwd(CWD.otherAgent), CWD.otherAgent);
  check('★ 名字像、但不在 tmpdir() 下的不是', !ws.isTestSessionCwd(CWD.lookalike));
  check('★ 仓库 .state 里别的目录不是', !ws.isTestSessionCwd(CWD.otherState));
  check('★ 别的 worktree 的 .state/ws-probe-* 不是', !ws.isTestSessionCwd(CWD.otherWorktreeScratch), CWD.otherWorktreeScratch);
  check('★ 桌面 dsh-any-agent-test-C 不是（只认 A|B）', !ws.isTestSessionCwd(CWD.desktopOther));
  check('空/非字符串不是', !ws.isTestSessionCwd('') && !ws.isTestSessionCwd(undefined) && !ws.isTestSessionCwd(null));
  check('相对路径不会被当成 ws-probe', !ws.isTestScratchPath('.state/ws-probe-1'));

  // ───────────────────────────────────────────────────────────
  console.log('\n[2] 干跑：零写入，但清单完整');
  const treeBefore = { dsh: treeHashes(dshHome), state: treeHashes(stateDir) };
  const dry = ws.purgeTestSessions({ dryRun: true });
  const dryIds = dry.victims.map((v) => v.id).sort();
  check('扫荡干跑命中全部测试会话（含子会话）', JSON.stringify(dryIds) === JSON.stringify([...TEST_IDS].sort()), JSON.stringify(dryIds));
  check('干跑不报告任何拒绝（扫荡不会"选中"非测试会话）', dry.skipped.length === 1 && dry.skipped[0].id === S.aChildReal, JSON.stringify(dry.skipped));
  const dryFull = residue.sweepTestResidue({ dryRun: true, minOrphanAgeMs: 0, tmpRoot: fakeTmpRoot });
  check('sweepTestResidue 干跑同样命中', dryFull.sessions.count === TEST_IDS.length);
  check('★ 干跑后整个沙箱 DSH_HOME 逐字节不变', sameTree(treeBefore.dsh, treeHashes(dshHome)));
  check('★ 干跑后本项目状态目录逐字节不变', sameTree(treeBefore.state, treeHashes(stateDir)));
  for (const id of TEST_IDS) check(`干跑后 ${id} 的 7 种产物都还在`, existsAll(id), survivors(id).join(','));

  // ───────────────────────────────────────────────────────────
  console.log('\n[3] cwd 护栏：点名也删不掉非测试会话');
  const refusedNames = ws.purgeTestSessions({ ids: [S.real, S.realGui, S.realTmp, S.otherAgent, S.lookalike, S.otherState, S.otherWt, S.deskC], idsOnly: true });
  check('点名非测试会话：删除 0 个', refusedNames.count === 0, JSON.stringify(refusedNames.victims.map((v) => v.id)));
  check('全部列进 skipped 并给出原因', refusedNames.skipped.length === 8 && refusedNames.skipped.every((s) => /不是测试目录/.test(s.reason)));
  const viaResidue = residue.purgeTestResidue({ ids: [S.real, S.otherAgent], stateFiles: [stateFile] });
  check('purgeTestResidue 点名非测试会话：会话与本项目数据都不动', viaResidue.sessions.count === 0 && viaResidue.project.removed.meta === 0 && viaResidue.project.removed.registry === 0);
  // 圈得再大，护栏照样拦（干跑：家目录同时包着 tmpdir 和仓库，真跑会把测试会话也带走）
  const roots = ws.purgeTestSessions({ roots: [homedir()], dryRun: true });
  check('roots 圈到整个家目录也只会命中测试 cwd', roots.victims.every((v) => TEST_IDS.includes(v.id)), JSON.stringify(roots.victims.map((v) => v.id)));
  check('roots 圈住家目录时真实项目被拒绝而不是删除', roots.skipped.some((s) => s.id === S.real) && existsAll(S.real));
  assertKeepUntouched('护栏之后');

  // ───────────────────────────────────────────────────────────
  console.log('\n[4] 点名清理一个套件的会话：每种产物都清掉，子会话级联');
  check('清理前 a/aChild 的 7 种产物齐全且已登记', existsAll(S.a) && existsAll(S.aChild) && inRegistry(S.a) && inWorkspaces(S.a) && inWorkspaces(S.aChild));
  // 只点名 a：它的子会话 aChild 不在 ids 里，必须靠级联带走
  const r4 = residue.purgeTestResidue({ ids: [S.a], stateFiles: [stateFile] });
  const gone4 = r4.sessions.victims.map((v) => v.id).sort();
  check('清掉了 a 与它的子会话 aChild', JSON.stringify(gone4) === JSON.stringify([S.a, S.aChild].sort()), JSON.stringify(gone4));
  check('子会话标注了原因', r4.sessions.victims.find((v) => v.id === S.aChild)?.reason.includes('子会话'));
  for (const id of [S.a, S.aChild]) {
    for (const [kind, p] of Object.entries(artifacts(id))) check(`  ${id} 的「${kind}」已删除`, !existsSync(p), p);
    check(`  ${id} 已从本项目注册表摘除`, !inRegistry(id));
    check(`  ${id} 已从工作区登记/archived/pinned 摘除`, !inWorkspaces(id));
  }
  check('因此变空的测试工作区条目被删', !readWs().tables.workspaces['ws-tmpA'] && !readWs().tables.workspaces['ws-tmpA-sub']);
  check('workspaceIds 同步去掉了它们', !readWs().global.workspaceIds.includes('ws-tmpA') && !readWs().global.workspaceIds.includes('ws-tmpA-sub'));
  check('因此变空的会话分桶目录被收掉', !existsSync(join(sessionsRoot, bucketOf(CWD.testA))) && !existsSync(join(sessionsRoot, bucketOf(CWD.testAChild))));
  check('★ cwd 是真实项目的"子会话"被拒绝，没被级联带走', existsAll(S.aChildReal) && r4.sessions.skipped.some((s) => s.id === S.aChildReal && /子会话/.test(s.reason)));
  check('★ 别的套件的会话（另一个临时根）没被带走', existsAll(S.b));
  check('★ 其它测试会话（桌面/ws-probe）也没被带走（点名模式不扫荡）', existsAll(S.desk) && existsAll(S.scratch));
  assertKeepUntouched('点名清理之后');
  check('★ 非测试会话的 archived/pinned 标记保留，测试会话的被摘掉', readWs().global.archivedSessionIds.includes(S.real) && readWs().global.pinnedSessionIds.includes(S.realGui) && !readWs().global.archivedSessionIds.includes(S.a) && !readWs().global.pinnedSessionIds.includes(S.aChild));

  // ───────────────────────────────────────────────────────────
  console.log('\n[5] roots 兜底：没记 id 的会话也能按套件根清掉');
  const r5 = residue.purgeTestResidue({ roots: [tmpB], stateFiles: [stateFile] });
  check('只凭 roots 清掉了另一个套件的会话 b', r5.sessions.victims.length === 1 && r5.sessions.victims[0].id === S.b);
  for (const [kind, p] of Object.entries(artifacts(S.b))) check(`  b 的「${kind}」已删除`, !existsSync(p), p);
  check('  b 已从本项目注册表摘除', !inRegistry(S.b));
  check('  桌面/ws-probe 测试会话仍在（只给了 tmpB 根）', existsAll(S.desk) && existsAll(S.scratch));
  assertKeepUntouched('roots 清理之后');

  // ───────────────────────────────────────────────────────────
  console.log('\n[6] 全局扫荡兜底：桌面/ws-probe 会话、孤儿缓存、只剩状态的残留');
  // 孤儿：会话目录没了，缓存还在
  const orphanId = (n) => `sess-orphan-${n}-00001`;
  const writeCache = (id, cwd) => {
    writeFileSync(join(projcacheDir, `${id}.json`), JSON.stringify({ record: { identity: { cwd } } }));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(projcacheDir, `${id}.json`), old, old);
  };
  writeCache(orphanId('test'), CWD.testA);
  writeCache(orphanId('desktop'), CWD.desktopTest);
  writeCache(orphanId('real'), CWD.real);
  writeCache(orphanId('agent'), CWD.otherAgent);
  writeFileSync(join(projcacheDir, `${orphanId('junk')}.json`), '{ not json');
  utimesSync(join(projcacheDir, `${orphanId('junk')}.json`), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const fresh = orphanId('fresh');
  writeFileSync(join(projcacheDir, `${fresh}.json`), JSON.stringify({ record: { identity: { cwd: CWD.testA } } })); // 刚写的：不动
  // 只剩状态、会话目录早没了：有测试证据 → 清；证据是真实 cwd → 留；没有证据 → 留
  const stateOnlyTest = 'sess-state-only-test';
  const stateOnlyReal = 'sess-state-only-real';
  const stateOnlyNone = 'sess-state-only-none';
  seedState(stateOnlyTest, CWD.testA);
  seedState(stateOnlyReal, CWD.real);
  mkdirSync(join(runsDir, stateOnlyNone), { recursive: true });
  writeFileSync(join(runsDir, stateOnlyNone, 'run-x-1.json'), '{}');

  const r6 = residue.sweepTestResidue({ minOrphanAgeMs: 60_000, tmpRoot: fakeTmpRoot });
  const gone6 = r6.sessions.victims.map((v) => v.id).sort();
  check('扫荡清掉剩下的两个测试会话（桌面 + ws-probe）', JSON.stringify(gone6) === JSON.stringify([S.desk, S.scratch].sort()), JSON.stringify(gone6));
  for (const id of [S.desk, S.scratch]) {
    for (const [kind, p] of Object.entries(artifacts(id))) check(`  ${id} 的「${kind}」已删除`, !existsSync(p), p);
    check(`  ${id} 已从本项目注册表/工作区登记摘除`, !inRegistry(id) && !inWorkspaces(id));
  }
  check('桌面测试工作区条目随之被删', !readWs().tables.workspaces['ws-desk']);
  check('孤儿缓存：测试目录的两个被删', !existsSync(join(projcacheDir, `${orphanId('test')}.json`)) && !existsSync(join(projcacheDir, `${orphanId('desktop')}.json`)));
  check('★ 孤儿缓存：cwd 是真实项目/别的 agent/解析不了的都保留', existsSync(join(projcacheDir, `${orphanId('real')}.json`)) && existsSync(join(projcacheDir, `${orphanId('agent')}.json`)) && existsSync(join(projcacheDir, `${orphanId('junk')}.json`)));
  check('★ 刚写的孤儿缓存（minAge 内）不动', existsSync(join(projcacheDir, `${fresh}.json`)));
  check('报告里数出了保留的非测试孤儿', r6.orphans.kept_non_test >= 3, String(r6.orphans.kept_non_test));
  check('只剩状态、有测试证据的残留被清（元数据/哨兵/审核/锁）', [metaDir, runsDir, reviewsDir, locksDir].every((d) => !readdirSync(d).some((f) => f.startsWith(stateOnlyTest))));
  check('★ 只剩状态、证据是真实 cwd 的残留保留', existsSync(join(metaDir, `${stateOnlyReal}.json`)) && existsSync(join(runsDir, stateOnlyReal)));
  check('★ 只剩状态、没有任何证据的条目保留（扫荡不凭空猜）', existsSync(join(runsDir, stateOnlyNone)));
  check('测试工作区登记已无残留', Object.values(readWs().tables.workspaces).every((w) => !ws.isTestSessionCwd(w.path)));
  assertKeepUntouched('全局扫荡之后');
  const second = residue.sweepTestResidue({ tmpRoot: fakeTmpRoot });
  check('幂等：再扫一遍什么都不删', second.sessions.count === 0 && second.orphans.count === 0 && Object.values(second.project.removed).every((n) => n === 0));

  // ───────────────────────────────────────────────────────────
  console.log('\n[7] 坏文件 fail-closed；路径穿越');
  const registryAfter6 = readRegistryDoc().conversations;
  // 7a: 工作区注册表坏了
  const goner = 'sess-test-broken-ws1';
  seed(goner, CWD.testA);
  const brokenWs = '{ broken workspace';
  writeFileSync(workspaceFile, brokenWs);
  const r7a = ws.purgeTestSessions({ ids: [goner], idsOnly: true });
  check('注册表坏了：会话文件仍被清掉', r7a.count === 1 && !existsSync(join(sessionsRoot, bucketOf(CWD.testA), goner)));
  check('★ 注册表坏了：workspace.json 字节不变', readText(workspaceFile) === brokenWs);
  check('注册表坏了：错误被返回而不是吞掉', Boolean(r7a.registry?.error), JSON.stringify(r7a.registry));
  writeFileSync(workspaceFile, JSON.stringify(wsDoc, null, 2)); // 复原给后面用
  // 7b: 本项目注册表坏了
  const goner2 = 'sess-test-broken-reg1';
  seed(goner2, CWD.testA);
  const brokenReg = '{ broken registry';
  writeFileSync(stateFile, brokenReg);
  const r7b = residue.purgeTestResidue({ ids: [goner2], stateFiles: [stateFile] });
  check('★ 本项目注册表坏了：文件字节不变', readText(stateFile) === brokenReg);
  check('本项目注册表坏了：报出错误', r7b.project.errors.length === 1, JSON.stringify(r7b.project.errors));
  check('本项目注册表坏了：其余产物仍按元数据证据清掉', !existsSync(join(metaDir, `${goner2}.json`)) && !existsSync(join(runsDir, goner2)));
  writeRegistryDoc(registryAfter6); // 复原（保留类会话的条目要原样）
  // 7c: 头里 id 形状可疑 / 与目录名不符：不删，也不会去碰目录外的文件
  const victimFile = join(dshHome, 'storages', 'evil.json');
  writeFileSync(victimFile, 'do-not-delete');
  const evilDir = join(sessionsRoot, bucketOf(CWD.testA), 'weird-dir-name');
  mkdirSync(evilDir, { recursive: true });
  writeFileSync(join(evilDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: '../../evil', cwd: CWD.testA }) + '\n')));
  const r7c = ws.purgeTestSessions({});
  check('★ 头里 id 带路径分隔符：拒绝，会话目录原样', existsSync(evilDir) && r7c.skipped.some((s) => s.id === '../../evil'), JSON.stringify(r7c.skipped));
  check('★ 目录外的文件没被碰', readText(victimFile) === 'do-not-delete');
  const traversal = residue.purgeProjectState({ ids: ['../../evil', '..', 'a/b'], states: [stateFile], trusted: true });
  check('★ purgeProjectState 对非法 id 直接忽略', Object.values(traversal.removed).every((n) => n === 0) && existsSync(victimFile));

  // ───────────────────────────────────────────────────────────
  console.log('\n[8] 旧版扁平目录（%TEMP%/runs 等）：必须有证据才清');
  const legacy = join(sandbox, 'legacy-flat');
  const L = { test: 'sess-legacy-test-001', real: 'sess-legacy-real-001', none: 'sess-legacy-none-001' };
  mkdirSync(join(legacy, 'meta'), { recursive: true });
  writeFileSync(join(legacy, 'meta', `${L.test}.json`), JSON.stringify({ id: L.test, cwd: CWD.testA }));
  writeFileSync(join(legacy, 'meta', `${L.real}.json`), JSON.stringify({ id: L.real, cwd: CWD.real }));
  for (const id of [L.test, L.real, L.none]) {
    mkdirSync(join(legacy, 'runs', id), { recursive: true });
    writeFileSync(join(legacy, 'runs', id, 'run-1.json'), '{}');
    mkdirSync(join(legacy, 'reviews', id), { recursive: true });
    writeFileSync(join(legacy, 'reviews', id, 'run-1.review.json'), '{}');
  }
  mkdirSync(join(legacy, 'locks'), { recursive: true });
  const legacyDry = residue.sweepLegacyTmpState({ dir: legacy, dryRun: true });
  check('干跑只报告，不删', existsSync(join(legacy, 'runs', L.test)) && legacyDry.removed.runs === 1);
  const lg = residue.sweepLegacyTmpState({ dir: legacy });
  check('有测试证据的 id：哨兵/审核/元数据都清掉', !existsSync(join(legacy, 'runs', L.test)) && !existsSync(join(legacy, 'reviews', L.test)) && !existsSync(join(legacy, 'meta', `${L.test}.json`)));
  check('★ 证据是真实 cwd 的 id 原样保留', existsSync(join(legacy, 'runs', L.real)) && existsSync(join(legacy, 'reviews', L.real)) && existsSync(join(legacy, 'meta', `${L.real}.json`)));
  check('★ 没有任何证据的 id 原样保留', existsSync(join(legacy, 'runs', L.none)) && existsSync(join(legacy, 'reviews', L.none)));
  check('空的 locks 目录被收掉，非空的留着', lg.dirsRemoved.some((d) => d.endsWith('locks')) && existsSync(join(legacy, 'runs')) && existsSync(join(legacy, 'meta')));
  check('拒绝原因写明了', lg.refused.some((r) => r.id === L.none && /没有任何 cwd 证据/.test(r.reason)) && lg.refused.some((r) => r.id === L.real && /非测试/.test(r.reason)));

  // ───────────────────────────────────────────────────────────
  console.log('\n[9] 套件侧接线：McpClient 自动记 id，cleanupSuite 一站式清理');
  const fake = new McpClient({ env: { DSH_MCP_STATE: stateFile } });
  fake.request = async (method, params) => ({ structuredContent: { conversation_id: params.arguments.tag } });
  await fake.callTool('dsh_start', { tag: 'sess-via-client-01' });
  await fake.callTool('dsh_send', { tag: 'sess-not-started-01' }); // 只记 dsh_start
  check('McpClient 记录了 dsh_start 返回的 id，且只记它', fake.createdIds.has('sess-via-client-01') && fake.createdIds.size === 1);
  check('McpClient.stateFile 取自 env.DSH_MCP_STATE', fake.stateFile === stateFile);
  seed('sess-via-client-01', CWD.testA);
  writeRegistryDoc([...readRegistryDoc().conversations, { id: 'sess-via-client-01', cwd: CWD.testA }]);
  const quietLog = console.log;
  console.log = () => {};
  const cs = cleanupSuite({ clients: [fake], roots: [tmpA] });
  console.log = quietLog;
  check('cleanupSuite 清掉了客户端建的会话与本项目数据', cs?.sessions.victims.some((v) => v.id === 'sess-via-client-01') && !existsSync(join(metaDir, 'sess-via-client-01.json')) && !readRegistryDoc().conversations.some((c) => c.id === 'sess-via-client-01'));
  console.log = () => {};
  const csEmpty = cleanupSuite({});
  console.log = quietLog;
  check('cleanupSuite 没东西可清时也安全', csEmpty?.sessions.count === 0);
  assertKeepUntouched('套件收尾之后');

  // ───────────────────────────────────────────────────────────
  console.log('\n[10] 每个真机套件都接上了收尾清理，且状态不再散落在 %TEMP% 根下');
  const suiteFiles = readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
  const MANUAL_ONLY = new Set(['gui-lock-demo.mjs', 'gui-lock-probe.mjs']); // 手动演示脚本，不在任何套件列表里
  // roots.mjs 虽然也调 dsh_start，但它的 DSH_HOME 是沙箱，不会在真实 ~/.dsh 里留东西。
  const SANDBOXED = new Set(['roots.mjs', 'residue-purge.mjs']);
  const liveSuites = suiteFiles.filter(
    (f) => !MANUAL_ONLY.has(f) && !SANDBOXED.has(f) && (f === 'shared-process.mjs' || /callTool\(\s*'dsh_start'/.test(readText(join(HERE, f)))),
  );
  check('找到了真机套件', liveSuites.length >= 10, liveSuites.join(','));
  for (const f of liveSuites) {
    const src = readText(join(HERE, f));
    check(`${f} 在 finally 里调用了 cleanupSuite`, /cleanupSuite\(/.test(src) && /finally\s*\{/.test(src) && src.indexOf('finally') < src.lastIndexOf('cleanupSuite('));
  }
  const offenders = suiteFiles.filter((f) => /const STATE\w*\s*=\s*join\(tmpdir\(\)/.test(readText(join(HERE, f))) && f !== 'residue-purge.mjs');
  check('★ 没有套件把 DSH_MCP_STATE 直接放在 %TEMP% 根下（否则 runs/reviews/locks/meta 会散落且永不被清）', offenders.length === 0, offenders.join(','));

  // ───────────────────────────────────────────────────────────
  console.log('\n[11] ★ DSH_MCP_KEEP_EVIDENCE=1 时 cleanup.mjs 一样东西都不删（PR #11 评审）');
  {
    // 子进程的 tmpdir() 与 DSH_HOME 都指进沙箱：不碰真实 %TEMP% 与 ~/.dsh。
    const evTmp = join(sandbox, 'evidence-tmp');
    const evState = join(evTmp, 'dsh-any-agent-wseff-evidence');
    mkdirSync(evState, { recursive: true });
    writeFileSync(join(evState, 'conversations.json'), '{"version":1,"conversations":[]}');
    const runCleanup = (extra) =>
      spawnSync(process.execPath, [join(HERE, 'cleanup.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          TEMP: evTmp,
          TMP: evTmp,
          TMPDIR: evTmp,
          DSH_HOME: dshHome,
          DSH_MCP_STATE: join(stateDir, 'conversations.json'),
          DSH_MCP_PURGE_DESKTOP: '',
          ...extra,
        },
      });
    const kept = runCleanup({ DSH_MCP_KEEP_EVIDENCE: '1' });
    check('保留证据模式下 cleanup 正常退出', kept.status === 0, kept.stderr);
    check('★ 状态目录（证据）原样保留', existsSync(join(evState, 'conversations.json')));
    check('输出里说明了整轮已跳过、以及怎么收尾', /KEEP_EVIDENCE=1：整轮清理已跳过/.test(kept.stdout) && /不带这个开关再运行一次/.test(kept.stdout), kept.stdout.slice(0, 300));
    const swept = runCleanup({ DSH_MCP_KEEP_EVIDENCE: '' });
    check('对照：不带开关时同一个临时状态目录会被清掉', swept.status === 0 && !existsSync(evState), swept.stdout.slice(-300));
  }
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try {
    removeSandbox(sandbox);
  } catch {}
}

console.log(`\n===== 测试残留清理：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
