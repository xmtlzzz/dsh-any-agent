/**
 * 会话与 ACP 之间的"线格式"小函数：权限应答选项、审批上下文、会话级配置下发。
 *
 * 从 hub.mjs 拆出来：它们只读入参、通过传入的 `proc.request` 说话，不碰 Conversation/Hub
 * 的状态，所以放在一起方便对照 ACP 的规范形状。
 */

import { L } from './lang.mjs';
import { sanitizeApprovalContext } from './redact.mjs';

/** 按 ACP 权限应答的规范形状挑选项。 */
export function pickOption(options, want) {
  const list = Array.isArray(options) ? options : [];
  const match = list.find((o) => typeof o?.kind === 'string' && o.kind.startsWith(want));
  return match?.optionId;
}

export function approvalContext(params, toolCall, desc, options) {
  const input = toolCall.rawInput ?? toolCall.input ?? null;
  return sanitizeApprovalContext({
    tool: toolCall.name ?? desc,
    title: desc,
    tool_call_id: toolCall.toolCallId ?? null,
    kind: toolCall.kind ?? null,
    description: input?.description ?? null,
    reason: params?.reason ?? input?.justification ?? input?.reason ?? null,
    input,
    locations: toolCall.locations ?? [],
    options,
  });
}

/**
 * 把会话级配置套到 ACP 会话上。
 *
 * 两件必须知道的事：
 *   1) ACP 的 `reasoning_effort` 默认值是**空串**（Provider default），不是最大档，
 *      所以要显式设。传 'default' 即还原成空串（不设置）。
 *   2) **新进程不会记住**这些选择，因此 session/new 之后、以及每次 resume 之后都要重套一遍。
 *
 * 失败不致命：记进 applied/failed 供上层展示，避免因为某个模型不支持某一项而整个建会话失败。
 */
export async function applySessionConfig(proc, sessionId, cfg) {
  const applied = [];
  const failed = [];
  const failedKeys = [];
  const set = async (configId, value, label) => {
    if (value === undefined || value === null || value === '') return;
    try {
      // 注意方法名是 ACP 的 snake_case：session/set_config_option
      // （写成 session/setConfigOption 会得到 -32601 Method not found，且很容易被忽略）
      await proc.request('session/set_config_option', { sessionId, configId, value }, 30_000);
      applied.push(label);
    } catch (e) {
      failed.push(L(`${label} 设置失败: ${e.message}`, `${label} failed: ${e.message}`));
      failedKeys.push(configId);
    }
  };
  const effort = cfg.reasoningEffort === 'default' ? '' : cfg.reasoningEffort;
  // Selecting a model resets its dependent reasoning option in ACP. Apply effort last.
  if (cfg.provider && cfg.model) {
    await set('model', JSON.stringify([cfg.provider, cfg.model]), L(`模型=${cfg.provider}/${cfg.model}`, `model=${cfg.provider}/${cfg.model}`));
  }
  await set('reasoning_effort', effort, L(`思考深度=${effort}`, `reasoning_effort=${effort}`));
  return { applied, failed, failedKeys };
}

/**
 * 真实 DSH 的 tool_call 不带 name，工具名在 title 里（"read" / "pwsh"）。title 是纯标识符时才当名字；
 * 带空格的描述性 title（可能含命令原文）不算。
 */
export const toolNameFromTitle = (title) => (typeof title === 'string' && /^[\w.:-]{1,40}$/.test(title) ? title : null);
