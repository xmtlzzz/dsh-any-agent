/**
 * 冷启动 resume 超时的自动重试（离线，不需要 DSH、不花 token）。
 *
 * 背景：test/multi.mjs [3] 偶发 `ACP 请求超时: session/resume`（DSH 进程 60 秒没回话），
 * 重跑就好、本机复现不出来。resume 是幂等的，而失败路径已经把那个进程杀掉并等它退出，
 * 所以 ensureAlive 对"DSH 没回话"重建进程重试一次（见 hub.mjs 里的排查记录）。
 *
 * 这里用 test/fake-acp.mjs 当 DSH（DSH_BIN），验证重试的边界——哪些该重试、哪些不该：
 *   [1] 第一次 resume 停滞 → 恢复成功；恰好拉起 2 个进程、旧进程已退出、登记指向新进程
 *   [2] 一直停滞 → 只重试一次就如实报错，不死循环、不留僵尸进程、不留登记
 *   [3] 撞写锁（DSH 明确拒绝）→ 不重试，仍走"写锁被占用"的说明
 *   [4] invalid params（DSH 明确拒绝）→ 不重试
 *   [5] AcpProcess 的超时错误带机器可读的 code / method
 *   [6] 共享宿主上还挂着别的会话时不重试（那个进程里可能还有这条 resume 在跑）
 *
 * 默认（共享进程）跑一遍，再用 DSH_MCP_SHARED_PROCESS=0 重跑一遍"一会话一进程"的路径。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = process.argv.includes('--child');

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-any-agent-resumeretry-'));
const WS = join(ROOT, 'ws');
mkdirSync(WS, { recursive: true });

// 全部隔离在临时目录里：配置模块加载期就读这些变量，所以必须先于下面的 import 设置。
process.env.DSH_HOME = join(ROOT, 'dsh-home');
process.env.DSH_MCP_STATE = join(ROOT, 'state', 'conversations.json');
process.env.DSH_MCP_BOOTSTRAP = '0';
process.env.DSH_MCP_LOG = 'silent';
process.env.DSH_BIN = join(HERE, 'fake-acp.mjs');
// 够长，慢 CI 上 node 冷启动也不会误触发；够短，整套不拖。
process.env.DSH_MCP_REQUEST_TIMEOUT_MS = '2000';

const { Conversation } = await import('../src/hub.mjs');
const { SessionHost } = await import('../src/host.mjs');
const { AcpProcess } = await import('../src/acp.mjs');
const { SHARED_PROCESS } = await import('../src/config.mjs');
const { isPidAlive, readMarker } = await import('../src/locks.mjs');

let pass = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const logs = [];
const log = { info: (m) => logs.push(String(m)), debug() {}, dshStderr() {} };
const hosts = new Map();
const hub = {
  log,
  save() {},
  acquireHost(cwd, permission) {
    const key = `${cwd}\u0000${permission}`;
    let h = hosts.get(key);
    if (!h) {
      h = new SessionHost({ cwd, permission, log, hub });
      hosts.set(key, h);
    }
    return h;
  },
  forgetHost(host) {
    for (const [k, v] of hosts) if (v === host) hosts.delete(k);
  },
};

const allPids = new Set();
let scenarioNo = 0;

/** 每个场景一个独立的事件目录与行为开关；返回读事件的函数。 */
function scenario(resumeMode, extraEnv = {}) {
  scenarioNo += 1;
  const dir = join(ROOT, `fake-${scenarioNo}`);
  process.env.FAKE_ACP_DIR = dir;
  process.env.FAKE_ACP_RESUME = resumeMode;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  hosts.clear();
  const read = () => {
    const f = join(dir, 'events.jsonl');
    const evs = existsSync(f)
      ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    for (const e of evs) allPids.add(e.pid);
    return {
      starts: evs.filter((e) => e.event === 'start').map((e) => e.pid),
      resumes: evs.filter((e) => e.method === 'session/resume'),
    };
  };
  return read;
}

function newConv(id) {
  const conv = new Conversation({ id, cwd: WS, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
  // 权限回读读的是 DSH 的投影缓存，假 DSH 没有；与本测试无关，跳过。
  conv.verifyPermissionRecorded = async () => null;
  return conv;
}

const settle = async (ms = 400) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`\n共享进程: ${SHARED_PROCESS ? '开（默认）' : '关（DSH_MCP_SHARED_PROCESS=0）'}`);

  // ── [1] 第一次 resume 停滞 → 重试成功 ───────────────────────
  console.log('\n[1] ★ 第一次 resume 停滞（DSH 没回话）→ 重建进程重试一次并成功');
  {
    const read = scenario('hang-first');
    logs.length = 0;
    const conv = newConv('retry-ok');
    const t0 = Date.now();
    let err = null;
    try {
      await conv.ensureAlive();
    } catch (e) {
      err = e;
    }
    const { starts, resumes } = read();
    check('ensureAlive 最终成功（没有把偶发停滞抛给调用方）', err === null, err?.message);
    check('恰好拉起 2 个进程', starts.length === 2, JSON.stringify(starts));
    check('session/resume 恰好发了 2 次，且来自两个不同进程', resumes.length === 2 && resumes[0].pid !== resumes[1].pid, JSON.stringify(resumes));
    check('停滞的旧进程已退出（写锁随之释放）', starts.length === 2 && !isPidAlive(starts[0]));
    check('会话现在挂在新进程上', conv.proc?.alive === true && starts.length === 2 && conv.proc.pid === starts[1], `proc.pid=${conv.proc?.pid}`);
    check('写锁登记指向新进程', starts.length === 2 && readMarker('retry-ok')?.child_pid === starts[1], JSON.stringify(readMarker('retry-ok')));
    check('lastChildPid 记的是新进程', starts.length === 2 && conv.lastChildPid === starts[1], String(conv.lastChildPid));
    check('留下了一条重试日志', logs.some((l) => l.includes('重试一次')), JSON.stringify(logs));
    check('耗时 ≈ 一个超时 + 重启（远小于两个超时之和的上限）', Date.now() - t0 < 12_000, `${Date.now() - t0}ms`);
    await conv.close();
    await settle();
    check('收尾后新进程也退出了', starts.length === 2 && !isPidAlive(starts[1]));
    check('收尾后登记已删', readMarker('retry-ok') === null);
  }

  // ── [2] 一直停滞 → 只重试一次 ───────────────────────────────
  console.log('\n[2] ★ 一直停滞 → 只重试一次就如实报错（不死循环、不留僵尸）');
  {
    const read = scenario('hang-always');
    logs.length = 0;
    const conv = newConv('retry-fail');
    let err = null;
    try {
      await conv.ensureAlive();
    } catch (e) {
      err = e;
    }
    const { starts, resumes } = read();
    check('最终仍然报错', err !== null);
    check('错误是"恢复会话失败…超时"', /恢复会话失败/.test(err?.message ?? '') && /超时/.test(err?.message ?? ''), err?.message);
    check('只重试了一次：共 2 个进程、2 次 resume', starts.length === 2 && resumes.length === 2, `starts=${starts.length} resumes=${resumes.length}`);
    check('两个进程都已退出（无僵尸）', starts.length === 2 && starts.every((p) => !isPidAlive(p)), JSON.stringify(starts));
    check('会话没有挂在垂死进程上', !conv.proc);
    check('写锁登记已删', readMarker('retry-fail') === null);
    check('不是写锁冲突（没有伪造 lock_conflict）', conv.lockConflict === null);
  }

  // ── [3] 撞写锁 → 不重试 ─────────────────────────────────────
  console.log('\n[3] 撞写锁（DSH 明确拒绝）→ 不重试，走"写锁被占用"说明');
  {
    const read = scenario('lease');
    const conv = newConv('retry-lease');
    let err = null;
    try {
      await conv.ensureAlive();
    } catch (e) {
      err = e;
    }
    const { starts, resumes } = read();
    check('报的是写锁冲突', err?.code === 'session-writer-held', `${err?.code} ${err?.message}`);
    check('只 resume 了一次、只拉起一个进程', resumes.length === 1 && starts.length === 1, `starts=${starts.length} resumes=${resumes.length}`);
    check('进程已退出', starts.every((p) => !isPidAlive(p)));
  }

  // ── [4] invalid params → 不重试 ─────────────────────────────
  console.log('\n[4] invalid params（DSH 明确拒绝）→ 不重试');
  {
    const read = scenario('invalid');
    const conv = newConv('retry-invalid');
    let err = null;
    try {
      await conv.ensureAlive();
    } catch (e) {
      err = e;
    }
    const { starts, resumes } = read();
    check('报错并带上 DSH 的原因', /恢复会话失败/.test(err?.message ?? '') && /not resumable/.test(err?.message ?? ''), err?.message);
    check('只 resume 了一次、只拉起一个进程', resumes.length === 1 && starts.length === 1, `starts=${starts.length} resumes=${resumes.length}`);
  }

  // ── [5] 超时错误的机器可读字段 ──────────────────────────────
  console.log('\n[5] AcpProcess 的超时错误带 code / method（上层不再靠匹配中文文本）');
  {
    const read = scenario('hang-always');
    const proc = new AcpProcess({ cwd: WS, permission: 'workspace-write', log, onNotification() {}, onPermissionRequest() {} });
    proc.start();
    await proc.initialize();
    let err = null;
    try {
      await proc.request('session/resume', { sessionId: 'x', cwd: WS, mcpServers: [] }, 300);
    } catch (e) {
      err = e;
    }
    check('code=ACP_TIMEOUT', err?.code === 'ACP_TIMEOUT', `${err?.code}`);
    check('method=session/resume', err?.method === 'session/resume', `${err?.method}`);
    check('timeoutMs 如实回报', err?.timeoutMs === 300, `${err?.timeoutMs}`);
    check('报错文本保持不变（既有断言/文档仍然成立）', err?.message === 'ACP 请求超时: session/resume', err?.message);
    await proc.stop();
    read();
  }

  // ── [6] 共享宿主上还有别的会话 → 不重试 ─────────────────────
  if (SHARED_PROCESS) {
    console.log('\n[6] 共享宿主上还挂着别的会话时不重试（那个进程里可能还有这条 resume 在跑）');
    const read = scenario('hang-session', { FAKE_ACP_HANG_SESSION: 'shared-hang' });
    const healthy = newConv('shared-ok');
    const stuck = newConv('shared-hang');
    let okErr = null;
    try {
      await healthy.ensureAlive();
    } catch (e) {
      okErr = e;
    }
    check('同宿主的另一个会话正常 resume', okErr === null, okErr?.message);
    let err = null;
    try {
      await stuck.ensureAlive();
    } catch (e) {
      err = e;
    }
    const { starts, resumes } = read();
    const stuckResumes = resumes.filter((r) => r.pid === starts[0]).length;
    check('停滞的会话报错', /恢复会话失败/.test(err?.message ?? ''), err?.message);
    check('没有为它重试（宿主进程只有一个）', starts.length === 1, `starts=${starts.length}`);
    check('resume 总共只有 2 次（healthy 1 次 + stuck 1 次，stuck 没有第 2 次）', resumes.length === 2, `resumes=${resumes.length} stuck=${stuckResumes}`);
    check('同宿主的健康会话没被连坐', healthy.proc?.alive === true && isPidAlive(starts[0]));
    await healthy.close();
    await settle();
  } else {
    console.log('\n[6] （共享宿主专属场景，本轮 DSH_MCP_SHARED_PROCESS=0 跳过）');
  }
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  // 兜底：任何还活着的假进程都杀掉，再删临时目录。
  for (const pid of allPids) {
    if (pid && pid !== process.pid && isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
      break;
    } catch {
      await settle(300);
    }
  }
}

console.log(`\n===== resume 重试（${SHARED_PROCESS ? '共享进程' : '一会话一进程'}）：通过 ${pass}，失败 ${failed} =====`);

let childFailed = false;
if (!CHILD && SHARED_PROCESS) {
  console.log('\n──── 再跑一遍：DSH_MCP_SHARED_PROCESS=0（一会话一进程） ────');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    stdio: 'inherit',
    env: { ...process.env, DSH_MCP_SHARED_PROCESS: '0' },
  });
  childFailed = r.status !== 0;
}
process.exit(failed || childFailed ? 1 : 0);
