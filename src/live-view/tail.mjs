/**
 * 增量 tail 一个 live 目录，并按 TTL 刷新会话标题。
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_FILE } from '../live.mjs';
import { readRegistry } from '../registry.mjs';
import { LiveState, parseEvent, splitLines } from './state.mjs';

const TITLE_TTL_MS = 10_000;

/**
 * 增量 tail 一个 live 目录。`poll()` 返回本次是否有变化。
 * 只读文件；目录不存在时安静地什么也不做。
 */
export class LiveTail {
  constructor(dir, { state = new LiveState(), stateFile = null, readTitle = null } = {}) {
    this.dir = dir;
    this.state = state;
    this.stateFile = stateFile;
    this.readTitle = readTitle;
    /** file → {offset, rest: Buffer} */
    this.files = new Map();
    this.titles = new Map();
    this.titlesAt = 0;
  }

  #readFrom(file, track) {
    let st;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (st.size < track.offset) {
      track.offset = 0;
      track.rest = Buffer.alloc(0);
    }
    if (st.size === track.offset) return false;
    const len = st.size - track.offset;
    const buf = Buffer.alloc(len);
    let fd, n;
    try {
      fd = openSync(file, 'r');
      n = readSync(fd, buf, 0, len, track.offset);
      if (n <= 0) return false;
      track.offset += n;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
    const { lines, rest } = splitLines(Buffer.concat([track.rest, buf.subarray(0, n)]));
    track.rest = Buffer.from(rest);
    let changed = false;
    for (const line of lines) {
      const ev = parseEvent(line);
      if (ev) {
        this.state.apply(ev);
        changed = true;
      }
    }
    return changed;
  }

  poll() {
    let changed = false;
    let names = [];
    try {
      names = existsSync(this.dir) ? readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    } catch {
      names = [];
    }
    const present = new Set(names);
    for (const id of [...this.state.convs.keys()]) {
      if (!present.has(id)) {
        this.state.removeConv(id);
        this.files.delete(join(this.dir, id, LIVE_FILE));
        this.titles.delete(id);
        changed = true;
      }
    }
    for (const id of names) {
      const file = join(this.dir, id, LIVE_FILE);
      let track = this.files.get(file);
      if (!track) {
        track = { offset: 0, rest: Buffer.alloc(0) };
        this.files.set(file, track);
        const old = `${file}.1`;
        if (existsSync(old)) {
          const oldTrack = { offset: 0, rest: Buffer.alloc(0) };
          if (this.#readFrom(old, oldTrack)) changed = true;
        }
      }
      if (this.#readFrom(file, track)) changed = true;
    }
    if (this.#refreshTitles()) changed = true;
    return changed;
  }

  /** 标题：调用方给的 title_hint（注册表 > conv.open 事件）> DSH 原生标题（投影缓存）。 */
  #refreshTitles() {
    const t = Date.now();
    if (t - this.titlesAt < TITLE_TTL_MS) return false;
    this.titlesAt = t;
    const hints = new Map();
    if (this.stateFile) {
      try {
        const doc = readRegistry(this.stateFile);
        for (const c of doc?.conversations ?? []) if (c?.id && typeof c.titleHint === 'string') hints.set(c.id, c.titleHint);
      } catch {}
    }
    let changed = false;
    for (const [id, conv] of this.state.convs) {
      let title = hints.get(id) ?? conv.title_hint ?? null;
      if (!title && this.readTitle) {
        try {
          title = this.readTitle(id) ?? null;
        } catch {
          title = null;
        }
      }
      if (title && this.titles.get(id) !== title) {
        this.titles.set(id, title);
        changed = true;
      }
    }
    return changed;
  }

  view(opts = {}) {
    return this.state.view({ titles: this.titles, ...opts });
  }
}
