/**
 * 客户端配置的底层文件操作与公共常量：原子写、备份轮转、权限探测与卸载收尾。
 */

import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** 写进每个客户端的条目名。同时也是 --remove 唯一的识别依据。 */
export const ENTRY_NAME = 'dsh-any-agent';

export const IS_WIN = platform() === 'win32';
export const IS_MAC = platform() === 'darwin';

const SETUP_ENV_KEYS = new Set(['DSH_MCP_PERMISSION', 'DSH_MCP_LOG']);

export function managedEnvKey(key, { replaceBin = false, replaceDaemon = true } = {}) {
  const name = IS_WIN ? key.toUpperCase() : key;
  return (
    SETUP_ENV_KEYS.has(name) ||
    (name === 'DSH_MCP_DAEMON' && replaceDaemon) ||
    (name === 'DSH_BIN' && replaceBin)
  );
}

/** 写入前的备份文件名：<file>.bak-dsh-<时间戳>。 */
export function backupSuffix(stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  return '.bak-dsh-' + stamp;
}

/**
 * 备份一个文件，返回备份路径。
 * 同一毫秒内撞名就加序号，绝不覆盖已有备份。
 */
export function backupFile(file, stamp, { prune = true } = {}) {
  const base = file + backupSuffix(stamp);
  for (let i = 1; ; i++) {
    const dst = i === 1 ? base : base + '-' + i;
    try {
      copyFileSync(file, dst, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    if (prune) pruneBackups(file);
    return dst;
  }
}

/** 备份轮转：同一目标只保留最近 N 份（默认 20，DSH_MCP_BACKUP_KEEP 可调）。 */
export function pruneBackups(file) {
  const raw = Number(process.env.DSH_MCP_BACKUP_KEEP ?? 20);
  const keep = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
  try {
    const dir = dirname(file);
    const prefix = basename(file) + '.bak-dsh-';
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => a.slice(prefix.length).replace(/^pre-restore-/, '')
        .localeCompare(b.slice(prefix.length).replace(/^pre-restore-/, ''), 'en', { numeric: true }));
    for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
      try { unlinkSync(join(dir, name)); } catch {}
    }
  } catch {
    /* 轮转失败不影响本次备份 */
  }
}

/** 先写临时文件再改名，尽量保留原文件权限，避免崩溃时留下半截配置。 */
export function atomicWrite(file, text, { mode = undefined } = {}) {
  let originalMode = mode;
  if (originalMode === undefined) {
    try { originalMode = statSync(file).mode; } catch { originalMode = null; }
  }
  const tmp = file + '.tmp-dsh-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    writeFileSync(tmp, text, {
      encoding: 'utf8',
      ...(originalMode === null ? {} : { mode: originalMode & 0o7777 }),
    });
    renameSync(tmp, file);
    if (originalMode !== null) {
      try { chmodSync(file, originalMode & 0o7777); } catch { /* 尽力而为 */ }
    }
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 尽力而为 */ }
    throw e;
  }
}

/** 显式查一次写权限，确保 POSIX 0444 文件不会被临时文件 rename 静默替换。 */
export function isWritable(file) {
  if (!existsSync(file)) return true;
  try {
    accessSync(file, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读一个配置文件，把 UTF-8 BOM 拆出来单独记着。 */
export function readConfigFile(file) {
  const raw = readFileSync(file, 'utf8');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  return { raw, bom, text: bom ? raw.slice(1) : raw };
}

/** 配置文件当前字节的指纹（不存在为 null）：用于发现规划之后文件被外部修改。 */
export function sourceHashOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 这个文件现存备份的内容（不含还原前的安全副本）。 */
export function backupTexts(file) {
  const prefix = basename(file) + '.bak-dsh-';
  try {
    return readdirSync(dirname(file))
      .filter((name) => name.startsWith(prefix) && !name.startsWith(prefix + 'pre-restore-'))
      .map((name) => { try { return readFileSync(join(dirname(file), name), 'utf8'); } catch { return null; } });
  } catch {
    return [];
  }
}

/** 卸载后对照安装前备份决定是保留空容器、收掉空容器，还是删掉空壳文件。 */
export function settleRemoval(file, dropped, kept, isBare) {
  const before = backupTexts(file);
  if (kept !== dropped && before.includes(kept)) return { next: kept };
  if (isBare(dropped) && !before.includes(dropped)) return { deleteFile: true };
  return { next: dropped };
}
