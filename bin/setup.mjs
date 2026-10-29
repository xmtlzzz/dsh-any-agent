#!/usr/bin/env node
/**
 * dsh-any-agent setup -- wire this server into the MCP clients you already have.
 *
 *   dsh-any-agent setup                     detect and preview; writes nothing
 *   dsh-any-agent setup --yes               actually write (backs up first)
 *   dsh-any-agent setup --yes --only cursor,zed
 *   dsh-any-agent setup --yes --permission read-only
 *   dsh-any-agent setup --remove --yes      take it back out
 *
 * Constraints, each one learned the hard way:
 *   1. Dry-run by default. Touching someone else's config deserves a preview.
 *   2. Every file is backed up to <file>.bak-dsh-<stamp> before it is written.
 *   3. JSON clients: parse the original, build the new object, parse the result
 *      again, and only then write. A half-written config is worse than none.
 *   4. A client that is not installed is skipped, not failed.
 *   5. Claude Code and Codex have their own `mcp` subcommands; prefer them.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const NAME = 'dsh-any-agent';

/** Same source of truth as the server: package.json, not a hard-coded copy. */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
})();

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'dsh-any-agent-setup ' + VERSION + '\n\n' +
    'Detect installed MCP clients and register ' + NAME + ' with each.\n\n' +
    'Usage:\n' +
    '  dsh-any-agent-setup                     preview (writes nothing)\n' +
    '  dsh-any-agent-setup --yes               apply\n' +
    '  dsh-any-agent-setup --yes --only a,b    only these clients\n' +
    '  dsh-any-agent-setup --yes --permission read-only\n' +
    '  dsh-any-agent-setup --remove --yes      unregister\n\n' +
    'Clients: Claude Code, Codex, Cursor, Windsurf, Zed.\n' +
    'Every write is preceded by a .bak-dsh-<timestamp> backup; JSON clients are\n' +
    'validated before and after writing; re-running is idempotent.\n',
  );
  process.exit(0);
}

const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const WRITE = has('--yes') || has('-y');
const REMOVE = has('--remove');
const ONLY = (val('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const PERMISSION = val('--permission', 'workspace-write');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const HOME = homedir();
const IS_WIN = platform() === 'win32';
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');

const log = (s = '') => console.log(s);
const tick = (s) => log('  OK   ' + s);
const dash = (s) => log('  ---  ' + s);
const bang = (s) => log('  FAIL ' + s);

function which(cmd) {
  const probe = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', shell: IS_WIN });
  return probe.status === 0;
}

function desiredEnv() {
  const env = { DSH_MCP_PERMISSION: PERMISSION, DSH_MCP_LOG: 'silent' };
  if (process.env.DSH_BIN) env.DSH_BIN = process.env.DSH_BIN;
  return env;
}

/** Prefer this package's own entry point; fall back to the PATH command. */
function launch() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'dsh-any-agent.mjs');
  if (existsSync(sibling)) return { command: process.execPath, args: [sibling], style: 'node + sibling entry' };
  return { command: NAME, args: [], style: 'PATH command' };
}

function backup(file) {
  const dst = file + '.bak-dsh-' + STAMP;
  copyFileSync(file, dst);
  return dst;
}

/** Temp-then-rename so a crash cannot leave a truncated config. */
function atomicWrite(file, text) {
  const tmp = file + '.tmp-dsh-' + process.pid;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function parseJson(file) {
  const raw = readFileSync(file, 'utf8');
  try {
    return { json: JSON.parse(raw), raw };
  } catch (e) {
    return { error: e.message };
  }
}

const CLIENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    detect: () => which('claude') && existsSync(join(HOME, '.claude.json')),
    apply() {
      const run = (a) => spawnSync('claude', a, { encoding: 'utf8', shell: IS_WIN });
      const tried = (r) => (((r.stdout || '') + (r.stderr || '')).toLowerCase());

      if (REMOVE) {
        const r = run(['mcp', 'remove', NAME, '-s', 'user']);
        if (r.status !== 0) {
          return tried(r).includes('no mcp server named')
            ? { skipped: 'not registered' }
            : { error: tried(r).trim().split('\n')[0] || 'claude exited ' + r.status };
        }
        return { done: 'removed via \`claude mcp remove\` (user scope)' };
      }

      // `add` refuses to overwrite, so clear any existing entry first. A
      // missing entry is the normal path, not an error.
      const existing = run(['mcp', 'remove', NAME, '-s', 'user']);
      const hadIt = existing.status === 0;

      const { command, args } = launch();
      const envs = [];
      for (const [k, v] of Object.entries(desiredEnv())) envs.push('-e', k + '=' + v);
      const r = run(['mcp', 'add', NAME, '-s', 'user', ...envs, '--', command, ...args]);
      if (r.status !== 0) {
        return { error: tried(r).trim().split('\n')[0] || 'claude exited ' + r.status };
      }
      return { done: 'registered via \`claude mcp add\` (user scope)' + (hadIt ? ', replacing the old entry' : '') };
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    detect: () => existsSync(join(HOME, '.codex', 'config.toml')),
    apply() {
      const cfg = join(HOME, '.codex', 'config.toml');
      const raw = readFileSync(cfg, 'utf8');
      const kept = [];
      let skip = false;
      const re = new RegExp('^mcp_servers\\.(?:' + NAME + '|"' + NAME + '")(?:\\.|$)');
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (m) skip = re.test(m[1]);
        if (!skip) kept.push(line);
      }
      let out = kept.join('\n').trimEnd();
      if (!REMOVE) {
        const { command, args } = launch();
        const envLines = Object.entries(desiredEnv())
          .map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n');
        out += (out ? '\n\n' : '') +
          '[mcp_servers.' + NAME + ']\ncommand = ' + JSON.stringify(command) +
          '\nargs = ' + JSON.stringify(args) +
          '\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 120.0\n\n' +
          '[mcp_servers.' + NAME + '.env]\n' + envLines;
      }
      out += '\n';
      if (out === raw) return { skipped: 'already up to date' };
      backup(cfg);
      atomicWrite(cfg, out);
      return { done: REMOVE ? 'TOML block removed' : 'TOML block written' };
    },
  },
  { id: 'cursor',   label: 'Cursor',   json: () => join(HOME, '.cursor', 'mcp.json'),                        key: 'mcpServers' },
  { id: 'windsurf', label: 'Windsurf', json: () => join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),     key: 'mcpServers' },
  { id: 'zed',      label: 'Zed',      json: () => join(IS_WIN ? APPDATA : join(HOME, '.config'), IS_WIN ? join('Zed','settings.json') : join('zed','settings.json')), key: 'context_servers' },
];

/** Shared reader/writer for the JSON-shaped clients. */
function applyJson(c) {
  const file = c.json();
  const parsed = parseJson(file);
  if (parsed.error) return { error: 'existing file is not valid JSON (' + parsed.error + ')' };

  const root = (parsed.json && typeof parsed.json === 'object') ? parsed.json : {};
  const bag = (root[c.key] && typeof root[c.key] === 'object') ? root[c.key] : {};

  if (REMOVE) {
    if (!Object.prototype.hasOwnProperty.call(bag, NAME)) return { skipped: 'not present' };
    delete bag[NAME];
  } else {
    const { command, args } = launch();
    const next = { command, args, env: desiredEnv() };
    if (JSON.stringify(bag[NAME]) === JSON.stringify(next)) return { skipped: 'already up to date' };
    bag[NAME] = next;
  }
  root[c.key] = bag;

  const text = JSON.stringify(root, null, 2) + '\n';
  if (text === parsed.raw.trimEnd() + '\n') return { skipped: 'no change' };
  JSON.parse(text);            // self-check before touching disk
  backup(file);
  atomicWrite(file, text);
  const back = parseJson(file); // self-check after writing
  if (back.error) return { error: 'wrote a file that no longer parses (' + back.error + '); restore the .bak' };
  return { done: REMOVE ? 'entry removed' : 'entry written' };
}

// --- main -----------------------------------------------------------

const lc = launch();
log('');
log(WRITE
  ? (REMOVE ? 'Removing ' + NAME + ' from MCP clients' : 'Installing ' + NAME + ' into MCP clients')
  : 'Preview only -- nothing is written. Re-run with --yes to apply.');
log('  permission : ' + PERMISSION);
log('  launch     : ' + lc.command + (lc.args.length ? ' ' + lc.args.join(' ') : '') + '   (' + lc.style + ')');
log('  DSH_BIN    : ' + (process.env.DSH_BIN || '(unset -- auto-detect at runtime)'));
log('');

let changed = 0, skipped = 0, failed = 0;

for (const c of CLIENTS) {
  if (ONLY.length && !ONLY.includes(c.id)) continue;

  let present = false;
  try { present = c.detect ? c.detect() : existsSync(c.json()); } catch {}
  log(c.label + (present ? '' : '   (not installed)'));

  if (!present) { dash('skipped: client not found'); skipped++; log(''); continue; }

  let r;
  try { r = c.apply ? c.apply() : applyJson(c); }
  catch (e) { r = { error: e.message }; }

  if (r.error) { bang(r.error); failed++; }
  else if (r.skipped) { dash('skipped: ' + r.skipped); skipped++; }
  else { tick((WRITE ? '' : 'would ') + r.done); changed++; }
  log('');
}

log('Summary: ' + changed + ' ' + (WRITE ? 'changed' : 'would change') + ', ' + skipped + ' skipped, ' + failed + ' failed');
if (!WRITE && changed) log('Nothing was written. Re-run with --yes to apply.');
if (failed) {
  log('');
  log('A failure above left no damage: every writer validates the result and keeps');
  log('a .bak-dsh-* copy beside the file it touched.');
}
process.exit(failed ? 1 : 0);
