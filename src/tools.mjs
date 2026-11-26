/**
 * MCP 工具处理器装配入口（按职责拆在 ./tools/*，对外导出路径保持不变）。
 */

import { createApprovalHandlers } from './tools/approval.mjs';
import { createDispatchHandlers } from './tools/dispatch.mjs';
import { createInspectHandlers } from './tools/inspect.mjs';
import { createSessionHandlers } from './tools/session.mjs';

export { TOOL_DEFS } from './tool-defs.mjs';
export { compactResultForBudget, psReadCommand, psWaitCommand } from './tool-render.mjs';

/**
 * 组合 15 个 MCP 工具处理器。
 * @param {object} hub
 * @param {{projectDir?: () => Promise<string|null>}} [opts]
 */
export function createHandlers(hub, opts = {}) {
  const projectDir = typeof opts.projectDir === 'function' ? opts.projectDir : null;
  return {
    ...createSessionHandlers(hub, { projectDir }),
    ...createDispatchHandlers(hub),
    ...createInspectHandlers(hub),
    ...createApprovalHandlers(hub),
  };
}
