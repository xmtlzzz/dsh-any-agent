import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVersion, fetchLatestVersion, VERSION_SOURCES } from '../src/release.mjs';

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
