/**
 * Hub 进程回收器：空闲 TTL、保活数量上限（MAX_LIVE）与全局 RSS 预算，以及一键释放全部空闲会话。
 */

import { IDLE_TTL_MS, MAX_LIVE, MAX_RSS_MB } from '../config.mjs';
import { refreshRssMap, rssMb } from '../procstat.mjs';
import { heartbeat as lockHeartbeat, removeMarker } from '../locks.mjs';

const now = () => Date.now();

/** 一个回收周期（永不 reject）。`refreshRss` / `maxRssMb` 供测试注入。 */
export async function reapOnce(hub, { refreshRss = refreshRssMap, maxRssMb = MAX_RSS_MB } = {}) {
  try {
    const cutoff = now() - IDLE_TTL_MS;
    const reapable = [];
    const usedAtPick = new Map();
    for (const c of hub.conversations.values()) {
      if (!c.proc?.alive) continue;
      lockHeartbeat(c.id);
      if (c.busy) continue;
      reapable.push(c);
      usedAtPick.set(c, c.lastUsedAt);
    }

    const victims = new Set();
    const reapableNormal = reapable.filter((c) => !c.keepAlive);
    if (IDLE_TTL_MS > 0) {
      for (const c of reapableNormal) if (c.lastUsedAt <= cutoff) victims.add(c);
    }
    if (MAX_LIVE > 0) {
      const byAge = reapableNormal.slice().sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const excess = byAge.length - MAX_LIVE;
      for (let i = 0; i < excess; i++) victims.add(byAge[i]);
    }
    if (maxRssMb > 0) {
      await refreshRss();
      let total = 0;
      const rss = new Map();
      const seenPid = new Set();
      for (const c of hub.conversations.values()) {
        if (!c.proc?.alive) continue;
        const pid = c.proc.pid;
        const mb = rssMb(pid) ?? 0;
        rss.set(c, mb);
        if (pid && seenPid.has(pid)) continue;
        if (pid) seenPid.add(pid);
        total += mb;
      }
      if (total > maxRssMb) {
        const pool = reapable
          .filter((c) => !victims.has(c))
          .sort((a, b) =>
            a.keepAlive === b.keepAlive ? a.lastUsedAt - b.lastUsedAt : a.keepAlive ? 1 : -1,
          );
        for (const c of pool) {
          victims.add(c);
          total -= rss.get(c) ?? 0;
          if (total <= maxRssMb) break;
        }
      }
    }

    for (const c of victims) {
      if (c.recycling) await c.recycling;
      if (!c.proc?.alive || c.busy || c.lastUsedAt !== usedAtPick.get(c)) continue;
      hub.log.info(
        `[hub] 回收会话 ${c.id} 的进程（${IDLE_TTL_MS > 0 && c.lastUsedAt <= cutoff ? '空闲超时' : `保活上限 ${MAX_LIVE}`}；可 resume 复活）`,
      );
      const proc = c.proc;
      const stopping = typeof proc.detach === 'function' ? proc.detach(c) : proc.stop();
      c.recycling = stopping
        .catch(() => false)
        .then((stopped) => {
          if (stopped) removeMarker(c.id);
          return stopped;
        })
        .finally(() => {
          if (c.proc === proc) c.proc = null;
          c.recycling = null;
        });
      await c.recycling;
    }
  } catch (e) {
    hub.log.info(`[hub] 回收周期异常（已忽略，下个周期继续）: ${e.message}`);
  }
}

/** 释放所有活着的会话进程（默认跳过正在跑回合的会话，force=true 一并停止）。 */
export async function releaseAll(hub, { force = false } = {}) {
  const released = [];
  const skippedBusy = [];
  const failed = [];
  for (const c of hub.conversations.values()) {
    if (c.recycling) await c.recycling;
    if (!c.proc?.alive) continue;
    if (c.busy && !force) {
      skippedBusy.push(c.id);
      continue;
    }
    const proc = c.proc;
    const stopping = typeof proc.detach === 'function' ? proc.detach(c) : proc.stop();
    c.recycling = stopping
      .catch(() => false)
      .finally(() => {
        if (c.proc === proc) c.proc = null;
        c.recycling = null;
      });
    const stopped = await c.recycling;
    if (stopped) {
      removeMarker(c.id);
      released.push(c.id);
    } else {
      failed.push(c.id);
      hub.log.info(`[hub] 释放 ${c.id} 时进程未确认退出，保留写锁登记`);
    }
  }
  await hub.save();
  return { released: released.length, conversations: released, skipped_busy: skippedBusy, failed };
}
