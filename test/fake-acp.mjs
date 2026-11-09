/**
 * 假的 DSH ACP 服务端（测试用，零依赖）：换行 JSON-RPC over stdio，行为由环境变量编排。
 *
 * 用法：`DSH_BIN=<本文件>` 让 AcpProcess 拉起它，而不是真的 DSH。
 *
 * 环境变量：
 *   FAKE_ACP_DIR     必填。每个进程往 `<dir>/events.jsonl` 追加 { pid, event|method }，
 *                    测试靠它数"拉起了几个进程、各收到几次 session/resume"。
 *   FAKE_ACP_RESUME  session/resume 的行为：
 *                      ok            正常应答（默认）
 *                      hang-first    **全局第一次** resume 永远不应答（模拟 DSH 偶发停滞），之后正常
 *                      hang-always   一直不应答
 *                      hang-session  只对 FAKE_ACP_HANG_SESSION 指定的会话 id 不应答（同进程里别的会话照常 resume）
 *                      lease         立刻回"写锁被占用"（DSH 真实的措辞，被 ACP 包成 -32603）
 *                      invalid       立刻回 invalid params（-32602）
 *   FAKE_ACP_NOISE   =1 时每条应答前先输出 null / 数字 / 数组 / 字符串这类非对象 JSON 行
 *
 * stdin EOF → 立刻退出：和真实 DSH "stdin 关闭 → 有界退出" 一致，所以 AcpProcess.stop() 走优雅路径。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.FAKE_ACP_DIR;
const MODE = process.env.FAKE_ACP_RESUME ?? 'ok';
if (!DIR) {
  console.error('FAKE_ACP_DIR is required');
  process.exit(2);
}
mkdirSync(DIR, { recursive: true });
const EVENTS = join(DIR, 'events.jsonl');
const record = (o) => appendFileSync(EVENTS, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
const resumeCount = () =>
  existsSync(EVENTS)
    ? readFileSync(EVENTS, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"method":"session/resume"')).length
    : 0;

// FAKE_ACP_NOISE=1：每条应答前先吐几行“合法 JSON 但不是对象”的噪声（null / 数字 / 数组 / 字符串）。
const NOISE = process.env.FAKE_ACP_NOISE === '1';
const send = (obj) => process.stdout.write(`${NOISE ? 'null\n42\n[1,2]\n"x"\n' : ''}${JSON.stringify(obj)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

record({ event: 'start' });

function handle(msg) {
  if (msg.method === undefined || msg.id === undefined) return;
  // 先记账再决定是否应答：hang-first 要数"此前有没有人 resume 过"，所以计数在记录之前取。
  const priorResumes = msg.method === 'session/resume' ? resumeCount() : 0;
  record({ method: msg.method });
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', version: '0.0.0' },
        agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
        authMethods: [],
      });
    case 'session/new':
      return ok(msg.id, { sessionId: 'fake-session', configOptions: [] });
    case 'session/resume':
      if (MODE === 'hang-always' || (MODE === 'hang-first' && priorResumes === 0)) return; // 沉默
      if (MODE === 'hang-session' && msg.params?.sessionId === process.env.FAKE_ACP_HANG_SESSION) return;
      if (MODE === 'lease') {
        return fail(msg.id, -32603, 'Internal error', {
          details: `session ${msg.params?.sessionId} is already owned by an active write handle`,
        });
      }
      if (MODE === 'invalid') return fail(msg.id, -32602, 'Invalid params', { details: 'session is not resumable' });
      return ok(msg.id, { configOptions: [] });
    case 'session/set_config_option':
      return ok(msg.id, { configOptions: [] });
    case 'session/close':
      return ok(msg.id, {});
    default:
      return fail(msg.id, -32601, 'Method not found');
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      record({ event: 'bad-line', error: e.message });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
