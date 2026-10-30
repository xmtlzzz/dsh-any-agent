# 🐳 dsh-any-agent

[English](README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/dsh-any-agent.svg)](https://www.npmjs.com/package/dsh-any-agent)
[![node](https://img.shields.io/node/v/dsh-any-agent.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/dsh-any-agent.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

> **给任何 MCP 客户端配一个"能长期共事的编码搭子"** —— 背后是 DeepSeek Harness。

一个 MCP 服务端：把 DSH 当作**长驻的 agent 运行时**来驱动，而不是包一层命令行。开个会话、扔个目标，它自己写代码、跑脚本、派子代理；你随时能看、能插话、能回头验收。🛠️

**任何 MCP 客户端都能用。** 这里没有任何 Codex 或 Claude 专属的东西：服务端只讲标准 MCP over stdio，只用四个标准方法（`initialize`、`ping`、`tools/list`、`tools/call`）。已用一个"原始"客户端验证过——它协商更旧的协议版本、且从不发 `notifications/initialized`。

🧪 0.3.0 离线 632 项检查全绿（其中 619 项属于客户端注册器套件） · 🔌 MCP over stdio · 📦 零依赖 · 📜 MIT

> 📌 **建议先读 [使用注意事项](USAGE-NOTES.md)** —— 会真正踩到的坑：ACP 模型配置陷阱、**外部 MCP 工具的副作用不受 DSH 沙箱约束**、工作区与 GUI 的注册表缓存、成本控制、以及一张故障速查表。
>
> 🆕 **在新机器上部署？** [USAGE-MIGRATION.md](USAGE-MIGRATION.md) 是面向新环境的逐步指引：前置条件、怎么找 `DSH_BIN`、Claude Code / Codex / Cursor / Windsurf / Cline / Zed 的现成配置块，以及首轮对话清单。

## 📑 目录

- **先看这里** —— [解决什么问题](#-解决什么问题) · [主要优势](#-主要优势) · [为什么不是包一层](#-为什么不是直接把-dsh-包一层) · [前置要求](#-前置要求) · [安装配置](#-安装配置)
- **怎么用** —— [工具](#-工具) · [先派活回头验收](#-用法先派活回头再验收) · [跑完自动通知](#-用法跑完自动通知不轮询) · [多会话并发](#-用法同时控制多个会话)
- **行为** —— [权限](#-权限) · [思考内容](#-思考内容默认隐藏) · [日志与隐私](#-日志与隐私) · [工作区与 GUI](#-会话在-dsh-gui-里的可见性)
- **难点** —— [写锁](#-写锁一个会话同一时刻只有一个写者)
- **参考** —— [环境变量](#-环境变量) · [测试](#-测试) · [已知限制](#-已知限制) · [为什么还叫旧 profile 名？](#-为什么-profile-还叫-dsh-mcp)


```
  任意 MCP 客户端                    ← Claude Code、Codex、Cursor、Zed、Cline、你自己写的…
  (Claude/Codex/Cursor/…)            │
         │ MCP over stdio            │ 换行分隔 JSON-RPC（ACP）
         ▼                           ▼
   ┌─────────────┐          ┌──────────────────────────┐
   │dsh-any-agent│─────────▶│ dsh --profile dsh-mcp    │  每个会话一个长驻进程
   └─────────────┘          │                          │
                            └────────────┬─────────────┘
                                         │
                            ┌────────────┴─────────────┐
                            │ DSH 自带工具             │ 文件/shell/搜索/
                            │                          │ 技能/子代理/workflow
                            ├──────────────────────────┤
                            │ dsh-mcp-client           │ → 你自己的其他 MCP 服务器
                            └──────────────────────────┘
```

## 🎯 解决什么问题

你的编辑器里已经有一个编码 agent 了。你**没有**的是这样一个 agent：

- **把几小时的长活交给它，然后走开** —— 回头再来收结果；
- **跨重启不丢** —— 编辑器重启、会话断开、机器空闲回收，任务都还在；
- **跑偏时能中途插话** —— 改口、打断，而不毁掉已经做的工作；
- **同时跑好几个**，像切窗口一样轮流盯。

DSH（DeepSeek Harness）本身**全都能做** —— 它有文件/shell 工具、技能、子代理、workflow —— 但它是个 GUI 优先的应用。它自带的 `sdk` profile 只暴露 3 个请求，不能 resume、不能 cancel、不能应答审批。

**这个服务就是缺的那层适配器：** 把 DSH 变成一个*守规矩的后台 agent*，任何 MCP 客户端都能雇它、盯它、收它的活。

> 可以理解成 shell 里的 `&` —— 只不过后台跑的是个 agent。

## ✨ 主要优势

|  |  |
|---|---|
| 🔄 **进程死了对话也不丢** | 对话身份在磁盘上。进程崩溃、被空闲回收、甚至整个服务重启，都不影响继续——下次调用自动 `resume`，记忆完整（跨进程实测）。 |
| 🗣️ **不用傻等** | 回合跑偏了能**插话改口**（约 100ms 收敛到 idle，四次打断实测），或**排队**等这轮跑完再说；打断后会话不损坏。 |
| 📡 **跑完自动通知** | 长任务 `wait=false` 立刻返回 `run_id`；回合结束时**原子写出哨兵文件**，用你宿主的后台任务等它即可。不轮询、不占轮次。 |
| 🪟 **多会话并发** | `dsh_list(only_running)` 看谁在跑，`dsh_read` 游标式增量读——像切窗口一样轮流盯。 |
| 🧠 **灰色思考默认隐藏** | 只给"想了 N 字 / M 秒"的统计，不烧上下文；**不写日志、不落盘**。 |
| 🤫 **默认完全静默** | 一个字节都不输出，不污染宿主日志；stdout 只走协议。 |
| 🧩 **能力可叠加** | DSH 自己还能挂别的 MCP（IDA Pro、浏览器、内部工具）——这是一座通往整个工具箱的桥。 |
| 🛡️ **只读档真能只读** | `read-only` 沙箱 + 审批一律拒绝，适合分析不信任样本。 |

## ⚡ 为什么不是直接把 DSH 包一层

DSH 自带两个可编程入口。`sdk` profile 看着更简单，但它的 JSON-RPC 只有 **3 个请求 + 4 个通知**，缺了三样让 agent 实际不可用的能力；`acp` profile（Agent Client Protocol）全都有。以下结论全部针对 DSH `0.1.7-rc.2` 实测得出。

| 能力 | `sdk` profile | `acp` profile（**本项目**） |
|---|---|---|
| **恢复会话** | ❌ 无 resume 方法，复用 id 报 `already exists` | ✅ `session/resume`，**跨进程实测通过** |
| **中断回合** | ❌ 只能杀进程 | ✅ `session/cancel`，与用户手动按停止同一条路径 |
| **应答审批** | ❌ 无通道，操作静默 fail-closed | ✅ `session/request_permission` 往返 |
| 列出 / 关闭会话 | ❌ 无 | ✅ `session/list`、`session/close` |
| 灰字 vs 黑字 | 同一条消息里靠 `type` 字段分 | ✅ 两条独立通道 `agent_thought_chunk` / `agent_message_chunk` |
| 每会话 MCP 服务器 | ❌ 进程级 | ✅ `session/new` 与 `session/resume` 都接受 `mcpServers` |

**核心思想：进程只是缓存，不是身份。** 对话的身份是 DSH 的 `sessionId`，落盘在 `~/.dsh/sessions`。进程被回收、崩溃、甚至整个 MCP 服务重启，下一次调用都会自动 `session/resume` 把它接回来，历史完整保留。

## 📦 前置要求

- **Node.js ≥ 22.15** —— 服务用 `node:zlib` 的 `zstdDecompressSync` 读 DSH 会话头，这个 API 在 22.15 之前不存在
- **已安装 DSH**（`@deepseek-ai/dsh`），且 `~/.dsh` 下已有可用的 provider 与凭据（GUI 能正常聊天即可）

> 本服务**不自带** provider 配置，也**从不**接收或保存 API 密钥。

## 🚀 安装配置

### 1. 让 profile 自己就绪（通常无需手工操作）

> 📌 **为什么还叫 `dsh-mcp`？** 项目已改名 **dsh-any-agent**，但 DSH profile 名、`DSH_MCP_*` 环境变量、`# dsh-mcp:managed` 标记行都**故意保留旧名**。它们是已落盘的稳定标识符：改了会让现存 profile、会话和你的客户端配置一起失联。这是刻意的向后兼容，不是漏改。

首次拉起 DSH 时，[`src/bootstrap.mjs`](src/bootstrap.mjs) 会自动：

1. 在 `$DSH_HOME/profiles/dsh-mcp/` 建一个基于出厂 `acp` 模板的 profile；
2. 从本机**已有**的 profile（`$DSH_HOME/cordis.patch.yml` → `desktop` → `web` → `headless` → `acp` 取第一个有配置的）复制模型路由；
3. 写 `acp` 与 `agent-default-model` 两行，让 ACP 会话用与 GUI 相同的模型。

复制的内容只有 `apiKeyEnv` / `baseURL` / `api` / `models` / `reasoningEfforts`；`apiKey`（适配器从不读取的死字段）与 `headers`（可能夹凭据）一律剥掉。凭据本身由 DSH 的凭据服务逐次请求解析，路径与 GUI 完全一致。

想要的来源不是自动挑的那个，可设 `DSH_MCP_ROUTE_SOURCE=desktop`（或 `__home__`）；彻底关掉自动同步则设 `DSH_MCP_BOOTSTRAP=0`。

### 1b. 手工维护（可选）

```bash
dsh --profile dsh-mcp --from-default-profile acp
```

然后编辑 `~/.dsh/profiles/dsh-mcp/cordis.patch.yml`，**并删掉文件开头的 `# dsh-mcp:managed` 行** —— 有那行时本服务每次启动都会按来源重新生成，手改会被覆盖。可以从 [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml) 起步。

> ⚠️ **这里有两个坑**（都是踩出来的）：
>
> 1. **ACP 的模型不走 `agent-default-model`**，而是读 `dsh-acp` 插件自己的 `config.provider` / `config.model` —— 而 `acp` bundle 把它硬编码成了 `deepseek-official`。不覆盖 `acp` 这一行，会话会静默跑在错误的 provider 上，报 `no API key for provider route "deepseek-official"`。
> 2. **ACP 的 `reasoning_effort` 默认是空串**（= "Provider default"），不是最大档。本服务在每次 `session/new` 以及每次 `session/resume` 之后都会显式设成 `max` —— 因为新进程不会记住上一次的选择。

### 2. 注册 MCP 服务

**从 npm 安装，一条命令（推荐）**

```bash
npm install -g dsh-any-agent
dsh-any-agent-setup            # 检测你装了哪些客户端，不写任何文件
dsh-any-agent-setup --yes      # 真正写入
```

`setup` 会找出你机器上的 MCP 客户端 —— **Claude Code、Claude Desktop、Codex、Cursor、Windsurf、Zed、Gemini CLI、opencode、VS Code** —— 逐个写进去，没装的跳过。它的安全性是结构性保证的：

- **默认 dry-run**，必须加 `--yes` 才写；预览模式下**不启动任何子进程**，只读取它将要触及的那些文件
- 每个文件写前备份成 `<file>.bak-dsh-<时间戳>`，内容是**写入前的原始字节**
- 写入前后各解析一次，坏配置绝不落盘；坏 JSON 与只读文件一律拒绝而不是硬写，目录不存在则安全创建
- **文本级写入**：只替换自己那个条目的字节，缩进（2 空格 / 4 空格 / Tab）、键顺序、CRLF 行尾、UTF-8 BOM、有无末尾换行都原样保留
- **幂等**，重复运行只改变有差异的部分；第二次 `--yes` 不写盘、不新增 `.bak`

```bash
dsh-any-agent-setup --yes --only cursor,zed     # 只装这几个
dsh-any-agent-setup --yes --permission read-only
dsh-any-agent-setup --remove --yes               # 全部移除，只摘自己那条
```

**新增的三个开关**

| 开关 | 作用 |
|---|---|
| `--json` | **stdout 只有一个可解析的 JSON 对象，人类可读日志全部走 stderr**。结构：`{ ok, mode, clients: [{ id, label, path, status, summary, error? }], changed, skipped, failed }`，其中 `mode` 取 `plan` / `apply` / `remove`。这是**契约**，不是便利功能：脚本可以把 stdout 直接喂给 JSON 解析器 |
| `--home <dir>` | 用指定的 home 目录代替真实 `HOME` / `USERPROFILE` / `APPDATA`，注册—注销可以整套演练而不碰真实配置 |
| `--force` | 只做两件事：(a) 目录或文件不存在时创建它们（默认也会创建，这个开关让它在自动化里、以及检测不到客户端时也照做）；(b) 目标文件里已有同名条目、但形状不是本程序期望的样子时，允许覆盖它。它**绝不删别人的条目**，也**绝不跳过校验** |

**每个客户端到底会碰哪个文件**

写入前一律先落 `.bak-dsh-<时间戳>` 备份。表中路径均为通用示例，「自己那条」指名为 `dsh-any-agent` 的那一个条目 / 那一段。

| 客户端（`--only` 取值） | 配置文件 | 容器键 | 安装 / 更新 | 卸载（`--remove`） | 撤销 |
|---|---|---|---|---|---|
| Claude Code（`claude-code`） | `~/.claude.json` | `mcpServers` | 只增 / 改自己那条，且带 `type: "stdio"` | 删掉自己那条 | 把备份复制回去 |
| Claude Desktop（`claude-desktop`） | Windows `%APPDATA%\Claude\claude_desktop_config.json`；macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| Codex（`codex`） | `~/.codex/config.toml` | `[mcp_servers.dsh-any-agent]` | 按行追加自己那两段 TOML | 只删这两段 | 把备份复制回去 |
| Cursor（`cursor`） | `~/.cursor/mcp.json` | `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| Windsurf（`windsurf`） | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| Zed（`zed`） | Windows `%APPDATA%\Zed\settings.json`；其他平台 `~/.config/zed/settings.json` | `context_servers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| Gemini CLI（`gemini`） | `~/.gemini/settings.json` | `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| opencode（`opencode`） | `~/.config/opencode/opencode.json` | `mcp` | 只增 / 改自己那条，且按 opencode 的形状写：`{ type: "local", command: [exe, ...args], enabled: true }` —— 一个数组，不是分开的 `command`/`args` | 删掉自己那条 | 把备份复制回去 |
| VS Code（`vscode`） | Windows `%APPDATA%\Code\User\mcp.json`；其他平台是 VS Code 用户目录下的同名 `mcp.json` | `servers` —— **不是** `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |

具体路径以 `--json` 输出里每个客户端的 `path` 字段为准 —— 那是本次运行在你这个系统上真正要写的文件，比任何文档都准。

有三种形状值得单独点出来，写错了是**静默失效**。**VS Code** 的 MCP 配置放在 `servers` 下，不是 `mcpServers`；按常见写法写进去，编辑器会直接忽略。**opencode** 用的是**一个** `command` 数组（`{ type: "local", command: [exe, ...args], enabled: true }`），不是分开的 `command`/`args`。**Claude Code** 则是本次发布**完全不用 JSON 库**的原因：`~/.claude.json` 的 `projects` 映射里确实存在**只差大小写**的重复键（`.../Rust` 和 `.../rust` 并存），朴素的 `JSON.parse` 在那里会失败，而任何整份重写都会毁掉用户的项目列表。所以改用按字符区间扫描、**从不构造值对象**的扫描器；早先那版「调 `claude mcp add`」也出于同样理由被放弃 —— 那条命令会用它自己的格式重写整个文件，且不产生我们可以回滚的备份。

**setup 会动什么、不会动什么**

它只做新增，而且只动自己那一条。在真正装着别的 MCP 服务器的机器上验证过（Cursor 4 个、Codex 2 个段、Claude Code 5 个、Zed 33 个配置键）：所有既有条目**逐字节不变**，键顺序不变，唯一的差异是每个客户端多了一个条目。

```
Cursor       4 -> 5 个条目   既有条目逐字节相同
Codex        2 -> 3 个段     node_repl 与 rea 内容不变
Claude Code  5 -> 6 个服务   原有四个都还在列表里
Zed          33 -> 33 个键   只有 context_servers 多了个子项
```

和 0.1.x 的区别：过去 JSON 配置是**整份重新序列化**的（值保留、排版丢失），所以「白空格不保证原样」。现在写入是文本级的 —— 除了自己那一条，文件其余部分逐字节相同：4 空格缩进、2 空格缩进、Tab、单行 JSON、没有末尾换行、CRLF 行尾、带 UTF-8 BOM，一律原样。

Codex 的 `config.toml` 同理，是按行处理的：其它 `[表]` 及其注释、顶层键（`model`、`approval_policy`、`sandbox_mode` 等）、CRLF 行尾都原样保留 —— `--remove` 只删 `[mcp_servers.dsh-any-agent]` 那两段，其余一律不动。

这些断言的详细覆盖见 [`test/`](test/)（`test/config-safety.mjs` 共 403 项，逐条断言上面每一条）。

**在真实 home 上做过只读验证。** 用 `setup --json`（纯计划模式）跑一遍开发机上的真实配置：9 个客户端全部报出，而现存的每份配置都**原封未动** —— size、mtime、SHA-256 全同，没有新增任何 `.bak-dsh-*`，也没有新建任何文件：

```
~/.claude.json                            182693 B   未变
~/.cursor/mcp.json                          1396 B   未变
~/.codex/config.toml                        6647 B   未变
~/.gemini/settings.json                      465 B   未变
~/.config/opencode/opencode.json             441 B   未变
%APPDATA%/Zed/settings.json                 5647 B   未变
%APPDATA%/Claude/claude_desktop_config.json   247 B   未变
```

同一条命令加 `--home <临时目录>` 时，报出的**每一个** path 都落进了那个目录（`APPDATA` 也跟着走）—— 注册 / 注销整套演练之所以安全，靠的就是这条。

**在真实 home 上做过完整的注册 → 撤销往返（不只是预览）。** 备份全部 7 份配置后，实际执行 `--yes` 再执行 `--remove --yes`，然后逐字节核对：

| 客户端 | 注册前 | 注册后 | 撤销后 | 其它 MCP 服务器 |
|---|---|---|---|---|
| ~/.claude.json | 182693 B | 182693 B（原本已是最新） | 逐字节回到基线 | 未动；67 个顶层键、60 个 projects 条目、两个只差大小写的重复键都还在 |
| ~/.cursor/mcp.json | 1396 B | 1389 B | 1009 B | stitch / obsidian-mcp-server / codegraph / rea 逐字段相同 |
| ~/.codex/config.toml | 6647 B | 6647 B（原本已是最新） | 6239 B | 其它 `[表]`、注释、顶层键全部保留 |
| %APPDATA%/Zed/settings.json | 5647 B | 5647 B（原本已是最新） | 5240 B | 32 个顶层设置键全部保留 |
| ~/.gemini/settings.json | 465 B | 845 B | 465 B | 逐字节还原 |
| ~/.config/opencode/opencode.json | 441 B | 869 B | 441 B | `$schema` 与 pencil 条目保留 |
| %APPDATA%/Claude/claude_desktop_config.json | 247 B | 627 B | 247 B | 逐字节还原 |

撤销的验收方式不是「看起来对」，而是**从备份原文里用同一套编辑引擎摘掉 `dsh-any-agent` 这一条，结果必须与磁盘上的当前文件逐字节相同** —— 7 个文件全部通过。这条证明撤销是注册的严格逆运算，不会顺手带走别的东西。

撤销后所有 JSON 仍可解析、`codex mcp list` 仍能正常读取配置，客户端不需要人工修复。


**cwd 不要选家目录本身**

DSH 自己的 ACL 沙箱要求临时目录在工作区**之外**。Windows 上 `%TEMP%` 是 `C:/Users/<你>/AppData/Local/Temp`，就在家目录里面，所以 `cwd` 取家目录时，第一条 shell 命令会失败并报 `Windows ACL: temp root must be outside the workspace`。现在 `dsh_start` 会直接拒绝这个组合并给出两条出路：换一个具体项目目录，或改用 `permission=read-only` / `danger-full-access`。

**备份与回滚**

注册和删除**都会**在动文件之前先存一份：`<配置文件>.bak-dsh-<时间戳>`，内容就是操作前的原始字节。两个方向都存，因为要退回的状态不同——注册前那份用来「装错了退回原样」，删除前那份用来「删错了装回去」。

每次实际写入后，`--json` 的每个客户端条目里都带 `backup` 字段，直接告诉你备份在哪；人类可读的输出也会在每条下面打印 `backup: <路径>`。

备份散落在各客户端目录里，手动翻文件容易挑错，所以附带一个还原命令：

| 要做的事 | 命令 |
|---|---|
| 看有哪些备份（新的在前） | `dsh-any-agent-restore --list` |
| 退回每个文件最新的那份 | `dsh-any-agent-restore --latest` |
| 退回某一批次 | `dsh-any-agent-restore --stamp 2026-10-30T01-35` |
| 退回指定的一份 | `dsh-any-agent-restore --file <备份路径>` |
| 先看会做什么 | 任意命令加 `--dry-run` |

还原本身也是破坏性操作，所以覆盖之前会把**当前**状态另存为 `.bak-dsh-pre-restore-<时间戳>`——退错了还能再退回来。

**安装 / 更新 / 删除**

| 要做的事 | 命令 |
|---|---|
| 预览会改什么（不写） | `dsh-any-agent-setup` |
| 注册到所有检测到的客户端 | `dsh-any-agent-setup --yes` |
| 只注册某几个 | `dsh-any-agent-setup --yes --only cursor,zed` |
| 就地改权限档 | `dsh-any-agent-setup --yes --permission read-only` |
| 升级包之后更新配置 | `dsh-any-agent-setup --yes`（幂等，只重写有差异的条目） |
| 从所有客户端移除 | `dsh-any-agent-setup --remove --yes` |
| 只从某几个移除 | `dsh-any-agent-setup --remove --yes --only codex` |
| 撤销某次误写 | 把 `.bak-dsh-<时间戳>` 复制回原文件 |

**`--remove` 到底动了什么 —— 实测**

注销只删掉每个客户端里的**那一个键**，其余一概不碰。在真机上测得的前后对比：

```
Cursor       { keep, dsh-any-agent }  ->  { keep }
             手工写的那条原样保留
Claude Code  6 个服务                  ->  5 个服务
             原有五个都还在列表里
Zed          33 个顶层键               ->  33 个键
             只有 context_servers 少了子项，现在是空对象
Codex        我们的两个 TOML 段        ->  已移除
             model、approval_policy、sandbox_mode、node_repl、rea 全部完好
```

这些条目之外的东西它一概不读、不改、不删。你的凭据、其他 MCP 服务器、无关设置都不受影响。

注意：**`--remove` 不会卸载包本身** —— 那是 `npm uninstall -g dsh-any-agent`，两件事互相独立：你可以保留包但不注册任何客户端，也可以只注销而不卸载。

事后可自行核验：`claude mcp list`、`codex mcp list`，以及看 `~/.cursor/mcp.json` 和 Zed 设置里的 `context_servers` 键。

**记录的是绝对路径**

`setup` 写进去的是它运行时所处安装目录的**绝对路径**。**如果你移动或删除了那个目录，所有客户端都会报 `CONNECTION_CLOSED`**，直到你在新位置重新跑一遍 `setup`，或者用 `--remove` 把失效条目清掉。

最容易踩到的情况：装到临时目录里试用，然后清理掉 —— 配置还指着那个已经不存在的路径。

**从本地目录安装**

解压到任意位置，把 `command` 指向 `node`、`args` 指向 `<解压目录>/bin/dsh-any-agent.mjs`（见下）。

---

**Claude Code**

```bash
# 全局安装
claude mcp add dsh-any-agent -- dsh-any-agent

# 本地目录
claude mcp add dsh-any-agent -- node /绝对路径/server/bin/dsh-any-agent.mjs
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.dsh-any-agent]
command = "dsh-any-agent"          # 或 "node" + bin/dsh-any-agent.mjs 的路径
args = []
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
```

**通用 MCP 客户端** —— 任何支持 stdio 的 MCP 客户端：

```json
{
  "mcpServers": {
    "dsh-any-agent": {
      "command": "dsh-any-agent",
      "args": []
    }
  }
}
```

本地目录安装时改用 `"command": "node"` 和 `"args": ["/绝对路径/server/bin/dsh-any-agent.mjs"]`。

> Cursor、Windsurf、Zed、Cline、Continue 等大部分客户端都吃同一套 `mcpServers` 结构——只要能拉起 stdio MCP 服务，就能用。

### 3. 自检

```bash
dsh-any-agent --version      # 打印版本，不启动任何东西
dsh-any-agent --help         # 参数、关键环境变量、文档链接
node test/smoke.mjs          # 不调用 LLM，验证整条管道
```

## 🧰 工具

| 工具 | 作用 |
|---|---|
| `dsh_start` | 建会话：工作区、权限档、审批策略、**思考深度（默认 `max`）**、模型 |
| `dsh_send` | 派任务。**默认 `wait=false`：立刻返回 `run_id` + `sentinel_file`**，回合在后台跑，跑完由哨兵文件通知你（推荐）。`wait=true` 才原地阻塞到回合结束；到期（`timeout_ms`，默认 0 = 一直等）**只会转后台，不取消回合、不丢结果** |
| `dsh_list` | 所有会话及运行状态：`running` / `idle` / `detached`，已跑时长、当前工具、本轮输出。`only_running=true` 只看活动会话 |
| `dsh_read` | **游标式增量读**——看正在跑的会话此刻吐出了什么 |
| `dsh_get` | 会话详情；带 `run_id` 时返回**那一次派活的完整结果**（"回头验收"的入口） |
| `dsh_interject` | 会话在忙时插话：`interject` 打断并改口，`queue` 等本轮跑完接着说。**这一轮同样会写哨兵**，返回里给 `sentinel_file` |
| `dsh_takeover` | **抢占写锁**。锁被别的 DSH 进程占着时的唯一出路（DSH 没有夺锁 API，抢 = 杀掉持有者）。先判定持有者：本服务残留的孤儿 → 自动抢；另一个活着的实例 → 需 `force`；**GUI/未知 → 绝不杀**，只报告 |
| `dsh_interrupt` | 打断当前回合（会话不会损坏） |
| `dsh_release` | 交还会话（释放写锁，之后可在你自己的 DSH GUI 里打开）。仍可 resume |
| `dsh_approval_decide` | 裁决待决审批（仅当 `on_approval=ask`） |
| `dsh_status` | 轻量状态查询 |

## 📋 用法：先派活，回头再验收

MCP 工具调用是**阻塞**的，所以 `dsh_send` **默认就不阻塞**（`wait=false`）：派完立刻拿到收据，回合在后台跑，跑完由哨兵文件唤醒你。整个流程是这样：

```text
1. dsh_send(conversation_id, prompt, wait=false)
     → { run_id: "run-abc123", background: true }        # 不等回合跑完就返回

2. …继续做你自己的事（实测：期间在另一个会话上跑完了一整个回合）…

3. dsh_status(conversation_id)
     → state=running | elapsed=3.5s | current_tool=pwsh | out=37 chars

4. dsh_read(conversation_id, cursor)                      # 中途偷看
     → [我] … | [轮次] 第 1 轮开始 | [工具] pwsh [in_progress]

5. dsh_get(conversation_id, run_id)                       # 验收
     → status=done, elapsed=20.3s, 完整答复
```

`run_id` 是验收凭据。回合记录**只在内存、只留最近 20 条**；并发跑很多 run 时旧记录会被挤掉，`dsh_get` 就会失败——这正是下面"完成哨兵"自带结果的原因。

## 🔔 用法：跑完自动通知（不轮询）

`wait=false` 除了 `run_id`，还会返回 **`sentinel_file`**（哨兵文件路径）以及 **`sentinel_file_posix`**（Bash/MSYS 形式，**直接用它，别无手工转换**——转错了等待任务会一直挂到超时）。回合结束时——**无论成功、失败还是被取消**——本服务都会往这个路径**原子写出**一个含最终 `status` 与 `result` 的小文件。于是你不用轮询、也不用傻等：**用你自己宿主（Claude/Codex）的后台任务等这个文件出现即可，文件一到就会唤醒你。**

```bash
# sent="$sentinel_file_posix"   ← 直接用工具返回里那个字段
sent='/d/AI_MCP/DSH_MCP/.state/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 2100 ))          # 35min 兜底，防服务中途死掉时无限挂
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # 后台任务退出 → 宿主唤醒你 → 读文件收活
```

文件出现后：**直接读它**即得 `status` 和 `result`（推荐——不受内存窗口限制、还扛服务重启），或用 `dsh_get(conversation_id, run_id)` 验收。

设计要点（尤其**多会话并发**）：

- **不串台**：哨兵路径为 `.state/runs/<conversation_id>/<run_id>.json`，按会话分目录。`run_id` 的序号是每会话独立计数的，不同会话在同一毫秒可能生成同名 `run_id`——分目录后各写各的，绝不互相覆盖。每个 run 起一个独立后台任务即可，各自完成、各自唤醒。
- **闩锁语义**：文件写一次并保留。即便 run 在你启动等待任务**之前**就已完成，`[ -f ]` 也立刻为真，不会漏。
- **原子落地**：`tmp` + `rename`，文件一旦存在内容必然完整；每个 run 用独立 tmp，并发写互不干扰。
- **无主动推送**：本服务在 MCP 协议上只应答请求、不发通知；"跑完通知"完全由这个哨兵文件 + 你的后台等待任务实现。
- **★ 哨兵里没有思考内容**：载荷只含正文与思考**统计**；`result.thinking` 会被剥掉并置 `thinking_omitted: true`——本项目的红线是思考不落盘。`dsh_get(run_id)` 在内存里仍能看到它（记录还在时）。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可以故意打破这条保证。

> 清理：哨兵内含完整正文，所以服务**启动时会清掉超过 7 天的哨兵**（用 `DSH_MCP_SENTINEL_TTL_MS` 调；`0` 关闭）。等待任务消费后仍建议自行 `rm`。

## 🧵 用法：同时控制多个会话

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵进行中(已跑9s, 工具=pwsh, 本轮输出=40字) | cwd=…
     - … | id=33427096… | 🔵进行中(已跑8s, 本轮输出=34字)        | cwd=…
2. dsh_read(id,  cursor=0)      # 读第一个，记下 cursor
3. dsh_read(id2, cursor=0)      # 切到第二个
4. dsh_read(id,  cursor=<上次>) # 切回来，只拿增量
```

## 🤫 思考内容：默认隐藏

DSH 在模型层就把思考与正文分开，ACP 又把它们做成**两条独立流**。本服务默认隐藏思考内容，只返回**统计**（字数、耗时、段数）——调用方知道它想过，但不必为思考内容付上下文成本。

- `reasoning=hide`（默认）—— 丢弃内容，返回统计
- `reasoning=marker` / `summary` / `full` —— 逐步放出更多内容（注意上下文预算）
- `dsh_read(include_reasoning=true)` —— 只返回**当前正在跑那一轮**的实时思考；不进缓冲，回合结束即丢弃

## 🔐 权限

| 档位 | 审批默认 | 用途 |
|---|---|---|
| `danger-full-access`（默认） | `auto-allow` | 零摩擦 |
| `workspace-write` | `auto-allow` | 越界操作会冒泡为待决审批 |
| `read-only` | `auto-deny` | 分析不信任样本（恶意软件、来路不明 dump） |

`on_approval` 可选 `auto-allow` / `auto-deny` / `ask`（`ask` 会把审批挂起，交给 `dsh_approval_decide` 裁决）。

## 🪟 会话在 DSH GUI 里的可见性

两件事，别混淆：

| | 取决于 | 现状 |
|---|---|---|
| **工作区是否生效** | 会话的 `cwd` | ✅ 永远正确。进程工作目录、文件落点、沙箱可写根都跟着它 |
| **GUI 里是否分组** | `~/.dsh/storages/workspace.json` 的 `sessionIds` | ⚠️ 本服务会登记，但**正在运行的 DSH 服务把注册表缓存在内存里**，外部改文件要重启 DSH 才生效 |

**"生效"有实测**（[`test/workspace-effect.mjs`](test/workspace-effect.mjs)）：桌面两个文件夹各开一个会话，派活时**不给任何路径**，结果两个会话各自把文件写进了自己的工作区、自报的当前目录正确、没有泄漏到 MCP 服务工作目录 / 家目录 / 临时目录 / 另一个工作区（24/24 全过）。

维护命令：

```bash
node bin/dsh-any-agent-workspaces.mjs --list                  # 查看注册表
node bin/dsh-any-agent-workspaces.mjs --backfill              # 扫描磁盘上的会话，全部补登记
node bin/dsh-any-agent-workspaces.mjs --prune-temp            # 清掉临时目录条目
node bin/dsh-any-agent-workspaces.mjs --prune-empty           # 清掉"无会话且路径已不存在"的工作区
node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions   # 删测试会话（规则写得很死）
```

> ⚠️ 重启 DSH 之前**别在 GUI 里操作工作区**，否则服务会用内存状态把文件覆盖回去。

## 🕶️ 日志与隐私

默认**完全静默**，一个字节都不输出。

1. MCP 的 **stdout 是协议通道**，混进任何东西都会破坏报文；
2. 本服务被 Claude/Codex 拉起，它的 stderr 会进**对方的日志**；
3. DSH 子进程的 stderr 可能夹带模型输出（**含思考内容**），所以默认既不转发也不落盘。

| 级别 | 行为 |
|---|---|
| `silent`（默认） | 什么都不输出 |
| `info` | 只输出本服务自己的生命周期事件，**绝不含 DSH 的任何输出** |
| `debug` | 更细的本服务事件；仍不打印 DSH 输出 |
| `DSH_MCP_LOG_STDERR=1` | 额外转发 DSH 原始 stderr（**可能含思考内容**） |

**思考内容不落盘**，只有一个**刻意留下**的例外：

- 不写日志（默认静默）；状态文件只有元数据（id、cwd、权限、计数），冒烟测试里有一条断言专门守这个。
- **异步完成哨兵需要把正文写进文件**（否则调用方无法离线收活），但 `result.thinking` 会被**剥掉**并置 `thinking_omitted: true`。测试里专门验证了：即使请求 `reasoning=full`，哨兵里也不出现任何思考文本——而同一 run 在内存（`dsh_get`）里仍能看到。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可刻意打破这条。
- 哨兵默认 7 天后由启动清理删除（`DSH_MCP_SENTINEL_TTL_MS`，`0` 表示永久保留）。

（DSH 自己会在 `~/.dsh/sessions` 写会话日志，那是 resume 的依据，不在本服务控制范围内。）

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动探测 | `@deepseek-ai/dsh/lib/bin.js` 路径 |
| `DSH_MCP_PROFILE` | `dsh-mcp` | 驱动用的 DSH profile |
| `DSH_HOME` | `~/.dsh` | DSH 主目录。**默认就用本机用户自己的**，凭据与会话历史因此与 GUI 共用。指向别处即隔离环境（那就得自己准备那个目录的凭据与 profile） |
| `DSH_MCP_BOOTSTRAP` | 开 | `0` 关闭首启 profile 自动创建/同步（关掉后只驱动已存在的 profile，不写任何文件） |
| `DSH_MCP_ROUTE_SOURCE` | 自动 | 复制模型路由的来源 profile 名；`__home__` 表示只认 `$DSH_HOME/cordis.patch.yml` |
| `DSH_MCP_STATE` | `<仓库>/.state/conversations.json` | 会话注册表，跨重启存活 |
| `DSH_MCP_RUNS_DIR` | `<状态文件同目录>/runs` | 异步完成哨兵的根目录（`<此目录>/<会话id>/<run_id>.json`） |
| `DSH_MCP_LOCKS_DIR` | `<状态文件同目录>/locks` | 写锁"持有者登记"的目录。⚠️ **多个实例必须指向同一个值**，否则彼此看不见对方的持锁登记、会把对方误判成"无法识别的持有者（GUI）"而拒绝抢占 |
| `DSH_MCP_LOCK_STALE_MS` | `90000` | 持锁登记多久没续心跳就算"持有者失联"（此时可被 `dsh_takeover` 自动抢占） |
| `DSH_MCP_IDLE_TTL_MS` | `0`（永不回收） | 会话空闲多久回收其 DSH 进程。★★ **`0` = 永不回收（默认）**：本服务一直握着写锁，**GUI 抢不走**（你在 GUI 里点开是**只读**，照样能看 ✓）。代价：每会话常驻一个 DSH 进程（**两次冷启动实测 476MB / 295MB**）。设成毫秒数（如 `300000`）可省内存，但要接受"锁可能被 GUI 抢走" |
| `DSH_MCP_MAX_LIVE` | `8`（最坏约 2.5–4GB，见第 8 条） | ★ **最多同时保活几个会话进程**（`0` = 不限）。超标时回收**最久没用过**的（**在跑的回合绝不回收**）—— "**内存有界，锁尽量在手**"。内存紧用 `4`，机器大可以 `0`。用完想立刻全放掉：`dsh_release(all=true)` |
| `DSH_MCP_LIST_PROBE_TTL_MS` | `10000` | `dsh_list` 磁盘探测结果的缓存时长（探测要 spawn 一个 DSH 进程，实测约 1 秒） |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000`（7 天） | 启动时清理超过此时长的哨兵；`0` 关闭清理 |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | 未设置 | `1` 会把 `result.thinking` 一并写进哨兵（**打破"思考不落盘"的保证**） |
| `DSH_MCP_PERMISSION` | `danger-full-access` | `dsh_start` 未指定时的权限档 |
| `DSH_MCP_REASONING_EFFORT` | `max` | 默认思考深度 |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0`（不设超时） | **仅 `wait=true` 时**的等待上限；到期只转后台，不取消回合 |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | 待决审批的等待上限 |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_REQUEST_TIMEOUT_MS` | `60000` | ACP 通道单请求超时（initialize、session/new 等） |
| `DSH_MCP_REAP_INTERVAL_MS` | `30000` | 空闲回收器多久检查一次。低于安全下限的值会回落到默认值 |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | 未设置 | `1` 才转发 DSH 原始 stderr |

## 🧪 测试

```bash
node test/run.mjs          # 只跑冒烟（不消耗 token）
node test/run.mjs --all    # 全量
node test/cleanup.mjs      # 单独跑收尾清理（只针对临时目录；--dry-run 可预演）
```

测试套件**会自己收尾**：`run.mjs` 结束时必定执行 `cleanup.mjs`，它只清理**系统临时目录里**的测试会话与工作区登记，**绝不动**真实项目里的会话，也不动仓库的 `.state/`（那是你实际使用 MCP 时的会话注册表与哨兵）。要连桌面 `dsh-any-agent-test-*` 一起清，得显式跑 `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`。

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `smoke` | 29 | 握手、工具表、建会话、配置、注册表纯净性 |
| `boundary` | 42 | 协议边界（重复 initialize、脏行、未知方法）、参数校验、未知 id、游标边界、生命周期幂等、unicode |
| `integration` | 30 | 跨进程 resume 与记忆、中断、两种插话 |
| `async` | 16 | fire-and-forget + 事后验收 |
| `sentinel` | 36 | 完成哨兵：原子性、闩锁语义、多会话并发不串台、被取消也落地、**思考不进文件** |
| `prune` | 11 | **哨兵留存**：清超期与崩溃残留、留新、清空壳目录、`TTL=0` 关闭清理、且绝不碰同目录的会话注册表（不花 token，每次必跑） |
| `guards` | 31 | **环境变量守卫**：奇怪的数值一律压到安全侧 —— `IDLE_TTL_MS` 的 `-1`/非法值都当"永不回收"（绝不主动让出写锁）、回收间隔过小压回默认（防空转紧循环）、**失联阈值下限 30 秒**（防别的实例"合法地"抢占并杀掉我们的回合）（不花 token，每次必跑） |
| `sandbox-guard` | 18 | **测试沙箱自身**：「临时 HOME」如果落到真实用户目录、它的子目录、盘符根目录，或 OS 临时目录之外，一律报错拒绝，绝不被写入和删除。其余套件都通过 `test/sandbox-home.mjs` 拿目录、只销毁自己建的那个（不花 token，每次必跑） |
| `approval-details` | 24 | **审批审查上下文**：待决审批的快照带命令、理由、cwd 与原始审批 ID —— 不只是一个裸 ID，调用方才能真正裁决；凭据形状的字段与常见内联字面量在结构化上下文和展示标题里都会脱敏。经真实 stdio MCP 端到端验证 |
| `setup` | 41 | **注册 CLI**：预览不写盘、`--remove` 只摘自己那条、没装客户端算跳过不算失败、Codex TOML 段往返、以及把写进配置里的命令真的拉起一次并要求应答 `initialize`（不花 token） |
| `removal-scope` | 24 | **注销只动自己那条**：给一份装着别的 MCP 服务器、顶层 Codex 设置和 Zed 兄弟设置的配置，注册再注销，断言其余每个值逐字节不变；删一个从没写过的东西 = 无写入、无报错（不花 token） |
| `config-safety` | 403 | **0.3 这条线的核心性质**，逐客户端验证：预览后文件逐字节不变且不产生 `.bak`；注册再注销后其余条目逐字节还原、键顺序不变、顶层键不丢；4 空格 / 2 空格 / Tab 缩进、单行 JSON、无末尾换行、CRLF、UTF-8 BOM 都能在写入后保留；坏 JSON 与只读文件被拒绝且原文件无损；第二次 `--yes` 空跑不新增备份；每个 `.bak-dsh-<时间戳>` 只出现一次且内容等于写入前字节（不花 token） |
| `real-configs` | 66 | **拿真家伙做往返**：把本机**真实**的客户端配置复制进临时目录（18 万字节、含几百个 `projects` 条目与大小写重复键的 `~/.claude.json`，238 行的 Codex TOML，Zed 的完整 `settings.json`），注册再撤销，要求每个文件**逐字节**还原；CI 上没有这些文件时明确打印 `skipped`，绝不假绿（不花 token） |
| `timeout` | 38 | **超时语义**：`wait=false` 不受 `timeout_ms` 影响、`wait=true` 到期只转后台（不取消/不丢结果、`busy` 不说谎）、`timeout_ms<=0` 一直等、resume 失败会作废进程而不永久卡死、空 prompt 给清晰错误 |
| `lock` | 79 | **写锁与抢占**：四类持有者判定、`writeMarker` 不覆盖活着的持有者、登记文件损坏/目录缺失等边界；**端到端**两实例抢锁 → 清晰报错 → 拒绝 → `force` 夺锁；**崩溃自动释放锁**、**卡死持有者无 force 自动抢占**；以及"一个回合 = 一个哨兵"的不变量（含内联回合与空闲插话） |
| `cycle` | 36 | **异步派活的生命周期**：异步派活 → 收哨兵 → 空闲回收 → 再派活，连做 3 轮必须全程无锁错误；贴着回收窗口立刻重派（放大竞态）；`dsh_release` 后立刻重派；并断言回收后**不留下无法归因的锁**（这条实测抓到过"刚拉起的进程被 reaper 当空闲收掉"的竞态） |
| `concurrency` | 31 | 三会话并发 + 实时增量读 |
| `capability` | 22 | 写代码、跑脚本、**自行派子代理**（用磁盘上的子会话头验证） |
| `workspace-effect` | 24 | 不给路径时工作区是否真的生效 |
| `acceptance` | 36 | 两个文件夹 × 两个会话做只读 IDA Pro 分析 |
| `multi` | 19 | **多实例共存 + 非 ASCII 路径**：复现"两实例共写注册表 → 后写的把先建的会话抹掉"，并验证**仅凭 id 就能从会话存储找回并真的派活**；**兜底取回不会悄悄提权**（read-only 会话取回后仍是 read-only）；不留 `.tmp` 残渣；**中文 / emoji 工作区路径**能建会话、能干活、文件落在正确目录 |
| `permission` | 11 | ★ **权限档是否真的生效**（安全属性）：不看我们的返回值（那正是会说谎的地方），而是读**会话自己记录的事实**（投影缓存里的 `permissions.preset` / `sandboxMode`），三档逐一核对且三档记录值互不相同。**这条测试抓到过无声提权**：profile 里 `defaultPreset` 会在会话创建时盖掉 `DSH_PERMISSION_MODE` |
| `list` | 13 | **`dsh_list` 的开销**（实测驱动）：含磁盘探测的默认调用约 1 秒（要 spawn 一个 DSH 进程），**连续调用命中缓存降到个位数毫秒**；`only_running=true` 与 `include_closed=false` **跳过探测**且语义等价（不把磁盘上的未打开会话算进来） |

**离线那半边是 632 项检查，0.3.0 上全绿** —— `guards` 31、`prune` 11、`approval-details` 24、`sandbox-guard` 18、`setup` 41、`removal-scope` 24、`config-safety` 403、`real-configs` 66、`package-check` 14。九套全部退出码 0，都不需要模型、不需要装 DSH、也不需要 provider。

其中 **619 项属于客户端注册器套件**（`setup`、`removal-scope`、`config-safety`、`real-configs`）—— 0.3 的活其实都在这里。

需要模型的套件（`smoke` 29、`boundary` 42、`integration` 30、`async` 16、`sentinel` 36、`timeout` 38、`lock` 79、`cycle` 36、`concurrency` 31、`capability` 22、`workspace-effect` 24、`acceptance` 36、`multi` 19、`permission` 11、`list` 13）合计 462 项，**完整实测停在 0.1.2** —— 它们要可用 provider，发版前请自己重跑一遍：`node test/run.mjs --all`。

> 数字取各套件自己打印的汇总，不在这里手抄。`smoke`/`prune`/`guards`/`sandbox-guard`/`approval-details`/`boundary`/`setup`/`removal-scope`/`config-safety`/`package-check` 不调用模型；其余需要可用的 provider。

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

## 🔒 写锁：一个会话同一时刻只有一个写者

DSH 的会话有**跨进程写锁**：**持有者活着就永不过期，也没有 API 能从活的持有者手里夺走** —— 所以**谁先拿到就决定一切**。本服务把它做成"**你看得见，我们写得动**"：

| 情形 | 结论 |
|---|---|
| **本服务持有锁**（默认） | ✅ 你在 GUI 里点开它是**只读**的：**内容照看**，但**抢不走锁**。默认 `DSH_MCP_IDLE_TTL_MS=0`（永不回收）保证锁不会空出来 |
| **锁空着时你在 GUI 点开它** | ❌ **GUI 会永久持有它**（切走、等待、归档都不释放），本服务**再也接不回来**，只能重启 `dsh web` |
| **推荐做法** | 看进度用 **`dsh_read`**（游标增量读）或等**哨兵文件**；非要用 GUI 就先 `dsh_release`（会中断在跑的回合，适合任务间隙） |

**锁在谁手上**看 `dsh_status.lock_holder`，`dsh_takeover` 按四类分别处置：

| `lock_holder` | 含义 | 处置 |
|---|---|---|
| `self` | 本进程持有 | 无需抢占 |
| `stale-mcp` | 持有者**活着但已失联**（心跳 90 秒未续，典型是那个 MCP 卡死了） | ✅ `dsh_takeover` **自动杀掉并接管** |
| `live-mcp` | 另一个**活着**的 dsh-any-agent 实例在用 | ⚠️ 默认拒绝，`force=true` 才夺 |
| `none` | 无登记 → 多半是**你自己的 DSH GUI** | ❌ **绝不杀**（GUI 会话跑在 `dsh web` **单进程**里，杀它 = 整个界面连同其它 GUI 会话一起断），只报告 |

> **两条实测补充**：① **崩溃不会留下孤儿锁** —— `SIGKILL` 掉 MCP，它拉起的子进程随 stdio 管道关闭一起退出，锁自动释放 ✓；所以 `stale-mcp` 真正对应的是"**活着但卡死**"。② **多实例**：注册表是"整份文档、最后写入者获胜"（后保存的会抹掉它没见过的会话），但**会话存储才是权威** —— 只要会话在磁盘上，**仅凭 id 就能取回并派活**；若你给每个实例配了不同的 `DSH_MCP_STATE`，**务必把 `DSH_MCP_LOCKS_DIR` 指到同一处**，否则彼此看不见对方的持锁登记。
>
> 完整实测过程（A/B 探测方法、GUI"只读打开"的证据、为什么连归档都不释放、损坏与卡死怎么区分）见 [使用注意事项 §3.5–3.12](USAGE-NOTES.md)。

## ⚠️ 已知限制

1. **逐字流式进不了模型上下文** —— MCP 的固有限制，不是 DSH 的。调用方拿到的是分步结果；人能通过 stderr 日志跟进。
2. **真·中途改向做不到** —— ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`）。`dsh_interject` 是实用等价物：取消 + 立刻开新回合，历史保留。
3. **图片提示不支持** —— ACP 自报 `promptCapabilities: {image: false}`。
4. **MCP 服务重启会连坐** —— 本服务被重启/杀掉时，它拉起的 DSH 子进程会随 stdio 管道关闭一起退出：**进行中的回合会中断、哨兵不会落地**（此时要靠核对工作区状态判断，别干等哨兵）。好消息是**写锁会自动释放**，重启后总能拿回来。
   另注：本服务不会主动发 MCP 通知，"跑完通知"靠哨兵文件 + 调用方的后台等待任务实现。
5. **首次成功回合之前就死掉的会话可能尚未落盘** —— 此时 resume 会报清晰错误。发出第一条消息后就安全了。
6. **不能改名** —— DSH 的标题子系统没有对外改名接口（`SessionTitleService.rename` 需要进程内的活会话）。标题一律由首条消息自动生成。
7. **`session/list` 只返回 `{sessionId, cwd}`，且排除已打开的会话** —— 对话名由本服务从 DSH 投影缓存补全。
8. **默认"永不回收"要花内存（实测 300–480MB/会话）** —— 换来的是"GUI 抢不走写锁"。两次冷启动实测单个活跃会话新增常驻内存分别为 476MB 和 295MB（含 DSH 子进程与本服务），冷进程首次偏高。两种省内存办法：① **`DSH_MCP_MAX_LIVE`（默认 8**，超标就回收最久没用过的 → 内存有界 ✓ 锁仍尽量在手 ✓）；② 把 `DSH_MCP_IDLE_TTL_MS` 设成毫秒数（代价是锁可能被 GUI 拿走）。一批活干完想立刻归零：**`dsh_release(all=true)`** ✓（无损，之后照样 resume）。

## ❓ 为什么 profile 还叫 `dsh-mcp`？

因为改名会打断一堆已经落盘的东西。

本服务首次启动时会在 `~/.dsh/profiles/dsh-mcp/` 建一个 DSH profile。这个目录名被另外三样持久化标识引用着：

| 持久标识 | 位置 | 改名的后果 |
|---|---|---|
| profile 目录 | `~/.dsh/profiles/dsh-mcp/` | 已有会话解析不到 provider（`no adapter registered for provider "…"`） |
| `DSH_MCP_*` 环境变量 | 你的客户端配置 | 所有部署都得同时改 |
| `# dsh-mcp:managed` 标记行 | 生成的 `cordis.patch.yml` 首行 | bootstrap 不再认它是自己写的，从此不再同步 |

所以**产品名**是 `dsh-any-agent`，**持久标识**故意保留旧名。这是刻意的兼容决定，不是漏改。如果你是全新部署、想要别的 profile 名，直接设 `DSH_MCP_PROFILE` —— 服务会照你给的名字用。

## 📦 发布流程

发版清单。顺序有讲究 —— 其中两步是因为跳过它们发过一次坏版本才补上的。

```bash
# 1. 升版本号。SERVER_VERSION 读的是 package.json，别处不用改
#    （以前这里有两份数字，漂移过）
npm version patch --no-git-tag-version
#    然后手工改 CHANGELOG.md：把 [Unreleased] 变成新版本一节

# 2. 本地跑一遍离线套件（和 CI 相同，不花 token、不需要 DSH）
node test/guards.mjs && node test/prune.mjs
node test/approval-details.mjs && node test/setup.mjs
node test/package-check.mjs

# 3. 确认 tarball 本身：打得出来、装得上、起得来
npm pack --dry-run
#    再在临时目录里：npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. 打 tag 并推送（CI 绿了再发）
git add -A && git commit -m "chore: release x.y.z"
git tag vx.y.z && git push origin main --tags

# 5. 发布
npm publish
```

**发布后看到 404，不要当成失败。** npm 对新版本是异步入库（返回 `PUT 202` 而不是 `200`），几秒后去查 registry 仍然是 404，看起来像没发成功。先确认本地 npm 日志里有这一行：

```
grep 'http fetch PUT 202' "$LOCALAPPDATA/npm-cache/_logs/<最新的>.log"
```

然后等一两分钟再查 `npm view dsh-any-agent dist-tags`。
