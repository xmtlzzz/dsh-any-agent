> 返回 [README](../../README.zh.md)

# ⚡ 为什么不是直接把 DSH 包一层

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

**MCP 兼容性。** 服务端只使用 `initialize`、`ping`、`tools/list`、`tools/call` 四个标准方法。已用一个协商旧版协议、从不发送 `notifications/initialized` 的原始客户端验证。

</details>
