/**
 * 把 MCP 创建的会话登记进 DSH 的工作区注册表，并提供磁盘会话头扫描与测试清理护栏。
 *
 * 门面入口：拆分为 `src/workspace/{paths,sessions,store,purge}.mjs`，对外导出保持不变。
 */

export {
  PROJCACHE_DIR,
  SESSIONS_ROOT,
  WORKSPACE_FILE,
  canonicalPath,
  isTempPath,
  isTestDesktopPath,
  isTestScratchPath,
  isTestSessionCwd,
  isTestTempPath,
  shouldRegister,
} from './workspace/paths.mjs';
export {
  findSessionHeader,
  findSessionHeaderStatus,
  readHeaderAsync,
  scanSessions,
} from './workspace/sessions.mjs';
export {
  backfillWorkspaces,
  listWorkspaces,
  missingRegisteredSessions,
  pruneEmptyWorkspaces,
  pruneTempWorkspaces,
  pruneTestWorkspaces,
  registerWorkspace,
  unregisterSessions,
} from './workspace/store.mjs';
export {
  purgeOrphanProjcache,
  purgeTestSessions,
} from './workspace/purge.mjs';
