/**
 * 测试入口：默认跑全部离线套件（不花 token；smoke 在无 DSH 时跳过会话段）。
 * 用法：npm test              离线套件
 *       npm run test:all      离线 + 需要真实 DSH/模型的套件
 *       加 --bail             第一个失败就停（旧行为；默认跑完全部再汇总）
 *
 * ★ 默认不再“遇错即停”：以前 timeout.mjs 一条过时断言失败，后面 11 个真机套件
 *   （lock / multi / permission / concurrency …）全都没跑，结果看起来只坏了一处，
 *   实际上大半覆盖面根本没验证。现在每个套件都跑，最后列出全部失败项。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = process.argv.includes('--all');
const bail = process.argv.includes('--bail');

/** 离线套件：不拉 DSH（smoke 除外，它在无 DSH 时自动跳过会话段）、不花 token，每次必跑。 */
const OFFLINE = [
  'smoke.mjs',
  // 哨兵留存是纯文件系统 + 启动路径，不花 token —— 归到"冒烟一档"，每次必跑
  'prune.mjs',
  // 环境变量守卫：纯模块加载，不花 token，也归到"必跑"
  'guards.mjs',
  // DSH 自动发现：桌面版 asar + 自带运行时、候选排序、DSH_BIN/DSH_RUNTIME 覆盖、注册表解析。
  'dsh-locate.mjs',
  // 审批上下文与裁决：纯本地会话对象，不调用模型或拉起DSH。
  'approval-details.mjs',
  // 失败路径的终态：唤醒插话等待者、error 哨兵、审批 effective、dsh_get 回读哨兵。
  'failure-terminal.mjs',
  // 共享 ACP 进程宿主：通知/审批路由、进程退出扇出、refcount 停进程。
  'shared-host.mjs',
  // 派发面：dsh_inbox、client_run_id 幂等、会话队列、dsh_get 正文预算。
  'dispatch-tools.mjs',
  // dsh_read 游标语义：纯内存，不花 token；守住“合并追加后增量必须能看到全文”、
  // “不同工具调用各占一条”。
  'read-cursor.mjs',
  // 行式 UTF-8 解码：守住“chunk 边界不能把中文/emoji 截成 U+FFFD”。
  'line-decoder.mjs',
  // 哨兵落盘脱敏：纯内存，不花 token；守住“思考永不进哨兵、工具输入先脱敏”。
  'sentinel-redaction.mjs',
  // 调用方审核：结果/哨兵带审核单，dsh_review 落盘并回写；重启后仍可审核。
  // 纯内存 + 文件系统，不花 token。
  'review.mjs',
  // forget 墓碑：纯内存，不花 token；守住“forget 之后按 id 查询明确失败”。
  'forget-tombstone.mjs',
  // 首启 profile bootstrap：零依赖发布形态下必须能复制路由、剥离密钥、幂等；
  // 用户手写文件绝不覆盖。纯文件系统，不花 token。
  'bootstrap-profile.mjs',
  // 工作区注册表与测试清理的安全边界：坏文件不覆盖、临时目录前缀不误伤、
  // 自动清理只删本仓库测试造的会话。纯文件系统，不花 token。
  'workspace-safety.mjs',
  // 测试残留清理：DSH 侧（会话日志/投影缓存/工作区登记/墓碑）与本项目侧（注册表/元数据/
  // 哨兵/审核/锁登记）每一种产物都被清掉、非测试会话逐字节不变、cwd 护栏、子会话级联、
  // 干跑零写入、各真机套件都接上了收尾清理。沙箱 DSH_HOME，纯文件系统，不花 token。
  'residue-purge.mjs',
  // 接管外部会话 / 运行期权限核对：未知档 fail-closed 到 read-only，
  // 记录 read-only 不能被侧车提升。纯内存 + 文件系统，不花 token。
  'permission-adopt.mjs',
  // 状态/哨兵/锁目录：默认在用户可写位置、不可写时明确失败、
  // 哨兵写失败可见、非法数值落安全侧。纯文件系统，不花 token。
  'state-safety.mjs',
  // 工作区快照：workspace_changed 必须看全量文件内容（同一状态行、第 41 条之后、
  // 未跟踪目录内部），且 gitStatus 异步执行不阻塞共享 MCP 事件循环。
  // 纯文件系统 + 临时 git 仓库，不花 token。
  'workspace-snapshot.mjs',
  // 沙箱守卫先跑：任何把真实 HOME 当沙箱的写法必须立刻失败。
  // 2026-10-29 的事故就是少了这一条，一段临时脚本把 ~ 当沙箱递归删了。
  'sandbox-guard.mjs',
  // setup 命令改的是别人的客户端配置，必须每次必跑：一个会误写或误删的
  // setup 比没有 setup 更糟。沙箱经 sandbox-home.mjs 构造并校验。
  'setup.mjs',
  // 卸载的影响范围：只删自己那条，用户既有的 MCP 服务器与无关设置必须原样。
  'removal-scope.mjs',
  // 配置安全矩阵：9 个客户端 × 格式保留 × 只读文件 × 真实 HOME 只读回归。
  // 这是「注册/删除时不会破坏原有配置」这条承诺的可执行版本，必须每次必跑。
  'config-safety.mjs',
  // 提交脚本：信息必须走 stdin，不许落盘。曾经的病根是「先写文件再 -F 那个
  // 文件」，于是 git add -A 会把临时文件卷进发布提交。
  'commit-script.mjs',
  // MCP roots：不传 cwd 时用客户端当前打开的项目目录。走真实 stdio 握手，
  // 不需要 DSH，可以进 CI。
  'roots.mjs',
  // 工作区与标题的两个真实行为：cwd 选家目录要提前拦住、title_hint 不能被
  // DSH 自动标题吞掉。纯模块加载，不拉 DSH，归到必跑一档。
  'workspace-titles.mjs',
  // 真实配置往返：本机已装的客户端配置复制进沙箱，注册再撤销必须逐字节还原。
  // 手工 fixture 证明实现符合假设，这一组证明假设和真实文件一致。
  'real-configs.mjs',
  // 打包可发布性：files 白名单、零依赖、Node 下限、bin shebang。
  // 纯静态检查 + npm pack --dry-run，不花 token。
  'package-check.mjs',
  // 零依赖静态检查（scripts/lint.mjs）自身的回归：每条规则都会报、合法写法不误报，
  // 并顺带断言本仓库是 lint 干净的。纯文件系统 + node --check，不花 token。
  'lint.mjs',
];

/** 需要真实 DSH + provider 的套件（--all）。 */
const MODEL = [
  'boundary.mjs',
  'integration.mjs',
  'async.mjs',
  'sentinel.mjs',
  'timeout.mjs',
  'lock.mjs',
  'multi.mjs',
  'list.mjs',
  'permission.mjs',
  // 共享进程池的真机验证：没有 DSH 时套件自己 skip（退出 0）。
  'shared-process.mjs',
  'cycle.mjs',
  'concurrency.mjs',
  'capability.mjs',
  'workspace-effect.mjs',
  // 没有 IDA MCP（mcp__ida__*）时套件自己明确 skip（打印 skipped，退出 0），
  // 所以把它接进 --all 是安全的；README 不再声称一个实际没跑的命令。
  'acceptance.mjs',
  'reasoning-check.mjs',
];

function run(script) {
  return new Promise((resolve) => {
    console.log(`\n${'█'.repeat(70)}\n█ ${script}\n${'█'.repeat(70)}`);
    const child = spawn(process.execPath, [join(HERE, script)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const failed = [];
const skipped = [];
for (const script of [...OFFLINE, ...(all ? MODEL : [])]) {
  if (bail && failed.length) {
    skipped.push(script);
    continue;
  }
  const code = await run(script);
  if (code !== 0) failed.push({ script, code });
}

// 收尾清理：只清本仓库测试造出来的目录（真实项目会话与状态目录不动）。
// 无论前面成败都跑，否则失败的运行会把垃圾留在磁盘上。
// ★ cleanup 的退出码必须计入总结果：以前忽略它，清理悄悄失败也会显示全绿。
const cleanupCode = await run('cleanup.mjs');
if (cleanupCode !== 0) failed.push({ script: 'cleanup.mjs', code: cleanupCode });

const total = OFFLINE.length + (all ? MODEL.length : 0) + 1;
console.log(`\n${'='.repeat(70)}`);
console.log(`套件：${total} 个，失败 ${failed.length} 个${skipped.length ? `，因 --bail 跳过 ${skipped.length} 个` : ''}`);
for (const f of failed) console.log(`  ✗ ${f.script}（退出码 ${f.code}）`);
if (skipped.length) console.log(`  跳过：${skipped.join(', ')}`);
console.log(`\n总结果: ${failed.length === 0 ? '通过 ✅' : '失败 ❌'}`);
process.exit(failed.length ? 1 : 0);
