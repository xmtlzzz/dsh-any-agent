#!/usr/bin/env node
/**
 * CI 用：问项目自己"这台机器上找得到 DSH 吗"。
 *
 * 为什么不在 workflow 里写 `command -v dsh`：服务自己并不靠 PATH 上的 `dsh` 找 DSH，
 * 而是用 src/dsh-locate.mjs 的 resolveDsh()（桌面版注册表 / 默认安装路径、npm 全局、
 * npx 缓存，`DSH_BIN` 可显式覆盖）。只装了桌面版、PATH 里没有 `dsh` 的自托管 runner
 * 用旧写法会被误判成"没有 DSH"，模型套件整个跳过。这里直接复用同一套逻辑，
 * CI 判定与服务实际行为就不会再分叉。
 *
 * 写成脚本而不是内联 `node -e`：workflow 的 shell 在 Linux（bash）与 Windows（pwsh）上
 * 对引号的处理不同，`node scripts/detect-dsh.mjs` 在两边写法一致。
 *
 * 输出：
 *   - 标准输出一行人类可读的结果；
 *   - 在 GitHub Actions 里（有 GITHUB_OUTPUT）再写 ok=1|0、source、version，
 *     后续步骤用 steps.<id>.outputs.ok 判断；
 *   - 找不到时退出码仍是 0（这是"跳过"，不是失败），由 workflow 决定后续步骤。
 *
 * 只读：不拉起 DSH，只读安装目录 / asar 里的版本信息（以及 Windows 上的 `reg export`）。
 */

import { appendFileSync } from 'node:fs';
import { SOURCE_LABEL, resolveDsh } from '../src/dsh-locate.mjs';

let ok = false;
let source = '';
let version = '';
let detail = '';

try {
  const dsh = resolveDsh({ fresh: true });
  ok = true;
  source = dsh.source;
  version = dsh.version ?? '';
  detail = `${SOURCE_LABEL[dsh.source] ?? dsh.source} / DSH ${dsh.version ?? '未知版本'} / ${dsh.bin}`;
  console.log(`DSH found: ${detail}`);
} catch (e) {
  // resolveDsh 的报错是多行的；GitHub 注解里换行需要转义，这里只取第一行
  detail = String(e.message).split('\n')[0];
  console.log(`DSH not found: ${detail}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `ok=${ok ? '1' : '0'}\nsource=${source}\nversion=${version}\n`);
}
if (process.env.GITHUB_ACTIONS === 'true') {
  if (ok) console.log(`::notice title=DSH detected::${detail}`);
  else {
    console.log(
      `::warning title=Model suites skipped::${detail} -- use a self-hosted runner with DeepSeek Harness ` +
        '(desktop app, npm global or npx cache; or set the DSH_BIN secret), a provider and credentials.',
    );
  }
}
