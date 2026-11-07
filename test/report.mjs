/**
 * 测试报告：把每个套件打印出来的内容解析成机器可读的检查数。
 *
 * 为什么要有它：中英文 tests.md 与 .github/workflows/tests.yml 里的检查数原先是手抄的，
 * 一改测试就漂（failure-terminal 文档写 11、实际 10；dispatch-tools 写 59、实际 58）。
 * 现在 test/run.mjs 把每个套件的输出收下来、解析成 JSON，
 * 再由 scripts/sync-test-counts.mjs 写回文档 —— 数字只来自测试自己打印的那一行。
 *
 * 取数优先级（越靠前越可靠）：
 *   1) 套件自己的汇总行：`===== 冒烟测试：通过 33，失败 0 =====`、
 *      `===== setup regression: passed 45, failed 0 =====`、
 *      `===== real configs: skipped (0 checks) =====`；
 *   2) 没有汇总行时数 `✓` / `✗` 开头的行（approval-details 只在全绿时才打印汇总）；
 *   3) 都没有：记 0 项（退出码非 0 时记 1 项失败），并标成 counted='none'，由调用方决定怎么办。
 *
 * 套件还可以打印 `[report] key=value key2=value2` 行，把"检查数随环境变化"的条件
 * 交给报告（有没有 DSH、装了几个客户端配置、文件系统是否区分大小写）。
 *
 * 零依赖。这个文件只被 test/ 下的东西引用，不进 npm 包（package.json 的 files 不含 test/）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA = 1;

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认报告位置：仓库里已被 .gitignore 的 `.state/`（含本机绝对路径之类，不入库）。 */
export const DEFAULT_REPORT_PATH = join(HERE, '..', '.state', 'test-report.json');

// 汇总行：`=====` 夹着"…通过 N，失败 M"（中文）或"…passed N, failed M"（英文）。
const SUMMARY_RE = /^\s*=+\s*.*?(?:通过|passed)\s*(\d+)\s*[,，]\s*(?:失败|failed)\s*(\d+)\s*=+\s*$/;
// 整套跳过：`===== xxx: skipped (0 checks) =====`。
const SKIP_RE = /^\s*=+\s*.*?\bskipped\s*\((\d+)\s*checks?\)\s*=+\s*$/i;
const META_RE = /^\[report\]\s+(\S.*)$/;
const OK_MARK = /^\s*[✓✔]\s/; // ✓ ✔
const BAD_MARK = /^\s*[✗✘]\s/; // ✗ ✘
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

/** `smoke.mjs` -> `smoke`。 */
export const suiteName = (script) => String(script).replace(/\.mjs$/, '');

/**
 * 解析一个套件的完整输出。
 * @returns {{passed:number, failed:number, skipped:boolean, counted:'summary'|'marks'|'none',
 *            marks:{passed:number, failed:number}, meta:Record<string,string>}}
 */
export function parseSuiteOutput(text, exitCode = 0) {
  let summary = null;
  let skipped = false;
  const marks = { passed: 0, failed: 0 };
  const meta = {};
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    let m = SUMMARY_RE.exec(line);
    if (m) {
      summary = { passed: Number(m[1]), failed: Number(m[2]) };
      skipped = false;
      continue;
    }
    m = SKIP_RE.exec(line);
    if (m) {
      summary = { passed: Number(m[1]), failed: 0 };
      skipped = true;
      continue;
    }
    m = META_RE.exec(line);
    if (m) {
      for (const token of m[1].trim().split(/\s+/)) {
        const eq = token.indexOf('=');
        if (eq > 0) meta[token.slice(0, eq)] = token.slice(eq + 1);
      }
      continue;
    }
    if (OK_MARK.test(line)) marks.passed += 1;
    else if (BAD_MARK.test(line)) marks.failed += 1;
  }

  if (summary) return { ...summary, skipped, counted: 'summary', marks, meta };
  if (marks.passed || marks.failed) {
    // 没有汇总行却以非 0 退出（例如断言直接抛出）：✗ 行可能一条都没有，至少记 1 项失败。
    const failed = exitCode !== 0 ? Math.max(marks.failed, 1) : marks.failed;
    return { passed: marks.passed, failed, skipped: false, counted: 'marks', marks, meta };
  }
  return { passed: 0, failed: exitCode !== 0 ? 1 : 0, skipped: false, counted: 'none', marks, meta };
}

/**
 * 解析 `--report <path>` / `--report=<path>` / `--no-report`。
 * 没写时用默认位置，`explicit` 标明是不是用户点名的（点名的写失败要算失败，默认的只警告）。
 */
export function parseReportArgs(argv, defaultPath = DEFAULT_REPORT_PATH) {
  if (argv.includes('--no-report')) return { path: null, explicit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--report 需要一个文件路径');
      return { path: resolve(value), explicit: true };
    }
    if (a.startsWith('--report=')) {
      const value = a.slice('--report='.length);
      if (!value) throw new Error('--report= 需要一个文件路径');
      return { path: resolve(value), explicit: true };
    }
  }
  return { path: defaultPath, explicit: false };
}

/** 本机环境：平台、Node、DSH（找不到就是 null，并带上原因）。 */
export async function collectEnvironment() {
  const env = { platform: process.platform, arch: process.arch, node: process.version, dsh: null };
  try {
    const { resolveDsh } = await import('../src/dsh-locate.mjs');
    const d = resolveDsh();
    // 不记 bin 路径：报告可能被贴进 issue，本机绝对路径没有必要出现。
    env.dsh = { version: d.version ?? null, source: d.source ?? null, runtime: d.runtime ?? null };
  } catch (e) {
    env.dshNote = String(e?.message ?? e).split('\n')[0];
  }
  return env;
}

/**
 * 由各套件的运行结果拼出报告。
 * results: [{ script, kind: 'offline'|'model'|'cleanup', code, durationMs, output }]
 */
export function buildReport({ argv = [], all = false, results, env, startedAt, endedAt }) {
  const suites = [];
  let cleanup = null;
  for (const r of results) {
    if (r.kind === 'cleanup') {
      cleanup = { exitCode: r.code, durationMs: r.durationMs };
      continue;
    }
    const p = parseSuiteOutput(r.output, r.code);
    const entry = {
      suite: suiteName(r.script),
      kind: r.kind,
      exitCode: r.code,
      passed: p.passed,
      failed: p.failed,
      skipped: p.skipped,
      durationMs: r.durationMs,
      counted: p.counted,
      marks: p.marks,
    };
    if (Object.keys(p.meta).length) entry.meta = p.meta;
    suites.push(entry);
  }

  const real = suites.find((s) => s.suite === 'real-configs');
  let fixtures = null;
  if (real?.meta?.fixtures) {
    const m = /^(\d+)\/(\d+)$/.exec(real.meta.fixtures);
    if (m) {
      fixtures = {
        clientConfigs: {
          present: Number(m[1]),
          total: Number(m[2]),
          ids: real.meta.ids && real.meta.ids !== '-' ? real.meta.ids.split(',') : [],
        },
      };
    }
  }

  const sum = (kind, field) => suites.filter((s) => s.kind === kind).reduce((n, s) => n + s[field], 0);
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date(endedAt).toISOString(),
    command: ['node test/run.mjs', ...argv].join(' '),
    mode: all ? 'all' : 'offline',
    platform: env.platform,
    arch: env.arch,
    node: env.node,
    dsh: env.dsh,
    ...(env.dshNote ? { dshNote: env.dshNote } : {}),
    fixtures,
    durationMs: endedAt - startedAt,
    suites,
    cleanup,
    totals: {
      suites: suites.length,
      failedSuites: suites.filter((s) => s.exitCode !== 0).length,
      skippedSuites: suites.filter((s) => s.skipped).length,
      offlinePassed: sum('offline', 'passed'),
      offlineFailed: sum('offline', 'failed'),
      modelPassed: sum('model', 'passed'),
      modelFailed: sum('model', 'failed'),
    },
  };
}

export function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
