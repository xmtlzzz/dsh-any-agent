/**
 * 一个 DSH ACP 运行时进程的客户端封装。
 *
 * 协议：换行分隔 JSON-RPC 2.0 over stdio（与 `--profile acp` 的实现一致）。
 * 与 SDK profile 的关键差别：ACP 原生支持 session/resume、session/cancel、
 * session/close、session/list，以及 session/request_permission 客户端往返。
 *
 * 日志策略：子树进程的 stderr **默认既不转发也不落盘**，只在内存里保留有界的尾部若干行，
 * 供排障时一次性取出。原因是 DSH 的 stderr 可能夹带模型输出（含思考内容）。
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { ensureProfile } from './bootstrap.mjs';
import {
  CHILD_MAX_OLD_SPACE_MB,
  PKG_VERSION,
  REQUEST_TIMEOUT_MS,
  resolveDsh,
  resolveTeamProfile,
} from './config.mjs';
import { probeRuntimeNode, satisfiesNodeRange } from './dsh-locate.mjs';
import { L } from './lang.mjs';
import { LineDecoder } from './line-decoder.mjs';
import { readProcessStartTime } from './locks.mjs';

/** ACP 协议版本（@agentclientprotocol/sdk 的 v1）。 */
const PROTOCOL_VERSION = 1;

/** 内存里保留的 DSH stderr 行数上限（仅内存，不落盘、默认不打印）。 */
const STDERR_TAIL_LINES = 20;

const NOOP_LOG = { info: (_m) => {}, debug: (_m) => {}, dshStderr: (_m) => {} };

export class AcpProcess {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #lineDecoder = new LineDecoder();
  #errDecoder = new LineDecoder();
  #stderrTail = [];
  #stopping = false;
  #log = NOOP_LOG;
  #onPermissionRequest;
  #onNotification;
  #onExit;
  #exitNotified = false;
  #teamProfile = null;
  #startTime = null;

  /**
   * @param {object} opts
   * @param {string} opts.cwd      工作区（同时作为 OS 级 cwd 与 session cwd）
   * @param {string} opts.permission 权限档，映射到 DSH_PERMISSION_MODE
   * @param {object} [opts.log]    分级 logger（见 config.createLogger）
   * @param {(params:object)=>any} [opts.onPermissionRequest]
   * @param {(params:object, method?:string)=>void} [opts.onNotification]
   * @param {(reason:string)=>void} [opts.onExit]
   */
  constructor({ cwd, permission, log, onPermissionRequest, onNotification, onExit }) {
    this.cwd = cwd;
    this.permission = permission;
    if (log) this.#log = log;
    this.#onPermissionRequest = onPermissionRequest;
    this.#onNotification = onNotification;
    this.#onExit = onExit;
    this.initialized = false;
  }

  /** 非主动 stop 的退出通知，供共享进程池解除同组会话的宿主引用。 */
  #notifyExit(reason) {
    if (this.#exitNotified || this.#stopping) return;
    this.#exitNotified = true;
    try {
      this.#onExit?.(reason);
    } catch (e) {
      this.#log.debug(`[acp] onExit 处理异常: ${e.message}`);
    }
  }

  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#stopping;
  }

  /** 子进程 PID（供写锁登记使用）；未启动或已退出时为 null。 */
  get pid() {
    return this.#child?.pid ?? null;
  }

  get teamProfile() {
    return this.#teamProfile;
  }

  get startTime() {
    return this.#startTime;
  }

  /** DSH stderr 的内存尾部（诊断用；默认不打印、不落盘）。 */
  get stderrTail() {
    return this.#stderrTail.join('\n');
  }

  /** 拉起进程。注意 ACP 没有"就绪"握手信号，spawn 后即可发请求。 */
  start() {
    if (this.#child) throw new Error(L('AcpProcess 已经启动过了', 'AcpProcess has already started'));
    if (!statSync(this.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(L(
        '工作区目录不存在或不是目录：' + this.cwd + '。恢复原目录，或用新工作区的绝对路径调用 dsh_start。',
        'Workspace directory is missing or is not a directory: ' + this.cwd + '. Restore the original directory or pass the new absolute path to dsh_start.',
      ));
    }
    // 桌面版用 Electron 运行 asar 内的 CLI，npm/npx 一般用本进程的 node。
    const dsh = resolveDsh();
    const runtimeNode = dsh.enginesNode ? probeRuntimeNode(dsh) : null;
    if (satisfiesNodeRange(dsh.enginesNode, runtimeNode) === false) {
      throw new Error(L(
        'DSH 运行时 Node ' + runtimeNode + ' 不满足 ' + dsh.enginesNode +
          '。请更新所选运行时，或在 MCP 配置中用 DSH_RUNTIME 指定兼容的可执行文件后重连。',
        'DSH runtime Node ' + runtimeNode + ' does not satisfy ' + dsh.enginesNode +
          '. Update the selected runtime or set DSH_RUNTIME to a compatible executable in the MCP config, then reconnect.',
      ));
    }
    const teamProfile = resolveTeamProfile(dsh.version ?? null);
    this.#teamProfile = teamProfile;
    // ★ 拉进程前确保 profile 就绪：首次使用会自动按本机已有路由建一份。
    //   放在这里而不是模块加载期，是为了让"改完配置再拉起"这种场景也能生效，
    //   并且失败时只让本次拉起失败（由 DSH 自己报错），不拖垮整个 MCP 服务。
    const ready = ensureProfile({ log: this.#log, teamProfile });
    if (!ready.ok) {
      this.#log.info(`[acp] profile 引导失败（继续尝试拉起，由 DSH 自己报错）: ${ready.error}`);
    } else if (ready.skipped) {
      this.#log.debug(`[acp] profile 引导跳过: ${ready.skipped}`);
    }
    const env = { ...process.env, ...dsh.env, DSH_PERMISSION_MODE: this.permission };
    // 0.4.0：可选的子进程堆上限。只加参数、不覆盖用户已有的 NODE_OPTIONS。
    if (CHILD_MAX_OLD_SPACE_MB > 0) {
      const prev = String(env.NODE_OPTIONS ?? '').trim();
      env.NODE_OPTIONS = `${prev} --max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`.trim();
    }
    const launchError = (cause) => new Error(
      L(
        `无法启动 DSH 运行时 ${dsh.command}（${cause.code ?? 'spawn failed'}）。请检查可执行文件或 DSH_RUNTIME。`,
        `Unable to launch DSH runtime ${dsh.command} (${cause.code ?? 'spawn failed'}). Check the executable or DSH_RUNTIME.`,
      ),
      { cause },
    );
    let child;
    try {
      child = spawn(dsh.command, [...dsh.args, '--profile', teamProfile.profile], {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      throw launchError(e);
    }

    this.#child = child;
    const failChild = (error) => {
      if (this.#child !== child) return;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#child = null;
      this.initialized = false;
      this.#notifyExit(error.message);
    };
    child.stdout.on('data', (d) => this.#onData(d));
    // ★ stdio 的 'error' 必须常驻监听：子进程退出与下一次写入之间存在竞态，
    //   未监听的 EPIPE 会以未处理错误终止**整个 MCP 进程**（连带所有会话）。
    const streamError = (e) => {
      this.#log.info(`[acp] 子进程 stdio 错误: ${e.message}`);
      failChild(new Error(L(`DSH 进程 stdio 不可用: ${e.message}`, `DSH process stdio is unavailable: ${e.message}`), { cause: e }));
    };
    child.stdin.on('error', streamError);
    child.stdout.on('error', streamError);
    child.stderr.on('error', streamError);
    child.stderr.on('data', (d) => {
      for (const line of this.#errDecoder.push(d)) {
        if (!line.trim()) continue;
        this.#stderrTail.push(line.trim());
        if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
        // 只有显式开启 DSH_MCP_LOG_STDERR 才会把它打到 stderr
        this.#log.dshStderr(`[dsh stderr] ${line.trim()}`);
      }
    });
    child.on('exit', (code) => {
      failChild(new Error(L(`DSH 进程退出（code=${code}）`, `DSH process exited (code=${code})`)));
      this.#log.debug(`[acp] 进程退出 code=${code}`);
    });
    child.on('error', (e) => {
      this.#log.info(`[acp] 子进程操作失败: ${e.message}`);
      // A failed kill can emit 'error' too. A child with a PID still owns its state until exit.
      if (child.pid === undefined) failChild(launchError(e));
    });
    this.#startTime = readProcessStartTime(child.pid).then((time) => this.#child === child && this.alive ? time : null);
    return this;
  }

  #onData(chunk) {
    for (const line of this.#lineDecoder.push(chunk)) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#log.debug('[acp] 收到非 JSON 行（已忽略）');
        continue;
      }
      // ★ `null` / 数字 / 数组也是合法 JSON，但不是 JSON-RPC 消息：#dispatch 访问 msg.id 会抛出
      //   未捕获异常，在 stdout 的 data 回调里直接杀掉整个 MCP 服务（审计 D01）。
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.#log.debug('[acp] 收到非对象 JSON 行（已忽略）');
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        // ⚠️ 必须带上 error.data：ACP 把**非 RequestError 的异常**统一包成
        // {code:-32603, message:"Internal error", data:{...真实原因...}}。
        // 只取 message 的话，真实原因会被丢掉，只剩一句无用的 "Internal error"。
        const d = msg.error.data;
        let extra = '';
        if (d !== undefined && d !== null) {
          let s;
          try {
            s = typeof d === 'string' ? d : JSON.stringify(d);
          } catch {
            s = String(d);
          }
          if (s && s !== '{}') extra = ` | data=${s.length > 800 ? `${s.slice(0, 800)}…` : s}`;
        }
        const code = msg.error.code !== undefined ? `[${msg.error.code}] ` : '';
        p.reject(new Error(`${code}${msg.error.message ?? JSON.stringify(msg.error)}${extra}`));
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.#handleIncomingRequest(msg);
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.#onNotification?.(msg.params ?? {}, msg.method);
      } catch (e) {
        this.#log.debug(`[acp] 通知处理异常: ${e.message}`);
      }
    }
  }

  async #handleIncomingRequest(msg) {
    let result = {};
    try {
      if (msg.method === 'session/request_permission') {
        result = (await this.#onPermissionRequest?.(msg.params ?? {})) ?? {
          outcome: { outcome: 'cancelled' },
        };
      } else {
        this.#log.debug(`[acp] 未处理的客户端请求: ${msg.method}`);
      }
    } catch (e) {
      this.#log.debug(`[acp] 处理 ${msg.method} 失败: ${e.message}`);
      result = { outcome: { outcome: 'cancelled' } };
    }
    this.#write({ jsonrpc: '2.0', id: msg.id, result });
  }

  #write(obj) {
    if (!this.#child?.stdin?.writable) return false;
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  /**
   * 发一个请求并等结果。
   *
   * `timeoutMs <= 0` = **不设超时**。这是给"长回合"用的：等待与否应该由上层按
   * `wait` 语义决定，绝不该在这里把请求掐断 —— 本地放弃并不会让 agent 停下来，
   * 只会让我们丢掉结果、误判回合结束（进而让 reaper 杀掉正在干活的进程）。
   */
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.alive) return Promise.reject(new Error(L('DSH 进程未运行', 'The DSH process is not running')));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.#pending.delete(id)) return;
              // 带上机器可读的 code/method：上层要区分"DSH 没回话（超时）"与"DSH 明确拒绝"，
              // 前者可能是瞬时卡顿（可重试），后者重试只会重复同一个错误，不能靠匹配中文报错文本来分。
              const err = Object.assign(
                new Error(L(`ACP 请求超时: ${method}`, `ACP request timed out: ${method}`)),
                { code: 'ACP_TIMEOUT', method, timeoutMs },
              );
              reject(err);
            }, timeoutMs)
          : null;
      this.#pending.set(id, { resolve, reject, timer });
      const written = this.#write({ jsonrpc: '2.0', id, method, params });
      if (!written) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(L(`ACP 写入失败（子进程 stdin 不可写）: ${method}`, `Could not write ACP request to child stdin: ${method}`)));
      }
    });
  }

  /** 发一个通知（无回包）。 */
  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 进程创建后再绑定/更换回调（Hub 需要先建进程、再建会话对象，顺序上只能事后绑）。 */
  attachRoutes({ onNotification = undefined, onPermissionRequest = undefined } = {}) {
    if (onNotification) this.#onNotification = onNotification;
    if (onPermissionRequest) this.#onPermissionRequest = onPermissionRequest;
    return this;
  }

  /** 完成 ACP 握手（每个进程一次）。 */
  async initialize() {
    if (this.initialized) return this.#initResult;
    this.#initResult = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-any-agent', version: PKG_VERSION },
    });
    this.initialized = true;
    return this.#initResult;
  }
  #initResult = null;

  /** 优雅收尾：close 由调用方负责，这里只关 stdin（DSH 绑定 stdin EOF → 有界退出）。 */
  async stop({ graceMs = 3000, killWaitMs = 5000, signal = undefined } = {}) {
    const child = this.#child;
    if (!child) return true;
    this.#stopping = true;
    try {
      child.stdin.end();
    } catch {}
    const waitExit = (ms) =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
        const t = setTimeout(() => resolve(false), ms);
        child.once('exit', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    // 1) 先给它体面退出的机会（stdin EOF → DSH 有界退出）
    if (await waitExit(graceMs)) return true;
    // 2) 超时则强杀，**并且等它真的退出**。
    //    ★ 旧实现 kill() 之后立刻 resolve —— 于是调用方会在"子进程还活着、还握着写锁"
    //      的时候继续往下走：删掉登记、再 spawn 新进程去 resume，就会撞上一个**无法归因的锁**
    //      （登记没了 → classifyHolder 判成 none → 连 dsh_takeover 都会拒绝）。
    //      这就是"异步派活 → 等 task → 回头再进就报有锁"的一个真实来源。
    try {
      child.kill(signal);
    } catch {}
    return await waitExit(killWaitMs);
  }

  get quarantined() {
    return this.#stopping && this.#child !== null;
  }

  async abort() {
    const stopped = await this.stop({ graceMs: 0, signal: 'SIGKILL' });
    // 即便系统尚未确认进程退出，同组调用也必须收到有界的失败。
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ACP process quarantined by the turn watchdog'));
    }
    this.#pending.clear();
    return stopped;
  }
}
