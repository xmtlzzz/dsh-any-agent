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
 *          DSH_RUNTIME（可选，指定拉起 DSH 的可执行文件，例如一个 Node 24；配合 DSH_BIN，
 *          或单独设置时作用于自动发现的 npm/npx 候选 —— 桌面版始终用它自带的运行时）。
 */

import { DSH_PKG_PARTS, DSH_ASAR_ROOT } from './dsh-contract.mjs';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isHostAbsolute, windowsSystemExecutable } from './host-executable.mjs';
import { L } from './lang.mjs';

const execFileAsync = promisify(execFile);

/** 相对 DSH 包根的入口与包描述。 */
const DSH_ENTRY = join(...DSH_PKG_PARTS, 'lib', 'bin.js');

const SOURCE_RANK = { env: 4, desktop: 3, global: 2, npx: 1 };
export const SOURCE_LABEL = { env: 'DSH_BIN', desktop: '桌面版', global: 'npm 全局', npx: 'npx 缓存' };

/** 发现结果缓存：注册表 + 文件系统探测约 100ms，拉进程/体检时会频繁调用。 */
const DISCOVERY_TTL_MS = 60_000;
let discoveryCache = null;
let inFlightDiscovery = null;

// ── 版本工具 ──────────────────────────────────────────────────────

/** 极简 semver 比较（够用于挑最新）；返回 a-b 的符号。 */
export function cmpVersion(a, b) {
  const parts = (value) => {
    const [version] = String(value).split('+', 1);
    const dash = version.indexOf('-');
    return dash < 0 ? [version, ''] : [version.slice(0, dash), version.slice(dash + 1)];
  };
  const [ac, ap] = parts(a);
  const [bc, bp] = parts(b);
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
    for (let i = 0; i < Math.min(ar.length, br.length); i++) {
      const x = ar[i];
      const y = br[i];
      const xn = /^\d+$/.test(x);
      const yn = /^\d+$/.test(y);
      if (xn && yn) {
        if (x.length !== y.length) return x.length - y.length;
        if (x !== y) return x < y ? -1 : 1;
      } else if (xn) return -1;
      else if (yn) return 1;
      else if (x !== y) return x < y ? -1 : 1;
    }
    return ar.length - br.length;
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

function isRegularFile(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

function isDshEntry(path) {
  const split = splitAsarPath(path);
  if (!split) return isRegularFile(path);
  const entry = asarEntry(split.asar, split.inner);
  return entry !== null && !entry.node.files;
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

const WIN_UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function extractRegistryInstalls(text) {
  const found = [];
  for (const sec of parseRegExport(text)) {
    const v = sec.values;
    if (!/deepseek\s*harness/i.test(v.DisplayName ?? '')) continue;
    const icon = (v.DisplayIcon ?? '').replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
    const dir = v.InstallLocation || (icon ? dirname(icon) : '');
    if (dir) found.push({ dir, exe: /\.exe$/i.test(icon) ? icon : null, displayVersion: v.DisplayVersion ?? null, via: 'registry' });
  }
  return found;
}

/**
 * Windows 卸载注册表里的桌面版安装。
 * 用 `reg export`（UTF-16LE 文件）而不是 `reg query` 的控制台输出：后者按系统代码页
 * 编码，中文路径在 GBK 系统上会乱码。
 */
function windowsRegistryInstalls() {
  if (process.platform !== 'win32') return [];
  const reg = windowsSystemExecutable('reg.exe');
  if (!reg || !existsSync(reg)) return [];
  const found = [];
  WIN_UNINSTALL_ROOTS.forEach((root, i) => {
    const file = join(tmpdir(), `dsh-locate-${process.pid}-${Date.now()}-${i}.reg`);
    try {
      execFileSync(reg, ['export', root, file, '/y'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      found.push(...extractRegistryInstalls(readFileSync(file, 'utf16le')));
    } catch {
      // 该根不存在 / reg 不可用：静默跳过
    } finally {
      rmSync(file, { force: true });
    }
  });
  return found;
}

async function windowsRegistryInstallsAsync() {
  if (process.platform !== 'win32') return [];
  const reg = windowsSystemExecutable('reg.exe');
  if (!reg || !existsSync(reg)) return [];
  const stamp = Date.now();
  const batches = await Promise.all(
    WIN_UNINSTALL_ROOTS.map(async (root, i) => {
      const file = join(tmpdir(), `dsh-locate-async-${process.pid}-${stamp}-${i}.reg`);
      try {
        await execFileAsync(reg, ['export', root, file, '/y'], { windowsHide: true, timeout: 5000 });
        return extractRegistryInstalls(await readFile(file, 'utf16le'));
      } catch {
        return [];
      } finally {
        await rm(file, { force: true }).catch(() => {});
      }
    }),
  );
  return batches.flat();
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
  if (exeHint && isHostAbsolute(exeHint) && existsSync(exeHint)) return exeHint;
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
  if (!isHostAbsolute(dir)) return null;
  const asar =
    process.platform === 'darwin' && /\.app$/i.test(dir)
      ? join(dir, 'Contents', 'Resources', 'app.asar')
      : join(dir, 'resources', 'app.asar');
  if (!existsSync(asar)) return null;
  const bin = join(asar, ...DSH_ASAR_ROOT, 'lib', 'bin.js');
  if (!isDshEntry(bin)) return null;
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

function collectDesktopCandidates(registryInstalls) {
  const seen = new Set();
  const out = [];
  const entries = [...registryInstalls, ...defaultDesktopDirs().map((dir) => ({ dir, via: 'default-path' }))];
  for (const e of entries) {
    const k = e.dir.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const c = desktopCandidate(e);
    if (c) out.push(c);
  }
  return out;
}

function desktopCandidates() {
  return collectDesktopCandidates(windowsRegistryInstalls());
}

async function desktopCandidatesAsync() {
  return collectDesktopCandidates(await windowsRegistryInstallsAsync());
}

// ── npm 全局 / npx 缓存 ─────────────────────────────────────────

function nodeCandidate(source, bin) {
  if (!isHostAbsolute(bin) || !isDshEntry(bin)) return null;
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
      Number(a.runtimeOk === false) - Number(b.runtimeOk === false) ||
      cmpVersion(b.version ?? '0.0.0', a.version ?? '0.0.0') ||
      (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0),
  );
}

function assertRuntimeFile(path) {
  if (!isRegularFile(path)) {
    throw Object.assign(
      new Error(L(
        `DSH_RUNTIME 指向的文件不存在、不可访问或不是文件: ${path}`,
        `DSH_RUNTIME does not point to an accessible file: ${path}`,
      )),
      { code: 'DSH_RUNTIME_INVALID' },
    );
  }
}

function cachedDiscovery(runtime, fresh) {
  if (
    !fresh &&
    discoveryCache &&
    discoveryCache.runtime === runtime &&
    Date.now() - discoveryCache.at < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.list;
  }
  return null;
}

/** 自动发现到的全部候选（已排序，第一个就是默认选择）。结果缓存 60 秒。 */
export function discoverDsh({ fresh = false } = {}) {
  const runtime = process.env.DSH_RUNTIME ? resolve(process.env.DSH_RUNTIME) : null;
  if (runtime) assertRuntimeFile(runtime);
  const hit = cachedDiscovery(runtime, fresh);
  if (hit) return hit;
  const raw = [...desktopCandidates(), ...globalCandidates(), ...npxCandidates()];
  const list = rankCandidates(runtime ? applyRuntimeOverride(raw, runtime) : raw);
  discoveryCache = { at: Date.now(), runtime, list };
  return list;
}

/** 异步自动发现（不阻塞事件循环，供常驻进程预热与 dsh_doctor 使用，与同步版共用缓存）。 */
export async function discoverDshAsync({ fresh = false } = {}) {
  const runtime = process.env.DSH_RUNTIME ? resolve(process.env.DSH_RUNTIME) : null;
  if (runtime) assertRuntimeFile(runtime);
  const hit = cachedDiscovery(runtime, fresh);
  if (hit) return hit;
  if (!fresh && inFlightDiscovery?.runtime === runtime) return inFlightDiscovery.promise;
  const run = (async () => {
    const raw = [...(await desktopCandidatesAsync()), ...globalCandidates(), ...npxCandidates()];
    const list = rankCandidates(runtime ? await applyRuntimeOverrideAsync(raw, runtime) : raw);
    discoveryCache = { at: Date.now(), runtime, list };
    return list;
  })();
  const entry = { runtime, promise: run };
  if (!fresh) inFlightDiscovery = entry;
  try {
    return await run;
  } finally {
    if (inFlightDiscovery === entry) inFlightDiscovery = null;
  }
}

function rewriteNodeCandidates(list, runtime, env, runtimeNode) {
  return list.map((c) =>
    c.runtime === 'node'
      ? {
          ...c,
          command: runtime,
          env,
          runtime: 'custom',
          runtimeOk: satisfiesNodeRange(c.enginesNode, runtimeNode),
        }
      : c,
  );
}

/**
 * DSH_RUNTIME 对**自动发现**的候选同样生效（不只是配合 DSH_BIN）：dsh_doctor 在
 * "engines.node 不满足"时建议的正是"用 DSH_RUNTIME 指定一个满足要求的 node" —— 以前只有
 * 显式 DSH_BIN 分支读它，照做之后服务仍用自己的 Node 22 拉起要求 Node 24 的 npm 版 DSH。
 *
 * 只替换 npm 全局 / npx 这类 `node <bin.js>` 候选；桌面版的 CLI 在 app.asar 里，普通 node
 * 读不了，必须用它自带的 Electron 运行时，所以桌面版候选保持不变。替换后用实测的运行时
 * Node 版本重新判定 engines（拿不到版本就记 null = 未知，不当作不满足）。导出供测试。
 */
export function applyRuntimeOverride(list, runtime) {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  const runtimeNode = probeRuntimeNode({ command: runtime, env });
  return rewriteNodeCandidates(list, runtime, env, runtimeNode);
}

/** 异步版本：非阻塞探测自定义运行时 Node 版本并改写 npm/npx 候选。 */
export async function applyRuntimeOverrideAsync(list, runtime) {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  const runtimeNode = await probeRuntimeNodeAsync({ command: runtime, env });
  return rewriteNodeCandidates(list, runtime, env, runtimeNode);
}

/** 显式 DSH_BIN（可选 DSH_RUNTIME）。 */
function explicitDsh(binPath, runtimePath) {
  if (!isDshEntry(binPath)) {
    throw new Error(L(
      `DSH_BIN 指向的文件不存在、不可访问或不是文件: ${binPath}。请更新路径，或删除 DSH_BIN 后重连以恢复自动探测。`,
      `DSH_BIN does not point to an accessible file: ${binPath}. Update the path, or unset DSH_BIN and reconnect to resume auto-discovery.`,
    ));
  }
  const pkg = readDshPackage(binPath);
  const split = splitAsarPath(binPath);
  let command = process.execPath;
  if (runtimePath) {
    assertRuntimeFile(runtimePath);
    command = runtimePath;
  } else if (split) {
    command = desktopExeForAsar(split.asar);
    if (!command) {
      throw new Error(L(
        `DSH_BIN 在 asar 内（${split.asar}），但找不到配套的桌面版可执行文件；请用 DSH_RUNTIME 指定`,
        `DSH_BIN is inside an asar (${split.asar}), but its matching desktop executable was not found; set DSH_RUNTIME explicitly`,
      ));
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

function dshNotFoundError() {
  return new Error(L(
    'DSH CLI 未找到：没有发现 DeepSeek Harness 桌面版、npm 全局安装或 npx 缓存里的 @deepseek-ai/dsh。\n' +
      '  安装桌面版即可自动识别；或 npm i -g @deepseek-ai/dsh；或设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js',
    'DSH CLI not found: no DeepSeek Harness desktop app, global npm install, or npx-cached @deepseek-ai/dsh was detected.\n' +
      '  Install the desktop app for auto-discovery, run `npm i -g @deepseek-ai/dsh`, or set DSH_BIN to @deepseek-ai/dsh/lib/bin.js',
  ));
}

function cachedCandidateStale(selected) {
  const { version, enginesNode } = readDshPackage(selected.bin);
  return version !== selected.version || enginesNode !== selected.enginesNode || !isDshEntry(selected.bin);
}

/**
 * 解析要用的 DSH：`{ bin, command, args, env, version, source, runtime, runtimeOk, ... }`。
 * 拉起方式：`spawn(command, [...args, '--profile', X], { env: { ...process.env, ...env } })`。
 */
export function resolveDsh({ fresh = false } = {}) {
  const explicit = process.env.DSH_BIN;
  if (explicit) {
    // The child may run in another workspace. Resolve configured paths in the server before spawning it.
    const runtime = process.env.DSH_RUNTIME;
    return explicitDsh(resolve(explicit), runtime ? resolve(runtime) : null);
  }
  let [selected] = discoverDsh({ fresh });
  if (selected && !fresh && cachedCandidateStale(selected)) {
    // A desktop update or npm replacement can change the entry at the cached path.
    [selected] = discoverDsh({ fresh: true });
  }
  if (selected) return selected;
  throw dshNotFoundError();
}

/** 异步解析 DSH（不阻塞事件循环，与 resolveDsh 共用发现缓存）。 */
export async function resolveDshAsync({ fresh = false } = {}) {
  const explicit = process.env.DSH_BIN;
  if (explicit) {
    const runtime = process.env.DSH_RUNTIME;
    return explicitDsh(resolve(explicit), runtime ? resolve(runtime) : null);
  }
  let [selected] = await discoverDshAsync({ fresh });
  if (selected && !fresh && cachedCandidateStale(selected)) {
    [selected] = await discoverDshAsync({ fresh: true });
  }
  if (selected) return selected;
  throw dshNotFoundError();
}

/** 实测某个运行时的 Node 版本（体检用；约 0.2s，结果缓存）。 */
const runtimeNodeCache = new Map();
export function probeRuntimeNode(c) {
  if (c.command === process.execPath) return process.versions.node;
  const key = `${c.command}|${JSON.stringify(c.env)}`;
  try {
    const st = statSync(c.command, { throwIfNoEntry: false });
    if (!st?.isFile()) return null;
    const cached = runtimeNodeCache.get(key);
    if (cached && cached.modified === st.mtimeMs && cached.size === st.size) return cached.version;
    const r = spawnSync(c.command, ['-e', 'process.stdout.write(process.versions.node)'], {
      env: { ...process.env, ...c.env },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    const version = /^\d+\.\d+\.\d+/.test(r.stdout ?? '') ? r.stdout.trim() : null;
    if (version) runtimeNodeCache.set(key, { modified: st.mtimeMs, size: st.size, version });
    return version;
  } catch {
    return null;
  }
}

/** 异步实测运行时的 Node 版本（不阻塞事件循环，与 probeRuntimeNode 共用缓存）。 */
export async function probeRuntimeNodeAsync(c) {
  if (c.command === process.execPath) return process.versions.node;
  const key = `${c.command}|${JSON.stringify(c.env)}`;
  try {
    const st = await stat(c.command).catch(() => null);
    if (!st?.isFile()) return null;
    const cached = runtimeNodeCache.get(key);
    if (cached && cached.modified === st.mtimeMs && cached.size === st.size) return cached.version;
    const { stdout } = await execFileAsync(c.command, ['-e', 'process.stdout.write(process.versions.node)'], {
      env: { ...process.env, ...c.env },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    const version = /^\d+\.\d+\.\d+/.test(stdout ?? '') ? stdout.trim() : null;
    if (version) runtimeNodeCache.set(key, { modified: st.mtimeMs, size: st.size, version });
    return version;
  } catch {
    return null;
  }
}
