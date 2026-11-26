/**
 * live 事件流的读取、归并与终端渲染：`dsh-any-agent watch` 与 `dashboard` 共用。
 *
 * 门面入口：拆分为 `src/live-view/{state,tail,render}.mjs`，对外导出保持不变。
 */

export { detectLang } from './lang.mjs';
export {
  LiveState,
  cacheHitRate,
  fmtTokens,
  isTerminalTool,
  parseEvent,
  pidAlive,
  splitLines,
  sumTokens,
  tokenInputTotal,
  writerPid,
} from './live-view/state.mjs';
export { LiveTail } from './live-view/tail.mjs';
export {
  TEXT,
  charWidth,
  clipLine,
  diffFrame,
  displayWidth,
  layoutFrame,
  relToCwd,
  renderText,
} from './live-view/render.mjs';
