/**
 * 检查数同步的回归：套件输出解析（test/report.mjs）+ 把报告写回文档（scripts/sync-test-counts.mjs）。
 *
 * 为什么要测：文档里的检查数原先手抄，漂过（failure-terminal 写 11 实际 10；dispatch-tools 写 59
 * 实际 58）。现在由脚本从报告写回，这个脚本自己出错（读错汇总行、把一个环境的数字写进另一个环境的格子、
 * 悄悄改了模型套件的数字）就会让文档"看起来是测出来的"却是假的，所以必须有测试。
 *
 * 全部在临时目录里的一份最小仓库上跑，不碰真实文档、不拉 DSH、不花 token，可以进 CI。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeSandboxHome, removeSandbox } from './sandbox-home.mjs';
import { buildReport, parseReportArgs, parseSuiteOutput } from './report.mjs';
import { main as syncMain, parseCell, parseSuiteLists, renderCell, setMeasured, valueAt, VARIANTS } from '../scripts/sync-test-counts.mjs';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); failed++; }
};
const preview = (s) => String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 300);

// ── [1] 套件输出解析 ───────────────────────────────────────────────

console.log('\n[1] parseSuiteOutput');
{
  let p = parseSuiteOutput('  ✓ a\n  ✓ b\n\n===== 冒烟测试：通过 33，失败 0 =====\n', 0);
  check('中文汇总行', p.passed === 33 && p.failed === 0 && !p.skipped && p.counted === 'summary', JSON.stringify(p));

  p = parseSuiteOutput('\n===== setup regression: passed 45, failed 0 =====\n', 0);
  check('英文汇总行', p.passed === 45 && p.failed === 0 && p.counted === 'summary', JSON.stringify(p));

  p = parseSuiteOutput('===== 并发管理测试：通过 29，失败 2 =====\n', 1);
  check('失败数取自汇总行', p.passed === 29 && p.failed === 2, JSON.stringify(p));

  p = parseSuiteOutput('\n===== real configs: skipped (0 checks) =====\n', 0);
  check('整套跳过：skipped=true、0 项', p.skipped === true && p.passed === 0 && p.failed === 0 && p.counted === 'summary', JSON.stringify(p));

  p = parseSuiteOutput('\n===== acceptance: skipped (0 checks) =====\n', 0);
  check('acceptance 的跳过汇总行也认得', p.skipped === true, JSON.stringify(p));

  p = parseSuiteOutput('  ✓ 一\n  ✓ 二\n  ✓ 三\n  ✗ 四\n\n总结果: 3 项失败\n', 1);
  check('没有汇总行时数 ✓/✗ 行', p.passed === 3 && p.failed === 1 && p.counted === 'marks', JSON.stringify(p));

  p = parseSuiteOutput('  ✓ 一\n  ✓ 二\n\n总结果: 通过 ✅\n', 0);
  check('"总结果: 通过" 的老套件：按 ✓ 行数', p.passed === 2 && p.failed === 0 && p.counted === 'marks', JSON.stringify(p));

  p = parseSuiteOutput('  ✓ 一\n  ✓ 二\nAssertionError: boom\n', 1);
  check('没有汇总行、退出码非 0（断言抛出）：至少记 1 项失败', p.passed === 2 && p.failed === 1, JSON.stringify(p));

  p = parseSuiteOutput('\npackage.json\n  ✓ name is x\n  ✓ version is 1\n\nall checks passed\n', 0);
  check('package-check 的老输出（无汇总行）按 ✓ 行数', p.passed === 2 && p.counted === 'marks', JSON.stringify(p));

  p = parseSuiteOutput('随便一些输出\n', 0);
  check('什么都认不出：0 项、counted=none', p.passed === 0 && p.failed === 0 && p.counted === 'none', JSON.stringify(p));
  p = parseSuiteOutput('随便一些输出\n', 1);
  check('什么都认不出且退出码非 0：记 1 项失败', p.failed === 1 && p.counted === 'none', JSON.stringify(p));

  p = parseSuiteOutput('  ✓ 打印了 "===== x: passed 5, failed 0 =====" 这样的字样\n  ✓ 另一条\n', 0);
  check('✓ 行里引用汇总行字样不会被当成汇总行', p.counted === 'marks' && p.passed === 2, JSON.stringify(p));

  p = parseSuiteOutput('===== a：通过 1，失败 0 =====\r\n===== b：通过 7，失败 0 =====\r\n', 0);
  check('CRLF 换行 + 多个汇总行取最后一个', p.passed === 7, JSON.stringify(p));

  p = parseSuiteOutput('\u001b[32m===== 冒烟测试：通过 12，失败 0 =====\u001b[0m\n', 0);
  check('带 ANSI 颜色码的汇总行', p.passed === 12 && p.counted === 'summary', JSON.stringify(p));

  p = parseSuiteOutput('[report] fixtures=5/9 ids=claude-code,codex\n[report] dsh=0\n===== real configs: passed 48, failed 0 =====\n', 0);
  check('[report] 环境标注被收进 meta', p.meta.fixtures === '5/9' && p.meta.ids === 'claude-code,codex' && p.meta.dsh === '0', JSON.stringify(p.meta));
  check('[report] 行不影响计数', p.passed === 48 && p.marks.passed === 0, JSON.stringify(p));
}

// ── [2] 命令行参数 ─────────────────────────────────────────────────

console.log('\n[2] parseReportArgs');
{
  const def = join('x', 'default.json');
  check('没写时用默认位置、非显式', (() => { const r = parseReportArgs(['--all'], def); return r.path === def && r.explicit === false; })());
  check('--report <path>', (() => { const r = parseReportArgs(['--all', '--report', 'out.json'], def); return /out\.json$/.test(r.path) && r.explicit === true; })());
  check('--report=<path>', (() => { const r = parseReportArgs(['--report=a/b.json'], def); return /b\.json$/.test(r.path) && r.explicit === true; })());
  check('--no-report 关掉', parseReportArgs(['--no-report'], def).path === null);
  check('--report 缺值报错', (() => { try { parseReportArgs(['--report'], def); return false; } catch { return true; } })());
  check('--report 后面紧跟另一个选项也算缺值', (() => { try { parseReportArgs(['--report', '--all'], def); return false; } catch { return true; } })());
}

// ── [3] 拼报告 ─────────────────────────────────────────────────────

console.log('\n[3] buildReport');
{
  const results = [
    { script: 'smoke.mjs', kind: 'offline', code: 0, durationMs: 12, output: '[report] dsh=0\n===== 冒烟测试：通过 20，失败 0 =====\n' },
    { script: 'real-configs.mjs', kind: 'offline', code: 0, durationMs: 34, output: '[report] fixtures=5/9 ids=codex,zed\n===== real configs: passed 48, failed 0 =====\n' },
    { script: 'boundary.mjs', kind: 'model', code: 0, durationMs: 56, output: '===== 边界测试：通过 46，失败 0 =====\n' },
    { script: 'cleanup.mjs', kind: 'cleanup', code: 0, durationMs: 7, output: '' },
  ];
  const r = buildReport({
    argv: ['--all'], all: true, results,
    env: { platform: 'win32', arch: 'x64', node: 'v22.19.0', dsh: null, dshNote: 'no dsh' },
    startedAt: Date.parse('2026-11-07T10:00:00Z'), endedAt: Date.parse('2026-11-07T10:00:05Z'),
  });
  check('每个套件一条记录，cleanup 单列', r.suites.length === 3 && r.cleanup?.exitCode === 0 && !r.suites.some((s) => s.suite === 'cleanup'));
  check('字段：suite/kind/exitCode/passed/failed/skipped/durationMs',
    r.suites.every((s) => ['suite', 'kind', 'exitCode', 'passed', 'failed', 'skipped', 'durationMs'].every((k) => k in s)), JSON.stringify(r.suites[0]));
  check('套件名去掉 .mjs', r.suites[0].suite === 'smoke');
  check('平台 / Node / DSH 记在顶层', r.platform === 'win32' && r.node === 'v22.19.0' && r.dsh === null && r.dshNote === 'no dsh');
  check('mode 与 command', r.mode === 'all' && r.command === 'node test/run.mjs --all', r.command);
  check('客户端配置 fixture 取自 real-configs 的标注',
    r.fixtures?.clientConfigs?.present === 5 && r.fixtures.clientConfigs.total === 9 && r.fixtures.clientConfigs.ids.join() === 'codex,zed', JSON.stringify(r.fixtures));
  check('合计分开统计离线与模型', r.totals.offlinePassed === 68 && r.totals.modelPassed === 46 && r.totals.failedSuites === 0, JSON.stringify(r.totals));
  check('耗时与生成时间', r.durationMs === 5000 && r.generatedAt === '2026-11-07T10:00:05.000Z', JSON.stringify([r.durationMs, r.generatedAt]));
  const none = buildReport({ all: false, results: [results[0]], env: { platform: 'linux', arch: 'x64', node: 'v24.0.0', dsh: { version: '0.2.2' } }, startedAt: 0, endedAt: 1 });
  check('没有 real-configs 时 fixtures 为 null；DSH 信息原样带上', none.fixtures === null && none.dsh.version === '0.2.2' && none.mode === 'offline');
}

// ── [4] 套件清单 ───────────────────────────────────────────────────

console.log('\n[4] parseSuiteLists');
const RUN_SOURCE = [
  "const OFFLINE = [",
  "  'smoke.mjs',",
  "  // 注释里提到 'ghost.mjs' 不该被当成套件",
  "  'alpha.mjs',",
  "  'beta.mjs',",
  "  'dispatch-tools.mjs',",
  "  'config-safety.mjs',",
  "  'real-configs.mjs',",
  "  'gamma.mjs', // 行尾注释 'phantom.mjs'",
  "];",
  "const MODEL = [",
  "  'boundary.mjs',",
  "  'shared-process.mjs',",
  "];",
  "",
].join('\n');
{
  const l = parseSuiteLists(RUN_SOURCE);
  check('OFFLINE 清单', l.offline.join() === 'smoke,alpha,beta,dispatch-tools,config-safety,real-configs,gamma', l.offline.join());
  check('MODEL 清单', l.model.join() === 'boundary,shared-process', l.model.join());
  check('读不到清单时返回空数组', parseSuiteLists('const x = 1;').offline.length === 0);
}

// ── [5] 单元格 ─────────────────────────────────────────────────────

console.log('\n[5] 「主数字（其它环境的数字）」单元格');
{
  const v = VARIANTS['dispatch-tools'];
  let m = parseCell('59（非 Windows 56）', 'zh', v);
  check('中文：59（非 Windows 56）', m.head === 59 && m.slots.get('other') === 56 && renderCell(m, 'zh', v) === '59（非 Windows 56）');
  m = parseCell('59 (56 off Windows)', 'en', v);
  check('英文：59 (56 off Windows)', m.head === 59 && m.slots.get('other') === 56 && renderCell(m, 'en', v) === '59 (56 off Windows)');
  setMeasured(m, v, 'win32', 58);
  check('量到主环境只改主数字，其它格原样', renderCell(m, 'en', v) === '58 (56 off Windows)');
  setMeasured(m, v, 'other', 55);
  check('量到另一环境只改那一格', renderCell(m, 'en', v) === '58 (55 off Windows)');
  check('valueAt 读主数字与 slot', valueAt(m, v, 'win32') === 58 && valueAt(m, v, 'other') === 55 && valueAt(parseCell('7', 'zh', v), v, 'other') === undefined);

  const rc = VARIANTS['real-configs'];
  m = parseCell('84（7/9 配置时 66，本机 5/9 时 48）', 'zh', rc);
  check('real-configs 老写法被认出（含"本机"）', m.head === 84 && m.slots.get('7/9') === 66 && m.slots.get('5/9') === 48);
  check('real-configs 重写成统一写法', renderCell(m, 'zh', rc) === '84（7/9 配置时 66，5/9 配置时 48）', renderCell(m, 'zh', rc));
  m = parseCell('84 (66 with 7/9, 48 with 5/9 fixtures)', 'en', rc);
  check('real-configs 英文老写法', m.slots.get('7/9') === 66 && m.slots.get('5/9') === 48 && renderCell(m, 'en', rc) === '84 (66 with 7/9 fixtures, 48 with 5/9 fixtures)', renderCell(m, 'en', rc));
  setMeasured(m, rc, '9/9', 90);
  check('9/9 就是主数字', m.head === 90 && !m.slots.has('9/9'));
  setMeasured(m, rc, '6/9', 57);
  check('新的客户端数补一格，按数量从多到少排', renderCell(m, 'zh', rc) === '90（7/9 配置时 66，6/9 配置时 57，5/9 配置时 48）', renderCell(m, 'zh', rc));

  const sp = VARIANTS['shared-process'];
  m = parseCell('8（无 DSH 时 skip）', 'zh', sp);
  check('只有说明没有数字的括号原样保留', m.head === 8 && m.raw.join() === '无 DSH 时 skip' && renderCell(m, 'zh', sp) === '8（无 DSH 时 skip）');
  setMeasured(m, sp, 'full', 9);
  check('保留说明的同时更新主数字', renderCell(m, 'zh', sp) === '9（无 DSH 时 skip）');
  m = parseCell('8 (skips without DSH)', 'en', sp);
  check('英文说明原样保留', renderCell(m, 'en', sp) === '8 (skips without DSH)');

  check('纯数字', renderCell(parseCell(' 33 ', 'zh', undefined), 'zh', undefined) === '33');
  check('认不出的整格返回 null（不乱改）', parseCell('—', 'zh', undefined) === null && parseCell('', 'en', undefined) === null);
}

// ── [6] 在一份最小仓库上端到端 ─────────────────────────────────────

console.log('\n[6] 端到端：报告 -> 文档 / tests.yml');

const root = makeSandboxHome('dsh-any-agent-counts-');
const write = (rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
};
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const ZH_ROWS = [
  '| 套件 | 检查数 | 覆盖 |',
  '|---|---|---|',
  '| `smoke` | 33 | 握手 |',
  '| `alpha` | 5 | 甲 |',
  '| `beta` | 9 | 乙 |',
  '| `gamma` | 4 | 丙 |',
  '| `dispatch-tools` | 59（非 Windows 56） | 派发面 |',
  '| `config-safety` | 407（无客户端配置时 406） | 配置安全 |',
  '| `real-configs` | 84（7/9 配置时 66，本机 5/9 时 48） | 真实配置 |',
  '| `boundary` | 46 | 边界 |',
  '| `shared-process` | 8（无 DSH 时 skip） | 共享进程 |',
];
const EN_ROWS = [
  '| Suite | Checks | Covers |',
  '|---|---|---|',
  '| `smoke` | 33 | handshake |',
  '| `alpha` | 5 | a |',
  '| `beta` | 9 | b |',
  '| `gamma` | 4 | c |',
  '| `dispatch-tools` | 59 (56 off Windows) | dispatch |',
  '| `config-safety` | 407 (406 without client configs) | config |',
  '| `real-configs` | 84 (66 with 7/9, 48 with 5/9 fixtures) | real |',
  '| `boundary` | 46 | boundary |',
  '| `shared-process` | 8 (skips without DSH) | shared |',
];
const docText = (rows, intro) => [
  intro, '', ...rows, '',
  '<!-- counts:begin (generated by scripts/sync-test-counts.mjs; do not edit by hand) -->',
  'STALE TEXT',
  '<!-- counts:end -->',
  '',
  '尾部文字 / trailing prose', '',
].join('\n');
const YML = [
  'name: tests',
  '# OFFLINE (runs in CI)',
  '#     smoke             protocol + instructions length cap (session sections skip without DSH)  33 checks',
  '#     alpha             first suite         5 checks',
  '#     beta              second suite        9 checks',
  '#     gamma             third suite         4 checks',
  '#     dispatch-tools    dispatch surface    59 checks (56 off Windows)',
  '#     config-safety     in-place edits      407 checks',
  '#     real-configs      real config round-trip        skips without client fixtures',
  '#     package job       pack -> install -> --version',
  '# Some other comment mentioning 99 checks of nothing',
  'on: push',
  '',
].join('\n');

const seed = () => {
  write('test/run.mjs', RUN_SOURCE);
  write('docs/zh/tests.md', docText(ZH_ROWS, '# 测试'));
  write('docs/en/tests.md', docText(EN_ROWS, '# Tests'));
  write('.github/workflows/tests.yml', YML);
};

const mkSuite = (name, n, o = {}) => ({
  suite: name, kind: o.kind ?? 'offline', exitCode: o.exitCode ?? 0, passed: n, failed: o.failed ?? 0,
  skipped: o.skipped ?? false, durationMs: 1, counted: 'summary', marks: { passed: n, failed: 0 }, ...(o.meta ? { meta: o.meta } : {}),
});
const mkReport = (o) => ({
  schema: 1, generatedAt: o.at ?? '2026-11-07T10:00:00.000Z', command: 'node test/run.mjs', mode: o.mode ?? 'offline',
  platform: o.platform ?? 'win32', arch: 'x64', node: o.node ?? 'v22.19.0', dsh: o.dsh ?? null,
  fixtures: o.fixtures ?? null, suites: o.suites, cleanup: { exitCode: 0, durationMs: 1 },
});
const saveReport = (name, report) => { write(`.state/${name}`, JSON.stringify(report, null, 2)); return join(root, '.state', name); };
const run = (args) => {
  const out = [];
  const err = [];
  const code = syncMain(args, { root, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const FX5 = { clientConfigs: { present: 5, total: 9, ids: ['claude-code', 'codex', 'cursor', 'zed', 'vscode'] } };
const DEV = mkReport({
  fixtures: FX5,
  suites: [
    mkSuite('smoke', 20, { meta: { dsh: '0' } }),
    mkSuite('alpha', 7), mkSuite('beta', 9), mkSuite('gamma', 4),
    mkSuite('dispatch-tools', 58),
    mkSuite('config-safety', 407, { meta: { 'real-clients': '5' } }),
    mkSuite('real-configs', 48, { meta: { fixtures: '5/9', ids: 'claude-code,codex,cursor,zed,vscode' } }),
  ],
});

try {
  // a) 离线报告 -> 写回
  seed();
  const devPath = saveReport('dev.json', DEV);
  let r = run(['--report', devPath]);
  const zh = () => read('docs/zh/tests.md');
  const en = () => read('docs/en/tests.md');
  check('写回成功 exit 0', r.code === 0, r.code + ' ' + r.err);
  check('普通套件：数字更新', zh().includes('| `alpha` | 7 | 甲 |') && en().includes('| `alpha` | 7 | a |'));
  check('smoke 没有 DSH：只补"无 DSH"那一格，主数字（有 DSH）不动',
    zh().includes('| `smoke` | 33（无 DSH 时 20） | 握手 |') && en().includes('| `smoke` | 33 (20 without DSH) | handshake |'), zh().split('\n')[2]);
  check('dispatch-tools 在 Windows 上量：更新主数字，非 Windows 那格保持',
    zh().includes('| `dispatch-tools` | 58（非 Windows 56） | 派发面 |') && en().includes('| `dispatch-tools` | 58 (56 off Windows) | dispatch |'));
  check('config-safety 有客户端配置：更新主数字，"无客户端配置"那格保持',
    zh().includes('| `config-safety` | 407（无客户端配置时 406） | 配置安全 |'));
  check('real-configs 5/9：只更新 5/9 那一格并统一写法',
    zh().includes('| `real-configs` | 84（7/9 配置时 66，5/9 配置时 48） | 真实配置 |') &&
    en().includes('| `real-configs` | 84 (66 with 7/9 fixtures, 48 with 5/9 fixtures) | real |'));
  check('模型套件的数字原样保留（报告里没有模型套件）',
    zh().includes('| `boundary` | 46 | 边界 |') && zh().includes('| `shared-process` | 8（无 DSH 时 skip） | 共享进程 |'));
  check('说明了模型套件没动', /no model-backed suites/.test(r.out), r.out);
  check('总数段落：本机实测（套件数、检查数、环境）',
    zh().includes('在本机（Windows，没有 DSH，5/9 个客户端配置 fixture）跑了 7 个离线套件、553 项检查') &&
    en().includes('ran 553 checks in 7 offline suites on this machine (Windows, no DSH, 5/9 client config fixtures)'), zh().split('\n').slice(-8).join(' | '));
  check('总数段落：模型套件名义合计取自表（46+8）与 smoke 的会话段（13）',
    zh().includes('名义合计 **54 项**') && zh().includes('多跑 13 项') && en().includes('total **54 checks** nominally'));
  check('总数段落：CI 名义总数按 runner 环境算（无 DSH、无配置；Linux 与 Windows 只差 dispatch-tools）',
    zh().includes('名义 Linux/macOS 502，Windows 504') && en().includes('nominal 502 on Linux/macOS, 504 on Windows'), zh().split('\n').slice(-6).join(' | '));
  check('总数段落之外的文字不动', zh().includes('尾部文字 / trailing prose') && !zh().includes('STALE TEXT') && zh().startsWith('# 测试\n'));
  check('tests.yml：普通套件更新；变体取 CI 那一格；无数字的行不动；无关注释不动',
    read('.github/workflows/tests.yml').includes('alpha             first suite         7 checks') &&
    read('.github/workflows/tests.yml').includes('(session sections skip without DSH)  20 checks') &&
    read('.github/workflows/tests.yml').includes('dispatch surface    58 checks (56 off Windows)') &&
    read('.github/workflows/tests.yml').includes('in-place edits      406 checks') &&
    read('.github/workflows/tests.yml').includes('skips without client fixtures\n') &&
    read('.github/workflows/tests.yml').includes('mentioning 99 checks of nothing'), read('.github/workflows/tests.yml'));

  // b) 同一份报告再检查：一致
  r = run(['--check', '--report', devPath]);
  check('--check：刚写回就一致，exit 0', r.code === 0 && /agree/.test(r.out), r.code + ' ' + r.err);
  r = run(['--report', devPath]);
  check('再写回一次是空操作', r.code === 0 && /already match/.test(r.out), r.out);
  r = run(['--check', '--report', saveReport('later.json', { ...DEV, generatedAt: '2027-01-01T00:00:00.000Z', node: 'v24.9.0' })]);
  check('只有日期与 Node 版本不同的新报告：--check 仍一致（段落里不写它们，免得每次重跑都报漂移）', r.code === 0, preview(r.err));

  // c) 文档被手改 -> --check 报出差异
  const zhBefore = zh();
  write('docs/zh/tests.md', zhBefore.replace('| `alpha` | 7 | 甲 |', '| `alpha` | 99 | 甲 |'));
  r = run(['--check', '--report', devPath]);
  check('--check：文档与报告不一致 exit 1，并指出文件、行、旧值与新值',
    r.code === 1 && r.err.includes('docs/zh/tests.md') && r.err.includes('- | `alpha` | 99 | 甲 |') && r.err.includes('+ | `alpha` | 7 | 甲 |'), preview(r.err));
  check('--check 不写文件', zh().includes('| `alpha` | 99 | 甲 |'));
  r = run(['--report', devPath]);
  check('写回把手改的数字纠正回来，其余字节不变', r.code === 0 && zh() === zhBefore);

  // d) --all 报告：模型套件被更新，总数跟着变
  const allPath = saveReport('all.json', mkReport({ mode: 'all', fixtures: FX5, suites: [...DEV.suites, mkSuite('boundary', 47, { kind: 'model' })] }));
  r = run(['--report', allPath]);
  check('--all 报告：模型套件数字更新，总数段落跟着变',
    r.code === 0 && zh().includes('| `boundary` | 47 | 边界 |') && zh().includes('名义合计 **55 项**') && !/no model-backed suites/.test(r.out), r.out);

  // e) 套件 skipped：不动；失败的报告：拒绝使用
  const skipPath = saveReport('skip.json', mkReport({ suites: [mkSuite('real-configs', 0, { skipped: true, meta: { fixtures: '0/9', ids: '-' } }), mkSuite('alpha', 7)] }));
  const beforeSkip = zh();
  r = run(['--report', skipPath]);
  check('skipped 的套件不改数字', r.code === 0 && zh().includes('| `real-configs` | 84（7/9 配置时 66，5/9 配置时 48） | 真实配置 |') && /real-configs: skipped/.test(r.out), r.out);
  check('"本机实测"那行跟着这份报告走：2 个套件、7 项、没有客户端配置 fixture',
    zh().includes('在本机（Windows，没有 DSH，没有客户端配置 fixture）跑了 2 个离线套件、7 项检查') && beforeSkip !== zh(), zh().split('\n').slice(-8).join(' | '));

  const badPath = saveReport('bad.json', mkReport({ suites: [mkSuite('alpha', 8, { exitCode: 1, failed: 1 })] }));
  const beforeBad = [zh(), en(), read('.github/workflows/tests.yml')];
  r = run(['--report', badPath]);
  check('报告里有失败套件：exit 2 并拒绝写入', r.code === 2 && /did not pass/.test(r.err) && zh() === beforeBad[0] && en() === beforeBad[1] && read('.github/workflows/tests.yml') === beforeBad[2], r.err);

  // f) 套件在表里没有一行 -> exit 1 并点名
  seed();
  write('docs/zh/tests.md', docText(ZH_ROWS.filter((l) => !l.startsWith('| `gamma`')), '# 测试'));
  r = run(['--report', devPath]);
  check('套件没有表格行：exit 1，点名套件与文件', r.code === 1 && r.err.includes('no table row for suite `gamma`') && r.err.includes('docs/zh/tests.md'), r.err);
  check('没有表格行的套件不影响其它行的更新', read('docs/zh/tests.md').includes('| `alpha` | 7 | 甲 |'));

  // g) 文档里有行但 run.mjs 清单里没有的套件
  seed();
  write('docs/en/tests.md', docText([...EN_ROWS, '| `ghost` | 3 | gone |'], '# Tests'));
  r = run(['--check', '--report', devPath]);
  check('表里有行、run.mjs 里没有这个套件：被点名', r.err.includes('table row `ghost` is not in the test/run.mjs'), r.err);

  // h) 多份报告：按顺序应用，最后一份决定"本机实测"
  seed();
  const ciPath = saveReport('ci.json', mkReport({
    platform: 'linux', node: 'v24.1.0', fixtures: { clientConfigs: { present: 0, total: 9, ids: [] } },
    suites: [
      mkSuite('smoke', 20, { meta: { dsh: '0' } }), mkSuite('alpha', 7), mkSuite('beta', 9), mkSuite('gamma', 4),
      mkSuite('dispatch-tools', 55),
      mkSuite('config-safety', 405, { meta: { 'real-clients': '0' } }),
      mkSuite('real-configs', 0, { skipped: true, meta: { fixtures: '0/9', ids: '-' } }),
    ],
  }));
  r = run(['--report', ciPath, '--report', devPath]);
  check('两份报告：同一套件落在各自的格子（config-safety 无配置 405 / 有配置 407）',
    r.code === 0 && zh().includes('| `config-safety` | 407（无客户端配置时 405） | 配置安全 |') &&
    zh().includes('| `dispatch-tools` | 58（非 Windows 55） | 派发面 |') && en().includes('| `dispatch-tools` | 58 (55 off Windows) | dispatch |'), zh().split('\n').slice(2, 11).join(' | '));
  check('"本机实测"取最后一份报告的环境（Windows、5/9，而不是 CI 报告的 Linux、0 个）',
    zh().includes('在本机（Windows，没有 DSH，5/9 个客户端配置 fixture）') && !zh().includes('在本机（Linux'));
  check('tests.yml 里 config-safety 取 CI 那一格（405）', read('.github/workflows/tests.yml').includes('in-place edits      405 checks'));

  // i) --portable：只动与环境无关的套件，以及 runner 那一格；不动总数段落
  seed();
  r = run(['--report', devPath]); // 先得到一份与 DEV 一致的文档
  const afterDev = [read('docs/zh/tests.md'), read('docs/en/tests.md'), read('.github/workflows/tests.yml')];
  const linuxPath = saveReport('linux.json', mkReport({
    platform: 'linux', fixtures: { clientConfigs: { present: 0, total: 9, ids: [] } },
    suites: [
      mkSuite('smoke', 20, { meta: { dsh: '0' } }), mkSuite('alpha', 8), mkSuite('beta', 9), mkSuite('gamma', 4),
      mkSuite('dispatch-tools', 50),
      mkSuite('config-safety', 406, { meta: { 'real-clients': '0' } }),
      mkSuite('real-configs', 0, { skipped: true, meta: { fixtures: '0/9', ids: '-' } }),
    ],
  }));
  r = run(['--portable', '--report', linuxPath]);
  check('--portable：普通套件更新（alpha 8），runner 那一格（config-safety 406）更新',
    r.code === 0 && read('docs/zh/tests.md').includes('| `alpha` | 8 | 甲 |') && read('docs/zh/tests.md').includes('407（无客户端配置时 406）'), r.err + preview(read('docs/zh/tests.md')));
  check('--portable：随平台变化的 dispatch-tools（报告里是 50）不碰', read('docs/zh/tests.md').includes('| `dispatch-tools` | 58（非 Windows 56） | 派发面 |') && read('.github/workflows/tests.yml').includes('58 checks (56 off Windows)'));
  const blockOf = (t) => t.split('<!-- counts:begin')[1].split('<!-- counts:end -->')[0];
  check('--portable：总数段落不重写', blockOf(read('docs/zh/tests.md')) === blockOf(afterDev[0]) && blockOf(read('docs/en/tests.md')) === blockOf(afterDev[1]));
  check('--portable：tests.yml 里普通套件更新', read('.github/workflows/tests.yml').includes('first suite         8 checks'));
  r = run(['--portable', '--check', '--report', linuxPath]);
  check('--portable --check：写回后一致', r.code === 0, r.err);
  write('docs/zh/tests.md', read('docs/zh/tests.md').replace('407（无客户端配置时 406）', '407（无客户端配置时 405）'));
  r = run(['--portable', '--check', '--report', linuxPath]);
  check('--portable --check：runner 那一格对不上就报（CI 靠它抓 config-safety 漂移）', r.code === 1 && r.err.includes('406') && r.err.includes('405'), preview(r.err));
  seed();
  r = run(['--portable', '--check', '--report', saveReport('dev-p.json', DEV)]);
  check('--portable 对开发机的格子（有客户端配置的 config-safety 407、Windows 的 dispatch-tools）不做判断',
    !r.err.includes('| `config-safety` |') && !r.err.includes('| `dispatch-tools` |') && !r.err.includes('| `real-configs` |'), r.err);

  // j) CRLF 保留
  seed();
  write('docs/zh/tests.md', docText(ZH_ROWS, '# 测试').replace(/\n/g, '\r\n'));
  r = run(['--report', devPath]);
  const crlf = zh();
  check('CRLF 文档写回后仍是 CRLF，没有混入裸 LF', r.code === 0 && crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), r.err);

  // k) 用法错误
  seed();
  r = run([]);
  check('没有报告：exit 2，告诉怎么产出', r.code === 2 && /no report/.test(r.err) && /node test\/run\.mjs/.test(r.err), r.err);
  r = run(['--bogus']);
  check('未知参数：exit 2', r.code === 2 && /unknown argument/.test(r.err));
  write('.state/junk.json', '{"hello":1}');
  r = run(['--report', join(root, '.state', 'junk.json')]);
  check('不是报告的文件：exit 2', r.code === 2 && /not a test report/.test(r.err), r.err);
  r = run(['--report', join(root, '.state', 'missing.json')]);
  check('报告文件不存在：exit 2', r.code === 2 && /cannot read report/.test(r.err), r.err);
  write('.state/test-report.json', JSON.stringify(DEV));
  r = run(['--check']);
  check('不带 --report 时默认读 .state/test-report.json（这里文档是旧的，所以报不一致）', r.code === 1 && /disagrees/.test(r.err), r.code + ' ' + preview(r.err));
} finally {
  removeSandbox(root);
}

console.log('\n===== test counts: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);
