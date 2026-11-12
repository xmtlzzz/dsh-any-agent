> 返回 [README](../../README.zh.md)

# 🧪 测试

```bash
npm test                   # 全部离线套件；没有 DSH 时 smoke 自动跳过会话段
npm run test:all           # 离线 + 需要模型的套件（需要 DSH/provider）
node test/cleanup.mjs      # 单独跑收尾清理（只清测试自己造的目录；--dry-run 可预演；%TEMP% 下的 dsh-any-agent-* 目录要加 --purge-temp 才删）
npm run lint               # 零依赖静态检查：语法、导入路径、具名导出、未使用导入
node test/run.mjs --all --report .state/test-report.json   # 同上，并指定 JSON 报告位置（每次运行默认都写 .state/test-report.json）
npm run docs:counts       # 把报告里的检查数写回本文与 CI 注释（见下文「改了测试之后」）
npm run docs:counts:check # 只检查文档与报告是否一致，不一致 exit 1 并打印差异
```

`npm run lint`（`scripts/lint.mjs`）对 `src/ bin/ scripts/ test/ demo/` 下每个 `.mjs` 跑 `node --check`，并核对每条相对路径的 `import` / `export … from` 都指向存在且**大小写一致**的文件、每个具名导入都是目标模块的真实导出、没有未使用的具名导入。它不引入任何 npm 依赖（`package-check` 仍然强制零依赖），是 token 级扫描而不是完整解析器：宁可漏报也不误报。拆模块、挪函数之后先跑它 —— 一个漏掉的导出在没有真实 DSH 的 CI 上往往要到某条冷路径才会炸。CI 的离线 job 在每个矩阵格里都会先跑一遍。

模型套件不在 GitHub 托管 CI 里（需要真实 DSH、provider 与凭据）。在本机跑，
或用 `model-suites` workflow 指定一台装好 DSH 的 self-hosted runner。

测试套件**会自己收尾，跑完不留残留**。真机套件会在各自的 `finally` 里调用 `test/residue.mjs` 的 `cleanupSuite`，精确清掉**自己造的**会话（`McpClient` 自动记下每个 `dsh_start` 返回的 id；再按套件自己的临时根兜住没记到 id 的会话与 DSH 自己派出的子代理会话），连同它的**全部产物**：
- DSH 侧：会话日志、投影缓存 `storages/session_projcache/sessions/<id>.json`（删会话目录**不会**带走它，旧版跑多了会攒出几百个孤儿）、`workspace.json` 里的登记、forget 墓碑；
- 本项目侧：注册表条目、`meta/`、哨兵 `runs/`、审核 `reviews/`、写锁登记 `locks/`（状态目录收在套件自己的临时根里，不再散落在 `%TEMP%` 根下）。

`run.mjs` 结束时再执行一遍全局 `cleanup.mjs` 作兜底（处理被杀掉的进程、旧版本的残留、投影缓存里的测试孤儿）。**护栏**：只有 cwd 是**测试自己造的目录**（当前进程的 `tmpdir()/dsh-any-agent-*`、桌面 `dsh-any-agent-test-A|B`、本仓库 `.state/ws-probe-*`）的会话才会被删，**点名 id 也绕不过**；用户在 `%TEMP%` 里自己的真实项目、并行 agent 的临时根（TMP 指到别处）、以及你的状态目录都不会被碰。要连桌面测试目录一起清，可显式跑 `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`。`run.mjs` 每轮先建一个专属临时根（`%TEMP%\dsh-any-agent-run-*`），子进程的 TEMP/TMP/TMPDIR 都指向它，收尾只递归删除这个根里的东西；系统临时目录下其它同名前缀的目录不会被碰，单独运行 `cleanup.mjs` 时也只报告、不删除，除非显式加 `--purge-temp`。

为什么真机套件不把 `DSH_HOME` 指到一次性沙箱：DSH 的凭据在 `$DSH_HOME/.credentials.yaml`，沙箱里没有它真机套件就拿不到模型，而把密钥/路由复制进临时目录等于多开一个泄漏面；所以真机套件继续用真实 `~/.dsh`，靠上面这套精确清理保证不留残留（纯离线套件早就用沙箱 `DSH_HOME`，见 `test/sandbox-home.mjs`）。

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `smoke` | 54（无 DSH 时 40） | 握手、**instructions 长度上限**（客户端会截断过长说明）且铁律在最前、工具表（15 个工具）、建会话、配置、注册表纯净性、原型链工具名拒绝 |
| `dsh-locate` | 21 | **DSH 自动发现**：纯 Node 读合成的 `app.asar`（版本、`engines.node`、入口存在性）、桌面版目录映射到自带 Electron 运行时 + `ELECTRON_RUN_AS_NODE=1`、候选排序（能跑的优先 → 版本高 → 桌面版 > 全局 > npx）、`DSH_BIN` 指进 asar 自动配桌面版运行时、`DSH_RUNTIME` 覆盖、`engines.node` 区间判定、`reg export` 输出解析（不花 token、不读注册表） |
| `boundary` | 46 | 协议边界（重复 initialize、脏行、未知方法）、参数校验（含 read-only + 宽松审批必须拒绝、未知 provider/model、失败创建不留下写锁登记）、未知 id、游标边界、生命周期幂等、unicode |
| `integration` | 30 | 跨进程 resume 与记忆、中断、两种插话 |
| `async` | 21 | fire-and-forget + 事后验收，含收据/结果/哨兵里的审核单，以及一次真实 `dsh_review` 往返 |
| `sentinel` | 36 | 完成哨兵：原子性、闩锁语义、多会话并发不串台、被取消也落地、**思考不进文件** |
| `prune` | 11 | **哨兵留存**：清超期与崩溃残留、留新、清空壳目录、`TTL=0` 关闭清理、且绝不碰同目录的会话注册表（不花 token，每次必跑） |
| `guards` | 43 | **环境变量守卫**：奇怪的数值一律压到安全侧 —— `IDLE_TTL_MS` 的 `-1` 当"永不回收"、非法值/空串回落默认 10 分钟、回收间隔过小压回默认（防空转紧循环）、**失联阈值下限 30 秒**（防别的实例"合法地"抢占并杀掉我们的回合）；以及团队模式的默认值与优先级（`DSH_MCP_TEAM` > `settings.json` > 默认关）（不花 token，每次必跑） |
| `watchdog` | 33 | **回合看门狗**：开始 15 分钟内不打扰；没有任何进展才算卡住（有工具在跑时宽限放大 3 倍，工具重叠时短的先完成也不缩回；等调用方裁决审批时不判）；总时长上限不看进展；卡住时发 `session/cancel`，回合照常收尾，结果、审核单、哨兵都带 `watchdog`（假 ACP 进程 + 毫秒级阈值，不花 token） |
| `worktree` | 30 | **会话级 worktree 隔离**：worktree 建在状态目录下、不在仓库里；分支 `dsh/…` 基于主检出 HEAD；子目录映射（cwd 经 junction / 符号链接这类别名路径进来也一样）；主检出有未提交改动时如实标出；不是 git 仓库 / 没有提交时明确报错；**不跑仓库自带的钩子和 filter 驱动**（检出时的 smudge、status 时的 clean；带对照：不屏蔽时会执行）；干净才删目录、分支保留；建会话失败时整个撤销；`Hub.create(isolation='worktree')` 用假 ACP 进程（临时 git 仓库，不花 token） |
| `daemon` | 23 | **常驻进程模式**（`DSH_MCP_DAEMON=1`）：MCP 握手经转发进程到常驻进程；**转发进程被强杀后，常驻进程里正在跑的回合照常跑完、写出哨兵**；同一配置的第二个客户端连到同一个常驻进程，配置不同则另起一个；API 钥匙（`*_KEY`）不同的客户端各用各的常驻进程，只是会话级变量不同则照旧共用（带对照）；live 事件按连接记客户端名（后连上来的客户端不会顶掉先前连接派的活）；切换 `team on/off` 设置后重连会另起一个常驻进程；没带令牌 / 令牌不对的连接拿不到任何应答（带对照）；没有客户端也没有回合时空闲退出并删掉信息文件；超过 10 MB 的日志在下次启动时滚动成 `.1`（假 ACP 进程，不花 token） |
| `run-recovery` | 21 | **被中断回合的恢复**：回合开始写 `<run_id>.running` 标记、写出哨兵时删掉；启动恢复只认领主人 PID 已不在或被复用（启动时刻对不上）的标记，主人还活着 / 读不到启动时刻 / 看不懂的文件一律不碰，哨兵已在就只删标记；同一主人只查一次启动时刻；**关闭时在停任何子进程之前就写好中断哨兵**；**端到端：服务进程在回合中途被强杀，下一个服务进程启动时补出 `interrupted` 哨兵，dsh_get 也查得到**（假 ACP 进程，不花 token） |
| `contract` | 13 | **对外契约快照**：MCP 工具面（工具名、参数类型、是否必填、枚举值）与哨兵字段（完成的回合、补写的中断回合）对比 `test/contract.snapshot.json`；新增算兼容，删除 / 改类型 / 改成必填 / 删枚举值算破坏性，原来为空的值有了具体形状算细化；哨兵带 `schema`；判定规则自检；哨兵有破坏性改动而 `SENTINEL_SCHEMA` 没加一时 `--update` 拒绝重写快照（假 ACP 进程，不花 token） |
| `update-check` | 17 | **`dsh_doctor` 的新版本检查**（假 fetch，不联网）：`DSH_MCP_UPDATE_CHECK=0` 时不调 fetch；只请求 npm registry 上本包的 latest、只带 accept 头；结果缓存 24 小时、过期重查、时钟倒退不信缓存；离线 / HTTP 错误 / 响应不对都报未知且不缓存；fetch 一直不回（也不理 abort）时按超时返回并 abort 请求；版本比较含预发布版 |
| `sandbox-guard` | 21 | **测试沙箱自身**：「临时 HOME」如果落到真实用户目录、它的子目录、盘符根目录，或 OS 临时目录之外，一律报错拒绝，绝不被写入和删除。其余套件都通过 `test/sandbox-home.mjs` 拿目录、只销毁自己建的那个（不花 token，每次必跑） |
| `approval-details` | 40 | **审批审查上下文**：待决审批的快照带命令、理由、cwd 与原始审批 ID —— 不只是一个裸 ID，调用方才能真正裁决；缺失的 `rawInput` 会按 ID 从先前的 `tool_call` 更新关联回来；凭据形状的字段与常见内联字面量在结构化上下文和展示标题里都会脱敏；关闭会话会取消待决审批。经真实 stdio MCP 端到端验证 |
| `failure-terminal` | 10 | **失败路径的终态**：`ensureAlive` 失败时唤醒 `dsh_interject` 等待者、落 `status=error` 哨兵、错误对象挂 `runId`；审批没有对应 option 时 `effective=cancelled` 而不是假报 allow；`dsh_get` 能从哨兵文件回读（不花 token） |
| `shared-host` | 42 | **共享进程宿主**：通知/审批按 `sessionId` 路由、未知会话审批一律取消、进程退出扇出所有挂载会话、最后一个会话 detach 才停进程；**默认开启且 `=0` 可关闭**（空串按未设置处理）；`takeover` 杀共享进程前的连坐检查；RSS 读取；**回收器选中会话之后、刷新 RSS 期间它开跑了回合（或刚用过），就不再停它**（不花 token） |
| `shared-process` | 8（无 DSH 时 skip） | **共享进程真机验证**：同 `(cwd, permission)` 的两个会话落在同一个 PID、关一个不影响另一个、全部关闭后宿主清空且 PID 退出（需要本机 DSH，`--all` 时运行） |
| `resume-retry` | 65 | **冷启动 resume 超时重试**（用 `test/fake-acp.mjs` 当 DSH，共享进程与 `DSH_MCP_SHARED_PROCESS=0` 各跑一遍）：第一次 `session/resume` 没回话 → 在新进程上重试一次（旧子进程已退出、写锁登记指向新进程）；一直没回话 → 恰好重试一次后如实报错，不留僵尸子进程与登记；撞写锁、invalid params 一律**不**重试；`AcpProcess` 超时错误带 `code=ACP_TIMEOUT` 与 `method`；共享宿主上还挂着别的会话时不重试（不花 token） |
| `dispatch-tools` | 83（非 Windows 79） | **派发面**：`dsh_inbox` 跨会话汇总待决审批、`client_run_id` 幂等命中与淘汰、队列 list/update/promote/remove（remove 写 cancelled 哨兵）、`dsh_get(max_chars)` 同时压缩 text 与 structured（正文截断、工具输入只留 `input_chars`，`max_chars=0` 仍返回全文）、`dsh_doctor` 的 DSH 版本档位（0.2.1-rc.5 / 0.2.2-rc.1 已验证，0.2.3+ 未验证）与 npx 缓存识别、PowerShell 哨兵等待命令的转义与真机执行、哨兵**读取**命令（`-Encoding UTF8`，在 Windows PowerShell 5.1 下正确解析中文；真机执行仅 Windows）、审计只记元数据不记正文、`dsh_doctor` 关键检查项；有回合在跑时，`dsh_status` 与不带 `run_id` 的 `dsh_get` 取的是正在跑的那个，后面排队的、排队后被取消的回合不会顶替它；DSH 不带工具名时，像标识符的 title（`pwsh`）补成 `tools_used[].name`，描述性的 title 不算，DSH 给的 name 优先（不花 token） |
| `read-cursor` | 26 | **`dsh_read` 游标语义**：追加到已读条目里的文本必须再次返回（修订号游标，按 `seq` 替换全文）；**每个工具调用各占一条**、状态更新原地替换（以前会拼成一条、只剩第一个工具的 id）；空回合的开始/结束仍是两条；**`answer` 里被工具调用隔开的正文之间补空行**（以前首尾相接）；`limit` 钳到 1..500，`0`/负数不会空转或丢尾（不花 token） |
| `line-decoder` | 4 | **UTF-8 行分帧**：MCP/ACP 的 chunk 边界不能把中文/emoji 截成 U+FFFD；覆盖逐字节、任意 chunk、CRLF 与 EOF 残留（不花 token） |
| `progress` | 16 | **MCP 进度通知**：调用带 `progressToken` 时阻塞中的 `tools/call` 定时回报；不带 token 不发、progress 递增、响应之后不再发、工具抛错同样停下、消息只有时长/工具名/字数（不花 token） |
| `sentinel-redaction` | 26 | **哨兵落盘卫生**：`result.thinking` 被剥掉、`thinking_omitted` 始终是布尔值、`answer`/`error`/`title`/`tools_used[].input` 都走与审批相同的凭据脱敏；`DSH_MCP_SENTINEL_TOOL_INPUTS=0` 时工具输入和自动放行的命令预览都不落盘（不花 token） |
| `live-events` | 47 | **live 事件流写入侧**：假 hub + 假 ACP 进程跑完整回合；事件序列与字段、工具只在状态变化时写、思考内容不落盘、预览脱敏、`meta`/`off` 级别、写失败不影响派活、ask 审批裁决、失败/排队/取消/forget；一个进程服务几个客户端时事件记在发起调用的客户端名下，排队的回合由别的客户端的回合带起来时仍记排队的那个（不花 token） |
| `live-view` | 69 | **live 查看端**：按字节切行（不切坏中文）、调用链归并、写者退出显示中断、增量 tail（半行/滚动/删除）、`watch --once` 走 bin 入口、`dashboard` 的 token / Host / 只读校验与 SSE（不花 token） |
| `release-notes` | 12 | **Release 说明**：从 CHANGELOG 取对应一节（`1.1.1` 不误匹配 `1.1.10`、到链接定义区为止）、空节与缺失版本直接报错、附安装命令与 compare 链接、命令行退出码（不花 token） |
| `review` | 70 | **调用方审核**：默认 `advisory` 审核单带清单 + 证据 + `dsh_review` 入口；`dsh_review` 把裁决落盘并回写内存 run 与哨兵；`fail`/`partial` 必须给理由；未完成/未知 run 被拒绝；重启后仍可凭哨兵审核；队列与 `client_run_id` 重放收据也带审核单；审核记录与哨兵共享 TTL；理由、预览、证据**与清单项**都凭据脱敏；**路径穿越 id 在触盘前就被拒绝**（不花 token） |
| `forget-tombstone` | 25 | **`forget` 是终态**：`release(forget=true)` 写墓碑，按 id 查询明确失败并给出恢复路径，列表不再展示；删除墓碑后回到常规“未知会话”路径（不花 token） |
| `bootstrap-profile` | 27 | **首启 profile 在零依赖发布形态下可用**：内置 YAML 子集解析器复制路由、剥掉 `apiKey`/`headers`/字面密钥、绝不写 `defaultPreset`、幂等；用户手写文件逐字节不动（不花 token） |
| `workspace-safety` | 23 | **数据丢失边界**：`isTempPath` 按路径分段（`tmpdir()+'Suffix'`、`/tmpfoo` 都不算临时目录）、坏 `workspace.json` 绝不覆盖、会话根不可读时绝不清空 `sessionIds`、自动清理只删测试造的会话（不花 token） |
| `residue-purge` | 161 | **测试残留清理**（沙箱 `DSH_HOME`，不花 token）：一个测试会话的每种产物（会话日志、投影缓存、工作区登记/archived/pinned、墓碑、注册表条目、元数据、哨兵、审核、锁登记）都被清掉；**非测试会话逐字节不变**（点名也删不掉）；子会话级联、`roots` 限定、干跑零写入、坏文件 fail-closed、路径穿越、旧版扁平目录必须有证据才清、各真机套件都接上了收尾 |
| `permission-adopt` | 26 | **不无声提权**：接管没有权限记录的外部会话时 fail-closed 到 `read-only`；记录为 `read-only` 的会话不能被侧车提升；运行期回读记录与请求不一致会失败（不花 token） |
| `state-safety` | 26 | **状态/哨兵/锁目录**：默认在 `$DSH_HOME/.dsh-any-agent`、不可写时启动明确失败、哨兵写失败返回 `null` + `sentinel_error`、非法数值落安全侧（不花 token） |
| `workspace-snapshot` | 27 | **工作区快照**：`workspace_changed` 必须看全量文件内容（同一状态行但内容变了、第 41 条之后的改动、未跟踪目录内部），且 `gitStatus` 异步执行、不阻塞共享 MCP 事件循环（纯文件系统 + 临时 git 仓库，不花 token） |
| `setup` | 49 | **注册 CLI**：预览不写盘、`--remove` 只摘自己那条、没装客户端算跳过不算失败、Codex TOML 段往返、`--daemon` 写入 `DSH_MCP_DAEMON=1` 且不带它重跑就去掉、以及把写进配置里的命令真的拉起一次并要求应答 `initialize`（不花 token）。**不会调用 `claude mcp get`** —— 那个 CLI 会整体回写 `~/.claude.json` |
| `removal-scope` | 61 | **注销只动自己那条**：给一份装着别的 MCP 服务器、顶层 Codex 设置和 Zed 兄弟设置的配置，注册再注销，断言其余每个值逐字节不变；删一个从没写过的东西 = 无写入、无报错（不花 token） |
| `config-safety` | 450（无客户端配置时 449） | **0.3 这条线的核心性质**，逐客户端验证：预览后文件逐字节不变且不产生 `.bak`；注册再注销后其余条目逐字节还原、键顺序不变、顶层键不丢；4 空格 / 2 空格缩进、单行 JSON、无末尾换行、CRLF、UTF-8 BOM 都能在写入后保留；坏 JSON 与只读文件被拒绝且原文件无损；第二次 `--yes` 空跑不新增备份；每个 `.bak-dsh-<时间戳>` 只出现一次且内容等于写入前字节；PATH 上有 `claude` 也绝不调用（不花 token） |
| `real-configs` | 93（7/10 配置时 66，6/10 配置时 57，5/10 配置时 48） | **拿真家伙做往返**：把本机**真实**的客户端配置复制进临时目录（18 万字节、含几百个 `projects` 条目与大小写重复键的 `~/.claude.json`，238 行的 Codex TOML，Zed 的完整 `settings.json`），注册再撤销，要求每个文件**逐字节**还原；条目是否存在按**键**判断而不是裸子串；缺少 fixture 时明确打印 `skipped`，绝不假绿（不花 token） |
| `commit-script` | 26 | 提交信息走 stdin，绝不落临时文件让 `git add -A` 卷进发布提交（不花 token） |
| `test-counts` | 92 | **检查数同步**：套件输出解析（中英文汇总行、整套 skip、`✓`/`✗` 兜底、`[report]` 环境标注）、报告拼装、「主数字（其它环境的数字）」单元格往返、对中英文文档与 `tests.yml` 的重写、`--check` 差异与 `--portable`、模型套件数字不动、失败的报告被拒绝（不花 token） |
| `roots` | 18 | 不传 `cwd` 时通过 MCP roots 取客户端当前项目；不支持 roots 的客户端得到可操作的报错（不花 token） |
| `workspace-titles` | 19（TEMP 在家目录外时 18，区分大小写且 TEMP 在家目录外时 17） | 家目录**与文件系统根目录**当工作区都会在 DSH 启动前被拦住；`title_hint` 与 DSH 自动标题分开返回（不花 token） |
| `package-check` | 15 | `files` 白名单、零运行时依赖、Node 下限、bin shebang（不花 token） |
| `lint` | 22 | **静态检查 `npm run lint` 自身的回归**：在临时目录造一棵有问题的树，逐条断言语法错、导入路径不存在 / 大小写不一致、具名导出不存在（含 `export { x } from`、`await import()` 解构、`node:` 内置模块）、未使用导入都会报；写法刁钻但合法的树（模板字符串里的用法、正则里的引号、`export *`）零误报；并断言本仓库自己是 lint 干净的（不花 token） |
| `timeout` | 40 | **超时语义**：`wait=false` 不受 `timeout_ms` 影响、`wait=true` 到期只转后台（不取消/不丢结果、`busy` 不说谎）、`timeout_ms=0` 一直等、**负 `timeout_ms` 明确报错**（不派出回合、会话照常可用）、resume 失败会作废进程而不永久卡死、空 prompt 给清晰错误 |
| `lock` | 79 | **写锁与抢占**：四类持有者判定、`writeMarker` 不覆盖活着的持有者、登记文件损坏/目录缺失等边界；**端到端**两实例抢锁 → 清晰报错 → 拒绝 → `force` 夺锁；**崩溃自动释放锁**、**卡死持有者无 force 自动抢占**；以及"一个回合 = 一个哨兵"的不变量（含内联回合与空闲插话） |
| `cycle` | 36 | **异步派活的生命周期**：异步派活 → 收哨兵 → 空闲回收 → 再派活，连做 3 轮必须全程无锁错误；贴着回收窗口立刻重派（放大竞态）；`dsh_release` 后立刻重派；并断言回收后**不留下无法归因的锁**（这条实测抓到过"刚拉起的进程被 reaper 当空闲收掉"的竞态） |
| `concurrency` | 31 | 三会话并发 + 实时增量读 |
| `capability` | 22 | 写代码、跑脚本、**自行派子代理**（用磁盘上的子会话头验证） |
| `workspace-effect` | 24 | 不给路径时工作区是否真的生效 |
| `acceptance` | 36（没有 IDA MCP 时 skip） | 两个文件夹 × 两个会话做只读 IDA Pro 分析 |
| `multi` | 19 | **多实例共存 + 非 ASCII 路径**：复现"两实例共写注册表 → 后写的把先建的会话抹掉"，并验证**仅凭 id 就能从会话存储找回并真的派活**（指注册表丢失，不是显式 `forget` —— forget 是终态墓碑）；**兜底取回不会悄悄提权**（read-only 会话取回后仍是 read-only）；不留 `.tmp` 残渣；**中文 / emoji 工作区路径**能建会话、能干活、文件落在正确目录 |
| `permission` | 11 | ★ **权限档是否真的生效**（安全属性）：不看我们的返回值（那正是会说谎的地方），而是读**会话自己记录的事实**（投影缓存里的 `permissions.preset` / `sandboxMode`），三档逐一核对且三档记录值互不相同。**这条测试抓到过无声提权**：profile 里 `defaultPreset` 会在会话创建时盖掉 `DSH_PERMISSION_MODE` |
| `list` | 17 | **`dsh_list` 的开销**：含磁盘探测的默认调用要 spawn 一个 DSH 进程（会话多时数秒），**连续调用命中缓存**（用 `probe_cached` 判定而不是墙钟：Windows 上偶尔有一次缓存调用多出约 700ms）；`only_running=true` 与 `include_closed=false` **跳过探测**（`probe_ok=null`）且语义等价（不把磁盘上的未打开会话算进来） |
| `reasoning-check` | 8 | **思考可见性**：`reasoning=hide` 不返回思考正文但统计非零；`reasoning=full` 返回正文且渲染出思考段 |

> **2026-11-06**：`node test/run.mjs` 现在**跑完全部套件**再在末尾列出所有失败项（`--bail` 恢复遇错即停）—— 以前 `timeout.mjs` 一条过时断言就让后面 11 个真机套件全部没跑。需要模型的套件已对桌面版自带运行时上的 DSH 0.2.2-rc.1 全量重跑。

<!-- counts:begin (generated by scripts/sync-test-counts.mjs; do not edit by hand) -->
**`node test/run.mjs` 在本机（Windows，没有 DSH，6/10 个客户端配置 fixture）跑了 41 个离线套件、1907 项检查，全部通过。**表中带括号的数字随环境变化（有没有 DSH、哪个平台、文件系统是否区分大小写、本机装了几个客户端配置），套件总数也随之变化；这一行记录的是上次同步所用报告的环境。

其中 **617 项属于客户端注册器套件**（`setup` 49、`removal-scope` 61、`config-safety` 450、`real-configs` 57）—— 0.3 的活其实都在这里。

需要模型的套件（`boundary` 46、`integration` 30、`async` 21、`sentinel` 36、`timeout` 40、`lock` 79、`multi` 19、`list` 17、`permission` 11、`shared-process` 8、`cycle` 36、`concurrency` 31、`capability` 22、`workspace-effect` 24、`acceptance` 36、`reasoning-check` 8）名义合计 **464 项**；有 DSH 时 `smoke` 还会多跑 14 项会话段。它们要可用的 DSH 与 provider，发版前请自己重跑一遍：`node test/run.mjs --all`。`acceptance` 在没有 IDA MCP（`mcp__ida__*`）时会明确 **skip**；`shared-process` 没有 DSH 时也会 skip。

> 三个总数是刻意分开的：本机 `node test/run.mjs`（1907）、CI 离线 job（名义 Linux/macOS 1843，Windows 1849；hosted runner 没有 DSH 也没有客户端 fixture，`smoke` 跳过会话段、`real-configs` 整体跳过）、需要模型的集合（名义 464）。数字取各套件自己打印的汇总，由 `npm run docs:counts` 从报告写回，不在这里手抄；不要把一个数字套到另一个 runner 上。
<!-- counts:end -->

### 🔢 改了测试之后：检查数是算出来的

本文的检查数不手写。`node test/run.mjs` 每次运行都会把各套件的输出收下来，解析成一份 JSON 报告（默认 `.state/test-report.json`，已被 `.gitignore`；`--report <路径>` 换位置，`--no-report` 不写）：每个套件的 `passed` / `failed` / `skipped` / `exitCode` / `durationMs`，加上平台、Node 与 DSH 版本、本机有几个客户端配置 fixture。数字取各套件自己打印的汇总行（`===== …：通过 N，失败 M =====`）；没有汇总行的老套件退回去数 `✓`/`✗` 行；新写的套件请直接打印标准汇总行。

**改完测试后：**

```bash
node test/run.mjs --all --report .state/test-report.json   # 要有 DSH/provider；只想更新离线数字就去掉 --all
npm run docs:counts                                        # 写回本表、上面的总数段落（中英文）与 .github/workflows/tests.yml 的范围注释
git diff docs .github                                      # 看一眼改了什么，然后提交
```

- **没带 `--all`**：报告里没有需要模型的套件，模型套件的数字原样保留（脚本会说明）。
- **随环境变化的套件**写成「主数字（其它环境的数字）」：`smoke`（有无 DSH）、`dispatch-tools`（Windows 多跑 PowerShell 哨兵的真机执行）、`config-safety` 与 `real-configs`（本机装了几个客户端配置）、`workspace-titles`（文件系统是否区分大小写、`TEMP` 是否在家目录内）。**只更新这次量到的那一格**，其余格子原样保留 —— 想补哪一格，就在对应环境里再跑一次，把几份报告按顺序用多个 `--report` 传给 `docs:counts`。
- **整套 skip 的套件**（没有 DSH 的 `shared-process`、没有 IDA MCP 的 `acceptance`、没有客户端配置的 `real-configs`）不动数字。
- **报告里有失败的套件时脚本拒绝写入**（exit 2）：失败套件的检查数不可信。
- **新增套件**：先加进 `test/run.mjs` 的 `OFFLINE`/`MODEL`，再在表里补一行（脚本不替你写"覆盖"说明；缺行会 exit 1 并点名）。

**防漂移：** `npm run docs:counts:check` 不写文件，文档与报告不一致就打印差异并 exit 1。CI 的离线 job 跑完 `node test/run.mjs --report` 后执行 `docs:counts:check --portable`，只核对与环境无关的套件，以及只取决于「没有 DSH、没有客户端配置」的 `smoke` / `config-safety` 在 runner 上那一格；随平台变化的套件留给本机的完整检查（发版清单里有这一步）。`test-counts` 套件覆盖报告解析与文档重写本身。

### 🧯 为什么会有 `sandbox-guard`

2026-10-29 的一次性验证脚本把沙箱路径存进了 **PowerShell** 的 `$home`。`$home` 是只读自动变量，赋值静默失败（脚本设了 `$ErrorActionPreference = 'Continue'`），`$env:USERPROFILE` 照样被改成了那个假路径，于是收尾那句 `Remove-Item $home -Recurse -Force` 落在**真实用户目录**上。那次运行在 120 秒超时被杀在半路，删掉了 `~/.codex`、`~/.cursor`、`~/.claude` 的一部分。

此前所有套件对**写入方**的断言都是真的，缺的是对**沙箱本身**的断言。`sandbox-guard` 就是这条断言：真实 HOME、它的子目录、大小写变体、盘符根目录、`os.tmpdir()` 之外的位置，全部拒绝。现在 `test/sandbox-home.mjs` 是唯一创建与销毁沙箱的地方，`setup`/`removal-scope` 自己不再调用 `mkdtempSync` 或 `rmSync` —— 一旦退回旧写法，套件立刻失败。

### 📏 本文档里的数字必须可复现

这里的每一个数字，要么是**测试打印出来的**，要么是**你用一条命令就能重跑出来的**。要改数字，就改成实测值 —— 不是估算，更不是一个看起来合理的值。

单列这一节，是因为这条规矩被违反过。早期版本的 README 声称 `dsh_send(wait=false)` "在 ~1ms 内返回"（实测 81ms）、打断收敛 "~18ms"（没有任何测试产出过这个数 —— `integration.mjs` 只断言 `waited_ms` 落在 0–25 秒之间；人工实测四次为 91/102/105/119ms）、每会话占用 "~120MB"（实测 295–476MB）—— 最后这个还在同一句话里自相矛盾，同时写着 "每个 120MB" 和 "3 个 = 428MB"。

**三档，以及各自该怎么写：**

| 档位 | 含义 | 写法 |
|---|---|---|
| **测试断言** | 有套件在断言它 | 直接给数字，套件就是权威 |
| **实测** | 你跑过命令 | 给数字 **和测法**，让别人能复现 |
| **估算** | 推导或上界 | 明确写出来（"约"、"最坏"、"≈"），并给出算法 |

**把测法写在同一处。** 内存那两个数字就是范例 —— 它写清了工具、前后对比、以及两次采样：

```text
实测 300-480MB / 会话
  （Get-Process node: 在单个活跃会话跑到 end_turn 前后分别求和 WorkingSet64；
    两次冷启动分别得到 476MB 和 295MB）
```

**你的测量和文档不符，就说出来。** 数字依赖机器、DSH 版本和负载。实测落在文档区间之外，值得开个 issue —— 区间是一个主张，不是装饰。
