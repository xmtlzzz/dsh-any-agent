import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
const assets = await readdir(resolve(dist, 'assets'));

test('Every linked local asset exists in the deployable output', async () => {
  const paths = [...html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 4);
  for (const path of paths) assert.ok((await stat(resolve(dist, '.' + path))).isFile(), path);
  const modulePath = paths.find((p) => p.endsWith('.mjs'));
  const module = await readFile(resolve(dist, '.' + modulePath), 'utf8');
  const imports = [...module.matchAll(/from '\.\/([a-z]+\.[a-f0-9]+\.mjs)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 2, 'app should import demo and release assets');
  for (const imported of imports) assert.ok((await stat(resolve(dist, 'assets', imported))).isFile(), imported);
});

test('Navigation anchors resolve and public output contains no build placeholders or machine paths', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const match of html.matchAll(/href="#([^"\s]+)"/g)) assert.ok(ids.has(match[1]), match[1]);
  assert.doesNotMatch(html, /\{\{\w+\}\}|[CD]:\\|127\.0\.0\.1:8770/);
});

test('Unknown routes have a real error page and metadata points to the selected brand asset', async () => {
  const notFound = await readFile(resolve(dist, '404.html'), 'utf8');
  assert.match(notFound, /href="\/"/);
  assert.match(html, /property="og:image" content="(?:https:\/\/[^\"]+)?\/assets\/hero\.jpg"/);
  const image = await readFile(resolve(dist, 'assets/hero.jpg'));
  assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8);
  assert.ok(image.length < 400_000);
});

test('The release version is fetched at runtime, never baked into the page', async () => {
  assert.match(html, /id="release-version">v—<\/span>/);
  assert.doesNotMatch(html, /\bv\d+\.\d+\.\d+\b/, 'no semver literal may be baked into the page');
  const releaseName = assets.find((name) => /^release\.[a-f0-9]{10}\.mjs$/.test(name));
  assert.ok(releaseName, 'release module must be built as a hashed asset');
  const release = await readFile(resolve(dist, 'assets', releaseName), 'utf8');
  assert.match(release, /registry\.npmjs\.org\/dsh-any-agent\/latest/);
  assert.match(release, /api\.github\.com\/repos\/xmtlzzz\/dsh-any-agent\/releases\/latest/);
  assert.match(release, /api\.github\.com\/repos\/xmtlzzz\/dsh-any-agent\/tags\?per_page=1/);
});

test('CSP allows the runtime version endpoints and canonical uses the public domain', async () => {
  const headers = await readFile(resolve(dist, '_headers'), 'utf8');
  assert.match(headers, /connect-src 'self' https:\/\/registry\.npmjs\.org https:\/\/api\.github\.com;/);
  assert.match(html, /<link rel="canonical" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/">/);
  assert.match(html, /property="og:image" content="https:\/\/dsh-any-agent\.xmtlz\.dev\/assets\/hero\.jpg"/);
});
