/**
 * 共享 ACP 进程宿主（0.4.0 引入，0.5.0 起默认开启；`DSH_MCP_SHARED_PROCESS=0` 关闭）。
 *
 * DSH 的 ACP 服务端支持一条连接上多会话，每个 session 有自己的 Agent 与上下文。
 * 但 `dsh-base` 的 `sandbox-policy.workspaceRoot` / `mode` 与 `approval.policy`
 * 都是**进程级**配置，所以只能按 `(cwd, permission)` 分组共享：
 *   - 同一工作区、同一权限档的会话可以共用一个 DSH 进程；
 *   - 不同工作区/权限档仍然各起一个进程（这是硬约束，不是实现偷懒）。
 *
 * 共享进程崩溃会拒绝同组会话的 ACP 请求，各回合的收尾负责写哨兵并唤醒等待者。
 * `onExit` 解除宿主引用，下次派活各自重新 resume。
 */

import { AcpProcess } from './acp.mjs';

const now = () => Date.now();

export class SessionHost {
  constructor({ cwd, permission, log, hub, AcpProcessClass = AcpProcess }) {
    this.cwd = cwd;
    this.permission = permission;
    this.log = log;
    this.hub = hub;
    this.AcpProcessClass = AcpProcessClass;
    this.proc = null;
    this.initializing = null;
    this.stopping = null;
    /** sessionId → Conversation */
    this.conversations = new Map();
    this.lastUsedAt = now();
  }

  get alive() {
    return !!this.proc?.alive;
  }

  get quarantined() {
    return this.aborting != null || this.proc?.quarantined === true;
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  get stderrTail() {
    return this.proc?.stderrTail ?? '';
  }

  get size() {
    return this.conversations.size;
  }

  has(id) {
    return this.conversations.has(id);
  }

  attach(conv) {
    this.conversations.set(conv.id, conv);
    this.lastUsedAt = now();
  }

  /** 拉起并完成 ACP 握手；并发调用共享同一个 in-flight promise。 */
  async initialize() {
    if (this.quarantined) throw new Error('ACP process quarantined by the turn watchdog');
    // ★ 先看 in-flight 握手：`this.proc` 在握手完成前就已赋值且 alive，只看 alive 的话
    //   并发的第二个调用者会在 initialize 回包前发 session/new（审计 B05）。
    if (this.initializing) return this.initializing;
    if (this.proc?.alive && this.proc.initialized !== false) return;
    this.initializing = (async () => {
      // 进程活着但握手没完成（上次握手失败）：在它上面重试握手，不另起一个进程。
      if (this.proc?.alive) {
        await this.proc.initialize();
        return;
      }
      const proc = new this.AcpProcessClass({
        cwd: this.cwd,
        permission: this.permission,
        log: this.log,
        onNotification: (params) => {
          const conv = this.conversations.get(params.sessionId);
          if (conv) conv.onUpdate(params);
          else this.log?.debug?.(`[host] 丢弃未知会话的通知: ${params.sessionId}`);
        },
        onPermissionRequest: (params) => {
          const conv = this.conversations.get(params.sessionId);
          // 找不到会话时必须拒绝，绝不能自动放行。
          if (!conv) return { outcome: { outcome: 'cancelled' } };
          return conv.onPermissionRequest(params);
        },
        onExit: (reason) => this.#onExit(proc, reason),
      });
      proc.start();
      this.proc = proc;
      await proc.initialize();
    })().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  #onExit(proc, reason) {
    // 已被换下的旧进程退出：与当前进程上的会话无关（审计 C05 同类问题）。
    if (proc !== this.proc) return;
    const convs = [...this.conversations.values()];
    this.conversations.clear();
    this.proc = null;
    for (const conv of convs) {
      try {
        conv.onProcessExit?.(reason);
      } catch (e) {
        this.log?.info?.(`[host] 处理会话 ${conv.id} 的进程退出失败: ${e.message}`);
      }
    }
    this.hub?.forgetHost?.(this);
  }

  request(method, params, timeoutMs) {
    if (!this.proc) return Promise.reject(new Error('共享 DSH 进程未运行'));
    return this.proc.request(method, params, timeoutMs);
  }

  notify(method, params) {
    return this.proc?.notify(method, params) ?? false;
  }

  /** 一个无响应的宿主只影响其现有会话，同工作目录的新宿主不复用它。 */
  abort() {
    if (this.aborting) return this.aborting;
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    this.hub?.forgetHost?.(this);
    this.aborting = proc.abort()
      .then((stopped) => {
        if (stopped) this.#onExit(proc, 'ACP process stopped by the turn watchdog');
        return stopped;
      })
      .finally(() => { this.aborting = null; });
    return this.aborting;
  }

  /**
   * 让一个会话离开宿主。默认顺手 `session/close` 释放该会话的 Agent 与写锁；
   * 最后一个会话离开时停掉进程。
   */
  async detach(conv, { closeSession = true } = {}) {
    if (this.aborting) return this.aborting;
    let closed = true;
    if (closeSession && this.proc?.alive && this.conversations.has(conv.id)) {
      try {
        await this.request('session/close', { sessionId: conv.id }, 10_000);
      } catch (e) {
        // 进程已经不在了就无所谓；进程还活着而 close 被拒，说明这个会话（和它的写锁）仍在里面。
        closed = !this.proc?.alive;
        if (!closed) this.log?.info?.(`[host] session/close 失败，会话可能仍持有写锁: ${conv.id}: ${e.message}`);
      }
    }
    this.conversations.delete(conv.id);
    // 最后一个会话离开时停进程，锁随进程一起释放，此时以 stop 的结果为准。
    if (this.conversations.size === 0) return this.stop();
    // ★ 进程还载着别的会话、close 又没被确认：不能报告已释放，调用方据此保留写锁登记（审计 B05）。
    return closed;
  }

  /** 只有在没有会话附加时才真正停进程。 */
  async stop() {
    if (this.conversations.size > 0) return true;
    if (this.stopping) return this.stopping;
    const proc = this.proc;
    this.proc = null;
    if (!proc) {
      this.hub?.forgetHost?.(this);
      return true;
    }
    this.stopping = proc
      .stop()
      .catch(() => false)
      .finally(() => {
        this.stopping = null;
        // ★ 停的过程中同一宿主可能已经拉起新进程、挂上新会话：那时不能把宿主移出进程池，
        //   否则抢占检查（hostVictimsOf）就查不到新进程上的会话（审计 C05）。
        if (!this.proc && this.conversations.size === 0) this.hub?.forgetHost?.(this);
      });
    return this.stopping;
  }
}
