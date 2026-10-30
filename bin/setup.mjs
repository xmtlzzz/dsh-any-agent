#!/usr/bin/env node
/**
 * dsh-any-agent setup -- 把本服务注册进你已有的 MCP 客户端。
 *
 *   dsh-any-agent-setup                       检测并预览；一个字节都不写
 *   dsh-any-agent-setup --yes                 真正写入（先备份）
 *   dsh-any-agent-setup --yes --only cursor,zed
 *   dsh-any-agent-setup --yes --permission read-only
 *   dsh-any-agent-setup --json                机器可读的计划
 *   dsh-any-agent-setup --remove --yes        只把自己那一条摘掉
 *
 * 这个脚本会改别人的配置文件，所以下面每一条约束都是硬要求：
 *
 *   1) 默认只预览。动别人的配置，先看清要动什么。
 *   2) 每次写入前留 <file>.bak-dsh-<stamp>；内容等于写入前的原始字节。
 *   3) JSON 客户端做文本级定点编辑：只替换/插入/删除我们那一个条目所占的
 *      字符区间。缩进、键顺序、行尾、BOM、有无末尾换行全部原样保留。
 *      曾经的做法是 JSON.parse 再 JSON.stringify(...,2) 整份重写，
 *      值虽然对，但会把用户手写的格式全部重排掉。
 *   4) 删掉最后一条时若容器变空，连容器一起收掉，好让「装一次再卸掉」
 *      能把文件还原成安装前的样子。
 *   5) 只读文件、坏 JSON、非对象容器：拒绝并保持原文件不动，绝不写半截。
 *   6) 计划模式不启动任何会立刻写盘的东西；Claude Code 的预览只做只读探测。
 *   7) --json 时 stdout 只有一个 JSON 对象，人类日志全部走 stderr。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENTRY_NAME,
  applyClient,
  clientList,
  defaultLaunch,
  desiredEnv,
  isPresent,
  planClient,
  resolveDirs,
} from '../src/clients.mjs';

/** 版本号以 package.json 为准，避免 npm version 之后这里变旧。 */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
})();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (has('--version') || has('-v')) {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

const JSON_OUT = has('--json');

if (has('--help') || has('-h')) {
  const ids = clientList(resolveDirs()).map((c) => c.id).join(', ');
  process.stdout.write(
    'dsh-any-agent-setup ' + VERSION + '\n\n' +
    'Detect installed MCP clients and register ' + ENTRY_NAME + ' with each.\n\n' +
    'Usage:\n' +
    '  dsh-any-agent-setup                     preview (writes nothing)\n' +
    '  dsh-any-agent-setup --yes               apply\n' +
    '  dsh-any-agent-setup --yes --only a,b    only these clients\n' +
    '  dsh-any-agent-setup --yes --permission read-only\n' +
    '  dsh-any-agent-setup --remove --yes      unregister\n' +
    '  dsh-any-agent-setup --json              machine-readable result on stdout\n' +
    '  dsh-any-agent-setup --home <dir>        use another home (sandbox/testing)\n' +
    '  dsh-any-agent-setup --force             create configs even if the client\n' +
    '                                          is not detected; replace an entry\n' +
    '                                          whose shape we do not recognise\n\n' +
    'Clients: ' + ids + '\n\n' +
    'Scope of the change -- this is the whole promise:\n' +
    '  * exactly one entry per client, named "' + ENTRY_NAME + '";\n' +
    '  * --remove takes out exactly that entry, nothing else;\n' +
    '  * your other MCP servers, top-level settings, comments and indentation\n' +
    '    are never rewritten -- JSON configs are edited in place as text, so\n' +
    '    2-space, 4-space, tab, single-line, CRLF and BOM all survive;\n' +
    '  * Claude Code is edited the same way as the rest: ~/.claude.json is\n' +
    '    scanned by character range and only our own entry is touched -- that\n' +
    '    file holds hundreds of project entries and duplicate keys differing\n' +
    '    only in case, so it is never re-serialised from a parsed object;\n' +
    '  * every write is preceded by <file>.bak-dsh-<timestamp>.\n\n' +
    'The path recorded in each client is absolute. If you move or delete this\n' +
    'installation those clients report CONNECTION_CLOSED until setup is re-run\n' +
    'from the new location (or --remove to clean up).\n',
  );
  process.exit(0);
}
// ── 参数 ───────────────────────────────────────────────────────────

const WRITE = (has('--yes') || has('-y')) && !has('--dry-run') && !has('--preview');
const REMOVE = has('--remove');
const ONLY = (val('--only', '') || val('--clients', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const PERMISSION = val('--permission', 'workspace-write');
const HOME_OVERRIDE = val('--home');
const FORCE = has('--force');
const ALL = has('--all');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

/** 人类可读的日志：--json 时一律走 stderr，别污染 stdout 里的那个对象。 */
const log = (s = '') => {
  if (JSON_OUT) process.stderr.write(s + '\n');
  else process.stdout.write(s + '\n');
};
const tick = (s) => log('  OK   ' + s);
const dash = (s) => log('  ---  ' + s);
const bang = (s) => log('  FAIL ' + s);

// ── 主流程 ─────────────────────────────────────────────────────────

const dirs = resolveDirs(HOME_OVERRIDE);
const clients = clientList(dirs);
const byId = new Map(clients.map((c) => [c.id, c]));

const unknown = ONLY.filter((id) => !byId.has(id));
if (unknown.length) {
  const msg = 'unknown client id(s): ' + unknown.join(', ') + ' (known: ' + clients.map((c) => c.id).join(', ') + ')';
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: false, mode: 'error', error: msg, clients: [], changed: 0, skipped: 0, failed: unknown.length,
    }) + '\n');
  } else {
    bang(msg);
  }
  process.exit(2);
}

const launch = defaultLaunch();
const env = desiredEnv(PERMISSION);
const ctx = { dirs, remove: REMOVE, write: WRITE, launch, env, byId };

if (!JSON_OUT) {
  log('');
  log(WRITE
    ? (REMOVE ? 'Removing ' + ENTRY_NAME + ' from MCP clients' : 'Installing ' + ENTRY_NAME + ' into MCP clients')
    : 'Preview only -- nothing is written. Re-run with --yes to apply.');
  log('  home       : ' + dirs.home);
  log('  permission : ' + PERMISSION);
  log('  launch     : ' + launch.command + (launch.args.length ? ' ' + launch.args.join(' ') : '') + '   (' + launch.style + ')');
  log('  DSH_BIN    : ' + (process.env.DSH_BIN || '(unset -- auto-detect at runtime)'));
  log('');
}

const results = [];
let changed = 0;
let skipped = 0;
let failed = 0;

for (const client of clients) {
  // --json 时仍把每个客户端都报出来，只是标成 filtered：
  // 调用方拿到的永远是一份完整的清单，而不是「这次碰巧选中的那几个」。
  if (ONLY.length && !ONLY.includes(client.id)) {
    if (JSON_OUT) {
      results.push({
        id: client.id, label: client.label, path: client.pathOf(dirs),
        status: 'filtered', summary: 'not selected by --only', changed: false,
      });
    }
    continue;
  }

  let present = false;
  try { present = isPresent(client, dirs); } catch { present = false; }
  if (!JSON_OUT) log(client.label + (present ? '' : '   (not detected)'));

  if (!present && !(FORCE || ALL)) {
    if (!JSON_OUT) { dash('skipped: client not found'); log(''); }
    results.push({
      id: client.id, label: client.label, path: client.pathOf(dirs),
      status: 'skipped', summary: 'client not detected', changed: false,
    });
    skipped++;
    continue;
  }
  // 对没装过的客户端做 --remove 毫无意义：既没有文件，也没写过东西。
  if (!present && REMOVE) {
    if (!JSON_OUT) { dash('skipped: not present'); log(''); }
    results.push({
      id: client.id, label: client.label, path: client.pathOf(dirs),
      status: 'absent', summary: 'not present', changed: false,
    });
    skipped++;
    continue;
  }

  let plan;
  try {
    plan = planClient(client, ctx);
  } catch (e) {
    plan = { id: client.id, label: client.label, path: client.pathOf(dirs), status: 'failed', changed: false, summary: e.message };
  }

  let finalPlan = plan;
  try {
    finalPlan = applyClient(plan, ctx, STAMP);
  } catch (e) {
    finalPlan = { ...plan, status: 'failed', changed: false, summary: 'unexpected error: ' + e.message };
  }

  const row = {
    id: finalPlan.id,
    label: finalPlan.label,
    path: finalPlan.path,
    status: finalPlan.status,
    summary: finalPlan.summary,
    changed: Boolean(finalPlan.changed),
  };
  // 备份路径必须报出来：用户要回滚时得找得到那一份。
  if (finalPlan.backup) row.backup = finalPlan.backup;
  results.push(row);

  if (finalPlan.status === 'failed') {
    if (!JSON_OUT) { bang(finalPlan.summary); log(''); }
    failed++;
    continue;
  }
  if (finalPlan.changed) {
    if (!JSON_OUT) {
      tick(finalPlan.summary);
      if (finalPlan.backup) log('       backup: ' + finalPlan.backup);
      log('');
    }
    changed++;
  } else {
    if (!JSON_OUT) { dash('skipped: ' + finalPlan.summary); log(''); }
    skipped++;
  }
}

const ok = failed === 0;
const summary = {
  ok,
  mode: REMOVE ? 'remove' : (WRITE ? 'apply' : 'plan'),
  clients: results,
  changed,
  skipped,
  failed,
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  log('Summary: ' + changed + ' ' + (WRITE ? 'changed' : 'would change') + ', ' + skipped + ' skipped, ' + failed + ' failed');
  if (!WRITE && changed) log('Nothing was written. Re-run with --yes to apply.');
  if (failed) {
    log('');
    log('A failure above left no damage: every writer validates the result and keeps');
    log('    a .bak-dsh-* copy beside the file it touched.');
  }
}

process.exit(ok ? 0 : 1);