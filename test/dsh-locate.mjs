/**
 * DSH 自动发现（src/dsh-locate.mjs）的离线回归：不拉 DSH、不花 token、不读注册表。
 *
 * 背景：旧实现只会在 npx 缓存 / npm 全局里找 `bin.js`，认不出桌面版（CLI 在 app.asar 里，
 * 普通 Node 读不了）。结果是用户 GUI 已经是 0.2.2-rc.1，本服务却悄悄用着 npx 缓存里的
 * 0.2.1-rc.5，全量测试也就验证错了版本。这里用一个合成的 asar 把整条链路钉住。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRuntimeOverride,
  cmpVersion,
  desktopCandidate,
  desktopExeForAsar,
  existsMaybeAsar,
  parseRegExport,
  rankCandidates,
  readDshPackage,
  readMaybeAsar,
  resolveDsh,
  satisfiesNodeRange,
  splitAsarPath,
} from '../src/dsh-locate.mjs';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

/** 按 @electron/asar 的格式写一个最小 asar：[u32 4][u32 size] + pickle([u32 payload][u32 len][json 对齐 4]) + 数据。 */
function writeAsar(file, tree) {
  const blobs = [];
  let offset = 0;
  const build = (node) => {
    if (typeof node === 'string') {
      const buf = Buffer.from(node, 'utf8');
      const entry = { size: buf.length, offset: String(offset) };
      offset += buf.length;
      blobs.push(buf);
      return entry;
    }
    const files = {};
    for (const [k, v] of Object.entries(node)) files[k] = build(v);
    return { files };
  };
  const json = Buffer.from(JSON.stringify(build(tree)), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  writeFileSync(file, Buffer.concat([size, pickle, ...blobs]));
}

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-locate-'));
const savedBin = process.env.DSH_BIN;
const savedRuntime = process.env.DSH_RUNTIME;

try {
  // 一个“桌面版安装目录”：<root>/app/resources/app.asar + 可执行文件
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, 'resources'), { recursive: true });
  const asar = join(appDir, 'resources', 'app.asar');
  writeAsar(asar, {
    dsh: {
      node_modules: {
        '@deepseek-ai': {
          dsh: {
            'package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', engines: { node: '>=24.9.0' } }),
            lib: { 'bin.js': '#!/usr/bin/env node\nconsole.log("dsh")\n' },
          },
        },
      },
    },
  });
  // 各平台的可执行文件名都放一份，推导逻辑在哪个平台跑都能命中
  for (const n of ['DeepSeek Harness.exe', 'DeepSeek Harness']) writeFileSync(join(appDir, n), '');
  const asarBin = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  console.log('\n[1] 版本比较与 engines 判定');
  check('rc < 正式版、数字段按数值比较', () => {
    assert.ok(cmpVersion('0.2.2-rc.1', '0.2.2') < 0);
    assert.ok(cmpVersion('0.2.2-rc.10', '0.2.2-rc.9') > 0);
    assert.ok(cmpVersion('0.2.2-rc.1', '0.2.1-rc.5') > 0);
  });
  check('★ Node 22 不满足 >=24.9.0；Node 24.21 满足', () => {
    assert.equal(satisfiesNodeRange('>=24.9.0', '22.19.0'), false);
    assert.equal(satisfiesNodeRange('>=24.9.0', 'v24.21.0'), true);
  });
  check('|| 与区间组合', () => {
    assert.equal(satisfiesNodeRange('^20.10.0 || >=22.15', '22.19.0'), true);
    assert.equal(satisfiesNodeRange('>=18 <20', '22.0.0'), false);
    assert.equal(satisfiesNodeRange('^20.10.0', '21.0.0'), false);
  });
  check('看不懂的写法 → null（未知，不当作不满足）', () => {
    assert.equal(satisfiesNodeRange('lts/*', '22.0.0'), null);
    assert.equal(satisfiesNodeRange(null, '22.0.0'), null);
  });

  console.log('\n[2] asar 只读访问（纯 Node）');
  check('splitAsarPath 拆出 asar 文件与内部路径', () => {
    const s = splitAsarPath(asarBin);
    assert.equal(s.asar, asar);
    assert.deepEqual(s.inner, ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']);
    assert.equal(splitAsarPath(join(root, 'x', 'bin.js')), null);
  });
  check('★ asar 内文件“存在”、不存在的路径为 false', () => {
    assert.ok(existsMaybeAsar(asarBin));
    assert.ok(!existsMaybeAsar(join(asar, 'dsh', 'nope.js')));
  });
  check('★ 能读出 asar 内 package.json 的 version 与 engines', () => {
    assert.deepEqual(readDshPackage(asarBin), { version: '0.2.2-rc.1', enginesNode: '>=24.9.0' });
  });
  check('读 asar 内文件正文', () => assert.match(readMaybeAsar(asarBin), /console\.log\("dsh"\)/));
  check('坏 asar 不崩、返回 null', () => {
    const bad = join(root, 'bad.asar');
    writeFileSync(bad, 'not an asar');
    assert.equal(readMaybeAsar(join(bad, 'a.js')), null);
    assert.ok(!existsMaybeAsar(join(bad, 'a.js')));
  });

  console.log('\n[3] 桌面版目录识别');
  check('★ 桌面版目录 → electron 运行时 + ELECTRON_RUN_AS_NODE', () => {
    const c = desktopCandidate({ dir: appDir, via: 'test' });
    assert.ok(c, 'should detect');
    assert.equal(c.source, 'desktop');
    assert.equal(c.version, '0.2.2-rc.1');
    assert.equal(c.runtime, 'electron');
    assert.equal(c.env.ELECTRON_RUN_AS_NODE, '1');
    assert.deepEqual(c.args, [asarBin]);
    assert.equal(c.command, desktopExeForAsar(asar));
  });
  check('不是桌面版的目录 → null', () => assert.equal(desktopCandidate({ dir: join(root, 'empty'), via: 'test' }), null));

  console.log('\n[4] 候选排序');
  const mk = (source, version, runtimeOk) => ({ source, version, runtimeOk });
  check('★ 同版本：桌面版 > npm 全局 > npx', () => {
    const r = rankCandidates([mk('npx', '0.2.2-rc.1', null), mk('global', '0.2.2-rc.1', null), mk('desktop', '0.2.2-rc.1', null)]);
    assert.deepEqual(r.map((c) => c.source), ['desktop', 'global', 'npx']);
  });
  check('★ 版本高者优先（旧桌面版不压过新的全局安装）', () => {
    const r = rankCandidates([mk('desktop', '0.2.1', null), mk('global', '0.2.2', true)]);
    assert.equal(r[0].source, 'global');
  });
  check('★ 已知跑不起来的（engines 不满足）垫底，即使版本更高', () => {
    const r = rankCandidates([mk('npx', '0.2.3', false), mk('desktop', '0.2.2-rc.1', null)]);
    assert.equal(r[0].source, 'desktop');
  });

  console.log('\n[5] 显式 DSH_BIN / DSH_RUNTIME');
  check('★ DSH_BIN 指进 asar → 自动配上桌面版运行时', () => {
    process.env.DSH_BIN = asarBin;
    delete process.env.DSH_RUNTIME;
    const d = resolveDsh();
    assert.equal(d.source, 'env');
    assert.equal(d.runtime, 'electron');
    assert.equal(d.command, desktopExeForAsar(asar));
    assert.equal(d.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(d.version, '0.2.2-rc.1');
  });
  check('DSH_RUNTIME 覆盖运行时', () => {
    const rt = join(root, 'node24');
    writeFileSync(rt, '');
    process.env.DSH_RUNTIME = rt;
    const d = resolveDsh();
    assert.equal(d.command, rt);
    assert.equal(d.runtime, 'custom');
  });
  check('普通路径的 DSH_BIN → 用本进程 node，并按 engines 判定', () => {
    const pkgDir = join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.2.1-rc.5', engines: { node: '>=1' } }));
    writeFileSync(join(pkgDir, 'lib', 'bin.js'), '');
    process.env.DSH_BIN = join(pkgDir, 'lib', 'bin.js');
    delete process.env.DSH_RUNTIME;
    const d = resolveDsh();
    assert.equal(d.command, process.execPath);
    assert.equal(d.runtime, 'node');
    assert.equal(d.runtimeOk, true);
    assert.deepEqual(d.env, {});
  });
  check('DSH_BIN 指向不存在的文件 → 清晰报错', () => {
    process.env.DSH_BIN = join(root, 'missing', 'bin.js');
    assert.throws(() => resolveDsh(), /DSH_BIN 指向的文件不存在/);
  });

  console.log('\n[5b] ★ 只设 DSH_RUNTIME（不设 DSH_BIN）也作用于自动发现的候选（PR #11 评审）');
  const nodeCand = (enginesNode) => ({
    source: 'global',
    bin: '/x/node_modules/@deepseek-ai/dsh/lib/bin.js',
    version: '0.2.2-rc.1',
    enginesNode,
    command: process.execPath,
    args: ['/x/node_modules/@deepseek-ai/dsh/lib/bin.js'],
    env: {},
    runtime: 'node',
    runtimeOk: false,
  });
  const deskCand = { source: 'desktop', runtime: 'electron', command: 'C:/app/DeepSeek Harness.exe', env: { ELECTRON_RUN_AS_NODE: '1' }, runtimeOk: null, version: '0.2.2-rc.1' };
  check('★ npm/npx 候选换成 DSH_RUNTIME，并按它实测的 Node 版本重新判定 engines', () => {
    // 用本进程的 node 当“自定义运行时”：版本已知，判定结果可预期
    const [ok, desk] = applyRuntimeOverride([nodeCand('>=1'), deskCand], process.execPath);
    assert.equal(ok.command, process.execPath);
    assert.equal(ok.runtime, 'custom');
    assert.equal(ok.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(ok.runtimeOk, true, '>=1 必然满足');
    assert.deepEqual(desk, deskCand, '桌面版候选保持自带运行时不变');
    const [tooNew] = applyRuntimeOverride([nodeCand('>=999')], process.execPath);
    assert.equal(tooNew.runtimeOk, false, '>=999 必然不满足');
  });
  check('★ 只设 DSH_RUNTIME 且文件不存在 → 自动发现时清晰报错（不再被静默忽略）', () => {
    delete process.env.DSH_BIN;
    process.env.DSH_RUNTIME = join(root, 'missing-runtime.exe');
    assert.throws(() => resolveDsh({ fresh: true }), /DSH_RUNTIME 指向的文件不存在/);
    delete process.env.DSH_RUNTIME;
  });

  console.log('\n[6] 注册表导出解析');
  check('★ 解析 .reg：转义的反斜杠/引号还原、按 section 分组', () => {
    const reg =
      '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n' +
      '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc]\r\n' +
      '"DisplayName"="DeepSeek Harness"\r\n' +
      '"DisplayVersion"="0.2.2-rc.1"\r\n' +
      '"InstallLocation"="D:\\\\Tools\\\\dsh"\r\n' +
      '"DisplayIcon"="D:\\\\Tools\\\\dsh\\\\DeepSeek Harness.exe,0"\r\n' +
      '"EstimatedSize"=dword:00000400\r\n' +
      '"Quoted"="say \\"hi\\""\r\n';
    const [sec] = parseRegExport(reg);
    assert.equal(sec.values.DisplayName, 'DeepSeek Harness');
    assert.equal(sec.values.InstallLocation, 'D:\\Tools\\dsh');
    assert.equal(sec.values.DisplayIcon, 'D:\\Tools\\dsh\\DeepSeek Harness.exe,0');
    assert.equal(sec.values.Quoted, 'say "hi"');
    assert.equal(sec.values.EstimatedSize, undefined);
  });
} finally {
  if (savedBin === undefined) delete process.env.DSH_BIN;
  else process.env.DSH_BIN = savedBin;
  if (savedRuntime === undefined) delete process.env.DSH_RUNTIME;
  else process.env.DSH_RUNTIME = savedRuntime;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n===== DSH 自动发现：通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
