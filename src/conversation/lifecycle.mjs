/**
 * 会话进程生命周期：拉起/冷 resume 重试、权限记录回读核验、写锁抢占与释放/forget。
 */

import { join } from 'node:path';
import { L } from '../lang.mjs';
import { ALLOW_FULL_ACCESS, DSH_HOME, PERMISSION_TIERS, resolveTeamProfile, SHARED_PROCESS } from '../config.mjs';
import { AcpProcess } from '../acp.mjs';
import { applySessionConfig } from '../acp-session.mjs';
import { readConversationMeta } from '../titles.mjs';
import { writeTombstone } from '../hub-store.mjs';
import { removeLive } from '../live.mjs';
import { removeWorktree } from '../worktree.mjs';
import {
  classifyHolder,
  describeLeaseConflict,
  isLeaseError,
  isPidAlive,
  killHolderChild,
  removeMarker,
} from '../locks.mjs';

const now = () => Date.now();

/** @param {import('../types.mjs').ConversationContext} ctx */
export async function verifyPermissionRecorded(conv, ctx, { attempts = undefined, delayMs = 250 } = {}) {
  const { hub } = ctx;
  const tries = Number.isFinite(attempts) ? attempts : conv.permission === 'read-only' ? 40 : 6;
  const patchFile = join(DSH_HOME, 'profiles', conv.proc?.teamProfile?.profile ?? resolveTeamProfile().profile, 'cordis.patch.yml');
  for (let i = 0; i < tries; i++) {
    const meta = readConversationMeta(conv.id);
    const recorded = meta?.permissions?.preset;
    if (recorded) {
      if (!PERMISSION_TIERS.includes(recorded) || recorded !== conv.permission) {
        throw new Error(L(
          `会话实际权限档为 ${JSON.stringify(recorded)}，与请求的 ${conv.permission} 不一致。\n` +
            '  这通常意味着 DSH profile 里写了 permission.defaultPreset，覆盖了启动时传入的权限档。\n' +
            `  请检查 ${patchFile}，删掉 permission.defaultPreset 后重试。`,
          `Conversation recorded permission tier ${JSON.stringify(recorded)}, which does not match requested ${conv.permission}.\n` +
            '  This usually means permission.defaultPreset in the DSH profile overrode the launch permission.\n' +
            `  Check ${patchFile}, remove permission.defaultPreset, and retry.`,
        ));
      }
      const sandboxes = [meta.permissions.sandbox, meta.sandboxMode].filter((v) => v !== undefined && v !== null);
      if (sandboxes.some((s) => s !== conv.permission) || (conv.permission === 'read-only' && !sandboxes.length)) {
        throw new Error(L(
          `会话权限预设为 ${recorded}，但实际沙箱记录为 ${JSON.stringify(sandboxes)}，与请求的 ${conv.permission} 不一致。\n` +
            `  这通常意味着 DSH profile 改写了该预设的 sandbox。请检查 ${patchFile} 里的 permission.presets。`,
          `Conversation preset is ${recorded}, but recorded sandbox ${JSON.stringify(sandboxes)} does not match requested ${conv.permission}.\n` +
            `  This usually means the DSH profile redefined that preset's sandbox. Check permission.presets in ${patchFile}.`,
        ));
      }
      conv.permissionVerified = true;
      return recorded;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  conv.permissionVerified = false;
  if (conv.permission === 'read-only') {
    throw new Error(L(
      `无法在 ${(tries * delayMs) / 1000}s 内确认会话实际为 read-only（投影缓存无权限记录）。\n` +
        '  为避免 profile 的 defaultPreset 把只读会话静默提升为完全访问，本次调用已拒绝。\n' +
        '  请确认 DSH 会话存储可读，或稍后重试；非只读档位不受此限制。',
      `Could not verify read-only permission within ${(tries * delayMs) / 1000}s (no permission record in projection cache).\n` +
        '  Refusing to continue so a profile defaultPreset cannot silently elevate a read-only session.\n' +
        '  Check that DSH session storage is readable or retry; non-read-only tiers are unaffected.',
    ));
  }
  hub.log.info(`[conv ${conv.id}] 投影缓存里暂时没有权限记录，跳过运行期核对（非只读档）`);
  return null;
}

/** @param {import('../types.mjs').ConversationContext} ctx */
export async function ensureAlive(conv, ctx, { retried = false } = {}) {
  const { hub } = ctx;
  if (conv.recycling) await conv.recycling;
  if (conv.proc?.quarantined) throw new Error('ACP process quarantined by the turn watchdog');
  if (conv.proc?.alive) return conv.proc;
  if (conv.permission === 'danger-full-access' && !ALLOW_FULL_ACCESS) {
    throw new Error(L(
      `会话 ${conv.id} 的权限档是 danger-full-access，而本机没有允许 full access，拒绝恢复。` +
        ' 在客户端配置里设 DSH_MCP_PERMISSION=danger-full-access（或 DSH_MCP_ALLOW_FULL_ACCESS=1）后重连，' +
        '或改用 workspace-write / read-only 新建会话。',
      `Conversation ${conv.id} uses danger-full-access, which is not allowed on this machine; refusing to resume.` +
        ' Set DSH_MCP_PERMISSION=danger-full-access (or DSH_MCP_ALLOW_FULL_ACCESS=1) in your client config and reconnect, ' +
        'or start a new workspace-write / read-only conversation.',
    ));
  }
  const shared = SHARED_PROCESS;
  let proc;
  if (shared) {
    proc = hub.acquireHost(conv.cwd, conv.permission);
    proc.attach(conv);
    conv.proc = proc;
  } else {
    proc = new AcpProcess({
      cwd: conv.cwd,
      permission: conv.permission,
      log: hub.log,
      onNotification: (params) => conv.onUpdate(params),
      onPermissionRequest: (params) => conv.onPermissionRequest(params),
    });
    proc.start();
    conv.proc = proc;
  }
  try {
    await proc.initialize();
    await proc.request('session/resume', { sessionId: conv.id, cwd: conv.cwd, mcpServers: [] });
    conv.lastConfigApplied = await applySessionConfig(proc, conv.id, conv.cfg);
    for (const f of conv.lastConfigApplied.failed) hub.log.info(`[conv ${conv.id}] ${f}`);
    await conv.verifyPermissionRecorded();
    await conv.recordChildProcess(proc);
    conv.lockConflict = null;
    hub.log.info(`[conv ${conv.id}] 已 resume`);
    return proc;
  } catch (e) {
    if (e?.code === 'ACP_TIMEOUT') {
      const tail = proc.stderrTail;
      if (tail) hub.log.dshStderr?.(`[conv ${conv.id}] ${e.method} 超时时 DSH stderr 尾部:\n${tail}`);
    }
    if (conv.proc === proc) conv.proc = null;
    const stopped = shared
      ? await proc.detach(conv).catch(() => false)
      : await proc.stop().catch(() => false);
    if (stopped) removeMarker(conv.id);
    if (isLeaseError(e.message)) {
      const holder = classifyHolder(conv.id, { knownChildPid: conv.lastChildPid });
      conv.lockConflict = {
        at: now(),
        holder_kind: holder.kind,
        holder: holder.marker ?? null,
        reason: holder.reason,
        hint:
          holder.kind === 'none'
            ? L(
                '持有者不是本服务拉起的进程（多半是你自己的 DSH GUI；切走或归档也不会放锁）。重启 DSH 桌面端 / dsh web 即可无损归还；平时看进度请用 dsh-any-agent watch 或 dashboard --open。',
                'The holder is not a process started by this server (most likely DSH GUI; switching away or archiving does not release it). Restart DSH desktop / dsh web to release it without losing history; use dsh-any-agent watch or dashboard --open to watch progress.',
              )
            : holder.kind === 'stale-mcp'
              ? L('持有者已失联（心跳过期）或是本进程的残留子进程 —— 直接 dsh_takeover，无需 force。', 'The holder is stale (expired heartbeat) or a leftover child — call dsh_takeover without force.')
              : holder.kind === 'live-mcp'
                ? L('另一个活着的 dsh-any-agent 实例持有它：在那边 dsh_release，或用 dsh_takeover(force=true) 夺过来。', 'Another live dsh-any-agent instance holds it: call dsh_release there, or use dsh_takeover(force=true).')
                : L('稍后重试。', 'Retry shortly.'),
      };
      throw Object.assign(new Error(describeLeaseConflict(conv.id, holder)), { code: 'session-writer-held', holder });
    }
    if (e?.code === 'ACP_TIMEOUT' && !retried && stopped && !proc.alive) {
      hub.log.info(`[conv ${conv.id}] ${e.method ?? 'ACP'} 超时（${e.timeoutMs ?? '?'}ms），已回收该进程；重建进程重试一次`);
      return ensureAlive(conv, ctx, { retried: true });
    }
    throw new Error(L(`恢复会话失败（已作废该进程，下次调用会重建）：${e.message}`, `Failed to resume conversation (process discarded; next call will recreate it): ${e.message}`));
  }
}

/** @param {import('../types.mjs').ConversationContext} ctx */
export async function takeover(conv, ctx, { force = false } = {}) {
  const { hub, getLastChildStartedAt } = ctx;
  const report = { conversation_id: conv.id, ok: false, holder_kind: null, killed_pid: null, message: '' };

  if (conv.proc?.alive) {
    report.ok = true;
    report.message = L('本进程已经持有该会话，无需抢占。', 'This server already holds the conversation; no takeover needed.');
    return report;
  }

  try {
    await conv.ensureAlive();
    report.ok = true;
    report.message = L(
      '无需抢占：正常 resume 就成功了（锁是空的，原持有者已释放）。',
      'No takeover needed: normal resume succeeded (the lock was already free).',
    );
    return report;
  } catch (e) {
    if (e.code !== 'session-writer-held') {
      report.message = L(`不是写锁问题，抢占帮不上忙：${e.message}`, `Not a write-lock conflict; takeover cannot help: ${e.message}`);
      return report;
    }
  }

  const holder = classifyHolder(conv.id, { knownChildPid: conv.lastChildPid });
  report.holder_kind = holder.kind;
  report.holder = holder.marker;
  const killTarget = holder.known_child_pid ?? holder.marker?.child_pid;
  const expectedStartedAt = holder.known_child_pid ? getLastChildStartedAt() : holder.marker?.child_started_at;

  if (holder.kind === 'none' || !holder.childAlive) {
    report.message = L(
      `抢占未执行：${holder.reason}\n` +
        '本服务**不会**杀非本服务拉起的进程（那可能是你的 DSH GUI，杀它会连你正在看的对话一起没）。\n' +
        '注意：DSH GUI 点开会话后切走也不会放锁，请重启 DSH 桌面端 / dsh web 后重试；看进度请改用 dsh-any-agent watch 或 dashboard --open。',
      `Takeover skipped: ${holder.reason}\n` +
        'This server will **not** kill processes it did not start (likely your DSH GUI).\n' +
        'Note: switching away in DSH GUI does not release the lock; restart DSH desktop / dsh web and retry, and use dsh-any-agent watch or dashboard --open to observe progress.',
    );
    return report;
  }
  if (holder.kind === 'live-mcp' && !force) {
    report.message = L(
      `抢占被拒绝：${holder.reason}\n如果确认那边已经不用它了，重试时带 force=true 强行夺过来。`,
      `Takeover refused: ${holder.reason}\nIf the other instance no longer needs it, retry with force=true.`,
    );
    return report;
  }

  const sharedVictims = hub.hostVictimsOf(killTarget, conv.id);
  if (sharedVictims.length > 0) {
    report.shared_sessions = sharedVictims;
    if (!force) {
      const list = sharedVictims.map((id) => id.slice(0, 8)).join(', ');
      report.message = L(
        `抢占被拒绝：PID ${killTarget} 是共享进程，上面还挂着 ${sharedVictims.length} 个其它会话（${list}）。\n` +
          '杀掉它会连坐这些会话：各自进行中的回合会中断（会话本体无损，之后照常 resume）。\n' +
          '确认可以接受就带 force=true 重试；不想连坐就先 dsh_release 那些会话，或等它们空闲。',
        `Takeover refused: PID ${killTarget} is a shared process hosting ${sharedVictims.length} other conversation(s) (${list}).\n` +
          'Killing it interrupts their in-flight turns (sessions stay intact on disk and resume later).\n' +
          'Retry with force=true if acceptable, or dsh_release those conversations first.',
      );
      return report;
    }
  }

  const kill = killHolderChild(killTarget, { expectedStartedAt });
  report.kill = kill;
  if (!kill.killed) {
    report.message = L(`抢占失败：${kill.reason}`, `Takeover failed: ${kill.reason}`);
    return report;
  }
  report.killed_pid = killTarget;
  removeMarker(conv.id, { force: true });
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(killTarget)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    await conv.ensureAlive();
    report.ok = true;
    report.message = L(
      `已抢占：杀掉持有者 PID ${killTarget}（${holder.reason}），并成功接管会话。` +
        '\n⚠️ 如果那个进程当时正在跑回合，那一轮的工作会中断（会话日志会记为 interrupted）。' +
        (sharedVictims.length > 0 ? `\n⚠️ 它是共享进程，另外 ${sharedVictims.length} 个会话也被一起断掉了（各自 resume 即可）。` : ''),
      `Takeover succeeded: killed holder PID ${killTarget} (${holder.reason}) and resumed the conversation.` +
        '\n⚠️ If that process was running a turn, that turn was interrupted.' +
        (sharedVictims.length > 0 ? `\n⚠️ It was a shared process, so ${sharedVictims.length} other conversation(s) were also detached (they resume on next dispatch).` : ''),
    );
  } catch (e) {
    report.message = L(`杀掉 PID ${killTarget} 之后仍无法接管：${e.message}`, `Killed PID ${killTarget} but could not take over: ${e.message}`);
  }
  return report;
}

/** @param {import('../types.mjs').ConversationContext} ctx */
export async function closeConversation(conv, ctx, { forget = false } = {}) {
  const { hub, activity } = ctx;
  if (forget) {
    const holder = conv.proc?.alive ? null : classifyHolder(conv.id, { knownChildPid: conv.lastChildPid });
    if (holder?.kind === 'live-mcp') {
      return {
        closed: false,
        forgotten: false,
        error: L(
          `另一个活着的 dsh-any-agent 实例（PID ${holder.marker?.mcp_pid ?? '?'}）正持有该会话的写锁：先在那边 dsh_release，再 forget。`,
          `Another live dsh-any-agent instance (PID ${holder.marker?.mcp_pid ?? '?'}) holds this conversation's write lock: call dsh_release there before forgetting.`,
        ),
      };
    }
    for (const item of [...conv.queue]) conv.queueRemove(item.run.run_id);
  }
  if (conv.recycling) await conv.recycling;
  const proc = conv.proc;
  let stopped = true;
  if (proc?.alive) {
    if (typeof proc.detach === 'function') {
      conv.recycling = proc.detach(conv).finally(() => {
        if (conv.proc === proc) conv.proc = null;
        conv.recycling = null;
      });
      stopped = await conv.recycling;
    } else {
      try {
        await proc.request('session/close', { sessionId: conv.id }, 10_000);
      } catch {}
      conv.recycling = proc
        .stop()
        .catch(() => false)
        .finally(() => {
          if (conv.proc === proc) conv.proc = null;
          conv.recycling = null;
        });
      stopped = await conv.recycling;
    }
  } else if (conv.proc === proc) {
    conv.proc = null;
  }

  for (const [apId, p] of conv.pendingApprovals) {
    try { p.resolve({ outcome: { outcome: 'cancelled' } }); } catch {}
    activity.approvalDecided(apId, 'close', null, 'cancelled');
  }
  conv.pendingApprovals.clear();

  if (stopped) removeMarker(conv.id);
  else {
    hub.log.info(`[conv ${conv.id}] 进程未能确认退出，保留写锁登记以便后续归因`);
    if (forget) {
      return {
        closed: false,
        forgotten: false,
        error: L('进程未能确认退出，拒绝 forget', 'Could not confirm process exit; refusing to forget'),
      };
    }
  }
  if (forget) {
    const tombErr = writeTombstone(conv.id);
    if (tombErr) {
      await hub.save();
      return {
        closed: stopped,
        forgotten: false,
        error: L(
          `forget 墓碑写入失败（会话未移除，可修复后重试）：${tombErr}`,
          `Failed to write forget tombstone (conversation kept; fix and retry): ${tombErr}`,
        ),
      };
    }
    await hub.remove(conv.id);
    removeLive(conv.id);
    if (conv.worktree) {
      const worktree = await removeWorktree(conv.worktree);
      return { closed: stopped, forgotten: true, worktree };
    }
  } else {
    await hub.save();
    activity.emit('conv.close', { stopped });
  }
  return {
    closed: stopped,
    forgotten: forget,
    ...(stopped ? {} : { error: L('进程未能确认退出，登记已保留', 'Could not confirm process exit; lock registration kept') }),
  };
}
