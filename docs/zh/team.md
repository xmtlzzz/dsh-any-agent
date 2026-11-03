> 返回 [README](../../README.zh.md)

# 🧑‍🤝‍🧑 团队模式（0.4.0 默认开）

默认 profile 是 `dsh-team`：首次启动自动创建，包含实验性 Agent Teams，并关闭旧的 `subagent` 工具。
`dsh_send` 会在调用方的 prompt 前注入一句"需要并行/多角色时先建团队"；简单任务不会被强制组队。

## 三种关闭方式

| 想做什么 | 怎么做 | 效果 |
|---|---|---|
| **全局关闭** | 在 MCP 客户端的服务条目里加 `DSH_MCP_TEAM=0`，重连 | 回到 `dsh-mcp` profile；没有 team 工具；不注入提示 |
| **只关这一次** | `dsh_send(..., team=false)` | profile 仍是 `dsh-team`；agent 仍有 team 工具；只是这次不提示它组队 |
| **换 profile** | `DSH_MCP_PROFILE=<name>` | 服务会检查该 profile 是否真的含 team 包；不含就自动不注入 |

> 注意：`DSH_MCP_PROFILE` 显式设置时优先级最高。如果你把它指向 `dsh-team`，只设
> `DSH_MCP_TEAM=0` 不会移除 profile 里的 team 工具；要彻底关闭，把 `DSH_MCP_PROFILE`
> 也改成 `dsh-mcp`（或删掉这个变量）。

## 具体步骤（以 Claude Code 为例）

### 1. 找到注册条目

```bash
claude mcp get dsh-any-agent
```

会显示注册在哪个 scope、命令是什么。也可以直接看：

- 用户级：`~/.claude.json` 里的 `mcpServers.dsh-any-agent`
- 项目级：项目根目录的 `.mcp.json` 里的 `mcpServers.dsh-any-agent`

### 2. 在条目里加 env

只追加 `DSH_MCP_TEAM`，不要覆盖已有的其它 env：

```json
{
  "mcpServers": {
    "dsh-any-agent": {
      "command": "npx",
      "args": ["-y", "dsh-any-agent"],
      "env": {
        "DSH_MCP_TEAM": "0"
      }
    }
  }
}
```

### 3. 重连服务

MCP 服务的 env 只在进程启动时读一次，所以必须让客户端重新拉起它：

- Claude Code：`/mcp` → `dsh-any-agent` → reconnect；或重启 Claude Code。
- 其它客户端：重启客户端，或在其 MCP 面板里 disconnect/reconnect。

### 4. 验证

调用一次 `dsh_start`，返回里应该出现：

```
团队模式: 关（DSH_MCP_TEAM=0 或 DSH < 0.1.7）
```

或调用 `dsh_doctor`，`config` 检查里应该是：

```
profile=dsh-mcp team=off
```

这时 `dsh_send` 也不会再注入"【团队】…"那句提示。

## 各客户端的 env 写法

| 客户端 | 位置 | 写法 |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `"env": { "DSH_MCP_TEAM": "0" }` |
| Cursor | `~/.cursor/mcp.json` | 同上 |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | 同上 |
| Codex | `~/.codex/config.toml` | `[mcp_servers.dsh-any-agent.env]` 下写 `DSH_MCP_TEAM = "0"` |
| VS Code | `.vscode/mcp.json` | `"env": { "DSH_MCP_TEAM": "0" }` |
| opencode | 其 MCP 配置 | 字段名是 `environment` |
| Zed | `settings.json` 的 `context_servers` | 其 `command.env` 下写 `DSH_MCP_TEAM` |

## 注意

- 团队模式要求 DSH `>= 0.1.7-0`；版本不够会自动退回 `dsh-mcp`，即使设了 `DSH_MCP_TEAM=1` 也不会启用。
- team profile 会关闭旧的 `subagent` 工具，换成 9 个团队工具；成员共享一个工作区。
- 团队是**实验性**能力，DSH 不提供稳定性承诺；不要在关键路径上假定它永远可用。
- 不需要删 `~/.dsh/profiles/dsh-team`；关闭后它只是不被使用。想彻底清理再删即可。

## 恢复

把 `"DSH_MCP_TEAM": "0"` 删掉（或改成 `"1"`），重新连接即可回到默认的团队模式。
