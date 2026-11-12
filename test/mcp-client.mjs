/**
 * 极简 MCP 客户端（测试用）：拉起 dsh-any-agent 服务端，走 stdio 换行分隔 JSON-RPC。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PKG_ROOT } from '../src/config.mjs';

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = '';
  stderr = [];
  /**
   * 本客户端通过 dsh_start 建出来的会话 id（自动记录）。套件收尾时交给
   * `test/residue.mjs` 的 cleanupSuite 精确清理，不必每个套件各自记 id。
   */
  createdIds = new Set();

  constructor({ env = {}, entry = join(PKG_ROOT, 'bin', 'dsh-any-agent.mjs'), roots, clientInfo = { name: 'dsh-any-agent-test', version: '0.1.0' } } = {}) {
    this.env = env;
    this.entry = entry;
    this.roots = roots;
    /** initialize 里报给服务端的客户端名（常驻进程测试要区分同一进程上的几个连接）。 */
    this.clientInfo = clientInfo;
  }

  /** 这个客户端拉起的服务用的注册表文件（DSH_MCP_STATE；per-run 数据按它的同级目录推导）。 */
  get stateFile() {
    return this.env.DSH_MCP_STATE ?? process.env.DSH_MCP_STATE ?? null;
  }

  start() {
    this.#child = spawn(process.execPath, [this.entry], {
      // 集成测试会显式请求 danger-full-access；0.5.0 起它需要机器侧放行。
      // 只给测试拉起的子进程放行，测试进程自身的默认值仍会被 guards 钉住。
      // 工具描述与服务说明跟系统语言走；测试断言的是中文那一份，所以钉成 zh（要测英文的套件自己传 en）。
      // 测试一律离线：dsh_doctor 的新版本检查不去 npm（test/update-check.mjs 用假 fetch 单测它）。
      env: { DSH_MCP_ALLOW_FULL_ACCESS: '1', DSH_MCP_LANG: 'zh', DSH_MCP_UPDATE_CHECK: '0', ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', (d) => this.#onData(d));
    this.#child.stderr.on('data', (d) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) {
          this.stderr.push(l.trim());
          if (process.env.DSH_MCP_TEST_VERBOSE) process.stderr.write(`  [server] ${l.trim()}\n`);
        }
      }
    });
    this.#child.on('exit', (code) => {
      for (const p of this.#pending.values()) p.reject(new Error(`服务端退出 code=${code}`));
      this.#pending.clear();
    });
    return this;
  }

  /** 服务端进程 PID（测试用：模拟"MCP 崩了但它的 DSH 子进程还活着"需要单独杀掉它）。 */
  get pid() {
    return this.#child?.pid ?? null;
  }

  #onData(chunk) {
    this.#buf += chunk.toString('utf8');
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
      if (msg.id !== undefined) {
        if (msg.method === 'roots/list' && this.roots) {
          this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots: this.roots() } }) + '\n');
          continue;
        }
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 120_000, { signal } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const settle = (fn, value) => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        fn(value);
      };
      const cancel = () => {
        this.notify('notifications/cancelled', { requestId: id });
        settle(reject, signal.reason);
      };
      const timer = setTimeout(() => settle(reject, new Error(`请求超时: ${method}`)), timeoutMs);
      this.#pending.set(id, { resolve: (value) => settle(resolve, value), reject: (error) => settle(reject, error) });
      signal?.addEventListener('abort', cancel, { once: true });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: this.roots ? { roots: { listChanged: true } } : {},
      clientInfo: this.clientInfo,
    });
    this.notify('notifications/initialized', {});
    return r;
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools;
  }

  async callTool(name, args, timeoutMs, options) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, options);
    if (name === 'dsh_start') {
      const id = result?.structuredContent?.conversation_id;
      if (typeof id === 'string' && id) this.createdIds.add(id);
    }
    return result;
  }

  /** 取工具结果里的纯文本。 */
  static text(result) {
    return (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  async close() {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    try {
      this.#child.stdin.end();
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          this.#child?.kill();
        } catch {}
        r();
      }, 6000);
      this.#child?.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
}
