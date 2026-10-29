/**
 * 沙箱 HOME 的唯一构造与销毁入口。
 *
 * 为什么单独抽出来：2026-10-29 那次事故里，一段临时脚本把沙箱路径存在
 * 名为 \`$home\` 的变量里。\`$home\` 是 PowerShell 的只读自动变量，赋值
 * 静默失败（脚本设了 Continue），于是 "沙箱" 一直指向真实用户目录，
 * 收尾的 \`Remove-Item $home -Recurse -Force\` 把 \`~/.codex\`、\`~/.cursor\`、
 * \`~/.claude\` 的一部分删掉了。文件断言全绿，真实数据没了。
 *
 * 规则：沙箱路径只能由这里产生，销毁只能经这里。任何一步发现自己指向
 * 真实 HOME，立刻抛错 —— 宁可测试失败，也不要删用户的目录。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';

/** 真实 HOME，取一次，之后不再从环境变量推断（它可能已被改坏）。 */
const REAL_HOME = (() => {
  try {
    return resolve(realpathSync(homedir()));
  } catch {
    return resolve(homedir());
  }
})();

const isInside = (child, parent) => {
  const a = resolve(child);
  const b = resolve(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** 这个路径能不能被当成一次性沙箱？不能就抛错。 */
export function assertSafeSandbox(dir) {
  const target = resolve(dir);
  if (!target || target === resolve(sep)) {
    throw new Error('refusing sandbox at filesystem root: ' + target);
  }
  if (target === REAL_HOME || isInside(REAL_HOME, target)) {
    throw new Error(
      'refusing to use the real home as a sandbox: ' + target +
      ' (real home is ' + REAL_HOME + ')',
    );
  }
  const base = resolve(tmpdir());
  if (!isInside(target, base)) {
    throw new Error(
      'refusing sandbox outside the temp directory: ' + target +
      ' (temp is ' + base + ')',
    );
  }
  return target;
}

/**
 * 建一个一次性 HOME，并把给定的客户端配置写进去。
 * 返回的目录保证：在 tmpdir 下、不等于真实 HOME、名字带随机后缀。
 */
export function makeSandboxHome(prefix, files = {}) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  assertSafeSandbox(home);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(home, rel);
    const dir = dirname(p);
    mkdirSync(dir, { recursive: true });
    assertSafeSandbox(home);
    writeFileSync(p, content, 'utf8');
  }
  return home;
}

/** 销毁沙箱：同样过一遍守卫，删不掉的（句柄未释放）也不抛。 */
export function removeSandbox(dir) {
  assertSafeSandbox(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** 只读地暴露真实 HOME，给断言用。 */
export const realHome = () => REAL_HOME;
