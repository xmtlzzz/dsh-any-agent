/**
 * 英文模式（DSH_MCP_LANG=en）回归：核心报错、会话配置标签、CLI 提示与 failedKeys 判定
 * 在英文模式下不能泄露中文文案。纯本地离线，不拉 DSH，不花 token。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-any-agent-i18n-'));
const EMPTY_DSH_HOME = join(ROOT, 'dsh-home');
const STATE = join(ROOT, 'state.json');

// 必须在动态导入 ../src/*.mjs 之前设好语言与沙箱环境（src/lang.mjs 在模块加载期求值 LANG）。
process.env.DSH_MCP_LANG = 'en';
process.env.DSH_HOME = EMPTY_DSH_HOME;
process.env.DSH_MCP_STATE = STATE;

const { LANG } = await import('../src/lang.mjs');
const { assertSafeId } = await import('../src/ids.mjs');
const { assertWritableDir } = await import('../src/config.mjs');
const { resolveDsh } = await import('../src/dsh-locate.mjs');
const { applySessionConfig } = await import('../src/acp-session.mjs');
const { OutBuffer } = await import('../src/out-buffer.mjs');
const { MAX_QUEUE, RunLedger } = await import('../src/run-ledger.mjs');
const { load: yamlLoad } = await import('../src/yaml-lite.mjs');
const { registerWorkspace } = await import('../src/workspace.mjs');
const { ensureProfile } = await import('../src/bootstrap.mjs');
const { describeLeaseConflict } = await import('../src/locks.mjs');
const { Conversation, Hub, homeWorkspaceProblem } = await import('../src/hub.mjs');
const { makeSandboxHome, removeSandbox } = await import('./sandbox-home.mjs');

const CJK = /[\u3400-\u9fff]/;
let pass = 0;
let failCount = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const isEnText = (s) => typeof s === 'string' && s.length > 0 && !CJK.test(s);

function catchMsg(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

async function catchAsyncMsg(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

const savedBin = process.env.DSH_BIN;
const savedRuntime = process.env.DSH_RUNTIME;

try {
  console.log('\n[1] 模块语言环境与基础校验报错');
  check('LANG 为 en', LANG === 'en', LANG);
  check('assertSafeId 报错为英文', isEnText(catchMsg(() => assertSafeId('../bad', 'conversation_id'))));

  const fileAsDir = join(ROOT, 'not-a-dir');
  writeFileSync(fileAsDir, 'x');
  check('assertWritableDir 报错为英文', isEnText(catchMsg(() => assertWritableDir(fileAsDir, 'Sentinel directory'))));

  process.env.DSH_BIN = join(ROOT, 'missing-dsh.js');
  delete process.env.DSH_RUNTIME;
  check('resolveDsh(缺失 DSH_BIN) 报错为英文', isEnText(catchMsg(() => resolveDsh({ fresh: true }))));

  delete process.env.DSH_BIN;
  process.env.DSH_RUNTIME = join(ROOT, 'missing-node.exe');
  check('resolveDsh(缺失 DSH_RUNTIME) 报错为英文', isEnText(catchMsg(() => resolveDsh({ fresh: true }))));

  delete process.env.DSH_BIN;
  delete process.env.DSH_RUNTIME;

  console.log('\n[2] applySessionConfig 标签与 failedKeys 解耦');
  const okProc = { request: async () => ({}) };
  const okCfg = await applySessionConfig(okProc, 'sess-1', { provider: 'p1', model: 'm1', reasoningEffort: 'high' });
  check('applySessionConfig 成功标签为英文', okCfg.applied.length === 2 && okCfg.applied.every(isEnText), JSON.stringify(okCfg.applied));

  const badProc = {
    request: async (_m, params) => {
      if (params.configId === 'model') throw new Error('unknown model');
      return {};
    },
  };
  const badCfg = await applySessionConfig(badProc, 'sess-1', { provider: 'p1', model: 'bad', reasoningEffort: 'high' });
  check('applySessionConfig 失败文案为英文', badCfg.failed.length === 1 && isEnText(badCfg.failed[0]), JSON.stringify(badCfg.failed));
  check('applySessionConfig 返回结构化 failedKeys=["model"]', Array.isArray(badCfg.failedKeys) && badCfg.failedKeys.includes('model'), JSON.stringify(badCfg.failedKeys));

  console.log('\n[3] OutBuffer / RunLedger / yaml-lite / workspace / bootstrap');
  const buf = new OutBuffer();
  buf.push('text', 'a'.repeat(200_100), {}, 1);
  const capped = buf.read().entries[0]?.text ?? '';
  check('OutBuffer 截断标记为英文', isEnText(capped) && capped.includes('truncated'), capped.slice(0, 80));

  const ledger = new RunLedger();
  for (let i = 0; i < MAX_QUEUE; i++) ledger.enqueue({ run: { run_id: `r-${i}`, prompt_preview: 'x' } });
  check('RunLedger 满队列报错为英文', isEnText(catchMsg(() => ledger.assertRoom())));
  check('RunLedger take 未知 run 报错为英文', isEnText(catchMsg(() => ledger.take('missing'))));
  check('RunLedger update 未知 run 报错为英文', isEnText(catchMsg(() => ledger.update('missing', 'next'))));

  check('yamlLoad 引号未闭合报错为英文', isEnText(catchMsg(() => yamlLoad('a: "unterminated'))));
  check('yamlLoad 制表符缩进报错为英文', isEnText(catchMsg(() => yamlLoad('a:\n\tb: 1'))));
  check('yamlLoad 缺冒号报错为英文', isEnText(catchMsg(() => yamlLoad('not-a-mapping'))));

  const wsSkip = registerWorkspace(ROOT, 'sess-1');
  check('registerWorkspace 跳过原因无中文', isEnText(wsSkip.error), wsSkip.error);

  const bootRes = ensureProfile();
  check('ensureProfile 缺路由错误为英文', !bootRes.ok && isEnText(bootRes.error) && isEnText(bootRes.reason), JSON.stringify(bootRes));

  console.log('\n[4] Conversation / Hub / 写锁提示');
  const leaseMsg = describeLeaseConflict('conv-en-1', { kind: 'external', reason: 'not ours' });
  check('写锁外部占用提示为英文且指引 watch/dashboard', isEnText(leaseMsg) && leaseMsg.includes('watch') && leaseMsg.includes('dashboard'), leaseMsg.slice(0, 140));

  const hub = new Hub();
  check('Hub.create 缺 cwd 报错为英文', isEnText(await catchAsyncMsg(() => hub.create({}))));
  check('Hub.create 相对 cwd 报错为英文', isEnText(await catchAsyncMsg(() => hub.create({ cwd: 'rel/path' }))));
  check('Hub.create 非法 permission 报错为英文', isEnText(await catchAsyncMsg(() => hub.create({ cwd: ROOT, permission: 'bad' }))));
  check('Hub.create read-only+ask 报错为英文', isEnText(await catchAsyncMsg(() => hub.create({ cwd: ROOT, permission: 'read-only', onApproval: 'ask' }))));
  check('Hub.create model 缺 provider 报错为英文', isEnText(await catchAsyncMsg(() => hub.create({ cwd: ROOT, model: 'm1' }))));
  const homeMsg = homeWorkspaceProblem(homedir(), 'workspace-write');
  check('homeWorkspaceProblem 报错为英文', isEnText(homeMsg), String(homeMsg).slice(0, 120));

  const conv = new Conversation({ id: 'conv-en-1', cwd: ROOT, permission: 'workspace-write' }, hub);
  check('Conversation.send 空文本报错为英文', isEnText(await catchAsyncMsg(() => conv.send('   '))));
  check('Conversation.send 负超时报错为英文', isEnText(await catchAsyncMsg(() => conv.send('hi', { timeoutMs: -1 }))));
  check('Conversation.review fail 缺理由报错为英文', isEnText(await catchAsyncMsg(() => conv.review({ runId: 'r1', verdict: 'fail' }))));
  check('Conversation.review 未知 run 报错为英文', isEnText(await catchAsyncMsg(() => conv.review({ runId: 'r-unknown', verdict: 'pass', notes: 'ok' }))));

  console.log('\n[5] CLI（setup / restore）英文输出');
  const home = makeSandboxHome('dsh-any-agent-i18n-home-', { '.cursor/mcp.json': '{"mcpServers":{}}\n' });
  try {
    const setupBad = spawnSync(process.execPath, [join(HERE, '../bin/setup.mjs'), '--home', home, '--permission', 'bad'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_MCP_LANG: 'en' },
    });
    const setupOut = (setupBad.stdout ?? '') + (setupBad.stderr ?? '');
    check('setup 非法 --permission 退出 2 且无中文', setupBad.status === 2 && isEnText(setupOut.trim()), setupOut.trim());

    const restoreList = spawnSync(process.execPath, [join(HERE, '../bin/restore.mjs'), '--home', home, '--list'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_MCP_LANG: 'en' },
    });
    const restoreOut = (restoreList.stdout ?? '') + (restoreList.stderr ?? '');
    check('restore --list 英文模式无中文', restoreList.status === 0 && isEnText(restoreOut.trim()), restoreOut.trim());

    const restoreMiss = spawnSync(process.execPath, [join(HERE, '../bin/restore.mjs'), '--home', home, '--stamp', 'nope'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_MCP_LANG: 'en' },
    });
    const restoreMissOut = (restoreMiss.stdout ?? '') + (restoreMiss.stderr ?? '');
    check('restore 缺失 stamp 英文模式无中文', restoreMiss.status === 1 && isEnText(restoreMissOut.trim()), restoreMissOut.trim());
  } finally {
    removeSandbox(home);
  }
} finally {
  if (savedBin === undefined) delete process.env.DSH_BIN;
  else process.env.DSH_BIN = savedBin;
  if (savedRuntime === undefined) delete process.env.DSH_RUNTIME;
  else process.env.DSH_RUNTIME = savedRuntime;
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n===== 英文文案与报错回归：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);
