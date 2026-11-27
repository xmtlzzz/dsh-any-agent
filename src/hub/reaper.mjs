/**
 * Hub 进程回收器：空闲 TTL、保活数量上限（MAX_LIVE）与全局 RSS 预算，以及一键释放全部空闲会话。
 */

import { L } from '../lang.mjs';
import { IDLE_TTL_MS, MAX_LIVE, MAX_RSS_MB } from '../config.mjs';
import { refreshRssMap, validPid } from '../procstat.mjs';
import { heartbeat as lockHeartbeat, removeMarker } from '../locks.mjs';

const now = () => Date.now();

/** 一个回收周期（永不 reject）。`refreshRss` / `maxRssMb` 供测试注入。
 * @param {import('../hub.mjs').Hub} hub
 */
export async function reapOnce(hub, { refreshRss = refreshRssMap, maxRssMb = MAX_RSS_MB, maxLive = MAX_LIVE } = {}) {
  try {
    const cutoff = now() - IDLE_TTL_MS;
    const idleAtPick = new Map();
    const victims = new Set();
    for (const c of hub.conversations.values()) {
      if (!c.proc?.alive) continue;
      lockHeartbeat(c.id);
      if (!c.busy && !c.recycling) {
        idleAtPick.set(c, { proc: c.proc, pid: c.proc.pid, lastUsedAt: c.lastUsedAt });
      }
    }

    const rss = maxRssMb > 0 ? await refreshRss() : null;
    const groups = new Map();
    for (const c of hub.conversations.values()) {
      if (!c.proc?.alive) continue;
      const pid = c.proc.pid;
      const key = validPid(pid) ? pid : c;
      const group = groups.get(key) ?? { members: [], pid, idle: true, hasKeepAlive: false, lastUsedAt: 0 };
      group.members.push(c);
      const before = idleAtPick.get(c);
      const eligible = !c.busy && !c.recycling && before?.proc === c.proc &&
        before.pid === pid && before.lastUsedAt === c.lastUsedAt;
      group.idle &&= eligible;
      if (eligible && IDLE_TTL_MS > 0 && !c.keepAlive && c.lastUsedAt <= cutoff) victims.add(c);
      group.hasKeepAlive ||= Boolean(c.keepAlive);
      group.lastUsedAt = Math.max(group.lastUsedAt, c.lastUsedAt);
      groups.set(key, group);
    }
    const live = [...groups.values()];
    const idle = live.filter((g) => g.idle).sort((a, b) =>
      Number(a.hasKeepAlive) - Number(b.hasKeepAlive) || a.lastUsedAt - b.lastUsedAt);
    if (maxLive > 0) {
      const normal = idle.filter((g) => !g.hasKeepAlive);
      // Under sharing the cap applies to resident hosts. For one-to-one hosts
      // preserve the historical allowance for busy and keep-alive conversations.
      const counted = live.some((g) => g.members.length > 1) ? live.length : normal.length;
      for (const g of normal.slice(0, Math.max(0, counted - maxLive))) {
        for (const c of g.members) victims.add(c);
      }
    }
    if (maxRssMb > 0) {
      let total = 0;
      for (const g of groups.values()) {
        g.mb = rss?.get(g.pid) ?? 0;
        if (!g.idle || !g.members.every((c) => victims.has(c))) total += g.mb;
      }
      for (const g of idle) {
        if (total <= maxRssMb) break;
        if (!g.mb || g.members.every((c) => victims.has(c))) continue;
        for (const c of g.members) victims.add(c);
        total -= g.mb;
      }
    }

    // Reserve all detachments before yielding. A new turn will await its conversation's recycling promise.
    const pending = [];
    for (const c of victims) {
      hub.log.info('[hub] ' + L('正在回收空闲会话进程：', 'Reaping idle conversation process: ') + c.id);
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
      pending.push(c.recycling);
    }
    await Promise.all(pending);
  } catch (e) {
    hub.log.info(`[hub] 回收周期异常（已忽略，下个周期继续）: ${e.message}`);
  }
}

/** 释放所有活着的会话进程（默认跳过正在跑回合的会话，force=true 一并停止）。
 * @param {import('../hub.mjs').Hub} hub
 */
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
