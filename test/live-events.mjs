/**
 * live 事件流（服务端写入侧）回归：离线，不拉 DSH、不调用模型。
 *
 * 守的不变量：
 *   1. 一个回合写出 run.start → tool（只在状态变化时） → approval → run.end，字段齐全；
 *   2. 思考内容在任何级别都不落盘；
 *   3. meta 级别不含任何预览（命令、路径、prompt、title）；detail 级别预览已脱敏；
 *   4. live 写入失败（目录不可写）不影响派活；off 级别什么都不写；
 *   5. 现有输出不变：tools_used 不混入 live 跟踪字段；
 *   6. 失败路径 / 审批裁决 / 排队 / forget 都有对应事件或清理。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-live-events-'));
const liveDir = join(root, 'live');
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_MCP_LIVE_DIR = liveDir;
process.env.DSH_MCP_LIVE = 'detail';
process.env.DSH_MCP_APPROVAL = 'auto-allow';
// token 用量来自 DSH 的投影缓存：指到临时 DSH_HOME，测试里自己写假的缓存文件。
process.env.DSH_HOME = join(root, 'dsh-home');

const { Conversation } = await import('../src/hub.mjs');
const live = await import('../src/live.mjs');

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

const log = { info() {}, debug() {}, dshStderr() {} };
const hub = {
  log,
  approvalTimeoutMs: 300_000,
  save() {},
  remove() {},
  clearRunSentinel() {},
  writeRunSentinel() {
    return null;
  },
  runSentinelPath(id, runId) {
    return join(root, 'runs', id, `${runId}.json`);
  },
};

/** 假 ACP 进程：session/prompt 由测试手动结束。 */
function fakeProc() {
  let finish;
  const proc = {
    alive: true,
    notified: [],
    started: false,
    request(method) {
      if (method === 'session/prompt') {
        proc.started = true;
        return new Promise((resolve) => (finish = resolve));
      }
      return Promise.resolve({});
    },
    /** 等到 prompt() 真的把 session/prompt 发出来（之前还有 git 快照要跑）。 */
    async ready() {
      for (let i = 0; i < 500 && !proc.started; i++) await new Promise((r) => setTimeout(r, 10));
      if (!proc.started) throw new Error('session/prompt 一直没发出');
      proc.started = false;
    },
    notify(method) {
      proc.notified.push(method);
    },
    end(stopReason = 'end_turn') {
      finish({ stopReason });
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

const events = (id) => {
  const f = live.liveFilePath(id, liveDir);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};
const tick = () => new Promise((r) => setTimeout(r, 20));
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const THOUGHT = 'PRIVATE-THOUGHT-MARKER-7d1c';

try {
  console.log('\n[1] 一个完整回合的事件序列（detail）');
  live.setLiveClient({ name: 'claude-code', version: '9.9.9' });
  const { conv, proc } = makeConv('live-events-1');
  const pending = conv.prompt(`run the tests with token=${SECRET}`, { wait: true, timeoutMs: 0 });
  await proc.ready();
  const update = (u) => conv.onUpdate({ sessionId: conv.id, update: u });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: THOUGHT } });
  update({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'pwsh', kind: 'execute', title: 'pwsh', status: 'pending', rawInput: { command: `npm test --token ${SECRET}` } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'pending' }); // 重复状态：不该再写
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
  await conv.onPermissionRequest({
    toolCall: { toolCallId: 't1', name: 'pwsh', title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test', sandbox_permissions: 'danger-full-access' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  update({ sessionUpdate: 'tool_call', toolCallId: 't2', name: 'read', kind: 'read', title: 'read src/a.ts', status: 'in_progress', rawInput: { path: 'src/a.ts' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  proc.end('end_turn');
  const result = await pending;
  const ev = events(conv.id);
  const types = ev.map((e) => e.type);

  check('事件顺序：run.start → tool… → approval → … → run.end', () => types[0] === 'run.start' && types[types.length - 1] === 'run.end' && types.includes('approval'));
  check('run.start 带 via / client / cwd / 权限', () => {
    const s = ev[0];
    return s.via === 'send' && s.client === 'claude-code' && s.cwd === root && s.permission === 'workspace-write' && s.on_approval === 'auto-allow' && s.run === result.run_id;
  });
  check('公共字段：v / ts / conv / w / n / turn', () => ev.every((e) => e.v === 1 && e.ts && e.conv === conv.id && /^\d+:[0-9a-f]+$/.test(e.w) && Number.isInteger(e.n) && e.turn === 1));
  const t1 = ev.filter((e) => e.type === 'tool' && e.tool_call_id === 't1');
  check('同一工具只在状态变化时写（pending / in_progress / completed）', () => t1.map((e) => e.status).join(',') === 'pending,in_progress,completed', t1.map((e) => e.status).join(','));
  check('完成的工具带 elapsed_ms', () => typeof t1[t1.length - 1].elapsed_ms === 'number');
  check('工具输入预览已脱敏', () => t1[0].input_preview.includes('npm test') && !t1[0].input_preview.includes(SECRET));
  check('路径类输入取 path 字段', () => ev.find((e) => e.tool_call_id === 't2').input_preview === 'src/a.ts');
  const ap = ev.find((e) => e.type === 'approval');
  check('审批事件：auto-allow + 提权 + 关联工具', () => ap.mode === 'auto-allow' && ap.escalation === 'danger-full-access' && ap.tool_call_id === 't1');
  const end = ev[ev.length - 1];
  check('run.end 汇总：状态 / 工具数 / 自动放行 / 提权', () => end.status === 'done' && end.stop_reason === 'end_turn' && end.tool_count === 2 && end.auto_approvals === 1 && end.auto_escalations === 1 && typeof end.duration_ms === 'number');
  check('prompt 预览已脱敏', () => ev[0].prompt_preview.includes('run the tests') && !ev[0].prompt_preview.includes(SECRET));
  const raw = readFileSync(live.liveFilePath(conv.id, liveDir), 'utf8');
  check('★ 思考内容不落盘', () => !raw.includes(THOUGHT));
  check('★ 任何地方都不出现原始密钥', () => !raw.includes(SECRET));
  check('现有输出不变：tools_used 不含 live 跟踪字段', () => result.tools_used.every((t) => !('at' in t) && !('hasInput' in t)) && result.tools_used.length === 2);

  console.log('\n[2] meta 级别：没有任何预览');
  live.configureLive({ level: 'meta' });
  const m = makeConv('live-events-meta');
  const pm = m.conv.prompt('secret plan: rewrite everything', { wait: true, timeoutMs: 0 });
  await m.proc.ready();
  m.conv.onUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'm1', name: 'pwsh', kind: 'execute', title: 'pwsh: rm -rf build', status: 'in_progress', rawInput: { command: 'rm -rf build' } } });
  m.proc.end('end_turn');
  await pm;
  const metaRaw = readFileSync(live.liveFilePath('live-events-meta', liveDir), 'utf8');
  check('meta 不含 prompt / 命令 / title', () => !metaRaw.includes('secret plan') && !metaRaw.includes('rm -rf') && !metaRaw.includes('prompt_preview') && !metaRaw.includes('input_preview'));
  check('meta 仍有工具名与状态', () => events('live-events-meta').some((e) => e.type === 'tool' && e.name === 'pwsh' && e.status === 'in_progress'));
  // 真实 DSH：没有 name，工具名在 title 里
  const m2 = makeConv('live-events-meta-title');
  const pm2 = m2.conv.prompt('x', { wait: true, timeoutMs: 0 });
  await m2.proc.ready();
  m2.conv.onUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'other', status: 'in_progress', rawInput: { path: 'a.txt' } } });
  m2.conv.onUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'r2', title: 'pwsh: rm -rf build', status: 'in_progress' } });
  m2.proc.end('end_turn');
  await pm2;
  const mt = events('live-events-meta-title').filter((e) => e.type === 'tool');
  check('没有 name 时，纯标识符的 title 当作工具名（真实 DSH 的形状）', () => mt.find((e) => e.tool_call_id === 'r1').name === 'read');
  check('含空格的 title 不进 meta 的 name', () => mt.find((e) => e.tool_call_id === 'r2').name === null && !JSON.stringify(mt).includes('rm -rf'));

  console.log('\n[3] off 级别：什么都不写');
  live.configureLive({ level: 'off' });
  const o = makeConv('live-events-off');
  const po = o.conv.prompt('hello', { wait: true, timeoutMs: 0 });
  await o.proc.ready();
  o.proc.end('end_turn');
  await po;
  check('off：没有事件文件', () => !existsSync(live.liveFilePath('live-events-off', liveDir)));

  console.log('\n[4] live 目录不可写时派活照常');
  const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, 'x');
  live.configureLive({ level: 'detail', dir: join(blocker, 'live') });
  const b = makeConv('live-events-blocked');
  const pb = b.conv.prompt('hello', { wait: true, timeoutMs: 0 });
  await b.proc.ready();
  b.proc.end('end_turn');
  const rb = await pb;
  check('写失败不抛错，回合正常结束', () => rb.stop_reason === 'end_turn' && !rb.error);
  check('emitLive 返回 false 而不是抛错', () => live.emitLive('live-events-blocked', 'tool', {}) === false);
  live.configureLive({ dir: liveDir, level: 'detail' });

  console.log('\n[5] ask 审批：挂起 → 调用方裁决 / 回合结束取消');
  const a = makeConv('live-events-ask', { onApproval: 'ask' });
  const pa = a.conv.prompt('needs approval', { wait: true, timeoutMs: 0 });
  await a.proc.ready();
  const req = { toolCall: { toolCallId: 'a1', name: 'pwsh', title: 'Run x', kind: 'execute', rawInput: { command: 'x' } }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] };
  const decided = a.conv.onPermissionRequest(req);
  await tick();
  const apId = a.conv.snapshot().pending_approvals[0];
  a.conv.decideApproval(apId, 'allow');
  await decided;
  a.conv.onPermissionRequest({ ...req, toolCall: { ...req.toolCall, toolCallId: 'a2' } });
  await tick();
  const ap2 = a.conv.snapshot().pending_approvals[0];
  a.proc.end('end_turn');
  await pa;
  const aev = events('live-events-ask');
  check('ask 审批带 approval_id', () => aev.some((e) => e.type === 'approval' && e.mode === 'ask' && e.approval_id === apId));
  check('调用方裁决写 approval.decided（by=caller）', () => aev.some((e) => e.type === 'approval.decided' && e.approval_id === apId && e.by === 'caller' && e.decision === 'allow' && e.effective === 'selected'));
  check('回合结束时未裁决的审批写 by=turn_end', () => aev.some((e) => e.type === 'approval.decided' && e.approval_id === ap2 && e.by === 'turn_end'));

  console.log('\n[6] 起不来的回合：只有 run.end(error)');
  const f = makeConv('live-events-fail');
  f.conv.ensureAlive = async () => {
    throw new Error(`session-writer-held password=${SECRET}`);
  };
  try {
    await f.conv.prompt('x', { wait: true, timeoutMs: 0 });
  } catch {}
  const fev = events('live-events-fail');
  check('失败路径写 run.end status=error，错误已脱敏', () => fev.length === 1 && fev[0].type === 'run.end' && fev[0].status === 'error' && !JSON.stringify(fev[0]).includes(SECRET));

  console.log('\n[7] 排队 / 取消 / forget');
  const q = makeConv('live-events-queue');
  const pq = q.conv.prompt('first', { wait: true, timeoutMs: 0 });
  await q.proc.ready();
  const { run: queued } = q.conv.enqueue('second');
  const { run: dropped } = q.conv.enqueue('third');
  q.conv.queueRemove(dropped.run_id);
  q.proc.end('end_turn');
  await pq;
  await q.proc.ready(); // 队首任务自动开跑
  const qev = events('live-events-queue');
  check('入队写 run.queued（带位置）', () => qev.some((e) => e.type === 'run.queued' && e.run === queued.run_id && e.position === 1));
  check('取消排队写 run.end cancelled', () => qev.some((e) => e.type === 'run.end' && e.run === dropped.run_id && e.status === 'cancelled'));
  check('队列里的任务开跑时 via=queue', () => qev.some((e) => e.type === 'run.start' && e.run === queued.run_id && e.via === 'queue'));
  q.proc.end('end_turn');
  await q.conv.waitIdle(5000);

  const g = makeConv('live-events-forget');
  live.emitLive('live-events-forget', 'conv.open', { cwd: root });
  check('forget 之前事件目录存在', () => existsSync(live.liveConvDir('live-events-forget', liveDir)));
  g.conv.proc = null;
  await g.conv.close({ forget: true });
  check('forget 删除事件目录', () => !existsSync(live.liveConvDir('live-events-forget', liveDir)));

  console.log('\n[7a] 一个进程服务几个客户端：事件记在发起调用的客户端名下');
  {
    // 就像常驻进程里两个连接各自的 tools/call（mcp.mjs 把每个调用包在 withLiveClient 里）。
    const x = makeConv('live-events-clients');
    const pa = live.withLiveClient({ name: 'client-a', version: '1' }, () => x.conv.prompt('first', { wait: true, timeoutMs: 0 }));
    await x.proc.ready();
    const { run: qb } = live.withLiveClient({ name: 'client-b', version: '1' }, () => x.conv.enqueue('second'));
    x.proc.end('end_turn'); // client-a 的回合结束触发出队
    await pa;
    await x.proc.ready();
    live.emitLive('live-events-clients', 'conv.open', { cwd: root }); // 任何调用链之外
    const xev = events('live-events-clients');
    const startOf = (pred) => xev.find((e) => e.type === 'run.start' && pred(e));
    check('client-a 发的回合：run.start 记 client-a', () => startOf((e) => e.via === 'send')?.client === 'client-a');
    check('client-b 排的队：run.queued 记 client-b', () => xev.find((e) => e.type === 'run.queued' && e.run === qb.run_id)?.client === 'client-b');
    check('★ client-b 排的回合由 client-a 的回合结束带起来，run.start 仍记 client-b', () =>
      startOf((e) => e.run === qb.run_id)?.client === 'client-b',
      JSON.stringify(startOf((e) => e.run === qb.run_id)),
    );
    check('调用链之外仍用进程级的客户端', () => xev.filter((e) => e.type === 'conv.open').at(-1)?.client === 'claude-code');
    x.proc.end('end_turn');
    await x.conv.waitIdle(5000);
  }

  console.log('\n[7b] token 用量：回合内增量 + 最终值');
  {
    const projDir = join(root, 'dsh-home', 'storages', 'session_projcache', 'sessions');
    mkdirSync(projDir, { recursive: true });
    const writeProj = (id, totals, pressure) =>
      writeFileSync(
        join(projDir, `${id}.json`),
        JSON.stringify({ record: { rows: { tokenUsage: { val: { totals } }, contextPressure: { val: pressure } } } }),
      );
    const id = 'live-events-tokens';
    // 会话之前已经用过一些 token（更早的回合）
    writeProj(id, { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 }, { pressureTokens: 6000, contextWindow: 1000000 });
    const k = makeConv(id);
    const pk = k.conv.prompt('x', { wait: true, timeoutMs: 0 });
    await k.proc.ready();
    writeProj(id, { uncachedInputTokens: 1600, outputTokens: 260, cacheReadTokens: 9000, cacheWriteTokens: 10 }, { pressureTokens: 7000, contextWindow: 1000000 });
    k.conv.onUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'k1', title: 'read', status: 'in_progress' } });
    writeProj(id, { uncachedInputTokens: 1800, outputTokens: 300, cacheReadTokens: 12000, cacheWriteTokens: 10 }, { pressureTokens: 7400, contextWindow: 1000000 });
    k.proc.end('end_turn');
    await pk;
    const uev = events(id).filter((e) => e.type === 'usage');
    const mid = uev.find((e) => !e.final);
    const fin = uev.find((e) => e.final);
    check('回合中发出 usage 增量（相对回合开始的基线）', () => mid && mid.tokens.input === 600 && mid.tokens.output === 60 && mid.tokens.cache_read === 4000 && mid.tokens.cache_write === 10);
    check('回合结束后发最终值（final=true）', () => fin && fin.tokens.input === 800 && fin.tokens.output === 100 && fin.tokens.cache_read === 7000);
    check('带会话累计与上下文占用', () => fin.session_tokens.input === 1800 && fin.session_tokens.cache_read === 12000 && fin.context.used === 7400 && fin.context.window === 1000000);
    check('usage 事件挂在本回合 run 上', () => uev.every((e) => e.run === fin.run && typeof e.run === 'string'));
    check('final 在 run.end 之后', () => {
      const ev2 = events(id);
      return ev2.findIndex((e) => e.type === 'run.end') < ev2.findIndex((e) => e.type === 'usage' && e.final);
    });
    // 没有投影缓存（DSH 还没写）：不发 usage，也不报错
    const nk = makeConv('live-events-no-proj');
    const pn = nk.conv.prompt('x', { wait: true, timeoutMs: 0 });
    await nk.proc.ready();
    nk.proc.end('end_turn');
    const rn = await pn;
    check('没有投影缓存时不发 usage、回合照常', () => !events('live-events-no-proj').some((e) => e.type === 'usage') && rn.stop_reason === 'end_turn');
  }

  console.log('\n[7c] dsh_doctor 的 live 检查');
  {
    const { inspectLive } = await import('../src/doctor.mjs');
    const off = inspectLive({ dir: liveDir, level: 'off' });
    check('关闭时报 ok 并说明看不到新派活', () => off[0] === 'ok' && off[1].includes('已关闭'));
    const blocked = inspectLive({ dir: join(root, 'not-a-dir', 'live'), level: 'detail' });
    check('目录不可写只报 warn（不影响派活）并给出修复建议', () => blocked[0] === 'warn' && blocked[1].includes('不可写') && blocked[2]?.includes('DSH_MCP_LIVE_DIR'));
    const emptyDir = join(root, 'live-empty');
    const empty = inspectLive({ dir: emptyDir, level: 'detail' });
    check('空目录：ok，提示还没有事件', () => empty[0] === 'ok' && empty[1].includes('0 个会话') && empty[1].includes('还没有任何事件'));
    const normal = inspectLive({ dir: liveDir, level: 'detail' });
    check('有事件时报会话数、占用和最近事件时间', () => normal[0] === 'ok' && /\d+ 个会话/.test(normal[1]) && !normal[1].includes(' 0 个会话') && normal[1].includes('最近一条事件'));
  }

  console.log('\n[8] 写入侧的防御');
  check('非法会话 id 不写（防路径穿越）', () => live.emitLive('../escape', 'tool', {}) === false && !existsSync(join(root, 'escape')));
  const big = 'y'.repeat(20_000);
  live.emitLive('live-events-big', 'tool', { name: 'pwsh' }, { input_preview: big });
  const bigEv = events('live-events-big')[0];
  check('超长行丢掉 detail 并标 truncated', () => bigEv.truncated === true && !('input_preview' in bigEv) && bigEv.name === 'pwsh');
  check('summarizeToolInput：命令 > 路径 > 整体', () =>
    live.summarizeToolInput({ command: 'ls', path: 'x' }) === 'ls' &&
    live.summarizeToolInput({ path: 'a', pattern: 'b' }) === 'a · b' &&
    live.summarizeToolInput({ foo: 1 }) === '{"foo":1}');
  check('livePreview 脱敏 Bearer 与 URL 口令', () => {
    const s = live.livePreview('curl -H "Authorization: Bearer abc.def" https://u:p@host/x');
    return !s.includes('abc.def') && !s.includes('u:p@');
  });
} catch (e) {
  failed += 1;
  console.log(`  ✗ 未捕获异常: ${e.stack ?? e.message}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* git 快照子进程可能还占着目录；cleanup.mjs 会按前缀收尾 */
  }
}

console.log(`\n===== live 事件流（写入侧）：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
