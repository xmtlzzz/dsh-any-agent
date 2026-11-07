/**
 * 只读 dashboard：本地 HTTP + SSE，把 live 事件流渲染成调用链页面。
 *
 * 安全边界（页面能看到命令预览、路径等，所以按"本机私有页面"对待）：
 *   - 只监听 127.0.0.1；端口默认随机。
 *   - 每次启动生成一次性 token，所有请求都要带 `?t=<token>`（EventSource 不能设请求头）。
 *   - 校验 Host 头只能是 127.0.0.1:<port> / localhost:<port>，挡 DNS rebinding。
 *   - 只有 GET；不提供任何会改变状态的接口（没有控制面，见设计稿 §9）。
 *   - CSP 禁止外部资源；Referrer-Policy: no-referrer，避免 token 随 Referer 外泄。
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_FILE = join(HERE, 'live-dashboard.html');
/** 没有新事件时也定期推一次（刷新"写者是否还活着"与相对时间）。 */
const IDLE_PUSH_MS = 5000;
const KEEPALIVE_MS = 15000;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function tokenOk(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 起 dashboard。返回 {url, port, token, server, close()}。
 * @param {object} opts
 * @param {import('./live-view.mjs').LiveTail} opts.tail
 * @param {number} [opts.port] 0 = 随机
 * @param {number} [opts.pollMs]
 * @param {string} [opts.token] 测试用；缺省随机
 * @param {string} [opts.html] 测试用；缺省读 live-dashboard.html
 */
export async function startDashboard({ tail, port = 0, pollMs = 500, token = randomBytes(18).toString('base64url'), html } = {}) {
  const page = html ?? readFileSync(HTML_FILE, 'utf8');
  const clients = new Set();
  let snapshot = '';

  const refresh = () => {
    snapshot = JSON.stringify(tail.view());
    return snapshot;
  };
  tail.poll();
  refresh();

  const send = (res, data) => {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  };

  let lastPush = Date.now();
  const pollTimer = setInterval(() => {
    let changed = false;
    try {
      changed = tail.poll();
    } catch {
      changed = false;
    }
    if (changed || Date.now() - lastPush > IDLE_PUSH_MS) {
      const data = refresh();
      for (const res of clients) send(res, data);
      lastPush = Date.now();
    }
  }, pollMs);
  const keepTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, KEEPALIVE_MS);
  pollTimer.unref?.();
  keepTimer.unref?.();

  const server = createServer((req, res) => {
    const actualPort = server.address()?.port;
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('misdirected request');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('read-only');
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    if (!tokenOk(url.searchParams.get('t'), token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('forbidden: open the URL printed by `dsh-any-agent dashboard`');
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(page);
      return;
    }
    if (url.pathname === '/api/view') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(snapshot);
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      send(res, snapshot);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = server.address().port;
  const url = `http://127.0.0.1:${actual}/?t=${encodeURIComponent(token)}`;

  return {
    url,
    port: actual,
    token,
    server,
    async close() {
      clearInterval(pollTimer);
      clearInterval(keepTimer);
      for (const res of clients) {
        try {
          res.end();
        } catch {}
      }
      clients.clear();
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}
