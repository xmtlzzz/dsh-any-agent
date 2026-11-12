/** Exercise the installed npm tarball over stdio. --real uses the configured DSH provider. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpClient } from './mcp-client.mjs';
import { cleanupSuite } from './residue.mjs';

const real = process.argv.includes('--real');
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this suite with npm run test:packed');
const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-package-lifecycle-'));
const install = join(root, 'consumer');
const project = join(root, 'workspace');
const second = join(root, 'other-workspace');
const clients = [];

function npmRun(args) {
  const result = spawnSync(process.execPath, [npm, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

async function until(check, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(80);
  }
  throw new Error('Timed out waiting for a packaged MCP turn');
}

const env = {
  DSH_MCP_STATE: join(root, 'state', 'conversations.json'),
  DSH_MCP_LIVE_DIR: join(root, 'live'),
  DSH_MCP_UPDATE_CHECK: '0',
  DSH_MCP_PERMISSION: 'workspace-write',
  DSH_MCP_APPROVAL: 'auto-deny',
  DSH_MCP_ALLOW_FULL_ACCESS: '0',
  DSH_MCP_GIT_STATUS: '0',
  DSH_MCP_TEAM: '0',
  DSH_MCP_DAEMON: '0',
  DSH_MCP_LOG: 'silent',
  DSH_MCP_LANG: 'en',
  ...(real ? {} : {
    DSH_HOME: join(root, 'dsh-home'),
    DSH_BIN: fileURLToPath(new URL('./fake-acp.mjs', import.meta.url)),
    DSH_RUNTIME: process.execPath,
    FAKE_ACP_DIR: root,
    FAKE_ACP_PROMPT_MS: '1600',
  }),
};
let roots = [project, second];
const entry = join(install, 'node_modules', 'dsh-any-agent', 'bin', 'dsh-any-agent.mjs');
function connect() {
  const client = new McpClient({ entry, env, roots: () => roots.map((path) => ({ uri: pathToFileURL(path).href })) }).start();
  clients.push(client);
  return client;
}

try {
  mkdirSync(project);
  mkdirSync(second);
  const [{ filename }] = JSON.parse(npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', root]));
  npmRun(['install', '--prefix', install, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(root, filename)]);
  const first = connect();
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  const discover = await first.request('server/discover', { _meta });
  assert.ok(discover.supportedVersions.includes('2026-07-28'));
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'dsh-any-agent');
  const modernList = await first.request('tools/list', { _meta });
  assert.equal(modernList.resultType, 'complete');
  assert.ok(modernList.tools.find((tool) => tool.name === 'dsh_send')?.outputSchema);
  const modernStart = await first.request('tools/call', { _meta, name: 'dsh_start', arguments: {} });
  assert.match(McpClient.text(modernStart), /Pass cwd explicitly/);
  const legacy = await first.request('initialize', { protocolVersion: '1900-01-01' });
  assert.equal(legacy.protocolVersion, '2025-11-25');
  await first.initialize();
  assert.equal((await first.callTool('dsh_start', {})).isError, true);
  roots = [project];
  first.notify('notifications/roots/list_changed');
  const start = await first.callTool('dsh_start', {});
  const conversationId = start.structuredContent?.conversation_id;
  assert.ok(conversationId, McpClient.text(start));
  assert.equal(start.structuredContent.cwd, project);
  assert.equal(start.structuredContent.on_approval, 'auto-deny');
  await assert.rejects(first.callTool('constructor', {}), { code: -32602 });
  const invalid = await first.callTool('dsh_send', { conversation_id: conversationId, prompt: 'invalid', wait: 'true' });
  assert.equal(invalid.isError, true);
  assert.equal((await first.callTool('dsh_get', { conversation_id: conversationId })).structuredContent.run, null);

  const key = 'package-lifecycle';
  const controller = new AbortController();
  const wait = first.callTool('dsh_send', {
    conversation_id: conversationId, prompt: 'Reply with exactly PACKAGED_MCP_OK. Do not use tools.', client_run_id: key, wait: true,
  }, 120_000, { signal: controller.signal });
  void wait.catch(() => {});
  await until(async () => {
    const state = await first.callTool('dsh_status', { conversation_id: conversationId });
    return state.structuredContent?.busy || state.structuredContent?.run?.status === 'done';
  }, 10_000);
  controller.abort();
  await wait.catch((error) => assert.equal(error.name, 'AbortError'));
  const args = { conversation_id: conversationId, client_run_id: key };
  const finished = await until(async () => {
    const response = await first.callTool('dsh_get', args);
    const run = response.structuredContent?.run;
    return run?.result && run;
  });
  assert.equal(finished.status, 'done', finished.result.error ?? finished.result.stop_reason);
  assert.match(finished.result.answer, real ? /PACKAGED_MCP_OK/ : /fake answer/);
  await first.close();

  const reopened = connect();
  await reopened.initialize();
  const readBack = (await reopened.callTool('dsh_get', args)).structuredContent?.run;
  assert.equal(readBack?.run_id, finished.run_id);
  const replay = (await reopened.callTool('dsh_send', { ...args, prompt: 'This retry must not run.' })).structuredContent;
  assert.equal(replay?.replayed, true);
  assert.equal(replay.run_id, finished.run_id);
  console.log(`Packaged MCP lifecycle passed (${real ? 'real DSH and provider' : 'simulated ACP'}).`);
} finally {
  for (const client of clients) await client.close();
  if (real) cleanupSuite({ clients, roots: [root] });
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
