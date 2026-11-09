/**
 * --remove 的影响范围：只删自己那条，别的一概不动。
 *
 * 这个断言值得单独存在，因为「卸载」是最容易造成数据丢失的操作。
 * 用户的原话是「确认删除这个 mcp 对 agent 的影响只能是 mcp 新增的部分」，
 * 这里就按这句话验：给每个客户端准备一份含多种既有条目的配置，
 * 注册再注销，逐字段比对其余部分是否原样。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeSandboxHome, removeSandbox } from './sandbox-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'bin', 'setup.mjs');

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};

function sandbox(files) {
  return makeSandboxHome('dsh-remove-', files);
}

const run = (home, args) => spawnSync(process.execPath, [SETUP, ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DSH_BIN: '/fake/dsh.js' },
});

// ── Cursor: 既有条目必须一字节不变 ──────────────────────────────────

console.log('\n[1] Cursor -- existing servers survive removal untouched');
{
  const existing = {
    mcpServers: {
      alpha: { command: 'alpha-bin', args: ['--flag', 'value with spaces'], env: { KEY: 'v' } },
      beta: { command: 'beta-bin', args: [] },
    },
  };
  const home = sandbox({ '.cursor/mcp.json': JSON.stringify(existing, null, 2) });

  run(home, ['--yes', '--only', 'cursor']);
  const withUs = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  check('both existing servers still present after add', Boolean(withUs.mcpServers.alpha && withUs.mcpServers.beta));
  check('our entry was added', Boolean(withUs.mcpServers['dsh-any-agent']));

  const r = run(home, ['--remove', '--yes', '--only', 'cursor']);
  const after = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));

  check('our entry is gone', after.mcpServers['dsh-any-agent'] === undefined);
  check('alpha is byte-identical', JSON.stringify(after.mcpServers.alpha) === JSON.stringify(existing.mcpServers.alpha));
  check('beta is byte-identical', JSON.stringify(after.mcpServers.beta) === JSON.stringify(existing.mcpServers.beta));
  check('no other keys appeared', Object.keys(after.mcpServers).sort().join(',') === 'alpha,beta', Object.keys(after.mcpServers).join(','));
  check('exit code is 0', r.status === 0, String(r.status));

  removeSandbox(home);
}

// ── Codex: 顶层设置与其他 MCP 段必须保留 ────────────────────────────

console.log('\n[2] Codex -- top-level settings and other MCP sections survive');
{
  const original = [
    'model = "gpt-5.1-codex"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[mcp_servers.node_repl]',
    'command = "cmd.exe"',
    'args = ["/d", "/s", "/c", "call ./start.cmd"]',
    'startup_timeout_sec = 20.0',
    '',
    '[mcp_servers.node_repl.env]',
    'FOO = "bar"',
    '',
    '[mcp_servers.rea]',
    'command = "rea"',
    'args = ["mcp"]',
  ].join('\n') + '\n';
  const home = sandbox({ '.codex/config.toml': original });

  run(home, ['--yes', '--only', 'codex']);
  const withUs = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('our TOML block was added', withUs.includes('[mcp_servers.dsh-any-agent]'));

  run(home, ['--remove', '--yes', '--only', 'codex']);
  const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');

  check('our blocks are gone', !after.includes('dsh-any-agent'));
  check('model survived', after.includes('model = "gpt-5.1-codex"'));
  check('approval_policy survived', after.includes('approval_policy = "never"'));
  check('sandbox_mode survived', after.includes('sandbox_mode = "danger-full-access"'));
  check('node_repl survived', after.includes('[mcp_servers.node_repl]'));
  check('node_repl.env survived', after.includes('FOO = "bar"'));
  check('rea survived', after.includes('[mcp_servers.rea]'));
  check('file is not empty', after.trim().length > 0, String(after.length));
  check('every original line still present', original.trim().split('\n').every((l) => after.includes(l)));

  removeSandbox(home);
}

// ── Codex: 我们之后的数组表、别的表里同名的键都要留（审计 B01） ─────────

console.log('\n[2b] Codex -- array tables after ours and same-named keys in other tables survive');
{
  const original = [
    'model = "o3"',
    '',
    '[mcp_servers.dsh-any-agent]',
    'command = "npx"',
    'args = ["-y", "dsh-any-agent"]',
    '',
    '[[skills]]',
    'name = "keep-me"',
    '',
    '[projects]',
    'dsh-any-agent = "trusted"',
  ].join('\n') + '\n';
  const home = sandbox({ '.codex/config.toml': original });

  const r = run(home, ['--remove', '--yes', '--only', 'codex']);
  const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');

  check('our table is gone', !after.includes('[mcp_servers.dsh-any-agent]'));
  check('array table after ours survived', after.includes('[[skills]]') && after.includes('name = "keep-me"'), after);
  check('same-named key in [projects] survived', after.includes('[projects]') && after.includes('dsh-any-agent = "trusted"'), after);
  check('exit code is 0', r.status === 0, String(r.status));

  removeSandbox(home);
}

// ── Codex: 我们表尾的注释属于用户，删除和改写都要留 ─────────────────
//   注释常写在下一张表上方（"# 浏览器工具"），按行切表时它落在我们的区间里，以前会被一起删掉。

console.log('\n[2c] Codex -- comments after our table survive removal and rewrite');
{
  const original = [
    'model = "o3"',
    '',
    '[mcp_servers.dsh-any-agent]',
    'command = "node"',
    'args = ["old.mjs"]',
    '# DSH_BIN = "C:/dsh/dsh.exe"',
    '',
    '# Browser automation - keep this note',
    '[mcp_servers.playwright]',
    'command = "npx"',
  ].join('\n') + '\n';
  const home = sandbox({ '.codex/config.toml': original });

  // 条目过时（args 不同）：--yes 会改写我们的表。
  run(home, ['--yes', '--only', 'codex']);
  const rewritten = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('rewrite: note above the next table survived',
    rewritten.includes('# Browser automation - keep this note\n[mcp_servers.playwright]'), rewritten);
  check('rewrite: commented-out line survived', rewritten.includes('# DSH_BIN = "C:/dsh/dsh.exe"'), rewritten);
  check('rewrite: our table written once', (rewritten.match(/^\[mcp_servers\.dsh-any-agent\]$/gm) || []).length === 1, rewritten);
  const again = run(home, ['--yes', '--only', 'codex']);
  check('rewrite: second --yes changes nothing',
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8') === rewritten && /0 changed/.test(again.stdout || ''),
    (again.stdout || '').split('\n').find((l) => /Summary/.test(l)) ?? '');

  const r = run(home, ['--remove', '--yes', '--only', 'codex']);
  const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('remove: our table is gone', !after.includes('[mcp_servers.dsh-any-agent'), after);
  check('remove: note above the next table survived',
    after.includes('# Browser automation - keep this note\n[mcp_servers.playwright]'), after);
  check('remove: commented-out line survived', after.includes('# DSH_BIN = "C:/dsh/dsh.exe"'), after);
  check('remove: exit code is 0', r.status === 0, String(r.status));

  removeSandbox(home);
}

// ── Codex: 多行字符串里像表头的行不是表头 ──────────────────────────────

console.log('\n[2d] Codex -- a header-looking line inside a multi-line string is text, not a table');
{
  const original = [
    '[profiles.p]',
    'note = """',
    '[mcp_servers.dsh-any-agent]',
    'text',
    '"""',
    'after = 1',
    '',
    '[features]',
    'x = true',
  ].join('\n') + '\n';
  const home = sandbox({ '.codex/config.toml': original });

  const rm = run(home, ['--remove', '--yes', '--only', 'codex']);
  check('remove: file untouched (nothing of ours there)',
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8') === original, String(rm.status));

  run(home, ['--yes', '--only', 'codex']);
  const added = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('add: the string and every line after it survived', added.startsWith(original.trimEnd()), added);
  check('add: our real table appended once', (added.match(/^\[mcp_servers\.dsh-any-agent\]$/gm) || []).length === 2, added);

  removeSandbox(home);
}

// ── Codex: 认不出、改不了的写法（点号键 / 内联表）宁可拒绝，不写坏 ───

console.log('\n[2e] Codex -- forms we cannot edit safely are refused, file untouched');
for (const [label, original] of [
  ['dotted key under [mcp_servers]', '[mcp_servers]\ndsh-any-agent.command = "node"\n'],
  ['dotted key at root', 'mcp_servers.dsh-any-agent.command = "node"\n'],
  ['inline table at root', 'mcp_servers = { dsh-any-agent = { command = "node" } }\n'],
]) {
  const home = sandbox({ '.codex/config.toml': original });
  const add = run(home, ['--yes', '--only', 'codex']);
  check(label + ': add refused (exit 1)', add.status === 1, String(add.status) + ' ' + (add.stdout || '').trim().split('\n').find((l) => /codex/i.test(l)));
  const rm = run(home, ['--remove', '--yes', '--only', 'codex']);
  check(label + ': remove refused (exit 1)', rm.status === 1, String(rm.status));
  check(label + ': file untouched', readFileSync(join(home, '.codex', 'config.toml'), 'utf8') === original);
  removeSandbox(home);
}

// ── Zed: 其他设置键与 context_servers 的其他子项都要留 ───────────────

console.log('\n[3] Zed -- unrelated settings and sibling context servers survive');
{
  const existing = {
    theme: 'One Dark',
    vim_mode: true,
    context_servers: {
      other: { command: 'other-mcp', args: [] },
    },
  };
  const home = sandbox({ 'Zed/settings.json': JSON.stringify(existing, null, 2) });

  run(home, ['--yes', '--only', 'zed']);
  run(home, ['--remove', '--yes', '--only', 'zed']);
  const after = JSON.parse(readFileSync(join(home, 'Zed', 'settings.json'), 'utf8'));

  check('theme survived', after.theme === 'One Dark');
  check('vim_mode survived', after.vim_mode === true);
  check('sibling context server survived', JSON.stringify(after.context_servers.other) === JSON.stringify(existing.context_servers.other));
  check('our entry removed', after.context_servers['dsh-any-agent'] === undefined);

  removeSandbox(home);
}

// ── 移除不存在的条目：不报错、不改文件 ───────────────────────────────

console.log('\n[4] removing something that is not there is a no-op');
{
  const original = JSON.stringify({ mcpServers: { only: { command: 'x', args: [] } } }, null, 2);
  const home = sandbox({ '.cursor/mcp.json': original });

  const r = run(home, ['--remove', '--yes', '--only', 'cursor']);
  const after = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');

  check('file unchanged', after === original);
  check('reported not present', /not present/i.test(r.stdout || ''), (r.stdout || '').split('\n').find((l) => /skipped/.test(l)) ?? '');
  check('exit code is 0', r.status === 0, String(r.status));

  removeSandbox(home);
}

console.log('\n===== removal scope: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);
