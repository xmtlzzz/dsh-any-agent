#!/usr/bin/env node
/**
 * dsh-any-agent-restore -- 把客户端配置退回某一次备份的状态。
 *
 * 为什么需要它：setup 每次写入前都会留 <file>.bak-dsh-<stamp>，但真出事时
 * 手动去每个目录里翻文件名、判断哪个是最新的、再复制回去，很容易挑错一份。
 * 这个命令把「看有哪些备份」和「退回某一份」变成两个明确的操作。
 *
 *   dsh-any-agent-restore --list                    列出所有备份（新的在前）
 *   dsh-any-agent-restore --latest                  退回每个文件最新的那份备份
 *   dsh-any-agent-restore --stamp 2026-10-30T01-35 退回指定批次
 *   dsh-any-agent-restore --file <备份文件>          退回指定的一份
 *   dsh-any-agent-restore --latest --dry-run        只看会做什么
 *
 * 还原本身也是破坏性操作，所以还原前会先把当前状态另存一份
 * （后缀 .bak-dsh-pre-restore-<stamp>），退错了还能再退回来。
 */

import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { backupFile, clientList, resolveDirs, ENTRY_NAME } from '../src/clients.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const JSON_OUT = has('--json');
const log = (s = '') => (JSON_OUT ? process.stderr.write(s + '\n') : process.stdout.write(s + '\n'));

const dirs = resolveDirs(val('--home'));
const clients = clientList(dirs);

/** 每个客户端配置目录下的备份，按时间从新到旧。 */
function backupsOf(path) {
  const dir = dirname(path);
  const prefix = basename(path) + '.bak-dsh-';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => {
      const full = join(dir, f);
      return { file: full, stamp: f.slice(prefix.length), mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const all = [];
for (const c of clients) {
  const path = c.pathOf(dirs);
  for (const b of backupsOf(path)) all.push({ client: c.id, target: path, ...b });
}

if (has('--help') || has('-h') || argv.length === 0) {
  log(
    'dsh-any-agent-restore -- roll client configs back to a previous backup\n\n' +
    'Usage:\n' +
    '  --list                     list every backup, newest first\n' +
    '  --latest                   restore the newest backup of each file\n' +
    '  --stamp <stamp>            restore the batch with this stamp\n' +
    '  --file <path>              restore one specific backup\n' +
    '  --dry-run                  show what would happen, write nothing\n' +
    '  --json                     machine-readable output on stdout\n\n' +
    'A restore is itself destructive: the current file is copied aside as\n' +
    '.bak-dsh-pre-restore-<stamp> first, so a restore can be undone.\n',
  );
  process.exit(has('--help') || has('-h') ? 0 : 1);
}

if (has('--list')) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, backups: all }, null, 2) + '\n');
  } else if (!all.length) {
    log('没有任何备份。');
  } else {
    log('共 ' + all.length + ' 份备份（新的在前）：');
    for (const b of all) {
      log('  ' + new Date(b.mtime).toISOString() + '  ' + b.client.padEnd(15) + '  ' + b.file);
    }
  }
  process.exit(0);
}

const wantStamp = val('--stamp');
const wantFile = val('--file');
const latest = has('--latest');
const dryRun = has('--dry-run');

if (!wantStamp && !wantFile && !latest) {
  log('需要 --list / --latest / --stamp <stamp> / --file <path> 之一。用 --help 看用法。');
  process.exit(1);
}

let chosen;
if (wantFile) {
  chosen = all.filter((b) => b.file === wantFile);
  if (!chosen.length) {
    log('没有这份备份: ' + wantFile);
    process.exit(1);
  }
} else if (wantStamp) {
  chosen = all.filter((b) => b.stamp.startsWith(wantStamp));
  if (!chosen.length) {
    log('没有 stamp 以 ' + wantStamp + ' 开头的备份。用 --list 看有哪些。');
    process.exit(1);
  }
} else {
  // 每个文件只取最新的一份。
  const byTarget = new Map();
  for (const b of all) if (!byTarget.has(b.target)) byTarget.set(b.target, b);
  chosen = [...byTarget.values()];
}

if (!chosen.length) {
  log('没有可还原的备份。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = [];
for (const b of chosen) {
  const row = { client: b.client, target: b.target, from: b.file, action: dryRun ? 'would-restore' : 'restored' };
  if (!dryRun) {
    try {
      // 还原也是破坏性操作：先把「现在」也存一份。
      if (existsSync(b.target)) row.safety = backupFile(b.target, 'pre-restore-' + stamp);
      copyFileSync(b.file, b.target);
    } catch (e) {
      row.action = 'failed';
      row.error = e.message;
    }
  }
  results.push(row);
}

const failed = results.filter((r) => r.action === 'failed').length;
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: failed === 0, dryRun, results }, null, 2) + '\n');
} else {
  for (const r of results) {
    log('  ' + (r.action === 'failed' ? 'FAIL ' : 'OK   ') + r.client.padEnd(15) +
      (dryRun ? ' 会从 ' : ' 已从 ') + basename(r.from) + (r.safety ? '   （当前状态另存为 ' + basename(r.safety) + '）' : ''));
  }
  log('');
  log(dryRun ? '预演，没有写任何文件。' : '还原完成。重启对应的客户端即可生效。');
}
process.exit(failed ? 1 : 0);
