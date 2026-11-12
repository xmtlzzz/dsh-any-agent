# 更新日志

本项目所有值得一提的改动都记在这里。

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

[English](CHANGELOG.md) · **中文**

> 本文是英文版 [CHANGELOG.md](CHANGELOG.md) 的中文译本，两者逐版本对应；措辞有出入时以英文版为准。
> GitHub Release 的说明取自英文版。

## [Unreleased]

### 变更

- `workspace-write` 默认拒绝越界审批。`DSH_MCP_APPROVAL` 限制调用方可请求
  的审批策略，恢复已有会话时也会应用当前上限。
- 哨兵保留期内，服务重启后仍可查到已接收的回执和幂等键。尚未执行的排队回合
  会在恢复时写出取消哨兵。
- 看门狗发出取消后，若 ACP 在宽限内无响应，服务会隔离并终止该进程，记录
  `watchdog_timeout`。同一进程中的其他回合也会中断。
- 支持 MCP `2026-07-28` 服务发现和逐请求元数据，同时兼容旧版握手。校验工具入参，
  多工作区时要求显式指定 `cwd`。宿主取消阻塞请求后，停止等待和发送进度。
- 为建会话、派活和取结果提供输出 schema。CI 验证实际安装的包，配置模型 runner 后，
  发版时用真实模型验证同一流程。

- **仓库根目录的文档少了。** 使用注意事项移到
  `docs/zh/caveats.md` / `docs/en/caveats.md`，已归档的设计草案移到
  `docs/history/design-v0.2.md`（不随包发布），`CONTRIBUTING.md` /
  `SECURITY.md` 移到 `.github/`（GitHub 照样能识别；npm 包不再带
  `SECURITY.md`）。新机器部署指引 `USAGE-MIGRATION.md` / `.en.md`
  和安装文档重复，还在讲一个早已不存在的离线安装包，所以删掉了：
  其中仍有用的内容（装完常见问题、彻底卸载）并入了 `docs/*/install.md`。
  README、官网、issue 表单和文档里的链接都已指向新位置。
- **README 跟上了 0.7.0。** 功能表写进了中断哨兵、看门狗和 worktree 隔离，
  不再说 worktree 留给 agent 自己建、或要靠外层工具；安装文档标注为支持
  10 个客户端（原来的计数漏了 Antigravity）。
- **新增中文更新日志 `CHANGELOG.zh.md`**，覆盖 0.1.0 以来的每个版本。
  发布检查会核对两份日志的版本标题、日期、顺序和版本链接。

### 官网

- **star 数不再停在旧值。** 页头的 star 徽章原先由每个访客的浏览器直接请求
  `api.github.com`；未登录的请求每个 IP 每小时只有 60 次，访客走共用的代理出口
  （或 `api.github.com` 超时）时，页面就一直显示浏览器里缓存的旧数字。
  现在由一个小 Worker（`website/src/worker.mjs`）在边缘应答 `/api/stars`：
  数字缓存 10 分钟；缓存过期时先立刻返回最近一次成功的值、再在后台刷新；
  什么都没缓存时，最多等 GitHub 2 秒。可选的 `GITHUB_TOKEN` 密钥能提高它的额度。
  其他路径照旧直接走静态资源；拿不到 `/api/stars` 时（纯静态托管、本地预览），
  页面退回直连 GitHub。
- **文案跟上 0.7.0：** 中断哨兵、常驻进程模式（`setup --daemon`）、看门狗、
  worktree 隔离、`danger-full-access` 的规则，以及 `dsh_doctor` 的新版本检查；
  "断线恢复"演示里的中断那一帧也显示了中断哨兵。
- 手机宽度下不再出现横向滚动（页脚链接原先不换行），并补上英文首页缺的一个空格。

## [0.7.0] — 2026-11-11

正在跑的回合更扛得住了。可选的常驻进程能让回合在客户端关闭或重连时继续跑
（实测：回合中途完全退出 Claude 桌面版），看门狗会停下卡住或超过上限的回合，
服务退出时被打断的回合也会拿到哨兵。哨兵有了格式版本号，并有契约测试兜底；
`dsh_doctor` 会提示 npm 上有新版本。

### 新增

- **回合看门狗。** 回合已经跑了 15 分钟、之后又连续 10 分钟没有任何进展
  （DSH 没有发来正文、思考、工具状态或用量更新），就用 `session/cancel` 取消，
  走的是和 `dsh_interrupt` 相同的路径：已有输出保留，文件不回滚，回合照常结束并写出哨兵。
  回合里还有工具在跑时，宽限放大 3 倍（长时间的 `npm install` 或测试不会发任何更新）；
  正在等调用方裁决审批时完全不判。另有一个独立的 2 小时上限（`DSH_MCP_TURN_MAX_MS`），
  它不看进展，所以一边不停输出一边打转的回合也会被停下。结果、哨兵和审核单里带
  `watchdog: {reason, …}`；`dsh_status` 显示距上次进展的时间。用
  `DSH_MCP_WATCHDOG_AFTER_MS` / `DSH_MCP_STALL_MS` / `DSH_MCP_TURN_MAX_MS` 调整，
  设 `0` 关掉对应的那一项。
- **常驻进程模式：回合不再受客户端影响（`DSH_MCP_DAEMON=1`）。**
  MCP 客户端关闭服务的方式是先关 stdin、再强杀；在 Windows 上，客户端的作业对象
  还会杀掉整棵进程树（用 Node/libuv 客户端实测，崩溃和按规范关闭两种情况都是），
  所以关闭或重连客户端会打断正在跑的回合，而且不写哨兵。设了 `DSH_MCP_DAEMON=1` 后，
  客户端拉起的进程只负责转发字节，由一个 detached 的常驻进程持有会话中枢、DSH 进程和回合；
  转发进程被杀掉，正在跑的回合照常跑完并写出哨兵。配置相同的客户端（状态目录、版本、
  `DSH_*` 与语言变量、名字以 `_KEY` 结尾的凭据变量——如 `DEEPSEEK_API_KEY` 或 profile 里
  `apiKeyEnv` 指向的变量——、`*_PROXY`，以及 `dsh-any-agent team on/off` 的设置）
  共用一个常驻进程；配置不同则各用各的，所以换了 API 钥匙的客户端（或钥匙轮换后重连的客户端）
  不会继续用旧钥匙。凭据放在其他名字的变量里不在此列：请改名，或者不开常驻模式。
  连接时必须出示一个随机令牌，令牌存在只有当前用户能读的信息文件里。没有客户端、
  也没有回合时，它在 `DSH_MCP_DAEMON_IDLE_MS`（10 分钟）后退出。常驻进程起不来时，
  转发进程退回普通的 stdio 服务。live 事件（`watch` / `dashboard`）记的是派出每个会话
  和回合的那条连接的客户端，而不是最后连上来的那个。目前默认关闭；
  `dsh-any-agent-setup --yes --daemon` 会把 `DSH_MCP_DAEMON=1` 写进客户端配置
  （不带 `--daemon` 重跑 setup 会再去掉）。常驻进程的 stderr 日志超过 10 MB 时滚动成 `.1`。
  常驻进程多占一个 Node 进程（空闲时实测约 75 MB）；DSH 进程不变。
- **可选的 worktree 隔离：`dsh_start(isolation="worktree")`。** 会话在一个新的
  git worktree 和分支 `dsh/<时间>-<随机>` 里干活（放在状态目录下，不在仓库里），
  基于主检出的 HEAD，所以调用方可以继续改原目录。主检出里有未提交的改动没带过去时，
  建会话的结果会说明。改动留在分支上由调用方合并；`dsh_release(forget=true)`
  删除干净的 worktree 并保留分支，有未提交改动的则保留。创建、检查和删除 worktree 的
  git 命令不运行仓库的任何钩子或 filter 驱动（`smudge` / `clean`），所以 Git LFS
  管理的文件在 worktree 里是指针文件。默认关闭：新 worktree 里没有装好的依赖。
- **哨兵带 `schema: 1`，公开契约有了明文。** 同一个 `schema` 内，哨兵字段只增不减；
  不兼容的改动要把它加一。兼容性文档对 MCP 工具接口也写明了同样的规则。新套件
  `test/contract.mjs` 把工具接口和哨兵字段与仓库里的快照比对，有任何差异就失败；
  `--update` 会重写快照，但哨兵有不兼容的改动却没有提升 `schema` 时会拒绝。
- **`dsh_doctor` 会提示 npm 上有新版本。** 新的 `update` 检查只在运行 `dsh_doctor` 时
  从 npm registry 读取本包的 `latest`（4 秒超时，结果在状态目录里缓存 24 小时），
  比当前运行的版本新时给出警告。离线或超时算作未知，不算问题。
  `DSH_MCP_UPDATE_CHECK=0` 关掉这个请求。
- **`DSH_MCP_SENTINEL_TOOL_INPUTS=0` 让工具输入不进哨兵。** 每个工具只保留名字、状态和
  `input_chars`，自动放行审批的摘要也去掉 `command_preview`；内存里的 `dsh_get` 仍有输入。
  安全文档新增了一张表，列出本服务写到磁盘的所有内容、保留多久以及怎么关掉。
- **`dsh_doctor` 的报告有了英文版。** 它和其他工具结果一样，跟随 `DSH_MCP_LANG`
  或系统语言。接管报告和"找不到 DSH"的报错文字仍然只有中文。
- **CI 会构建 `Dockerfile`**，并检查镜像能应答 `--version` 和 stdio 上的 MCP `initialize`。
- **可选的发布闸门。** 仓库变量 `MODEL_SUITE_RUNNER` 设为一台装有 DSH 和凭据的自托管
  runner 时，推送标签会先在打标签的提交上跑完整的需要模型的套件，再发布到 npm。
  不设的话，发布流程和以前一样。
- **Cursor 和 VS Code 一键安装。** README 里有两者的安装按钮（运行的是
  `npx -y dsh-any-agent@latest`；DSH 仍需先装好），Cursor 插件清单
  （`.cursor-plugin/plugin.json`）让本服务上架 cursor.directory，收录徽章（Glama、mcprush）
  在 README 里单独成节。

### 变更

- **等哨兵的命令，期限跟随回合上限。** 后台收据里现成的 Bash 和 PowerShell 等待命令
  原先 35 分钟就放弃，比这长的回合还在跑，调用方就被 `TIMEOUT` 唤醒了。现在它们等
  回合的最长时长再加 5 分钟（默认 2 小时 5 分；`DSH_MCP_TURN_MAX_MS=0` 时是 35 分钟）。
  看门狗在达到上限时会结束回合并写出哨兵，正在退出的服务也会写，所以现在出现
  `TIMEOUT` 就意味着服务被杀了、而且没有再启动。
- **`conversation.mjs` 拆分了。** 终态结果的构建、`dsh_read` 的输出缓冲、运行记录与
  忙碌队列、审批规则分别移到了 `run-result.mjs`、`out-buffer.mjs`、`run-ledger.mjs`
  和 `approval-policy.mjs`。行为不变。

### 修复

- **不带 `run_id` 的 `dsh_status` 和 `dsh_get` 显示真正在跑的回合。** 它们原先返回最近
  创建的那条运行记录，于是排在当前回合后面的、或者排队后又取消的运行顶替了它：
  `dsh_status` 可能在一条已取消的运行旁边报 `state: running`。现在返回正在跑的回合，
  没有的话返回最后一个开始过的。
- **用真实 DSH 时 `tools_used[].name` 有值了。** DSH 的 `tool_call` 把工具名放在
  `title` 里（`pwsh`、`read`），没有 `name`，所以结果和哨兵里每一项都是 `name: null`，
  live 审批事件的 `tool` 也一样。现在像标识符的 title 会填进 `name`，与 live 工具事件
  已有的规则相同；`read src/a.ts` 这类描述性的 title 不算，DSH 自己发了 `name` 时仍以它为准。
- **服务退出时被打断的回合现在会拿到哨兵。** 服务在回合中途停下（客户端关闭、重连或崩溃）时，
  没人给这个回合写哨兵，于是调用方的后台等待一直等到超时，`dsh_get` 还回答
  "unknown run_id"。现在服务关闭的第一步，就是给正在跑的回合写一个
  `status: "error"`、`stop_reason: "interrupted"` 的哨兵。服务被直接杀掉时，每个回合都
  留有一个 `<run_id>.running` 标记，记着服务的 PID 和启动时间；下一个启动的服务会给
  主人已经不在的标记补写哨兵（PID 被复用、但启动时间不同的算不在；启动时间未知的不算）。
  回合改过的文件不回滚。
- **`dsh-any-agent-setup --permission danger-full-access` 生成的配置能用了。** 它写入了
  `DSH_MCP_PERMISSION=danger-full-access`，但服务还要求 `DSH_MCP_ALLOW_FULL_ACCESS=1`，
  所以每次 `dsh_start` 都被拒绝。现在，客户端配置的默认档是 `danger-full-access` 时，
  就算作本机允许完全权限。只有默认档是其他档、调用方又要按会话单独开完全权限时，
  才仍需 `DSH_MCP_ALLOW_FULL_ACCESS=1`。README 和权限文档现在把信任模型讲明白了：
  本服务只负责派发，权限跟着 DSH 和所有者的配置走，能调用这些工具的人就能执行命令。
- **读取进程内存不再卡住服务。** `rss_mb` 原先来自同步执行的 `tasklist`（Windows 上每次约
  0.6 秒）或 `ps`，只要 `dsh_status`、`dsh_get`、`dsh_list` 或 `dsh_start` 构建快照时缓存
  超过 5 秒就会跑一次；这期间所有会话的 ACP 消息和审批都在等它。现在进程表改为异步读取：
  快照立刻返回缓存值、再在后台刷新，所以进程刚启动的头几秒 `rss_mb` 可能是 `null`。
  内存预算（`DSH_MCP_MAX_RSS_MB`）和 `dsh_doctor` 会等一次新鲜的读取；回收器随后会
  重新检查它选中的每个会话，读取期间开始了回合（或被用过）的会话不会被停掉。
- **`dsh_doctor` 不再把没在本版本线上验证过的 DSH 版本说成已验证。** `dsh_version` 的说明
  现在区分两类版本：当前版本线重新跑过完整套件的（0.6.x：DSH 0.2.1），和验证区间里的
  其余版本（0.1.7 – 0.2.2，最近一次完整测试是在 0.5.x 上）。两者都仍是 `ok`，
  只是措辞改了，与兼容性表一致。

## [0.6.9] — 2026-11-10

工具返回的结果现在也有英文版了，`dsh-any-agent-setup` 能注册到 Antigravity，
文档也不再描述 0.4.0 之前的空闲回收默认值。

### 新增

- **工具结果有了英文版。** 工具的返回内容现在和工具描述跟随同一个语言设置
  （`DSH_MCP_LANG`，没有则用系统语言）：每个工具的结果正文、后台与排队收据、
  审核单及其清单，以及参数错误、会话不存在和写锁冲突的报错。仍然只有中文的：
  `dsh_doctor` 的报告、接管报告，以及回合深处抛出的不常见错误。
- **`dsh-any-agent-setup` 能注册到 Antigravity。** 条目写进
  `~/.gemini/config/mcp_config.json`（`mcpServers`），Antigravity 的 IDE 和 CLI 共用这个文件。
  这个文件存在，或者 `~/.gemini/antigravity` / `~/.gemini/antigravity-cli` 存在时，
  就算装了 Antigravity——因为这个文件要等加了第一个 MCP 服务才会创建。旧版本读的是
  `~/.gemini/antigravity/mcp_config.json`；它存在而新文件不存在时，改用它。

### 变更

- **`dsh-any-agent-setup` 删掉了没有客户端在用的代码。** 通过客户端自带 CLI 注册的那条路径，
  自从 Claude Code 改为就地编辑配置后就没再用过；它和一处重复的只读检查都删了。行为不变。

### 修复

- **文档和 `dsh_release` 描述里过时的空闲回收默认值。** 好几处还写着
  `DSH_MCP_IDLE_TTL_MS` 默认是 `0`（从不回收）、`DSH_MCP_MAX_LIVE` 默认是 `8`；
  从 0.4.0 起它们分别是 10 分钟和 `4`。调用方看到的 `dsh_release` 工具描述现在写的是
  `MAX_LIVE=4`；对必须一直握着写锁的会话，文档指向 `dsh_start(keep_alive=true)`
  或 `DSH_MCP_IDLE_TTL_MS=0`。

## [0.6.8] — 2026-11-10

系统不是中文时，客户端看到的工具改为英文；每个工具都带 MCP 注解和标题；
`dsh-any-agent-setup --remove` 能把配置原样恢复成安装前的样子。

### 新增

- **每个工具都声明了全部四项 MCP 注解**（`readOnlyHint`、`destructiveHint`、
  `idempotentHint`、`openWorldHint`）。六个查询工具——`dsh_list`、`dsh_read`、`dsh_get`、
  `dsh_status`、`dsh_inbox`、`dsh_doctor`——标为只读，客户端不必再把它们当成派活或停进程的工具对待。

- **工具描述和服务说明有了英文版。** 标题、工具描述、参数描述和 `instructions` 现在跟随
  系统语言，与 `watch`、`dashboard` 已有的规则相同；设 `DSH_MCP_LANG=en` 或 `zh` 来指定。
  在非中文系统上，客户端显示的内容由中文变为英文。工具运行时返回的文字仍是中文。
- **每个工具都有 `title`，`dsh_list`、`dsh_status` 和 `dsh_inbox` 声明了 `outputSchema`。**
  只有这三个的结果形状固定；其他工具的结果随路径变化，写错了 schema 会让客户端拒收结果，
  所以不声明。
- **阻塞调用的进度通知。** `tools/call` 带了 `progressToken` 时，服务每 5 秒发一次
  `notifications/progress`，直到调用返回：已用时间、当前工具名和目前产出的字符数。
  不带令牌就什么都不发。完成仍由哨兵文件通知。
- **`server.json` 列出了客户端可能要设的环境变量**
  （`DSH_BIN`、`DSH_MCP_PERMISSION`、`DSH_MCP_APPROVAL`、`DSH_MCP_LANG`）。
- **新增 `Dockerfile`**，通过 stdio 运行服务。CI 里还没有构建过它。

### 修复

- **`dsh-any-agent-setup --remove` 把配置恢复成 setup 动它之前的样子。** 有三种情况
  原先回不去。本来就是你的空容器（例如 `"mcpServers": {}`）会和我们的条目一起被删掉，
  现在会保留。setup 自己创建的配置文件（对没装的客户端用了 `--force`）原先会剩下一个空的
  `{}` 或零字节的 `config.toml`，现在会在照常备份后删除。移除时根据安装前留下的
  `.bak-dsh-*` 备份做比对来判断。
- **从一个只剩我们条目的文件里移除条目，会把这个文件删掉。** 你手写的、只含
  `dsh-any-agent` 条目的配置也一样。删之前先留备份；setup 运行前就已经是空的文件不动。
- **Codex 的 `config.toml` 开头的 UTF-8 BOM 不再丢失。** JSON 配置一直保留着 BOM，TOML 这条路径原先没有。

## [0.6.7] — 2026-11-09

一次许可与文档版本：包里现在带着本项目起源项目的版权声明。代码没有变化。

### 变更

- **注明 dsh-any-agent 的起源项目。** dsh-any-agent 起步于
  [Moer2831/Deepseek-DSH-MCP](https://github.com/Moer2831/Deepseek-DSH-MCP)（MIT），
  在那里服务叫 `dsh-mcp`。按 MIT 许可的要求，它的版权声明现在和我们的一起保留在 `LICENSE` 里；
  两份 README 和"为什么 profile 还叫 `dsh-mcp`"的说明都写明了代码的来源。

## [0.6.6] — 2026-11-09

`dsh-any-agent-setup` 编辑 Codex 的 `config.toml` 更小心了：你的注释会保留，
多行字符串不会被截断，无法安全编辑的写法会被拒绝，而不是重复写一份。MCP 服务本身没有变化。

### 修复

- **`dsh-any-agent-setup` 不再删掉你在 Codex `config.toml` 里的注释。** 紧跟在我们那张表后面的
  注释——通常是下一张表上方的说明，或者你注释掉的某个设置——会被当成我们表的一部分，
  在 `--remove` 时删掉，`--yes` 重写过时条目时也会删。现在末尾的注释和空行都原地保留。
- **多行字符串里的一行不再被误认为表头。** `"""` / `'''` 字符串里如果有一行像
  `[mcp_servers.dsh-any-agent]`，会被从中间截断，留下一个 Codex 读不了的文件。
- **无法安全编辑的条目会被拒绝，而不是重复写入。** 如果我们的服务是手写成点号键
  （`dsh-any-agent.command = …`）或者写在内联的 `mcp_servers = { … }` 表里，`--remove`
  会把它留在原处，`--yes` 又追加第二份定义，导致整个配置失效。现在 setup 会报告这种情况，并且不动文件。

## [0.6.5] — 2026-11-09

在容易选错的地方，工具描述会说明该用哪个兄弟工具；发布流程先发 npm，再创建 GitHub Release。
运行时行为没有变化。

### 变更

- **在 agent 可能选错的地方，工具描述点名正确的兄弟工具。** 服务说明原先把
  `dsh_interject(mode='queue')` 和 `dsh_send(queue=true)` 列为可以互换，但只有
  `dsh_send(queue=true)` 会立即返回：`dsh_interject` 会阻塞到新回合结束，而且它的排队模式
  不进 `dsh_queue` 的队列。`dsh_interrupt` / `dsh_interject` 以及 `dsh_review` /
  `dsh_approval_decide` 现在开头就说明了两者的边界；`dsh_interrupt` 说明被取消的回合
  保留部分输出、不回滚文件改动；`dsh_status` 说明它读的是内存状态、不会拉起 DSH，
  并返回写锁持有者 `lock_holder`。
- **GitHub Release 要等 npm 能取到新版本后才创建。** 发布流程原先两个任务同时跑，
  Release 比 npm 上有包早公开了约 2.7 分钟；任何在新 Release 出现时重新构建的东西
  （Glama 的自动发布会运行 `npm install -g dsh-any-agent`）都可能在新标签下装到上一个版本。
  现在 npm 任务会等到版本可见，Release 和 MCP Registry 两个任务都在它之后运行。

## [0.6.4] — 2026-11-09

一次安全与可靠性版本：一次外部审计对 0.6.3 提出的每一条问题，都在真实代码路径上复现、
修复，并配了回归测试。

### 安全

- **工作区 git 快照不再执行仓库配置的命令。** `git status` 在宿主机上、DSH 沙箱之外运行，
  会执行仓库 `.git/config` 里定义的任何 clean filter——即使是只读会话。现在快照时禁用
  filter 驱动、不进入子模块；遇到无法安全覆盖的驱动名时，快照直接失败（fail closed）。
  `DSH_MCP_GIT_STATUS=0` 仍可完全关掉快照。
- **`DSH_MCP_ALLOW_FULL_ACCESS` 现在也管恢复会话。** 开关关闭时，新建 `danger-full-access`
  会话会被拒绝，但已有的会话原先仍能以完全权限恢复。
- **权限检查比对的是真实沙箱，而不只是预设名。** 原先 profile 可以定义一个叫 `read-only`、
  沙箱却是 `danger-full-access` 的预设，并且能通过校验。
- **跨盘符的 junction 不再能绕过磁盘根目录防护**（Windows）：`C:` 上指向 `D:\` 的
  junction 原先被拿去和错误的盘符比较。
- **`watch` 会过滤终端控制序列**（会话标题、工具名和预览里的），所以 OSC 52 这类内容
  无法改写显示它的终端的剪贴板。
- **旧版 `llm-deepseek.baseURL` 里的凭据不再被复制**进托管的 profile；和 `llm-pi-ai`
  一样，会去掉 `user:pass@`。

### 修复

- **对 Codex 执行 `setup --remove`** 不再删掉紧跟在我们表后面的 `[[array-table]]`，
  也不再删掉属于其他表的 `dsh-any-agent = …` 键。
- **`setup` 不再覆盖规划之后才保存的客户端配置**；它会对照当前文件重新规划。JSON 配置里有
  **重复的 `dsh-any-agent` 键**时，现在报告失败并保持文件不动，而不是报告成功、
  最后那条（过时的）条目却仍然生效。
- **DSH 发来一行格式不对的消息（`null`、数字、数组）不再让整个 MCP 服务崩溃。**
- **MCP roots**：两个并发的、不带 `cwd` 的 `dsh_start` 都会等客户端的回答；切换项目之前的
  迟到回复也不再能覆盖新的项目目录。
- **`forget` 可靠了**：写不了墓碑时它会报告失败（并保留会话）；它会取消排队中的运行，
  而不是事后再派出去；另一个活着的实例持有会话写锁时它会拒绝；任何实例都不会再给已遗忘的会话派活。
- **冷启动期间（拉起进程 + 恢复会话）的 `dsh_interrupt`** 现在真的会在发送之前停下这次运行，
  而不是报告 `interrupted=true` 却照样把提示词派出去。`dsh_interject(mode='interject')` 也修了同样的问题。
- **`client_run_id` 在长时间运行中一直有效**：正在跑和排队中的运行永远不会被挤出内存里的历史。
  两个并发的 `dsh_interject(mode='queue')` 都会运行，而不是有一个失败。
- **`workspace_changed`** 现在在回合编辑并提交了文件时为真（前后工作树都是干净的，但 HEAD 移动了）。
- **共享的 DSH 进程**：并发的调用方会等 ACP 握手完成；被拒绝的 `session/close` 不再在进程
  仍握着锁时报告会话已释放；一个停得慢的旧进程不再把宿主（以及它的新进程）从池里移除。
- **多个实例共用一个注册表时**，会保留彼此新增的条目，也不再把回合计数写回过时的值。
- 发布流程：MCP Registry 任务现在会等（最多 10 分钟）npm 能取到新版本。v0.6.3 第一次运行时，
  它在 `npm publish` 几秒后就去注册，Registry 查 npm 时还是 404。

### 变更

- 文档和官网：服务端的裸默认值是 `workspace-write`（从 0.5.0 起就是）；
  `danger-full-access` 需要 `DSH_MCP_ALLOW_FULL_ACCESS=1`。
- 测试：`npm test` 让每个套件在自己的临时根目录下运行，只在其中清理；单独运行
  `node test/cleanup.mjs` 时，除非带 `--purge-temp`，不再删除 `%TEMP%\dsh-any-agent-*` 目录。
  live 套件 `workspace-effect` 和 `acceptance` 在 `Desktop/dsh-any-agent-test-A|B`
  已存在时拒绝运行（而不是跑完后删掉它们）。

## [0.6.3] — 2026-11-08

### 新增

- **`watch` 和 `dashboard` 有了英文界面。** 两者都跟随系统语言（`DSH_MCP_LANG`，其次
  `LC_ALL` / `LC_MESSAGES` / `LANG`，再其次操作系统的区域设置），并接受 `--lang zh|en`；
  dashboard 的角落还有一个切换开关，会记住你的选择。
- **`dashboard --open`** 会在默认浏览器里打开页面。
- **上架 MCP Registry。** 新增 `server.json`，`package.json` 里加了 `mcpName`；发布流程在
  发完 npm 之后发布到官方 MCP Registry，用 GitHub OIDC 登录，运行一个固定版本、
  经 cosign 校验的 `mcp-publisher`。`check:release` 让 `server.json` 和 `package.json` 保持同步。
- **社区文件**：`CONTRIBUTING.md`、issue 表单（bug 报告会要 `dsh_doctor` 的输出）、
  PR 检查清单，以及针对 GitHub Actions 和 `video/` 的 Dependabot。
- README：CI 徽章和 dashboard 截图；官网加上了宣传片。
- `docs/en/live-view-design.md`（这份设计原先只有中文）。
- **`dsh_doctor` 检查 live 事件流。** 新的 `live` 检查报告级别、live 目录是否可写、
  里面有多少个会话、占多大空间、最后一个事件是何时写的——这样"`watch` 为什么是空的？"
  就有答案了。问题只算警告、不算失败：实时视图从不影响运行。
- **发布自动化。** `release.yml` 现在用该版本在 CHANGELOG 里的那一节生成 GitHub Release
  的说明（`scripts/release-notes.mjs`，附带安装命令和对比链接），而不是 GitHub 自动生成的一行说明；
  重跑时会更新已有 Release 的说明。第二个任务在 CI 里发布到 npm，**通过 npm Trusted Publishing
  带来源证明**（不需要 `NPM_TOKEN`），发布前先核对标签与 `package.json` 一致并跑发布闸门；
  npm 上已有的版本会跳过。需要在 npmjs.com 上做一次 Trusted Publisher 设置——见 `docs/zh/release.md`。
- **`SECURITY.md`**：如何私下报告漏洞、支持哪些版本，以及哪些在范围内、哪些不在。

### 变更

- 官网：可观测性卡片和一条新的常见问题介绍了 `watch` / `dashboard` 和 token 用量；
  GUI 那条常见问题现在把它们作为不抢写锁的看进度方式。
- **npm 包变小了**（打包后 935 KB → 约 370 KB）：维护者脚本、图片和已归档的 `DESIGN.md`
  不再随包发布；`docs/zh` 和 `docs/en` 仍然随包。仓库专用的路径一旦又进了包，`package-check` 会失败。
- `DESIGN.md` 标注为已归档的早期草案，并附上指向当前文档的链接。
- dashboard 的"文件"面板只列真正读写过的文件，不再列 `grep` / `glob` 搜过的目录。

### 修复

- 单独运行某些离线套件（`node test/dispatch-tools.mjs` 等）时，会把 live 事件写进真实的
  `~/.dsh/.dsh-any-agent/live`，结果出现在 `watch` / `dashboard` 里。它们现在用临时的
  live 目录（`test/live-sandbox.mjs`），和 `npm test` 原本的做法一样。
- `check:release` 原先只要某个版本后面还跟着别的版本，就认为这一版的 CHANGELOG 小节不是空的；
  现在它检查小节本身、能否据此生成发布说明，以及文末的对比链接。`[Unreleased]` 的链接和
  缺失的 `[0.6.1]` / `[0.6.2]` 链接已更正。

## [0.6.2] — 2026-11-08

### 新增

- **实时视图里有了 token 用量。** 新的 `usage` 事件带着这次运行的 token 增量（未命中缓存的输入、
  输出、缓存读取、缓存写入）、会话总量和上下文窗口占用，数据读自 DSH 自己的投影缓存。
  它在运行中持续更新（每 2 秒节流一次，数字有变化时才发；已对照真实 DSH 验证，DSH 每走一步模型
  都会更新总量），运行结束后再用最终数字更新一次。`watch` 显示每次运行和整个会话的总量；
  dashboard 加了一个 token 统计、每个回合上的 token 数，以及一个"Token 消耗"面板
  （输入 / 输出 / 缓存命中率、构成、上下文窗口、按回合的图表）。这些计数只是元数据，
  除了 `off` 之外的每个级别都会写。

### 变更

- **`watch` 原地重绘。** 它现在运行在终端的备用屏幕上（像 `top` 一样），只重写有变化的行，
  而不是每一帧都清屏——那样在 Windows Terminal 里每一帧都会堆进回滚区。行按终端宽度截断
  （中日韩字符算两列），整帧按终端高度截断；退出时恢复原来的屏幕。
- **dashboard：检查器栏和可滚动的回合。** 宽屏上多了一个右栏，显示选中会话的总量、
  按工具的细分、读写过的文件和审批。长回合在自己的卡片里滚动（隐藏滚动条、边缘渐隐、
  "↓ N 条"提示）；你停在底部时会跟着最新的工具走，往上翻时实时更新也不会打乱你的位置。
  页面不再限制宽度，超宽屏也能铺满。
- 查看器优先显示调用方的 `title_hint`，而不是 DSH 原生的标题（那只是第一条提示词截断后的前缀）。

### 修复

- dashboard：窄屏上 token 统计的长标签会撑宽页头、导致横向滚动；统计标签现在会截断，
  完整的 token 细分放在提示框里。

## [0.6.1] — 2026-11-08

### 新增

- **派出去的活的实时调用链视图。** 服务现在把每个会话的活动——运行的开始/结束（带派发方式：
  send、queue 或 interject，以及是哪个 MCP 客户端发的）、状态变化时的工具调用、审批及其裁决——
  追加到 `<状态目录>/live/<conversation_id>/events.jsonl`。两个新的只读子命令可以不经过调用方
  agent 直接查看：`dsh-any-agent watch`（终端树形视图）和 `dsh-any-agent dashboard`
  （`127.0.0.1` 上的本地页面，带一次性令牌和 Host 校验，没有任何控制按钮）。两者都作为独立进程
  运行，从不碰写锁，并合并所有客户端的会话。`DSH_MCP_LIVE=detail|meta|off`（默认 `detail`：
  脱敏后的预览，暴露程度与哨兵相同）以及 `DSH_MCP_LIVE_DIR`。思考内容从不写入；写入失败从不
  影响运行；文件跟随哨兵的保留期，并在 `forget` 时删除。设计见 `docs/zh/live-view-design.md`。

## [0.6.0] — 2026-11-07

### 新增

- **零配置发现 DSH，包括桌面版。** 服务现在能自己找到 DeepSeek Harness 桌面版（Windows 上通过
  `reg export` 读卸载注册表，另外在每个平台上查默认安装路径），用普通的 Node 直接从
  `resources/app.asar` 里读出 CLI 的版本和 `engines`，并用桌面版自带的 Electron 运行时以 Node
  模式（`ELECTRON_RUN_AS_NODE=1`）启动它。原先只搜索 npx 缓存和 npm 全局安装，所以桌面版已经是
  0.2.2-rc.1 时，服务却悄悄地从 npx 缓存里跑着一个过时的 0.2.1-rc.5。候选项的排序是：能运行的优先
  → 版本新的优先 → 桌面版 > npm 全局 > npx。`DSH_BIN` 仍作为显式覆盖（可以指向 `.asar` 内部）；
  新的 `DSH_RUNTIME` 覆盖启动器，既可以和 `DSH_BIN` 一起用，也可以单独用于自动发现的 npm/npx 安装
  （这时会用它重新核对 `engines.node`）；桌面版始终使用自带的运行时。
- `dsh_doctor`：`dsh_bin` 显示来源和运行时；新增 `dsh_runtime`（启动器的 Node 与 DSH 的
  `engines.node` 对比——0.2.2 需要 Node ≥ 24.9）、`dsh_desktop`（GUI 和本服务在共用的 `~/.dsh`
  上运行不同 DSH 版本时给出警告），以及 `dsh_candidates`。
- Windows 上的后台收据带有 `sentinel_read_powershell`，这条读取命令会加上 `-Encoding UTF8`
  （否则 Windows PowerShell 5.1 会读错没有 BOM 的哨兵，`ConvertFrom-Json` 遇到中文就失败）。
- `npm run lint`（`scripts/lint.mjs`，不依赖任何 npm 包）：对每个 `.mjs` 跑 `node --check`，
  检查相对导入路径能按精确大小写解析、具名导入确实是存在的导出（包括 `await import()` 解构和
  `node:` 内置模块），以及未使用的具名导入。它在每个 CI 离线单元和 Node 22.15 最低版本上第一个运行；
  `test/lint.mjs` 是它的回归套件。第一次运行就删掉了九个没用的导入。
- **文档里的测试计数是生成的，不再手工编辑。** `test/run.mjs` 会写一份机器可读的报告
  （默认 `.state/test-report.json`，可用 `--report <路径>` 指定；每个套件：通过/失败/跳过/耗时，
  外加平台、Node、DSH 和客户端夹具等上下文），每个套件都打印一行标准的汇总，
  `npm run docs:counts` 据此重写每个套件的计数、总数和 CI 的范围注释；
  `npm run docs:counts:check` 只要有一处对不上就失败。CI 离线任务对与平台无关的套件跑这项检查，
  发布清单里也有它。好几个手工维护的数字原本是错的，已更正（例如 failure-terminal 是 10，不是 11）。

### 变更

- **内部：`src/hub.mjs` 和 `src/tools.mjs` 拆成了内聚的模块**，行为不变。从 `hub.mjs` 拆出：
  `conversation.mjs`（`Conversation` 类）、`git-snapshot.mjs`、`hub-store.mjs`（meta 旁路文件和
  forget 墓碑）、`sentinel.mjs`、`workspace-guard.mjs`、`acp-session.mjs`。从 `tools.mjs` 拆出：
  `tool-defs.mjs`、`tool-render.mjs`、`doctor.mjs`。两个文件都重新导出了原先导出的每个名字，
  所以现有的导入路径照常可用。
- `model-suites` 工作流通过项目自己的 `resolveDsh()`（`scripts/detect-dsh.mjs`）来找 DSH，
  不再用 `command -v dsh`，所以只装了桌面版的自托管 runner 不需要任何密钥也能跑；
  `DSH_BIN` 仍是可选的覆盖。
- **`dsh-any-agent-workspaces --purge-test-sessions --ids …` 现在会拒绝 cwd 不是测试目录的会话**，
  即使显式点名也一样，并把它们报告为已跳过。清理还会删除测试会话的全部产物（投影缓存、注册表条目、
  哨兵、审核记录、锁），而不只是它的会话目录。
- 兼容性矩阵：DSH 0.2.1-rc.5 和 0.2.2-rc.1 为**已验证**（完整套件，2026-11-06）；0.2.3 及以上未验证。
- 服务的 `instructions` 从约 4.4k 字符精简到约 1.5k 字符，硬性规则放在最前。客户端会截断过长的说明
  （Claude Code 丢掉了旧说明的末尾，包括那些"不要"的规则）；`smoke` 现在强制 2400 字符的上限。
- `node test/run.mjs` 会跑**所有**套件，并在最后列出全部失败；`--bail` 恢复遇到第一个失败就停的行为。
  原先一个过时的断言会把它后面的十一个需要模型的套件都挡住。

### 修复

- **跑测试会在真实的 `~/.dsh` 里留下残留。** 清理测试会话时只删了它的会话目录；DSH 的投影缓存
  （`storages/session_projcache/sessions/<id>.json`）从来没删过，于是堆了约 400 个孤儿文件，
  项目自己的 `runs/`、`reviews/`、`meta/`、`locks/` 和注册表条目也都泄漏了（有八个套件把状态散放在
  `%TEMP%` 下，没有任何东西清理它们）。现在每个需要模型的套件都在自己的 `finally` 里，精确清理
  它创建的会话（以及 DSH 衍生出的子代理会话）和全部产物；`test/cleanup.mjs` 只作为兜底，同时清扫
  旧的孤儿文件。cwd 不是测试目录的会话，即使按 id 点名，清理也会拒绝；清理也不再顺带把磁盘上
  每个临时会话重新登记进 GUI 的工作区列表。新的离线套件 `residue-purge` 在沙箱化的 `DSH_HOME`
  里证明了这两方面。设了 `DSH_MCP_KEEP_EVIDENCE=1` 时，`cleanup.mjs` 会跳过整个清扫，
  所以 `acceptance` / `workspace-effect` 留着供检查的会话和状态目录能在收尾清理后保留下来。
- **`dsh_read` 把不同的工具调用合并成了一条。** 一个回合里连续的工具更新被拼接在一起
  （`read [in_progress]read [completed]pwsh …`），挂在第一个调用的 `tool_call_id` 下。
  现在每个工具调用都有自己的一条，状态更新会原地替换它；只有流式文本仍会合并，所以空回合的
  开始/结束标记也各自独立。由于原地更新可能让较早的条目拿到更高的修订号，`dsh_read` 现在按修订号
  顺序分页（同一页里的条目仍按时间顺序返回），这样较小的 `limit` 也不会跳过未读的条目；
  `gap` 按真正被挤出环形缓冲区的条目计算，而不是假设修订号沿着缓冲区递增。
- **`answer` 把消息段连在了一起。** DSH 在工具调用前后发的文字是两条消息，但汇总出的答复
  把它们直接拼在一起，没有分隔（`…where possible.1) package.json…`）。现在跟在工具调用后面的
  段落前会加一个空行（上一段已经以换行结尾时，或者在第一段文字之前，不加）；`dsh_read` 的条目不变。
- **干净的仓库是一个"0 处改动"的快照，而不是 `null`。** `null` 现在只表示"没有快照"
  （不是 git 仓库、git 不可用、被关掉）。一个撤销了最后一处改动的回合，原先会报告
  `workspace_changed=true`、`diff_stat=null`。
- **DSH 一直不应答的冷启动 `session/resume` 会重试一次。** 一次 live `test/multi.mjs` 运行曾遇到
  `ACP request timed out: session/resume`（刚拉起的 DSH 沉默了 60 秒）；重跑通过了，在约 70 次
  受控的恢复循环（其中 40 次在并发负载下）里也没有复现。写锁已经排除（DSH 用零超时的等待拿锁，
  拿不到会立即拒绝），所以看起来是 DSH 进程内部偶发的卡顿。`resume` 是幂等的，失败路径本来就会
  杀掉进程并等它退出，所以 `ensureAlive` 现在会重建进程并只重试一次——只针对超时，写锁拒绝或参数无效
  不重试，承载着其他会话的共享宿主也不重试。`AcpProcess` 的超时错误现在带 `code=ACP_TIMEOUT` 和
  `method`，超时那一刻的 DSH stderr 末尾会写进需手动开启的 `DSH_MCP_LOG_STDERR` 日志。
  新的离线套件 `resume-retry`（假的 ACP 服务）。
- 测试：`timeout` 断言负数的 `timeout_ms` 会被拒绝（0.4.0 起的行为），而不是旧的"一直等"语义，
  也不再在拿到错误结果时通过；`list` 通过 `probe_cached` 断言缓存，而不是一个 500 毫秒的
  墙钟阈值；`integration` 的排队检查用一个代码令牌，而不是要求模型逐字复述一句话；
  调用失败时，`capability` 会打印工具的报错文字，而不是一个空的 `err=`。

## [0.5.2] — 2026-11-05

### 修复

- **`workspace_changed` 不再漏掉真实的编辑。** 回合快照现在给每一条 `git status` 条目都算指纹
  （状态行 + 每个路径的大小/修改时间，未跟踪目录递归展开），而不只是前 40 行状态。已经是脏状态
  又被再次修改的文件，以及第 40 条之后的任何改动，都能检测到；`changed_files` 和 `entries`
  含义不变（`entries` 仍然只显示前 40 条）。
- **`gitStatus` 改为异步。** 回合开始/结束时的快照改用 `execFile`，不再用 `spawnSync`，
  所以大仓库的 `git status`（最长 8 秒）不再阻塞共享的 MCP 事件循环、ACP 消息、审批或其他会话。
  `busy` 仍在任何 await 之前设置；回合收尾时，仍然先释放 `busy`、唤醒等待插话的调用、安排
  排队的派发，然后才等 git，并且等结果（包括 `workspace_changed` 和审核单）完整之后才写哨兵。
- `--no-optional-locks` 改为作为 git 的**全局**选项传入（放在子命令之前）；原先
  `git status ... --no-optional-locks` 会以 129 退出，所以每次真实的快照都是 `null`，
  `workspace_changed` 永远是 false。
- **`dsh_get(max_chars)` 现在限制的是整个响应。** 这个预算原先只作用于渲染出的文本，而
  `structured.run.result` 保留着每个工具的完整输入，所以一个用了 77 个工具的回合会返回约 75K
  字符，即使设了 `max_chars=8000` 也会被 Claude Code 的单次调用上限拒收。`max_chars > 0` 时，
  结构化内容也会被压缩：答复被截断，`tools_used[]` 只保留 `id/title/name/status/kind` 外加
  `input_chars`（`run.result_compacted: true`）。`max_chars=0`（默认）不变；完整结果始终在哨兵文件里。
- **`dsh_doctor` 会标出未验证的 DSH 版本和不稳的入口。** 新的 `dsh_version` 检查按兼容性矩阵
  给 DSH 版本评级（`verified` 0.1.7 ≤ v < 0.2.0 → ok；`partial`、`unsupported`、`unverified`
  ——比如 0.2.x——或读不出版本 → warn）。DSH 解析自 npx 缓存（`_npx/<hash>/`）时，
  `dsh_bin` 会警告，因为清理缓存后它就没了。

### 新增

- **自动放行的审批看得见了。** 在 `on_approval=auto-allow` 下，每个回合的结果现在都带
  `auto_approvals_total`、`auto_escalations_total`（带 `sandbox_permissions` 的请求，例如
  `danger-full-access`）以及最多 20 条脱敏后的 `auto_approvals` 摘要（工具、提权、理由、命令预览）。
  审核单的证据和清单会点出它们，所以一个悄悄提了权的 `workspace-write` 会话，不会再看起来像
  一直守在边界内。默认值不变；要逐条把关就用 `on_approval=ask`。
- **PowerShell 版的哨兵等待命令。** Windows 上的后台收据里带有一条现成的、已转义引号的
  `sentinel_wait_powershell` 命令（正文里也有），服务说明里也写了它，供没有 Git Bash
  或 Git Bash 会卡住的宿主使用。

### 官网

- 演示：可以后退一步、连接线状态随步骤变化、哨兵回执有脉冲动画，派活的帧上有一个跨场景的
  "试试插话"操作。
- 代码片段改为一次性完成的语法高亮（带引号的键、值、注释和箭头），不再嵌套 span；新增了
  Cursor 配置标签页和复制成功的图标；`/en/` 的 HTML 会显式重新校验。
- 导航栏露出了常见问题；中英文导航的顺序一致。

### 文档

- 修正 `USAGE-NOTES.md` / `.en.md` 里创建 profile 的命令：需要
  `dsh --profile dsh-mcp --from-default-profile acp`，而且 0.5.0 起通常会自动建好 profile。
- 更正 `docs/zh/limits.md` 和架构图里团队模式的默认 profile：默认是 `dsh-mcp`；
  只有开了团队模式才用 `dsh-team`。
- 讲清楚官网 README 里的 Node.js 最低版本（构建官网需要 ≥ 22；MCP 服务本身需要 ≥ 22.15）。

## [0.5.1] — 2026-11-04

### 安全

- **拼接任何状态文件路径之前，先校验 id 是安全的路径段。** 构建哨兵、审核记录、元数据或墓碑的
  路径之前，`conversation_id` 和 `run_id` 现在都会被校验为单个路径段。含有 `/`、`\`、`:`、`..`
  或其他分隔符的值会被拒绝，而不是交给 `path.join`；这堵上了 `dsh_get` 回读哨兵时、以及
  `dsh_review` 写 `<状态目录>/reviews/<会话>/<运行>.review.json` 时的路径穿越。
- **可写档位拒绝以文件系统根目录作为 `cwd`。** 用 `workspace-write` 选 `/` 或 `C:\`，
  沙箱根目录就成了整块磁盘；符号链接的路径会在家目录/根目录防护之前先解析，所以指向根目录或
  家目录的符号链接也绕不过去。
- **`title_hint` 限制在 200 字符以内**（schema 和运行时都限制）。它在每个回合都会写进注册表
  和旁路文件；不设上限的值会成为一个稳定的磁盘/内存放大器。
- **`dsh_doctor` 检查 `reviews/` 是否可写**，和 `runs/`、`locks/` 一起。
- **MCP 工具分发只接受处理器对象自身的属性**，所以 `constructor`、`toString` 或 `__proto__`
  这类名字会被报告为未知工具，而不会碰到原型链。

### 功能

- **调用方审核（`dsh_review`）。** 现在每个完成的回合，在结果、`structuredContent`、`dsh_get`
  的输出和异步哨兵里，都带一张 `review` 审核单：一份由回合推导出的清单（工作区变了吗？正常停止了吗？
  跑了哪些工具？）、核对所需的证据，以及一个 `dsh_review` 入口。调用方 agent 可以记录
  `pass` / `partial` / `fail` 以及备注和发现；裁决原子地写进
  `<状态目录>/reviews/<conversation_id>/<run_id>.review.json`，并回写到内存里的运行和哨兵
  （这样异步的调用方不会再看到过时的 `pending`）。`fail`/`partial` 必须写理由；正在跑或未知的运行
  会被拒绝。默认是 `advisory`：审核单很醒目，但**不会阻塞**下一次 `dsh_send`，审核不通过的结果
  也不会自动回灌给 DSH。设 `DSH_MCP_REVIEW=off`（或传 `review: "off"`）可以关掉审核单。
  审核记录和哨兵一样保留 7 天、做凭据脱敏，包括从 `result.error` 插入清单的条目
  （Codex 在 #2 上的评审意见）。

## [0.5.0] — 2026-11-03

### 进程模型

- **共享 ACP 进程成为默认。** `(cwd, 权限档)` 相同的会话落在同一个 DSH 进程上：第二个会话只要约
  300 毫秒，而不是约 4 秒的冷启动；300–480 MB 的内存按组只付一次，而不是每个会话付一次。
  `DSH_MCP_SHARED_PROCESS=0` 恢复每个会话一个进程（需要硬隔离时值得这么做）。不同的工作区或
  权限档仍然用各自的进程——`dsh-base` 让沙箱根目录和审批策略在整个进程范围内生效。
- **`dsh_takeover` 不再盲杀共享进程。** 它要杀的 PID 上还承载着其他会话时，除非 `force=true`，
  否则拒绝，并把那些会话报告为 `shared_sessions`；带了 `force` 时，它会说明有多少会话跟着一起停了。
- **`dsh_doctor` 按 PID 对内存去重**，并报告共享宿主的数量，所以"活着的进程"和"内存总计"
  不再按挂在一个进程上的会话数翻倍。
- 更正了过时的注释：`DSH_MCP_IDLE_TTL_MS=0` 已经不是默认值（0.4.0 起是 10 分钟）。

### 团队模式与默认值

- **Agent Teams 改为按需开启。** `DSH_MCP_TEAM` 默认关闭。用 `dsh-any-agent team on` 开启
  （写入 `<DSH_HOME>/.dsh-any-agent/settings.json`），`team off` 关闭，`team status` 查看；
  不用改客户端配置。开启时 profile 切到 `dsh-team`，旧的子代理工具被禁用，`dsh_send` 会加上
  "需要时组建团队"那一句。
- **默认的会话权限改为 `workspace-write`**（原为 `danger-full-access`）。
  `permission=danger-full-access` 还要求本机设 `DSH_MCP_ALLOW_FULL_ACCESS=1`，所以一个不带参数的
  `dsh_start` 不再能把整台机器的写权限交给调用方。
- `dsh_doctor` 有了专门的 `team` 检查：开 / 关 / 请求了但不可用。

### 演示

- **`npm run demo`**——一个五分钟的端到端案例：建会话、用 `wait=false` 派活、跑的过程中插话两次、
  收哨兵，然后核验磁盘上的产物（包括 `node --test`），而不是相信模型自己的总结。它在隔离的
  注册表 / 哨兵 / 锁目录里运行，所以从不碰你日常用的 `~/.dsh/.dsh-any-agent`。`--replay`
  回放一份录好的记录，不需要 DSH，也不花 token；`--keep` 保留工作区。以 `demo/` 的形式随 npm 包发布。

## [0.4.0] — 2026-11-03

### 内存

- **空闲回收默认开启。** `DSH_MCP_IDLE_TTL_MS` 现在默认 10 分钟（原为 `0` = 从不回收）。
  空闲的会话会释放它的 DSH 进程，下次调用时自动恢复；写锁也随之释放。设 `0` 恢复旧的
  "永远握着锁"行为。
- **`DSH_MCP_MAX_LIVE` 默认是 4**（原为 8），按文档里每个会话 300–480 MB 算，最坏情况约
  1.2–1.9 GB，而不是 2.5–4 GB。
- **`dsh_start` 的 `keep_alive`。** 用 `keep_alive: true` 创建的会话不受空闲 TTL 和 `MAX_LIVE`
  约束；它会一直保留自己的 DSH 进程（和写锁），直到 `dsh_release`。用于"必须一直挂着"的会话。
- **全局内存预算**，通过 `DSH_MCP_MAX_RSS_MB` 设置（默认 `0` = 关）。活着的子进程内存总和超过预算时，
  按最近最少使用的顺序回收空闲会话，直到降到预算以内。`keep_alive` 的会话最后才回收。
- **`dsh_list` / `dsh_status` 报告 `rss_mb`**（以及 `keep_alive`），开销看得见，不用猜。
- **可选的子进程堆上限**，通过 `DSH_MCP_CHILD_MAX_OLD_SPACE_MB` 设置（默认 `0` = 关）。它把
  `--max-old-space-size=<n>` 追加到子进程的 `NODE_OPTIONS`，不会覆盖已有的选项。
- **实验性的共享 ACP 进程**，通过 `DSH_MCP_SHARED_PROCESS=1` 开启。`(cwd, 权限档)` 相同的会话
  共用一个 DSH 进程；ACP 支持在一条连接上并发多个会话，DSH 给每个会话一个独立的 Agent。
  在 DSH 0.1.7 上实测：两个会话 → 一个 PID，第二次 `session/new` 只用了约 300 毫秒，而不是约 4 秒。
  之所以要求 `(cwd, 权限档)` 相同，是因为在 `dsh-base` 里 `sandbox-policy.workspaceRoot`/`mode`
  和 `approval.policy` 是进程级的。代价：进程一崩溃，整组会话都会停；宿主会给每个进行中的运行写
  错误哨兵，每个会话在下次调用时恢复。

### 派发能力

- **`dsh_inbox`**——跨会话的审批收件箱。`dsh_status` 仍然只看单个会话；这个工具列出所有待决的
  审批，带会话 id/标题、审批 id、工具、理由、输入、选项和等待时长。
- **`dsh_send` / `dsh_interject` 支持 `client_run_id` 幂等**：用同一个键重复提交，会返回第一次的
  运行（`replayed=true`），而不是再建一个。这个键会写进哨兵，并和运行记录一起被淘汰。
- **会话队列**，通过 `dsh_send(queue=true)`（需显式开启；会话忙时的默认行为仍是"报错"），
  外加 **`dsh_queue`** 用于列出/移除/修改/提前。哨兵只在终态时写；移除一个排队项会写一个
  `cancelled` 哨兵。
- **`dsh_get` 的文本预算**：`max_chars` 只截断渲染出的文本（结构化内容保留完整结果），并报告
  `answer_truncated` / `next_offset`。
- **`dsh_doctor`**——只读的健康检查：DSH 程序/版本、profile 是否存在/是否漂移、状态文件、
  `runs`/`locks` 是否可写、孤立的锁持有者、会话/内存总计、生效的配置。
- **可选的元数据审计**，通过 `DSH_MCP_AUDIT_FILE` 开启：为 start/send/queue/interject/interrupt/
  approve/release/takeover 写 JSONL 记录。它只记 ID、裁决和计数——从不记提示词、答复、思考或工具输入。
  超过 10 MB 时滚动。
- **`resolveDshBin` 优先选缓存里最新的 DSH**，而不是它找到的第一个目录。这台机器上同时缓存着
  0.1.5 和 0.1.7；选了 0.1.5 就悄悄地藏起了实验性的 Agent Teams 包。
- **README 的定位一节**：本服务是派发层，不是能力聚合器；DSH 自己管它的工具/技能/团队，按需派发。

### 团队模式

- **Agent Teams 默认开启**（`DSH_MCP_TEAM=1`）。默认 profile 现在是 `dsh-team`，从同一个路由来源
  自动创建，带 `@deepseek-ai/dsh-experimental-agent-team` +
  `@deepseek-ai/dsh-experimental-tool-agent-team`；旧的 `subagent` 工具被禁用，与官方团队 profile
  层一致。需要 DSH `>= 0.1.7-0`（这些包随 0.1.7-rc.1 发布）。
- `dsh_send` 会在调用方的提示词前面加一句简短的"需要并行或多角色时组建团队"；简单任务不会被
  强制组队。`dsh_send(team=false)` 对单次调用关闭它；`DSH_MCP_TEAM=0` 回到 `dsh-mcp` 并关闭这句注入。
- 选中的 profile 里实际没有团队包时，`TEAM_ACTIVE` 为 false，所以显式把 `DSH_MCP_PROFILE`
  指向一个非团队 profile 时，不会注入一个 agent 用不了的工具。
- **切换**：`DSH_MCP_TEAM=0` 回到 `dsh-mcp` 并关闭注入；`dsh_send(team=false)` 对单次调用关闭；
  `DSH_MCP_PROFILE` 仍优先于默认 profile。`dsh_start` / `dsh_doctor` 会报告生效的团队模式和 profile。

### 正确性

- **`ensureAlive` 失败时有了终态。** 它会唤醒每个 `dsh_interject` 的等待者，写一个 `error` 哨兵，
  并在抛出的错误上附带 `runId`/`status`/`sentinelFile`。原先在写锁冲突/冷启动窗口里到来的插话
  可能会一直等下去（`timeout_ms=0` 没有定时器）。
- **`dsh_approval_decide` 报告实际的结果。** `decideApproval` 返回
  `effective: 'selected' | 'cancelled'`（以及 `reason: 'no_option'`）；当 ACP 实际收到的是
  `cancelled` 时，工具的文字不再声称"已按允许裁决"。
- **`dsh_get` 能从哨兵里读回运行。** 内存里没有时，它读 `RUNS_DIR/<会话>/<run_id>.json`，
  返回 `run.source='sentinel'`，并始终带上 `sentinel_file` / `sentinel_file_posix`。
- **修复了回收/重新拉起之间的竞态。** `stop()` 会被登记为 `recycling`，只有确认子进程已经退出后
  才清空 `proc`，所以并发的 `dsh_send` 会等待，而不是对着一个还没释放的写锁拉起新进程。
  `lastChildPid` 只在恢复成功后才更新，所以恢复失败不再丢掉上一代进程留下的接管线索。
- **`timeout_ms` 会被校验。** 非有限值或负数现在会报错，而不是悄悄变成 `NaN` 或立刻返回后台收据。

### 测试

- 新增 `failure-terminal.mjs`（插话唤醒 + 错误哨兵 + 审批的实际结果 + 从哨兵读回）。
- 新增 `shared-host.mjs`（会话路由、退出时的扇出通知、引用计数式回收、内存辅助函数）。
- 新增 `shared-process.mjs`（真实 DSH 的共享进程；没有 DSH 时跳过）。
- 新增 `dispatch-tools.mjs`（`dsh_inbox`、`client_run_id` 幂等、会话队列操作、`dsh_get` 文本预算）。
- `guards.mjs` 和 `smoke.mjs` 按新的默认值和 `keepAlive` 元数据字段做了更新。

## [0.3.9] — 2026-11-02

### 安全 / 健壮性

- **UTF-8 流的分帧不再丢字。** MCP 和 ACP 现在共用一个基于 `StringDecoder` 的 `LineDecoder`，
  所以被拆在两个数据块之间的多字节中文/emoji 字符，不会再悄悄变成 U+FFFD。输入的提示词和
  DSH 的输出都覆盖到了。
- **同一个磁盘会话被并发认领时会去重。** `Hub.get` 现在对每个 id 共用同一个进行中的
  `findSessionHeader`/认领 promise，并重新检查注册表，避免出现两个 Conversation 对象
  （以及随之而来的、无从回收的子进程/写锁泄漏）。
- **`read-only` 的运行时校验失败即拒绝（fail closed）。** 它最多等约 10 秒（覆盖 DSH 投影缓存的
  落盘窗口）；拿不到记录的权限时，调用会被拒绝，而不是依赖一个在危险沙箱下可能根本不会触发的审批层。
- **子进程 PID 变化时会重置 `spawned_at`。** PID 复用防护不再拒绝对一个合法重启的子进程的接管。
- **会话头读不出来时，`forget` 墓碑会保留。** 读会话头分三种状态（找到 / 不存在 / 出错）；
  只有会话文件确实不存在时，才会清理墓碑。
- **`DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 不再关掉脱敏。** 思考内容会保留，但答复、报错、标题和
  工具输入仍会清洗。
- **`close`/`releaseAll`/`shutdown` 会保留锁登记，直到确认子进程已死。** 停止超时时登记会保留，
  这样接管时仍能认出这个孤儿进程；子进程还活着时，`forget` 会被拒绝。
- setup 会保留目标文件的权限位（例如 0600），遇到无效的 `--permission` 以退出码 2 拒绝。
- `restore --latest` 会排除它自己留下的 `pre-restore-*` 安全副本，所以连续运行两次不会再撤销第一次的还原。

### 行为

- `workspace_changed` 改为比较 git 状态条目的快照，而不是对象身份；输出现在说"工作区状态有变化"，
  而不是声称一个按回合统计的文件数。
- 标记指向的子进程已经死了时，`dsh_takeover` 优先使用一个还活着的 `known_child_pid`。

### 官网

- 手机端导航始终露出语言切换；页脚也有一个语言链接。
- `hero.jpg` 和 `favicon.svg` 带上了内容哈希；所有 `/assets/*` 都可以设为永久缓存。
- 浅色主题里次要/暗淡/强调色调深了，在它们所处的背景上满足 WCAG AA。

### 文档 / 测试

- README/中文 README/USAGE-MIGRATION：workspace-write 的审批语义、setup 默认的 `workspace-write`、
  Zed 的 `context_servers`、英文版的 npm 发布步骤、当前的路由/限制链接。
- 新增 `line-decoder` 套件（4 项），扩充了哨兵脱敏（19）、墓碑清理（10）、权限认领（17）、
  状态/锁安全（26）、沙箱防护（21）、setup（45）、配置安全（407）。离线合计 843 / 879
  （九个客户端夹具时）；官网 29 项。

## [0.3.8] — 2026-11-02

### 变更

- 本机没有 DSH 时 `npm test` 也能跑了：smoke 仍会检查握手和工具表，然后跳过依赖会话的部分，
  而不是失败，所以所有离线套件都会运行。`npm run test:all` 是显式的全量入口。
- 新增 `model-suites` 工作流，供装有 DSH 和 provider 凭据的自托管 runner 使用；托管 runner 会
  明确打印"已跳过"。
- 新增英文版 `USAGE-MIGRATION.en.md`，并在英文 README 和 `/en/` 的安装一节里链接了它。

### 测试

- 删掉了剩下的恒为真的 `check(..., true)` 断言；清理相关的检查现在断言实际的释放/遗忘结果或超时状态。
- `prune` 在隔离的 `DSH_HOME` 下运行，碰不到真实的墓碑。
- 为两种语言新增 8 项静态可访问性测试（算上已有的 site/release/demo 套件，官网共 28 项测试）。
- `readHeaderAsync` 现在用 `StringDecoder` 处理多字节 UTF-8 的边界。

### 官网

- `robots.txt` 现在完整镜像 Cloudflare Managed 的爬虫列表，而不只是最常见的四个 bot。

## [0.3.7] — 2026-11-02

### 修复

- **查找会话头不再阻塞事件循环。** `Hub.get()`、`Hub.load()` 和 `pruneStaleTombstones()`
  现在用流式的 `readHeaderAsync()`，读到第一个换行就停，带 5 秒超时和 1 MiB 的会话头上限。
  恢复一个未知会话时，大的会话日志不会再卡住 MCP 请求、心跳续期或审批处理。同步读取器只留在显式的
  工作区 CLI/测试清理路径里。
- **官网的 robots 策略镜像 Cloudflare Managed 的内容。** 生成的 `robots.txt` 现在写明
  `Content-Signal: search=yes, ai-train=no`，并禁止 GPTBot/ClaudeBot/Google-Extended/CCBot，
  这样非 Cloudflare 的主机和仓库都与线上策略一致。
- 官网测试现在覆盖英文页面、robots 策略、hreflang、CSP 哈希和双语页面（20 项测试）。

## [0.3.6] — 2026-11-02

0.3.5 之后的加固（完整性审计剩下的条目）。

### 修复

- `dsh_status` 现在报告 `lock_holder_reason`，会话只是空闲/已释放时，不再把 `none` 说成
  "你的 GUI"；只有真的发生写锁冲突后，才显示 GUI 相关的提示。
- `dsh_get` 报告 `title_source`（`native` / `title_hint` / `null`），不再把退回用的 `title_hint`
  标成"DSH 生成"。
- `dsh_read` 把单条输出限制在 20 万字符（保留末尾），一个失控的工具输出不能让内存缓冲无限增长。
- `dsh_list` 暴露 `probe_ok` / `probe_error` / `probe_cached`；磁盘探测失败不再和"没有会话"分不清。
- 发送 `notifications/roots/list_changed` 的 MCP 客户端，现在会让缓存的项目目录失效并重新请求
  `roots/list`。
- 客户端配置的备份会轮转（默认每个文件保留 20 份，`DSH_MCP_BACKUP_KEEP`）；
  `dsh-any-agent-restore` 原子写入并保留目标文件的权限位。
- 共享的 `workspace.json` 写入器在替换前，会保留一份 `<file>.bak-dsh` 作为最后一次正常的副本。
- `dsh_takeover` 在发 SIGKILL 之前，会比对子进程在操作系统里的启动时间和登记的时间；
  PID 对不上（被复用）时拒绝。
- 官网：`/en/` 上完整的英文页面、hreflang 互指、双语 sitemap、JSON-LD、CSP 里加入
  Cloudflare Insights 的域名，以及一个首屏前执行的主题脚本（CSP sha256），浅色系统的用户
  不会再先看到一闪而过的深色页面。

### 已知遗留

- Cloudflare Managed 的 robots.txt / Content Signals 在控制台里管理；仓库把两者的分工写成文档，
  而不是试图覆盖它们。
- 会话日志头的解压仍是同步的；因为只解析会话头，影响有限，但一个非常大的日志仍可能短暂阻塞事件循环。
  完全异步的读取器需要对 `Hub.get`/`findSessionHeader` 做更大范围的重构。

## [0.3.5] — 2026-11-02

完整性审计的后续。先处理数据安全和权限边界，再处理文档/CI 的真实性。

### 安全

- **认领外部会话时，权限未知就退到 `read-only`（fail closed）。** 原先投影缓存里没有权限记录时，
  会退回 `danger-full-access`。
- **运行时回读权限。** 在 `session/new` 以及每次 `session/resume` 之后，回读会话自己记录的
  `permissions.preset`；对不上时（例如 profile 里的 `defaultPreset`）调用失败，而不是悄悄提权。
  `dsh_get` 暴露 `permission_verified`。
- **如实写明 workspace-write 的语义。** 工作区之外的请求默认自动放行；要逐条裁决就传 `on_approval=ask`。

### 修复

- **临时路径前缀的 bug 可能删掉真实会话。** `isTempPath` 现在按路径段比较，所以
  `tmpdir()+'Suffix'` 和 `/tmpfoo` 不会再被当成系统临时目录。自动清理只删除测试创建的会话
  （`tmpdir()/dsh-any-agent-*` 和桌面上的测试文件夹）；`tempOnly` 仍是一个需显式指定的手动开关。
- **`setup` 不再调用 `claude mcp get`。** 这个探测会让 Claude Code 重写 `~/.claude.json`
  （丢掉 `projects[*].history` 并增加键）。
- **首次启动时的 profile 引导在发布的包里也能用了。** 未声明的 `js-yaml` 依赖换成了内置的 YAML
  子集解析器（`src/yaml-lite.mjs`）；生成的 profile 包含三个权限预设，但从不写 `defaultPreset`。
  路由里没有默认 provider/model 时，给出一个可操作的报错，而不是写出一个空的 `acp` 配置。
- **状态/哨兵/锁的存储移到 `$DSH_HOME/.dsh-any-agent`。** 旧的包内 `.state` 位置会迁移一次
  （包括元数据旁路文件）。目录不可写时启动会明确失败，哨兵写入失败会以 `sentinel_error` 暴露出来。
- **损坏的 `workspace.json` 不再被一个空文档覆盖**；register/prune 报告错误，并保持文件逐字节不变。
  每个写入者的临时文件名都不同。
- **`defaultLaunch` 使用 `fileURLToPath`**，安装路径里有空格或非 ASCII 字符时，不再被百分号编码。
- **`release(all=true)` 默认跳过忙碌的会话**（传 `force=true` 才会打断它们）；插话超时的描述与
  忙碌路径的行为一致了。
- 数值类环境变量的防护：负的哨兵 TTL 不再删掉所有哨兵；空的权限/思考深度值退回默认值。
- `ACP clientInfo.version` 现在取自 `package.json`。

### 测试

- 新的离线套件：`bootstrap-profile`、`workspace-safety`、`permission-adopt`、`state-safety`
  （共 81 项检查）。`package-check` 纳入 `node test/run.mjs`；`acceptance` 纳入 `--all`
  （没有 IDA 时自动跳过）；`reasoning-check` 现在会断言，而不只是打印。
- CI 跑所有离线套件以及官网的构建/测试；SCOPE 注释和 README 里过时的计数已更正
  （五个客户端夹具时 815 项，九个时 851 项；CI 离线 786/822）。

## [0.3.4] — 2026-11-02

只改文档的版本。没有运行时代码变化；这一版发布更新后的 README（Star History、更正后的 setup 措辞）
和官网源码，让 npm 包页面与仓库一致。官网单独部署在 <https://dsh-any-agent.xmtlz.dev/>。

### 变更

- README / README.zh：加入 Star History 图表，并保留实测的 setup 影响范围说明。
- 官网：发布版本号在运行时从 npm 读取（回退到 GitHub release/tag），而不是构建时写死；
  CSP 放行这些端点；canonical 和 Open Graph 的 URL 用公开域名。
- 官网措辞现在写明：把模型路由复制进 ACP profile 需要一个 YAML 解析器（js-yaml）、外部 MCP 服务
  在 DSH profile 里配置、`setup --yes` 写入的是绝对的 node/入口路径外加环境变量。

## [0.3.3] — 2026-11-02

一次针对 0.3.2 MCP 接口的对抗式审计，发现了一个可以被绕过的安全边界，以及好几处实现与文档不一致的地方。
这一版把它们都堵上了，每一处都有回归测试。

### 安全

- **`read-only` 现在是一道硬边界。** `dsh_start` 拒绝 `permission=read-only` 与
  `on_approval=auto-allow`/`ask` 的组合，审批层也会拒绝只读会话的每一个权限请求。原先 DSH 可以请求
  `sandbox_permissions` 提权，宽松的策略会放行写操作，而会话记录上还写着 `read-only`。

### 修复

- **`dsh_read` 不再丢失流式文本。** 游标是一个修订号：已读条目被追加了文字时会再次返回，
  所以轮询的调用方能看到消息剩下的部分。`limit` 被限制在 1..500。
- **`dsh_release(forget=true)` 是终结性的。** 它在 `$DSH_HOME/.dsh-any-agent-forgotten` 下写一个墓碑；
  按 id 查找会失败并给出恢复办法，列表里不再出现这个会话，过时的墓碑在启动时清理。
- **失败的 `dsh_start` 不再留下写锁标记。** 原先 provider/model 无效后，它会作为孤立的持有者出现。
- **真实的审批上下文。** 权限请求的 `toolCallId` 会和之前的 `tool_call` 更新关联起来，所以
  `pending_approval_details` 带的是命令和理由，而不是一个看不懂的 id。
- **哨兵会按审批的凭据规则对工具输入脱敏**，`thinking_omitted` 始终是布尔值。
- **空提示词会同步失败**，而不是给一个马上就会出错的回合返回一张"已接受"的收据。
- **`dsh_start` 拒绝未知的 provider/model**，而不是悄悄退回 profile 的默认模型。
- **回合结束或会话关闭时，待决的审批会被取消并清掉。**
- **`queue` 模式的插话遵守 `timeout_ms`**（0 = 一直等）。
- 测试：`read-cursor`、`sentinel-redaction` 和 `forget-tombstone` 回归测试；`real-configs` 检查
  条目的键，而不是一个裸子串；测试收尾只删除它自己创建的会话 id；没有配置 IDA MCP 时，
  acceptance 会明确跳过。

### 变更

- `dsh_read` 的游标语义：条目的文字变长时会再次出现；按 `seq` 匹配并替换文字。
- 文档现在写明 **DSH 自己的会话日志里有思考内容**（即使是 `reasoning=hide`）；"从不落盘"的保证
  只覆盖本服务的日志、哨兵和注册表。
- README 链接了官网 <https://dsh-any-agent.xmtlz.dev/>，并记录了九个受支持客户端的实测配置影响范围。

## [0.3.2] — 2026-10-30

两处修复和一个功能，都是在 Claude Code 里实际驱动这个服务时发现的，而不是读代码读出来的。

### 新增

- **`cwd` 变为可选，默认是客户端当前打开的项目。** 客户端早就知道用户在哪个文件夹里干活，只是没人问它。
  `initialize` 现在会记下客户端的 `roots` 能力，不带 `cwd` 的 `dsh_start` 会发一次 `roots/list`
  请求，并把返回的 `file://` URI 转成路径。"DSH 在客户端看着的地方干活"成了默认行为，这也去掉了
  手工拼路径时最常见的落到家目录的情况。不声明 roots、或者没有及时回答的客户端，会拿到一个可操作的
  报错，里面举了一个 `cwd` 的例子——它从不猜目录。服务对象上暴露了 `projectDir()`，供需要原始值的调用方使用。
- **拒绝把家目录作为工作目录，并说明原因。** DSH 自己的 ACL 沙箱要求它的临时目录在工作区*之外*。
  Windows 上 `%TEMP%` 是 `C:/Users/<name>/AppData/Local/Temp`，在家目录里面，所以
  `cwd: C:/Users/<name>` 会让第一条 shell 命令以 `Windows ACL: temp root must be outside the workspace`
  失败——离真正原因隔了好几层，很容易被误以为是安装坏了。现在这种组合会在一开始就被拒绝，并给出两条出路：
  换一个更具体的项目目录，或者用 `permission=read-only` / `danger-full-access`。
- `snapshot()` 在 `title` 旁边返回 `title_hint`。DSH 自己的标题是第一条消息截断后的前缀
  （13–15 个字符，例如 `这是一次连通性冒烟测试，请`），GUI 显示的就是它。`title` 不变——它仍是 GUI 读取的
  字段，这样两边一致——提示单独返回，而不是替换掉它。

### 变更

- `title_hint` 的工具描述现在说清楚了实际会发生什么：显示时以 DSH 生成的标题为准，提示和它一起返回，
  而不是含糊的"作为后备显示"。

### 测试

- `test/roots.mjs`——在真实的 stdio 握手上做 12 项检查：客户端声明了 roots 时服务会发 `roots/list`；
  回答的 root 成为工作目录；不支持的客户端拿到可操作的提示；显式给出一个不存在的 `cwd` 时仍能干净地报错。
- `test/workspace-titles.mjs`——15 项检查：家目录防护对大小写不敏感和末尾分隔符的处理（只在文件系统
  真有这些特性时才断言）、`read-only` 仍然允许，以及两个标题字段不会互相覆盖。
- 十一个套件共 660 项离线检查，在 Ubuntu 和 Windows 的 Node 22 与 24 上全绿。

## [0.3.1] — 2026-10-30

0.3.0 可能会覆盖用户特意设成只读的客户端配置。这个问题是 Linux 上的 CI 抓到的，Windows 上没抓到——
这正是它有意思的地方。

### 修复

- **在 POSIX 上，只读的配置会被悄悄替换。** 写入走的是"先写临时文件、再 `rename`"，而 `rename`
  只要求*目录*可写，不要求目标文件可写。所以一个 `chmod 444` 的 `~/.codex/config.toml` 会被当作
  没有只读位一样替换掉。Windows 上对只读目标 `rename` 会返回 EPERM，所以同样的代码在 `windows-latest`
  上通过、在 `ubuntu-latest` 上失败；这个 bug 其实在 0.3.0 里一直都在。现在写入前用 `access(W_OK)`
  检查可写性，两个平台都会拒绝。
- **`--force` 原先根本没有覆盖任何东西。** 它被解析了、写进了文档，却既没有传给只读检查，也没有传给
  写入器。现在它会清掉只读位、写入，并**恢复原来的权限**——经过验证，不会留下一个权限被悄悄改掉的文件。

### 变更

- 当前身份无法写入的文件，报告为 `config file is read-only, refusing to overwrite it (use --force to
  override)`，而不是笼统的写入失败，也不会留下备份或临时文件。

### 测试

- 九个套件共 633 项离线检查，在 Ubuntu 和 Windows 的 Node 22 与 24 上全绿。只读那一节现在断言：
  拒绝写入、文件不动、没有残留的临时文件，以及 `--force` 既会写入*又会*恢复权限。在权限位确实不生效的
  主机上，仍以 root 身份跳过。

## [0.3.0] — 2026-10-30

**对配置的影响，现在是一个有边界、可审计的性质。** 把本服务注册到九个 MCP 客户端中的任何一个，
每个客户端都只改动恰好一个条目，别的什么都不动——包括带注释、CRLF 行尾、BOM，或有仅大小写不同的键的配置。
`package.json` 报告 `0.3.0`；`dsh-any-agent --version` 和 `dsh-any-agent-setup --version` 都会打印它。

### 新增

- **九个客户端，原先是五个。** `dsh-any-agent-setup` 现在能检测并注册到 Claude Code（`claude-code`）、
  Claude Desktop（`claude-desktop`）、Codex（`codex`）、Cursor（`cursor`）、Windsurf（`windsurf`）、
  Zed（`zed`）、Gemini CLI（`gemini`）、opencode（`opencode`）和 VS Code（`vscode`）——这些 id 就是
  `--only` 和 `--json` 输出里用的。没装的客户端仍然跳过，从不算失败。
- **每个客户端的配置形状都按它自己的方式正确写入，而不是一刀切。** VS Code 把 MCP 服务放在 `servers` 下
  （不是 `mcpServers`）；opencode 接受一个 `command` 数组（`{ type: "local", command: [exe, ...args],
  enabled: true }`），而不是分开的 `command`/`args`；Zed 用 `context_servers`；Codex 写两个
  `[mcp_servers.dsh-any-agent]` 段。Claude Code 现在和其他 JSON 客户端一样被编辑——对
  `~/.claude.json` 做文本级的 `mcpServers` 编辑，写一个 `type: "stdio"` 的条目——而不是通过
  `claude mcp add` 注册。
- **一个不构造值对象的 JSON 扫描器。** `~/.claude.json` 里确实有一个 `projects` 映射，键只有大小写不同
  （`.../Rust` 挨着 `.../rust`），这就足以让一个朴素的 `JSON.parse` 出问题；整个文件重写会毁掉用户的
  项目列表。扫描器把文本解析成一棵字节区间树（容忍注释和末尾逗号，因为 Zed 和 VS Code 的配置允许它们），
  所以那些大小写冲突的键从来不会被实体化——只动我们自己那个条目的区间。
- **JSON 写入现在是文本级的：只就地重写恰好一个条目。** 早先的版本会把整个文件重新序列化，值保住了，
  格式却没保住。现在 setup 在已有文本里找到自己的条目，只替换那一段，所以缩进（2 空格、4 空格、制表符）、
  键序、CRLF 行尾、UTF-8 BOM 以及缺失的末尾换行，除了那个条目本身，都逐字节保持原样。
- `--json`——**stdout 只有一个可解析的对象，别的什么都没有；所有给人看的行都移到 stderr。**
  形状：`{ ok, mode, clients: [{ id, label, path, status, summary, error? }], changed, skipped, failed }`，
  其中 `mode` 是 `plan`、`apply` 或 `remove`。这种分离就是契约——调用方可以把 stdout 直接交给 JSON 解析器。
  退出码仍然报告失败（`0` / `1`）。
- `--home <dir>`——让 setup 指向一个沙箱（或任意）家目录，而不是真实的 `HOME`/`USERPROFILE`/`APPDATA`，
  这样注册、重新注册和移除都能演练，而不碰正在用的配置。
- `--force`——恰好两个作用：创建缺失的目录或文件（默认也会这么做；这个开关让它在自动化场景下、
  以及客户端本身没被检测到时也靠得住），以及覆盖一个形状不符合本程序预期的同名条目。它从不删除别的条目，
  也从不跳过校验。

### 变更

- **影响范围现在作为一个性质来陈述，而不是一句承诺。** 对每个客户端，setup 写入一个名为
  `dsh-any-agent` 的条目，`--remove` 删除的恰好就是这个条目。文件里别的东西都不会被重新序列化、
  重新缩进或重新排序。
- **Codex（`config.toml`）按行编辑。** 其他 `[tables]`、它们的注释、顶层键（`model`、`approval_policy`、
  `sandbox_mode`）和 CRLF 行尾都原样保留；`--remove` 会把文件恢复原状。
- **`dsh-any-agent-restore`**——配合备份使用的 CLI。setup 和移除都会留下操作前字节的
  `<file>.bak-dsh-<stamp>` 副本，但只有找得到正确的那份、还能放回去，备份才有用：`--list` 按从新到旧
  列出所有副本，`--latest` / `--stamp` / `--file` 还原其中一份，`--dry-run` 预览。还原前会先把当前文件
  备份为 `.bak-dsh-pre-restore-<stamp>`，所以误还原本身也能撤销。`test/config-safety.mjs` 里有 9 项检查
  覆盖它，包括恢复一个故意损坏的配置。
- **备份不会再互相覆盖。** 同一毫秒内的两次运行会产生同一个文件名，第二份副本会悄悄替换掉第一份——
  而被替换的那份可能正是唯一值得回去的状态。现在名字冲突时会加上 `-2`、`-3` 后缀。
- **会报告备份的路径。** `--json` 给每个客户端加了一个 `backup` 字段，给人看的输出在每个写入的条目下面
  打印 `backup: <路径>`；在此之前，备份是建了，但你得去猜它在哪。
- **每次写入前都备份**：`<file>.bak-dsh-<时间戳>`，每次运行每个文件一份，保存写入前的原始字节。
  预览不会留下备份。
- **在七份真实配置上实测，而不是夹具。** 注册时每个客户端恰好增加一个 `dsh-any-agent` 条目，并保留了
  所有原有的行——注释、CRLF 行尾、一份 238 行的 Codex 配置、182693 字节的 `~/.claude.json`——
  随后的 `--remove` 把七个文件都逐字节恢复了。
- **往返测试在真实的家目录上跑过，并且先做了备份。** 在把七份配置都备份之后，对开发机上的真实配置
  先执行 `--yes`、再执行 `--remove --yes`。移除被验证为注册的严格逆操作：用同一个编辑引擎从备份里拿掉
  我们那一个条目，必须逐字节得到当时磁盘上的文件。七份全部一致。其他 MCP 服务逐字段没有变化
  （Cursor 里仍有 stitch / obsidian-mcp-server / codegraph / rea），Zed 仍有全部 32 个顶层设置键，
  `~/.claude.json` 仍能解析，67 个顶层键、60 个项目条目以及两个仅大小写不同的重复键都还在。
  之后 `codex mcp list` 能正常读取文件，所以不需要任何手工修复。
- **对已有条目的一处有意的改动**：因为启动命令取决于 setup 在哪里运行，从这个检出注册时，把 Cursor
  原有条目里打包的 `node/node.exe` 换成了系统的 `node.exe`。那是我们自己拥有的那一个条目；
  没有碰任何别的服务。
- **预览模式是一个硬保证，而不是一份报告。** 不带 `--yes` 时什么都不写，也不启动任何会写入的子进程。
  Claude Code 那条路径原先会调用 `claude mcp add`，它会立即写入——更糟的是，它会按自己的格式重写
  `~/.claude.json`，而且没有我们能还原的备份。现在它和其他客户端一样是文本级编辑，预览纯粹是读取：
  根本不调用任何 CLI。
- **`claude mcp get` 只用作只读的确认。** 恰好装了 `claude` CLI 时，写入完成后会跑一次 `claude mcp get`
  探测，摘要里写 `(confirmed by claude mcp get)`；如果客户端还没读到这个条目，摘要会如实说明。
  这个探测从不写入。
- README（两种语言）：一张按客户端列出的表，写明配置文件路径，以及安装 / 更新 / 移除 / 撤销分别动了什么，
  取代了旧的"JSON 会被重新序列化"的说明。
- `test/sandbox-home.mjs` + `test/sandbox-guard.mjs`（18 项检查）——测试沙箱再也不能指向真实的用户数据。
  防护会拒绝真实的家目录、它的子目录、大小写变体、文件系统根目录，以及 `os.tmpdir()` 之外的任何路径；
  `setup` 和 `removal-scope` 现在只通过这个模块创建和销毁它们的 HOME，一旦又直接调用
  `mkdtempSync`/`rmSync` 就会失败。
- `test/removal-scope.mjs`——24 项检查，证明注销只动它自己的条目。给定包含无关 MCP 服务、Codex 顶层设置
  （`model`、`approval_policy`、`sandbox_mode`）和 Zed 设置（`theme`、`vim_mode`、一个同级的
  `context_servers` 子项）的配置，它先注册再移除，断言之后其他每个值都逐字节相同。还覆盖了移除一个从未
  写入过的条目：不报错、不写入。
- README（两种语言）：一张安装 / 更新 / 移除 / 撤销的表、每个客户端 `--remove` 前后的实测对比，以及一条
  明确的说明：`--remove` **不会**卸载这个包。
- `dsh-any-agent-setup --help` 现在写明：每个客户端只添加一个条目、移除的也恰好是那个条目；其他 MCP 服务
  从不读取或重写；记录的是绝对路径——移动或删除安装目录后，客户端会报 `CONNECTION_CLOSED`，
  直到在新位置重新运行 setup。

### 修复

- **setup 原先会重排一份它本来只该加一个键的配置。** 旧的写入器会解析每个 JSON 客户端配置，再用
  `JSON.stringify(..., null, 2)` 重新输出，悄悄地把每个无关条目的缩进、键序、行尾和末尾换行都规范化了——
  值保住了，格式没保住。现在写入只替换属于 setup 自己条目的那些字节，这个不变量在
  `test/config-safety.mjs` 里被断言，而不是用文字描述。
- **一个用完即扔的验证脚本删掉了操作者真实家目录里的部分内容。** 这不是 `setup` 的 bug——是用来验证它的
  测试脚手架的 bug。脚本把沙箱路径存在 `$home` 里，而它在 PowerShell 里是一个只读的自动变量；在
  `$ErrorActionPreference = 'Continue'` 下赋值失败是静默的，所以 `$env:USERPROFILE` 仍然指向预期的
  沙箱名，而清理那一行 `Remove-Item $home -Recurse -Force` 解析到的却是真实的用户目录。三次运行，
  每次都在删除中途被 120 秒的超时杀掉，删掉了 `~/.codex`、`~/.cursor` 和 `~/.claude` 的一部分
  （本包自己的配置条目保住了，它们周围的用户数据没保住）。

  证明这是沙箱逃逸而不是写入的证据：残留的 `~/.cursor/mcp.json.bak-dsh-*` 文件里是脚本写的夹具内容
  （`{"mcpServers":{"keep":...}}`），也就是说它一直在往真实的用户目录里写。`sandbox-guard`
  现在让这种事不可能悄无声息地发生。

### 测试

- **632 项离线检查，在 0.3.0 上全绿**——`guards` 31、`prune` 11、`approval-details` 24、
  `sandbox-guard` 18、`setup` 41、`removal-scope` 24、`config-safety` 403、`real-configs` 66、
  `package-check` 14。每个套件都以 0 退出；没有一个需要模型、DSH 安装或 provider。**其中 619 项断言
  在客户端注册相关的套件里**（`setup`、`removal-scope`、`config-safety`、`real-configs`），这一版的
  工作正集中在那里。需要模型的套件（462 项检查）最近一次完整测量是在 0.1.2 上，用
  `node test/run.mjs --all` 重跑。
- `test/real-configs.mjs`——**66 项针对真实配置而不是夹具的检查。** 它把这台机器上实际的客户端文件
  复制到一个临时目录——带着数百个 `projects` 条目和大小写冲突键的 182693 字节 `~/.claude.json`、
  一份 238 行的 Codex `config.toml`、Zed 完整的 `settings.json`——先注册再移除，要求每个文件都逐字节
  恢复原样。这些文件不存在的地方（CI），套件会明确打印 `skipped`，而不是空洞地通过。
- `test/config-safety.mjs`——**403 项检查**，是针对这一版所关注的性质的夹具矩阵，按客户端、在一个
  用完即扔的家目录上运行：预览让每个文件逐字节不变，也不创建备份；先注册后移除，其他每个条目都逐字节
  恢复，也不留下任何顶层键；4 空格、2 空格和制表符缩进、单行 JSON、缺失的末尾换行、CRLF 行尾和
  UTF-8 BOM 都能在写入后保留；格式错误的 JSON 和只读文件会被拒绝，原文件不受损，而缺失的目录会被安全地
  创建；第二次 `--yes` 是空操作，不产生新备份；移除一个从未写入的条目时什么都不写、以 `0` 退出；
  每个 `.bak-dsh-<stamp>` 只出现一次，并且等于写入前的字节。
- `test/removal-scope.mjs`——24 项检查；`test/setup.mjs`——41 项检查，包括拉起写进配置里的命令，
  并要求它对 `initialize` 给出有效的应答。
- **在真实的家目录上做过只读验证。** 在一位操作者的真实用户目录上运行 `setup --json`（计划模式），
  已有的七份客户端配置——`~/.claude.json`（182693 B）、`~/.cursor/mcp.json`（1396 B）、
  `~/.codex/config.toml`（6647 B）、`~/.gemini/settings.json`（465 B）、
  `~/.config/opencode/opencode.json`（441 B）、Zed 的 `settings.json`（5647 B）和 Claude Desktop 的
  `claude_desktop_config.json`（247 B）——大小、修改时间和 SHA-256 全部不变，没有创建任何
  `.bak-dsh-*` 文件，也没有创建新的配置。九个客户端全部报出。用 `--home <tmp>` 时，报告的每个路径都
  移到了那个目录里，包括 `APPDATA`。

## [0.1.2] — 2026-10-29

一行的修复，但它决定了 `dsh-any-agent-setup` 在 Windows 上到底能不能注册 Claude Code。

### 修复

- **路径里只要有空格，注册 Claude Code 就会失败。** Windows 默认安装时 `process.execPath` 是
  `C:\Program Files\nodejs\node.exe`，setup 通过 shell 把它传给 `claude` CLI 时没有加引号。
  cmd 把参数拆开了：

      Command: C:\Program
      Args:    Files\nodejs\node.exe D:\...\bin\dsh-any-agent.mjs

  没有任何地方报错。`claude mcp add` 以 0 退出，写进配置的 JSON 也是对的——唯一的症状是 Claude Code
  尝试启动服务时报 `CONNECTION_CLOSED`。Cursor、Zed 和 Codex 不受影响，因为它们收到的是一个 JSON/TOML
  值，而不是一个 shell 参数。现在含空白的参数都会加引号。

### 新增

- `test/setup.mjs` 增加了第九组，补上了让上面这个问题溜过去的缺口：它拿到 setup 刚写入的条目，像客户端
  那样原样拉起它，并要求一个有效的 `initialize` 应答。之前的每一项检查都在断言文件内容；没有一项问过
  文件里的那条命令能不能跑。35 → 41 项检查。

### 文档

- **setup 会动什么、不会动什么**，附上在一台装有真实 MCP 服务的机器上测得的前后数量：Cursor 4→5 个条目、
  Codex 2→3 个段、Claude Code 5→6 个服务、Zed 33→33 个键，每个原有条目都没变。也写明了会变的那一点：
  JSON 配置会被重新序列化，所以值会保留，但空白不会。
- **一份发布清单**，包括发布 0.1.0 和 0.1.1 时踩到的两个坑——npm 返回 202，而 registry 还要 404 一分钟；
  shields.io 提供的徽章会滞后五分钟（`license: package not found` 是它通用的失败文案，不代表缺了许可证）——
  以及对一个有问题的已发布版本执行 `npm deprecate` 的步骤，还有它需要交互式 OTP、因此不能在 CI 里运行这一事实。

## [0.1.1] — 2026-10-29

一次正确性版本。如果你在用 Node 20，或者依赖 `dsh-any-agent-setup` 在写入前先预览，其中两处修复对你很重要。

### 修复

- **`engines` 写错了：需要的是 Node ≥ 22.15，而不是 ≥ 20。** `src/workspace.mjs` 从 `node:zlib` 导入
  `zstdDecompressSync` 来读 DSH 的会话头；这个 API 在 22.15 之前不存在，而对一个不存在的导出做具名导入，
  在加载时就会报错。在 Node 20 上，服务还没来得及回应任何一个请求就以退出码 1 退出了，而 `package.json`
  一直告诉大家 Node 20 没问题。现在 `engines` 和 README 都写的是 22.15。
- **`dsh-any-agent-setup` 在演练（dry run）时会写文件。** 每条写入路径都无条件调用了"备份并写入"的辅助函数，
  事后才*报告*"将会写入"，所以一次不带 `--yes` 的预览会修改它找到的客户端配置，并留下 `.bak-dsh-*` 文件。
  Claude Code 那条路径在预览时会调用 `claude mcp add`，而它会立即写入。现在三条路径都返回预览、在碰磁盘
  之前就停下，演练也不会执行任何可能改变状态的子进程。
- **路径里有空格时，注册 Claude Code 会出问题。** Windows 上 `process.execPath` 是
  `C:\Program Files\nodejs\node.exe`，setup 命令通过 shell 把它交给 `claude` CLI 时没有加引号，于是它被拆成
  `C:\Program` 和一个多出来的 `Files\nodejs\node.exe` 参数。写入的配置看起来是对的，而 Claude Code 报
  `CONNECTION_CLOSED`。现在每个含空格的参数都会加引号。

### 新增

- `dsh-any-agent --version` / `--help`，在会话中枢启动之前就应答，所以查版本不会拉起回收器，也不碰注册表。
  `dsh-any-agent-setup` 也一样。
- `test/setup.mjs`——针对客户端配置写入器的 41 项检查，在一个用完即扔的 HOME 上运行：演练逐字节不变、
  原有条目保留、写入是幂等的、`--remove` 只拿掉它自己的条目、损坏的配置被拒绝而不是重写、没装的客户端被跳过、
  Codex 的 TOML 块能往返还原，以及——在引号 bug 之后加上的——写进配置的命令会被真正拉起，并且必须应答 `initialize`。
- `test/package-check.mjs`——抓那些只有打成 tarball 才会暴露的问题：缺 `bin` 字段、路径没有 `./`、缺 shebang、
  `private:true`、`files` 里有测试或状态路径，以及与源码实际导入相矛盾的 `engines` 下限。
- GitHub Actions：在 Linux 和 Windows 的 Node 22/24 上跑 guards、prune、approval-details 和 setup，外加一个
  打包任务：打包、安装到一个临时项目里，并断言 tarball 里没有状态、测试或凭据。

### 变更

- `SERVER_VERSION` 现在取自 `package.json`，而不是 `src/mcp.mjs` 里一份写死的副本，所以 `npm version`
  不会再让它过时。

## [0.1.0] — 2026-10-29

首个公开版本，以 [`dsh-any-agent`](https://www.npmjs.com/package/dsh-any-agent) 的名字发布到 npm。

### 新增

- **基于 stdio 的 MCP 服务**，把 DeepSeek Harness（DSH）当作一个可以长期共事的后台编码 agent 来驱动。
  只用四个标准的 MCP 方法（`initialize`、`ping`、`tools/list`、`tools/call`），所以任何能启动 stdio 服务的
  客户端都能用——不需要任何宿主专有的扩展。
- **11 个 `dsh_*` 工具**：`dsh_start`、`dsh_send`、`dsh_list`、`dsh_read`、`dsh_get`、`dsh_interject`、
  `dsh_interrupt`、`dsh_takeover`、`dsh_release`、`dsh_approval_decide`、`dsh_status`。
- **跨进程恢复。** 会话的身份是磁盘上 DSH 的 `sessionId`，而不是进程。崩溃、空闲回收、甚至重启整个服务
  都没有损失：下次调用会透明地恢复会话，记忆完整。
- **用哨兵文件做异步派活。** `dsh_send(wait=false)` 立刻返回一个 `run_id` 和一个 `sentinel_file`；回合结束时
  原子地写出这个文件，所以宿主里的后台任务会唤醒调用方，而不用轮询。哨兵按会话分命名空间、写定后不再改变，
  带着答复，但从不带思考内容。
- **回合中途改方向。** `dsh_interject` 改变一个正在跑的回合的方向（取消，然后立刻开始一个保留历史的新回合）；
  `dsh_interject(mode=queue)` 把一句话推迟到当前回合结束后再说。`dsh_interrupt` 停下一个回合，而不损坏会话。
- **写锁处理。** DSH 的会话带着一个跨进程的写锁，只要持有者活着就永不过期，也没有抢锁的 API。
  `dsh_status` 报告 `lock_holder`（`self` / `stale-mcp` / `live-mcp` / `none`），`dsh_takeover` 只在
  能证明安全的情况下抢占——它从不杀 GUI，因为 GUI 的会话都在唯一的 `dsh web` 进程里。
- **审批桥接**到调用方客户端，像凭据的字段在结构化上下文和显示的标题里都会被脱敏。
- **首次启动时引导 profile。** 第一次使用时，服务从附带的 `acp` 模板搭出 `~/.dsh/profiles/dsh-mcp/`，
  并从已有的 profile 复制模型路由。只复制路由*声明*（`apiKeyEnv`、`baseURL`、`api`、`models`、
  `reasoningEfforts`）；`apiKey`——适配器从不读取的字段——和 `headers` 会被剥掉。本项目从不请求、保存或写入任何凭据。
- **思考内容默认隐藏。** 只有统计数据（字符数、时长、分块数）会到达调用方；思考内容从不落盘，只有一个刻意保留的
  例外开关（`DSH_MCP_SENTINEL_INCLUDE_REASONING=1`）。
- **默认完全静默。** stderr 上一个字节都不输出，所以不会污染宿主的日志；stdout 只走协议。
- **工作区维护 CLI**（`dsh-any-agent-workspaces`）：`--list`、`--backfill`、`--prune-temp`、
  `--prune-empty`、`--purge-test-sessions`。
- 文档：`README.md` / `README.zh.md`、`USAGE-NOTES.md` / `USAGE-NOTES.en.md`（踩坑合集）、
  `USAGE-MIGRATION.md`（新环境部署）、`DESIGN.md`（协议层面的设计笔记）。

### 验证

- 18 个套件中 **528 项检查全绿**（套件内 492 项 + 验收 36 项），包括跨进程带记忆的恢复、并发下哨兵的原子性、
  四种写锁持有者分类、从会话自己的记录里回读的权限档强制，以及通过 provider 的真实模型调用。
- **零运行时依赖**——只用 Node 内置模块（`child_process`、`crypto`、`fs`、`module`、`os`、`path`、`url`、`zlib`）。
- 从发布的 tarball 安装：`npm install -g dsh-any-agent` 会创建 `dsh-any-agent` / `.cmd` / `.ps1` 垫片，
  服务以 `serverInfo: dsh-any-agent@0.1.0` 应答 `initialize`，暴露全部 11 个工具，并在 stderr 零字节输出的
  情况下返回一条真实的模型回复。
- 文档里的说法在发布前都重新测量过，而不是直接相信。有三个数字没经受住检验：`dsh_send(wait=false)` 被写成
  "约 1 毫秒"返回（实测 81 毫秒）、打断被写成"约 18 毫秒"收敛（没有任何测试得出过这个数；`waited_ms`
  字段的四个样本是 91/102/105/119 毫秒），以及一个会话被写成"约 120 MB"（实测 295–476 MB，而且原句自相矛盾）。
  README 的测试一节现在写明了规则：每个数字要么由某个套件打印出来，要么用一条读者能重跑的命令测得，
  测得的值要附上方法。

### 已知限制

- 不能把 token 级别的流式输出送进模型上下文（这是 MCP 的限制）。
- 真正的回合中途改方向做不到——ACP 拒绝并发的提示词，所以插话是用"取消再重启"实现的。
- 不支持图片提示词（ACP 声明 `promptCapabilities.image: false`）。
- 重启 MCP 服务会带走它的子进程：进行中的回合被打断，不会有哨兵。写锁*会*被释放，所以重启后总能拿回来。
- 在第一次成功的回合之前就死掉的会话，可能从来没有落到磁盘上；这时恢复会以一个清楚的报错失败。
- 不能改名——DSH 的标题子系统没有对外的改名 API。
- `session/list` 只返回 `{sessionId, cwd}`，而且不包括已经打开的会话；标题从 DSH 的投影缓存里补上。

### 备注

- DSH profile 故意仍然叫 `dsh-mcp`，`DSH_MCP_*` 环境变量和 `# dsh-mcp:managed` 标记行也一样。这些都是已经落盘的
  标识符：改名会让现有的 profile、会话和客户端配置失联。产品名变了，磁盘上的契约没变。见 README 的常见问题。

[Unreleased]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.9...v0.7.0
[0.6.9]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.8...v0.6.9
[0.6.8]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.7...v0.6.8
[0.6.7]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.6...v0.6.7
[0.6.6]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.2...v0.3.0
[0.1.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmtlzzz/dsh-any-agent/releases/tag/v0.1.0
