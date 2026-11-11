/**
 * 哨兵落盘脱敏的纯内存回归（不花 token）。
 *
 * 背景：哨兵会保留 7 天，载荷里的 tools_used[].input 可能含完整命令、路径、
 * 写入的文件内容甚至密钥。这里守住两条：
 *   1) thinking 正文永远被剥掉（默认），且 thinking_omitted 始终是布尔值；
 *   2) 工具输入按审批上下文同一套规则脱敏（密钥类字段 + 常见内联字面量）。
 */

import './live-sandbox.mjs'; // 必须是第一条 import：live 事件别写进真实 ~/.dsh
import { spawnSync } from 'node:child_process';

process.env.DSH_MCP_SENTINEL_INCLUDE_REASONING = '';
const { sanitizeResultForSentinel } = await import('../src/hub.mjs');

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

console.log('\n[1] 思考剥离');
const withThinking = sanitizeResultForSentinel({
  answer: 'A',
  thinking: 'SECRET_CHAIN_OF_THOUGHT',
  thinking_stats: { chars: 24 },
});
check('thinking 正文被剥掉', withThinking.thinking === undefined);
check('thinking_omitted=true', withThinking.thinking_omitted === true);
check('answer 保留', withThinking.answer === 'A');

const withoutThinking = sanitizeResultForSentinel({ answer: 'B', thinking: '', thinking_stats: { chars: 0 } });
check('无思考时 thinking_omitted=false（字段仍在）', withoutThinking.thinking_omitted === false);
check('无 thinking 字段', withoutThinking.thinking === undefined);

console.log('\n[2] 工具输入脱敏');
const redacted = sanitizeResultForSentinel({
  answer: 'C',
  tools_used: [
    {
      name: 'pwsh',
      input: {
        command: 'curl -H "Authorization: Bearer sk-ABCDEF123456" https://example.test',
        apiKey: 'sk-SHOULD_NOT_LEAK',
        description: 'safe text',
      },
    },
  ],
});
const input = redacted.tools_used[0].input;
check('apiKey 字段被替换', input.apiKey === '[REDACTED]', JSON.stringify(input));
check('Bearer 令牌被替换', !String(input.command).includes('sk-ABCDEF123456') && String(input.command).includes('Bearer [REDACTED]'), String(input.command));
check('普通描述保留', input.description === 'safe text');
check('thinking_omitted=false（本来没有思考）', redacted.thinking_omitted === false);

console.log('\n[3] 正文/标题/错误也脱敏');
const body = sanitizeResultForSentinel({
  answer: 'use token sk-ANSWERLEAK12345 and password: hunter2',
  error: 'Authorization: Bearer sk-ERRORLEAK12345',
  title: 'run with api_key=sk-TITLELEAK12345',
});
check('answer 里的令牌被替换', !String(body.answer).includes('sk-ANSWERLEAK12345'), String(body.answer));
check('answer 里的 password 被替换', !String(body.answer).includes('hunter2'), String(body.answer));
check('error 里的 Bearer 被替换', !String(body.error).includes('sk-ERRORLEAK12345'), String(body.error));
check('title 里的 api_key 被替换', !String(body.title).includes('sk-TITLELEAK12345'), String(body.title));

console.log('\n[4] INCLUDE_REASONING=1 仍必须脱敏');
{
  const hubURL = new URL('../src/hub.mjs', import.meta.url).href;
  const script =
    `const { sanitizeResultForSentinel } = await import(${JSON.stringify(hubURL)});\n` +
    'console.log(JSON.stringify(sanitizeResultForSentinel({' +
    "answer: 'token sk-INCLUDELEAK12345', thinking: 'THINK_KEEP'," +
    "tools_used: [{ name: 'pwsh', input: { apiKey: 'sk-TOOLLEak12345' } }]" +
    '})));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DSH_MCP_SENTINEL_INCLUDE_REASONING: '1' },
  });
  let value = null;
  try { value = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
  check('INCLUDE_REASONING=1 时保留 thinking', value?.thinking === 'THINK_KEEP', JSON.stringify(value));
  check('★ 但 answer 仍然脱敏', !String(value?.answer).includes('sk-INCLUDELEAK12345'), String(value?.answer));
  check('★ 工具输入仍然脱敏', value?.tools_used?.[0]?.input?.apiKey === '[REDACTED]', JSON.stringify(value?.tools_used));
  check('thinking_omitted=false', value?.thinking_omitted === false, String(value?.thinking_omitted));
}

console.log('\n[4b] DSH_MCP_SENTINEL_TOOL_INPUTS=0：工具输入不落盘，只留长度');
{
  const hubURL = new URL('../src/hub.mjs', import.meta.url).href;
  const script =
    `const { sanitizeResultForSentinel } = await import(${JSON.stringify(hubURL)});\n` +
    'console.log(JSON.stringify(sanitizeResultForSentinel({' +
    "answer: 'ok', tools_used: [{ name: 'write', status: 'completed', input: { path: 'a.txt', content: 'PRIVATE-FILE-BODY' } }, { name: 'ls' }], " +
    "auto_approvals: [{ tool: 'bash', tool_call_id: 't1', escalation: true, reason: 'network', command_preview: 'curl -d PRIVATE-CMD-ARG https://x.invalid', at: '2026-01-01T00:00:00Z' }]" +
    '})));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DSH_MCP_SENTINEL_TOOL_INPUTS: '0' },
  });
  let value = null;
  try { value = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
  const t0 = value?.tools_used?.[0];
  check('★ 输入整个不在了（文件内容、路径都不落盘）', t0 && !('input' in t0) && !JSON.stringify(value).includes('PRIVATE-FILE-BODY'), JSON.stringify(value));
  check('留下工具名、状态与 input_chars', t0?.name === 'write' && t0?.status === 'completed' && t0?.input_chars === JSON.stringify({ path: 'a.txt', content: 'PRIVATE-FILE-BODY' }).length, JSON.stringify(t0));
  check('没有输入的工具不凭空多出 input_chars', value?.tools_used?.[1] && !('input_chars' in value.tools_used[1]), JSON.stringify(value?.tools_used?.[1]));
  check('默认（不设）仍然带输入', Array.isArray(redacted.tools_used) && 'input' in redacted.tools_used[0]);
  // 自动放行审批摘要里的 command_preview 是命令原文的开头，同样是工具输入。
  const a0 = value?.auto_approvals?.[0];
  check('★ 自动放行摘要的命令预览也不落盘', a0 && !('command_preview' in a0) && !JSON.stringify(value).includes('PRIVATE-CMD-ARG'), JSON.stringify(a0));
  check('自动放行的条数与裁决信息照留', value?.auto_approvals?.length === 1 && a0?.tool === 'bash' && a0?.tool_call_id === 't1' && a0?.escalation === true && a0?.reason === 'network' && a0?.at === '2026-01-01T00:00:00Z', JSON.stringify(a0));
  const dflt = sanitizeResultForSentinel({ auto_approvals: [{ tool: 'bash', command_preview: 'npm test' }] });
  check('默认（不设）仍然带命令预览', dflt.auto_approvals?.[0]?.command_preview === 'npm test', JSON.stringify(dflt.auto_approvals));
}

console.log('\n[5] 非对象/空值安全');
check('null 原样返回', sanitizeResultForSentinel(null) === null);
check('字符串原样返回', sanitizeResultForSentinel('x') === 'x');

console.log(`\n===== 哨兵脱敏回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
