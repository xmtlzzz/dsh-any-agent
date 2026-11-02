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
let html = await readFile(join(root, 'src/index.html'), 'utf8');
for (const [key, value] of Object.entries({ YEAR: String(new Date().getFullYear()), STYLE: `/assets/${cssName}`, APP: `/assets/${appName}`, OG_IMAGE: `${origin}/assets/hero.jpg`, CANONICAL_URL: origin ? `${origin}/` : '', CANONICAL: origin ? `<link rel="canonical" href="${origin}/">` : '' })) html = html.replaceAll(`{{${key}}}`, value);
if (/\{\{\w+\}\}/.test(html)) throw Error('Unresolved build template');
await Promise.all([
  writeFile(join(assets, demoName), demo), writeFile(join(assets, releaseName), release), writeFile(join(assets, appName), app), writeFile(join(assets, cssName), css), writeFile(join(dist, 'index.html'), html),
  copyFile(join(root, '../docs/brand/header.jpg'), join(assets, 'hero.jpg')),
  copyFile(join(root, 'src/favicon.svg'), join(assets, 'favicon.svg')),
  copyFile(join(root, 'src/_headers'), join(dist, '_headers')),
  writeFile(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`),
  writeFile(join(dist, '404.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>页面未找到 · dsh-any-agent</title><link rel="stylesheet" href="/assets/' + cssName + '"></head><body><main class="wrap" style="padding:12vh 24px;max-width:720px"><p class="tiny-label">404 · NOT FOUND</p><h1>这条路还没有任务。</h1><p>你访问的页面不存在，或者已经被移动。</p><p><a class="button primary" href="/">返回 dsh-any-agent 首页 →</a></p></main></body></html>'),
]);
if (origin) await writeFile(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`);
else await unlink(join(dist, 'sitemap.xml')).catch(error => { if (error.code !== 'ENOENT') throw error; });
const files = await readdir(assets);
console.log(`Built dsh-any-agent v${pkg.version}: ${files.length} static assets → ${dist}`);
