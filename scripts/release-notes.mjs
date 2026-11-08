#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 取出某个版本的那一节，作为 GitHub Release 的说明。
 *
 * 为什么要有这个脚本：release.yml 以前用 `gh release create --generate-notes`，
 * 生成的只有一行 PR 链接（"Release 0.6.2 … by @xmtlzzz in #14"），CHANGELOG 里写好的
 * 功能说明在 Release 页面上完全看不到。
 *
 *   node scripts/release-notes.mjs 0.6.2            # 输出到 stdout
 *   node scripts/release-notes.mjs v0.6.2 --out notes.md
 *
 * 找不到这一节、或这一节是空的 → exit 1（宁可让发布失败，也不要发一份空说明）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/xmtlzzz/dsh-any-agent';

/**
 * 取出 `## [version]` 那一节的正文（不含标题行），去掉首尾空行。
 * 找不到返回 null。
 */
export function extractSection(changelog, version) {
  const v = String(version).replace(/^v/, '');
  const lines = changelog.split(/\r?\n/);
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^## \\[${esc}\\](?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // 下一个版本标题，或文末的链接定义区（[x.y.z]: https://…）
    if (/^## \[/.test(lines[i]) || /^\[[^\]]+\]:\s*\S+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body;
}

/** 上一个版本号（CHANGELOG 里紧跟在后面的那一节），用于 compare 链接。 */
export function previousVersion(changelog, version) {
  const v = String(version).replace(/^v/, '');
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1]);
  const i = versions.indexOf(v);
  return i >= 0 && i + 1 < versions.length ? versions[i + 1] : null;
}

/** 组装完整的 Release 说明：CHANGELOG 那一节 + 安装命令 + compare 链接。 */
export function buildNotes(changelog, version) {
  const v = String(version).replace(/^v/, '');
  const body = extractSection(changelog, v);
  if (body === null) throw new Error(`CHANGELOG.md 里没有 "## [${v}]" 这一节`);
  if (!body) throw new Error(`CHANGELOG.md 的 "## [${v}]" 一节是空的`);
  const prev = previousVersion(changelog, v);
  const tail = [
    '---',
    '',
    `Install / upgrade: \`npm install -g dsh-any-agent@${v}\` · [npm](https://www.npmjs.com/package/dsh-any-agent/v/${v})`,
    prev ? `Full diff: ${REPO}/compare/v${prev}...v${v}` : null,
  ].filter((x) => x !== null);
  return `${body}\n\n${tail.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  if (!version) {
    process.stderr.write('用法: node scripts/release-notes.mjs <version> [--out file]\n');
    process.exit(2);
  }
  try {
    const notes = buildNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
    if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1], notes, 'utf8');
    else process.stdout.write(notes);
  } catch (e) {
    process.stderr.write(`release-notes: ${e.message}\n`);
    process.exit(1);
  }
}
