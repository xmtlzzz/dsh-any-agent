> 返回 [README](../../README.zh.md)

# 📦 前置要求

- **Node.js ≥ 22.15** —— 服务用 `node:zlib` 的 `zstdDecompressSync` 读 DSH 会话头，这个 API 在 22.15 之前不存在
- **已安装 DSH**（`@deepseek-ai/dsh`），且 `~/.dsh` 下已有可用的 provider 与凭据（GUI 能正常聊天即可）

> 本服务**不自带** provider 配置，也**从不**接收或保存 API 密钥。

## 🚀 安装配置

### 1. 让 profile 自己就绪（通常无需手工操作）

> 📌 **为什么还叫 `dsh-mcp`？** 本服务起步于 [Deepseek-DSH-MCP](https://github.com/Moer2831/Deepseek-DSH-MCP)，在那里叫 `dsh-mcp`；现已改名 **dsh-any-agent**，但 DSH profile 名、`DSH_MCP_*` 环境变量、`# dsh-mcp:managed` 标记行都**故意保留旧名**。它们是已落盘的稳定标识符：改了会让现存 profile、会话和你的客户端配置一起失联。这是刻意的向后兼容，不是漏改。

首次拉起 DSH 时，[`src/bootstrap.mjs`](../../src/bootstrap.mjs) 会自动：

1. 在 `$DSH_HOME/profiles/dsh-mcp/` 建一个基于出厂 `acp` 模板的 profile；
2. 从本机**已有**的 profile（`$DSH_HOME/cordis.patch.yml` → `desktop` → `web` → `headless` → `acp` 取第一个有配置的）复制模型路由；
3. 写 `acp`、`agent-default-model` 与三档 `permission` presets（**不写 `defaultPreset`**，否则会覆盖权限档），让 ACP 会话用与 GUI 相同的模型，并让 read-only 真正生效。

复制的内容只有 `apiKeyEnv` / `baseURL` / `api` / `models` / `reasoningEfforts`；`apiKey`（适配器从不读取的死字段）与 `headers`（可能夹凭据）一律剥掉。凭据本身由 DSH 的凭据服务逐次请求解析，路径与 GUI 完全一致。

想要的来源不是自动挑的那个，可设 `DSH_MCP_ROUTE_SOURCE=desktop`（或 `__home__`）；彻底关掉自动同步则设 `DSH_MCP_BOOTSTRAP=0`。

<details>
<summary>手工维护 profile 与 ACP 配置细节（可选）</summary>

### 1b. 手工维护（可选）

```bash
dsh --profile dsh-mcp --from-default-profile acp
```

然后编辑 `~/.dsh/profiles/dsh-mcp/cordis.patch.yml`，**并删掉文件开头的 `# dsh-mcp:managed` 行** —— 有那行时本服务每次启动都会按来源重新生成，手改会被覆盖。可以从 [`profile-example/cordis.patch.yml`](../../profile-example/cordis.patch.yml) 起步。

> ⚠️ **这里有两个坑**（都是踩出来的）：
>
> 1. **ACP 的模型不走 `agent-default-model`**，而是读 `dsh-acp` 插件自己的 `config.provider` / `config.model` —— 而 `acp` bundle 把它硬编码成了 `deepseek-official`。不覆盖 `acp` 这一行，会话会静默跑在错误的 provider 上，报 `no API key for provider route "deepseek-official"`。
> 2. **ACP 的 `reasoning_effort` 默认是空串**（= "Provider default"），不是最大档。本服务在每次 `session/new` 以及每次 `session/resume` 之后都会显式设成 `max` —— 因为新进程不会记住上一次的选择。

</details>

### 2. 注册 MCP 服务

执行[快速开始](../../README.zh.md#快速开始)中的三条命令，再重新连接客户端。需要手工配置时，可展开下方的客户端示例。

`setup` 会找出你机器上的 MCP 客户端 —— **Claude Code、Claude Desktop、Codex、Cursor、Windsurf、Zed、Gemini CLI、Antigravity、opencode、VS Code** —— 逐个写进去，没装的跳过。它的安全性是结构性保证的：

- **默认 dry-run**，必须加 `--yes` 才写；预览模式下**不启动任何子进程**，只读取它将要触及的那些文件
- 每个文件写前备份成 `<file>.bak-dsh-<时间戳>`，内容是**写入前的原始字节**
- 写入前后各解析一次，坏配置绝不落盘；坏 JSON 与只读文件一律拒绝而不是硬写，目录不存在则安全创建
- **文本级写入**：只替换自己那个条目的字节，缩进（2 空格 / 4 空格 / Tab）、键顺序、CRLF 行尾、UTF-8 BOM、有无末尾换行都原样保留
- **幂等**，重复运行只改变有差异的部分；第二次 `--yes` 不写盘、不新增 `.bak`
- **装一次再卸掉，回到安装前**：`--remove` 以安装前的备份为准 —— 你原本就有的空容器（如 `"mcpServers": {}`）留着，我们加的容器一并收掉；文件里除了我们那条什么都没有、安装前也不是这样时（典型情况是 `--force` 新建的文件），先备份再删掉文件，不留空壳

**实测影响范围（2026-11-02，本机 plan 模式）：** 9 个客户端中检测到 5 个（Claude Code、Codex、Cursor、Zed、VS Code），其余 4 个跳过；`--json` 报告 `mode=plan, changed=5, skipped=4, failed=0`。所有已存在客户端配置的 SHA-256、大小与 mtime **全部未变**。真正执行 `--yes` 也是增量写入：只写 `dsh-any-agent` 这一个条目，其余字节原样保留，写前先落一份 `.bak-dsh-<时间戳>`；`--remove` 也只删这一个条目。

```bash
dsh-any-agent-setup --yes --only cursor,zed     # 只装这几个
dsh-any-agent-setup --yes --permission read-only
dsh-any-agent-setup --remove --yes               # 全部移除，只摘自己那条
```

<details>
<summary>高级开关与各客户端的配置路径</summary>

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
| Antigravity（`antigravity`） | `~/.gemini/config/mcp_config.json`（IDE 与 CLI 共用）；只有旧版本的 `~/.gemini/antigravity/mcp_config.json` 存在、新文件不存在时写旧文件。两个都没有时，凭 `~/.gemini/antigravity` 或 `~/.gemini/antigravity-cli` 目录判定已安装 | `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |
| opencode（`opencode`） | `~/.config/opencode/opencode.json` | `mcp` | 只增 / 改自己那条，且按 opencode 的形状写：`{ type: "local", command: [exe, ...args], enabled: true }` —— 一个数组，不是分开的 `command`/`args` | 删掉自己那条 | 把备份复制回去 |
| VS Code（`vscode`） | Windows `%APPDATA%\Code\User\mcp.json`；其他平台是 VS Code 用户目录下的同名 `mcp.json` | `servers` —— **不是** `mcpServers` | 只增 / 改自己那条 | 删掉自己那条 | 把备份复制回去 |

具体路径以 `--json` 输出里每个客户端的 `path` 字段为准 —— 那是本次运行在你这个系统上真正要写的文件，比任何文档都准。

有三种形状值得单独点出来，写错了是**静默失效**。**VS Code** 的 MCP 配置放在 `servers` 下，不是 `mcpServers`；按常见写法写进去，编辑器会直接忽略。**opencode** 用的是**一个** `command` 数组（`{ type: "local", command: [exe, ...args], enabled: true }`），不是分开的 `command`/`args`。**Claude Code** 则是本次发布**完全不用 JSON 库**的原因：`~/.claude.json` 的 `projects` 映射里确实存在**只差大小写**的重复键（`.../Rust` 和 `.../rust` 并存），朴素的 `JSON.parse` 在那里会失败，而任何整份重写都会毁掉用户的项目列表。所以改用按字符区间扫描、**从不构造值对象**的扫描器；早先那版「调 `claude mcp add`」也出于同样理由被放弃 —— 那条命令会用它自己的格式重写整个文件，且不产生我们可以回滚的备份。

</details>

<details>
<summary>注册器检查与注册、撤销的往返验证</summary>

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

这些断言的详细覆盖见 [`test/`](../../test/)（`test/config-safety.mjs` 共 407 项，逐条断言上面每一条）。

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

</details>

**`cwd` 可以省略：默认用客户端当前打开的项目**

客户端本来就知道用户在哪个目录干活（MCP roots）。现在 `dsh_start` 不传 `cwd` 时，会向客户端发一次 `roots/list`，把返回的 `file://` URI 转成路径直接用。于是「客户端里看到哪个项目，DSH 就在哪个项目干活」成了默认行为，也顺带堵掉了「手拼路径拼到家目录」这条最常见的翻车路径。客户端不声明 roots、或者超时没回，就退回一条能照着改的报错，而不是猜一个目录。

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

<details>
<summary>移除操作的实测记录</summary>

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

</details>

**记录的是绝对路径**

`setup` 写进去的是它运行时所处安装目录的**绝对路径**。**如果你移动或删除了那个目录，所有客户端都会报 `CONNECTION_CLOSED`**，直到你在新位置重新跑一遍 `setup`，或者用 `--remove` 把失效条目清掉。

最容易踩到的情况：装到临时目录里试用，然后清理掉 —— 配置还指着那个已经不存在的路径。

<details>
<summary>手工配置客户端：Claude Code、Codex 与通用 MCP</summary>

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

> Cursor、Windsurf、Cline、Continue 等大部分客户端都吃同一套 `mcpServers` 结构——只要能拉起 stdio MCP 服务，就能用。Zed 是例外：它用 `context_servers`（见上方示例）。

</details>

### 3. 自检

```bash
dsh-any-agent --version      # 打印版本，不启动任何东西
dsh-any-agent --help         # 参数、关键环境变量、文档链接
node test/smoke.mjs          # 不调用 LLM，验证整条管道
```
