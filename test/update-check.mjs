/**
 * dsh_doctor 的新版本检查（离线：假 fetch，不联网）。
 *
 * 守的不变量：
 *   1. DSH_MCP_UPDATE_CHECK=0 时根本不调 fetch；
 *   2. 只请求 npm registry 上本包的 latest，不带任何别的东西；
 *   3. 成功的结果缓存 24 小时，过期再查；时钟倒退不信缓存；
 *   4. 离线 / HTTP 错误 / 响应不对 / 超时都报"未知"，不缓存、不抛错；fetch 不理 abort 也按时返回；
 *   5. 版本比较：更高的 latest = 有新版本，相同或更低 = 没有，正式版高于同号预发布版。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATE_URL, checkForUpdate } from '../src/update-check.mjs';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-update-'));
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 假 fetch：记下每次调用，按给定的方式应答。 */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return respond(url, opts);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

try {
  console.log('\n[1] 关掉时不联网');
  {
    const f = fakeFetch(() => json({ version: '9.9.9' }));
    const r = await checkForUpdate({ enabled: false, fetchImpl: f, cacheFile: join(root, 'off.json'), current: '0.6.9' });
    check('DSH_MCP_UPDATE_CHECK=0：status=off，fetch 一次都没调', r.status === 'off' && f.calls.length === 0, JSON.stringify(r));
  }

  console.log('\n[2] 有新版本 / 没有 / 缓存');
  {
    const cacheFile = join(root, 'cache.json');
    const f = fakeFetch(() => json({ version: '0.7.0', name: 'dsh-any-agent' }));
    const r = await checkForUpdate({ fetchImpl: f, cacheFile, current: '0.6.9', now: T0 });
    check('latest 更高：newer=true，不是缓存', r.status === 'ok' && r.latest === '0.7.0' && r.newer === true && r.cached === false, JSON.stringify(r));
    check('只请求 npm registry 上本包的 latest', f.calls.length === 1 && f.calls[0].url === UPDATE_URL && UPDATE_URL === 'https://registry.npmjs.org/dsh-any-agent/latest');
    check('请求只带 accept 头（没有任何用户数据）', JSON.stringify(f.calls[0].opts.headers) === '{"accept":"application/json"}', JSON.stringify(f.calls[0].opts.headers));
    check('结果写进缓存', existsSync(cacheFile) && JSON.parse(readFileSync(cacheFile, 'utf8')).latest === '0.7.0');
    const again = await checkForUpdate({ fetchImpl: f, cacheFile, current: '0.6.9', now: T0 + DAY - 1000 });
    check('24 小时内：读缓存，不再联网', again.cached === true && again.newer === true && f.calls.length === 1, JSON.stringify(again));
    const stale = await checkForUpdate({ fetchImpl: f, cacheFile, current: '0.6.9', now: T0 + DAY + 1000 });
    check('过了 24 小时：重新联网', stale.cached === false && f.calls.length === 2);
    const back = await checkForUpdate({ fetchImpl: f, cacheFile, current: '0.6.9', now: T0 - 1000 });
    check('时钟倒退（缓存时刻在未来）：不信缓存', back.cached === false && f.calls.length === 3);
    const same = await checkForUpdate({ fetchImpl: f, cacheFile: join(root, 'same.json'), current: '0.7.0', now: T0 });
    check('版本相同：newer=false', same.status === 'ok' && same.newer === false);
    const ahead = await checkForUpdate({ fetchImpl: f, cacheFile: join(root, 'ahead.json'), current: '0.8.0-rc.1', now: T0 });
    check('本地更高（开发中的预发布版）：newer=false', ahead.newer === false);
    const rc = await checkForUpdate({ fetchImpl: f, cacheFile: join(root, 'rc.json'), current: '0.7.0-rc.2', now: T0 });
    check('同号预发布版 vs 正式版：newer=true', rc.newer === true);
  }

  console.log('\n[3] 查不到时报"未知"，不缓存、不抛错');
  {
    const cases = [
      ['离线（fetch 抛错）', () => { throw new TypeError('fetch failed'); }, /fetch failed/],
      ['HTTP 500', () => json({}, 500), /HTTP 500/],
      ['响应里没有版本号', () => json({ name: 'dsh-any-agent' }), /no version/],
      ['版本号不像版本号', () => json({ version: '<script>' }), /no version/],
    ];
    for (const [name, respond, re] of cases) {
      const cacheFile = join(root, `bad-${passed}-${failed}.json`);
      const r = await checkForUpdate({ fetchImpl: fakeFetch(respond), cacheFile, current: '0.6.9', now: T0 });
      check(`${name}：status=unknown，不写缓存`, r.status === 'unknown' && re.test(r.error) && !existsSync(cacheFile), JSON.stringify(r));
    }
    const t0 = Date.now();
    const hang = await checkForUpdate({ fetchImpl: () => new Promise(() => {}), cacheFile: join(root, 'hang.json'), current: '0.6.9', timeoutMs: 150 });
    const ms = Date.now() - t0;
    check('★ fetch 一直不回（也不理 abort）：按超时返回 unknown', hang.status === 'unknown' && /timed out/.test(hang.error) && ms < 2000, `${ms}ms ${JSON.stringify(hang)}`);
    let aborted = false;
    await checkForUpdate({
      fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })),
      cacheFile: join(root, 'abort.json'),
      current: '0.6.9',
      timeoutMs: 100,
    });
    check('超时会 abort 掉请求（不留悬空连接）', aborted);
  }
} catch (e) {
  failed += 1;
  console.log(`\n✗ 异常中断: ${e.stack ?? e.message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n===== update-check: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
