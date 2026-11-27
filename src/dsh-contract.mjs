import { opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DSH_PKG_PARTS = Object.freeze(['@deepseek-ai', 'dsh']);
export const DSH_ASAR_ROOT = Object.freeze(['dsh', 'node_modules', ...DSH_PKG_PARTS]);
export const DSH_SESSION_LOG_VERSION = 4;
export const DSH_SESSION_LOG_FILE = 'session.v' + DSH_SESSION_LOG_VERSION + '.jsonl.zstd';
export const DSH_SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/;
export const DSH_WORKSPACE_REL = Object.freeze(['storages', 'workspace.json']);
export const DSH_WORKSPACE_SCHEMA_VERSION = 2;
export const DSH_PROJCACHE_REL = Object.freeze(['storages', 'session_projcache', 'sessions']);
export const DSH_PROJCACHE_ROWS = Object.freeze({
  title: 'title', model: 'modelSelection', metadata: 'sessionListMetadata', usage: 'tokenUsage',
  pressure: 'contextPressure', sandbox: 'sandboxMode', permissions: 'permissions', stats: 'sessionStats',
});
export const DSH_PROFILE_NAMES = Object.freeze({
  managed: 'dsh-mcp', team: 'dsh-team', sources: Object.freeze(['__home__', 'desktop', 'web', 'headless', 'acp']),
});
export const DSH_PROFILE_IDS = Object.freeze({
  agentTeam: 'agent-team',
  toolAgentTeam: 'tool-agent-team',
  providers: 'llm-pi-ai',
  defaultModel: 'agent-default-model',
  deepseek: 'llm-deepseek',
  acp: 'acp',
  permission: 'permission',
  subagentControl: 'tool-subagent-control',
  subagentList: 'tool-subagent-list-agents',
  subagent: 'tool-subagent',
  subagentFork: 'tool-subagent-fork',
});
export const DSH_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']);

// Limit directory entries read as well as the number of session directories opened.
function* sampleEntries(path) {
  let dir;
  try {
    dir = opendirSync(path);
    for (let n = 0; n < 32; n++) {
      const entry = dir.readSync();
      if (!entry) break;
      yield entry;
    }
  } catch { /* Missing or inaccessible directories provide no version evidence. */ }
  finally { dir?.closeSync(); }
}

/** Read version metadata and filenames only. Never open a session log. */
export function inspectDshStorageLayout(dshHome) {
  let workspaceVersion = null;
  let drift = false;
  try {
    workspaceVersion = JSON.parse(readFileSync(join(dshHome, ...DSH_WORKSPACE_REL), 'utf8'))?.unit?.version ?? null;
    drift = workspaceVersion !== DSH_WORKSPACE_SCHEMA_VERSION;
  } catch (error) {
    drift = error instanceof SyntaxError;
  }
  const versions = new Set();
  const sessions = join(dshHome, 'sessions');
  let sampled = 0;
  buckets: for (const bucket of sampleEntries(sessions)) {
    if (!bucket.isDirectory()) continue;
    const path = join(sessions, bucket.name);
    for (const session of sampleEntries(path)) {
      if (!session.isDirectory()) continue;
      for (const file of sampleEntries(join(path, session.name))) {
        const match = file.isFile() && DSH_SESSION_LOG_PATTERN.exec(file.name);
        if (match) versions.add(Number(match[1]));
      }
      if (++sampled === 32) break buckets;
    }
  }
  const sessionVersions = [...versions].sort((a, b) => a - b);
  drift ||= sessionVersions.some((v) => v > DSH_SESSION_LOG_VERSION);
  return {
    status: drift ? 'warn' : 'ok',
    detailZh: '工作区格式：' + (workspaceVersion ?? '未知') + '，抽样会话格式：' + (sessionVersions.join(', ') || '未发现'),
    detailEn: 'Workspace schema ' + (workspaceVersion ?? 'unknown') + ', sampled session versions ' + (sessionVersions.join(', ') || 'none'),
    fixZh: drift ? '检查 DSH 版本和兼容性矩阵，再使用会话恢复或工作区登记。' : null,
    fixEn: drift ? 'Check the DSH version and compatibility matrix before resuming sessions or registering workspaces.' : null,
    workspaceVersion, sessionVersions,
  };
}
