> 返回 [README](../../README.zh.md)

# 🧑‍🤝‍🧑 团队模式（按需开启）

**0.5.0 起默认关闭。** 需要时用一条命令开启，不用手改客户端配置。

开启后默认切到 `dsh-team` profile。DSH `0.2.2-rc.2` 起，新会话会启用共享任务板和普通子代理工具。恢复会话时，DSH 保留已保存的团队状态。

DSH `0.1.7-rc.1` 至 `0.2.2-rc.1` 使用实验版团队工具。`dsh_send` 会在派发前提示按需组队。

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
3. 调用 `dsh_doctor`，`team` 检查应为 `on`，并注明使用 DSH 会话团队模式还是实验版团队模式。

## 关闭

```bash
dsh-any-agent team off
```

重连后，新会话默认回到 `dsh-mcp`。已保存的原生团队状态可在 DSH 界面按会话关闭。自定义 profile 里的团队设置也由该 profile 的维护者控制。

实验版可用 `dsh_send(team=false)` 关闭本次派发的组队提示。

## 优先级与排查

生效值的优先级：

1. 环境变量 `DSH_MCP_TEAM`（`1` / `0`）—— **最高**；
2. `settings.json` 的 `team` 字段；
3. 默认关闭。

如果客户端配置里还留着旧版本写下的 `DSH_MCP_TEAM`，它会覆盖 `team on/off`。
`dsh-any-agent team status` 会显示来源（`env` / `file` / `default`）；
`team on/off` 检测到环境变量时也会提示。

## 注意

- 升级到 `0.2.2-rc.2` 或更新的 DSH 后，受管团队 profile 会在启动 DSH 时迁移。自定义 profile 需移除实验版团队插件配置，恢复标准子代理工具，并在原生 `agent-team` 条目的 `config` 中设置 `defaultEnabled: true`。
- 团队配置与 DSH 版本不兼容时，`dsh_doctor` 会给出提示。未显式指定 profile 时，服务回到 `dsh-mcp`。
