import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_FILE } from './config.mjs';
import { isPidAlive } from './procstat.mjs';

const STATE_DIR = dirname(STATE_FILE);

/** 列出状态目录下所有登记过的常驻进程信息（附存活状态）。 */
export function listDaemons() {
  if (!existsSync(STATE_DIR)) return [];
  const out = [];
  for (const name of readdirSync(STATE_DIR).sort()) {
    const m = /^daemon-([0-9a-f]+)\.json$/.exec(name);
    if (!m) continue;
    const infoFile = join(STATE_DIR, name);
    try {
      const info = JSON.parse(readFileSync(infoFile, 'utf8'));
      out.push({
        id: m[1],
        pid: info.pid ?? null,
        alive: isPidAlive(info.pid),
        version: info.version ?? null,
        started_at: info.started_at ?? null,
        infoFile,
      });
    } catch {
      /* 损坏的旧文件忽略 */
    }
  }
  return out;
}
