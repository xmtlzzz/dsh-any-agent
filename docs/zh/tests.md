> 返回 [README](../../README.zh.md)

# 🧪 测试

```bash
npm test                   # 全部离线套件；没有 DSH 时 smoke 自动跳过会话段
npm run test:all           # 离线 + 需要模型的套件（需要 DSH/provider）
node test/cleanup.mjs      # 单独跑收尾清理（只清测试自己造的目录；--dry-run 可预演）
```

模型套件不在 GitHub 托管 CI 里（需要真实 DSH、provider 与凭据）。在本机跑，
或用 `model-suites` workflow 指定一台装好 DSH 的 self-hosted runner。

测试套件**会自己收尾，跑完不留残留**。真机套件会在各自的 `finally` 里调用 `test/residue.mjs` 的 `cleanupSuite`，精确清掉**自己造的**会话（`McpClient` 自动记下每个 `dsh_start` 返回的 id；再按套件自己的临时根兜住没记到 id 的会话与 DSH 自己派出的子代理会话），连同它的**全部产物**：
- DSH 侧：会话日志、投影缓存 `storages/session_projcache/sessions/<id>.json`（删会话目录**不会**带走它，旧版跑多了会攒出几百个孤儿）、`workspace.json` 里的登记、forget 墓碑；
- 本项目侧：注册表条目、`meta/`、哨兵 `runs/`、审核 `reviews/`、写锁登记 `locks/`（状态目录收在套件自己的临时根里，不再散落在 `%TEMP%` 根下）。

`run.mjs` 结束时再执行一遍全局 `cleanup.mjs` 作兜底（处理被杀掉的进程、旧版本的残留、投影缓存里的测试孤儿）。**护栏**：只有 cwd 是**测试自己造的目录**（当前进程的 `tmpdir()/dsh-any-agent-*`、桌面 `dsh-any-agent-test-A|B`、本仓库 `.state/ws-probe-*`）的会话才会被删，**点名 id 也绕不过**；用户在 `%TEMP%` 里自己的真实项目、并行 agent 的临时根（TMP 指到别处）、以及你的状态目录都不会被碰。要连桌面测试目录一起清，可显式跑 `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`。

为什么真机套件不把 `DSH_HOME` 指到一次性沙箱：DSH 的凭据在 `$DSH_HOME/.credentials.yaml`，沙箱里没有它真机套件就拿不到模型，而把密钥/路由复制进临时目录等于多开一个泄漏面；所以真机套件继续用真实 `~/.dsh`，靠上面这套精确清理保证不留残留（纯离线套件早就用沙箱 `DSH_HOME`，见 `test/sandbox-home.mjs`）。

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `smoke` | 33 | 握手、**instructions 长度上限**（客户端会截断过长说明）且铁律在最前、工具表（15 个工具）、建会话、配置、注册表纯净性、原型链工具名拒绝 |
| `dsh-locate` | 19 | **DSH 自动发现**：纯 Node 读合成的 `app.asar`（版本、`engines.node`、入口存在性）、桌面版目录映射到自带 Electron 运行时 + `ELECTRON_RUN_AS_NODE=1`、候选排序（能跑的优先 → 版本高 → 桌面版 > 全局 > npx）、`DSH_BIN` 指进 asar 自动配桌面版运行时、`DSH_RUNTIME` 覆盖、`engines.node` 区间判定、`reg export` 输出解析（不花 token、不读注册表） |
| `boundary` | 46 | 协议边界（重复 initialize、脏行、未知方法）、参数校验（含 read-only + 宽松审批必须拒绝、未知 provider/model、失败创建不留下写锁登记）、未知 id、游标边界、生命周期幂等、unicode |
| `integration` | 30 | 跨进程 resume 与记忆、中断、两种插话 |
| `async` | 21 | fire-and-forget + 事后验收，含收据/结果/哨兵里的审核单，以及一次真实 `dsh_review` 往返 |
| `sentinel` | 36 | 完成哨兵：原子性、闩锁语义、多会话并发不串台、被取消也落地、**思考不进文件** |
| `prune` | 11 | **哨兵留存**：清超期与崩溃残留、留新、清空壳目录、`TTL=0` 关闭清理、且绝不碰同目录的会话注册表（不花 token，每次必跑） |
| `guards` | 40 | **环境变量守卫**：奇怪的数值一律压到安全侧 —— `IDLE_TTL_MS` 的 `-1` 当"永不回收"、非法值/空串回落默认 10 分钟、回收间隔过小压回默认（防空转紧循环）、**失联阈值下限 30 秒**（防别的实例"合法地"抢占并杀掉我们的回合）；以及团队模式的默认值与优先级（`DSH_MCP_TEAM` > `settings.json` > 默认关）（不花 token，每次必跑） |
| `sandbox-guard` | 21 | **测试沙箱自身**：「临时 HOME」如果落到真实用户目录、它的子目录、盘符根目录，或 OS 临时目录之外，一律报错拒绝，绝不被写入和删除。其余套件都通过 `test/sandbox-home.mjs` 拿目录、只销毁自己建的那个（不花 token，每次必跑） |
| `approval-details` | 37 | **审批审查上下文**：待决审批的快照带命令、理由、cwd 与原始审批 ID —— 不只是一个裸 ID，调用方才能真正裁决；缺失的 `rawInput` 会按 ID 从先前的 `tool_call` 更新关联回来；凭据形状的字段与常见内联字面量在结构化上下文和展示标题里都会脱敏；关闭会话会取消待决审批。经真实 stdio MCP 端到端验证 |
| `failure-terminal` | 11 | **失败路径的终态**：`ensureAlive` 失败时唤醒 `dsh_interject` 等待者、落 `status=error` 哨兵、错误对象挂 `runId`；审批没有对应 option 时 `effective=cancelled` 而不是假报 allow；`dsh_get` 能从哨兵文件回读（不花 token） |
| `shared-host` | 25 | **共享进程宿主**：通知/审批按 `sessionId` 路由、未知会话审批一律取消、进程退出扇出所有挂载会话、最后一个会话 detach 才停进程；**默认开启且 `=0` 可关闭**（空串按未设置处理）；`takeover` 杀共享进程前的连坐检查；以及 RSS 读取（不花 token） |
| `shared-process` | 8（无 DSH 时 skip） | **共享进程真机验证**：同 `(cwd, permission)` 的两个会话落在同一个 PID、关一个不影响另一个、全部关闭后宿主清空且 PID 退出（需要本机 DSH，`--all` 时运行） |
| `dispatch-tools` | 59（非 Windows 56） | **派发面**：`dsh_inbox` 跨会话汇总待决审批、`client_run_id` 幂等命中与淘汰、队列 list/update/promote/remove（remove 写 cancelled 哨兵）、`dsh_get(max_chars)` 同时压缩 text 与 structured（正文截断、工具输入只留 `input_chars`，`max_chars=0` 仍返回全文）、`dsh_doctor` 的 DSH 版本档位（0.2.1-rc.5 / 0.2.2-rc.1 已验证，0.2.3+ 未验证）与 npx 缓存识别、PowerShell 哨兵等待命令的转义与真机执行、哨兵**读取**命令（`-Encoding UTF8`，在 Windows PowerShell 5.1 下正确解析中文；真机执行仅 Windows）、审计只记元数据不记正文、`dsh_doctor` 关键检查项（不花 token） |
| `read-cursor` | 19 | **`dsh_read` 游标语义**：追加到已读条目里的文本必须再次返回（修订号游标，按 `seq` 替换全文）；**每个工具调用各占一条**、状态更新原地替换（以前会拼成一条、只剩第一个工具的 id）；空回合的开始/结束仍是两条；**`answer` 里被工具调用隔开的正文之间补空行**（以前首尾相接）；`limit` 钳到 1..500，`0`/负数不会空转或丢尾（不花 token） |
| `line-decoder` | 4 | **UTF-8 行分帧**：MCP/ACP 的 chunk 边界不能把中文/emoji 截成 U+FFFD；覆盖逐字节、任意 chunk、CRLF 与 EOF 残留（不花 token） |
| `sentinel-redaction` | 19 | **哨兵落盘卫生**：`result.thinking` 被剥掉、`thinking_omitted` 始终是布尔值、`answer`/`error`/`title`/`tools_used[].input` 都走与审批相同的凭据脱敏（不花 token） |
| `review` | 70 | **调用方审核**：默认 `advisory` 审核单带清单 + 证据 + `dsh_review` 入口；`dsh_review` 把裁决落盘并回写内存 run 与哨兵；`fail`/`partial` 必须给理由；未完成/未知 run 被拒绝；重启后仍可凭哨兵审核；队列与 `client_run_id` 重放收据也带审核单；审核记录与哨兵共享 TTL；理由、预览、证据**与清单项**都凭据脱敏；**路径穿越 id 在触盘前就被拒绝**（不花 token） |
| `forget-tombstone` | 10 | **`forget` 是终态**：`release(forget=true)` 写墓碑，按 id 查询明确失败并给出恢复路径，列表不再展示；删除墓碑后回到常规“未知会话”路径（不花 token） |
| `bootstrap-profile` | 24 | **首启 profile 在零依赖发布形态下可用**：内置 YAML 子集解析器复制路由、剥掉 `apiKey`/`headers`/字面密钥、绝不写 `defaultPreset`、幂等；用户手写文件逐字节不动（不花 token） |
| `workspace-safety` | 23 | **数据丢失边界**：`isTempPath` 按路径分段（`tmpdir()+'Suffix'`、`/tmpfoo` 都不算临时目录）、坏 `workspace.json` 绝不覆盖、会话根不可读时绝不清空 `sessionIds`、自动清理只删测试造的会话（不花 token） |
| `residue-purge` | 145 | **测试残留清理**（沙箱 `DSH_HOME`，不花 token）：一个测试会话的每种产物（会话日志、投影缓存、工作区登记/archived/pinned、墓碑、注册表条目、元数据、哨兵、审核、锁登记）都被清掉；**非测试会话逐字节不变**（点名也删不掉）；子会话级联、`roots` 限定、干跑零写入、坏文件 fail-closed、路径穿越、旧版扁平目录必须有证据才清、各真机套件都接上了收尾 |
| `permission-adopt` | 17 | **不无声提权**：接管没有权限记录的外部会话时 fail-closed 到 `read-only`；记录为 `read-only` 的会话不能被侧车提升；运行期回读记录与请求不一致会失败（不花 token） |
| `state-safety` | 26 | **状态/哨兵/锁目录**：默认在 `$DSH_HOME/.dsh-any-agent`、不可写时启动明确失败、哨兵写失败返回 `null` + `sentinel_error`、非法数值落安全侧（不花 token） |
| `setup` | 45 | **注册 CLI**：预览不写盘、`--remove` 只摘自己那条、没装客户端算跳过不算失败、Codex TOML 段往返、以及把写进配置里的命令真的拉起一次并要求应答 `initialize`（不花 token）。**不会调用 `claude mcp get`** —— 那个 CLI 会整体回写 `~/.claude.json` |
| `removal-scope` | 24 | **注销只动自己那条**：给一份装着别的 MCP 服务器、顶层 Codex 设置和 Zed 兄弟设置的配置，注册再注销，断言其余每个值逐字节不变；删一个从没写过的东西 = 无写入、无报错（不花 token） |
| `config-safety` | 407 | **0.3 这条线的核心性质**，逐客户端验证：预览后文件逐字节不变且不产生 `.bak`；注册再注销后其余条目逐字节还原、键顺序不变、顶层键不丢；4 空格 / 2 空格缩进、单行 JSON、无末尾换行、CRLF、UTF-8 BOM 都能在写入后保留；坏 JSON 与只读文件被拒绝且原文件无损；第二次 `--yes` 空跑不新增备份；每个 `.bak-dsh-<时间戳>` 只出现一次且内容等于写入前字节；PATH 上有 `claude` 也绝不调用（不花 token） |
| `real-configs` | 84（7/9 配置时 66，本机 5/9 时 48） | **拿真家伙做往返**：把本机**真实**的客户端配置复制进临时目录（18 万字节、含几百个 `projects` 条目与大小写重复键的 `~/.claude.json`，238 行的 Codex TOML，Zed 的完整 `settings.json`），注册再撤销，要求每个文件**逐字节**还原；条目是否存在按**键**判断而不是裸子串；缺少 fixture 时明确打印 `skipped`，绝不假绿（不花 token） |
| `commit-script` | 26 | 提交信息走 stdin，绝不落临时文件让 `git add -A` 卷进发布提交（不花 token） |
| `roots` | 12 | 不传 `cwd` 时通过 MCP roots 取客户端当前项目；不支持 roots 的客户端得到可操作的报错（不花 token） |
| `workspace-titles` | 18 | 家目录**与文件系统根目录**当工作区都会在 DSH 启动前被拦住；`title_hint` 与 DSH 自动标题分开返回（不花 token） |
| `package-check` | 14 | `files` 白名单、零运行时依赖、Node 下限、bin shebang（不花 token） |
| `timeout` | 40 | **超时语义**：`wait=false` 不受 `timeout_ms` 影响、`wait=true` 到期只转后台（不取消/不丢结果、`busy` 不说谎）、`timeout_ms=0` 一直等、**负 `timeout_ms` 明确报错**（不派出回合、会话照常可用）、resume 失败会作废进程而不永久卡死、空 prompt 给清晰错误 |
| `lock` | 79 | **写锁与抢占**：四类持有者判定、`writeMarker` 不覆盖活着的持有者、登记文件损坏/目录缺失等边界；**端到端**两实例抢锁 → 清晰报错 → 拒绝 → `force` 夺锁；**崩溃自动释放锁**、**卡死持有者无 force 自动抢占**；以及"一个回合 = 一个哨兵"的不变量（含内联回合与空闲插话） |
| `cycle` | 36 | **异步派活的生命周期**：异步派活 → 收哨兵 → 空闲回收 → 再派活，连做 3 轮必须全程无锁错误；贴着回收窗口立刻重派（放大竞态）；`dsh_release` 后立刻重派；并断言回收后**不留下无法归因的锁**（这条实测抓到过"刚拉起的进程被 reaper 当空闲收掉"的竞态） |
| `concurrency` | 31 | 三会话并发 + 实时增量读 |
| `capability` | 22 | 写代码、跑脚本、**自行派子代理**（用磁盘上的子会话头验证） |
| `workspace-effect` | 24 | 不给路径时工作区是否真的生效 |
| `acceptance` | 36 | 两个文件夹 × 两个会话做只读 IDA Pro 分析 |
| `multi` | 19 | **多实例共存 + 非 ASCII 路径**：复现"两实例共写注册表 → 后写的把先建的会话抹掉"，并验证**仅凭 id 就能从会话存储找回并真的派活**（指注册表丢失，不是显式 `forget` —— forget 是终态墓碑）；**兜底取回不会悄悄提权**（read-only 会话取回后仍是 read-only）；不留 `.tmp` 残渣；**中文 / emoji 工作区路径**能建会话、能干活、文件落在正确目录 |
| `permission` | 11 | ★ **权限档是否真的生效**（安全属性）：不看我们的返回值（那正是会说谎的地方），而是读**会话自己记录的事实**（投影缓存里的 `permissions.preset` / `sandboxMode`），三档逐一核对且三档记录值互不相同。**这条测试抓到过无声提权**：profile 里 `defaultPreset` 会在会话创建时盖掉 `DSH_PERMISSION_MODE` |
| `list` | 17 | **`dsh_list` 的开销**：含磁盘探测的默认调用要 spawn 一个 DSH 进程（会话多时数秒），**连续调用命中缓存**（用 `probe_cached` 判定而不是墙钟：Windows 上偶尔有一次缓存调用多出约 700ms）；`only_running=true` 与 `include_closed=false` **跳过探测**（`probe_ok=null`）且语义等价（不把磁盘上的未打开会话算进来） |
| `reasoning-check` | 8 | **思考可见性**：`reasoning=hide` 不返回思考正文但统计非零；`reasoning=full` 返回正文且渲染出思考段 |

> **2026-11-06**：`node test/run.mjs` 现在**跑完全部套件**再在末尾列出所有失败项（`--bail` 恢复遇错即停）—— 以前 `timeout.mjs` 一条过时断言就让后面 11 个真机套件全部没跑。新增 `dsh-locate`（19）；`smoke` 33、`dispatch-tools` 59、`read-cursor` 19、`workspace-snapshot` 21、`timeout` 40、`list` 17。本机离线实测（Windows / Node 22.19.0，5/9 客户端配置）：**28 个套件 1082 项全绿**。需要模型的套件已对桌面版自带运行时上的 DSH 0.2.2-rc.1 全量重跑。

**`node test/run.mjs` 在本机 7/9 客户端配置时跑 1012 项（九种齐全时 1030 项）** —— smoke 31 + 离线套件 981 项（九种齐全时 999 项）。**0.5.0 加调用方审核后全部退出码 0**（2026-11-04，Windows / Node 22.19.0；本机 5/9 配置时实测 994 项）；都不需要 provider（没有 DSH 时 smoke 自动跳过建会话段）。

其中 **542 项属于客户端注册器套件**（`setup` 45、`removal-scope` 24、`config-safety` 407、`real-configs` 66；九种齐全时 560 项）—— 0.3 的活其实都在这里。

需要模型的套件（`smoke` 31、`boundary` 46、`integration` 30、`async` 21、`sentinel` 36、`timeout` 38、`lock` 79、`cycle` 36、`concurrency` 31、`capability` 22、`workspace-effect` 24、`acceptance` 36、`multi` 19、`permission` 11、`list` 13、`reasoning-check` 8、`shared-process` 8）合计 489 项。多数最近一次完整实测在 0.3.9；与调用方审核相关的 `smoke`/`integration`/`async`/`sentinel`/`boundary` 已在本树重跑。它们要可用 provider，发版前请自己重跑一遍：`node test/run.mjs --all`。`acceptance` 在没有 IDA MCP（`mcp__ida__*`）时会明确 **skip**；`shared-process` 没有 DSH 时也会 skip。

> 三个总数是刻意分开的：`node test/run.mjs`（1012/1030）、CI 离线 job（名义 981/999，不含 smoke；hosted runner 没有客户端 fixture 时 `real-configs` 会整体跳过）、需要模型的集合（名义 489）。数字取各套件自己打印的汇总，不在这里手抄；不要把一个数字套到另一个 runner 上。

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
