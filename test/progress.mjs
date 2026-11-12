/**
 * MCP 进度通知：调用带 progressToken 时，阻塞中的 tools/call 定时回报进度。
 *
 * 守住四件事：
 *   - 不带 token 就一条都不发（MCP 的约定：不带就是不想要）；
 *   - progress 单调递增、token 原样带回；
 *   - 响应发出之后不再有进度（协议不允许对已结束的请求再发）；
 *   - 消息里只有时长、工具名、字数 —— 没有命令、路径或正文。
 *
 * 不拉 DSH、不花 token：直接在进程内起 createMcpServer，喂假的 handlers 与假的 hub，
 * 接管 stdout 收它写出的报文。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// 服务端模块加载时会解析状态目录；给它一份独立的，绝不碰真实 ~/.dsh。
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-any-agent-progress-'));
process.env.DSH_MCP_STATE = join(ROOT, 'state.json');
process.env.DSH_HOME = join(ROOT, 'dsh-home');
process.env.DSH_MCP_LOG = 'silent';
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const { createMcpServer } = await import('../src/mcp.mjs');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); failed++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = { conversations: new Map([['c1', { currentTool: 'pwsh', turnOutChars: 120 }]]) };
const handlers = {
  async slow() { await sleep(160); return { text: 'done', structured: { ok: true } }; },
  async fast() { return { text: 'done' }; },
  async boom() { await sleep(120); throw new Error('nope'); },
};
const input = new PassThrough();
const output = new PassThrough();
const server = createMcpServer({ hub, handlers, toolDefs: [], progressIntervalMs: 20, input, output });
server.start();
const send = (message) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
output.resume();
send({ id: 'initialize', method: 'initialize', params: { protocolVersion: '2025-06-18' } });
send({ method: 'notifications/initialized' });
await sleep(0);

/** 发一个 tools/call，收集到响应为止（再多等一会儿，抓响应之后不该出现的报文）。 */
async function call(name, args, meta) {
  const frames = [];
  const read = (chunk) => frames.push({ at: Date.now(), msg: JSON.parse(chunk) });
  output.on('data', read);
  try {
    const id = 'req-' + name;
    const params = { name, arguments: args, ...(meta ? { _meta: meta } : {}) };
    send({ id, method: 'tools/call', params });
    const deadline = Date.now() + 3000;
    while (!frames.some((f) => f.msg.id === id) && Date.now() < deadline) await sleep(5);
    await sleep(80);
    const response = frames.find((f) => f.msg.id === id);
    const progress = frames.filter((f) => f.msg.method === 'notifications/progress');
    return { response, progress };
  } finally {
    output.off('data', read);
  }
}

console.log('\n[1] 带 progressToken 的阻塞调用会回报进度');
{
  const { response, progress } = await call('slow', { conversation_id: 'c1' }, { progressToken: 'tok-1' });
  const values = progress.map((f) => f.msg.params.progress);
  check('响应正常返回', response?.msg.result?.content?.[0]?.text === 'done');
  check('至少收到两条进度', progress.length >= 2, String(progress.length));
  check('token 原样带回', progress.every((f) => f.msg.params.progressToken === 'tok-1'));
  check('progress 严格递增', values.every((v, i) => i === 0 || v > values[i - 1]), values.join(','));
  check('进度是通知（没有 id）', progress.every((f) => f.msg.id === undefined));
  check('响应之后不再有进度', progress.every((f) => f.at <= response.at));
  const message = progress[0]?.msg.params.message ?? '';
  check('消息带当前工具名与已产出字数', /pwsh/.test(message) && /120 chars/.test(message), message);
}

console.log('\n[2] 数字 token 同样有效；不认识的会话只报时长');
{
  const { progress } = await call('slow', { conversation_id: 'unknown' }, { progressToken: 7 });
  check('数字 token 原样带回', progress.length >= 1 && progress.every((f) => f.msg.params.progressToken === 7));
  check('没有会话信息时只有时长', progress.every((f) => /^\d+s$/.test(f.msg.params.message)), progress[0]?.msg.params.message);
}

console.log('\n[3] 不带 token 就不发');
{
  const { response, progress } = await call('slow', { conversation_id: 'c1' });
  check('响应正常返回', response?.msg.result?.content?.[0]?.text === 'done');
  check('一条进度都没有', progress.length === 0, String(progress.length));
}

console.log('\n[4] 很快结束的调用等不到第一条');
{
  const { progress } = await call('fast', {}, { progressToken: 'tok-fast' });
  check('一条进度都没有', progress.length === 0, String(progress.length));
}

console.log('\n[5] 工具抛错时进度同样停下');
{
  const { response, progress } = await call('boom', { conversation_id: 'c1' }, { progressToken: 'tok-err' });
  check('返回 isError', response?.msg.result?.isError === true);
  check('抛错之前有进度', progress.length >= 1, String(progress.length));
  check('响应之后不再有进度', progress.every((f) => f.at <= response.at));
}

console.log('\n[6] MCP 取消停止进度和回包');
{
  const frames = [];
  const read = (chunk) => frames.push(JSON.parse(chunk));
  output.on('data', read);
  try {
    send({ id: 'cancel-me', method: 'tools/call', params: { name: 'slow', _meta: { progressToken: 'cancel-token' } } });
    await sleep(65);
    const count = frames.length;
    send({ method: 'notifications/cancelled', params: { requestId: 'cancel-me' } });
    await sleep(180);
    check('取消后不再发进度，也不发送工具响应',
      count > 0 && frames.length === count && frames.every((frame) => frame.method === 'notifications/progress'));
  } finally {
    output.off('data', read);
  }
}

console.log(`\n===== progress: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
