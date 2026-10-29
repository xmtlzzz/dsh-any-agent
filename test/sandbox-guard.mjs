/**
 * 沙箱守卫：真实 HOME 必须被拒绝。
 *
 * 这是 2026-10-29 那次事故的回归测试。事故的根因不是 setup 的写入逻辑，
 * 而是一个把沙箱路径存进 \`$home\`（PowerShell 只读自动变量）的临时脚本：
 * 赋值静默失败，收尾的 \`Remove-Item $home -Recurse -Force\` 落在了真实
 * 用户目录上，删掉了 ~/.codex 的一部分。
 *
 * 所以结论不能只写成注释，得让它在任何一次改动后立刻失败。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandboxHome, removeSandbox, assertSafeSandbox, realHome } from './sandbox-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); failed++; }
};

const throws = (fn) => {
  try { fn(); return null; } catch (e) { return e.message || String(e); }
};

console.log('\n[1] the real home is never a sandbox');
{
  const real = realHome();
  check('realHome() looks like a home', /^([A-Za-z]:[\\/]|\/)/.test(real), real);

  const direct = throws(() => assertSafeSandbox(real));
  check('assertSafeSandbox(realHome) throws', Boolean(direct), String(direct));
  check('the error names the real home', Boolean(direct) && direct.includes(real), String(direct));

  // ~/.codex 这类子目录同样危险：删掉它等于删掉配置。
  const sub = throws(() => assertSafeSandbox(join(real, '.codex')));
  check('assertSafeSandbox(realHome/.codex) throws', Boolean(sub), String(sub));

  const lower = throws(() => assertSafeSandbox(real.toLowerCase()));
  check('case variants are refused too', Boolean(lower), String(lower));
}

console.log('\n[2] the filesystem root is never a sandbox');
{
  const root = throws(() => assertSafeSandbox('C:\\'));
  check('C:\\ is refused', Boolean(root), String(root));
}

console.log('\n[3] a directory outside the temp dir is refused');
{
  const outside = throws(() => assertSafeSandbox('C:\\Windows'));
  check('C:\\Windows is refused', Boolean(outside), String(outside));
}

console.log('\n[4] a real temp sandbox is accepted and cleaned up');
{
  const home = makeSandboxHome('dsh-guard-', { '.cursor/mcp.json': '{"mcpServers":{}}' });
  check('sandbox is not the real home', home !== realHome(), home);
  check('sandbox lives in a temp dir', assertSafeSandbox(home) === home, home);
  check('the seeded file is there', existsSync(join(home, '.cursor', 'mcp.json')));

  removeSandbox(home);
  check('removeSandbox deleted it', !existsSync(home), home);

  // 二次删除不能抛（句柄未释放、已被删掉都要能容忍）。
  const again = throws(() => removeSandbox(home));
  check('removing twice is harmless', again === null, String(again));
}

console.log('\n[5] the other suites go through this guard');
{
  // 这些套件以前各自手写 sandbox()，也就是事故里那种写法。
  // 现在必须都从 sandbox-home.mjs 取目录、并用 removeSandbox 销毁。
  for (const f of ['setup.mjs', 'removal-scope.mjs']) {
    const p = join(HERE, f);
    const src = existsSync(p) ? readFileSync(p, 'utf8') : '';
    check(f + ' imports the guard', src.includes('./sandbox-home.mjs'), p);
    check(f + ' has no hand-rolled mkdtemp', !src.includes('mkdtempSync'), p);
    check(f + ' has no raw rmSync of a home', !/rmSync\(\s*home/.test(src), p);
  }
}

console.log('\n===== sandbox guard: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);
