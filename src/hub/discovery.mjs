/**
 * Hub 磁盘会话兜底接管（adoptFromDisk）与 ACP `session/list` 合并探测（listConversations）。
 */

import {
  APPROVAL_POLICIES,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  LIST_PROBE_TTL_MS,
  PERMISSION_TIERS,
  REASONING_EFFORTS,
  REVIEW_MODES,
  defaultApprovalPolicy,
} from '../config.mjs';
import { L } from '../lang.mjs';
import { AcpProcess } from '../acp.mjs';
import { readConversationMeta } from '../titles.mjs';
import { Conversation } from '../conversation.mjs';
import { findSessionHeaderStatus } from '../workspace.mjs';
import { isForgotten, readConversationMetaFile } from '../hub-store.mjs';

const now = () => Date.now();

/** 从 DSH 会话存储按 id 兜底接管一条未在注册表里的会话（未知权限时 fail-closed 到 read-only）。 */
export async function adoptConversationFromDisk(hub, id) {
  const found = await findSessionHeaderStatus(id);
  if (found.status === 'error') {
    throw new Error(L(`无法读取会话 ${id} 的会话头：${found.reason}`, `Cannot read the session header of ${id}: ${found.reason}`));
  }
  const header = found.header;
  if (!header?.cwd) return null;

  const meta = readConversationMeta(id);
  const persisted = readConversationMetaFile(id);
  const recordedPreset = meta?.permissions?.preset;
  const recordedPermission = PERMISSION_TIERS.includes(recordedPreset) ? recordedPreset : null;
  const permission =
    recordedPermission === 'read-only'
      ? 'read-only'
      : PERMISSION_TIERS.includes(persisted?.permission)
        ? persisted.permission
        : (recordedPermission ?? 'read-only');
  const recordedApproval = meta?.permissions?.approval;
  let onApproval = APPROVAL_POLICIES.includes(persisted?.onApproval)
    ? persisted.onApproval
    : APPROVAL_POLICIES.includes(recordedApproval)
      ? recordedApproval
      : defaultApprovalPolicy(permission);
  if (permission === 'read-only' && onApproval !== 'auto-deny') onApproval = 'auto-deny';

  const conv = new Conversation(
    {
      id,
      cwd: persisted?.cwd ?? header.cwd,
      permission,
      onApproval,
      titleHint: persisted?.titleHint ?? null,
      reasoningEffort: REASONING_EFFORTS.includes(persisted?.reasoningEffort)
        ? persisted.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
      provider: persisted?.provider ?? null,
      model: persisted?.model ?? null,
      createdAt: persisted?.createdAt,
      lastUsedAt: persisted?.lastUsedAt,
      turnCount: persisted?.turnCount,
      review: REVIEW_MODES.includes(persisted?.review) ? persisted.review : DEFAULT_REVIEW,
      workspace: persisted?.workspace ?? null,
      worktree: persisted?.worktree ?? null,
    },
    hub,
  );
  hub.conversations.set(id, conv);
  try {
    await hub.save();
  } catch (error) {
    hub.conversations.delete(id);
    throw error;
  }
  hub.log.info(`[hub] 从会话存储吸收了 ${id}（注册表里没有，但磁盘上有；权限档沿用 ${permission}）`);
  return conv;
}

/** 合并本进程内存中的会话与 DSH 磁盘上未打开的会话（带 LIST_PROBE_TTL_MS 缓存）。 */
export async function listConversations(hub, { cwd = undefined, includeClosed = true } = {}, probeState) {
  const out = new Map();
  for (const c of hub.conversations.values()) {
    if (cwd && c.cwd !== cwd) continue;
    if (isForgotten(c.id)) continue;
    out.set(c.id, c.snapshot());
  }
  if (!includeClosed) {
    hub.lastProbe = { ok: null, error: null, cached: false, at: now() };
    return [...out.values()];
  }

  const cacheKey = cwd ?? '';
  const cached =
    probeState.cache && probeState.cache.key === cacheKey && now() - probeState.cache.at < LIST_PROBE_TTL_MS
      ? probeState.cache.sessions
      : null;

  let sessions = cached;
  if (cached) {
    hub.lastProbe = { ok: true, error: null, cached: true, at: probeState.cache.at };
  } else {
    let proc = null;
    try {
      proc = new AcpProcess({ cwd: cwd ?? process.cwd(), permission: 'read-only' });
      proc.start();
      await proc.initialize();
      const res = await proc.request('session/list', cwd ? { cwd } : {});
      sessions = res?.sessions ?? [];
      probeState.cache = { key: cacheKey, at: now(), sessions };
      hub.lastProbe = { ok: true, error: null, cached: false, at: probeState.cache.at };
    } catch (e) {
      hub.log.info(`[hub] session/list 探测失败: ${e.message}`);
      sessions = [];
      hub.lastProbe = { ok: false, error: e.message, cached: false, at: now() };
    } finally {
      await proc?.stop().catch(() => {});
    }
  }
  for (const s of sessions) {
    if (out.has(s.sessionId)) continue;
    if (isForgotten(s.sessionId)) continue;
    const meta = readConversationMeta(s.sessionId);
    out.set(s.sessionId, {
      conversation_id: s.sessionId,
      title: meta?.title ?? null,
      cwd: s.cwd,
      permission: null,
      alive: false,
      busy: false,
      state: 'detached',
      current_tool: null,
      out_chars: 0,
      running_ms: 0,
      turns: meta?.turns ?? null,
      usage: meta?.usage?.totals ?? null,
      context_pressure: meta?.pressure ?? null,
      model: meta?.model ?? null,
    });
  }
  return [...out.values()];
}
