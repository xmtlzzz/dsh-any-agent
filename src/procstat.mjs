/**
 * 子进程 RSS 读取（只用于观测与内存预算，不参与任何协议）。
 *
 * 平台差异：
 *   - Windows：`tasklist /FO CSV /NH` 第五列是 "12,345 K"
 *   - Unix：`ps -axo pid=,rss=` 第二列是 KB
 *
 * 读取失败一律返回空 Map / null —— 量不到内存不是故障，绝不能因此回收会话。
 * 结果缓存 5 秒，避免 reaper（默认 30 秒一轮）和 dsh_list 反复拉起进程。
 */

import { spawnSync } from 'node:child_process';

const CACHE_MS = 5000;
let cache = { at: 0, map: new Map() };

function parseTasklist(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const cols = line.match(/"[^"]*"/g);
    if (!cols || cols.length < 5) continue;
    const pid = Number(cols[1].slice(1, -1));
    const kb = /([\d,]+)\s*K/i.exec(cols[4]);
    if (Number.isFinite(pid) && kb) map.set(pid, Number(kb[1].replace(/,/g, '')) / 1024);
  }
  return map;
}

function parsePs(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]) / 1024);
  }
  return map;
}

/** @returns {Map<number, number>} pid → MB */
export function readRssMap({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - cache.at < CACHE_MS) return cache.map;
  let map = new Map();
  try {
    const r =
      process.platform === 'win32'
        ? spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true,
            maxBuffer: 8 << 20,
          })
        : spawnSync('ps', ['-axo', 'pid=,rss='], {
            encoding: 'utf8',
            timeout: 3000,
            maxBuffer: 8 << 20,
          });
    if (r.status === 0 && r.stdout) {
      map = process.platform === 'win32' ? parseTasklist(r.stdout) : parsePs(r.stdout);
    }
  } catch {
    // 读不到就当作未知
  }
  cache = { at: now, map };
  return map;
}

/** @returns {number|null} pid 的 RSS（MB，四舍五入）；未知返回 null */
export function rssMb(pid) {
  if (!pid) return null;
  const v = readRssMap().get(pid);
  return v === undefined ? null : Math.round(v);
}
