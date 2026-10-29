# dsh-any-agent 使用说明

> **完整文档**：[github.com/xmtlzzz/dsh-any-agent](https://github.com/xmtlzzz/dsh-any-agent)
> **English**：[README.md](https://github.com/xmtlzzz/dsh-any-agent/blob/main/README.md) · **中文**：[README.zh.md](https://github.com/xmtlzzz/dsh-any-agent/blob/main/README.zh.md)
> **npm**：[`dsh-any-agent`](https://www.npmjs.com/package/dsh-any-agent)

本文件只讲一件事：**在一台新机器上，怎么把它接进你正在用的 agent 并跑通第一轮对话。**
原理、工具详解、写锁机制、环境变量全表都不在这里 —— 那些在上面的 GitHub README 里。

---

## 0. 它是什么（30 秒版）

一个 **MCP 服务端**，把 DeepSeek Harness (DSH) 变成一个**可长期共事的后台编码 agent**，供任何支持 stdio 的 MCP 客户端调用。

它**不是** DSH 的替代品，也**不携带任何 API 密钥**：模型与凭据完全复用你本机已有的 DSH 配置。

```
你的 agent ──MCP(stdio)──▶ dsh-any-agent ──ACP──▶ dsh --profile dsh-mcp
                           (本项目)                    (常驻进程，每个会话一个)
```

---

## 1. 前置条件

| 项目 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **≥ 20** | `node -v` |
| DSH | 已安装且**能正常聊天** | 打开 DSH，随便发一句 |
| provider 与凭据 | 已配好，写进 `~/.dsh/.credentials.yaml` 或环境变量 | 见下 |

> ⚠️ **顺序不能反。** 本服务**不自带** provider 配置，也不能替你填密钥。
> 它首次启动时会去**复制**你已有 profile 的模型路由。如果 DSH 本身还没配好，第一次调用会失败并报
> `no adapter registered for provider "…"`。

### 1.1 确认 DSH 的位置

本服务需要一个明确的 DSH 入口路径。**自动探测只找两处**：npx 缓存、npm 全局安装目录。
如果你用的是 **DSH 桌面版（Electron）**，探测不到，必须手动指定：

```powershell
# 找一下你机器上 DSH 的入口文件
Get-ChildItem "$env:USERPROFILE\AppData\Local\npm-cache\_npx" -Recurse -Filter bin.js -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '@deepseek-ai[\\/]dsh[\\/]lib' } | Select-Object -First 1 -ExpandProperty FullName

# npm 全局安装的情况
npm root -g
```

记下这个路径，下一步要用（下称 `<DSH_BIN>`，形如
`C:/Users/you/AppData/Local/npm-cache/_npx/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`）。

---

## 2. 安装

### 方式 A：从 npm（推荐）

```powershell
npm install -g dsh-any-agent
```

装完 `dsh-any-agent` 就在 `PATH` 上。

### 方式 B：从本迁移包（离线 / 免联网）

把本目录解压到**长期保留**的位置（例：`D:\Tools\dsh-any-agent`），双击 `install.cmd`。
它只做三件事：建 profile 骨架、生成 `state/`、把 Codex 配置里的对应段替换掉（原配置备份为
`config.toml.bak-dsh-<时间戳>`）。**不询问也不需要任何密钥。**

> 移动目录后必须重新运行 `install.cmd` 更新绝对路径。

---

## 3. 接进你的 agent

所有客户端本质上是同一件事：**告诉它去哪里启动这个 stdio 服务**。
下面按客户端给出现成配置块，直接复制。

> 🔑 **通用要点**：如果 `dsh-any-agent` 不在 `PATH` 上（或你想用指定的 Node），
> 把 `command` 换成 node 的绝对路径、`args` 换成 `<安装目录>/bin/dsh-any-agent.mjs`。

### 3.1 Claude Code

```bash
# 全局安装的情况
claude mcp add dsh-any-agent -- dsh-any-agent

# 指定 DSH 入口（强烈建议显式给，避免探测失败）
claude mcp add dsh-any-agent -e DSH_BIN=<DSH_BIN> -- dsh-any-agent
```

### 3.2 Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.dsh-any-agent]
command = "dsh-any-agent"
args = []
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0

[mcp_servers.dsh-any-agent.env]
DSH_BIN = "<DSH_BIN>"
DSH_MCP_PERMISSION = "workspace-write"
DSH_MCP_APPROVAL = "ask"
DSH_MCP_LOG = "silent"
```

> 从迁移包安装的话，这段由 `install.cmd` 自动写入，不用手抄。

### 3.3 Cursor / Windsurf / Cline / Continue / Zed（JSON 型通用）

大多数客户端用同一套 `mcpServers` 结构。文件位置各异，通常是：

- Cursor：`~/.cursor/mcp.json` 或项目内 `.cursor/mcp.json`
- Cline / Continue：客户端设置里的 MCP Servers 面板
- Zed：`~/.config/zed/settings.json` 的 `context_servers`

```json
{
  "mcpServers": {
    "dsh-any-agent": {
      "command": "dsh-any-agent",
      "args": [],
      "env": {
        "DSH_BIN": "<DSH_BIN>",
        "DSH_MCP_PERMISSION": "workspace-write",
        "DSH_MCP_APPROVAL": "ask"
      }
    }
  }
}
```

### 3.4 其他任意 MCP 客户端

只要能启动 stdio MCP 服务就行。它只实现四个标准方法
（`initialize` / `ping` / `tools/list` / `tools/call`），
不依赖任何宿主专有扩展 —— 连协议版本协商到旧版、不发 `notifications/initialized` 的客户端都测过。

### 3.5 装完先验证

重启客户端，然后确认它发现了服务。各客户端查看方式不同，Codex 是：

```powershell
codex mcp list      # 应看到 dsh-any-agent ... enabled
```

> 最后一列显示 `Unsupported` 是 **Auth 列**（表示不支持 OAuth），不是错误；
> 同表里 `codex_app`、`cua_repl` 也都是这个值。看 **Status 列 = enabled** 即可。

---

## 4. 跑通第一轮对话

服务暴露 11 个 `dsh_*` 工具。最小闭环只有三步：

```
1. dsh_start(cwd="D:/你的/项目目录")
     → conversation_id

2. dsh_send(conversation_id, prompt="列出这个项目的目录结构", wait=false)
     → run_id + sentinel_file        ← 立刻返回，任务在后台跑

3. dsh_get(conversation_id, run_id)   ← 回头取结果
```

**`cwd` 必须是本机已存在的绝对路径**，否则建会话会失败。

### 关于 `wait`

| 场景 | 用哪个 |
|---|---|
| 几十秒内能做完的小活 | `wait=true`，直接拿结果 |
| 可能跑几分钟以上 | `wait=false`（默认），拿 `sentinel_file`，用你自己 agent 的后台任务等这个文件出现 |

`wait=true` 超时也**不会丢结果** —— 只会降级成后台继续跑，返回里会给你哨兵文件路径。

### 首次启动会发生什么

第一次调用时，本服务会自动：

1. 在 `~/.dsh/profiles/dsh-mcp/` 建一个基于出厂 `acp` 模板的 profile；
2. 从你**已有**的 profile 里复制模型路由（`$DSH_HOME/cordis.patch.yml` → `desktop` → `web` → `headless` → `acp`，取第一个有内容的）；
3. 把 `acp` 行与 `agent-default-model` 写成同一份路由。

复制的内容只有 `apiKeyEnv` / `baseURL` / `api` / `models` / `reasoningEfforts` 这些**路由声明**；
`apiKey`（适配器从不读取的死字段）与 `headers`（可能夹凭据）一律丢弃。**真正的密钥不经过本服务。**

生成的文件首行带 `# dsh-mcp:managed`：

- **有这行** → 每次启动按来源重新生成（幂等）；你在 DSH GUI 里改的模型选择会被复位成来源 profile 的选择。
- **删掉这行** → 视为你手工维护，从此不再自动改写。

想固定来源：设 `DSH_MCP_ROUTE_SOURCE=desktop`（指定 profile 名）
或 `DSH_MCP_ROUTE_SOURCE=__home__`（只认 `~/.dsh/cordis.patch.yml`）。想彻底关掉自动同步：`DSH_MCP_BOOTSTRAP=0`。

---

## 5. 新环境常见故障

| 现象 | 原因 | 解法 |
|---|---|---|
| `no adapter registered for provider "…"` | profile 还没建，或来源 profile 没有可用路由 | 确认 DSH 本身能聊天；删掉 `~/.dsh/profiles/dsh-mcp/cordis.patch.yml` 让它重新生成 |
| `DSH CLI 入口未找到` | 自动探测只查 npx 缓存和 npm 全局 | 显式设 `DSH_BIN` 指向 `@deepseek-ai/dsh/lib/bin.js` |
| 首次调用很慢（十几秒） | 要拉起 DSH 进程 + 建 profile | 正常，第二次起就快了 |
| 工具列表里没有 `dsh_*` | 客户端没启动服务 | 看客户端的 MCP 日志；确认 `command` 路径正确 |
| 会话报写锁被占 | 你在 DSH GUI 里打开过同一个会话 | GUI 的写锁**切走也不释放**。用 `dsh_read` 看进度，或先 `dsh_release` |
| `timeout` 后没结果 | 误以为超时取消了 | 超时只转后台，用返回的 `sentinel_file` 或 `dsh_get` 取 |

### 权限档怎么选

`DSH_MCP_PERMISSION` 默认 `danger-full-access`（零摩擦）。建议按用途改：

| 档位 | 适用于 |
|---|---|
| `danger-full-access` | 自己的项目，追求速度 |
| `workspace-write` | **推荐默认**，越界操作会变成待批审批 |
| `read-only` | 分析不信任的样本（配合 `DSH_MCP_APPROVAL=auto-deny`） |

`DSH_MCP_APPROVAL` 三选一：`auto-allow` / `auto-deny` / `ask`。
`ask` 时待决审批会出现在 `dsh_status` 里，用 `dsh_approval_decide` 裁决。

> ⚠️ **用本服务驱动的会话，不要同时在 DSH GUI 里打开。** 光是"点开"就会被 GUI 拿走写锁且不释放。
> 要看进度用 `dsh_read`；真要在 GUI 里看，先 `dsh_release`。

---

## 6. 卸载

1. 从客户端配置里移除 `dsh-any-agent` 那一段（Codex 是 `[mcp_servers.dsh-any-agent]` 及其 `.env` 子表）。
2. npm 全局安装：`npm uninstall -g dsh-any-agent`；迁移包：直接删解压目录。
3. 可选：删 `~/.dsh/profiles/dsh-mcp/`（保留也无害，只是不再使用）。
4. 你的 DSH 凭据、会话历史**不受影响**，本服务从未写入过它们。

---

## 7. 本迁移包里有什么

| 路径 | 内容 |
|---|---|
| `server/` | 源码、测试、文档、MIT 许可证 |
| `runtime/` | 已安装的完整 DSH 依赖（离线用） |
| `node/` | Windows x64 Node 22.19.0 |
| `profile-template/` | profile 骨架，**不含**任何 provider 或密钥 |
| `install.cmd` / `setup.mjs` | 路径配置与客户端注册（不处理密钥） |
| `verify.cmd` / `verify.mjs` | 不调用模型的管道自检 |

本包**不含**任何 API 密钥、凭据文件、会话、附件、日志或工作区登记。

> `SHA256SUMS.txt` 覆盖的是最初导出版本；后续本地改动（v0.2 的去密钥化、改名 dsh-any-agent）不在校验范围内，重新分发前请重算。

---

## 8. 更多

- 工具详解、写锁、并发、思考内容控制、全部环境变量 → [README.zh.md](https://github.com/xmtlzzz/dsh-any-agent/blob/main/README.zh.md)
- 踩坑合集（ACP 模型陷阱、外部 MCP 绕过沙箱、GUI 注册表缓存、成本控制）→ [USAGE-NOTES.md](https://github.com/xmtlzzz/dsh-any-agent/blob/main/USAGE-NOTES.md)
- 许可证：MIT，`Copyright (c) 2026 xmtlz`
