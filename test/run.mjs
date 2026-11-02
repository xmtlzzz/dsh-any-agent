/**
 * 测试入口：默认跑全部离线套件（不花 token；smoke 在无 DSH 时跳过会话段）。
 * 用法：npm test              离线套件
 *       npm run test:all      离线 + 需要真实 DSH/模型的套件
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
  // dsh_read 游标语义：纯内存，不花 token；守住“合并追加后增量必须能看到全文”。
  code = await run('read-cursor.mjs');
}
if (code === 0) {
  // 哨兵落盘脱敏：纯内存，不花 token；守住“思考永不进哨兵、工具输入先脱敏”。
  code = await run('sentinel-redaction.mjs');
}
if (code === 0) {
  // forget 墓碑：纯内存，不花 token；守住“forget 之后按 id 查询明确失败”。
  code = await run('forget-tombstone.mjs');
}
if (code === 0) {
  // 首启 profile bootstrap：零依赖发布形态下必须能复制路由、剥离密钥、幂等；
  // 用户手写文件绝不覆盖。纯文件系统，不花 token。
  code = await run('bootstrap-profile.mjs');
}
if (code === 0) {
  // 工作区注册表与测试清理的安全边界：坏文件不覆盖、临时目录前缀不误伤、
  // 自动清理只删本仓库测试造的会话。纯文件系统，不花 token。
  code = await run('workspace-safety.mjs');
}
if (code === 0) {
  // 接管外部会话 / 运行期权限核对：未知档 fail-closed 到 read-only，
  // 记录 read-only 不能被侧车提升。纯内存 + 文件系统，不花 token。
  code = await run('permission-adopt.mjs');
}
if (code === 0) {
  // 状态/哨兵/锁目录：默认在用户可写位置、不可写时明确失败、
  // 哨兵写失败可见、非法数值落安全侧。纯文件系统，不花 token。
  code = await run('state-safety.mjs');
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
  // 提交脚本：信息必须走 stdin，不许落盘。曾经的病根是「先写文件再 -F 那个
  // 文件」，于是 git add -A 会把临时文件卷进发布提交。
  code = await run('commit-script.mjs');
}
if (code === 0) {
  // MCP roots：不传 cwd 时用客户端当前打开的项目目录。走真实 stdio 握手，
  // 不需要 DSH，可以进 CI。
  code = await run('roots.mjs');
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
if (code === 0) {
  // 打包可发布性：files 白名单、零依赖、Node 下限、bin shebang。
  // 纯静态检查 + npm pack --dry-run，不花 token。
  code = await run('package-check.mjs');
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
  // 没有 IDA MCP（mcp__ida__*）时套件自己明确 skip（打印 skipped，退出 0），
  // 所以把它接进 --all 是安全的；README 不再声称一个实际没跑的命令。
  code = await run('acceptance.mjs');
}
if (code === 0 && all) {
  code = await run('reasoning-check.mjs');
}
// 收尾清理：只清本仓库测试造出来的目录（真实项目会话与状态目录不动）。
// 无论前面成败都跑，否则失败的运行会把垃圾留在磁盘上。
// ★ cleanup 的退出码必须计入总结果：以前忽略它，清理悄悄失败也会显示全绿。
const cleanupCode = await run('cleanup.mjs');
if (code === 0 && cleanupCode !== 0) code = cleanupCode;

console.log(`\n总结果: ${code === 0 ? '通过 ✅' : '失败 ❌'}`);
process.exit(code);