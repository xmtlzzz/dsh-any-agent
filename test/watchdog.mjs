/**
 * 回合看门狗回归（离线，不拉 DSH、不调用模型）。
 *
 * 守的不变量：
 *   1. 判定（watchdog.mjs）：开始前不打扰；没进展才算卡住；有工具在跑时宽限放大；
 *      等调用方裁决审批时不判卡住；总时长上限不看进展；阈值为 0 时关掉那一项。
 *   2. 接入（conversation.mjs）：卡住 → 发 session/cancel → 回合照常收尾，结果、审核单、
 *      哨兵里都能看出是看门狗中断的；一直有进展的回合不会被打断。
 *
 * 阈值用环境变量调到毫秒级（必须在 import src 之前设）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-watchdog-'));
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_MCP_LIVE_DIR = join(root, 'live');
process.env.DSH_HOME = join(root, 'dsh-home');
process.env.DSH_MCP_GIT_STATUS = '0';
process.env.DSH_MCP_WATCHDOG_AFTER_MS = '150';
process.env.DSH_MCP_STALL_MS = '200';
process.env.DSH_MCP_TURN_MAX_MS = '0';

const { Conversation } = await import('../src/hub.mjs');
const { watchdogVerdict, watchdogTickMs, TOOL_STALL_FACTOR } = await import('../src/watchdog.mjs');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const ok = fn();
    if (ok === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('\n[1] 判定规则（纯函数）');
  const base = { afterMs: 15 * 60_000, stallMs: 10 * 60_000, maxMs: 2 * 3600_000, toolRunning: false, waitingOnCaller: false };
  const min = 60_000;
  check('开始 15 分钟内，哪怕 14 分钟没进展也不打扰', () =>
    watchdogVerdict({ ...base, elapsedMs: 14 * min, sinceProgressMs: 14 * min }) === null);
  check('过了 15 分钟、还在持续进展 → 继续跑', () =>
    watchdogVerdict({ ...base, elapsedMs: 40 * min, sinceProgressMs: 30_000 }) === null);
  check('过了 15 分钟、10 分钟没进展、没有工具在跑 → stalled', () =>
    watchdogVerdict({ ...base, elapsedMs: 16 * min, sinceProgressMs: 10 * min })?.reason === 'stalled');
  check(`有工具在跑：宽限放大 ${TOOL_STALL_FACTOR} 倍（20 分钟没进展仍不算卡住）`, () =>
    watchdogVerdict({ ...base, toolRunning: true, elapsedMs: 40 * min, sinceProgressMs: 20 * min }) === null);
  check('有工具在跑、超过放大后的宽限 → stalled 且标明 tool_running', () => {
    const v = watchdogVerdict({ ...base, toolRunning: true, elapsedMs: 40 * min, sinceProgressMs: 30 * min });
    return v?.reason === 'stalled' && v.tool_running === true && v.limit_ms === 30 * min;
  });
  check('等调用方裁决审批时不判卡住', () =>
    watchdogVerdict({ ...base, waitingOnCaller: true, elapsedMs: 60 * min, sinceProgressMs: 50 * min }) === null);
  check('总时长上限不看进展（循环里一直有输出也会被拦）', () =>
    watchdogVerdict({ ...base, elapsedMs: 2 * 3600_000, sinceProgressMs: 1000 })?.reason === 'max_duration');
  check('上限在等审批时同样生效', () =>
    watchdogVerdict({ ...base, waitingOnCaller: true, elapsedMs: 3 * 3600_000, sinceProgressMs: 0 })?.reason === 'max_duration');
  check('afterMs=0 / stallMs=0 关掉"卡住"判定；maxMs=0 关掉上限', () =>
    watchdogVerdict({ ...base, afterMs: 0, elapsedMs: 60 * min, sinceProgressMs: 60 * min }) === null &&
    watchdogVerdict({ ...base, stallMs: 0, elapsedMs: 60 * min, sinceProgressMs: 60 * min }) === null &&
    watchdogVerdict({ ...base, maxMs: 0, elapsedMs: 99 * 3600_000, sinceProgressMs: 0 }) === null);
  check('巡检间隔：默认阈值下 60 秒一次，小阈值不低于 50ms', () =>
    watchdogTickMs({ stallMs: 10 * min, maxMs: 0 }) === 60_000 && watchdogTickMs({ stallMs: 100, maxMs: 0 }) === 50);

  // ── 接入 ───────────────────────────────────────────────────────
  const sentinels = [];
  const hub = {
    log: { info() {}, debug() {}, dshStderr() {} },
    approvalTimeoutMs: 300_000,
    save() {},
    remove() {},
    clearRunSentinel() {},
    writeRunSentinel(id, run) {
      sentinels.push({ id, run_id: run.run_id, result: run.result });
      return join(root, 'runs', id, `${run.run_id}.json`);
    },
    runSentinelPath(id, runId) {
      return join(root, 'runs', id, `${runId}.json`);
    },
  };
  /** 假 ACP 进程：收到 session/cancel 就以 cancelled 结束回合（与 DSH 一致）。 */
  function fakeProc() {
    let finish = null;
    const proc = {
      alive: true,
      cancels: 0,
      request(method) {
        if (method === 'session/prompt') return new Promise((resolve) => (finish = resolve));
        return Promise.resolve({});
      },
      notify(method) {
        if (method !== 'session/cancel') return;
        proc.cancels += 1;
        finish?.({ stopReason: 'cancelled' });
      },
      end(stopReason = 'end_turn') {
        finish?.({ stopReason });
      },
    };
    return proc;
  }
  function makeConv(id, extra = {}) {
    const conv = new Conversation({ id, cwd: root, permission: 'workspace-write', onApproval: 'auto-allow', ...extra }, hub);
    const proc = fakeProc();
    conv.ensureAlive = async () => {
      conv.proc = proc;
      return proc;
    };
    return { conv, proc };
  }
  const update = (conv, u) => conv.onUpdate({ update: u });
  const say = (conv, text) => update(conv, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  console.log('\n[2] ★ 没有任何进展 → 看门狗发 cancel，回合照常收尾并写哨兵');
  {
    const { conv, proc } = makeConv('wd-stalled-0000-0000-0000-000000000001');
    const t0 = Date.now();
    const result = await conv.prompt('卡住的任务', { wait: true, timeoutMs: 5000 });
    const took = Date.now() - t0;
    check('发了 session/cancel', () => proc.cancels >= 1);
    check('不早于"开始后多久才判"的阈值', () => took >= 150, `${took}ms`);
    check('回合以 cancelled 结束（与 dsh_interrupt 同一路径）', () => result.stop_reason === 'cancelled', result.stop_reason);
    check('结果里带 watchdog.reason=stalled 与诊断数字', () =>
      result.watchdog?.reason === 'stalled' && result.watchdog.since_progress_ms >= 200 && typeof result.watchdog.at === 'string',
    JSON.stringify(result.watchdog));
    check('哨兵照常写出、内容带 watchdog', () => sentinels.at(-1)?.result?.watchdog?.reason === 'stalled');
    check('审核清单点名看门狗中断', () => result.review?.checklist?.some((x) => /看门狗|watchdog/.test(x)), JSON.stringify(result.review?.checklist));
    check('会话回到空闲，可以接着派活', () => conv.busy === false && conv.state() !== 'running');
  }

  console.log('\n[3] ★ 一直有进展 → 不打断，正常结束');
  {
    const { conv, proc } = makeConv('wd-active-00000-0000-0000-000000000002');
    const pending = conv.prompt('一直在干活的任务', { wait: true, timeoutMs: 5000 });
    for (let i = 0; i < 14; i++) {
      await sleep(50);
      say(conv, `第 ${i} 段 `);
    }
    proc.end('end_turn');
    const result = await pending;
    check('跑了 700ms（超过 150+200）也没被 cancel', () => proc.cancels === 0, String(proc.cancels));
    check('结果里没有 watchdog 字段', () => !('watchdog' in result));
    check('stop_reason=end_turn', () => result.stop_reason === 'end_turn');
  }

  console.log('\n[4] 有工具在跑时宽限放大，最后仍会被拦下');
  {
    const { conv, proc } = makeConv('wd-tool-0000000-0000-0000-000000000003');
    const t0 = Date.now();
    const pending = conv.prompt('跑长命令', { wait: true, timeoutMs: 5000 });
    await sleep(20);
    update(conv, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pwsh', status: 'in_progress' });
    await sleep(450);
    check(`工具在跑、沉默 450ms（< 200×${TOOL_STALL_FACTOR}）时没被 cancel`, () => proc.cancels === 0, String(proc.cancels));
    const result = await pending;
    check('超过放大后的宽限 → stalled，且记下卡在哪个工具', () =>
      result.watchdog?.reason === 'stalled' && result.watchdog.tool_running === true && result.watchdog.current_tool === 'pwsh',
    JSON.stringify(result.watchdog));
    check('总耗时不少于放大后的宽限', () => Date.now() - t0 >= 600, `${Date.now() - t0}ms`);
  }
  {
    // 两个工具重叠：短的先完成会清掉"当前工具"这个显示字段，但长的还在跑 —— 宽限不能因此缩回去。
    const { conv, proc } = makeConv('wd-overlap-0000-0000-0000-000000000033');
    const pending = conv.prompt('并行跑两个命令', { wait: true, timeoutMs: 5000 });
    await sleep(20);
    update(conv, { sessionUpdate: 'tool_call', toolCallId: 'long', title: 'pwsh', status: 'in_progress' });
    update(conv, { sessionUpdate: 'tool_call', toolCallId: 'short', title: 'read', status: 'in_progress' });
    update(conv, { sessionUpdate: 'tool_call_update', toolCallId: 'short', status: 'completed' });
    await sleep(450);
    check(`★ 一个工具完成、另一个还在跑：沉默 450ms（< 200×${TOOL_STALL_FACTOR}）时没被 cancel`, () => proc.cancels === 0, String(proc.cancels));
    const result = await pending;
    check('最后按放大后的宽限拦下，记下的是还在跑的那个工具', () =>
      result.watchdog?.reason === 'stalled' && result.watchdog.tool_running === true && result.watchdog.current_tool === 'pwsh',
    JSON.stringify(result.watchdog));
  }

  console.log('\n[5] 等调用方裁决审批（on_approval=ask）时不判卡住');
  {
    const { conv, proc } = makeConv('wd-ask-00000000-0000-0000-000000000004', { onApproval: 'ask' });
    const pending = conv.prompt('需要审批的任务', { wait: true, timeoutMs: 5000 });
    await sleep(20);
    const approval = conv.onPermissionRequest({
      toolCall: { toolCallId: 'call-ask', name: 'pwsh', title: 'Run it', rawInput: { command: 'echo hi' } },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    });
    await sleep(600);
    check('审批挂着、沉默 600ms 也没被 cancel', () => proc.cancels === 0, String(proc.cancels));
    conv.decideApproval(conv.snapshot().pending_approvals[0], 'allow');
    await approval;
    say(conv, '审批通过，继续');
    proc.end('end_turn');
    const result = await pending;
    check('正常结束、没有 watchdog 字段', () => result.stop_reason === 'end_turn' && !('watchdog' in result));
  }

  console.log('\n[6] dsh_status 用的快照里有"距上次进展"');
  {
    const { conv, proc } = makeConv('wd-snap-0000000-0000-0000-000000000005');
    const pending = conv.prompt('看快照', { wait: true, timeoutMs: 5000 });
    await sleep(60);
    const snap = conv.snapshot();
    check('跑回合时 since_progress_ms 是数字', () => typeof snap.since_progress_ms === 'number' && snap.since_progress_ms >= 0, String(snap.since_progress_ms));
    say(conv, 'x');
    check('收到更新后归零附近', () => conv.snapshot().since_progress_ms < 50, String(conv.snapshot().since_progress_ms));
    proc.end('end_turn');
    await pending;
    check('空闲时是 null', () => conv.snapshot().since_progress_ms === null);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n===== watchdog: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
