/**
 * 极简 MCP 客户端（demo 用）。
 *
 * 与 `test/mcp-client.mjs` 是同一套换行分隔 JSON-RPC 协议，但这里刻意独立一份：
 * `test/` 不进 npm 发布包，而 demo 要随包分发 —— 依赖它会让 `npm run demo`
 * 在装好的包里直接崩。
 *
 * 只做四件事：拉起服务端、initialize、tools/list、tools/call。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = '';

  constructor({ pkgRoot, env = {} }) {
    this.pkgRoot = pkgRoot;
    this.env = env;
    /** 服务端的 stderr 行（demo 默认静默，只有 -v 时才值得看）。 */
    this.stderr = [];
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  start() {
    this.#child = spawn(process.execPath, [join(this.pkgRoot, 'bin', 'dsh-any-agent.mjs')], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (d) => this.#onData(d));
    this.#child.stderr.on('data', (d) => {
      for (const line of d.split(/\r?\n/)) if (line.trim()) this.stderr.push(line.trim());
    });
    this.#child.on('exit', (code, signal) => {
      const why = `服务端退出（code=${code}${signal ? `, signal=${signal}` : ''}）`;
      for (const [, p] of this.#pending) p.reject(new Error(why));
      this.#pending.clear();
    });
    return this;
  }

  #onData(chunk) {
    this.#buf += chunk;
    let i;
    while ((i = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error(`服务端输出了非 JSON 内容: ${line.slice(0, 300)}`);
      }
      if (msg.id === undefined) continue;
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-any-agent-demo', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    return r;
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools;
  }

  async callTool(name, args = {}, timeoutMs) {
    return await this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** 取工具结果里的纯文本。 */
  static text(result) {
    return (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  async close() {
    try {
      this.#child.stdin.end();
    } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.#child?.kill();
        } catch {}
        resolve();
      }, 6000);
      this.#child?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
