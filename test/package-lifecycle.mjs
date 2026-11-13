/** Exercise the installed tarball over stdio. --upgrade starts on npm 0.7.2; --real uses the configured provider. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpClient } from './mcp-client.mjs';
import { cleanupSuite } from './residue.mjs';
import { resolveDsh } from '../src/dsh-locate.mjs';

const real = process.argv.includes('--real');
const upgrade = process.argv.includes('--upgrade');
const baseline = '0.7.2';
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

function pack(destination, ...specs) {
  const [{ filename }] = JSON.parse(npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', destination, ...specs]));
  return join(destination, filename);
}

function installTarball(tarball) {
  npmRun(['install', '--prefix', install, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball]);
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
  const runtime = real ? resolveDsh() : null;
  mkdirSync(project);
  mkdirSync(second);
  const candidate = pack(root);
  if (upgrade) {
    const published = join(root, 'published');
    mkdirSync(published);
    installTarball(pack(published, `dsh-any-agent@${baseline}`));
  } else {
    installTarball(candidate);
  }
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
  const initial = await first.initialize();
  if (upgrade) assert.equal(initial.serverInfo.version, baseline);
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

  if (upgrade) {
    // Check that this really is a legacy result, then replace the installed package in place.
    const saved = JSON.parse(readFileSync(finished.result.sentinel_file, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'started_at'), false);
    installTarball(candidate);
  }
  const reopened = connect();
  await reopened.initialize();
  const readBack = (await reopened.callTool('dsh_get', args)).structuredContent?.run;
  assert.equal(readBack?.run_id, finished.run_id);
  assert.equal(readBack.status, finished.status);
  assert.equal(readBack.source, 'sentinel');
  assert.equal(readBack.result.answer, finished.result.answer);
  assert.equal(readBack.result.stop_reason, finished.result.stop_reason);
  const latest = (await reopened.callTool('dsh_get', { conversation_id: conversationId })).structuredContent?.run;
  assert.equal(latest?.run_id, finished.run_id);
  assert.equal(latest.result.answer, finished.result.answer);
  const replay = (await reopened.callTool('dsh_send', { ...args, prompt: 'This retry must not run.', wait: true })).structuredContent;
  assert.equal(replay?.replayed, true);
  assert.equal(replay.run_id, finished.run_id);
  assert.equal(replay.answer, finished.result.answer);

  if (upgrade) {
    const continued = await reopened.callTool('dsh_send', {
      conversation_id: conversationId,
      client_run_id: 'after-upgrade',
      prompt: 'Reply with exactly PACKAGED_UPGRADE_OK. Do not use tools.',
      wait: true,
    });
    const result = continued.structuredContent;
    assert.ok(result, McpClient.text(continued));
    assert.equal(result.conversation_id, conversationId);
    assert.notEqual(result.run_id, finished.run_id);
    assert.equal(result.stop_reason, 'end_turn', result.error);
    assert.match(result.answer, real ? /PACKAGED_UPGRADE_OK/ : /fake answer/);
    const saved = JSON.parse(readFileSync(result.sentinel_file, 'utf8'));
    assert.ok(Number.isFinite(saved.started_at));
    await reopened.close();
    const reconnected = connect();
    await reconnected.initialize();
    const current = (await reconnected.callTool('dsh_get', { conversation_id: conversationId })).structuredContent?.run;
    assert.equal(current?.run_id, result.run_id);
    assert.equal(current.source, 'sentinel');
    assert.equal(current.result.answer, result.answer);

    if (!real) {
      const methods = readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line).method);
      // The second prompt must use ACP resume. Replaying the original key must not send a prompt.
      assert.deepEqual(methods.filter((method) => ['session/new', 'session/resume', 'session/prompt'].includes(method)), [
        'session/new', 'session/prompt', 'session/resume', 'session/prompt',
      ]);
    }
  }
  const backend = runtime ? `DSH ${runtime.version ?? 'unknown version'} via ${runtime.source}, real provider` : 'simulated ACP';
  const scenario = upgrade ? `upgrade from npm ${baseline}` : 'lifecycle';
  console.log(`Packaged MCP ${scenario} passed (${backend}; ${process.platform}, Node ${process.versions.node}).`);
} finally {
  for (const client of clients) await client.close();
  if (real) cleanupSuite({ clients, roots: [root] });
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
