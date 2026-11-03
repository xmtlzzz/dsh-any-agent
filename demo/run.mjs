#!/usr/bin/env node
/**
 * 5 分钟真实案例：把一件活派给 DSH，中途插两次话，再回头验收。
 *
 * 这个脚本只用 MCP 协议本身（`initialize` / `tools/list` / `tools/call`），
 * 不 import 服务端的任何内部模块 —— 它就是你自己的客户端会做的事，
 * 只不过换成了命令行。
 *
 * 用法：
 *   node demo/run.mjs                 真实跑一遍（需要本机 DSH + 可用 provider）
 *   node demo/run.mjs --replay        回放上一次录制（零成本、不需要 DSH）
 *   node demo/run.mjs --keep          保留临时工作区，方便自己翻结果
 *   node demo/run.mjs --save          跑完把这份记录写成 demo/transcript.json
 *   node demo/run.mjs --timeout 240   单个回合的最长等待秒数（默认 240）
 *   node demo/run.mjs --prompt "…"    换一个任务（会跳过内置的两条插话）
 *
 * 隔离：注册表 / 哨兵 / 写锁登记全部指向临时目录，不会动你日常的
 * `~/.dsh/.dsh-any-agent`。DSH 自己的会话仍落在 `~/.dsh/sessions`（凭据与
 * provider 在那里），脚本结束时会 `dsh_release(forget=true)` 把它移出注册表。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './mcp-client.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRANSCRIPT = join(PKG_ROOT, 'demo', 'transcript.json');

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback;
};

if (flag('-h') || flag('--help')) {
  console.log(
    [
      'dsh-any-agent demo —— 派活 → 插话 → 验收',
      '',
      '  node demo/run.mjs                 real run (needs a local DSH + a working provider)',
      '  node demo/run.mjs --replay        replay the last recorded run (no DSH, no tokens)',
      '  node demo/run.mjs --keep          keep the temp workspace',
      '  node demo/run.mjs --save          write demo/transcript.json from this run',
      '  node demo/run.mjs --timeout 240   seconds to wait per turn (default 240)',
      '  node demo/run.mjs --prompt "…"    use your own task instead of the built-in one',
      '',
      'Env: DSH_BIN, DSH_HOME, DSH_MCP_PROFILE (same as the server).',
    ].join('\n'),
  );
  process.exit(0);
}

const TURN_TIMEOUT_S = Number(opt('--timeout', '240')) || 240;
const KEEP = flag('--keep');
const SAVE = flag('--save');

// ── 记录器：打印 + 收集，--save 时落盘 ──────────────────────────────
const log = [];
function say(line = '') {
  process.stdout.write(line + '\n');
  log.push(line);
}

// ── --replay：零成本回放 ────────────────────────────────────────────
if (flag('--replay')) {
  if (!existsSync(TRANSCRIPT)) {
    console.error(`还没有录制过：${TRANSCRIPT} 不存在。\n先真实跑一次：node demo/run.mjs --save`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(TRANSCRIPT, 'utf8'));
  say(`（回放：${doc.recorded_at} 在本机录制的真实运行，不是现场跑的）`);
  say(`  任务：${doc.prompt}`);
  say('');
  for (const line of doc.lines) say(line);
  process.exit(0);
}

// ── 真实运行 ────────────────────────────────────────────────────────
const DEFAULT_PROMPT = [
  '这是一个自动化演示，请直接动手，不要做架构/影响面分析，不要创建 .birdview/ 之类的产物，不要使用技能。',
  '',
  '在这个空目录里做一件小事，并自己验证：',
  '',
  '1. 写 fib.mjs：ESM 导出 fib(n)，fib(0)=0、fib(1)=1，用迭代实现，不要递归。',
  '2. 写 test-fib.mjs：用 node:test + node:assert 覆盖 fib(0)、fib(1)、fib(10)=55。',
  '3. 运行 `node --test test-fib.mjs`，确认全部通过。',
  '',
  '只在当前目录里建这两个文件，不要建别的文件，不要安装任何依赖。',
].join('\n');

const PROMPT = opt('--prompt', DEFAULT_PROMPT);
const CUSTOM = PROMPT !== DEFAULT_PROMPT;

const INTERJECTS = [
  '补充一条要求：fib(n) 收到负数要抛 RangeError("n must be >= 0")，测试里补一条对应断言。',
  '再补一条：在 fib.mjs 顶上加一行注释，说明时间复杂度是 O(n)。其它别动。',
];

const t0 = Date.now();
const since = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 隔离目录：注册表 / 哨兵 / 锁登记都放这里
const base = mkdtempSync(join(tmpdir(), 'dsh-any-agent-demo-'));
const stateDir = join(base, 'state');
const workspace = join(base, 'workspace');
mkdirSync(stateDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const env = {
  DSH_MCP_STATE: join(stateDir, 'conversations.json'),
  DSH_MCP_RUNS_DIR: join(stateDir, 'runs'),
  DSH_MCP_LOCKS_DIR: join(stateDir, 'locks'),
  DSH_MCP_LOG: 'silent',
  DSH_MCP_PERMISSION: 'workspace-write',
  DSH_MCP_APPROVAL: 'auto-allow',
};

say('dsh-any-agent · 5 分钟真实案例');
say('='.repeat(64));
say(`工作区：${workspace}`);
say(`注册表：${env.DSH_MCP_STATE}（隔离，不动你的日常状态）`);
say('');

// 前置检查：Node 版本 + DSH 是否可用。早失败 > 跑一半失败。
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  console.error(
    `Node ${process.versions.node} 太旧：服务端要用 node:zlib 的 zstdDecompressSync 读会话头，需要 >= 22.15。`,
  );
  process.exit(1);
}

let resolveDshBin;
try {
  ({ resolveDshBin } = await import('../src/config.mjs'));
} catch (e) {
  console.error(`加载配置失败：${e.message}`);
  process.exit(1);
}
try {
  say(`DSH：${resolveDshBin()}`);
} catch (e) {
  console.error(
    [
      '找不到可用的 DSH。这个 demo 演示的是「让 DSH 干活」，不是「不装 DSH 也能跑」。',
      '  装一份：npm i -g @deepseek-ai/dsh   （或设置 DSH_BIN 指向它的 lib/bin.js）',
      `  原因：${e.message}`,
    ].join('\n'),
  );
  process.exit(1);
}
say('');

const client = new McpClient({ pkgRoot: PKG_ROOT, env }).start();
let exitCode = 0;

/** 从 tools/call 的返回里同时拿结构化字段和可读文本。 */
const info = (res) => res?.structuredContent ?? {};
const text = (res) => McpClient.text(res);
const sentinelStatus = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

try {
  // 1. 握手
  say(`[1/6] ${since()}  initialize —— 服务端只要求 4 个标准方法`);
  await client.initialize();
  const tools = await client.listTools();
  say(`     已连接，暴露 ${tools.length} 个工具：${tools.map((t) => t.name).join(', ')}`);

  // 2. 建会话
  say('');
  say(`[2/6] ${since()}  dsh_start —— 建一个长驻会话`);
  const started = await client.callTool('dsh_start', {
    cwd: workspace,
    title_hint: 'demo: fib + test',
    permission: 'workspace-write',
  });
  const convId = info(started).conversation_id;
  if (!convId) throw new Error(`dsh_start 没返回 conversation_id：\n${text(started)}`);
  say(`     会话 ${convId}`);

  // 3. 派活（不等）
  say('');
  say(`[3/6] ${since()}  dsh_send(wait=false) —— 派完立刻返回，回合在后台跑`);
  const sent = await client.callTool('dsh_send', {
    conversation_id: convId,
    prompt: PROMPT,
    wait: false,
  });
  const sendInfo = info(sent);
  if (!sendInfo.run_id) throw new Error(`dsh_send 没返回 run_id：\n${text(sent)}`);
  const firstRun = sendInfo.run_id;
  const firstSentinel = sendInfo.sentinel_file;
  say(`     run_id=${firstRun}`);
  say(`     哨兵=${firstSentinel}   ← 跑完由它通知，不用轮询`);

  // 4. 两次插话。注意：dsh_interject 会一直等到"改口后的那一轮"结束才返回，
  //    所以这一步同时也是"第二轮的验收点"。
  say('');
  say(`[4/6] ${since()}  中途插话 —— 打断当前回合并改口，已做的工作不丢`);
  let last = null;
  let n = 0;
  for (const message of INTERJECTS) {
    if (CUSTOM) break;
    await sleep(4000);
    const res = await client.callTool(
      'dsh_interject',
      { conversation_id: convId, message, timeout_ms: TURN_TIMEOUT_S * 1000 },
      (TURN_TIMEOUT_S + 60) * 1000,
    );
    const r = info(res);
    n += 1;
    // interject 的返回是"改口后那一轮"的结果：有的版本带 status，有的只带 stop_reason。
    // 两个都认，别把一次正常结束报成 undefined。
    const state = r.status ?? (r.error ? 'error' : r.stop_reason === 'end_turn' ? 'done' : r.stop_reason);
    if (r.interjected === 'idle') {
      say(`     插话 #${n}：会话当时已空闲，按普通回合执行；status=${state}（${since()}）`);
    } else {
      say(
        `     插话 #${n}：已打断上一轮（上一轮跑了 ${((r.waited_ms ?? 0) / 1000).toFixed(1)}s），` +
          `新一轮 status=${state}（${since()}）`,
      );
    }
    last = r;
    if (state !== 'done') say(`       本轮未正常结束：${r.error ?? state}`);
  }
  if (CUSTOM) say('     （--prompt 自定义任务，跳过内置插话）');

  // 5. 收活：先看被打断那一轮的哨兵，再看最后一轮
  say('');
  say(`[5/6] ${since()}  收活 —— 一个回合 = 一个哨兵，被打断的也算`);
  const cancelled = firstSentinel ? sentinelStatus(firstSentinel) : null;
  if (cancelled) {
    say(`     第 1 轮（被打断）哨兵：status=${cancelled.status}  ← 没被丢掉，照样落地`);
  }
  if (last?.sentinel_file) {
    const fin = sentinelStatus(last.sentinel_file);
    say(`     最后一轮哨兵：status=${fin?.status ?? '（尚未落地）'}  ${last.sentinel_file}`);
  }

  // 6. 验收：用 run_id 取正文，然后自己复核磁盘
  say('');
  say(`[6/6] ${since()}  dsh_get —— 用 run_id 取回最终结果`);
  const finalRun = last?.run_id ?? firstRun;
  const got = await client.callTool('dsh_get', { conversation_id: convId, run_id: finalRun });
  const answer = info(got).run?.result?.answer ?? '';
  say(
    (answer || text(got))
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 10)
      .map((l) => `     ${l}`)
      .join('\n'),
  );

  say('');
  say('—'.repeat(64));
  say('复核（不看它说了什么，看磁盘上有什么）');
  const files = ['fib.mjs', 'test-fib.mjs'].filter((f) => existsSync(join(workspace, f)));
  say(`  产出文件：${files.length ? files.join(', ') : '（无）'}`);
  if (files.includes('test-fib.mjs')) {
    const test = spawnSync(process.execPath, ['--test', 'test-fib.mjs'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 60_000,
    });
    say(`  node --test：exit=${test.status}`);
    for (const line of (test.stdout ?? '').trim().split('\n').filter(Boolean).slice(-3)) {
      say(`    ${line.trim()}`);
    }
    if (test.status !== 0) exitCode = 1;
  } else {
    exitCode = 1;
  }

  // 状态快照：锁在谁手上、内存多少、是否共享进程
  const status = await client.callTool('dsh_status', { conversation_id: convId }).catch(() => null);
  if (status) {
    say('');
    say('状态快照（dsh_status）');
    for (const line of text(status).split('\n').slice(0, 8)) say(`  ${line}`);
  }

  await client.callTool('dsh_release', { conversation_id: convId, forget: true }).catch(() => null);
} catch (e) {
  exitCode = 1;
  say('');
  say(`!! 失败：${e.message}`);
  if (client.stderr.length) {
    say('服务端 stderr（最后 10 行）：');
    for (const l of client.stderr.slice(-10)) say(`  ${l}`);
  }
} finally {
  await client.close();
  if (!KEEP) rmSync(base, { recursive: true, force: true });
}

say('');
say('='.repeat(64));
say(
  `${exitCode === 0 ? '完成' : '未通过'} · 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (KEEP ? ` · 工作区保留在 ${workspace}` : ''),
);

if (SAVE && exitCode === 0) {
  writeFileSync(
    TRANSCRIPT,
    JSON.stringify({ recorded_at: new Date().toISOString(), prompt: PROMPT, lines: log }, null, 2) + '\n',
    'utf8',
  );
  say(`已录制：${TRANSCRIPT}（之后可用 --replay 零成本回放）`);
}

process.exit(exitCode);
