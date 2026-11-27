/**
 * dsh_doctor 的"npm 上有没有新版本"检查。
 *
 * 只在调用 dsh_doctor 时联网：GET npm registry 上本包的 latest（请求里没有任何用户数据），
 * 最多等 4 秒（实测一次要 2 秒左右，2 秒的上限会经常查不到）；成功的结果在状态目录缓存
 * 24 小时。查不到（离线、超时、被墙）只报"未知"，不算问题。DSH_MCP_UPDATE_CHECK=0 完全不联网。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PKG_VERSION, STATE_FILE } from './config.mjs';
import { cmpVersion } from './dsh-locate.mjs';
import { writeJsonAtomic } from './fs-atomic.mjs';

export const UPDATE_URL = 'https://registry.npmjs.org/dsh-any-agent/latest';
const CACHE_MS = 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;

function isVersion(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = VERSION_PATTERN.exec(value);
  return !!match && !match[4]?.split('.').some((id) => /^0\d+$/.test(id));
}

const verdict = (current, latest, cached) => ({ status: /** @type {'ok'} */ ('ok'), current, latest, newer: cmpVersion(latest, current) > 0, cached });

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
    if (isVersion(c.latest) && Number.isFinite(c.checked_at) && now >= c.checked_at && now - c.checked_at < CACHE_MS) {
      return verdict(current, c.latest, true);
    }
  } catch {
    /* 没有缓存或读不懂：去查 */
  }
  const ctl = new AbortController();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ error: `timed out after ${timeoutMs}ms` });
      ctl.abort();
    }, timeoutMs);
  });
  try {
    // 超时同时盖住连接与读响应体；fetch 不理 signal 时 race 也能按时返回。
    const { latest, error } = await Promise.race([
      (async () => {
        try {
          const res = await fetchImpl(UPDATE_URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
          if (!res.ok) return { error: Number.isInteger(res.status) ? `HTTP ${res.status}` : 'invalid HTTP response' };
          const latest = (await res.json())?.version;
          return isVersion(latest) ? { latest } : { error: 'no version in the response' };
        } catch {
          return { error: 'fetch failed' };
        }
      })(),
      timedOut,
    ]);
    if (error) return { status: 'unknown', current, error };
    try {
      writeJsonAtomic(cacheFile, { latest, checked_at: now });
    } catch {
      /* 缓存写不了就下次再查 */
    }
    return verdict(current, latest, false);
  } finally {
    clearTimeout(timer);
  }
}
