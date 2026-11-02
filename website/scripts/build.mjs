import { readFile, writeFile, mkdir, copyFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist'), assets = join(dist, 'assets');
await mkdir(assets, { recursive: true });
// Clean only known generated assets, never a computed recursive directory.
for (const name of await readdir(assets)) if (/^(?:app|demo|release|style)\.[a-f0-9]{10}\.(?:mjs|css)$/.test(name)) await unlink(join(assets, name));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 10);
const base64 = value => createHash('sha256').update(value).digest('base64');
const demo = await readFile(join(root, 'src/demo.mjs'), 'utf8');
const demoName = `demo.${hash(demo)}.mjs`;
const release = await readFile(join(root, 'src/release.mjs'), 'utf8');
const releaseName = `release.${hash(release)}.mjs`;
const app = (await readFile(join(root, 'src/app.mjs'), 'utf8'))
  .replace("'./demo.mjs'", `'./${demoName}'`)
  .replace("'./release.mjs'", `'./${releaseName}'`);
const appName = `app.${hash(app)}.mjs`;
const css = await readFile(join(root, 'src/style.css'), 'utf8'), cssName = `style.${hash(css)}.css`;
const pkg = JSON.parse(await readFile(join(root, '../package.json'), 'utf8'));
const site = JSON.parse(await readFile(join(root, 'site.config.json'), 'utf8'));
const configuredURL = process.env.SITE_URL || site.url;
const origin = configuredURL ? new URL(configuredURL).origin : '';

// Pre-paint theme: avoid a dark flash for light-system users. The CSP hash is
// inserted into dist/_headers, so this stays compatible with script-src 'self'.
const themeScript = "try{var t=localStorage.getItem('dsh-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){}";
const themeHash = `'sha256-${base64(themeScript)}'`;

function render(template, lang) {
  const pageURL = lang === 'en' ? `${origin}/en/` : `${origin}/`;
  const canonical = origin ? `<link rel="canonical" href="${pageURL}">` : '';
  const hreflang = origin
    ? `<link rel="alternate" hreflang="zh-CN" href="${origin}/"><link rel="alternate" hreflang="en" href="${origin}/en/"><link rel="alternate" hreflang="x-default" href="${origin}/">`
    : '';
  const values = {
    YEAR: String(new Date().getFullYear()),
    STYLE: `/assets/${cssName}`,
    APP: `/assets/${appName}`,
    OG_IMAGE: `${origin}/assets/hero.jpg`,
    CANONICAL_URL: pageURL,
    CANONICAL: canonical,
    HREFLANG: hreflang,
    THEME_SCRIPT: themeScript,
  };
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{{${key}}}`, value);
  if (/\{\{\w+\}\}/.test(out)) throw Error(`Unresolved build template (${lang})`);
  return out;
}

const zhTemplate = await readFile(join(root, 'src/index.html'), 'utf8');
const enTemplate = await readFile(join(root, 'src/index.en.html'), 'utf8');
const headers = (await readFile(join(root, 'src/_headers'), 'utf8')).replaceAll('{{THEME_SCRIPT_HASH}}', themeHash);
if (/\{\{\w+\}\}/.test(headers)) throw Error('Unresolved _headers template');
await mkdir(join(dist, 'en'), { recursive: true });

const sitemap = origin
  ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `<url><loc>${origin}/</loc><xhtml:link rel="alternate" hreflang="zh-CN" href="${origin}/"/><xhtml:link rel="alternate" hreflang="en" href="${origin}/en/"/></url>\n` +
    `<url><loc>${origin}/en/</loc><xhtml:link rel="alternate" hreflang="zh-CN" href="${origin}/"/><xhtml:link rel="alternate" hreflang="en" href="${origin}/en/"/></url>\n` +
    `</urlset>\n`
  : null;

await Promise.all([
  writeFile(join(assets, demoName), demo),
  writeFile(join(assets, releaseName), release),
  writeFile(join(assets, appName), app),
  writeFile(join(assets, cssName), css),
  writeFile(join(dist, 'index.html'), render(zhTemplate, 'zh')),
  writeFile(join(dist, 'en/index.html'), render(enTemplate, 'en')),
  copyFile(join(root, '../docs/brand/header.jpg'), join(assets, 'hero.jpg')),
  copyFile(join(root, 'src/favicon.svg'), join(assets, 'favicon.svg')),
  writeFile(join(dist, '_headers'), headers),
  writeFile(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`),
  writeFile(
    join(dist, '404.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>页面未找到 · Page not found · dsh-any-agent</title><link rel="stylesheet" href="/assets/' +
      cssName +
      '"></head><body><main class="wrap" style="padding:12vh 24px;max-width:720px"><p class="tiny-label">404 · NOT FOUND</p><h1>这条路还没有任务。 / This path has no task yet.</h1><p>你访问的页面不存在，或者已经被移动。 / The page does not exist or has moved.</p><p><a class="button primary" href="/">返回 dsh-any-agent 首页 →</a> <a class="button secondary" href="/en/">English home →</a></p></main></body></html>',
  ),
]);
if (sitemap) await writeFile(join(dist, 'sitemap.xml'), sitemap);
else await unlink(join(dist, 'sitemap.xml')).catch(error => { if (error.code !== 'ENOENT') throw error; });
const files = await readdir(assets);
console.log(`Built dsh-any-agent v${pkg.version}: ${files.length} static assets → ${dist} (zh + en)`);
