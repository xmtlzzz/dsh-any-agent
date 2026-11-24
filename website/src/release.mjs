/**
 * 版本号运行时同步：页面不写死版本。
 *
 * 优先问官网自己的边缘缓存端点 `/api/version`（不受访客 IP 频控或国内直连超时影响），
 * 纯静态托管 / 本地预览没有该端点时，再依次退回 npm latest 与 GitHub release/tag。
 * 所有端点都允许跨域；CSP 在 src/_headers 的 connect-src 中放行它们。
 */
export const SITE_VERSION_URL = '/api/version';
export const VERSION_CACHE_KEY = 'dsh_release_version_cache';

export const VERSION_SOURCES = [
  {
    id: 'npm',
    url: 'https://registry.npmjs.org/dsh-any-agent/latest',
    pick: (payload) => payload?.version,
  },
  {
    id: 'github-release',
    url: 'https://api.github.com/repos/xmtlzzz/dsh-any-agent/releases/latest',
    pick: (payload) => payload?.tag_name,
  },
  {
    id: 'github-tag',
    url: 'https://api.github.com/repos/xmtlzzz/dsh-any-agent/tags?per_page=1',
    pick: (payload) => (Array.isArray(payload) ? payload[0]?.name : null),
  },
];

const ALL_VERSION_SOURCES = [
  {
    id: 'site',
    url: SITE_VERSION_URL,
    pick: (payload) => payload?.version,
  },
  ...VERSION_SOURCES,
];

/** 接受 0.3.3 / v0.3.3 / 1.2.3-rc.1；其它一律视为无效。 */
export function normalizeVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * 读取本地缓存的最新版本号（供首屏立即填充，网络完成后再静默更新）。
 */
export function readCachedVersion(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try {
    const raw = storage?.getItem(VERSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const version = normalizeVersion(parsed?.version);
    return version ? { version, ts: Number(parsed?.ts) || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * 依次尝试所有来源，返回第一个有效版本；支持 10 分钟 localStorage 缓存与过期兜底。
 * @param {typeof fetch} [fetchImpl] 便于测试注入
 * @param {Storage | null} [storage] 便于测试注入
 */
export async function fetchLatestVersion(
  fetchImpl = fetch,
  storage = (typeof localStorage !== 'undefined' ? localStorage : null),
) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let staleVersion = null;
  const cached = readCachedVersion(storage);
  if (cached) {
    if (Date.now() - cached.ts < CACHE_TTL_MS) {
      return { version: cached.version, source: 'cache' };
    }
    staleVersion = cached.version;
  }

  for (const source of ALL_VERSION_SOURCES) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        // 3 s per source: a hung registry must not leave the badge pending forever.
        signal: AbortSignal.timeout(3000),
      });
      if (!response?.ok) continue;
      const version = normalizeVersion(source.pick(await response.json()));
      if (version) {
        try {
          storage?.setItem(VERSION_CACHE_KEY, JSON.stringify({ version, ts: Date.now() }));
        } catch {}
        return { version, source: source.id };
      }
    } catch {
      /* 换下一个来源 */
    }
  }
  if (staleVersion) return { version: staleVersion, source: 'stale-cache' };
  return { version: null, source: 'unavailable' };
}

export const GITHUB_REPO_URL = 'https://api.github.com/repos/xmtlzzz/dsh-any-agent';
/** 官网自己的 Worker 端点（src/worker.mjs）：边缘取数并缓存，不受访客 IP 的 GitHub 频控影响。 */
export const SITE_STARS_URL = '/api/stars';

/** 依次问的来源：先问官网自己，没有这个端点（纯静态托管、本地预览）再直连 GitHub。 */
const STAR_SOURCES = [
  { id: 'site', url: SITE_STARS_URL, pick: (data) => data?.stars, headers: { accept: 'application/json' } },
  { id: 'network', url: GITHUB_REPO_URL, pick: (data) => data?.stargazers_count, headers: { accept: 'application/vnd.github+json' } },
];

/**
 * 格式化 Star 数量：
 * count < 1000: 直接显示，例如 "4"
 * count >= 1000: 显示 "1.2k"、"83.3k" 等
 */
export function formatStars(count) {
  if (!Number.isFinite(count) || count < 0) return null;
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * 获取 GitHub Star 数量：先问官网的 /api/stars，再退回 GitHub 公开 API（都不需要 Token）。
 * localStorage 缓存 5 分钟；两处都取不到时用缓存里的旧值。
 */
export async function fetchGitHubStars(fetchImpl = fetch, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const CACHE_KEY = 'dsh_gh_stars_cache';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  let staleStars = null;
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.stars === 'number' && parsed.stars >= 0) {
        if (Date.now() - parsed?.ts < CACHE_TTL_MS) {
          return { stars: parsed.stars, source: 'cache' };
        }
        staleStars = parsed.stars;
      }
    }
  } catch {}

  for (const source of STAR_SOURCES) {
    try {
      const res = await fetchImpl(source.url, {
        headers: source.headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (!res?.ok) continue;
      const stars = source.pick(await res.json());
      if (typeof stars !== 'number' || stars < 0) continue;
      try {
        storage?.setItem(CACHE_KEY, JSON.stringify({ stars, ts: Date.now() }));
      } catch {}
      return { stars, source: source.id };
    } catch {
      /* 换下一个来源 */
    }
  }

  if (staleStars !== null) return { stars: staleStars, source: 'stale-cache' };
  return { stars: null, source: 'unavailable' };
}
