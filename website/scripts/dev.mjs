import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status) process.exit(build.status);
const dist = resolve(root, 'dist'), port = Number(process.env.PORT || 8770);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
    // Directory URLs such as /en/ serve their index.html (the production host does this too).
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    if (!(await stat(path)).isFile()) throw Error('Not found');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(path));
  } catch { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await readFile(resolve(dist, '404.html'))); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
