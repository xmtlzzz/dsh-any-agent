import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export function isHostAbsolute(file, platform = process.platform) {
  return platform === 'win32'
    ? win32.isAbsolute(file) && win32.parse(file).root.length > 1
    : posix.isAbsolute(file);
}

/** Keep PATH entries independent of the MCP and child working directories. */
export function hostPath(env = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const key = windows ? Object.keys(env).sort().find((name) => name.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const dirs = (env[key] ?? (windows ? '' : '/usr/bin:/bin'))
    .split(path.delimiter)
    .map((dir) => windows ? dir.replace(/^"(.*)"$/, '$1') : dir)
    .filter((dir) => isHostAbsolute(dir, platform));
  const childEnv = { ...env, [key]: dirs.join(path.delimiter) };
  if (windows) childEnv.NoDefaultCurrentDirectoryInExePath = '1';
  return { dirs, env: childEnv };
}

/** Windows utilities shipped with the OS must be launched from System32. */
export function windowsSystemExecutable(...parts) {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  if (!isHostAbsolute(root, 'win32')) return null;
  return win32.join(root, 'System32', ...parts);
}

export function findPosixExecutable(name, dirs) {
  for (const dir of dirs) {
    const candidate = posix.join(dir, name);
    try {
      if (!(statSync(candidate)).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next directory when the utility is missing or not executable.
    }
  }
  return null;
}

export function processListExecutable() {
  return findPosixExecutable('ps', ['/bin', '/usr/bin']) ?? findPosixExecutable('ps', hostPath().dirs);
}
