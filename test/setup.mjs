/**
 * dsh-any-agent-setup 的回归测试。
 *
 * setup 会改别人的客户端配置文件，所以它比服务端本身更需要测试：
 * 一个会误写、误删、或者 dry-run 却真的写了的 setup，比没有 setup 更糟。
 *
 * 手法：把 HOME / USERPROFILE 指向临时目录，在沙箱里跑真实的 CLI。
 * 不需要 DSH、不需要模型，可以进 CI。
 *
 * 除了「文件写对了」，还必须验证「写进去的东西真能启动」。曾经漏掉这一
 * 条：Windows 上 process.execPath 是 C:\Program Files\nodejs\node.exe，
 * 经 cmd 传给 claude CLI 时没加引号，被拆成 "C:\Program" + 一个多余参数，
 * 配置看上去完全正确，客户端却报 CONNECTION_CLOSED。文件断言全绿而功能
 * 全废 —— 所以第 9 组会把写进配置的那条命令真的执行一遍。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'bin', 'setup.mjs');
const NODE = process.execPath;

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};

/** A throwaway HOME with the client configs we want present. */
function sandbox(configs = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-setup-'));
  for (const [rel, content] of Object.entries(configs)) {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return home;
}

function runSetup(home, args = []) {
  const r = spawnSync(NODE, [SETUP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DSH_BIN: '/fake/dsh/bin.js' },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const backupsIn = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('.bak-dsh-')) : [];

// ── 1. dry-run 必须真的不写 ──────────────────────────────────────────

console.log('\n[1] dry-run writes nothing');
{
  const original = '{"mcpServers":{}}';
  const home = sandbox({ '.cursor/mcp.json': original });
  const before = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');

  const r = runSetup(home, ['--only', 'cursor']);

  const after = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');
  check('file is byte-identical after a dry run', after === before, after.slice(0, 80));
  check('no backup was created', backupsIn(join(home, '.cursor')).length === 0);
  check('it reported a preview', /would/i.test(r.out), r.out.split('\n')[0]);
  check('it said nothing was written', /nothing was written/i.test(r.out));
  check('exit code is 0', r.code === 0, String(r.code));

  rmSync(home, { recursive: true, force: true });
}

// ── 2. --yes 写入，且保留既有条目 ────────────────────────────────────

console.log('\n[2] --yes writes and preserves what was already there');
{
  const home = sandbox({
    '.cursor/mcp.json': JSON.stringify({ mcpServers: { keep: { command: 'x', args: [] } } }, null, 2),
  });
  const r = runSetup(home, ['--yes', '--only', 'cursor']);
  const cfg = readJson(join(home, '.cursor', 'mcp.json'));

  check('existing entry survived', cfg.mcpServers.keep?.command === 'x');
  check('our entry was added', Boolean(cfg.mcpServers['dsh-any-agent']));
  check('entry carries a permission env', cfg.mcpServers['dsh-any-agent']?.env?.DSH_MCP_PERMISSION === 'workspace-write');
  check('a backup was created', backupsIn(join(home, '.cursor')).length === 1);
  check('exit code is 0', r.code === 0, String(r.code));

  rmSync(home, { recursive: true, force: true });
}

// ── 3. 幂等 ──────────────────────────────────────────────────────────

console.log('\n[3] re-running is idempotent');
{
  const home = sandbox({ '.cursor/mcp.json': '{"mcpServers":{}}' });
  runSetup(home, ['--yes', '--only', 'cursor']);
  const first = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');
  const backupsAfterFirst = backupsIn(join(home, '.cursor')).length;

  const r = runSetup(home, ['--yes', '--only', 'cursor']);
  const second = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');

  check('second run changes nothing', first === second);
  check('second run added no backup', backupsIn(join(home, '.cursor')).length === backupsAfterFirst);
  check('second run reports already up to date', /already up to date/i.test(r.out), r.out.split('\n').find((l) => /skipped/.test(l)) ?? '');
  check('exit code is 0', r.code === 0, String(r.code));

  rmSync(home, { recursive: true, force: true });
}

// ── 4. --remove 只移除自己 ───────────────────────────────────────────

console.log('\n[4] --remove takes out only our entry');
{
  const home = sandbox({
    '.cursor/mcp.json': JSON.stringify({ mcpServers: { keep: { command: 'x', args: [] } } }, null, 2),
  });
  runSetup(home, ['--yes', '--only', 'cursor']);
  check('entry exists before removal', Boolean(readJson(join(home, '.cursor', 'mcp.json')).mcpServers['dsh-any-agent']));

  const r = runSetup(home, ['--remove', '--yes', '--only', 'cursor']);
  const cfg = readJson(join(home, '.cursor', 'mcp.json'));

  check('our entry is gone', cfg.mcpServers['dsh-any-agent'] === undefined);
  check('the other one is untouched', cfg.mcpServers.keep?.command === 'x');
  check('exit code is 0', r.code === 0, String(r.code));

  rmSync(home, { recursive: true, force: true });
}

// ── 5. 坏 JSON 必须拒绝，且不破坏原文件 ──────────────────────────────

console.log('\n[5] a corrupt config is refused, not rewritten');
{
  const broken = '{ "mcpServers": { this is not json }';
  const home = sandbox({ '.cursor/mcp.json': broken });
  const r = runSetup(home, ['--yes', '--only', 'cursor']);
  const after = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');

  check('reported a failure', /not valid JSON/i.test(r.out), r.out.split('\n').find((l) => /FAIL/.test(l)) ?? '');
  check('exit code is non-zero', r.code !== 0, String(r.code));
  check('the broken file was left untouched', after === broken);
  check('no backup of a file we never wrote', backupsIn(join(home, '.cursor')).length === 0);

  rmSync(home, { recursive: true, force: true });
}

// ── 6. 未安装的客户端被跳过 ──────────────────────────────────────────

console.log('\n[6] a client that is not installed is skipped');
{
  const home = sandbox({}); // 没有任何客户端配置
  const r = runSetup(home, ['--yes']);

  check('reported skipped clients', /skipped/i.test(r.out));
  check('nothing failed', /0 failed/i.test(r.out), r.out.split('\n').find((l) => /Summary/.test(l)) ?? '');
  check('exit code is 0', r.code === 0, String(r.code));

  rmSync(home, { recursive: true, force: true });
}

// ── 7. Codex 的 TOML 段 ──────────────────────────────────────────────

console.log('\n[7] Codex TOML block is written, kept idempotent, and removed');
{
  const home = sandbox({
    '.codex/config.toml': '[mcp_servers.other]\ncommand = "x"\n',
  });
  runSetup(home, ['--yes', '--only', 'codex']);
  const written = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');

  check('our block is present', written.includes('[mcp_servers.dsh-any-agent]'));
  check('the unrelated block survived', written.includes('[mcp_servers.other]'));
  check('a backup was created', backupsIn(join(home, '.codex')).length === 1);

  const r2 = runSetup(home, ['--yes', '--only', 'codex']);
  check('second run is a no-op', readFileSync(join(home, '.codex', 'config.toml'), 'utf8') === written, r2.out.split('\n').find((l) => /skipped/.test(l)) ?? '');

  runSetup(home, ['--remove', '--yes', '--only', 'codex']);
  const removed = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('block removed', !removed.includes('[mcp_servers.dsh-any-agent]'));
  check('unrelated block still there', removed.includes('[mcp_servers.other]'));

  rmSync(home, { recursive: true, force: true });
}

// ── 8. --version / --help 无副作用 ───────────────────────────────────

console.log('\n[8] --version and --help touch nothing');
{
  const home = sandbox({ '.cursor/mcp.json': '{"mcpServers":{}}' });
  const v = runSetup(home, ['--version']);
  const h = runSetup(home, ['--help']);

  check('--version prints a semver', /^\d+\.\d+\.\d+/m.test(v.out), v.out.trim());
  check('--help mentions the flags', /--yes/.test(h.out) && /--remove/.test(h.out));
  check('neither created a backup', backupsIn(join(home, '.cursor')).length === 0);
  check('the config is unchanged', readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8') === '{"mcpServers":{}}');

  rmSync(home, { recursive: true, force: true });
}

// ── 9. 写进配置的命令必须真的能启动 ──────────────────────────────────

console.log('\n[9] the command written into the config actually starts');
{
  const home = sandbox({ '.cursor/mcp.json': '{"mcpServers":{}}' });
  runSetup(home, ['--yes', '--only', 'cursor']);

  const entry = readJson(join(home, '.cursor', 'mcp.json')).mcpServers['dsh-any-agent'];
  check('entry has a command', typeof entry?.command === 'string' && entry.command.length > 0, JSON.stringify(entry?.command));
  check('entry command exists on disk', existsSync(entry.command), entry.command ?? '');
  check('entry args point at the server entry point', Array.isArray(entry.args) && entry.args.some((a) => a.endsWith('dsh-any-agent.mjs')), JSON.stringify(entry.args));

  // Spawn it exactly as a client would: the command with those args, no shell.
  // This is the check that was missing when an unquoted "C:\Program Files"
  // path produced a config that looked right and could not start.
  if (entry?.command && Array.isArray(entry.args)) {
    const child = spawnSync(entry.command, entry.args, {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'setup-test', version: '1' } } }) + '\n',
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ...entry.env, DSH_MCP_LOG: 'silent' },
    });
    const line = (child.stdout || '').split('\n').find((l) => l.includes('"serverInfo"'));
    check('it answers initialize', Boolean(line), (child.stdout || '').slice(0, 120) || (child.stderr || '').slice(0, 120));
    if (line) {
      let info = null;
      try { info = JSON.parse(line).result?.serverInfo; } catch {}
      check('serverInfo names dsh-any-agent', info?.name === 'dsh-any-agent', JSON.stringify(info));
      check('serverInfo carries a version', typeof info?.version === 'string' && /^\d+\.\d+/.test(info.version), JSON.stringify(info?.version));
    }
  }

  rmSync(home, { recursive: true, force: true });
}

console.log('\n===== setup regression: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);
