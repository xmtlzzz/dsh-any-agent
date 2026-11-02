/**
 * 行式 UTF-8 解码回归：MCP/ACP 的 chunk 边界绝不能把中文/emoji 截成 U+FFFD。
 * 纯内存，不拉 DSH，不花 token。
 */

import { LineDecoder } from '../src/line-decoder.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const text = JSON.stringify({ id: 1, text: '中文🐳'.repeat(4000) });
const utf8 = Buffer.from(text + '\n', 'utf8');

console.log('\n[1] 逐字节切分多字节 UTF-8');
{
  const d = new LineDecoder();
  const lines = [];
  for (let i = 0; i < utf8.length; i++) lines.push(...d.push(utf8.subarray(i, i + 1)));
  check('每一字节单独 push 仍还原完整一行', lines.length === 1 && lines[0] === text, `lines=${lines.length} len=${lines[0]?.length}`);
  check('没有替换字符', !String(lines[0]).includes('�'));
}

console.log('\n[2] 任意 chunk 边界');
{
  const d = new LineDecoder();
  const lines = [];
  for (let i = 0; i < utf8.length; i += 7) lines.push(...d.push(utf8.subarray(i, i + 7)));
  check('7 字节 chunk 仍还原', lines.length === 1 && lines[0] === text);
}

console.log('\n[3] 多行、CRLF、EOF 残留');
{
  const d = new LineDecoder();
  const lines = [
    ...d.push(Buffer.from('a\r\n')),
    ...d.push(Buffer.from('中文\n')),
    ...d.push(Buffer.from('末尾没有换行')),
    ...d.end(),
  ];
  check('三行按顺序切出', lines.length === 3 && lines[0] === 'a\r' && lines[1] === '中文' && lines[2] === '末尾没有换行', JSON.stringify(lines));
}

console.log(`\n===== line decoder：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
