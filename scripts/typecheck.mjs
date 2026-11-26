#!/usr/bin/env node
/**
 * 零依赖静态类型检查：`npm run typecheck`。
 *
 * 借助固定版本 `typescript` 与 `@types/node`（通过 `npm exec` 临时拉取，不写入 package.json），
 * 对 `jsconfig.json` 覆盖的全部 `src/` 与 `bin/` ESM 文件执行 `tsc --noEmit --checkJs`。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_PKG = 'typescript@5.8.3';
const NODE_TYPES_PKG = '@types/node@22';

function findToolModules() {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).map((d) => resolve(d, '..')),
    join(ROOT, 'node_modules'),
  ];
  return dirs.find(
    (nm) => existsSync(join(nm, 'typescript', 'bin', 'tsc')) && existsSync(join(nm, '@types', 'node')),
  );
}

const nm = findToolModules();
if (!nm) {
  if (process.env.DSH_TYPECHECK_BOOTSTRAPPED === '1') {
    process.stderr.write('typecheck: failed to locate typescript and @types/node in npm exec cache\n');
    process.exit(1);
  }
  const extra = process.argv.slice(2);
  const execArgs = ['exec', '--yes', `--package=${TS_PKG}`, `--package=${NODE_TYPES_PKG}`, '--', 'node', 'scripts/typecheck.mjs', ...extra];
  const env = { ...process.env, DSH_TYPECHECK_BOOTSTRAPPED: '1' };
  const r = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...execArgs], { cwd: ROOT, stdio: 'inherit', env })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', execArgs, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env,
      });
  process.exit(r.status ?? 1);
}

const tsc = join(nm, 'typescript', 'bin', 'tsc');
const typeRoots = join(nm, '@types');
const res = spawnSync(
  process.execPath,
  [tsc, '-p', join(ROOT, 'jsconfig.json'), '--noEmit', '--typeRoots', typeRoots, ...process.argv.slice(2)],
  { cwd: ROOT, stdio: 'inherit' },
);
if (res.status === 0) process.stdout.write('typecheck: 0 errors\n');
process.exit(res.status ?? 1);
