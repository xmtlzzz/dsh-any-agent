/**
 * 运行期输出环形缓冲（**仅内存、有界、不落盘**），供 dsh_read "看正在跑的会话输出"用。
 *
 * 只记三类：用户发的话、agent 的正文、工具调用状态（加上回合起止标记）；
 * **思考内容一律不进这里**。
 *
 * 游标是**修订号**（rev），不是条目序号（seq）：条目被追加或原地更新时修订号前进，
 * 已经读过它的调用方下次增量读还能拿到新全文。
 *
 * 从 conversation.mjs 拆出来；回合号由会话传入（缓冲本身不知道"现在是第几轮"）。
 */

/** 条目上限（超出丢最旧的）。 */
export const MAX_OUT_ENTRIES = 500;
/** 单条正文的字符上限；超出保留尾部，避免一条超长输出把内存撑爆。 */
const MAX_OUT_TEXT = 200_000;

const now = () => Date.now();
const revOf = (e) => (typeof e.rev === 'number' ? e.rev : e.seq);
const cap = (s) => (s.length > MAX_OUT_TEXT ? `…[已截断，保留尾部 ${MAX_OUT_TEXT} 字]…\n${s.slice(-MAX_OUT_TEXT)}` : s);

export class OutBuffer {
  constructor() {
    this.entries = [];
    this.seq = 0;
    /** 修订号：每次追加（含合并进已有条目、工具原地更新）都 +1。 */
    this.rev = 0;
    /** 被环形缓冲挤掉的条目里最大的修订号：游标落在它之下就说明有内容没读到（gap）。 */
    this.droppedRev = 0;
  }

  /** 追加一条输出；正文的流式增量合并进同一轮的上一条正文。 */
  push(kind, text, extra, turn) {
    const last = this.entries[this.entries.length - 1];
    // 工具更新是**快照**（`read [completed]`），不是增量：同一个 tool_call_id 原地替换，
    // 不同的工具调用各占一条。旧实现按 kind 拼接，三个工具会挤成
    // `read [in_progress]read [completed]pwsh …` 一条，且只剩第一个工具的 id。
    if (kind === 'tool' && extra.tool_call_id) {
      const same = this.#findToolEntry(extra.tool_call_id, turn);
      if (same) {
        same.text = cap(text ?? '');
        same.at = now();
        same.rev = ++this.rev;
        return;
      }
    }
    // 只有正文是流式增量，才需要合并；user/turn/tool 都是独立事件，合并会把
    // “第 N 轮开始”与“第 N 轮结束”拼成一条（空回合时）。
    if (kind === 'text' && last && last.kind === kind && last.turn === turn && text) {
      last.text = cap(last.text + text);
      last.at = now();
      // ★ 合并进已有条目也必须推进修订号。否则游标已经读过这条的调用方
      //   会永远看不到后续追加的正文（旧实现用 seq 当游标，seq 不变 = 漏读）。
      last.rev = ++this.rev;
      return;
    }
    this.entries.push({ seq: ++this.seq, rev: ++this.rev, kind, turn, text: cap(text ?? ''), at: now(), ...extra });
    if (this.entries.length > MAX_OUT_ENTRIES) {
      const dropped = this.entries.shift();
      const droppedRev = revOf(dropped);
      if (droppedRev > this.droppedRev) this.droppedRev = droppedRev;
    }
  }

  /** 本轮里同一 tool_call_id 的工具条目（从尾部往回找，跨轮不复用）。 */
  #findToolEntry(toolCallId, turn) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.turn !== turn) return null;
      if (e.kind === 'tool' && e.tool_call_id === toolCallId) return e;
    }
    return null;
  }

  /**
   * 按修订号的游标式增量读。返回 `{entries, cursor, has_more, gap}`。
   * 条目被追加时会再次返回（调用方按 seq 替换全文）。
   */
  read({ cursor = 0, limit = 200 } = {}) {
    const cur = Number.isFinite(cursor) ? cursor : 0;
    // limit 必须清洗：负数会被 slice 解释成“从头到尾少一条”，0 会让调用方原地空转。
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), MAX_OUT_ENTRIES)) : 200;
    // ★ 分页必须按**修订号**取，不能按数组顺序：工具条目的状态更新是原地替换并推进修订号，
    //   数组里靠前的条目可能比靠后的修订号更大（追加工具 A → 追加正文 → 更新 A）。按数组顺序
    //   切 limit 条、再拿最后一条的修订号当游标，就会越过没读到的正文，之后永远读不到它。
    //   按修订号升序取前 n 条，游标 = 本页最大修订号，于是"修订号 ≤ 游标"的条目一定都已返回。
    const eligible = this.entries.filter((e) => revOf(e) > cur).sort((a, b) => revOf(a) - revOf(b));
    const page = eligible.slice(0, n);
    return {
      // 本页内部再按 seq 排回时间顺序，方便调用方直接展示。
      entries: page.slice().sort((a, b) => a.seq - b.seq),
      cursor: page.length ? revOf(page[page.length - 1]) : cur,
      has_more: eligible.length > page.length,
      /** 缓冲被环形覆盖、且被挤掉的条目里有游标之后的内容时为 true：你错过了中间一段。 */
      gap: this.droppedRev > cur,
    };
  }
}
