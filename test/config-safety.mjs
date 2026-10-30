/**
 * 配置安全测试矩阵：证明 setup 只增删它自己写进客户端配置的那一条。
 *
 * 用户的底线是「注册 / 删除 MCP 时不许破坏客户端原有的配置」。所以这里的
 * 每一条断言都围绕「影响范围」而不是「文件写对了」：
 *   1) 计划模式一个字节都不写，也不产生 .bak；
 *   2) 注册再删除之后，别人的 MCP 条目、顶层键、键顺序原样；
 *   3) 缩进 / 单行 / 无尾随换行 / CRLF / BOM 等格式原样保留；
 *   4) 坏 JSON、只读文件、空文件、缺目录 —— 拒绝或安全创建，绝不破坏原文；
 *   5) Codex 的 TOML 注释、顶层键、其它表、CRLF 全保留；
 *   6) 连续两次 --yes 第二次不写、不新增 .bak；
 *   7) 删除不存在的条目：不写盘、退出码 0；
 *   8) 每个客户端的 .bak-dsh-<stamp> 只出现一次，内容等于写入前原文。
 * v2 补充（lead 已核对真机路径与 --force 语义之后）：
 *   11) opencode 条目形状：type=local、command 是数组、enabled=true；
 *   12) vscode 写 servers 容器，且不污染同目录的 settings.json；
 *   13) claude-code 走 ~/.claude.json 的文本级定点编辑（不是 claude mcp CLI）：只增删自己
 *       那条、projects 大映射与顶层键逐字节不变、删除后整文件还原；CLI 在不在 PATH 上
 *       都不得报 failed，且只有 CLI 存在时才允许在 summary 里出现 'confirmed by claude mcp get'；
 *   14) 幂等矩阵扩展到全部 9 个客户端；
 *   15) 真实 HOME 只读回归：plan 模式覆盖全部已存在客户端，size+mtime 与备份名单都不变。
 *
 * 两条硬约束（和 sandbox-home.mjs 的由来同源：2026-10-29 那次事故把真实
 * HOME 当成沙箱删了一部分）：
 *   - 沙箱目录只能由 makeSandboxHome 产生、只能由 removeSandbox 销毁；
 *   - 任何要写的路径都必须落在沙箱内，写之前断言，越界立刻抛错。
 * 另外每个子进程都同时拿到 --home 和 HOME/USERPROFILE/APPDATA 覆盖，
 * 并在开头/结尾对真实 HOME 下的客户端配置做一次 size+mtime 快照对比。
 *
 * 契约（已冻结）：
 *   node bin/setup.mjs [--yes] [--remove] [--only <id,...>] [--all]
 *                      [--permission <p>] [--json] [--force] [--home <dir>]
 *   --json 时 stdout 是单个 JSON 对象
 *   {ok, mode, clients:[{id,label,path,status,summary,error?}], changed, skipped, failed}
 *   客户端 id：claude-code, claude-desktop, codex, cursor, windsurf, zed,
 *             gemini, opencode, vscode
 * 实现还没跟上契约时，测试会失败（而不是跳过），但绝不会碰真实 HOME。
 */

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, chmodSync, statSync,
} from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeSandboxHome, removeSandbox, realHome } from './sandbox-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'bin', 'setup.mjs');
const NODE = process.execPath;
const FAKE_DSH_BIN = '/fake/dsh/bin.js';

const CLIENT_IDS = [
  'claude-code', 'claude-desktop', 'codex', 'cursor', 'windsurf',
  'zed', 'gemini', 'opencode', 'vscode',
];
/** 以 JSON 文件承载 MCP 配置的客户端；codex 是 TOML，单独测。 */
const JSON_CLIENTS = ['claude-desktop', 'cursor', 'windsurf', 'zed', 'gemini', 'opencode', 'vscode'];

/** 实现没有在 --json 里给出 path 时的兜底猜测（只为让测试能跑，失败会明说）。 */
const CANDIDATES = {
  'claude-code': ['.claude.json'],
  'claude-desktop': ['Claude/claude_desktop_config.json'],
  codex: ['.codex/config.toml'],
  cursor: ['.cursor/mcp.json'],
  windsurf: ['.codeium/windsurf/mcp_config.json'],
  zed: ['Zed/settings.json'],
  gemini: ['.gemini/settings.json'],
  opencode: ['.config/opencode/opencode.json'],
  vscode: ['Code/User/mcp.json'],
};

/**
 * 真实 HOME 下的客户端配置（只读回归用）。
 * 前 6 个在 HOME 内；其余在 APPDATA 内 —— Windows 上 <APPDATA> 就是 HOME，
 * 但真实机器上 APPDATA 不等于 HOME（homedir() 却等于 USERPROFILE），
 * 所以这里两套都列上，路径按平台拼。
 */
const HOME_REL_REAL = {
  'claude-code': '.claude.json',
  'claude-desktop': 'Claude/claude_desktop_config.json',
  codex: '.codex/config.toml',
  cursor: '.cursor/mcp.json',
  windsurf: '.codeium/windsurf/mcp_config.json',
  zed: 'Zed/settings.json',
  gemini: '.gemini/settings.json',
  opencode: '.config/opencode/opencode.json',
  vscode: 'Code/User/mcp.json',
};
/** Windows 上这些客户端在 %APPDATA% 下，不在 USERPROFILE 下。 */
const APPDATA_REL = new Set(['claude-desktop', 'zed', 'vscode']);
const REAL_APPDATA = process.env.APPDATA || join(realHome(), 'AppData', 'Roaming');
function realClientPath(id) {
  const rel = HOME_REL_REAL[id];
  if (!rel) return null;
  const base = process.platform === 'win32' && APPDATA_REL.has(id) ? REAL_APPDATA : realHome();
  return join(base, ...rel.split('/'));
}
/** 兜底猜测（实现没给 path 时用），只为让测试能跑。 */
const SANDBOX_APPDATA = realClientPath('zed') ? join(realHome(), 'AppData', 'Roaming') : null;

/** 当前身份是否无视文件权限位（CI 的 Linux runner 以 root 运行）。 */
function isPrivileged() {
  if (process.platform !== 'win32') {
    // geteuid 只在 POSIX 上存在；拿不到就按普通用户处理。
    try { return process.geteuid() === 0; } catch { return false; }
  }
  return false;
}

/** 沙箱里 APPDATA 的位置：真实布局一致时直接用 <home>，否则用 <home>/AppData/Roaming。 */
function sandboxAppData(home, id) {
  const p = realClientPath(id);
  if (!p) return join(home, 'AppData', 'Roaming');
  if (isInside(home, p)) return home;
  return join(home, 'AppData', 'Roaming');
}

/** 各客户端放 MCP 条目的容器键：探测失败时用作兜底。 */
const CONTAINERS = {
  'claude-code': 'mcpServers',
  'claude-desktop': 'mcpServers',
  cursor: 'mcpServers',
  windsurf: 'mcpServers',
  zed: 'context_servers',
  gemini: 'mcpServers',
  opencode: 'mcp',
  vscode: 'servers',
};

/** 每个客户端配置文件里另外真实存在的顶层键，用来验证顶层键不被改动。 */
const EXTRA_TOP = {
  zed: { theme: 'One Dark', vim_mode: true, languages: { Python: { 'format_on_save': 'off' } } },
  gemini: { theme: 'Default', selectedAuthType: 'oauth-personal' },
  'claude-desktop': { globalShortcut: 'Ctrl+Space' },
  opencode: { '$schema': 'https://opencode.ai/config.json' },
};

// ── 断言与输出 ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};
const firstLine = (s) => {
  const line = String(s || '').split(/\r?\n/).find((l) => l.trim() !== '') || '';
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
};
const preview = (s) => {
  if (s === null || s === undefined) return String(s);
  const one = String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return one.length > 90 ? one.slice(0, 90) + '…' : one;
};
/** 第一个不同的位置，失败时比整段文本好读。 */
const diffPreview = (expected, actual) => {
  if (actual === null || actual === undefined) return 'file is missing';
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  const ctx = (s) => preview(s.slice(Math.max(0, i - 20), i + 40));
  return 'first diff at ' + i + ' expected~' + ctx(expected) + ' actual~' + ctx(actual);
};

function section(title, fn) {
  console.log('\n' + title);
  try { fn(); } catch (e) {
    check(title + ' —— 未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
  }
}

// ── 沙箱 HOME：只能由 sandbox-home.mjs 生产/销毁 ─────────────────────

const HOMES = [];
function sandbox(files = {}) {
  const home = makeSandboxHome('dsh-cfgsafe-', files);
  HOMES.push(home);
  return home;
}
function dropSandbox(home) {
  try { removeSandbox(home); } catch (e) { console.log('  ! 沙箱清理失败: ' + home + ' ' + e.message); }
  const i = HOMES.indexOf(home);
  if (i >= 0) HOMES.splice(i, 1);
}
function cleanupAll() {
  while (HOMES.length) dropSandbox(HOMES[0]);
}

const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
function isInside(parent, child) {
  const a = norm(resolve(parent));
  const b = norm(resolve(child));
  if (a === b) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}
/** 写文件前最后一道闸：越界就抛错，绝不落到真实 HOME。 */
function assertInsideSandbox(home, p, what) {
  if (!isInside(home, p)) throw new Error('refusing to ' + what + ' outside the sandbox: ' + p);
}

// ── CLI 调用 ─────────────────────────────────────────────────────────

function run(home, args = [], extraEnv = {}) {
  const r = spawnSync(NODE, [SETUP, '--home', home, ...args], {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      DSH_BIN: FAKE_DSH_BIN,
      DSH_MCP_LOG: 'silent',
      ...extraEnv,
    },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return {
    code: r.status,
    signal: r.signal,
    spawnError: r.error ? r.error.message : null,
    stdout,
    stderr,
    out: stdout + stderr,
  };
}

/** --json 契约：stdout 必须是单个 JSON 对象（日志可以走 stderr）。 */
function runJson(home, args = [], extraEnv = {}) {
  const r = run(home, [...args, '--json'], extraEnv);
  const text = (r.stdout || '').trim();
  let data = null;
  let error = '';
  if (!text) error = 'stdout 为空';
  else {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) data = v;
      else error = 'stdout 不是 JSON 对象';
    } catch (e) { error = 'stdout 不是合法 JSON: ' + e.message; }
  }
  return { ...r, json: data, jsonError: error };
}

// ── 文件工具 ─────────────────────────────────────────────────────────

const readText = (p) => {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; }
};
/** JSON 里带 BOM 是合法的 UTF-8，但 JSON.parse 不认，所以先剥。 */
function safeParse(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
}
const backupsIn = (dir) => {
  try { return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('.bak-dsh-')) : []; } catch { return []; }
};
const tempsIn = (dir) => {
  try { return existsSync(dir) ? readdirSync(dir).filter((f) => /\.tmp-dsh-/.test(f)) : []; } catch { return []; }
};
function seedText(home, p, text) {
  assertInsideSandbox(home, p, 'write');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}
/** 整棵沙箱树的内容快照，用来断言「计划模式什么都没创建」。 */
function snapshotTree(root) {
  const map = new Map();
  const walk = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { map.set(relative(root, p), readFileSync(p)); } catch { map.set(relative(root, p), null); } }
    }
  };
  walk(root);
  return map;
}
function diffTree(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) && !before.get(k).equals(after.get(k)));
  return { added, removed, changed };
}
/** 去掉字符串字面量之外的空白，用来做「除空白外逐字节相同」的比对。 */
function stripWs(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of String(text)) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') continue;
    out += ch;
  }
  return out;
}
/**
 * 从对象成员的**原文本**里摘掉一个键，只做文本级删除，不构造值对象。
 * 用于 /^\.claude\.json$ 这类「projects 里存在大小写重复键」的真实文件：
 * JSON.parse 会因重复键静默丢数据，而实现的扫描器不做值构造，所以测试也必须
 * 只用文本手段，双方口径才能对上。
 */
function stripMemberInObjectText(text, key, depth) {
  const body = text.slice(depth, text.lastIndexOf('}'));
  const needle = JSON.stringify(key) + ':';
  const at = body.indexOf(needle);
  if (at < 0) return null;
  const valueStart = at + needle.length;
  let d = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = valueStart; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') {
      d--;
      if (d < 0) break;
      if (d === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  let rest = body.slice(end);
  const tail = /^[ \t]*\r?\n[ \t]*/.exec(rest);
  if (rest[0] === ',') rest = rest.slice(1);
  else if (tail && rest[tail[0].length - 1] !== undefined) {
    // 本条目是最后一个：连它前面那个逗号一起摘掉
    const head = body.slice(0, at);
    const back = /,\s*$/.exec(head);
    if (!back) return null;
    return text.slice(0, depth) + head.slice(0, back.index) + rest + text.slice(text.lastIndexOf('}'));
  }
  return text.slice(0, depth) + body.slice(0, at) + rest + text.slice(text.lastIndexOf('}'));
}

/**
 * 只看文本、不构造值对象，所以大小写重复键不会像 JSON.parse 那样被吞掉。
 * 用来验「projects 里那几个键（含重复的 Rust/rust）都还在」。
 */
function dupKeysOf(text) {
  const out = String(text || '').match(/"[^"]*\/code\/[Rr]ust"/g) || [];
  return out.map((s) => s.slice(1, -1));
}
function containsAll(haystack, needles) {
  return needles.every((n) => String(haystack || '').includes(n));
}
function indentOfLineContaining(text, needle) {
  if (typeof text !== 'string' || !text.includes(needle)) return null;
  const line = text.split(/\r?\n/).find((l) => l.includes(needle));
  if (line === undefined) return null;
  return (/^[ \t]*/.exec(line) || [''])[0];
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nonEmptyLines(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => l.replace(/[ \t]+$/, ''));
}
function countBareLf(text) {
  const all = (String(text).match(/\n/g) || []).length;
  const crlf = (String(text).match(/\r\n/g) || []).length;
  return all - crlf;
}

/**
 * after 相对 before 新增了哪些条目。
 * 不写死「容器叫 mcpServers」「我们这条叫 dsh-any-agent」，因为契约只冻结了
 * 客户端 id，没冻结容器键/条目名；逐层比对才能既严格又不误判。
 */
function addedEntries(beforeObj, afterObj) {
  const entries = [];
  const containers = [];
  const before = beforeObj && typeof beforeObj === 'object' ? beforeObj : {};
  const after = afterObj && typeof afterObj === 'object' ? afterObj : {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  for (const k of Object.keys(after)) {
    const v = after[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const b = before[k] && typeof before[k] === 'object' && !Array.isArray(before[k]) ? before[k] : {};
    for (const kk of Object.keys(v)) {
      if (!has(b, kk)) entries.push({ container: k, key: kk, value: v[kk] });
    }
    if (!has(before, k)) containers.push(k);
  }
  return { entries, containers };
}

// ── 路径：优先用 --json 报告的 path，结构映射到本次沙箱 ───────────────

/**
 * 客户端的配置文件放在沙箱的哪个位置。
 *
 * 测试不写死「APPDATA 到底是 <home> 还是 <home>/AppData/Roaming」——那是实现
 * 的布局选择，不是安全不变量。这里把 id 相对「真实 HOME」和「真实 APPDATA」
 * 两种基准都算出来，优先用 --json 报告的 path 结构映射，映射不了就**两个
 * 位置都写一份种子**（带别的 MCP 条目），实现写哪份都能被检验；两处都没被
 * 写过则由断言如实报错。
 */
const PROBE_HOME = sandbox({});
const REPORTED = new Map();

function sandboxPathsFor(id, home) {
  const cands = CANDIDATES[id] || [];
  if (!cands.length) return [join(home, '.' + id, 'config.json')];
  const rel = cands[0].split('/');
  const out = [join(home, ...rel)];
  if (process.platform === 'win32' && APPDATA_REL.has(id)) out.push(join(home, 'AppData', 'Roaming', ...rel));
  return [...new Set(out)];
}

function resolvePaths(id, home) {
  const reported = REPORTED.get(id);
  if (typeof reported === 'string' && reported) {
    if (!isAbsolute(reported)) return [join(home, reported)];
    if (isInside(home, reported)) return [reported];
    const rel = relative(PROBE_HOME, reported);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return [join(home, rel)];
    // 越界（可能是真实 HOME 的路径）：绝不复用，走兜底并让探测断言报错。
  }
  return sandboxPathsFor(id, home);
}
/** 用来「种子」的位置：报告路径优先，否则所有可能的布局位置都种上。 */
function seedPaths(id, home) {
  return REPORTED.has(id) ? resolvePaths(id, home) : sandboxPathsFor(id, home);
}
/** 断言/读取用的主路径：报告路径优先，否则第一个布局位置。 */
function resolvePath(id, home) {
  return resolvePaths(id, home)[0];
}
/** 在这个客户端的候选路径里，挑出实际发生了变化的那一个。 */
function pickChangedPath(id, home, baseline) {
  for (const p of resolvePaths(id, home)) {
    if (sandboxHasChange(home, p, baseline)) return p;
  }
  return resolvePaths(id, home)[0];
}
function sandboxHasChange(home, p, baseline) {
  if (!isInside(home, p)) return false;
  const now = readText(p);
  if (now !== null) return now !== baseline;
  return true;
}
const containerOf = (id) => (DISC.get(id) && DISC.get(id).container) || CONTAINERS[id] || 'mcpServers';

// 真实 HOME 快照：测试根本不该碰它，碰了就说明 HOME 隔离失效。
function realHomeSnapshot() {
  const map = new Map();
  for (const id of CLIENT_IDS) {
    const p = realClientPath(id);
    if (!p) continue;
    try {
      const st = statSync(p);
      map.set(p, st.size + ':' + st.mtimeMs);
    } catch { /* 不存在就算了 */ }
  }
  return map;
}
/**
 * 真实 HOME 下已有的 .bak-dsh-* 名单。
 * 真机上前人跑 setup 留下的历史备份是正常存量，不是本次回归造成的；
 * 只能断言「名单没有新增」，不能断言「一个都没有」。
 */
function realBackupSnapshot() {
  const set = new Set();
  for (const id of CLIENT_IDS) {
    const p = realClientPath(id);
    if (!p) continue;
    for (const f of backupsIn(dirname(p))) set.add(join(dirname(p), f));
  }
  return set;
}
const REAL_BEFORE = realHomeSnapshot();
const REAL_BAK_BEFORE = realBackupSnapshot();

// ══════════════════════════════════════════════════════════════════════
// [0] CLI 契约探测
// ══════════════════════════════════════════════════════════════════════

section('[0] CLI 契约：--json 单个对象 / 9 个客户端 / path 在沙箱内', () => {
  check('bin/setup.mjs 存在', existsSync(SETUP), SETUP);

  const r = runJson(PROBE_HOME, ['--only', 'cursor']);
  check('计划模式 + --json 退出码 0', r.code === 0, 'exit ' + r.code + ' signal=' + r.signal + ' ' + firstLine(r.out));
  check('--json 在 stdout 输出单个 JSON 对象', Boolean(r.json), r.jsonError + ' | ' + firstLine(r.stdout));
  if (!r.json) return;

  const need = ['ok', 'mode', 'clients', 'changed', 'skipped', 'failed'];
  const missingKeys = need.filter((k) => !(k in r.json));
  check('--json 顶层含 ' + need.join(' / '), missingKeys.length === 0, '缺少 ' + missingKeys.join(','));
  check('--json.mode 是非空字符串', typeof r.json.mode === 'string' && r.json.mode.length > 0, preview(r.json.mode));

  const clients = Array.isArray(r.json.clients) ? r.json.clients : [];
  const ids = new Set(clients.map((c) => c && c.id));
  const missingIds = CLIENT_IDS.filter((id) => !ids.has(id));
  check('clients 覆盖 9 个客户端 id', missingIds.length === 0, '缺少 ' + missingIds.join(','));

  const badPath = clients.filter((c) => c && c.path && !isInside(PROBE_HOME, c.path));
  check('每个客户端 path 都落在沙箱 home 内（越界=会写真实配置）', badPath.length === 0,
    badPath.map((c) => c.id + '=' + c.path).join(' '));

  const badStatus = clients.filter((c) => c && (typeof c.status !== 'string' || !c.status));
  check('每个客户端都有非空 status', badStatus.length === 0, badStatus.map((c) => c.id).join(','));

  const okShape = clients.every((c) => c && typeof c.id === 'string' && typeof c.label === 'string');
  check('每个客户端都有 id 与 label', okShape);

  for (const c of clients) if (c && typeof c.path === 'string' && c.path) REPORTED.set(c.id, c.path);

  const tree = snapshotTree(PROBE_HOME);
  check('探测本身没有写盘', tree.size === 0 || [...tree.keys()].every((k) => !k.includes('.bak-dsh-')),
    [...tree.keys()].join(','));
});

// ══════════════════════════════════════════════════════════════════════
// [0b] 每个 JSON 客户端：先探出它自己的容器键与条目名
// ══════════════════════════════════════════════════════════════════════

const DISC = new Map();
for (const id of JSON_CLIENTS) {
  DISC.set(id, { ok: false, container: CONTAINERS[id], key: null, error: 'not run' });
}

section('[0b] 每个 JSON 客户端都能注册出唯一新条目（据此确定容器键）', () => {
  for (const id of JSON_CLIENTS) {
    const home = sandbox({});
    let info = { ok: false, container: CONTAINERS[id], key: null, error: '' };
    try {
      // 报告路径优先；否则逐个布局位置试（用一个新沙箱跑一遍），全失败才算失败。
      const cands = seedPaths(id, home);
      let after = null;
      let r = null;
      let p = cands[0];
      for (const cand of cands) {
        seedText(home, cand, '{}\n');
        const rr = run(home, ['--yes', '--only', id]);
        const got = readText(cand);
        if (!rr.spawnError && rr.code === 0 && got !== null && got !== '{}\n' && got !== '{}') {
          p = cand; after = got; r = rr; break;
        }
        r = rr;
      }
      if (!after) {
        const got = readText(cands[0]);
        info.error = '没有新条目（exit ' + (r ? r.code : '?') + '，客户端可能被跳过；试过 ' +
          cands.join(' / ') + '；输出=' + (r ? firstLine(r.out) : '') + '；内容=' + preview(got) + '）';
      }
      else if (r.spawnError) info.error = 'spawn: ' + r.spawnError;
      else if (r.code !== 0) info.error = 'exit ' + r.code + ' ' + firstLine(r.out);
      else {
        const parsed = safeParse(after);
        if (!parsed) info.error = '写出的文件不是合法 JSON: ' + preview(after);
        else {
          const added = addedEntries({}, parsed);
          if (added.entries.length !== 1) info.error = '新增条目数=' + added.entries.length;
          else {
            info.ok = true;
            info.container = added.entries[0].container;
            info.key = added.entries[0].key;
            info.shape = added.entries[0].value;
          }
        }
      }
    } catch (e) {
      info.error = 'threw: ' + (e && e.message ? e.message : String(e));
    }
    DISC.set(id, info);
    check(id + ': 注册出恰好一个新条目', info.ok, info.error);
    if (info.ok) {
      const v = info.shape || {};
      // 三种形状都是契约，不是笔误：
      //   default  → { command: "exe", args: [...] }
      //   opencode → { command: ["exe", ...args], type: 'local' }
      //   zed      → { command: { path: "exe", args: [...], env } }
      const stringShape = typeof v.command === 'string' && v.command.length > 0 && Array.isArray(v.args);
      const arrayShape = Array.isArray(v.command) && v.command.length > 0 && typeof v.command[0] === 'string';
      const nestedShape = Boolean(v.command) && typeof v.command === 'object' && !Array.isArray(v.command)
        && typeof v.command.path === 'string' && v.command.path.length > 0 && Array.isArray(v.command.args);
      check(id + ': 条目含可执行命令（字符串+args / command 数组 / {path,args}）',
        stringShape || arrayShape || nestedShape, preview(JSON.stringify(v)));
      if (id === 'zed') {
        check('zed: command 是 {path,args} 对象', nestedShape, preview(JSON.stringify(v.command)));
        check('zed: command.path 指向真实存在的可执行文件',
          Boolean(v.command && v.command.path && existsSync(v.command.path)),
          preview(v.command && v.command.path));
      }
    }
    dropSandbox(home);
  }
});

const USABLE = JSON_CLIENTS.filter((id) => DISC.get(id) && DISC.get(id).ok);
const FORMAT_ID = ['cursor', 'windsurf', 'zed', 'gemini', 'claude-desktop', 'vscode', 'opencode']
  .find((id) => DISC.get(id) && DISC.get(id).ok) || null;

// ══════════════════════════════════════════════════════════════════════
// [1] 计划模式：一个字节都不写
// ══════════════════════════════════════════════════════════════════════

section('[1] 计划模式（无 --yes）：字节不变、无 .bak、无新文件', () => {
  const targets = (USABLE.length ? USABLE : JSON_CLIENTS).slice(0, 3);
  for (const id of targets) {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const original = JSON.stringify({
      ...(EXTRA_TOP[id] || {}),
      [containerOf(id)]: { alpha: { command: 'alpha', args: ['--x'] } },
    }, null, 2) + '\n';
    seedText(home, p, original);
    const beforeTree = snapshotTree(home);

    const plan = run(home, ['--only', id]);
    const afterTree = snapshotTree(home);
    const d = diffTree(beforeTree, afterTree);

    check(id + ': 计划模式退出码 0', plan.code === 0, 'exit ' + plan.code + ' ' + firstLine(plan.out));
    check(id + ': 计划模式文件字节不变', readText(p) === original, diffPreview(original, readText(p)));
    check(id + ': 计划模式没有创建任何文件', d.added.length === 0, d.added.join(','));
    check(id + ': 计划模式没有删除任何文件', d.removed.length === 0, d.removed.join(','));
    check(id + ': 计划模式没有改动任何文件', d.changed.length === 0, d.changed.join(','));
    check(id + ': 计划模式没有 .bak', [...afterTree.keys()].filter((k) => k.includes('.bak-dsh-')).length === 0);
    check(id + ': 计划模式没有临时文件残留', tempsIn(dirname(p)).length === 0, tempsIn(dirname(p)).join(','));

    // 已经写过之后再计划 --remove，同样不许动盘。
    const applied = run(home, ['--yes', '--only', id]);
    const afterApply = readText(p);
    const beforeRemoveTree = snapshotTree(home);
    const planRemove = run(home, ['--remove', '--only', id]);
    const afterRemoveTree = snapshotTree(home);
    const dr = diffTree(beforeRemoveTree, afterRemoveTree);

    check(id + ': 写入成功（计划删除的前置）', applied.code === 0 && afterApply !== original,
      'exit ' + applied.code + ' ' + firstLine(applied.out));
    check(id + ': 计划 --remove 退出码 0', planRemove.code === 0, 'exit ' + planRemove.code + ' ' + firstLine(planRemove.out));
    check(id + ': 计划 --remove 文件字节不变', readText(p) === afterApply, diffPreview(afterApply, readText(p)));
    check(id + ': 计划 --remove 没有创建/删除文件', dr.added.length === 0 && dr.removed.length === 0,
      'added=' + dr.added.join(',') + ' removed=' + dr.removed.join(','));

    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [2] 注册再删除：别人的条目、顶层键、键顺序原样
// ══════════════════════════════════════════════════════════════════════

section('[2] 注册再删除：其它条目逐字节相同、顶层键与键序不变', () => {
  for (const id of USABLE) {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const container = containerOf(id);
    const others = {
      alpha: { command: 'alpha-bin', args: ['--flag', 'value with spaces'], env: { KEY: 'v' } },
      beta: { command: 'beta-bin', args: [] },
      'gamma-mcp': { command: 'gamma', args: ['--n', '1'], disabled: false },
    };
    const original = { ...(EXTRA_TOP[id] || {}), [container]: others };
    const beforeText = JSON.stringify(original, null, 2) + '\n';
    seedText(home, p, beforeText);

    const rAdd = run(home, ['--yes', '--only', id]);
    const afterText = readText(p);
    const afterObj = safeParse(afterText || '');
    const added = afterObj ? addedEntries(original, afterObj) : { entries: [] };

    check(id + ': 注册退出码 0', rAdd.code === 0, 'exit ' + rAdd.code + ' ' + firstLine(rAdd.out));
    check(id + ': 写入后仍是合法 JSON', Boolean(afterObj), preview(afterText));
    check(id + ': 恰好新增一个条目', added.entries.length === 1, JSON.stringify(added.entries.map((e) => e.key)));
    check(id + ': 新条目落在原有容器里', added.entries.length === 1 && added.entries[0].container === container,
      added.entries.map((e) => e.container).join(','));

    if (afterObj) {
      const bag = afterObj[container] || {};
      const sameValues = Object.keys(others).every((k) => JSON.stringify(bag[k]) === JSON.stringify(others[k]));
      check(id + ': 其它条目逐字节相同（值序列化一致）', sameValues, preview(JSON.stringify(bag)));
      const ourKey = added.entries.length === 1 ? added.entries[0].key : null;
      check(id + ': 其它条目键序不变（新条目追加在末尾）',
        Object.keys(bag).filter((k) => k !== ourKey).join(',') === Object.keys(others).join(','),
        Object.keys(bag).join(','));
      check(id + ': 顶层键与键序不变',
        Object.keys(afterObj).join(',') === Object.keys(original).join(','),
        Object.keys(afterObj).join(',') + ' vs ' + Object.keys(original).join(','));
      // 文本级：原有每一行的缩进与内容都还在（行尾逗号可能因插入而变，去掉后比）。
      const missingLines = beforeText.split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => l.replace(/,[ \t]*$/, ''))
        .filter((l) => !afterText.includes(l));
      check(id + ': 原有每一行（含缩进）仍逐字节存在', missingLines.length === 0,
        JSON.stringify(missingLines.slice(0, 2)));
    }

    const rRm = run(home, ['--remove', '--yes', '--only', id]);
    const restoredText = readText(p);
    const restoredObj = safeParse(restoredText || '');

    check(id + ': 删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
    check(id + ': 删除后我们的条目消失', restoredObj ? !Object.keys(restoredObj[container] || {}).includes(added.entries[0] ? added.entries[0].key : '\u0000') : false,
      preview(restoredText));
    check(id + ': 删除后整文件逐字节还原', restoredText === beforeText, diffPreview(beforeText, restoredText));
    check(id + ': 删除后除空白外完全一致', restoredText !== null && stripWs(restoredText) === stripWs(beforeText));
    check(id + ': 删除后其它条目仍是原对象',
      restoredObj ? JSON.stringify(restoredObj[container]) === JSON.stringify(others) : false,
      restoredObj ? preview(JSON.stringify(restoredObj[container])) : 'null');

    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [3] 格式保留矩阵
// ══════════════════════════════════════════════════════════════════════

section('[3] 格式保留：4空格 / 2空格 / 单行 / 无尾随换行 / CRLF / BOM', () => {
  if (!FORMAT_ID) {
    check('存在可用的 JSON 客户端做格式矩阵', false, '没有客户端注册成功（见 [0b]）');
    return;
  }
  const container = containerOf(FORMAT_ID);
  const body = { alpha: { command: 'alpha', args: [] }, beta: { command: 'beta', args: ['-x'] } };
  const root = { ...(EXTRA_TOP[FORMAT_ID] || {}), [container]: body };

  const cases = [
    {
      name: '4 空格缩进',
      text: JSON.stringify(root, null, 4) + '\n',
      verify: (t) => indentOfLineContaining(t, '"alpha"') === '        '
        && indentOfLineContaining(t, '"' + container + '"') === '    ',
    },
    {
      name: '2 空格缩进',
      text: JSON.stringify(root, null, 2) + '\n',
      verify: (t) => indentOfLineContaining(t, '"alpha"') === '    '
        && indentOfLineContaining(t, '"' + container + '"') === '  ',
    },
    { name: '单行 JSON', text: JSON.stringify(root), verify: (t) => !/[\r\n]/.test(t) },
    { name: '无尾随换行', text: JSON.stringify(root, null, 2), verify: (t) => !/[\r\n]$/.test(t) },
    {
      name: 'CRLF 行尾',
      text: JSON.stringify(root, null, 2).replace(/\n/g, '\r\n') + '\r\n',
      verify: (t) => countBareLf(t) === 0 && t.includes('\r\n'),
    },
    {
      name: 'UTF-8 BOM',
      text: '\uFEFF' + JSON.stringify(root, null, 2) + '\n',
      verify: (t) => t.startsWith('\uFEFF'),
    },
  ];

  for (const c of cases) {
    const home = sandbox({});
    const p = resolvePath(FORMAT_ID, home);
    seedText(home, p, c.text);

    const rAdd = run(home, ['--yes', '--only', FORMAT_ID]);
    const afterAdd = readText(p);
    const parsed = safeParse(afterAdd || '');

    check(c.name + '：注册退出码 0', rAdd.code === 0, 'exit ' + rAdd.code + ' ' + firstLine(rAdd.out));
    check(c.name + '：格式标记保留', rAdd.code === 0 && afterAdd !== null && c.verify(afterAdd), preview(afterAdd));
    check(c.name + '：其它条目仍旧原样',
      parsed ? JSON.stringify(parsed[container] && parsed[container].alpha) === JSON.stringify(body.alpha)
        && JSON.stringify(parsed[container] && parsed[container].beta) === JSON.stringify(body.beta) : false,
      parsed ? preview(JSON.stringify(parsed[container])) : 'not JSON');
    check(c.name + '：新增条目没有把别的键挤掉',
      parsed ? Object.keys(parsed[container] || {}).length === 3 : false,
      parsed ? Object.keys(parsed[container] || {}).join(',') : 'not JSON');
    check(c.name + '：写入前有且只有一个 .bak', backupsIn(dirname(p)).length === 1, backupsIn(dirname(p)).join(','));

    const rRm = run(home, ['--remove', '--yes', '--only', FORMAT_ID]);
    const afterRm = readText(p);
    check(c.name + '：删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
    check(c.name + '：删除后逐字节还原原文', afterRm === c.text, diffPreview(c.text, afterRm));
    check(c.name + '：删除后除空白外一致', afterRm !== null && stripWs(afterRm) === stripWs(c.text));

    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [4] 坏 JSON / 只读 / 空文件 / 缺目录
// ══════════════════════════════════════════════════════════════════════

section('[4] 坏 JSON / 只读 / 空文件 / 缺目录：拒绝或安全创建，原文不破', () => {
  const id = FORMAT_ID || 'cursor';
  const container = containerOf(id);

  // 4.1 坏 JSON
  {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const broken = '{ "' + container + '": { this is not json }';
    seedText(home, p, broken);
    const beforeTree = snapshotTree(home);
    const r = runJson(home, ['--yes', '--only', id]);
    const afterText = readText(p);
    const afterTree = snapshotTree(home);
    const d = diffTree(beforeTree, afterTree);

    check('坏 JSON：退出码非 0', r.code !== 0 && r.code !== null, 'exit ' + r.code);
    check('坏 JSON：原文件逐字节不变', afterText === broken, diffPreview(broken, afterText));
    check('坏 JSON：没有产生 .bak', backupsIn(dirname(p)).length === 0, backupsIn(dirname(p)).join(','));
    check('坏 JSON：没有动其它文件', d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0,
      'added=' + d.added.join(',') + ' changed=' + d.changed.join(','));
    if (r.json) {
      check('坏 JSON：--json 报告失败', r.json.failed >= 1 || r.json.ok === false,
        preview(JSON.stringify({ ok: r.json.ok, failed: r.json.failed })));
    } else {
      check('坏 JSON：--json 仍能输出可解析的结果', false, r.jsonError);
    }
    dropSandbox(home);
  }

  // 4.2 只读文件
  {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const original = JSON.stringify({ [container]: { alpha: { command: 'a', args: [] } } }, null, 2) + '\n';
    seedText(home, p, original);
    let madeReadonly = true;
    try { chmodSync(p, 0o444); } catch { madeReadonly = false; }
    // 这条曾经在 Linux CI 上红过，而且不是测试的问题：写入用的是
    // 「先写临时文件再 rename」，rename 只要求目录可写、不要求目标文件可写，
    // 于是 POSIX 上一个 0444 的配置会被静默覆盖。现在写入前显式检查可写性，
    // 两个平台行为一致。root 无视权限位，那种环境下这条断言不适用 ——
    // 但 root 也几乎不会出现在真实用户机器上，所以不因此削弱断言。
    const privileged = isPrivileged();
    const r = run(home, ['--yes', '--only', id]);
    const afterText = readText(p);
    const baks = backupsIn(dirname(p));
    const bakText = baks.length ? readText(join(dirname(p), baks[0])) : null;

    check('只读文件：确实置为只读（Windows=只读属性）', madeReadonly);
    if (privileged) {
      console.log('  ---  只读文件：当前身份是 root（无视权限位），跳过「必须拒绝」断言');
    } else {
      check('只读文件：退出码非 0（不能假装成功）', r.code !== 0 && r.code !== null, 'exit ' + r.code);
      check('只读文件：原文件逐字节不变', afterText === original, diffPreview(original, afterText));
      check('只读文件：若产生备份，备份等于原文', baks.length === 0 || bakText === original, baks.join(','));
      check('只读文件：没有临时文件残留', tempsIn(dirname(p)).length === 0, tempsIn(dirname(p)).join(','));

      // --force 必须真的能覆盖，并且把权限位还回去，而不是留一个被改了属性的文件。
      const modeBefore = (statSync(p).mode & 0o777).toString(8);
      const forced = run(home, ['--yes', '--only', id, '--force']);
      const forcedText = readText(p);
      check('只读文件：--force 确实覆盖成功', forced.code === 0 && forcedText !== original,
        'exit ' + forced.code + ' ' + firstLine(forced.out));
      check('只读文件：--force 之后权限位被还原',
        (statSync(p).mode & 0o777).toString(8) === modeBefore,
        modeBefore + ' -> ' + (statSync(p).mode & 0o777).toString(8));
    }
    try { chmodSync(p, 0o666); } catch { /* 收尾一定要能删 */ }
    dropSandbox(home);
  }

  // 4.3 空文件
  {
    const home = sandbox({});
    const p = resolvePath(id, home);
    seedText(home, p, '');
    const r = run(home, ['--yes', '--only', id]);
    const text = readText(p);
    const parsed = text && text.trim() !== '' ? safeParse(text) : null;
    const added = parsed ? addedEntries({}, parsed) : { entries: [] };
    const created = text !== '' && parsed !== null && added.entries.length === 1;
    const refused = r.code !== 0 && (text === '');
    const noop = r.code === 0 && text === '';
    check('空文件：安全创建合法配置，或干净拒绝（不写半截）', created || refused || noop,
      'exit ' + r.code + ' text=' + preview(text));
    if (created) {
      check('空文件：创建后恰好一个新条目', added.entries.length === 1, String(added.entries.length));
      check('空文件：创建后 JSON 可解析', Boolean(parsed), preview(text));
    }
    dropSandbox(home);
  }

  // 4.4 目录不存在
  {
    const home = sandbox({});
    const p = resolvePath(id, home);
    check('缺目录：测试前目录确实不存在', !existsSync(dirname(p)), dirname(p));
    const r = run(home, ['--yes', '--only', id]);
    const exists = existsSync(p);
    const text = exists ? readText(p) : null;
    const parsed = text ? safeParse(text) : null;
    const added = parsed ? addedEntries({}, parsed) : { entries: [] };

    const safeCreate = r.code === 0 && exists && parsed !== null && added.entries.length === 1;
    const refused = r.code !== 0 && (!exists || text === '');
    const skippedCleanly = r.code === 0 && !exists;
    check('缺目录：安全创建或干净拒绝，且不崩溃',
      r.spawnError === null && r.signal === null && (safeCreate || refused || skippedCleanly),
      'exit ' + r.code + ' signal=' + r.signal + ' exists=' + exists + ' text=' + preview(text));
    if (safeCreate) {
      check('缺目录：创建出的目录在沙箱内', isInside(home, dirname(p)), dirname(p));
      check('缺目录：创建出的配置可解析且有我们的条目', Boolean(parsed) && added.entries.length === 1);
    }
    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [5] Codex TOML：注释 / 顶层键 / 其它表 / CRLF 全保留
// ══════════════════════════════════════════════════════════════════════

section('[5] Codex TOML：注释、顶层键、其它 [表]、CRLF 全保留，删除后还原', () => {
  const home = sandbox({});
  const p = resolvePath('codex', home);
  const lines = [
    '# 顶部注释：模型与审批策略不要动',
    'model = "gpt-5.1-codex"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '# 别人注册的 MCP，必须留着',
    '[mcp_servers.node_repl]',
    'command = "cmd.exe"',
    'args = ["/d", "/s", "/c", "call ./start.cmd"]',
    'startup_timeout_sec = 20.0',
    '',
    '[mcp_servers.node_repl.env]',
    'FOO = "bar"',
    '',
    '[mcp_servers.rea]',
    'command = "rea"',
    'args = ["mcp"]',
    '# 表尾注释',
  ];
  const original = lines.join('\r\n') + '\r\n';
  seedText(home, p, original);
  const beforeTables = (original.match(/^\[mcp_servers\.[^\]]+\]/gm) || []).length;

  const rAdd = run(home, ['--yes', '--only', 'codex']);
  const added = readText(p) || '';
  const addedTables = (added.match(/^\[mcp_servers\.[^\]]+\]/gm) || []).length;

  check('codex: 注册退出码 0', rAdd.code === 0, 'exit ' + rAdd.code + ' ' + firstLine(rAdd.out));
  check('codex: 新增了我们的 mcp_servers 段', added.includes('dsh-any-agent') && addedTables > beforeTables,
    'tables ' + beforeTables + ' -> ' + addedTables);
  const origHeaders = lines.filter((l) => /^\[[^\]]+\]$/.test(l));
  const headersKept = origHeaders.every((h) => (added.match(new RegExp(escapeRe(h), 'g')) || []).length === 1);
  check('codex: 原有每个 [表] 头都恰好出现一次', headersKept,
    'missing/duplicated among ' + origHeaders.join(' ') + ' | got ' + (added.match(/\[[^\]]+\]/g) || []).join(' '));
  const lostLines = lines.filter((l) => l.trim() !== '' && !added.includes(l.replace(/[ \t]+$/, '')));
  check('codex: 原有每一行（含注释）仍在', lostLines.length === 0, JSON.stringify(lostLines.slice(0, 3)));
  check('codex: CRLF 行尾保留（没有裸 LF）', countBareLf(added) === 0,
    'bare LF=' + countBareLf(added) + ' LF=' + (added.match(/\n/g) || []).length);
  check('codex: 顶层键 model 保留', added.includes('model = "gpt-5.1-codex"'));
  check('codex: 顶层键 approval_policy 保留', added.includes('approval_policy = "never"'));
  check('codex: 顶层键没有被塞进任何表（仍在文件开头）',
    /^#[\s\S]*?model = "gpt-5\.1-codex"/.test(added) || added.indexOf('model = "gpt-5.1-codex"') < added.indexOf('[mcp_servers.'), preview(added));
  check('codex: 写入前有一个 .bak', backupsIn(dirname(p)).length === 1, backupsIn(dirname(p)).join(','));

  const rRm = run(home, ['--remove', '--yes', '--only', 'codex']);
  const restored = readText(p) || '';
  check('codex: 删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
  check('codex: 我们的段已消失', !restored.includes('dsh-any-agent'), preview(restored));
  // 允许空行差异（删段后可能多/少一个空行），其余逐行逐字节还原。
  check('codex: 删除后逐行还原（仅允许空行差异）',
    JSON.stringify(nonEmptyLines(restored)) === JSON.stringify(nonEmptyLines(original)),
    'first diff: ' + diffPreview(nonEmptyLines(original).join('\n'), nonEmptyLines(restored).join('\n')));
  check('codex: 删除后其它表都在', restored.includes('[mcp_servers.node_repl]') && restored.includes('[mcp_servers.rea]'));
  check('codex: 删除后 CRLF 仍保留', countBareLf(restored) === 0, 'bare LF=' + countBareLf(restored));

  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [6] 幂等
// ══════════════════════════════════════════════════════════════════════

section('[6] 幂等：连续两次 --yes，第二次不写、不新增 .bak', () => {
  const targets = [FORMAT_ID || 'cursor', 'codex'];
  for (const id of targets) {
    const home = sandbox({});
    const p = resolvePath(id, home);
    let seedTextValue;
    if (id === 'codex') seedTextValue = 'model = "m"\r\n\r\n[mcp_servers.other]\r\ncommand = "x"\r\n';
    else {
      seedTextValue = JSON.stringify({
        ...(EXTRA_TOP[id] || {}),
        [containerOf(id)]: { alpha: { command: 'a', args: [] } },
      }, null, 2) + '\n';
    }
    seedText(home, p, seedTextValue);

    const r1 = run(home, ['--yes', '--only', id]);
    const firstText = readText(p);
    const baksAfter1 = backupsIn(dirname(p)).length;

    const r2 = runJson(home, ['--yes', '--only', id]);
    const secondText = readText(p);
    const baksAfter2 = backupsIn(dirname(p)).length;

    check(id + ': 第一次确实写入', r1.code === 0 && firstText !== seedTextValue, 'exit ' + r1.code + ' ' + firstLine(r1.out));
    check(id + ': 第二次文件字节不变', secondText === firstText, diffPreview(firstText, secondText));
    check(id + ': 第二次不新增 .bak', baksAfter2 === baksAfter1, baksAfter1 + ' -> ' + baksAfter2);
    check(id + ': 第二次退出码 0', r2.code === 0, 'exit ' + r2.code + ' ' + firstLine(r2.out));
    if (r2.json) {
      check(id + ': 第二次 --json 报告 0 changed', r2.json.changed === 0,
        'changed=' + r2.json.changed + ' clients=' + preview(JSON.stringify((r2.json.clients || []).map((c) => c.id + ':' + c.status))));
      check(id + ': 第二次 --json 报告 0 failed', r2.json.failed === 0, 'failed=' + r2.json.failed);
    } else {
      check(id + ': 第二次 --json 可解析', false, r2.jsonError);
    }
    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [7] 删除不存在的条目
// ══════════════════════════════════════════════════════════════════════

section('[7] 删除不存在的条目：不写盘、退出码 0、无 .bak', () => {
  const targets = [FORMAT_ID || 'cursor', 'codex'];
  for (const id of targets) {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const container = containerOf(id);
    const original = id === 'codex'
      ? 'model = "m"\r\n\r\n[mcp_servers.other]\r\ncommand = "x"\r\n'
      : JSON.stringify({ [container]: { alpha: { command: 'a', args: [] } } }, null, 2) + '\n';
    seedText(home, p, original);

    const r = run(home, ['--remove', '--yes', '--only', id]);
    const text = readText(p);

    check(id + ': 文件逐字节不变', text === original, diffPreview(original, text));
    check(id + ': 退出码 0', r.code === 0, 'exit ' + r.code + ' ' + firstLine(r.out));
    check(id + ': 没有产生 .bak', backupsIn(dirname(p)).length === 0, backupsIn(dirname(p)).join(','));
    check(id + ': 报告里提到跳过/未找到', /skip|not present|not found|未|不存在/i.test(r.out) || r.out.trim() === '',
      firstLine(r.out));
    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [8] .bak-dsh-<stamp>：每个文件只出现一次，内容等于写入前原文
// ══════════════════════════════════════════════════════════════════════

section('[8] .bak-dsh-<stamp>：每客户端只出现一次且等于写入前原文', () => {
  const targets = USABLE.slice(0, 3);
  if (!targets.length) {
    check('至少有一个可写客户端来验证 .bak', false, '没有客户端注册成功（见 [0b]）');
    return;
  }
  const home = sandbox({});
  const originals = new Map();
  for (const id of targets) {
    const p = resolvePath(id, home);
    const text = JSON.stringify({
      ...(EXTRA_TOP[id] || {}),
      [containerOf(id)]: { alpha: { command: 'alpha-bin', args: ['--flag'] } },
    }, null, 2) + '\n';
    seedText(home, p, text);
    originals.set(id, text);
  }

  const r = run(home, ['--yes', '--only', targets.join(',')]);
  check('批量注册退出码 0', r.code === 0, 'exit ' + r.code + ' ' + firstLine(r.out));

  for (const id of targets) {
    const p = resolvePath(id, home);
    const baks = backupsIn(dirname(p));
    check(id + ': 恰好一个 .bak-dsh-*', baks.length === 1, baks.join(','));
    if (baks.length === 1) {
      check(id + ': .bak 名字形如 .bak-dsh-<stamp>', /\.bak-dsh-[^\\/]+$/.test(baks[0]), baks[0]);
      check(id + ': .bak 内容等于写入前原文', readText(join(dirname(p), baks[0])) === originals.get(id),
        diffPreview(originals.get(id), readText(join(dirname(p), baks[0]))));
    }
    check(id + ': 没有临时文件残留', tempsIn(dirname(p)).length === 0, tempsIn(dirname(p)).join(','));
  }

  // 再跑一次（幂等）：仍然只有一个 .bak。
  run(home, ['--yes', '--only', targets.join(',')]);
  for (const id of targets) {
    const baks = backupsIn(dirname(resolvePath(id, home)));
    check(id + ': 第二次运行后仍只有一个 .bak', baks.length === 1, baks.join(','));
  }
  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [9] claude-code：计划模式不写；写入则必须只动自己（也可能干净跳过）
// ══════════════════════════════════════════════════════════════════════

section('[9] claude-code：计划模式不写盘，写入时只动自己', () => {
  const home = sandbox({});
  const p = resolvePath('claude-code', home);
  const other = { command: 'other-bin', args: ['--y'] };
  const original = JSON.stringify({ mcpServers: { other } }, null, 2) + '\n';
  seedText(home, p, original);

  // 同样屏蔽 claude CLI：CLI 的 verify 探针会让客户端回写 ~/.claude.json（实测会
  // 丢掉 projects[*].history、往顶层塞十几个键）。那是客户端行为，不是我们的写入；
  // 本节只验「我们的写入只动自己那一条」，CLI 存在时的报告语义见 [16]。
  const emptyPath = join(home, 'empty-path');
  mkdirSync(emptyPath, { recursive: true });
  const noCliEnv = { PATH: emptyPath, Path: emptyPath };

  const plan = run(home, ['--only', 'claude-code'], noCliEnv);
  check('claude-code: 计划模式文件字节不变', readText(p) === original, diffPreview(original, readText(p)));
  check('claude-code: 计划模式无 .bak', backupsIn(dirname(p)).length === 0, backupsIn(dirname(p)).join(','));
  check('claude-code: 计划模式退出码 0', plan.code === 0, 'exit ' + plan.code + ' ' + firstLine(plan.out));

  const apply = run(home, ['--yes', '--only', 'claude-code'], noCliEnv);
  const text = readText(p);
  const parsed = safeParse(text || '');
  const unchanged = text === original;
  const added = parsed ? addedEntries({ mcpServers: { other } }, parsed) : { entries: [] };
  const wroteSafely = !unchanged && added.entries.length === 1
    && JSON.stringify(parsed && parsed.mcpServers && parsed.mcpServers.other) === JSON.stringify(other)
    && Object.keys(parsed).join(',') === 'mcpServers';
  // 契约反转后：claude-code 一定写文件（不再 skip），只允许新增自己那一条。
  check('claude-code: 写入后只新增自己那一条（别人的条目与顶层键不变）',
    wroteSafely,
    'exit ' + apply.code + ' unchanged=' + unchanged + ' entries=' + added.entries.length + ' ' + firstLine(apply.out));
  if (!unchanged) {
    check('claude-code: 写入后 .bak 等于原文', backupsIn(dirname(p)).some((b) => readText(join(dirname(p), b)) === original),
      backupsIn(dirname(p)).join(','));
  }
  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [11] opencode：条目形状必须是 local + command 数组
// ══════════════════════════════════════════════════════════════════════

section('[11] opencode：type=local、command 是数组、enabled=true，且不动别人的条目', () => {
  const home = sandbox({});
  const container = 'mcp';
  const other = { type: 'local', command: ['other-mcp', '--stdio'], enabled: true };
  const original = JSON.stringify({
    '$schema': 'https://opencode.ai/config.json',
    mcp: { other },
  }, null, 2) + '\n';
  const seeded = seedPaths('opencode', home);
  for (const s of seeded) seedText(home, s, original);

  const r = run(home, ['--yes', '--only', 'opencode']);
  const p = pickChangedPath('opencode', home, original);
  const text = readText(p);
  const parsed = safeParse(text || '');
  const bag = (parsed && parsed[container]) || {};
  const added = parsed ? addedEntries({ mcp: { other } }, parsed) : { entries: [] };
  const entryKey = added.entries.length === 1 ? added.entries[0].key : null;
  const entry = (entryKey && bag[entryKey]) || {};

  check('opencode: 注册退出码 0', r.code === 0, 'exit ' + r.code + ' ' + firstLine(r.out));
  check('opencode: 写入后仍是合法 JSON', Boolean(parsed), preview(text));
  check('opencode: 恰好新增一个条目', added.entries.length === 1, JSON.stringify(added.entries.map((e) => e.key)));
  check('opencode: 容器是 mcp', added.entries.length === 1 && added.entries[0].container === 'mcp',
    added.entries.map((e) => e.container).join(','));
  check('opencode: type === "local"', entry.type === 'local', preview(JSON.stringify(entry.type)));
  check('opencode: command 是数组', Array.isArray(entry.command), preview(JSON.stringify(entry.command)));
  check('opencode: command[0] 是可执行文件路径（非空字符串）',
    Array.isArray(entry.command) && typeof entry.command[0] === 'string' && entry.command[0].length > 0,
    preview(JSON.stringify(entry.command)));
  check('opencode: enabled === true', entry.enabled === true, preview(JSON.stringify(entry.enabled)));
  check('opencode: 别人的条目一字未改', JSON.stringify(bag.other) === JSON.stringify(other), preview(JSON.stringify(bag.other)));
  check('opencode: 顶层 $schema 保留', parsed ? parsed.$schema === 'https://opencode.ai/config.json' : false);
  check('opencode: 写入前有且只有一个 .bak', backupsIn(dirname(p)).length === 1, backupsIn(dirname(p)).join(','));

  const rRm = run(home, ['--remove', '--yes', '--only', 'opencode']);
  const restored = readText(p);
  check('opencode: 删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
  check('opencode: 删除后逐字节还原原文', restored === original, diffPreview(original, restored));

  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [12] vscode：写在 servers 容器，且不污染 settings.json
// ══════════════════════════════════════════════════════════════════════

section('[12] vscode：servers 容器、不动 settings.json、别人条目保留', () => {
  const home = sandbox({});
  const other = { command: 'other', args: ['--y'], env: { A: '1' } };
  const original = JSON.stringify({ servers: { other } }, null, 2) + '\n';
  const settingsText = JSON.stringify({ 'editor.fontSize': 14, 'files.autoSave': 'onFocusChange' }, null, 2) + '\n';
  const seeded = seedPaths('vscode', home);
  const settingsFiles = seeded.map((s) => join(dirname(s), 'settings.json'));
  for (const s of seeded) seedText(home, s, original);
  for (const s of settingsFiles) seedText(home, s, settingsText);

  const r = run(home, ['--yes', '--only', 'vscode']);
  const p = pickChangedPath('vscode', home, original);
  const text = readText(p);
  const parsed = safeParse(text || '');
  const added = parsed ? addedEntries({ servers: { other } }, parsed) : { entries: [] };

  check('vscode: 注册退出码 0', r.code === 0, 'exit ' + r.code + ' ' + firstLine(r.out));
  check('vscode: 文件确实被写过（不是静默跳过）', text !== original, preview(text));
  check('vscode: 写入前有一个 .bak', backupsIn(dirname(p)).length === 1, backupsIn(dirname(p)).join(','));
  check('vscode: 容器是 servers（不是 mcpServers）',
    added.entries.length === 1 && added.entries[0].container === 'servers',
    added.entries.map((e) => e.container).join(',') || 'none');
  check('vscode: 没有冒出一个 mcpServers 容器',
    parsed ? !Object.prototype.hasOwnProperty.call(parsed, 'mcpServers') : false,
    parsed ? Object.keys(parsed).join(',') : 'not JSON');
  check('vscode: 顶层键只有 servers',
    parsed ? Object.keys(parsed).join(',') === 'servers' : false,
    parsed ? Object.keys(parsed).join(',') : 'not JSON');
  check('vscode: 别人的条目一字未改',
    parsed && parsed.servers ? JSON.stringify(parsed.servers.other) === JSON.stringify(other) : false,
    parsed && parsed.servers ? preview(JSON.stringify(parsed.servers.other)) : 'not JSON');
  const settingsDirty = settingsFiles.filter((s) => readText(s) !== settingsText);
  check('vscode: 所有 settings.json 逐字节未被污染', settingsDirty.length === 0,
    settingsDirty.map((s) => s + ' -> ' + preview(readText(s))).join(' | '));
  const settingsBaks = settingsFiles.flatMap((s) => backupsIn(dirname(s)).filter((b) => b.startsWith('settings.json')));
  check('vscode: settings.json 旁边没有 .bak', settingsBaks.length === 0, settingsBaks.join(','));

  const rRm = run(home, ['--remove', '--yes', '--only', 'vscode']);
  const restored = readText(p);
  check('vscode: 删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
  check('vscode: 删除后逐字节还原原文', restored === original, diffPreview(original, restored));
  check('vscode: 删除后 settings.json 仍逐字节未变',
    settingsFiles.every((s) => readText(s) === settingsText));

  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [13] claude-code：CLI 不在 PATH 上时必须 skip，且不碰 ~/.claude.json
// ══════════════════════════════════════════════════════════════════════

section('[13] claude-code：~/.claude.json 定点编辑，只增删自己那一条', () => {
  // 契约（与最初设想相反，以最终实现为准）：Claude Code **不走** claude mcp CLI，
  // 而是对 ~/.claude.json 做同样的文本级定点编辑 —— 这样才可能做到「只增删自己
  // 那一条 + 可逐字节撤销 + 有我们能控制的 .bak」。claude mcp add 会整体重写文件。
  // 单独保留的断言语义：CLI 在不在 PATH 上都必须成功，且绝不报 failed。
  const home = sandbox({});
  const p = resolvePath('claude-code', home);
  // 与真实 ~/.claude.json 同构：顶层杂项 + projects 大映射 + mcpServers。
  const obj = {
    numStartups: 42,
    installMethod: 'npm',
    projects: {
      'D:/Desktop/dsh-any-agent': { allowedTools: ['Bash(node:*)'], history: [{ display: 'hi', ts: 1 }] },
      'D:/Desktop/code/Rust': { allowedTools: [], history: [] },
      'D:/Desktop/code/rust': { allowedTools: [], history: [] },
    },
    mcpServers: {
      alpha: { command: 'alpha-bin', args: ['--x'], env: { K: 'v' } },
      beta: { command: 'beta-bin', args: [] },
    },
  };
  const original = JSON.stringify(obj, null, 2) + '\n';
  seedText(home, p, original);

  // ⚠️ 用空 PATH 跑，屏蔽 claude CLI：CLI 的 verify 探针会让 Claude CLI 自己
  // 重写 ~/.claude.json（实测会丢掉 projects[*].history 并往顶层塞十几个键），
  // 那是**客户端**的行为，不是我们的写入；纯文件编辑的正确性必须在没有探针时验。
  const emptyPath = join(home, 'empty-path');
  mkdirSync(emptyPath, { recursive: true });
  const noCliEnv = { PATH: emptyPath, Path: emptyPath };

  const rAdd = runJson(home, ['--yes', '--only', 'claude-code'], noCliEnv);
  const afterText = readText(p);
  const afterObj = safeParse(afterText || '');
  const added = afterObj ? addedEntries(obj, afterObj) : { entries: [] };

  check('claude-code: 注册退出码 0', rAdd.code === 0, 'exit ' + rAdd.code + ' ' + firstLine(rAdd.out));
  check('claude-code: 写入后仍是合法 JSON', Boolean(afterObj), preview(afterText));
  check('claude-code: 恰好新增一个条目', added.entries.length === 1,
    JSON.stringify(added.entries.map((e) => e.key)));
  check('claude-code: 新条目落在 mcpServers 容器',
    added.entries.length === 1 && added.entries[0].container === 'mcpServers',
    added.entries.map((e) => e.container).join(','));
  check('claude-code: 条目带 type/stdio 或 command 形状',
    added.entries.length === 1
      && ((added.entries[0].value && added.entries[0].value.type === 'stdio')
        || typeof (added.entries[0].value || {}).command === 'string'),
    preview(JSON.stringify(added.entries[0] && added.entries[0].value)));

  if (afterObj) {
    check('claude-code: 别人的 MCP 条目逐字节不变',
      JSON.stringify(afterObj.mcpServers.alpha) === JSON.stringify(obj.mcpServers.alpha)
      && JSON.stringify(afterObj.mcpServers.beta) === JSON.stringify(obj.mcpServers.beta),
      preview(JSON.stringify(afterObj.mcpServers)));
  }
  check('claude-code: 大小写重复键在文本里都还在（D:/Desktop/code/Rust 与 rust）',
    JSON.stringify(dupKeysOf(afterText).sort()) === JSON.stringify(['D:/Desktop/code/Rust', 'D:/Desktop/code/rust']),
    '文本里的键: ' + dupKeysOf(afterText).join(' | '));
  check('claude-code: projects 里原有内容（history/allowedTools）逐段都还在',
    containsAll(afterText, ['"allowedTools"', '"Bash(node:*)"', '"display": "hi"', '"ts": 1']),
    'MISSING=' + JSON.stringify(['"allowedTools"', '"Bash(node:*)"', '"display": "hi"', '"ts": 1']
      .filter((n) => !String(afterText || '').includes(n))) + ' AFTER=' + JSON.stringify(String(afterText || '').slice(0, 700)));

  const baks1 = backupsIn(dirname(p));
  check('claude-code: 写入前有 .bak-dsh-*', baks1.length >= 1, baks1.join(','));
  check('claude-code: .bak 内容等于写入前原文',
    baks1.some((b) => readText(join(dirname(p), b)) === original), baks1.join(','));

  // CLI 在不在 PATH 上都不能改变「写文件」这个事实，也都不能报 failed。
  // 第二次 --yes：幂等（不新增 .bak、字节不变）。
  const baksBeforeSecond = backupsIn(dirname(p)).length;
  const second = runJson(home, ['--yes', '--only', 'claude-code'], noCliEnv);
  check('claude-code: 第二次 --yes 不新增 .bak', backupsIn(dirname(p)).length === baksBeforeSecond,
    baksBeforeSecond + ' -> ' + backupsIn(dirname(p)).length);
  check('claude-code: 第二次 --yes 字节不变（幂等）', readText(p) === afterText,
    diffPreview(afterText, readText(p)));
  check('claude-code: 第二次 --yes changed === 0', second.json ? second.json.changed === 0 : false,
    second.json ? 'changed=' + second.json.changed : second.jsonError);

  // CLI 缺席：必须成功、不报 failed、不得声称已确认。
  const cNoCli = second.json ? (second.json.clients || []).find((c) => c && c.id === 'claude-code') : null;
  check('claude-code: 没有 CLI 时退出码 0', second.code === 0, 'exit ' + second.code + ' ' + firstLine(second.out));
  check('claude-code: 没有 CLI 时也不报 failed', second.json ? second.json.failed === 0 : false,
    second.json ? 'failed=' + second.json.failed : second.jsonError);
  check('claude-code: 没有 CLI 时该客户端仍被报告', Boolean(cNoCli),
    second.json ? preview(JSON.stringify((second.json.clients || []).map((c) => c.id))) : second.jsonError);
  check('claude-code: 没有 CLI 时 status 不含 failed',
    cNoCli ? !/fail/i.test(String(cNoCli.status)) : false,
    cNoCli ? 'status=' + cNoCli.status + ' ' + preview(cNoCli.summary || '') : 'no client');
  check('claude-code: 没有 CLI 时不得声称 claude mcp get 确认过',
    cNoCli ? !/confirmed by/i.test(String(cNoCli.summary || '')) : false,
    cNoCli ? preview(cNoCli.summary || '') : 'no client');

  // 删除：整文件逐字节还原（大小写重复键必须原样还在）。
  const rRm = run(home, ['--remove', '--yes', '--only', 'claude-code'], noCliEnv);
  const restored = readText(p);
  check('claude-code: 删除退出码 0', rRm.code === 0, 'exit ' + rRm.code + ' ' + firstLine(rRm.out));
  check('claude-code: 删除后逐字节还原原文', restored === original,
    diffPreview(original, restored) + ' | 提示：若差异只在空白，说明实现做了重新序列化而非定点删除');
  check('claude-code: 删除后 projects 与顶层键都还在',
    typeof restored === 'string' && obj.projects['D:/Desktop/dsh-any-agent'] !== undefined
      ? restored.includes('"allowedTools"') && restored.includes('"installMethod"') : false,
    preview(restored));

  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [16] claude-code：CLI 存在时的 verify 语义（只验报告，不验文件）
// ══════════════════════════════════════════════════════════════════════

section('[16] claude-code：CLI 存在时 summary 出现 confirmed by claude mcp get', () => {
  const home = sandbox({});
  const p = resolvePath('claude-code', home);
  seedText(home, p, JSON.stringify({ mcpServers: {}, projects: {} }, null, 2) + '\n');
  const hasCli = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'],
    { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true }).status === 0;

  const r = runJson(home, ['--yes', '--only', 'claude-code']);
  const c = r.json ? (r.json.clients || []).find((x) => x && x.id === 'claude-code') : null;

  check('claude-code: CLI 存在时不报 failed', r.json ? r.json.failed === 0 : false,
    r.json ? 'failed=' + r.json.failed : r.jsonError);
  check('claude-code: --json 可解析', Boolean(r.json), r.jsonError);
  if (!hasCli) {
    check('claude-code: 本机没有 claude CLI，confirmed 断言不适用（不假绿）', true);
  } else {
    check('claude-code: summary 出现 confirmed by claude mcp get',
      c ? /confirmed by claude mcp get/i.test(String(c.summary || '')) : false,
      c ? preview(c.summary || '') : 'no client');
  }

  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [14] 幂等矩阵：全部 9 个客户端，第二次 changed=0 且无新 .bak
// ══════════════════════════════════════════════════════════════════════

section('[14] 幂等矩阵：9 个客户端连续两次 --yes，第二次 0 changed', () => {
  for (const id of CLIENT_IDS) {
    const home = sandbox({});
    const p = resolvePath(id, home);
    const isToml = id === 'codex';
    const isCli = id === 'claude-code';
    const container = containerOf(id);
    if (!isToml && !isCli) {
      seedText(home, p, JSON.stringify({
        ...(EXTRA_TOP[id] || {}),
        [container]: { alpha: { command: 'alpha', args: [] } },
      }, null, 2) + '\n');
    } else if (isToml) {
      seedText(home, p, 'model = "m"\r\n\r\n[mcp_servers.other]\r\ncommand = "x"\r\n');
    } else {
      // claude-code 现在也是文本级定点编辑 ~/.claude.json。
      seedText(home, p, JSON.stringify({ mcpServers: {}, projects: {} }, null, 2) + '\n');
    }

    const preText = readText(p);
    const r1 = runJson(home, ['--yes', '--only', id]);
    const firstText = readText(p);
    const baksAfter1 = backupsIn(dirname(p)).length;
    const c1 = r1.json ? (r1.json.clients || []).find((c) => c && c.id === id) : null;
    // 拿不到 --json 就无法区分「跳过」和「写了」：此时不断言写入（[0] 会单独报这个缺口）。
    const skipped1 = !c1 || /skip|not found|not installed|missing|缺少|未安装/i.test(String(c1.status));

    const r2 = runJson(home, ['--yes', '--only', id]);
    const secondText = readText(p);
    const baksAfter2 = backupsIn(dirname(p)).length;

    check(id + ': 第一次运行退出码 0', r1.code === 0, 'exit ' + r1.code + ' ' + firstLine(r1.out));
    check(id + ': 第二次 --json 可解析', Boolean(r2.json), r2.jsonError);
    if (r2.json) {
      check(id + ': 第二次 changed === 0', r2.json.changed === 0,
        'changed=' + r2.json.changed + ' clients=' + preview(JSON.stringify((r2.json.clients || []).map((c) => c.id + ':' + c.status))));
      check(id + ': 第二次 failed === 0', r2.json.failed === 0, 'failed=' + r2.json.failed);
    }
    check(id + ': 第二次文件字节不变', secondText === firstText, diffPreview(firstText, secondText));
    check(id + ': 第二次不新增 .bak', baksAfter2 === baksAfter1, baksAfter1 + ' -> ' + baksAfter2);
    if (!skipped1) {
      check(id + ': 第一次确实写入了（幂等才有意义）', firstText !== preText,
        'before=' + preview(preText) + ' after=' + preview(firstText));
    }
    dropSandbox(home);
  }
});

// ══════════════════════════════════════════════════════════════════════
// [15] 真实 HOME 只读回归：plan 模式覆盖全部已存在客户端，一个字节不动
// ══════════════════════════════════════════════════════════════════════

section('[15] 真实 HOME 只读回归：plan 模式覆盖全部已存在客户端', () => {
  const before = realHomeSnapshot();
  const r = run(realHome(), ['--all'], { HOME: realHome(), USERPROFILE: realHome(), APPDATA: REAL_APPDATA });
  const after = realHomeSnapshot();

  const changed = [];
  for (const [p, sig] of before) if (after.get(p) !== sig) changed.push(p);
  for (const p of after.keys()) if (!before.has(p)) changed.push('created: ' + p);
  const existing = [...before.keys()].filter((p) => existsSync(p));

  check('真实 HOME：plan 模式退出码 0', r.code === 0, 'exit ' + r.code + ' ' + firstLine(r.out));
  // CI runner 上通常一个 MCP 客户端都没装，这一组退化为空断言。
  // 与其假绿，不如明确说「这里没验」—— 它只在开发机上才真正覆盖东西。
  if (existing.length === 0) {
    console.log('  ---  真实 HOME：本机没有已安装的客户端配置，这一组跳过（CI 上属正常，不代表通过）');
    console.log('       请在装有 Cursor / Codex / Claude Code 等客户端的机器上跑，才有回归价值');
  } else {
    check('真实 HOME：全部 ' + existing.length + ' 个已存在客户端配置 size+mtime 未变',
      changed.length === 0, changed.join(', '));
  }
  const created = [...after.keys()].filter((p) => !before.has(p));
  check('真实 HOME：plan 模式没有新建任何客户端配置文件', created.length === 0, created.join(', '));

  // plan 模式在真实 HOME 上也不该出现新备份；历史遗留的备份是存量，只比名单。
  const afterBaks = realBackupSnapshot();
  const newBaks = [...afterBaks].filter((p) => !REAL_BAK_BEFORE.has(p));
  check('真实 HOME：没有新增 .bak-dsh-* 备份', newBaks.length === 0, newBaks.join(','));
  check('真实 HOME：历史备份数量未被改动', afterBaks.size === REAL_BAK_BEFORE.size,
    REAL_BAK_BEFORE.size + ' -> ' + afterBaks.size);
});

// ══════════════════════════════════════════════════════════════════════
// 收尾：清沙箱、确认真实 HOME 没被碰过
// ══════════════════════════════════════════════════════════════════════

cleanupAll();

section('[10] 真实 HOME 隔离：本测试没有向真实客户端配置写入任何东西', () => {
  const after = realHomeSnapshot();
  const changed = [];
  for (const [p, sig] of REAL_BEFORE) {
    if (after.get(p) !== sig) changed.push(p);
  }
  for (const p of after.keys()) if (!REAL_BEFORE.has(p)) changed.push('created: ' + p);
  check('真实 HOME 下客户端配置的 size/mtime 未变', changed.length === 0, changed.join(', '));
  check('没有沙箱目录残留', HOMES.length === 0, HOMES.join(','));
});

// ══════════════════════════════════════════════════════════════════════
// [17] 注册与删除都必须先备份，且备份路径要在 --json 里报出来
// ══════════════════════════════════════════════════════════════════════

section('[17] 两个方向都留备份：注册前存、删除前也存，路径可查、可回滚', () => {
  const id = FORMAT_ID || 'cursor';
  const home = sandbox({});
  const p = resolvePath(id, home);
  const container = containerOf(id);
  if (id === 'codex') {
    seedText(home, p, 'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n');
  } else {
    seedText(home, p, JSON.stringify({ [container]: { keep: { command: 'x', args: [] } } }, null, 2) + '\n');
  }
  const original = readText(p);

  const add = runJson(home, ['--yes', '--only', id]);
  const addRow = add.json ? (add.json.clients || []).find((c) => c && c.id === id) : null;
  check(id + ': 注册的 --json 报告了 backup 字段', Boolean(addRow && addRow.backup),
    addRow ? JSON.stringify(Object.keys(addRow)) : 'no row');
  if (addRow && addRow.backup) {
    check(id + ': 注册的备份文件真的存在', existsSync(addRow.backup), addRow.backup);
    check(id + ': 注册的备份内容等于注册前原文', readText(addRow.backup) === original,
      diffPreview(original, readText(addRow.backup)));
  }
  const registered = readText(p);

  const rm = runJson(home, ['--remove', '--yes', '--only', id]);
  const rmRow = rm.json ? (rm.json.clients || []).find((c) => c && c.id === id) : null;
  check(id + ': 删除的 --json 报告了 backup 字段', Boolean(rmRow && rmRow.backup),
    rmRow ? JSON.stringify(Object.keys(rmRow)) : 'no row');
  if (rmRow && rmRow.backup) {
    check(id + ': 删除的备份文件真的存在', existsSync(rmRow.backup), rmRow.backup);
    check(id + ': 删除的备份内容等于删除前原文（已注册状态）',
      readText(rmRow.backup) === registered,
      diffPreview(registered, readText(rmRow.backup)));
    check(id + ': 删除的备份没有覆盖注册时那份',
      !addRow || addRow.backup !== rmRow.backup,
      'both = ' + (rmRow ? rmRow.backup : ''));
    seedText(home, p, readText(rmRow.backup));
    check(id + ': 用删除前的备份可以恢复回已注册状态', readText(p) === registered);
  }
  dropSandbox(home);
});

// ══════════════════════════════════════════════════════════════════════
// [18] dsh-any-agent-restore：备份能真正救回一个被破坏的文件
// ══════════════════════════════════════════════════════════════════════

section('[18] dsh-any-agent-restore：能把文件退回某一份备份', () => {
  const id = FORMAT_ID || 'cursor';
  const home = sandbox({});
  const p = resolvePath(id, home);
  const container = containerOf(id);
  if (id === 'codex') {
    seedText(home, p, 'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n');
  } else {
    seedText(home, p, JSON.stringify({ [container]: { keep: { command: 'x', args: [] } } }, null, 2) + '\n');
  }
  const original = readText(p);

  const restoredBin = join(HERE, '..', 'bin', 'restore.mjs');
  const restore = (args) => spawnSync(NODE, [restoredBin, ...args, '--home', home], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DSH_BIN: FAKE_DSH_BIN, DSH_MCP_LOG: 'silent' },
  });

  const add = run(home, ['--yes', '--only', id]);
  check(id + ': 还原测试的前置——注册成功', add.code === 0 && readText(p) !== original,
    'exit ' + add.code);

  // 模拟一次事故：文件被别的工具写坏了。
  seedText(home, p, '{ this is broken');

  const dry = restore(['--latest', '--dry-run']);
  check(id + ': --dry-run 不写盘', readText(p) === '{ this is broken',
    'exit ' + dry.status + ' text=' + preview(readText(p)));

  const r = restore(['--latest']);
  check(id + ': 还原退出码 0', r.status === 0, 'exit ' + r.status + ' ' + firstLine(r.stdout + r.stderr));
  check(id + ': 文件被退回备份状态（不再是被写坏的样子）', readText(p) !== '{ this is broken',
    preview(readText(p)));
  const restoredText = readText(p);
  const parses = id === 'codex' ? restoredText.includes('model') : (() => {
    try { JSON.parse(restoredText.replace(/^\uFEFF/, '')); return true; } catch { return false; }
  })();
  check(id + ': 还原出来的文件是可用的', parses, preview(restoredText));

  // 还原本身也是破坏性操作：必须把「还原前」另存一份，否则退错了就回不去。
  const safety = readdirSync(dirname(p)).filter((f) => f.includes('.bak-dsh-pre-restore-'));
  check(id + ': 还原前把当前状态另存了一份', safety.length === 1, safety.join(','));
  if (safety.length === 1) {
    check(id + ': 那份另存的内容等于还原前的样子',
      readText(join(dirname(p), safety[0])) === '{ this is broken',
      preview(readText(join(dirname(p), safety[0]))));
  }

  const list = restore(['--list', '--json']);
  let listed = null;
  try { listed = JSON.parse(list.stdout); } catch { listed = null; }
  check(id + ': --list --json 可解析', Boolean(listed && Array.isArray(listed.backups)),
    preview(list.stdout));
  check(id + ': --list 至少列出刚才那些备份', Boolean(listed && listed.backups.length >= 2),
    listed ? String(listed.backups.length) : 'null');

  dropSandbox(home);
});

console.log('\n===== config safety: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);
