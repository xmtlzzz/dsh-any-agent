/**
 * 官网 Worker 入口：只接管 `/api/stars` 与 `/api/version`，其余请求一律交给静态资源
 * （wrangler.jsonc 里 `run_worker_first` 只列了 `/api/*`，别的路径根本不经过这里）。
 *
 * 为什么不让浏览器直接调 GitHub / npm：未登录的 GitHub API 每个 IP 每小时只给 60 次，访客走共用的
 * 代理出口时很快被拒，页面只能一直显示本地缓存里的旧值；部分网络环境直连 api.github.com / registry.npmjs.org 还常超时。
 * 改由边缘去取并缓存：
 *   - `/api/stars`：缓存 10 分钟，过期后先回最近一次成功值（留 7 天）并在后台刷新；
 *   - `/api/version`：缓存 3 分钟，过期后**先同步刷新**（总超时 2 秒内依次尝试 npm / GitHub），
 *     仅当所有上游都不可达时才回退最近一次成功值并标 `stale: true`，避免冷门 PoP 把几天前的旧版本号直接吐给访客。
 *   - 命中 `caches.default` 时重新构造响应头，防止 Cloudflare Zone 默认 4 小时 Browser Cache TTL 把短 TTL 抬高到 `max-age=14400`。
 * 配了 `GITHUB_TOKEN`（`wrangler secret put GITHUB_TOKEN`，不需要任何权限）就带上它，
 * GitHub 额度变成每小时 5000 次；不配也能用。
 */

import { VERSION_SOURCES, normalizeVersion } from './release.mjs';

const REPO_API = 'https://api.github.com/repos/xmtlzzz/dsh-any-agent';
const STARS_FRESH_S = 600;
const VERSION_FRESH_S = 180;
const LAST_GOOD_S = 7 * 24 * 3600;
// 升级缓存 key 版本，部署后各 PoP 立即绕过历史遗留的旧版本 last-good 缓存，无需手动清全站缓存。
const VERSION_CACHE_SCHEMA = 'v2';

const json = (body, maxAge, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });

const versionJson = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * 页面那边 3 秒就放弃这个请求（release.mjs），所以：
 *   - 有最近一次成功的值就**立刻**回它，再在后台去 GitHub 刷新（GitHub 卡住时访客也不用等）；
 *   - 什么都没缓存时才等 GitHub，最多 2 秒，赶在页面放弃之前回 503。
 */
export async function handleStars(
  request,
  env,
  { fetchImpl = fetch, cache = caches.default, now = Date.now, waitUntil = () => {}, timeoutMs = 2000 } = {},
) {
  const origin = new URL(request.url).origin;
  const freshKey = new Request(`${origin}/api/stars`);
  const lastGoodKey = new Request(`${origin}/api/stars?last-good`);
  const hit = await cache.match(freshKey);
  if (hit) return json(await hit.text(), STARS_FRESH_S);

  /** 问一次 GitHub；成功就写两份缓存并返回响应体，失败返回 null。 */
  const refresh = async () => {
    let stars = null;
    try {
      const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-any-agent-site' };
      if (env?.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
      const res = await fetchImpl(REPO_API, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.stargazers_count === 'number') stars = data.stargazers_count;
      }
    } catch {
      /* 由调用方决定回什么 */
    }
    if (stars === null) return null;
    const body = JSON.stringify({ stars, fetched_at: new Date(now()).toISOString() });
    await Promise.all([cache.put(freshKey, json(body, STARS_FRESH_S)), cache.put(lastGoodKey, json(body, LAST_GOOD_S))]);
    return body;
  };

  const lastGood = await cache.match(lastGoodKey);
  if (lastGood) {
    waitUntil(refresh());
    return json(await lastGood.text(), 60);
  }
  const body = await refresh();
  return body ? json(body, STARS_FRESH_S) : json(JSON.stringify({ stars: null }), 60, 503);
}

/**
 * 边缘查询并缓存最新发布的版本号（npm latest → GitHub release → GitHub tag）。
 * 过期时先在总超时预算内同步刷新，避免冷门 PoP 把几天前的 last-good 旧版本号返回给访客；
 * 仅在所有上游都失败或超时时才回退 last-good，并带 `stale: true` 标记。
 */
export async function handleVersion(
  request,
  env,
  { fetchImpl = fetch, cache = caches.default, now = Date.now, timeoutMs = 2000 } = {},
) {
  const origin = new URL(request.url).origin;
  const freshKey = new Request(`${origin}/api/version?cache=${VERSION_CACHE_SCHEMA}`);
  const lastGoodKey = new Request(`${origin}/api/version?last-good&cache=${VERSION_CACHE_SCHEMA}`);
  const hit = await cache.match(freshKey);
  if (hit) return versionJson(await hit.text());

  const refresh = async () => {
    const deadline = Date.now() + timeoutMs;
    const perSourceCap = Math.max(1, Math.ceil(timeoutMs * 0.6));
    for (let i = 0; i < VERSION_SOURCES.length; i += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const source = VERSION_SOURCES[i];
      const attemptMs = i === VERSION_SOURCES.length - 1 ? remaining : Math.min(remaining, perSourceCap);
      try {
        const isGitHub = source.url.startsWith('https://api.github.com/');
        const headers = {
          accept: isGitHub ? 'application/vnd.github+json' : 'application/json',
          'user-agent': 'dsh-any-agent-site',
        };
        if (isGitHub && env?.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
        const res = await fetchImpl(source.url, {
          headers,
          cache: 'no-store',
          signal: AbortSignal.timeout(attemptMs),
        });
        if (!res?.ok) continue;
        const version = normalizeVersion(source.pick(await res.json()));
        if (!version) continue;
        const body = JSON.stringify({ version, source: source.id, fetched_at: new Date(now()).toISOString() });
        await Promise.all([
          cache.put(freshKey, json(body, VERSION_FRESH_S)),
          cache.put(lastGoodKey, json(body, LAST_GOOD_S)),
        ]);
        return body;
      } catch {
        /* 换下一个来源 */
      }
    }
    return null;
  };

  const body = await refresh();
  if (body) return versionJson(body);

  const lastGood = await cache.match(lastGoodKey);
  if (lastGood) {
    try {
      const parsed = JSON.parse(await lastGood.text());
      if (normalizeVersion(parsed?.version)) {
        return versionJson(JSON.stringify({ ...parsed, stale: true }));
      }
    } catch {
      /* 损坏的旧缓存直接走 503 */
    }
  }
  return versionJson(JSON.stringify({ version: null }), 503);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/stars' && request.method === 'GET') {
      return handleStars(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (pathname === '/api/version' && request.method === 'GET') {
      return handleVersion(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
