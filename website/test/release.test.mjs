import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVersion, fetchLatestVersion, VERSION_SOURCES, formatStars, fetchGitHubStars, GITHUB_REPO_URL, SITE_STARS_URL } from '../src/release.mjs';

test('normalizeVersion accepts v-prefixed semver and prereleases, rejects junk', () => {
  assert.equal(normalizeVersion('0.3.3'), '0.3.3');
  assert.equal(normalizeVersion('v0.3.3'), '0.3.3');
  assert.equal(normalizeVersion('1.2.3-rc.1'), '1.2.3-rc.1');
  for (const bad of ['', 'v', 'latest', '0.3', 'v0.3.3.4', 'abc']) assert.equal(normalizeVersion(bad), null);
});

test('version sources start with npm and include GitHub release/tag fallbacks', () => {
  assert.equal(VERSION_SOURCES[0].id, 'npm');
  assert.match(VERSION_SOURCES[0].url, /^https:\/\/registry\.npmjs\.org\//);
  assert.ok(VERSION_SOURCES.some((source) => source.id === 'github-release'));
  assert.ok(VERSION_SOURCES.some((source) => source.id === 'github-tag'));
});

test('fetchLatestVersion falls back from npm to GitHub release', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === VERSION_SOURCES[0].url) return { ok: false, json: async () => ({}) };
    if (url === VERSION_SOURCES[1].url) return { ok: true, json: async () => ({ tag_name: 'v9.9.9' }) };
    return { ok: false, json: async () => ({}) };
  };
  assert.deepEqual(await fetchLatestVersion(fetchImpl), { version: '9.9.9', source: 'github-release' });
  assert.equal(calls.length, 2);
});

test('npm payload wins when present', async () => {
  const result = await fetchLatestVersion(async (url) => ({
    ok: true,
    json: async () => (url === VERSION_SOURCES[0].url ? { version: '0.3.3' } : { tag_name: 'v9.9.9' }),
  }));
  assert.deepEqual(result, { version: '0.3.3', source: 'npm' });
});

test('fetchLatestVersion returns unavailable instead of inventing a version', async () => {
  assert.deepEqual(await fetchLatestVersion(async () => ({ ok: false, json: async () => ({}) })), {
    version: null,
    source: 'unavailable',
  });
});

test('formatStars formats numbers under 1000 verbatim and abbreviates thousands with k', () => {
  assert.equal(formatStars(0), '0');
  assert.equal(formatStars(4), '4');
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1000), '1k');
  assert.equal(formatStars(1200), '1.2k');
  assert.equal(formatStars(1234), '1.2k');
  assert.equal(formatStars(83300), '83.3k');
  assert.equal(formatStars(104000), '104k');
  assert.equal(formatStars(-1), null);
  assert.equal(formatStars(NaN), null);
  assert.equal(formatStars(null), null);
});

test('fetchGitHubStars returns cached value when fresh', async () => {
  const store = new Map([['dsh_gh_stars_cache', JSON.stringify({ stars: 42, ts: Date.now() })]]);
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  let fetchCalled = false;
  const res = await fetchGitHubStars(async () => { fetchCalled = true; }, mockStorage);
  assert.deepEqual(res, { stars: 42, source: 'cache' });
  assert.equal(fetchCalled, false);
});

test('fetchGitHubStars queries GitHub API and updates cache when cache missing or expired', async () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  let requestedUrl = null;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ stargazers_count: 88 }) };
  };
  const res = await fetchGitHubStars(fetchImpl, mockStorage);
  assert.deepEqual(res, { stars: 88, source: 'network' });
  assert.equal(requestedUrl, GITHUB_REPO_URL);
  assert.ok(store.has('dsh_gh_stars_cache'));
  const cached = JSON.parse(store.get('dsh_gh_stars_cache'));
  assert.equal(cached.stars, 88);
});

test('fetchGitHubStars asks the site\'s own /api/stars first and skips GitHub when it answers', async () => {
  const store = new Map();
  const mockStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ stars: 31 }) };
  };
  const res = await fetchGitHubStars(fetchImpl, mockStorage);
  assert.deepEqual(res, { stars: 31, source: 'site' });
  assert.deepEqual(urls, [SITE_STARS_URL]);
  assert.equal(JSON.parse(store.get('dsh_gh_stars_cache')).stars, 31);
});

test('fetchGitHubStars falls back to the GitHub API when /api/stars is missing (static host, local preview)', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url === SITE_STARS_URL ? { ok: false, status: 404 } : { ok: true, json: async () => ({ stargazers_count: 9 }) };
  };
  const res = await fetchGitHubStars(fetchImpl, null);
  assert.deepEqual(res, { stars: 9, source: 'network' });
  assert.deepEqual(urls, [SITE_STARS_URL, GITHUB_REPO_URL]);
});

test('fetchGitHubStars returns unavailable when network fails', async () => {
  const res = await fetchGitHubStars(async () => { throw new Error('network down'); }, null);
  assert.deepEqual(res, { stars: null, source: 'unavailable' });
});

test('fetchGitHubStars falls back to stale cache when network is rate-limited or down', async () => {
  const staleTs = Date.now() - 60 * 60 * 1000;
  const store = new Map([['dsh_gh_stars_cache', JSON.stringify({ stars: 77, ts: staleTs })]]);
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const res = await fetchGitHubStars(async () => ({ ok: false, status: 403 }), mockStorage);
  assert.deepEqual(res, { stars: 77, source: 'stale-cache' });
});
