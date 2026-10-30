/**
 * 测试入口：先跑冒烟（不花 token），再跑集成（会调用真实 LLM）。
 * 用法：npm test          只跑冒烟
 *       npm test -- --all 冒烟 + 集成
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = process.argv.includes('--all');

function run(script) {
  return new Promise((resolve) => {
    console.log(`\n${'█'.repeat(70)}\n█ ${script}\n${'█'.repeat(70)}`);
    const child = spawn(process.execPath, [join(HERE, script)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let code = await run('smoke.mjs');
if (code === 0) {
  // 哨兵留存是纯文件系统 + 启动路径，不花 token —— 归到"冒烟一档"，每次必跑
  code = await run('prune.mjs');
}
if (code === 0) {
  // 环境变量守卫：纯模块加载，不花 token，也归到"必跑"
  code = await run('guards.mjs');
}
if (code === 0) {
  // 审批上下文与裁决：纯本地会话对象，不调用模型或拉起DSH。
  code = await run('approval-details.mjs');
}
if (code === 0) {
  // 沙箱守卫先跑：任何把真实 HOME 当沙箱的写法必须立刻失败。
  // 2026-10-29 的事故就是少了这一条，一段临时脚本把 ~ 当沙箱递归删了。
  code = await run('sandbox-guard.mjs');
}
if (code === 0) {
  // setup 命令改的是别人的客户端配置，必须每次必跑：一个会误写或误删的
  // setup 比没有 setup 更糟。沙箱经 sandbox-home.mjs 构造并校验。
  code = await run('setup.mjs');
}
if (code === 0) {
  // 卸载的影响范围：只删自己那条，用户既有的 MCP 服务器与无关设置必须原样。
  code = await run('removal-scope.mjs');
}
if (code === 0) {
  // 配置安全矩阵：9 个客户端 × 格式保留 × 只读文件 × 真实 HOME 只读回归。
  // 这是「注册/删除时不会破坏原有配置」这条承诺的可执行版本，必须每次必跑。
  code = await run('config-safety.mjs');
}
if (code === 0) {
  // 工作区与标题的两个真实行为：cwd 选家目录要提前拦住、title_hint 不能被
  // DSH 自动标题吞掉。纯模块加载，不拉 DSH，归到必跑一档。
  code = await run('workspace-titles.mjs');
}
if (code === 0) {
  // 真实配置往返：本机已装的客户端配置复制进沙箱，注册再撤销必须逐字节还原。
  // 手工 fixture 证明实现符合假设，这一组证明假设和真实文件一致。
  code = await run('real-configs.mjs');
}
if (code === 0 && all) {
  code = await run('boundary.mjs');
}
if (code === 0 && all) {
  code = await run('integration.mjs');
}
if (code === 0 && all) {
  code = await run('async.mjs');
}
if (code === 0 && all) {
  code = await run('sentinel.mjs');
}
if (code === 0 && all) {
  code = await run('timeout.mjs');
}
if (code === 0 && all) {
  code = await run('lock.mjs');
}
if (code === 0 && all) {
  code = await run('multi.mjs');
}
if (code === 0 && all) {
  code = await run('list.mjs');
}
if (code === 0 && all) {
  code = await run('permission.mjs');
}
if (code === 0 && all) {
  code = await run('cycle.mjs');
}
if (code === 0 && all) {
  code = await run('concurrency.mjs');
}
if (code === 0 && all) {
  code = await run('capability.mjs');
}
if (code === 0 && all) {
  code = await run('workspace-effect.mjs');
}
if (code === 0 && all) {
  code = await run('reasoning-check.mjs');
}
// 收尾清理：只清临时目录里的测试残留（真实项目会话与仓库 .state/ 不动）。
// 无论前面成败都跑，否则失败的运行会把垃圾留在磁盘上。
await run('cleanup.mjs');

console.log(`\n总结果: ${code === 0 ? '通过 ✅' : '失败 ❌'}`);
process.exit(code);