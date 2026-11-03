/**
 * 共享 ACP 进程宿主（0.4.0 引入，0.5.0 起默认开启；`DSH_MCP_SHARED_PROCESS=0` 关闭）。
 *
 * DSH 的 ACP 服务端支持一条连接上多会话，每个 session 有自己的 Agent 与上下文。
 * 但 `dsh-base` 的 `sandbox-policy.workspaceRoot` / `mode` 与 `approval.policy`
 * 都是**进程级**配置，所以只能按 `(cwd, permission)` 分组共享：
 *   - 同一工作区、同一权限档的会话可以共用一个 DSH 进程；
 *   - 不同工作区/权限档仍然各起一个进程（这是硬约束，不是实现偷懒）。
 *
 * 代价：共享进程崩溃会连坐同组的所有会话。`onExit` 会把它们统一标成失败、
 * 写 error 哨兵并唤醒等待者；下次派活各自重新 resume。
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
    if (this.proc?.alive) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
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
        onExit: (reason) => this.#onExit(reason),
      });
      proc.start();
      this.proc = proc;
      await proc.initialize();
    })().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  #onExit(reason) {
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

  /**
   * 让一个会话离开宿主。默认顺手 `session/close` 释放该会话的 Agent 与写锁；
   * 最后一个会话离开时停掉进程。
   */
  async detach(conv, { closeSession = true } = {}) {
    if (closeSession && this.proc?.alive && this.conversations.has(conv.id)) {
      try {
        await this.request('session/close', { sessionId: conv.id }, 10_000);
      } catch {
        // 已经关闭/进程正在退出都无所谓
      }
    }
    this.conversations.delete(conv.id);
    if (this.conversations.size === 0) return this.stop();
    return true;
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
        this.hub?.forgetHost?.(this);
      });
    return this.stopping;
  }
}
