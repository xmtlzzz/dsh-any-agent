#!/usr/bin/env node
/**
 * 把测试报告里的检查数写回文档：中英文 tests.md 的套件表与总数段落，
 * 以及 .github/workflows/tests.yml 范围注释里的检查数。零依赖。
 *
 * 为什么要有它：这些数字原先全靠手抄，一改测试就漂（failure-terminal 文档写 11、实际 10；
 * dispatch-tools 写 59、实际 58）。现在数字只来自 test/run.mjs 写出的 JSON 报告
 * （见 test/report.mjs），也就是各套件自己打印的汇总行。
 *
 * 用法：
 *   node test/run.mjs --all --report .state/test-report.json   # 先产出报告（--all 才含需要模型的套件）
 *   npm run docs:counts                                        # 写回文档
 *   npm run docs:counts:check                                  # 只检查，不一致就 exit 1 并打印差异
 *
 *   --report <path>   报告文件，可重复，按顺序逐份应用（同一格后面的覆盖前面的；总数段落里的
 *                     "本机实测"取最后一份含离线套件的报告）。例如：模拟 CI 环境的报告 + 本机的 --all 报告。
 *                     默认 .state/test-report.json
 *   --check           不写文件；文档与报告不一致时 exit 1 并打印差异
 *   --portable        只处理 CI 上量得准的离线套件（CI 用）：与环境无关的套件，以及只取决于
 *                     "有没有 DSH、有没有客户端配置"的套件（smoke、config-safety，且这次量到的正是
 *                     runner 那一格）；随平台、文件系统变化的套件（dispatch-tools、workspace-titles）
 *                     和总数段落不处理
 *   --root <dir>      仓库根（测试用）
 *
 * 退出码：0 一致/已写回；1 文档与报告不一致，或有需要人工补的东西（例如某个套件在表里没有一行）；
 *         2 用法或报告有问题（报告缺失、报告里有失败的套件 —— 失败的套件检查数不可信）。
 *
 * 两类数字必须"保持为真"：
 *   - 随环境变化的套件（有没有 DSH、平台、装了几个客户端配置、文件系统是否区分大小写）
 *     写成「主数字（另一环境的数字）」。本次只更新量到的那一格，其余格子原样保留；
 *     这一格由报告里的环境决定（见下面的 VARIANTS）。
 *   - 报告里没有需要模型的套件时（没带 --all），模型套件的数字原样保留。
 *   - 报告里标记为 skipped 的套件（没有 DSH 的 shared-process、没有 IDA 的 acceptance …）不动。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

export const DOC_FILES = { zh: 'docs/zh/tests.md', en: 'docs/en/tests.md' };
export const WORKFLOW_FILE = '.github/workflows/tests.yml';
export const RUN_FILE = 'test/run.mjs';
export const DEFAULT_REPORT = '.state/test-report.json';

const BLOCK_BEGIN_RE = /<!--\s*counts:begin[^>]*-->/;
const BLOCK_END = '<!-- counts:end -->';

// ── 随环境变化的套件 ──────────────────────────────────────────────

/**
 * 检查数随环境变化的套件。每一项说明：
 *   head     主数字对应的环境（写在单元格最前面）
 *   slots    其余环境的格子（label 是单元格里的写法，zh/en 各一种）
 *   fixtures 按"客户端配置数 K/N"分格（每个 K 一格，K=N 时就是主数字）
 *   context  由报告里的这个套件算出"这次量到的是哪一格"，算不出来返回 null（不更新）
 *   ci       GitHub 托管 runner 上落在哪一格（参数是平台）；null = runner 上整套跳过
 *   portable true = 在 runner 那一格量到时，--portable 也核对它（只取决于 DSH/客户端配置的套件）；
 *            缺省 = --portable 完全不碰（随平台/文件系统变化，我们没法在三个平台上各量一遍）
 *   yml      slot 在 tests.yml 注释里的写法（缺省用 en）
 *
 * 没出现在这里的套件视为与环境无关：只有一个数字，CI 也要核对它（--portable）。
 */
export const VARIANTS = {
  // 没有 DSH 时跳过会话段：33（有 DSH）/ 20（没有）。
  smoke: {
    head: 'full',
    slots: [{ key: 'nodsh', zh: '无 DSH 时', en: 'without DSH' }],
    context: (s) => (s.meta.dsh === '1' || (s.meta.dsh == null && s.hasDsh) ? 'full' : 'nodsh'),
    ci: () => 'nodsh',
    portable: true,
  },
  // PowerShell 哨兵的真机执行只在 Windows 上跑（多 3 项）。
  'dispatch-tools': {
    head: 'win32',
    slots: [{ key: 'other', zh: '非 Windows', en: 'off Windows' }],
    context: (s) => (s.platform === 'win32' ? 'win32' : 'other'),
    ci: (platform) => (platform === 'win32' ? 'win32' : 'other'),
  },
  // 两条断言只在特定环境下才有：「改大小写也认得出家目录」只在不区分大小写的文件系统上，
  // 「文案指出 temp 就在工作区里」只在 TEMP 落在家目录内时（Windows 默认如此）。
  // 两个条件由套件自己探测并写进报告：键 = 文件系统(i 不区分/s 区分) + TEMP(h 在家目录内/o 在外)。
  // GitHub 的 macos-latest runner 是区分大小写的（见 workspace-titles.mjs 里的注释）。
  'workspace-titles': {
    head: 'ih',
    slots: [
      { key: 'io', zh: 'TEMP 在家目录外时', en: 'with TEMP outside the home directory' },
      { key: 'sh', zh: '区分大小写的文件系统上', en: 'on a case-sensitive filesystem' },
      { key: 'so', zh: '区分大小写且 TEMP 在家目录外时', en: 'case-sensitive with TEMP outside home', yml: 'off Windows' },
    ],
    context: (s) => {
      const fsCase = s.meta['fs-case'];
      const tempInHome = s.meta['temp-in-home'];
      if (!fsCase || tempInHome == null) return null;
      return (fsCase === 'insensitive' ? 'i' : 's') + (tempInHome === '1' ? 'h' : 'o');
    },
    ci: (platform) => (platform === 'win32' ? 'ih' : 'so'),
  },
  // 真实 HOME 只读回归里"全部已存在客户端配置未变"那一条，只在装了客户端时才有。
  'config-safety': {
    head: 'with',
    slots: [{ key: 'none', zh: '无客户端配置时', en: 'without client configs' }],
    context: (s) => (s.meta['real-clients'] == null ? null : Number(s.meta['real-clients']) > 0 ? 'with' : 'none'),
    ci: () => 'none',
    portable: true,
  },
  // 每多一个客户端配置多一组往返；runner 上没有任何配置，整套跳过。
  'real-configs': {
    head: 'full',
    fixtures: true,
    context: (s) => (/^\d+\/\d+$/.test(s.meta.fixtures ?? '') ? s.meta.fixtures : null),
    ci: () => null,
  },
  // 下面两个只是"有条件才跑"，数字本身与环境无关；标成变体是为了不让 CI 的 --portable 去核对它们。
  'shared-process': { head: 'full', slots: [], context: () => 'full', ci: () => null },
  acceptance: { head: 'full', slots: [], context: () => 'full', ci: () => null },
};

const FIX_KEY_RE = /^(\d+)\/(\d+)$/;

const isHeadKey = (spec, key) => {
  if (!spec) return true;
  if (spec.fixtures) {
    const m = FIX_KEY_RE.exec(key);
    return m ? m[1] === m[2] : key === spec.head;
  }
  return key === spec.head;
};

// ── 套件清单（从 test/run.mjs 的源码里取，不 import 它：import 会真的把测试跑起来）──

export function parseSuiteLists(source) {
  const grab = (name) => {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(source);
    if (!m) return [];
    // 先去掉注释：注释里可能写着 'xxx.mjs' 字样。
    const body = m[1].replace(/\/\/[^\n]*/g, '');
    return [...body.matchAll(/'([^']+?)\.mjs'/g)].map((x) => x[1]);
  };
  return { offline: grab('OFFLINE'), model: grab('MODEL') };
}

// ── 报告 ──────────────────────────────────────────────────────────

export function readReport(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read report ${path}: ${e.message}`);
  }
  if (data?.schema !== 1 || !Array.isArray(data.suites)) {
    throw new UsageError(`${path} is not a test report (schema 1 expected)`);
  }
  return data;
}

class UsageError extends Error {}

// ── 单元格：「主数字（其它环境的数字）」─────────────────────────────

/**
 * 解析 `59（非 Windows 56）` / `59 (56 off Windows)` / `84（7/9 配置时 66，5/9 配置时 48）` /
 * `8（无 DSH 时 skip）`。认不出的括号内片段原样保留（raw），不丢信息。解析不了整格返回 null。
 */
export function parseCell(text, lang, spec) {
  const m = /^\s*(\d+)\s*(?:[（(]\s*([\s\S]*?)\s*[）)])?\s*$/.exec(text);
  if (!m) return null;
  const model = { head: Number(m[1]), slots: new Map(), raw: [] };
  if (!m[2]) return model;
  for (const seg of m[2].split(lang === 'zh' ? /[，,]\s*/ : /,\s*/)) {
    const part = seg.trim();
    if (!part) continue;
    // 中文是「标签 数字」，英文是「数字 标签」；没有数字的片段（如「无 DSH 时 skip」）原样保留。
    const mm = lang === 'zh' ? /^(.*?)\s*(\d+)$/.exec(part) : /^(\d+)\s+(.*)$/.exec(part);
    const label = mm ? (lang === 'zh' ? mm[1] : mm[2]).trim() : null;
    const n = mm ? Number(lang === 'zh' ? mm[2] : mm[1]) : null;
    const key = label == null ? null : slotKeyOf(spec, label, lang);
    if (key == null) model.raw.push(part);
    else model.slots.set(key, n);
  }
  return model;
}

function slotKeyOf(spec, label, lang) {
  if (!spec) return null;
  for (const slot of spec.slots ?? []) if (slot[lang] === label) return slot.key;
  if (spec.fixtures) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(label);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

const fmtPart = (lang, label, n) => (lang === 'zh' ? `${label} ${n}` : `${n} ${label}`);

export function renderCell(model, lang, spec) {
  const parts = [];
  if (spec) {
    for (const slot of spec.slots ?? []) {
      if (model.slots.has(slot.key)) parts.push(fmtPart(lang, slot[lang], model.slots.get(slot.key)));
    }
    if (spec.fixtures) {
      const keys = [...model.slots.keys()]
        .filter((k) => FIX_KEY_RE.test(k))
        .sort((a, b) => Number(b.split('/')[0]) - Number(a.split('/')[0]));
      for (const k of keys) {
        parts.push(fmtPart(lang, lang === 'zh' ? `${k} 配置时` : `with ${k} fixtures`, model.slots.get(k)));
      }
    }
  }
  parts.push(...model.raw);
  if (!parts.length) return String(model.head);
  return lang === 'zh' ? `${model.head}（${parts.join('，')}）` : `${model.head} (${parts.join(', ')})`;
}

/** 把一次量到的数写进格子模型。 */
export function setMeasured(model, spec, key, n) {
  if (isHeadKey(spec, key)) model.head = n;
  else model.slots.set(key, n);
}

/** 某个环境在格子里记的数；没记过返回 undefined。 */
export function valueAt(model, spec, key) {
  if (isHeadKey(spec, key)) return model.head;
  return model.slots.get(key);
}

// ── 要写什么 ──────────────────────────────────────────────────────

/**
 * 哪些套件、量到哪一格、是多少。返回 { items, notes, problems }。
 * 报告按顺序逐份处理：items 里同一格的后一项会盖掉前一项。
 */
export function planMeasurements(reports, { portable }) {
  const items = [];
  const notes = [];
  const problems = [];
  for (const report of reports) {
    for (const raw of report.suites) {
      // 每个套件带上自己报告的环境：同一套件在不同报告里可以落在不同的格子。
      const s = { ...raw, meta: raw.meta ?? {}, platform: report.platform, hasDsh: Boolean(report.dsh) };
      if (s.exitCode !== 0 || s.failed > 0) {
        problems.push(`${s.suite} did not pass (exit ${s.exitCode}, ${s.failed} failed): its count is not trustworthy`);
        continue;
      }
      if (s.skipped) {
        notes.push(`${s.suite}: skipped in the report, its number is left as is`);
        continue;
      }
      if (s.counted === 'none') {
        notes.push(`${s.suite}: no summary line and no check marks in its output, left as is`);
        continue;
      }
      const spec = VARIANTS[s.suite];
      let key = 'head';
      if (spec) {
        key = spec.context(s);
        if (key == null) {
          notes.push(`${s.suite}: the report does not say which environment it ran in, left as is`);
          continue;
        }
      }
      if (portable && spec && !(spec.portable && key === spec.ci(s.platform))) continue;
      items.push({ name: s.suite, kind: s.kind, spec, key, n: s.passed });
    }
  }
  return { items, notes: [...new Set(notes)], problems: [...new Set(problems)] };
}

// ── 文档 ──────────────────────────────────────────────────────────

const ROW_RE = /^(\|\s*`([^`]+)`\s*\|\s*)([^|]*?)(\s*\|.*)$/;

const PLATFORM_LABEL = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

/**
 * 重写一份 tests.md：套件表里的数字 + 总数段落。
 * @returns {{ text:string, missing:string[], notes:string[] }}
 */
export function rewriteDoc(text, lang, plan, ctx) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const rows = new Map();
  lines.forEach((line, i) => {
    const m = ROW_RE.exec(line);
    if (m && !rows.has(m[2])) rows.set(m[2], i);
  });

  const missing = [];
  const notes = [];
  for (const it of plan.items) {
    const idx = rows.get(it.name);
    if (idx == null) {
      missing.push(it.name);
      continue;
    }
    const m = ROW_RE.exec(lines[idx]);
    const model = parseCell(m[3], lang, it.spec);
    if (!model) {
      notes.push(`${DOC_FILES[lang]}: the count cell of \`${it.name}\` is not a number ("${m[3]}"), left as is`);
      continue;
    }
    setMeasured(model, it.spec, it.key, it.n);
    lines[idx] = m[1] + renderCell(model, lang, it.spec) + m[4];
  }

  // 套件表里的格子模型（后面算总数用；只看当前这份文档里的数）。
  const cells = new Map();
  for (const [name, idx] of rows) {
    const m = ROW_RE.exec(lines[idx]);
    const model = parseCell(m[3], lang, VARIANTS[name]);
    if (model) cells.set(name, model);
  }

  let out = lines.join(eol);
  if (!ctx.portable) {
    const block = renderBlock(lang, cells, ctx);
    if (block) {
      const replaced = replaceBlock(out, block, eol);
      if (replaced == null) notes.push(`${DOC_FILES[lang]}: counts:begin/counts:end markers not found, totals not rewritten`);
      else out = replaced;
    }
  }
  return { text: out, missing, notes, rows };
}

function replaceBlock(text, block, eol) {
  const b = BLOCK_BEGIN_RE.exec(text);
  if (!b) return null;
  const start = b.index + b[0].length;
  const end = text.indexOf(BLOCK_END, start);
  if (end < 0) return null;
  return text.slice(0, start) + eol + block.join(eol) + eol + text.slice(end);
}

const REGISTRAR = ['setup', 'removal-scope', 'config-safety', 'real-configs'];

/** 总数段落（markdown 行）。数据不全时返回 null，保留原文。 */
function renderBlock(lang, cells, ctx) {
  const { report, lists } = ctx;
  if (!report) return null;
  const offlineSuites = report.suites.filter((s) => s.kind === 'offline');
  const checks = offlineSuites.reduce((n, s) => n + s.passed, 0);

  const head = (name) => cells.get(name)?.head;
  const measured = (name) => {
    const s = report.suites.find((x) => x.suite === name);
    if (!s) return head(name);
    return s.skipped ? 0 : s.passed;
  };

  // 客户端注册器套件：优先取这份报告量到的数。
  const registrar = REGISTRAR.map((name) => ({ name, n: measured(name), skipped: report.suites.find((x) => x.suite === name)?.skipped }));
  const registrarOk = registrar.every((r) => r.n != null);
  const registrarSum = registrar.reduce((n, r) => n + (r.n ?? 0), 0);

  // 需要模型的套件：名义合计（取各自表里的主数字）。
  const modelNames = lists.model;
  const modelNums = modelNames.map((name) => head(name));
  const modelOk = modelNames.length > 0 && modelNums.every((n) => n != null);
  const modelSum = modelNums.reduce((n, v) => n + (v ?? 0), 0);
  const smokeCell = cells.get('smoke');
  const smokeExtra = smokeCell && smokeCell.slots.has('nodsh') ? smokeCell.head - smokeCell.slots.get('nodsh') : null;

  // CI 离线 job 的名义总数：runner 没有 DSH、没有客户端配置。
  const ciTotal = (platform) => {
    let sum = 0;
    for (const name of lists.offline) {
      const model = cells.get(name);
      if (!model) return null;
      const spec = VARIANTS[name];
      if (!spec) {
        sum += model.head;
        continue;
      }
      const key = spec.ci(platform);
      if (key == null) continue;
      const v = valueAt(model, spec, key);
      if (v === undefined) return null;
      sum += v;
    }
    return sum;
  };
  const ciLinux = ciTotal('linux');
  const ciWin = ciTotal('win32');

  // 不写日期、Node 版本、DSH 版本：检查数不依赖它们，写进去只会让 `docs:counts:check`
  // 在每次重跑、每次升级之后都报"不一致"（日期交给 git 历史）。只留真正会改变总数的环境因素。
  const platform = PLATFORM_LABEL[report.platform] ?? report.platform;
  const fx = report.fixtures?.clientConfigs;
  const realSkipped = report.suites.find((s) => s.suite === 'real-configs')?.skipped;

  const zh = lang === 'zh';
  const dshText = report.dsh ? (zh ? '装了 DSH' : 'DSH installed') : zh ? '没有 DSH' : 'no DSH';
  const fxText = fx
    ? zh ? `，${fx.present}/${fx.total} 个客户端配置 fixture` : `, ${fx.present}/${fx.total} client config fixtures`
    : realSkipped ? (zh ? '，没有客户端配置 fixture' : ', no client config fixtures') : '';
  const ciText = ciLinux == null
    ? null
    : ciWin == null || ciWin === ciLinux
      ? String(ciLinux)
      : zh ? `Linux/macOS ${ciLinux}，Windows ${ciWin}` : `${ciLinux} on Linux/macOS, ${ciWin} on Windows`;

  const lines = [];
  if (zh) {
    lines.push(
      `**\`node test/run.mjs\` 在本机（${platform}，${dshText}${fxText}）跑了 ${offlineSuites.length} 个离线套件、${checks} 项检查，全部通过。**表中带括号的数字随环境变化（有没有 DSH、哪个平台、文件系统是否区分大小写、本机装了几个客户端配置），套件总数也随之变化；这一行记录的是上次同步所用报告的环境。`,
    );
    if (registrarOk) {
      const list = registrar.map((r) => (r.skipped ? `\`${r.name}\` 已跳过` : `\`${r.name}\` ${r.n}`)).join('、');
      lines.push('', `其中 **${registrarSum} 项属于客户端注册器套件**（${list}）—— 0.3 的活其实都在这里。`);
    }
    if (modelOk) {
      const list = modelNames.map((name, i) => `\`${name}\` ${modelNums[i]}`).join('、');
      const extra = smokeExtra ? `；有 DSH 时 \`smoke\` 还会多跑 ${smokeExtra} 项会话段` : '';
      lines.push(
        '',
        `需要模型的套件（${list}）名义合计 **${modelSum} 项**${extra}。它们要可用的 DSH 与 provider，发版前请自己重跑一遍：\`node test/run.mjs --all\`。\`acceptance\` 在没有 IDA MCP（\`mcp__ida__*\`）时会明确 **skip**；\`shared-process\` 没有 DSH 时也会 skip。`,
      );
    }
    if (ciText != null && modelOk) {
      lines.push(
        '',
        `> 三个总数是刻意分开的：本机 \`node test/run.mjs\`（${checks}）、CI 离线 job（名义 ${ciText}；hosted runner 没有 DSH 也没有客户端 fixture，\`smoke\` 跳过会话段、\`real-configs\` 整体跳过）、需要模型的集合（名义 ${modelSum}）。数字取各套件自己打印的汇总，由 \`npm run docs:counts\` 从报告写回，不在这里手抄；不要把一个数字套到另一个 runner 上。`,
      );
    }
  } else {
    lines.push(
      `**\`node test/run.mjs\` ran ${checks} checks in ${offlineSuites.length} offline suites on this machine (${platform}, ${dshText}${fxText}), all passing.** Parenthesised numbers in the table depend on the environment (DSH present or not, platform, filesystem case sensitivity, how many client configs the machine has), so the total moves with it; this line records the environment of the report used for the last sync.`,
    );
    if (registrarOk) {
      const list = registrar.map((r) => (r.skipped ? `\`${r.name}\` skipped` : `\`${r.name}\` ${r.n}`)).join(', ');
      lines.push('', `That is **${registrarSum} assertions in the client-registration suites alone** (${list}), which is where the 0.3 work actually is.`);
    }
    if (modelOk) {
      const list = modelNames.map((name, i) => `\`${name}\` ${modelNums[i]}`).join(', ');
      const extra = smokeExtra ? `; with DSH present \`smoke\` runs ${smokeExtra} more checks in its session sections` : '';
      lines.push(
        '',
        `The model-backed suites (${list}) total **${modelSum} checks** nominally${extra}. They need a working DSH and provider, so re-run them yourself before trusting a release: \`node test/run.mjs --all\`. \`acceptance\` **skips explicitly** when the DSH profile has no IDA MCP (\`mcp__ida__*\`); \`shared-process\` also skips without DSH.`,
      );
    }
    if (ciText != null && modelOk) {
      lines.push(
        '',
        `> Three different totals are intentional: \`node test/run.mjs\` on this machine (${checks}), the CI offline job (nominal ${ciText}; hosted runners have no DSH and no client fixtures, so \`smoke\` skips its session sections and \`real-configs\` skips entirely), and the model-backed set (${modelSum} nominal). Counts are the numbers each suite prints itself, written back from the report by \`npm run docs:counts\`; don't copy them by hand and don't use one number for a different runner.`,
      );
    }
  }
  return lines;
}

// ── tests.yml 的范围注释 ──────────────────────────────────────────

const YML_LINE_RE = /^(#\s+)([a-z][a-z0-9-]*)(\s+.*)$/;
const YML_COUNT_RE = /(\d+) checks(?: \((\d+) off Windows\))?/;

/**
 * 重写 workflow 注释里的 `N checks`（及 `(M off Windows)`）。
 * 数字取 CI 环境对应的那一格：runner 没有 DSH、没有客户端配置。
 */
export function rewriteWorkflow(text, docModels, offlineNames, portable) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const notes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = YML_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const name = m[2];
    if (!offlineNames.has(name)) continue;
    if (!YML_COUNT_RE.test(lines[i])) continue;
    const spec = VARIANTS[name];
    // --portable 不碰随平台/文件系统变化的套件，它们的注释行也不动。
    if (portable && spec && !spec.portable) continue;
    const model = docModels.get(name);
    if (!model) {
      notes.push(`${WORKFLOW_FILE}: \`${name}\` has no row in the docs table, line left as is`);
      continue;
    }
    const text2 = ymlCount(name, spec, model);
    if (text2 == null) continue;
    lines[i] = lines[i].replace(YML_COUNT_RE, text2);
  }
  return { text: lines.join(eol), notes };
}

function ymlCount(name, spec, model) {
  if (!spec) return `${model.head} checks`;
  const win = spec.ci('win32');
  const other = spec.ci('linux');
  if (win == null && other == null) return null;
  const vWin = valueAt(model, spec, win);
  const vOther = valueAt(model, spec, other);
  if (vWin === undefined || vOther === undefined) return null;
  if (vWin === vOther) return `${vWin} checks`;
  // 只有「Windows 是主数字、其它平台是一个 slot」时才写得成 `18 checks (16 off Windows)`。
  const slot = spec.slots.find((s) => s.key === other);
  const label = slot?.yml ?? slot?.en;
  return label === 'off Windows' && win === spec.head ? `${vWin} checks (${vOther} off Windows)` : null;
}

// ── 差异显示 ──────────────────────────────────────────────────────

/**
 * 行级差异：先去掉共同的首尾，再对中间做 LCS。文档才几百行，O(n*m) 足够。
 * 不能只做"逐行配对"：总数段落的行数会变，行数一变，后面所有行都会错位成一大片假差异。
 * 返回 [{ line（旧文件里的行号）, removed:[], added:[] }]。
 */
function diffHunks(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea -= 1;
    eb -= 1;
  }
  const x = a.slice(s, ea);
  const y = b.slice(s, eb);
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < y.length && (i === x.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      cur ??= { line: s + i + 1, removed: [], added: [] };
      cur.added.push(y[j]);
      j += 1;
    } else {
      cur ??= { line: s + i + 1, removed: [], added: [] };
      cur.removed.push(x[i]);
      i += 1;
    }
  }
  flush();
  return hunks;
}

const clip = (s) => (s.length > 170 ? s.slice(0, 167) + '...' : s);

// ── 入口 ──────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @param {{root?:string, out?:(s:string)=>void, err?:(s:string)=>void}} io
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  let root = io.root ?? DEFAULT_ROOT;
  const reportPaths = [];
  let check = false;
  let portable = false;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      const value = () => {
        const v = argv[i + 1];
        if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
        i += 1;
        return v;
      };
      if (a === '--check') check = true;
      else if (a === '--portable') portable = true;
      else if (a === '--report') reportPaths.push(resolve(value()));
      else if (a.startsWith('--report=')) reportPaths.push(resolve(a.slice('--report='.length)));
      else if (a === '--root') root = resolve(value());
      else if (a === '--help' || a === '-h') {
        out('usage: node scripts/sync-test-counts.mjs [--report <path>]... [--check] [--portable]');
        return 0;
      } else throw new UsageError(`unknown argument ${a}`);
    }

    if (!reportPaths.length) {
      const def = join(root, DEFAULT_REPORT);
      if (!existsSync(def)) {
        throw new UsageError(`no report at ${def}; run \`node test/run.mjs\` (add --all for model suites) first, or pass --report <path>`);
      }
      reportPaths.push(def);
    }
    const reports = reportPaths.map(readReport);

    const lists = parseSuiteLists(readFileSync(join(root, RUN_FILE), 'utf8'));
    if (!lists.offline.length) throw new UsageError(`could not read the OFFLINE list from ${RUN_FILE}`);

    const plan = planMeasurements(reports, { portable });
    if (plan.problems.length) {
      for (const p of plan.problems) err(`docs:counts: ${p}`);
      err('docs:counts: refusing to use a report with failing suites');
      return 2;
    }

    // 总数段落里的"本机实测"取最后一份含离线套件的报告。
    const contextReport = [...reports].reverse().find((r) => r.suites.some((s) => s.kind === 'offline')) ?? null;
    const ctx = { report: contextReport, lists, portable };
    const issues = [];
    const diffs = [];
    const docModels = new Map();

    for (const lang of ['zh', 'en']) {
      const file = join(root, DOC_FILES[lang]);
      if (!existsSync(file)) {
        issues.push(`${DOC_FILES[lang]} not found`);
        continue;
      }
      const before = readFileSync(file, 'utf8');
      const res = rewriteDoc(before, lang, plan, ctx);
      for (const name of res.missing) issues.push(`${DOC_FILES[lang]}: no table row for suite \`${name}\`; add one by hand`);
      for (const n of res.notes) issues.push(n);
      // 文档里有行、但 run.mjs 的两个清单里都没有的套件：多半是删了套件没删行。
      const known = new Set([...lists.offline, ...lists.model]);
      for (const name of res.rows.keys()) {
        if (!known.has(name)) issues.push(`${DOC_FILES[lang]}: table row \`${name}\` is not in the ${RUN_FILE} OFFLINE/MODEL lists`);
      }
      // 写 tests.yml 注释时用中文文档里（已更新过的）格子；两份文档的数字本来就该一致。
      if (lang === 'zh') {
        const outLines = res.text.split(/\r?\n/);
        for (const [name, idx] of res.rows) {
          const model = parseCell(ROW_RE.exec(outLines[idx])[3], lang, VARIANTS[name]);
          if (model) docModels.set(name, model);
        }
      }
      if (res.text !== before) diffs.push({ file: DOC_FILES[lang], before, after: res.text, path: file });
    }

    const ymlFile = join(root, WORKFLOW_FILE);
    if (existsSync(ymlFile)) {
      const before = readFileSync(ymlFile, 'utf8');
      const res = rewriteWorkflow(before, docModels, new Set(lists.offline), portable);
      for (const n of res.notes) issues.push(n);
      if (res.text !== before) diffs.push({ file: WORKFLOW_FILE, before, after: res.text, path: ymlFile });
    }

    for (const n of plan.notes) out(`docs:counts: ${n}`);
    const hasModel = reports.some((r) => r.suites.some((s) => s.kind === 'model'));
    if (!hasModel && !portable) {
      out('docs:counts: the report has no model-backed suites (run `node test/run.mjs --all`), so their numbers were left untouched');
    }

    if (check) {
      if (diffs.length) {
        for (const d of diffs) {
          err(`docs:counts: ${d.file} disagrees with the report:`);
          for (const h of diffHunks(d.before, d.after)) {
            err(`  ${d.file}:${h.line}`);
            for (const l of h.removed) err(`    - ${clip(l)}`);
            for (const l of h.added) err(`    + ${clip(l)}`);
          }
        }
        err('docs:counts: run `npm run docs:counts` to rewrite them from the report');
      }
      for (const i of issues) err(`docs:counts: ${i}`);
      if (!diffs.length && !issues.length) out(`docs:counts: docs agree with the report${portable ? ' (portable suites only)' : ''}`);
      return diffs.length || issues.length ? 1 : 0;
    }

    for (const d of diffs) {
      writeFileSync(d.path, d.after, 'utf8');
      out(`docs:counts: updated ${d.file}`);
      for (const h of diffHunks(d.before, d.after)) {
        for (const l of h.removed) out(`    - ${clip(l)}`);
        for (const l of h.added) out(`    + ${clip(l)}`);
      }
    }
    if (!diffs.length) out('docs:counts: docs already match the report');
    for (const i of issues) err(`docs:counts: ${i}`);
    return issues.length ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`docs:counts: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
