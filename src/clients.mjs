/**
 * 客户端 MCP 配置写入引擎门面（具体实现按职责拆在 ./clients/*，对外导出路径不变）。
 */

export {
  ENTRY_NAME,
  IS_MAC,
  IS_WIN,
  atomicWrite,
  backupFile,
  backupSuffix,
  isWritable,
  pruneBackups,
  readConfigFile,
} from './clients/io.mjs';
export {
  detectEol,
  detectIndentUnit,
  editJsonEntry,
  renderValue,
  scanJson,
  stripWs,
} from './clients/jsonc.mjs';
export { editTomlBlock } from './clients/toml.mjs';
export {
  CONTAINER_KEY,
  clientList,
  codexBlock,
  defaultLaunch,
  describeEntry,
  desiredEnv,
  entryShape,
  existingShapeMode,
  isPresent,
  resolveDirs,
} from './clients/registry.mjs';
export { applyClient, planClient } from './clients/plan.mjs';
