import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { hostPath } from './host-executable.mjs';

const execFileAsync = promisify(execFile);
const windows = process.platform === 'win32';

/** Run host Git without allowing the repository cwd to affect executable lookup. */
export async function execGit(args, { env = process.env, ...options }) {
  const { dirs, env: childEnv } = hostPath(env);

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
