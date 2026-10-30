#!/usr/bin/env node
/**
 * 提交/打标签，绝不写临时文件。
 *
 * 为什么要有这个脚本：过去几次发布都把 _cm.txt、_msg.cjs 这类临时文件
 * 一起提交进了仓库 —— 因为生成多行提交信息的老办法是「先写文件，再
 * git commit -F 那个文件」。文件一旦落盘，只要有一条 git add -A 就会顺手
 * 把它加进索引，事后还得补一个清理提交。
 *
 * 正确做法是根本不让它落盘：提交信息走 stdin。
 *
 *   node scripts/commit.mjs -m "标题" -m "正文第一段" ...
 *   node scripts/commit.mjs --file -           从 stdin 读
 *   node scripts/commit.mjs --tag v1.2.3 -m "..."   打附注标签
 *
 * 安全阀：提交前检查索引里有没有下划线开头的临时文件或 *.tmp-dsh-* 残留，
 * 有就直接失败并列出它们 —— 宁可中断，也不要再制造一个「发布提交里混进
 * 垃圾文件」的历史。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const vals = (f) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === f && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
};

if (has('--help') || has('-h') || argv.length === 0) {
  process.stdout.write(
    'commit.mjs -- commit or tag without ever writing a message file\n\n' +
    '  node scripts/commit.mjs -m "subject" -m "body paragraph"\n' +
    '  node scripts/commit.mjs --tag v1.2.3 -m "release notes"\n' +
    '  node scripts/commit.mjs --file - < msg.txt\n\n' +
    'Messages go to git over stdin (git commit -F -), so no temp file exists\n' +
    'and no git add -A can sweep one into the tree. Refuses to run if the\n' +
    'index already contains scratch files (leading underscore) or *.tmp-dsh-*.\n',
  );
  process.exit(has('--help') || has('-h') ? 0 : 1);
}

const DRY = has('--dry-run');
const TAG = val('--tag');
const ALLOW_TEMP = has('--allow-staged-temp');

/** 组装提交信息：每段之间一个空行。 */
function buildMessage() {
  const fileArg = val('--file');
  if (fileArg) {
    const text = fileArg === '-' ? readFileSync(0, 'utf8') : readFileSync(fileArg, 'utf8');
    // 统一成 LF，并且去掉结尾的空白行 —— git 会把它们当正文保留。
    return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  }
  const paras = vals('-m');
  if (!paras.length) {
    process.stderr.write('需要至少一个 -m，或 --file <path|->。用 --help 看用法。\n');
    process.exit(2);
  }
  // 每段各自去掉首尾空白：残留的空行会被 git 原样保留进提交信息。
  return paras.map((s) => s.trim()).filter(Boolean).join('\n\n');
}

function git(args, input) {
  const r = spawnSync('git', args, {
    // 三种 stdio 都继承，git 自己的报错才看得见；只有 stdin 接管道。
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
    encoding: 'utf8',
  });
  return r.status ?? 1;
}

/** 索引里不该有的东西。宁可在这一步失败。 */
function scratchInIndex() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      const base = p.split('/').pop();
      return base.startsWith('_') || /\.tmp-dsh-/.test(base) || /\.bak-dsh-/.test(base);
    });
}

const message = buildMessage();
if (!message.trim()) {
  process.stderr.write('提交信息为空，拒绝执行。\n');
  process.exit(2);
}

if (!ALLOW_TEMP) {
  const scratch = scratchInIndex();
  if (scratch.length) {
    process.stderr.write('索引里有临时/备份文件，拒绝提交：\n');
    for (const p of scratch) process.stderr.write('  ' + p + '\n');
    process.stderr.write('先 git restore --staged 它们，或确认无误后加 --allow-staged-temp。\n');
    process.exit(1);
  }
}

const args = TAG ? ['tag', '-a', TAG, '-F', '-'] : ['commit', '-F', '-'];

if (DRY) {
  process.stdout.write('[dry-run] git ' + args.join(' ') + '  <<< 信息走 stdin，不落盘\n');
  process.stdout.write('----\n' + message + '\n----\n');
  process.exit(0);
}

// 关键一行：信息从 stdin 进 git，磁盘上不存在任何信息文件。
const code = git(args, message);
process.exit(code);
