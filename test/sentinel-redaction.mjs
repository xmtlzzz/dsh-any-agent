/**
 * 哨兵落盘脱敏的纯内存回归（不花 token）。
 *
 * 背景：哨兵会保留 7 天，载荷里的 tools_used[].input 可能含完整命令、路径、
 * 写入的文件内容甚至密钥。这里守住两条：
 *   1) thinking 正文永远被剥掉（默认），且 thinking_omitted 始终是布尔值；
 *   2) 工具输入按审批上下文同一套规则脱敏（密钥类字段 + 常见内联字面量）。
 */

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

console.log('\n[4] 非对象/空值安全');
check('null 原样返回', sanitizeResultForSentinel(null) === null);
check('字符串原样返回', sanitizeResultForSentinel('x') === 'x');

console.log(`\n===== 哨兵脱敏回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
