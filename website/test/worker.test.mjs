import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleStars } from '../src/worker.mjs';

/** Workers 的 caches.default 的最小替身：按 URL 存响应（TTL 不模拟，"过期"用删条目表示）。 */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const hit = store.get(new URL(req.url).href);
      return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
    },
    async put(req, res) {
      store.set(new URL(req.url).href, { body: await res.text(), status: res.status, headers: Object.fromEntries(res.headers) });
    },
  };
}
const req = (path = '/api/stars') => new Request(`https://site.example${path}`);
const github = (stars, calls) => async (url, init) => {
  calls?.push({ url, init });
  return new Response(JSON.stringify({ stargazers_count: stars }), { status: 200 });
};

test('stars: a miss asks GitHub once, answers the count and caches it', async () => {
  const cache = fakeCache();
  const calls = [];
  const res = await handleStars(req(), {}, { fetchImpl: github(12, calls), cache });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stars, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/xmtlzzz/dsh-any-agent');
  assert.ok(calls[0].init.headers['user-agent'], 'GitHub rejects requests without a User-Agent');
  assert.match(res.headers.get('cache-control'), /max-age=600/);

  const again = await handleStars(req(), {}, { fetchImpl: github(99, calls), cache });
  assert.equal((await again.json()).stars, 12, 'a fresh cached count is served without asking GitHub');
  assert.equal(calls.length, 1);
});

test('stars: when GitHub fails, the last good count is served', async () => {
  const cache = fakeCache();
  await handleStars(req(), {}, { fetchImpl: github(7), cache });
  cache.store.delete('https://site.example/api/stars'); // the fresh copy expired
  const limited = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });
  const res = await handleStars(req(), {}, { fetchImpl: limited, cache });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stars, 7);
});

/**
 * 一个卡住的 GitHub：只有被 abort 才结束。Node 里 AbortSignal.timeout 的定时器不拖住进程，
 * 这里另挂一个定时器，免得测试在等 abort 时事件循环先空了。
 */
const hanging = async (url, init) =>
  new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new Error('aborted'));
    });
  });

test('stars: with a last good value, answers at once even when GitHub hangs, and refreshes in the background', async () => {
  const cache = fakeCache();
  await handleStars(req(), {}, { fetchImpl: github(7), cache });
  cache.store.delete('https://site.example/api/stars'); // the fresh copy expired
  const pending = [];
  const t0 = Date.now();
  const res = await handleStars(req(), {}, { fetchImpl: hanging, cache, waitUntil: (p) => pending.push(p) });
  assert.ok(Date.now() - t0 < 500, 'the browser gives up after 3 s, so the last good value must not wait for GitHub');
  assert.equal((await res.json()).stars, 7);
  assert.equal(pending.length, 1, 'the refresh runs in the background');
  await Promise.all(pending);

  // A background refresh that succeeds renews the fresh copy for the next visitor.
  cache.store.delete('https://site.example/api/stars');
  const later = [];
  await handleStars(req(), {}, { fetchImpl: github(8), cache, waitUntil: (p) => later.push(p) });
  await Promise.all(later);
  const next = await handleStars(req(), {}, { fetchImpl: hanging, cache });
  assert.equal((await next.json()).stars, 8);
});

test('stars: with nothing cached, gives up on a hanging GitHub before the browser does (3 s)', async () => {
  const t0 = Date.now();
  const res = await handleStars(req(), {}, { fetchImpl: hanging, cache: fakeCache() });
  const took = Date.now() - t0;
  assert.equal(res.status, 503);
  assert.ok(took < 2700, `took ${took} ms`);
});

test('stars: with nothing cached and GitHub down, answers 503 with stars null', async () => {
  const res = await handleStars(req(), {}, { fetchImpl: async () => { throw new Error('down'); }, cache: fakeCache() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).stars, null);
});

test('stars: a GITHUB_TOKEN secret is sent when set', async () => {
  const calls = [];
  await handleStars(req(), { GITHUB_TOKEN: 'tok' }, { fetchImpl: github(1, calls), cache: fakeCache() });
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const none = [];
  await handleStars(req(), {}, { fetchImpl: github(1, none), cache: fakeCache() });
  assert.equal(none[0].init.headers.authorization, undefined);
});

test('worker: every other path goes to the static assets', async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (r) => (seen.push(new URL(r.url).pathname), new Response('asset')) } };
  const res = await worker.fetch(req('/en/'), env);
  assert.equal(await res.text(), 'asset');
  assert.deepEqual(seen, ['/en/']);
});
