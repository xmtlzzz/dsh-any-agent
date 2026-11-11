/**
 * 子进程 RSS 读取（只用于观测与内存预算，不参与任何协议）。
 *
 * 平台差异：
 *   - Windows：`tasklist /FO CSV /NH` 第五列是 "12,345 K"
 *   - Unix：`ps -axo pid=,rss=` 第二列是 KB
 *
 * 读取失败一律返回空 Map / null —— 量不到内存不是故障，绝不能因此回收会话。
 *
 * ★ 全程异步。Windows 上 `tasklist` 一次要 0.6 秒左右（实测 574–678ms），以前用
 *   `spawnSync`，于是 dsh_status / dsh_get / dsh_list / dsh_start 每次生成快照都可能把
 *   整个事件循环卡住这么久 —— 所有会话的 ACP 消息与审批跟着停。现在：
 *     - `rssMb(pid)` 只读缓存、立刻返回；缓存超过 5 秒就在后台刷新（下次调用拿到新值）；
 *     - 需要准确数字的地方（reaper 的 RSS 预算、dsh_doctor）先 `await refreshRssMap()`。
 */

import { execFile } from 'node:child_process';

const CACHE_MS = 5000;
let cache = { at: 0, map: new Map() };
let inflight = null;

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

/**
 * 读进程表的超时。异步读取不占事件循环，所以宽一点没有代价；太紧反而会在机器忙时
 * 把整张表读成空的（实测 tasklist 平时 1.4–2.1 秒，原先的 3 秒在负载下会超）。
 */
const READ_TIMEOUT_MS = 15_000;

function readProcessTable() {
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      win ? 'tasklist' : 'ps',
      win ? ['/FO', 'CSV', '/NH'] : ['-axo', 'pid=,rss='],
      { encoding: 'utf8', timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 << 20 },
      // 读不到就当作未知
      (err, stdout) => resolve(err || !stdout ? new Map() : win ? parseTasklist(stdout) : parsePs(stdout)),
    );
  });
}

/**
 * 刷新并返回 pid → MB 的表。缓存还新鲜就直接返回它；并发调用共用同一次读取。
 * 永不 reject。
 * @returns {Promise<Map<number, number>>}
 */
export function refreshRssMap({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.map);
  if (!inflight) {
    inflight = readProcessTable().then((map) => {
      cache = { at: Date.now(), map };
      inflight = null;
      return map;
    });
  }
  return inflight;
}

/**
 * pid 的 RSS（MB，四舍五入）；未知返回 null。
 * 不阻塞：读的是缓存，过期时只触发一次后台刷新 —— 所以进程刚起来的头几秒可能是 null。
 * @returns {number|null}
 */
export function rssMb(pid) {
  if (!pid) return null;
  if (Date.now() - cache.at >= CACHE_MS) refreshRssMap();
  const v = cache.map.get(pid);
  return v === undefined ? null : Math.round(v);
}
