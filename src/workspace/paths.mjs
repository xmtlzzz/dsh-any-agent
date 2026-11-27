/**
 * 工作区与测试会话路径守卫：路径规范化、临时目录判定与清理护栏。
 */

import { DSH_WORKSPACE_REL, DSH_PROJCACHE_REL } from '../dsh-contract.mjs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DSH_HOME, PKG_ROOT, REGISTER_WORKSPACE } from '../config.mjs';

export const WORKSPACE_FILE = join(DSH_HOME, ...DSH_WORKSPACE_REL);
export const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
/**
 * DSH 的会话投影缓存：每个会话一个 `<id>.json`（标题/用量/cwd 等折叠结果）。
 * ★ 删会话目录**不会**连带删它，所以清理会话必须一并删它。
 */
export const PROJCACHE_DIR = join(DSH_HOME, ...DSH_PROJCACHE_REL);
/** forget 墓碑目录（存 id+时间，不含内容）；清掉测试会话时一并清掉其墓碑。 */
export const FORGOTTEN_DIR = process.env.DSH_MCP_FORGOTTEN_DIR ?? join(DSH_HOME, '.dsh-any-agent-forgotten');

/** 会话清理只认这个：桌面 `dsh-any-agent-test-A|B`（注意不含 `dsh-conc-*`，那只用于清工作区登记）。 */
export const DESKTOP_TEST_SESSION_RE = /[\\/]Desktop[\\/]dsh-any-agent-test-[AB]([\\/]|$)/i;
export const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{4,80}$/;

/** 路径比较用：Windows 下大小写不敏感，且忽略结尾分隔符。 */
export const normPath = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * DSH 在 create 时把 `path` 存成 `fs.realpath` 的规范形式，
 * 所以我们也必须存 realpath，否则同一个目录可能出现两条不等价的记录。
 */
export function canonicalPath(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return p;
  }
}

/** `child` 是否真的在 `parent` 里面（按路径分段，不能用字符串前缀）。 */
export function isInside(parent, child) {
  try {
    const rel = relative(parent, child);
    if (!rel) return true;
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * 路径是否位于系统临时目录下（这类"工作区"不该出现在 GUI 里）。
 * ★ 必须按路径分段判断，不能用 `startsWith(tmpdir())`。
 */
export function isTempPath(p) {
  try {
    return Boolean(p) && isInside(tmpdir(), p);
  } catch {
    return false;
  }
}

/** 是否是本仓库测试自己造的临时工作区（`tmpdir()/dsh-any-agent-*`）。 */
export function isTestTempPath(p) {
  try {
    if (!p || !isTempPath(p)) return false;
    const rel = relative(tmpdir(), p);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
    const first = rel.split(/[\\/]/).filter(Boolean)[0] ?? '';
    return /^dsh-any-agent-/.test(first);
  } catch {
    return false;
  }
}

/** 是否是"测试用桌面目录"（`Desktop\dsh-any-agent-test-A|B` 或 `Desktop\dsh-conc-A|B|C`）。 */
export function isTestDesktopPath(p) {
  return /[\\/]Desktop[\\/](dsh-any-agent-test-[AB]|dsh-conc-[ABC])([\\/]|$)/i.test(String(p ?? ''));
}

/** 边界测试（boundary.mjs）在本仓库 `.state/ws-probe-<ts>` 造的登记探针目录。 */
export function isTestScratchPath(p) {
  try {
    if (!p || !isAbsolute(String(p))) return false;
    const rel = relative(join(PKG_ROOT, '.state'), String(p));
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
    return /^ws-probe-\d+$/.test(rel.split(/[\\/]/).filter(Boolean)[0] ?? '');
  } catch {
    return false;
  }
}

/**
 * ★ 清理会话的**唯一护栏**：只有 cwd 满足三种测试目录之一才允许被删，点名也绕不过。
 */
export function isTestSessionCwd(p) {
  const s = String(p ?? '');
  return isTestTempPath(s) || DESKTOP_TEST_SESSION_RE.test(s) || isTestScratchPath(s);
}

/**
 * 是否该登记这个工作区。
 * 模式（DSH_MCP_REGISTER_WORKSPACE）：project（默认，跳过系统临时目录）| all | 0（关闭）
 */
export function shouldRegister(cwd) {
  if (REGISTER_WORKSPACE === false) return false;
  if (REGISTER_WORKSPACE === 'all') return true;
  return !isTempPath(cwd);
}
