import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const pages = {
  zh: await readFile(resolve(dist, 'index.html'), 'utf8'),
  en: await readFile(resolve(dist, 'en/index.html'), 'utf8'),
};

const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('Each locale declares language, title, description, and viewport', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.match(html, new RegExp(`<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">`));
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  }
});

test('Each page has exactly one h1, a skip link, and a focusable main landmark', () => {
  for (const html of Object.values(pages)) {
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.match(html, /class="skip-link" href="#main"/);
    assert.match(html, /<main id="main" tabindex="-1">/);
  }
});

test('Every image has a non-empty alt attribute', () => {
  for (const [lang, html] of Object.entries(pages)) {
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
      const alt = /\balt="([^"]*)"/.exec(tag);
      assert.ok(alt && alt[1].trim().length > 0, `${lang} image without alt: ${tag.slice(0, 120)}`);
    }
  }
});

test('Every static button has an accessible name', () => {
  for (const [lang, html] of Object.entries(pages)) {
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const attrs = match[1];
      const label = /\baria-label="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const text = strip(match[2]);
      assert.ok(label.trim() || text.length > 0, `${lang} button has no name: ${attrs.slice(0, 120)}`);
    }
  }
});

test('IDs are unique within each page', () => {
  for (const [lang, html] of Object.entries(pages)) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `${lang} duplicate ids`);
  }
});

test('External links that open a new tab use rel=noopener', () => {
  for (const [lang, html] of Object.entries(pages)) {
    for (const tag of html.match(/<a\b[^>]*target="_blank"[^>]*>/g) ?? []) {
      assert.match(tag, /\brel="[^"]*noopener/, `${lang} link: ${tag.slice(0, 140)}`);
    }
  }
});

test('Tablists expose aria-selected and a tabpanel target', () => {
  for (const [lang, html] of Object.entries(pages)) {
    const tablists = [...html.matchAll(/<div[^>]*role="tablist"[^>]*>/g)];
    assert.ok(tablists.length > 0, `${lang} has no tablist`);
    for (const match of html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)) {
      assert.match(match[0], /\baria-selected="(?:true|false)"/);
      assert.match(match[0], /\baria-controls="[^"]+"/);
    }
  }
});

test('Language switching remains reachable on mobile', async () => {
  const styleName = (await readdir(resolve(dist, 'assets'))).find((n) => /^style\.[a-f0-9]{10}\.css$/.test(n));
  assert.ok(styleName, 'hashed stylesheet exists');
  const css = await readFile(resolve(dist, 'assets', styleName), 'utf8');
  assert.doesNotMatch(css, /\.nav-links a:last-child\s*\{[^}]*display\s*:\s*none/);
  assert.match(pages.zh, /href="\/en\/"/);
  assert.match(pages.en, /href="\/"/);
});

test('Internal anchors resolve to an existing id', () => {
  for (const [lang, html] of Object.entries(pages)) {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const anchor of html.matchAll(/href="#([^"\s]+)"/g)) {
      assert.ok(ids.has(anchor[1]), `${lang} missing #${anchor[1]}`);
    }
  }
});
