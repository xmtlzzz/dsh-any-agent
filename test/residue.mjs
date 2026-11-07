/**
 * 真机套件的收尾清理（每个会拉起真实 DSH 的套件在自己的 `finally` 里调用）。
 *
 * 目标：跑完不留任何残留 —— DSH 的会话日志/投影缓存/工作区登记/墓碑，以及本项目的
 * 注册表/元数据/哨兵/审核/锁登记。规则与护栏见 `src/residue.mjs`、`src/workspace.mjs`：
 * 只会动 cwd 是测试目录的会话，点名也绕不过。
 *
 * 用法（务必放在 `await client.close()` 之后、`rmSync(ROOT)` 之前或之后均可）：
 *
 *     } finally {
 *       await client.close();
 *       cleanupSuite({ clients: [client], roots: [ROOT] });
 *       rmSync(ROOT, { recursive: true, force: true });
 *     }
 *
 *   - clients  McpClient 会自动记下自己 dsh_start 出来的会话 id 与状态文件；
 *   - roots    套件自己的临时根（`mkdtempSync(tmpdir()/dsh-any-agent-…)`）。会话的 cwd 落在
 *              里面就一并清 —— 兜住"dsh_start 成功但结果丢了没记到 id"，以及 DSH 自己派出的
 *              子代理会话（测试根本不知道它们的 id）；
 *   - ids      额外要清的 id（套件自己另外记的）。
 *   全局的 `test/cleanup.mjs` 只是兜底，处理"进程被杀、finally 没跑到"留下的东西。
 *
 * ── 为什么不把 DSH_HOME 指到一次性沙箱 ─────────────────────────────────────
 * 这样当然最干净（连 DSH 的 workspace.json、projcache 都是一次性的），但**做不到而不复制凭据**：
 *   - DSH 在每次请求时从 `$DSH_HOME/.credentials.yaml`（其次是继承的环境变量、`.env`）解析
 *     provider 的密钥；沙箱里没有这个文件，真机套件就拿不到模型。
 *   - 沙箱还需要 `profiles/`（模型路由）与运行时，bootstrap 会从真实 home 抄路由。
 *   把密钥/路由复制（或硬链接）进临时目录等于把凭据散到磁盘的另一处，而且要保证它也被清掉——
 *   用一个新的泄漏面换"少一次精确清理"，不划算。所以真机套件继续用真实 `~/.dsh`，
 *   靠上面这套"只清自己造的、cwd 必须是测试目录"的精确清理保证不留残留、不碰真实会话。
 *   （纯离线套件早就用沙箱 DSH_HOME 了：`test/sandbox-home.mjs`。）
 */

import { purgeTestResidue } from '../src/residue.mjs';

/**
 * @param {object} opts
 * @param {Array<{createdIds?: Set<string>, stateFile?: string|null}>} [opts.clients]
 * @param {string[]} [opts.ids]
 * @param {string[]} [opts.roots]
 * @param {Array<string|object>} [opts.stateFiles] 额外的状态目录规格
 * @returns 清理结果（出错时为 null；**不抛错**：收尾失败不该掩盖套件自己的结论，但会打印警告）
 */
export function cleanupSuite({ clients = [], ids = [], roots = [], stateFiles = [] } = {}) {
  const allIds = new Set(ids.filter(Boolean));
  const states = new Set(stateFiles);
  for (const c of clients) {
    for (const id of c?.createdIds ?? []) allIds.add(id);
    if (c?.stateFile) states.add(c.stateFile);
  }
  try {
    const r = purgeTestResidue({
      ids: [...allIds],
      roots,
      stateFiles: states.size ? [...states] : undefined,
    });
    const failed = r.sessions.victims.filter((v) => v.error);
    console.log(
      `\n  收尾清理：删除测试会话 ${r.sessions.victims.length - failed.length} 个` +
        `（含投影缓存/登记/墓碑），状态条目 ${Object.values(r.project.removed).reduce((a, b) => a + b, 0)} 项`,
    );
    for (const s of r.sessions.skipped) console.log(`    ⚠️ 拒绝删除 ${s.id}：${s.reason}（cwd=${s.cwd}）`);
    for (const v of failed) console.log(`    ⚠️ 删除失败 ${v.id}：${v.error}`);
    for (const e of r.project.errors) console.log(`    ⚠️ ${e}`);
    return r;
  } catch (e) {
    console.log(`\n  ⚠️ 收尾清理失败（不影响套件结论）：${e.message}`);
    return null;
  }
}
