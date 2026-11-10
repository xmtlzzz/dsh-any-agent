import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
const enHtml = await readFile(resolve(dist, 'en/index.html'), 'utf8');
const assets = await readdir(resolve(dist, 'assets'));

test('Every linked local asset exists in the deployable output', async () => {
  const paths = [...html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 4);
  for (const path of paths) {
    if (path.endsWith('/')) continue; // locale directory links, not assets
    assert.ok((await stat(resolve(dist, '.' + path))).isFile(), path);
  }
  const modulePath = paths.find((p) => p.endsWith('.mjs'));
  const module = await readFile(resolve(dist, '.' + modulePath), 'utf8');
  const imports = [...module.matchAll(/from '\.\/([a-z]+\.[a-f0-9]+\.mjs)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 2, 'app should import demo and release assets');
  for (const imported of imports) assert.ok((await stat(resolve(dist, 'assets', imported))).isFile(), imported);
});

test('Navigation anchors resolve and public output contains no build placeholders or machine paths', () => {
  for (const page of [html, enHtml]) {
    const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const match of page.matchAll(/href="#([^"\s]+)"/g)) assert.ok(ids.has(match[1]), match[1]);
    assert.doesNotMatch(page, /\{\{\w+\}\}|[CD]:\\|127\.0\.0\.1:8770/);
  }
});

test('English page is a real locale with hreflang alternates and its own canonical', () => {
  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /hreflang="zh-CN" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/"/);
  assert.match(enHtml, /hreflang="en" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/en\/"/);
  assert.match(enHtml, /<link rel="canonical" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/en\/">/);
  assert.match(enHtml, /href="\/en\/"|href="\/"/);
  assert.match(html, /hreflang="en" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/en\/"/);
  assert.match(html, /href="\/en\/"/);
});

test('robots.txt mirrors the Cloudflare Managed AI-crawler policy instead of drifting', async () => {
  const robots = await readFile(resolve(dist, 'robots.txt'), 'utf8');
  assert.match(robots, /Content-Signal: search=yes, ai-train=no/);
  for (const bot of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Amazonbot', 'Applebot-Extended', 'Bytespider', 'KimiBot']) {
    assert.match(robots, new RegExp(`User-agent: ${bot}\\nDisallow: /`));
  }
  assert.match(robots, /Sitemap: https:\/\/dsh-any-agent\.xmtlz\.dev\/sitemap\.xml/);
});

test('The pre-paint theme script is allowed by the CSP hash', async () => {
  const headers = await readFile(resolve(dist, '_headers'), 'utf8');
  assert.match(headers, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/static\.cloudflareinsights\.com/);
  assert.match(html, /<script>try\{var t=localStorage\.getItem\('dsh-theme'\)/);
  assert.match(enHtml, /<script>try\{var t=localStorage\.getItem\('dsh-theme'\)/);
  assert.match(html, /matchMedia\('\(prefers-color-scheme: light\)'\)/);
});

test('Unknown routes have a real error page and metadata points to the selected brand asset', async () => {
  const notFound = await readFile(resolve(dist, '404.html'), 'utf8');
  assert.match(notFound, /href="\/"/);
  const heroName = assets.find((n) => /^hero\.[a-f0-9]{10}\.jpg$/.test(n));
  assert.ok(heroName, 'hashed hero asset exists');
  assert.match(html, new RegExp(`property="og:image" content="(?:https:\\/\\/[^"]+)?\\/assets\\/${heroName.replace('.', '\\.')}"`));
  const image = await readFile(resolve(dist, 'assets', heroName));
  assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8);
  assert.ok(image.length < 400_000);
});

test('The release version is fetched at runtime, never baked into the page', async () => {
  for (const page of [html, enHtml]) {
    assert.match(page, /id="release-version">v—<\/span>/);
    assert.doesNotMatch(page, /\bv\d+\.\d+\.\d+\b/, 'no semver literal may be baked into the page');
  }
  const releaseName = assets.find((name) => /^release\.[a-f0-9]{10}\.mjs$/.test(name));
  assert.ok(releaseName, 'release module must be built as a hashed asset');
  const release = await readFile(resolve(dist, 'assets', releaseName), 'utf8');
  assert.match(release, /registry\.npmjs\.org\/dsh-any-agent\/latest/);
  assert.match(release, /api\.github\.com\/repos\/xmtlzzz\/dsh-any-agent\/releases\/latest/);
  assert.match(release, /api\.github\.com\/repos\/xmtlzzz\/dsh-any-agent\/tags\?per_page=1/);
});

test('CSP allows the runtime version endpoints and canonical uses the public domain', async () => {
  const headers = await readFile(resolve(dist, '_headers'), 'utf8');
  assert.match(headers, /connect-src 'self' https:\/\/registry\.npmjs\.org https:\/\/api\.github\.com https:\/\/cloudflareinsights\.com/);
  assert.match(html, /<link rel="canonical" href="https:\/\/dsh-any-agent\.xmtlz\.dev\/">/);
  assert.match(html, /property="og:image" content="https:\/\/dsh-any-agent\.xmtlz\.dev\/assets\/hero\.[a-f0-9]{10}\.jpg"/);
});

test('Install card notes use block wrappers and manual config note resides inside details', () => {
  for (const page of [html, enHtml]) {
    for (const match of page.matchAll(/<div class="install-card-note[^"]*">([\s\S]*?)<\/div>/g)) {
      assert.match(match[1], /^<span>↳<\/span><(?:div|p)>/, 'install-card-note must wrap text in a container element');
    }
    const manualConfig = /<details class="manual-config">([\s\S]*?)<\/details>/.exec(page);
    assert.ok(manualConfig, 'manual-config details must exist');
    assert.match(manualConfig[1], /class="install-card-note manual-note"/, 'manual note must be inside manual-config details');
    assert.doesNotMatch(page, /<\/details>\s*<p class="install-card-note"/);
  }
});

test('GitHub Star badge is rendered in the header and queries repository stars', async () => {
  for (const page of [html, enHtml]) {
    assert.match(page, /<span class="github-star-badge"[^>]*>[\s\S]*?<span data-github-stars="true">(?:\d+|—)<\/span>/);
    assert.match(page, /class="github-nav" href="https:\/\/github\.com\/xmtlzzz\/dsh-any-agent"/);
  }
  const releaseName = assets.find((name) => /^release\.[a-f0-9]{10}\.mjs$/.test(name));
  const release = await readFile(resolve(dist, 'assets', releaseName), 'utf8');
  assert.match(release, /api\.github\.com\/repos\/xmtlzzz\/dsh-any-agent/);
});

test('FAQ section uses expanded 2-column card rows without requiring clicks', () => {
  for (const page of [html, enHtml]) {
    const faqSection = /<section class="faq-section wrap" id="faq">([\s\S]*?)<\/section>/.exec(page);
    assert.ok(faqSection, 'faq-section must exist');
    assert.match(faqSection[1], /class="faq-card"/, 'faq-card must exist');
    const rows = [...faqSection[1].matchAll(/<article class="faq-row">/g)];
    assert.equal(rows.length, 10, 'must contain all 10 FAQ entries');
    assert.doesNotMatch(faqSection[1], /<details>/, 'FAQ must be expanded by default without details/summary');
  }
});

test('Website docs alignment: compatibility range, 15 tools, dashboard showcase, and client schemas', async () => {
  const appName = assets.find((name) => /^app\.[a-f0-9]{10}\.mjs$/.test(name));
  assert.ok(appName, 'app bundle exists');
  const app = await readFile(resolve(dist, 'assets', appName), 'utf8');
  assert.doesNotMatch(app, /Claude Desktop \/ Windsurf \/ Zed/, 'Zed must not be grouped under mcpServers');
  assert.match(app, /context_servers/, 'Zed manual example uses context_servers');
  assert.match(app, /"type":\s*"stdio"/, 'VS Code manual example includes stdio type');
  assert.match(app, /"type":\s*"local"/, 'opencode manual example includes local mcp format');

  const expectedTools = [
    'dsh_start', 'dsh_send', 'dsh_interject', 'dsh_interrupt', 'dsh_queue',
    'dsh_list', 'dsh_status', 'dsh_read', 'dsh_get', 'dsh_review',
    'dsh_inbox', 'dsh_approval_decide', 'dsh_takeover', 'dsh_release', 'dsh_doctor',
  ];
  for (const page of [html, enHtml]) {
    assert.match(page, /0\.1\.7 ~ 0\.2\.2/);
    assert.match(page, /0\.2\.3\+/);
    assert.doesNotMatch(page, /0\.2\.x 尚未验证|0\.2\.x is unverified/);
    assert.match(page, /data-config="zed"/);
    assert.match(page, /data-config="opencode"/);
    assert.match(page, /src="\/assets\/dashboard-(?:zh|en)\.[a-f0-9]{10}\.png"/);
    for (const tool of expectedTools) assert.ok(page.includes(tool), `page includes ${tool}`);
  }
});
