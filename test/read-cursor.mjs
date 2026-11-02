/**
 * dsh_read 游标语义的纯内存回归（不花 token、不拉 DSH）。
 *
 * 背景：旧实现把连续文本合并进同一条目却不推进 seq，而游标就是 seq ——
 * 已经读过该条目的调用方永远看不到后续追加的正文（真实缺陷，concurrency 套件抓到的）。
 * 现在 cursor 是**修订号**：条目被追加后会再次返回，调用方按 seq 替换全文。
 */

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

console.log('\n[5] limit 清洗');
const l0 = conv.readOut({ cursor: 0, limit: 0 });
check('limit=0 不再返回空（钳到 1）', l0.entries.length === 1, `entries=${l0.entries.length}`);
const ln = conv.readOut({ cursor: 0, limit: -1 });
check('limit=-1 不再静默丢尾（钳到 1）', ln.entries.length === 1, `entries=${ln.entries.length}`);
const lh = conv.readOut({ cursor: 0, limit: 999999 });
check('limit 过大被钳到缓冲上限', lh.entries.length === conv.out.length, `${lh.entries.length} vs ${conv.out.length}`);

console.log(`\n===== 读游标回归：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
