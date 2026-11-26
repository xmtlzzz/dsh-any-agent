/**
 * 受支持的 MCP 客户端注册表、路径探测与配置形状定义。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_NAME, IS_MAC, IS_WIN, readConfigFile } from './io.mjs';
import { scanJson } from './jsonc.mjs';

/** 各客户端写 MCP 配置用的容器键。 */
export const CONTAINER_KEY = {
  'claude-desktop': 'mcpServers',
  cursor: 'mcpServers',
  windsurf: 'mcpServers',
  gemini: 'mcpServers',
  antigravity: 'mcpServers',
  zed: 'context_servers',
  vscode: 'servers',
  opencode: 'mcp',
};

/** 构造各客户端的条目形状。 */
export function entryShape(shape, launch, env, shapeMode) {
  switch (shape) {
    case 'zed':
      if (shapeMode === 'flat') return { command: launch.command, args: launch.args, env };
      return { command: { path: launch.command, args: launch.args, env } };
    case 'vscode':
      return { type: 'stdio', command: launch.command, args: launch.args, env };
    case 'opencode':
      return { type: 'local', command: [launch.command, ...launch.args], enabled: true, environment: env };
    default:
      return { command: launch.command, args: launch.args, env };
  }
}

/** 从既有条目里取出可比较的形状。 */
export function describeEntry(shape, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (shape === 'opencode') {
    const cmd = Array.isArray(entry.command) ? entry.command : null;
    if (!cmd || !cmd.length) return null;
    return { command: cmd[0], args: cmd.slice(1), env: entry.environment ?? entry.env ?? {} };
  }
  if (shape === 'zed') {
    const c = entry.command;
    if (c && typeof c === 'object') return { command: c.path, args: c.args ?? [], env: c.env ?? {} };
    if (typeof c === 'string') return { command: c, args: entry.args ?? [], env: entry.env ?? {} };
    return null;
  }
  if (typeof entry.command !== 'string') return null;
  return { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], env: entry.env ?? {} };
}

/** 解析出本次要用的 home 与 appdata（--home / 环境变量 / 平台默认）。 */
export function resolveDirs(homeOverride) {
  const envHome = IS_WIN
    ? (process.env.USERPROFILE || process.env.HOME)
    : (process.env.HOME || process.env.USERPROFILE);
  const home = homeOverride ? resolve(homeOverride) : (envHome ? resolve(envHome) : homedir());
  let appData;
  if (homeOverride || !process.env.APPDATA) {
    appData = IS_WIN
      ? join(home, 'AppData', 'Roaming')
      : (IS_MAC ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  } else appData = resolve(process.env.APPDATA);
  return { home, appData };
}

function jsonClient(id, label, shape, containerKey, pathOf) {
  return { id, label, kind: 'json', shape, containerKey, pathOf };
}

/** 既有条目用的是什么写法（只对形状有多种合法写法的客户端有意义）。 */
export function existingShapeMode(client, file) {
  if (client.shape !== 'zed' || !existsSync(file)) return undefined;
  try {
    const { raw } = readConfigFile(file);
    const root = scanJson(raw);
    const cont = root.entries.find((e) => e.key === client.containerKey);
    if (!cont || cont.value.type !== 'object') return undefined;
    const ours = cont.value.entries.find((e) => e.key === ENTRY_NAME);
    if (!ours || ours.value.type !== 'object') return undefined;
    const front = raw.slice(ours.value.start, ours.value.end);
    const cmdIdx = front.indexOf('"command"');
    if (cmdIdx < 0) return undefined;
    const afterCmd = front.slice(cmdIdx + 9).trimStart();
    if (afterCmd.startsWith(':') && afterCmd.slice(1).trimStart().startsWith('"')) return 'flat';
    return 'nested';
  } catch { return undefined; }
}

export function clientList(dirs) {
  const antigravityPaths = ['config', 'antigravity'].map(dir => join(dirs.home, '.gemini', dir, 'mcp_config.json'));
  const { home, appData } = dirs;
  return [
    jsonClient('claude-code', 'Claude Code', 'vscode', 'mcpServers', () => join(home, '.claude.json')),
    jsonClient(
      'claude-desktop', 'Claude Desktop', 'default', 'mcpServers',
      () => IS_WIN || IS_MAC
        ? join(appData, 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    ),
    { id: 'codex', label: 'Codex', kind: 'toml', pathOf: () => join(home, '.codex', 'config.toml') },
    jsonClient('cursor', 'Cursor', 'default', 'mcpServers', () => join(home, '.cursor', 'mcp.json')),
    jsonClient('windsurf', 'Windsurf', 'default', 'mcpServers',
      () => join(home, '.codeium', 'windsurf', 'mcp_config.json')),
    jsonClient('zed', 'Zed', 'zed', 'context_servers',
      () => IS_WIN || IS_MAC ? join(appData, 'Zed', 'settings.json') : join(home, '.config', 'zed', 'settings.json')),
    jsonClient('gemini', 'Gemini CLI', 'default', 'mcpServers', () => join(home, '.gemini', 'settings.json')),
    {
      ...jsonClient('antigravity', 'Antigravity', 'default', 'mcpServers', () => {
        const [current, legacy] = antigravityPaths;
        return !existsSync(current) && existsSync(legacy) ? legacy : current;
      }),
      backupTargets: antigravityPaths,
      detectPaths: [join(home, '.gemini', 'antigravity'), join(home, '.gemini', 'antigravity-cli')],
    },
    jsonClient('opencode', 'opencode', 'opencode', 'mcp', () => join(home, '.config', 'opencode', 'opencode.json')),
    jsonClient('vscode', 'VS Code', 'vscode', 'servers',
      () => IS_WIN || IS_MAC
        ? join(appData, 'Code', 'User', 'mcp.json')
        : join(home, '.config', 'Code', 'User', 'mcp.json')),
  ];
}

export function isPresent(client, dirs) {
  return existsSync(client.pathOf(dirs)) || (client.detectPaths ?? []).some((p) => existsSync(p));
}

export function defaultLaunch() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, '..', '..', 'bin', 'dsh-any-agent.mjs');
  if (existsSync(sibling)) return { command: process.execPath, args: [sibling], style: 'node + sibling entry' };
  return { command: ENTRY_NAME, args: [], style: 'PATH command' };
}

export function codexBlock(launch, env) {
  return [
    '[mcp_servers.' + ENTRY_NAME + ']',
    'command = ' + JSON.stringify(launch.command),
    'args = ' + JSON.stringify(launch.args),
    'startup_timeout_sec = 20.0',
    'tool_timeout_sec = 120.0',
    '',
    '[mcp_servers.' + ENTRY_NAME + '.env]',
    ...Object.keys(env).map((k) => k + ' = ' + JSON.stringify(env[k])),
  ].join('\n');
}

/** 期望写入的最小环境变量集合：不塞密钥，也不继承整份环境。 */
export function desiredEnv(permission, extra = {}) {
  const env = { DSH_MCP_PERMISSION: permission ?? 'workspace-write', DSH_MCP_LOG: 'silent' };
  if (process.env.DSH_BIN) env.DSH_BIN = process.env.DSH_BIN;
  return { ...env, ...extra };
}
