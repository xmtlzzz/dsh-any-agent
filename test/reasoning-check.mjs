/**
 * 验证 ACP 是否真的转发思考内容（agent_thought_chunk）。
 * 用一个明确要求逐步推理的题目来逼出 reasoning，并对比 hide / full 两种档位。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from './mcp-client.mjs';

const STATE = join(tmpdir(), `dsh-any-agent-reason-state-${Date.now()}.json`);
const ws = mkdtempSync(join(tmpdir(), 'dsh-any-agent-reason-ws-'));
const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

try {
  await client.initialize();
  const start = await client.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 120_000);
  const id = start?.structuredContent?.conversation_id;
  check('建会话成功', Boolean(id), JSON.stringify(start?.structuredContent ?? start));
  console.log('conversation_id =', id);

  const prompt =
    '请一步步推理再回答：一个笼子里有鸡和兔共 35 个头、94 只脚，鸡和兔各几只？' +
    '要求：先写出你的推理过程（列方程、逐步求解），最后一行只写答案。';

  console.log('\n--- reasoning=hide ---');
  const r1 = await client.callTool('dsh_send', { conversation_id: id, prompt, wait: true, reasoning: 'hide' }, 300_000);
  const s1 = r1?.structuredContent ?? {};
  console.log('thinking_stats:', JSON.stringify(s1.thinking_stats));
  console.log('structured.thinking 是否为空:', JSON.stringify(s1.thinking ?? ''));
  console.log('答复全文:\n' + (s1.answer ?? ''));
  check('hide：返回了正文', typeof s1.answer === 'string' && s1.answer.trim().length > 0);
  check('hide：结构化结果里没有思考正文', !s1.thinking, JSON.stringify(String(s1.thinking ?? '').slice(0, 80)));
  check('hide：thinking_stats 标记为隐藏', s1.thinking_stats?.hidden === true, JSON.stringify(s1.thinking_stats));

  console.log('\n--- reasoning=full（同一会话追问，逼出第二段思考）---');
  const r2 = await client.callTool(
    'dsh_send',
    { conversation_id: id, prompt: '再算一遍：如果头变成 50、脚变成 140，鸡兔各几只？同样先推理再给答案。', wait: true, reasoning: 'full' },
    300_000,
  );
  const s2 = r2?.structuredContent ?? {};
  console.log('thinking_stats:', JSON.stringify(s2.thinking_stats));
  console.log('结构化 thinking 长度:', (s2.thinking ?? '').length);
  console.log('结构化 thinking 前 500 字:\n' + (s2.thinking ?? '').slice(0, 500));
  const hasThinkingSection = McpClient.text(r2).includes('--- 思考内容 ---');
  console.log('\n渲染文本里是否含思考段:', hasThinkingSection);
  check('full：返回了正文', typeof s2.answer === 'string' && s2.answer.trim().length > 0);
  check('full：结构化结果包含思考正文', typeof s2.thinking === 'string' && s2.thinking.trim().length > 0, `len=${(s2.thinking ?? '').length}`);
  check('full：thinking_stats 不标记隐藏', s2.thinking_stats?.hidden === false, JSON.stringify(s2.thinking_stats));
  check('full：渲染文本包含思考段', hasThinkingSection);

  await client.callTool('dsh_release', { conversation_id: id, forget: true });
} catch (e) {
  fail++;
  console.log('异常:', e.message);
  console.log(client.stderr.slice(-20).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
  try { rmSync(ws, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== reasoning 检查：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);