/**
 * dsh_doctor 的"npm 上有没有新版本"检查。
 *
 * 只在调用 dsh_doctor 时联网：GET npm registry 上本包的 latest（请求里没有任何用户数据），
 * 最多等 4 秒（实测一次要 2 秒左右，2 秒的上限会经常查不到）；成功的结果在状态目录缓存
 * 24 小时。查不到（离线、超时、被墙）只报"未知"，不算问题。DSH_MCP_UPDATE_CHECK=0 完全不联网。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PKG_VERSION, STATE_FILE } from './config.mjs';
import { cmpVersion } from './dsh-locate.mjs';

export const UPDATE_URL = 'https://registry.npmjs.org/dsh-any-agent/latest';
const CACHE_MS = 24 * 60 * 60 * 1000;

const verdict = (current, latest, cached) => ({ status: 'ok', current, latest, newer: cmpVersion(latest, current) > 0, cached });

/**
 * @returns {Promise<
 *   | { status: 'off', current: string }
 *   | { status: 'ok', current: string, latest: string, newer: boolean, cached: boolean }
 *   | { status: 'unknown', current: string, error: string }
 * >} 永不 reject。
 */
export async function checkForUpdate({
  current = PKG_VERSION,
  enabled = process.env.DSH_MCP_UPDATE_CHECK !== '0',
  fetchImpl = globalThis.fetch,
  cacheFile = join(dirname(STATE_FILE), 'update-check.json'),
  now = Date.now(),
  timeoutMs = 4000,
} = {}) {
  if (!enabled) return { status: 'off', current };
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (typeof c.latest === 'string' && now >= c.checked_at && now - c.checked_at < CACHE_MS) return verdict(current, c.latest, true);
  } catch {
    /* 没有缓存或读不懂：去查 */
  }
  const ctl = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // 超时同时盖住连接与读响应体；fetch 不理 signal 时 race 也能按时返回。
    const latest = await Promise.race([
      (async () => {
        const res = await fetchImpl(UPDATE_URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const v = (await res.json())?.version;
        if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new Error('no version in the response');
        return v;
      })(),
      timedOut,
    ]);
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ latest, checked_at: now }), 'utf8');
      renameSync(tmp, cacheFile);
    } catch {
      /* 缓存写不了就下次再查 */
    }
    return verdict(current, latest, false);
  } catch (e) {
    return { status: 'unknown', current, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
    timedOut.catch(() => {});
  }
}
