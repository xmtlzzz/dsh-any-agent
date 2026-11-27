> 返回 [README](../../README.zh.md)

# ⚡ 为什么不是直接把 DSH 包一层

存储格式常量在 `src/dsh-contract.mjs` 中集中定义。`dsh_storage` 只读检查工作区格式并抽样会话日志文件名。`src/fs-atomic.mjs` 使用同目录临时文件替换目标文件。工作区登记在读改写期间持有 `$DSH_HOME/.dsh-any-agent/workspace-registry.lock`，并在同一目录暂存锁。共享宿主的 RSS 只在其所有会话均可回收时计入释放量。

DSH 自带两个可编程入口。`sdk` profile 看着更简单，但它的 JSON-RPC 只有 **3 个请求 + 4 个通知**，缺了三样让 agent 实际不可用的能力；`acp` profile（Agent Client Protocol）全都有。以下结论全部针对 DSH `0.2.1-rc.5` 实测得出。

| 能力 | `sdk` profile | `acp` profile（**本项目**） |
|---|---|---|
| **恢复会话** | ❌ 无 resume 方法，复用 id 报 `already exists` | ✅ `session/resume`，**跨进程实测通过** |
| **中断回合** | ❌ 只能杀进程 | ✅ `session/cancel`，与用户手动按停止同一条路径 |
| **应答审批** | ❌ 无通道，操作静默 fail-closed | ✅ `session/request_permission` 往返 |
| 列出 / 关闭会话 | ❌ 无 | ✅ `session/list`、`session/close` |
| 灰字 vs 黑字 | 同一条消息里靠 `type` 字段分 | ✅ 两条独立通道 `agent_thought_chunk` / `agent_message_chunk` |
| 每会话 MCP 服务器 | ❌ 进程级 | ✅ `session/new` 与 `session/resume` 都接受 `mcpServers` |

**核心思想：进程只是缓存，不是身份。** 对话的身份是 DSH 的 `sessionId`，落盘在 `~/.dsh/sessions`。进程被回收、崩溃、甚至整个 MCP 服务重启，下一次调用都会自动 `session/resume` 把它接回来，历史完整保留。

<details>
<summary>客户端、服务端与 DSH 是怎样连接的</summary>

```
  任意 MCP 客户端                    ← Claude Code、Codex、Cursor、Zed、Cline、你自己写的…
  (Claude/Codex/Cursor/…)            │
         │ MCP over stdio            │ 换行分隔 JSON-RPC（ACP）
         ▼                           ▼
   ┌─────────────┐          ┌──────────────────────────┐
   │dsh-any-agent│─────────▶│ dsh --profile dsh-mcp    │  同 (cwd, 权限) 的会话
   └─────────────┘          │ (team on → dsh-team)     │  共用一个长驻进程
                            └────────────┬─────────────┘  （0.5.0 起默认共享进程）
                                         │
                            ┌────────────┴─────────────┐
                            │ DSH 自带工具             │ 文件/shell/搜索/
                            │                          │ 技能/子代理/workflow
                            ├──────────────────────────┤
                            │ dsh-mcp-client           │ → 你自己的其他 MCP 服务器
                            └──────────────────────────┘
```

**进程模型。** 会话的身份是 `sessionId`，进程只是可丢弃的载体。0.5.0 起同一 `(cwd, permission)` 的会话默认共用一个 ACP 进程（`src/host.mjs`）：DSH 的 ACP 服务端支持一条连接上多会话、每个 session 有自己的 Agent，但沙箱根与审批策略是**进程级**的，所以只能按这两项分组。收益是第二个会话建起来约 300ms（独立进程约 4s），内存也按组只付一份；代价是这**一个**进程崩了，组里所有会话的进行中回合会一起断（会话本体无损，下次派活各自 resume）——因此 `dsh_takeover` 不会在不带 `force` 的情况下杀共享进程。要回到「一会话一进程」就设 `DSH_MCP_SHARED_PROCESS=0`。

**常驻进程模式（`src/daemon.mjs`，`dsh-any-agent-setup --yes` 默认开启 `DSH_MCP_DAEMON=1`）。** 客户端拉起的是极薄的转发进程，通过带令牌校验的本机命名管道 / Unix socket 连向 detached 常驻进程；配置（`DSH_*`、语言、`*_KEY`/`*_TOKEN`/`*_SECRET`、`*_PROXY` 及 `team` 设置）相同的客户端连接共用同一个 `Hub`，客户端退出或重连不会打断在跑回合。可用 `dsh-any-agent daemon status|stop` 查看与优雅关闭（经本机控制通道触发 `hub.shutdown()`，仅在无响应且核实 PID 的系统启动时间与记录相符后才发送 `SIGTERM`），加 `--no-daemon` 退回直连 stdio。

**实时查看（0.6.1 起）。** 直连模式下每个 MCP 客户端各自拉起独立的 stdio 实例，常驻模式下同配置连接共享一个 `Hub`、不同配置仍可能并存多个实例。因此实时查看统一走文件而不是端口：各个服务端把会话活动（回合、工具调用、审批、token 用量）按连接附带的客户端身份追加到 `<状态目录>/live/<会话id>/events.jsonl`。写锁本来就保证一个会话同一时刻只有一个写者，所以"一会话一文件"不需要再加锁。`dsh-any-agent watch` 和 `dsh-any-agent dashboard` 是独立的只读进程，tail 这些文件，因此在直连与常驻模式下都能同时看到所有客户端、所有实例派出的活，服务重启也不丢，并且完全不碰写锁和 DSH：

```
 MCP 客户端 ─▶ dsh-any-agent（每个客户端一个）──追加──▶ live/<id>/events.jsonl
                                                                │ tail（只读）
                                                  ┌─────────────┴─────────────┐
                                          dsh-any-agent watch        dsh-any-agent dashboard
                                          （终端，原地刷新）          （127.0.0.1 + token，SSE）
```

token 数字取自 DSH 自己的投影缓存（`tokenUsage` / `contextPressure`），DSH 每走一个模型步就会更新它。设计细节见 [实时查看设计](live-view-design.md)。

**MCP 兼容性。** 服务端支持 `ping`、`tools/list` 和 `tools/call`。旧版客户端通过 `initialize` 握手，可通过 `roots/list` 提供工作区。MCP `2026-07-28` 用 `server/discover` 发现服务，通过显式 `cwd` 指定工作区。已用一个协商旧版协议、从不发送 `notifications/initialized` 的原始客户端验证。

</details>

[回合存储模块](../../src/run-store.mjs)负责收据、结果检查点和完成文件的读写，并在恢复时识别旧格式。[Hub](../../src/hub.mjs) 管理活跃会话，在为中断回合生成审核记录时提供会话权限。

[Conversation](../../src/conversation.mjs) 控制派发、中断和收尾顺序。[实时事件跟踪器](../../src/conversation-live.mjs)负责工具事件去重，并根据每个回合开始时的基线计算 token 用量。延迟收尾的回合只能结算自己的用量。
