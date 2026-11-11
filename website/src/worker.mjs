/**
 * 官网 Worker 入口：只接管 `/api/stars`，其余请求一律交给静态资源
 * （wrangler.jsonc 里 `run_worker_first` 只列了 `/api/*`，别的路径根本不经过这里）。
 *
 * 为什么不让浏览器直接调 GitHub：未登录的 GitHub API 每个 IP 每小时只给 60 次，访客走共用的
 * 代理出口时很快被拒，页面只能一直显示本地缓存里的旧数字；国内直连 api.github.com 还常超时。
 * 改由边缘去取、缓存 10 分钟（每个机房 10 分钟最多问 GitHub 一次）；取不到时回最近一次成功的值
 * （留 7 天）。配了 `GITHUB_TOKEN`（`wrangler secret put GITHUB_TOKEN`，不需要任何权限）就带上它，
 * 额度变成每小时 5000 次；不配也能用。
 */

const REPO_API = 'https://api.github.com/repos/xmtlzzz/dsh-any-agent';
const FRESH_S = 600;
const LAST_GOOD_S = 7 * 24 * 3600;

const json = (body, maxAge, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
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
  if (hit) return hit;

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
    await Promise.all([cache.put(freshKey, json(body, FRESH_S)), cache.put(lastGoodKey, json(body, LAST_GOOD_S))]);
    return body;
  };

  const lastGood = await cache.match(lastGoodKey);
  if (lastGood) {
    waitUntil(refresh());
    return json(await lastGood.text(), 60);
  }
  const body = await refresh();
  return body ? json(body, FRESH_S) : json(JSON.stringify({ stars: null }), 60, 503);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/stars' && request.method === 'GET') {
      return handleStars(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
