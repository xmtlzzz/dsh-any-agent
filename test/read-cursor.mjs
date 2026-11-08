/**
 * dsh_read 游标语义的纯内存回归（不花 token、不拉 DSH）。
 *
 * 背景：旧实现把连续文本合并进同一条目却不推进 seq，而游标就是 seq ——
 * 已经读过该条目的调用方永远看不到后续追加的正文（真实缺陷，concurrency 套件抓到的）。
 * 现在 cursor 是**修订号**：条目被追加后会再次返回，调用方按 seq 替换全文。
 */

import './_live-sandbox.mjs'; // 必须是第一条 import：live 事件别写进真实 ~/.dsh
import { Conversation } from '../src/hub.mjs';

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

const hub = { save() {}, log: { info() {}, debug() {} } };
const conv = new Conversation({ id: '00000000-0000-0000-0000-000000000000', cwd: process.cwd() }, hub);
conv.currentTurn = 1;

console.log('\n[1] 首次读取');
conv.pushOut('text', 'AAA');
const a = conv.readOut({ cursor: 0 });
check('返回首条文本', a.entries.length === 1 && a.entries[0].text === 'AAA', JSON.stringify(a.entries));
check('cursor 为正数', typeof a.cursor === 'number' && a.cursor > 0, String(a.cursor));
const firstSeq = a.entries[0].seq;

console.log('\n[2] ★ 追加文本后，增量读必须拿到更新后的全文');
conv.pushOut('text', 'BBB'); // 合并进同一条目（seq 不变、rev 前进）
const b = conv.readOut({ cursor: a.cursor });
check(
  '★ 合并追加的正文不再漏读',
  b.entries.length === 1 && b.entries[0].seq === firstSeq && b.entries[0].text === 'AAABBB',
  JSON.stringify(b.entries),
);
check('cursor 前进', b.cursor > a.cursor, `${a.cursor} -> ${b.cursor}`);

console.log('\n[3] 再追加一次');
conv.pushOut('text', 'CCC');
const c = conv.readOut({ cursor: b.cursor });
check('再次拿到完整全文', c.entries.length === 1 && c.entries[0].text === 'AAABBBCCC', JSON.stringify(c.entries));
const d = conv.readOut({ cursor: c.cursor });
check('无新增时返回空增量', d.entries.length === 0 && d.cursor === c.cursor, JSON.stringify(d));

console.log('\n[4] 不同 kind 会生成新条目（seq 递增）');
conv.pushOut('tool', 'pwsh [in_progress]');
const e = conv.readOut({ cursor: d.cursor });
check('工具条目单独出现', e.entries.length === 1 && e.entries[0].kind === 'tool' && e.entries[0].seq > firstSeq, JSON.stringify(e.entries));

console.log('\n[4b] ★ 不同工具调用各占一条；同一调用的状态更新原地替换');
conv.currentTurn = 2;
conv.pushOut('tool', 'read [in_progress]', { tool_call_id: 't-read' });
conv.pushOut('tool', 'read [completed]', { tool_call_id: 't-read' });
conv.pushOut('tool', 'pwsh [in_progress]', { tool_call_id: 't-pwsh' });
conv.pushOut('tool', 'pwsh [completed]', { tool_call_id: 't-pwsh' });
conv.pushOut('tool', 'write [completed]', { tool_call_id: 't-write' });
const tools2 = conv.out.filter((x) => x.turn === 2 && x.kind === 'tool');
check('★ 三个工具三条条目', tools2.length === 3, JSON.stringify(tools2.map((x) => x.text)));
check(
  '★ 每条只带自己的 id 与最新状态（不拼接）',
  tools2.map((x) => `${x.tool_call_id}=${x.text}`).join('|') ===
    't-read=read [completed]|t-pwsh=pwsh [completed]|t-write=write [completed]',
  JSON.stringify(tools2),
);
const beforeUpd = conv.readOut({ cursor: 0, limit: 999 }).cursor;
conv.pushOut('tool', 'pwsh [failed]', { tool_call_id: 't-pwsh' });
const upd = conv.readOut({ cursor: beforeUpd });
check(
  '★ 状态更新推进修订号、增量里能看到替换后的全文',
  upd.entries.length === 1 && upd.entries[0].tool_call_id === 't-pwsh' && upd.entries[0].text === 'pwsh [failed]',
  JSON.stringify(upd.entries),
);

console.log('\n[4c] ★ 空回合的“开始/结束”是两条，不会拼成一条');
conv.currentTurn = 3;
conv.pushOut('turn', '第 3 轮开始', { phase: 'start' });
conv.pushOut('turn', '第 3 轮结束（error）', { phase: 'end' });
const turns3 = conv.out.filter((x) => x.turn === 3 && x.kind === 'turn');
check(
  '★ 开始与结束各自独立、phase 正确',
  turns3.length === 2 && turns3[0].phase === 'start' && turns3[1].phase === 'end',
  JSON.stringify(turns3),
);

console.log('\n[4d] 跨轮同一 tool_call_id 不复用旧条目');
conv.currentTurn = 4;
conv.pushOut('tool', 'read [in_progress]', { tool_call_id: 't-read' });
const read4 = conv.out.filter((x) => x.tool_call_id === 't-read');
check('新一轮的同 id 工具另起一条', read4.length === 2 && read4[1].turn === 4, JSON.stringify(read4));

console.log('\n[5] limit 清洗');
const l0 = conv.readOut({ cursor: 0, limit: 0 });
check('limit=0 不再返回空（钳到 1）', l0.entries.length === 1, `entries=${l0.entries.length}`);
const ln = conv.readOut({ cursor: 0, limit: -1 });
check('limit=-1 不再静默丢尾（钳到 1）', ln.entries.length === 1, `entries=${ln.entries.length}`);
const lh = conv.readOut({ cursor: 0, limit: 999999 });
check('limit 过大被钳到缓冲上限', lh.entries.length === conv.out.length, `${lh.entries.length} vs ${conv.out.length}`);

console.log('\n[6] ★ answer：被工具调用隔开的正文分段，不首尾相接');
{
  const newCollector = () => ({ answer: '', answerBreak: false, tools: new Map(), reasoning: '', reasoningChunks: 0, reasoningStartedAt: 0, otherUpdates: [] });
  const say = (text) => conv.onUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  const tool = (id, status) => conv.onUpdate({ update: { sessionUpdate: status ? 'tool_call_update' : 'tool_call', toolCallId: id, title: 'pwsh', status } });

  conv.currentTurn = 10;
  conv.collector = newCollector();
  say('I will run the ');
  say('checks.');
  tool('t1');
  tool('t1', 'completed');
  say('1) name is ');
  say('dsh-any-agent');
  check(
    '★ 同一段的流式块照常拼接；工具调用之后的新一段前补空行',
    conv.collector.answer === 'I will run the checks.\n\n1) name is dsh-any-agent',
    JSON.stringify(conv.collector.answer),
  );

  const texts10 = conv.out.filter((x) => x.turn === 10 && x.kind === 'text').map((x) => x.text);
  check(
    'dsh_read 里两段正文仍是两条原样条目（不被插入空行）',
    texts10.length === 2 && texts10[0] === 'I will run the checks.' && texts10[1] === '1) name is dsh-any-agent',
    JSON.stringify(texts10),
  );

  conv.currentTurn = 11;
  conv.collector = newCollector();
  tool('t2');
  say('先用工具，再说话');
  check('正文之前的工具调用不产生开头空行', conv.collector.answer === '先用工具，再说话', JSON.stringify(conv.collector.answer));

  conv.currentTurn = 12;
  conv.collector = newCollector();
  say('第一段\n');
  tool('t3', 'completed');
  say('第二段');
  check('上一段已以换行结尾时不重复补空行', conv.collector.answer === '第一段\n第二段', JSON.stringify(conv.collector.answer));
  conv.collector = null;
}

console.log('\n[7] ★ 工具原地更新后分页不跳条（PR #11 评审：追加 A → 追加正文 → 更新 A → limit=1）');
{
  const c7 = new Conversation({ id: '00000000-0000-0000-0000-000000000007', cwd: process.cwd() }, hub);
  c7.currentTurn = 1;
  c7.pushOut('tool', 'read [in_progress]', { tool_call_id: 'A' }); // rev 1
  c7.pushOut('text', '正文');                                        // rev 2
  c7.pushOut('tool', 'read [completed]', { tool_call_id: 'A' });    // A 原地更新到 rev 3
  const seen = [];
  let cur = 0;
  for (let i = 0; i < 10; i++) {
    const r = c7.readOut({ cursor: cur, limit: 1 });
    seen.push(...r.entries.map((e) => e.text));
    if (r.entries.length === 0 && !r.has_more) break;
    cur = r.cursor;
  }
  check('★ limit=1 逐页读：正文没有被跳过', seen.includes('正文'), JSON.stringify(seen));
  check('★ 工具的最新状态也读到了', seen.includes('read [completed]'), JSON.stringify(seen));
  const first = c7.readOut({ cursor: 0, limit: 1 });
  check('★ 第一页按修订号取最小的那条，且 has_more=true', first.entries[0]?.text === '正文' && first.has_more === true, JSON.stringify(first));
  const all = c7.readOut({ cursor: 0 });
  check('一次读全：条目按 seq 时间顺序返回、游标是最大修订号', all.entries.map((e) => e.seq).join(',') === '1,2' && all.cursor === 3 && all.has_more === false, JSON.stringify(all));
  check('★ 没被环形缓冲挤掉任何条目时 gap=false（数组首条修订号大也不误报）', all.gap === false && first.gap === false, JSON.stringify({ all: all.gap, first: first.gap }));
}

console.log('\n[8] 环形缓冲挤掉未读条目时 gap=true，挤掉的都已读过时 gap=false');
{
  const c8 = new Conversation({ id: '00000000-0000-0000-0000-000000000008', cwd: process.cwd() }, hub);
  c8.currentTurn = 1;
  c8.pushOut('user', '第一条');
  const early = c8.readOut({ cursor: 0 }).cursor; // 读过第一条
  for (let t = 2; t <= 520; t++) {
    c8.currentTurn = t;
    c8.pushOut('user', `第 ${t} 条`); // 不同回合的 user 条目各占一条，超过 500 条开始挤
  }
  check('★ 游标停在早期：被挤掉的条目里有没读到的 → gap=true', c8.readOut({ cursor: early }).gap === true);
  const latest = c8.readOut({ cursor: 0, limit: 999 }).cursor;
  check('游标已经越过所有被挤掉的条目 → gap=false', c8.readOut({ cursor: latest }).gap === false);
}

console.log(`\n===== 读游标回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
