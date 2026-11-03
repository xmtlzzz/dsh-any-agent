> 返回 [README](../../README.zh.md)

# 🧑‍🤝‍🧑 团队模式（按需开启）

**0.5.0 起默认关闭。** 需要时用一条命令开启，不用手改客户端配置。

开启后：profile 切到 `dsh-team`（含实验性 Agent Teams，关闭旧的 `subagent` 工具），
`dsh_send` 会在 prompt 前注入一句"需要并行/多角色时先建团队"；简单任务不会被强制组队。

## 命令

```bash
dsh-any-agent team on       # 开启（写 settings.json）
dsh-any-agent team off      # 关闭
dsh-any-agent team status   # 查看当前生效值、来源、profile
```

`team on/off` 写入 `<DSH_HOME>/.dsh-any-agent/settings.json` 的 `team` 字段，
**不改任何客户端配置**。改完需要**重连 MCP 服务**（或重启客户端）才会生效。

## 开启步骤

1. 运行：

   ```bash
   dsh-any-agent team on
   ```

2. 重连 MCP 服务：Claude Code 用 `/mcp` → `dsh-any-agent` → reconnect；
   其它客户端重启或在 MCP 面板里 reconnect。
3. 验证：调用 `dsh_start`，返回里应该出现：

   ```
   团队模式: 开（profile=dsh-team；派发时会提示"需要时先建团队"，简单任务不会组队）
   ```

   或调用 `dsh_doctor`，`team` 检查应为 `on`。

## 关闭

```bash
dsh-any-agent team off
```

重连后 profile 回到 `dsh-mcp`，没有 team 工具，也不注入提示。

**单次关闭**（只这一次不提示组队，profile 仍是 `dsh-team`）：

```
dsh_send(..., team=false)
```

## 优先级与排查

生效值的优先级：

1. 环境变量 `DSH_MCP_TEAM`（`1` / `0`）—— **最高**；
2. `settings.json` 的 `team` 字段；
3. 默认关闭。

如果客户端配置里还留着旧版本写下的 `DSH_MCP_TEAM`，它会覆盖 `team on/off`。
`dsh-any-agent team status` 会显示来源（`env` / `file` / `default`）；
`team on/off` 检测到环境变量时也会提示。

## 注意

- 团队模式要求 DSH `>= 0.1.7-0`；版本不够时即使 `team on` 也不会启用，
  `dsh_doctor` 会把它标成 `warn`。
- team profile 会关闭旧的 `subagent` 工具，换成 9 个团队工具；成员共享一个工作区。
- 团队是**实验性**能力，DSH 不提供稳定性承诺。
- 不需要删 `~/.dsh/profiles/dsh-team`；关闭后它只是不被使用。
