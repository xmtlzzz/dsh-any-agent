/**
 * 找本机的 DSH CLI，并给出“用什么运行时、怎么拉起它”。零配置、零依赖。
 *
 * 来源（全部自动发现，不需要手填 DSH_BIN）：
 *   - desktop：DeepSeek Harness 桌面版。CLI 打包在 `resources/app.asar` 里，普通 Node
 *     读不了 asar，所以用桌面版自带的 Electron 以 Node 模式（ELECTRON_RUN_AS_NODE=1）
 *     运行它 —— 顺带用上桌面版自带的 Node（DSH 0.2.2 起要求 Node >= 24.9）。
 *     Windows 从卸载注册表（HKCU/HKLM）读安装目录，另外各平台都查默认安装位置。
 *   - global：npm 全局安装（`node <bin.js>`）。
 *   - npx：npx 缓存（随 `npm cache clean` 随时消失，同等条件下最低优先）。
 *
 * 选择顺序：当前运行时能满足 DSH `engines.node` 的优先 → 版本高的优先 →
 *   desktop > global > npx。这样用户的 GUI 与本服务默认跑同一份 DSH（两者共用
 *   ~/.dsh 会话存储，版本不一致时新版本写的会话可能被旧版本 resume）。
 *
 * 显式覆盖：DSH_BIN（指向 bin.js；可以指进 .asar 内部，运行时自动推导），
 *          DSH_RUNTIME（可选，指定拉起 DSH 的可执行文件，例如一个 Node 24）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

/** 相对 DSH 包根的入口与包描述。 */
const DSH_PKG_PARTS = ['@deepseek-ai', 'dsh'];
const DSH_ENTRY = join(...DSH_PKG_PARTS, 'lib', 'bin.js');
/** 桌面版 asar 内 DSH 包的位置（实测 0.2.2-rc.1：`app.asar/dsh/node_modules/@deepseek-ai/dsh`）。 */
const ASAR_DSH_ROOT = ['dsh', 'node_modules', ...DSH_PKG_PARTS];

const SOURCE_RANK = { env: 4, desktop: 3, global: 2, npx: 1 };
export const SOURCE_LABEL = { env: 'DSH_BIN', desktop: '桌面版', global: 'npm 全局', npx: 'npx 缓存' };

/** 发现结果缓存：注册表 + 文件系统探测约 100ms，拉进程/体检时会频繁调用。 */
const DISCOVERY_TTL_MS = 60_000;
let discoveryCache = null;

// ── 版本工具 ──────────────────────────────────────────────────────

/** 极简 semver 比较（够用于挑最新）；返回 a-b 的符号。 */
export function cmpVersion(a, b) {
  const [ac, ap] = String(a).split('-', 2);
  const [bc, bp] = String(b).split('-', 2);
  const an = ac.split('.').map(Number);
  const bn = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (an[i] || 0) - (bn[i] || 0);
    if (d) return d;
  }
  if (!ap && bp) return 1; // release > prerelease
  if (ap && !bp) return -1;
  if (ap && bp) {
    const ar = ap.split('.');
    const br = bp.split('.');
    for (let i = 0; i < Math.max(ar.length, br.length); i++) {
      const x = ar[i] ?? '';
      const y = br[i] ?? '';
      const xn = x !== '' && Number.isFinite(Number(x));
      const yn = y !== '' && Number.isFinite(Number(y));
      if (xn && yn) {
        if (Number(x) !== Number(y)) return Number(x) - Number(y);
      } else if (xn) return -1;
      else if (yn) return 1;
      else if (x !== y) return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Node 版本是否满足 `engines.node`。支持 `||`、空格分隔的 `>= > <= < =` 与 `^X`；
 * 看不懂的写法返回 null（未知，不当作不满足）。
 */
export function satisfiesNodeRange(range, version) {
  if (!range || !version) return null;
  const v = String(version).replace(/^v/, '');
  let understood = true;
  const alt = String(range)
    .split('||')
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((cmp) => {
          const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.\d+){0,2}(?:-[\w.]+)?)$/.exec(cmp);
          if (!m) {
            understood = false;
            return false;
          }
          const [, op = '=', target] = m;
          const d = cmpVersion(v, target);
          const major = (s) => Number(String(s).split('.')[0]);
          switch (op) {
            case '>=': return d >= 0;
            case '>': return d > 0;
            case '<=': return d <= 0;
            case '<': return d < 0;
            case '^': return d >= 0 && major(v) === major(target);
            case '~': return d >= 0 && String(v).split('.').slice(0, 2).join('.') === String(target).split('.').slice(0, 2).join('.');
            default: return d === 0;
          }
        }),
    );
  if (alt.some(Boolean)) return true;
  return understood ? false : null;
}

// ── asar 只读访问（纯 Node，不需要 Electron）──────────────────────

const asarHeaders = new Map();

/** 读 asar 头：`[u32 4][u32 headerSize]` + pickle(`[u32 payload][u32 len][json]`)，文件区从 8+headerSize 开始。 */
function readAsarHeader(asarPath) {
  let st;
  try {
    st = statSync(asarPath);
  } catch {
    return null;
  }
  const key = `${asarPath}|${st.size}|${st.mtimeMs}`;
  const hit = asarHeaders.get(asarPath);
  if (hit?.key === key) return hit.value;
  let value = null;
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    const size = head.readUInt32LE(4);
    if (size <= 8 || size > st.size) throw new Error('bad asar header size');
    const hb = Buffer.alloc(size);
    readSync(fd, hb, 0, size, 8);
    const strLen = hb.readUInt32LE(4);
    value = { header: JSON.parse(hb.toString('utf8', 8, 8 + strLen)), base: 8 + size };
  } catch {
    value = null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  asarHeaders.set(asarPath, { key, value });
  return value;
}

/** 把 `X/app.asar/a/b.js` 拆成 `{ asar: 'X/app.asar', inner: ['a','b.js'] }`；不在 asar 里返回 null。 */
export function splitAsarPath(p) {
  const parts = String(p ?? '').split(/[\\/]/);
  const i = parts.findIndex((s, idx) => idx < parts.length - 1 && /\.asar$/i.test(s));
  if (i < 0) return null;
  return { asar: parts.slice(0, i + 1).join(sep), inner: parts.slice(i + 1) };
}

function asarEntry(asarPath, inner) {
  const h = readAsarHeader(asarPath);
  if (!h) return null;
  let node = h.header;
  for (const k of inner) {
    node = node?.files?.[k];
    if (!node) return null;
  }
  return { node, base: h.base };
}

/** 读文件（asar 感知）；读不到返回 null。 */
export function readMaybeAsar(p) {
  const split = splitAsarPath(p);
  if (!split) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
  const e = asarEntry(split.asar, split.inner);
  if (!e || e.node.files || e.node.link) return null;
  if (e.node.unpacked) {
    try {
      return readFileSync(join(`${split.asar}.unpacked`, ...split.inner), 'utf8');
    } catch {
      return null;
    }
  }
  let fd;
  try {
    fd = openSync(split.asar, 'r');
    const buf = Buffer.alloc(e.node.size);
    readSync(fd, buf, 0, e.node.size, e.base + Number(e.node.offset));
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 路径是否存在（asar 感知）。 */
export function existsMaybeAsar(p) {
  const split = splitAsarPath(p);
  if (!split) return existsSync(p);
  return asarEntry(split.asar, split.inner) !== null;
}

/** 读 bin.js 所在包的 version / engines.node（asar 感知）。 */
export function readDshPackage(bin) {
  const txt = readMaybeAsar(join(dirname(bin), '..', 'package.json'));
  if (!txt) return { version: null, enginesNode: null };
  try {
    const j = JSON.parse(txt);
    return { version: j.version ?? null, enginesNode: j.engines?.node ?? null };
  } catch {
    return { version: null, enginesNode: null };
  }
}

// ── 桌面版发现 ────────────────────────────────────────────────────

const DESKTOP_NAME = 'DeepSeek Harness';

/** 解析 `reg export` 产出的 .reg（UTF-16LE）：返回 [{ key, values: {Name: string} }]。 */
export function parseRegExport(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = { key: sec[1], values: {} };
      out.push(cur);
      continue;
    }
    const kv = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (kv && cur) {
      const un = (s) => s.replace(/\\(.)/g, '$1');
      cur.values[un(kv[1])] = un(kv[2]);
    }
  }
  return out;
}

/**
 * Windows 卸载注册表里的桌面版安装。
 * 用 `reg export`（UTF-16LE 文件）而不是 `reg query` 的控制台输出：后者按系统代码页
 * 编码，中文路径在 GBK 系统上会乱码。
 */
function windowsRegistryInstalls() {
  if (process.platform !== 'win32') return [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const found = [];
  roots.forEach((root, i) => {
    const file = join(tmpdir(), `dsh-locate-${process.pid}-${Date.now()}-${i}.reg`);
    try {
      execFileSync(existsSync(reg) ? reg : 'reg', ['export', root, file, '/y'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      for (const sec of parseRegExport(readFileSync(file, 'utf16le'))) {
        const v = sec.values;
        if (!/deepseek\s*harness/i.test(v.DisplayName ?? '')) continue;
        const icon = (v.DisplayIcon ?? '').replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
        const dir = v.InstallLocation || (icon ? dirname(icon) : '');
        if (dir) found.push({ dir, exe: /\.exe$/i.test(icon) ? icon : null, displayVersion: v.DisplayVersion ?? null, via: 'registry' });
      }
    } catch {
      // 该根不存在 / reg 不可用：静默跳过
    } finally {
      rmSync(file, { force: true });
    }
  });
  return found;
}

/** 各平台默认安装位置（注册表之外的兜底，以及 macOS/Linux）。 */
function defaultDesktopDirs() {
  const home = homedir();
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', DESKTOP_NAME),
      process.env.ProgramFiles && join(process.env.ProgramFiles, DESKTOP_NAME),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], DESKTOP_NAME),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [join('/Applications', `${DESKTOP_NAME}.app`), join(home, 'Applications', `${DESKTOP_NAME}.app`)];
  }
  return ['/opt/DeepSeek Harness', '/opt/deepseek-harness', '/usr/lib/deepseek-harness', join(home, '.local', 'share', 'deepseek-harness')];
}

/** 由 asar 路径推导桌面版可执行文件（显式 DSH_BIN 指进 asar 时也用它）。 */
export function desktopExeForAsar(asarPath, exeHint = null) {
  if (exeHint && existsSync(exeHint)) return exeHint;
  const resources = dirname(asarPath);
  if (process.platform === 'darwin' && basename(resources) === 'Resources') {
    const macos = join(dirname(resources), 'MacOS');
    const named = join(macos, DESKTOP_NAME);
    if (existsSync(named)) return named;
    try {
      const first = readdirSync(macos)[0];
      return first ? join(macos, first) : null;
    } catch {
      return null;
    }
  }
  const root = dirname(resources);
  const names =
    process.platform === 'win32'
      ? [`${DESKTOP_NAME}.exe`]
      : [DESKTOP_NAME, 'deepseek-harness', 'dsh-desktop'];
  for (const n of names) {
    const p = join(root, n);
    if (existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    try {
      const exe = readdirSync(root).find((f) => /\.exe$/i.test(f) && !/^(uninstall|elevate)/i.test(f));
      if (exe) return join(root, exe);
    } catch {}
  }
  return null;
}

/** 检查一个桌面版安装目录，返回候选（不是有效安装时返回 null）。导出供测试。 */
export function desktopCandidate({ dir, exe = null, displayVersion = null, via }) {
  const asar =
    process.platform === 'darwin' && /\.app$/i.test(dir)
      ? join(dir, 'Contents', 'Resources', 'app.asar')
      : join(dir, 'resources', 'app.asar');
  if (!existsSync(asar)) return null;
  const bin = join(asar, ...ASAR_DSH_ROOT, 'lib', 'bin.js');
  if (!existsMaybeAsar(bin)) return null;
  const runtime = desktopExeForAsar(asar, exe);
  if (!runtime) return null;
  const pkg = readDshPackage(bin);
  return {
    source: 'desktop',
    via,
    installDir: dir,
    displayVersion,
    bin,
    version: pkg.version,
    enginesNode: pkg.enginesNode,
    command: runtime,
    args: [bin],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    runtime: 'electron',
    // 桌面版自带运行时就是 GUI 自己跑 DSH 用的那个：视为满足（体检时再实测版本）。
    runtimeOk: null,
  };
}

function desktopCandidates() {
  const seen = new Set();
  const out = [];
  const entries = [...windowsRegistryInstalls(), ...defaultDesktopDirs().map((dir) => ({ dir, via: 'default-path' }))];
  for (const e of entries) {
    const k = e.dir.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const c = desktopCandidate(e);
    if (c) out.push(c);
  }
  return out;
}

// ── npm 全局 / npx 缓存 ─────────────────────────────────────────

function nodeCandidate(source, bin) {
  if (!existsSync(bin)) return null;
  const pkg = readDshPackage(bin);
  return {
    source,
    bin,
    version: pkg.version,
    enginesNode: pkg.enginesNode,
    command: process.execPath,
    args: [bin],
    env: {},
    runtime: 'node',
    runtimeOk: satisfiesNodeRange(pkg.enginesNode, process.versions.node),
  };
}

function globalCandidates() {
  const nodeDir = dirname(process.execPath);
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    join(nodeDir, 'node_modules'), // Windows 下 prefix=node 安装目录时
    join(nodeDir, '..', 'lib', 'node_modules'), // Unix prefix
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const bin = join(r, DSH_ENTRY);
    if (seen.has(bin.toLowerCase())) continue;
    seen.add(bin.toLowerCase());
    const c = nodeCandidate('global', bin);
    if (c) out.push(c);
  }
  return out;
}

/** npx 的缓存目录名带随机 hash（`_npx/<hash>/`），写死会随环境失效，所以这里筛一遍。 */
function npxCandidates() {
  const roots = [join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'), join(homedir(), '.npm', '_npx')];
  const out = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const c = nodeCandidate('npx', join(root, e.name, 'node_modules', DSH_ENTRY));
      if (c) out.push(c);
    }
  }
  return out;
}

/** DSH 入口是不是落在 npx 缓存里（`_npx/<hash>/…`）：那里随 `npm cache clean` 或 npx 自身淘汰随时消失。 */
export function isNpxCachePath(p) {
  return /[\\/]_npx[\\/]/.test(String(p ?? ''));
}

// ── 选择 ──────────────────────────────────────────────────────────

/**
 * 候选排序：已知跑不起来的（runtimeOk=false）垫底 → 版本高优先 → desktop > global > npx。
 * ★ 不按“版本最高”一刀切：npx 里一份要求 Node 24 的新版，在 Node 22 上可能根本跑不起来，
 *   不如桌面版自带运行时的同代版本可靠。
 */
export function rankCandidates(list) {
  return [...list].sort(
    (a, b) =>
      (a.runtimeOk === false) - (b.runtimeOk === false) ||
      cmpVersion(b.version ?? '0.0.0', a.version ?? '0.0.0') ||
      (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0),
  );
}

/** 自动发现到的全部候选（已排序，第一个就是默认选择）。结果缓存 60 秒。 */
export function discoverDsh({ fresh = false } = {}) {
  if (!fresh && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.list;
  const list = rankCandidates([...desktopCandidates(), ...globalCandidates(), ...npxCandidates()]);
  discoveryCache = { at: Date.now(), list };
  return list;
}

/** 显式 DSH_BIN（可选 DSH_RUNTIME）。 */
function explicitDsh(binPath, runtimePath) {
  if (!existsMaybeAsar(binPath)) throw new Error(`DSH_BIN 指向的文件不存在: ${binPath}`);
  const pkg = readDshPackage(binPath);
  const split = splitAsarPath(binPath);
  let command = process.execPath;
  if (runtimePath) {
    if (!existsSync(runtimePath)) throw new Error(`DSH_RUNTIME 指向的文件不存在: ${runtimePath}`);
    command = runtimePath;
  } else if (split) {
    command = desktopExeForAsar(split.asar);
    if (!command) {
      throw new Error(`DSH_BIN 在 asar 内（${split.asar}），但找不到配套的桌面版可执行文件；请用 DSH_RUNTIME 指定`);
    }
  }
  const foreign = command !== process.execPath;
  return {
    source: 'env',
    bin: binPath,
    version: pkg.version,
    enginesNode: pkg.enginesNode,
    command,
    args: [binPath],
    // ELECTRON_RUN_AS_NODE 对普通 node 无副作用，所以外部运行时一律带上。
    env: foreign ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    runtime: split && !runtimePath ? 'electron' : foreign ? 'custom' : 'node',
    runtimeOk: foreign ? null : satisfiesNodeRange(pkg.enginesNode, process.versions.node),
  };
}

/**
 * 解析要用的 DSH：`{ bin, command, args, env, version, source, runtime, runtimeOk, ... }`。
 * 拉起方式：`spawn(command, [...args, '--profile', X], { env: { ...process.env, ...env } })`。
 */
export function resolveDsh({ fresh = false } = {}) {
  const explicit = process.env.DSH_BIN;
  if (explicit) return explicitDsh(explicit, process.env.DSH_RUNTIME || null);
  const list = discoverDsh({ fresh });
  if (list.length) return list[0];
  throw new Error(
    'DSH CLI 未找到：没有发现 DeepSeek Harness 桌面版、npm 全局安装或 npx 缓存里的 @deepseek-ai/dsh。\n' +
      '  安装桌面版即可自动识别；或 npm i -g @deepseek-ai/dsh；或设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js',
  );
}

/** 实测某个运行时的 Node 版本（体检用；约 0.2s，结果缓存）。 */
const runtimeNodeCache = new Map();
export function probeRuntimeNode(c) {
  if (c.command === process.execPath) return process.versions.node;
  const key = `${c.command}|${JSON.stringify(c.env)}`;
  if (runtimeNodeCache.has(key)) return runtimeNodeCache.get(key);
  let v = null;
  try {
    const r = spawnSync(c.command, ['-e', 'process.stdout.write(process.versions.node)'], {
      env: { ...process.env, ...c.env },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    v = /^\d+\.\d+\.\d+/.test(r.stdout ?? '') ? r.stdout.trim() : null;
  } catch {
    v = null;
  }
  runtimeNodeCache.set(key, v);
  return v;
}
