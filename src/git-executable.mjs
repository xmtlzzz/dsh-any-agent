import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, parse } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const windows = process.platform === 'win32';

/** Run host Git without allowing the repository cwd to affect executable lookup. */
export async function execGit(args, { env = process.env, ...options }) {
  const pathKey = windows ? Object.keys(env).sort().find((key) => key.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const entries = (env[pathKey] ?? (windows ? '' : '/usr/bin:/bin')).split(delimiter);
  const dirs = entries
    .map((entry) => windows ? entry.replace(/^"(.*)"$/, '$1') : entry)
    .filter((dir) => isAbsolute(dir) && (!windows || parse(dir).root.length > 1));
  const childEnv = { ...env, [pathKey]: dirs.join(delimiter) };
  if (windows) childEnv.NoDefaultCurrentDirectoryInExePath = '1';

  for (const dir of dirs) {
    const candidate = join(dir, windows ? 'git.exe' : 'git');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return execFileAsync(candidate, args, { ...options, env: childEnv });
  }
  throw new Error('Git executable not found in absolute PATH entries');
}
