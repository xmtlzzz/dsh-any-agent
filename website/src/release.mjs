/**
 * 版本号运行时同步：页面不写死版本。
 *
 * 优先 npm 的 latest（发布后即时生效），失败时退回 GitHub 的 release/tag。
 * 所有端点都允许跨域；CSP 在 src/_headers 的 connect-src 中放行它们。
 */
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

/** 接受 0.3.3 / v0.3.3 / 1.2.3-rc.1；其它一律视为无效。 */
export function normalizeVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * 依次尝试所有来源，返回第一个有效版本。
 * @param {typeof fetch} [fetchImpl] 便于测试注入
 */
export async function fetchLatestVersion(fetchImpl = fetch) {
  for (const source of VERSION_SOURCES) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response?.ok) continue;
      const version = normalizeVersion(source.pick(await response.json()));
      if (version) return { version, source: source.id };
    } catch {
      /* 换下一个来源 */
    }
  }
  return { version: null, source: 'unavailable' };
}
