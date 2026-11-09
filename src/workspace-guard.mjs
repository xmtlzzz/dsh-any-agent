/**
 * 工作区路径边界：哪些 cwd 不能拿来当工作区（家目录本身、文件系统根）。
 *
 * 从 hub.mjs 拆出来：只看路径与当前文件系统，不依赖 Hub/Conversation 状态。
 * hub.mjs 仍然重新导出 `homeWorkspaceProblem` / `fsCaseInsensitive`，外部的导入路径不变。
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';

/**
 * 当前文件系统是否大小写不敏感（缓存一次）。
 *
 * 不能按平台猜：GitHub 的 `macos-latest` 是**大小写敏感的 APFS**，而普通 macOS
 * 默认又不敏感；Windows 一定不敏感；Linux 一定敏感。用临时文件探针最稳。
 */
let caseInsensitiveCache = null;
export function fsCaseInsensitive() {
  if (caseInsensitiveCache !== null) return caseInsensitiveCache;
  if (process.platform === 'win32') {
    caseInsensitiveCache = true;
    return true;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-any-agent-case-'));
    writeFileSync(join(dir, 'probe'), '');
    caseInsensitiveCache = existsSync(join(dir, 'PROBE'));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    caseInsensitiveCache = false;
  }
  return caseInsensitiveCache;
}

/**
 * 工作区能不能用在家目录本身？
 *
 * DSH 自己的 ACL 沙箱要求临时目录在工作区**之外**。Windows 上 %TEMP% 是
 * C:/Users/<name>/AppData/Local/Temp，正好在用户家目录里面，所以把家目录
 * 当作工作区时，沙箱初始化会失败：
 *   Windows ACL: temp root must be outside the workspace
 * 症状出现在第一次起 shell 的时候，看起来像这个服务坏了，其实只是 cwd
 * 选得太大。read-only 档不写盘、也不起 ACL 沙箱，所以不受影响。
 *
 * @returns {string|null} null 表示没问题，否则返回一段可直接抛出的说明。
 */
export function homeWorkspaceProblem(cwd, permission) {
  if (permission === 'read-only') return null;
  const home = homedir();
  if (!home) return null;
  const caseInsensitive = process.platform === 'win32' || fsCaseInsensitive();
  const real = (p) => {
    // 解析 symlink：一个指向家目录/根目录的软链不能绕过这两个边界。
    // 路径不存在时（测试里的 "some-project"）回落到 resolve。
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const norm = (p) => (caseInsensitive ? real(p).toLowerCase() : real(p));
  // 根目录 = 整个磁盘。workspace-write 的沙箱根会跟着 cwd 走，
  // 于是“只写工作区”退化成“可写全盘”，必须显式要求 danger-full-access。
  // ★ 根要从**解析后的真实路径**取：C: 上指向 `D:\` 的 junction 解析后在 D: 盘，
  //   拿传入路径的盘符比较就会放行（审计 A04）。
  const fsRoot = resolve(parse(real(cwd)).root);
  if (norm(cwd) === norm(fsRoot)) {
    return [
      'cwd 不能是文件系统根目录: ' + cwd,
      '  workspace-write 的沙箱根会变成整个磁盘，等于绕过“只写工作区”的权限档。',
      '  请传一个具体的项目目录；确实要全盘访问请显式用 permission=danger-full-access。',
    ].join('\n');
  }
  if (norm(cwd) !== norm(home)) return null;

  const temp = tmpdir();
  const tempInside = norm(temp) === norm(home) || norm(temp).startsWith(norm(home) + sep);
  const lines = ['cwd 不能是用户家目录本身: ' + cwd];
  if (tempInside) lines.push('  临时目录 ' + temp + ' 就在它里面，');
  lines.push(
    '  DSH 的 ACL 沙箱要求临时目录在工作区之外，否则第一次起 shell 就会报:',
    '    Windows ACL: temp root must be outside the workspace',
    '',
    '  换个具体项目目录最省事，或者改权限档：',
    '    permission=read-only           不写盘，不需要该沙箱',
    '    permission=danger-full-access  不受该沙箱约束',
  );
  return lines.join('\n');
}
