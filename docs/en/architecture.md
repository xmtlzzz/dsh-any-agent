> Back to [README](../../README.md)

# ⚡ Why not just wrap the DSH CLI?

DSH ships two programmable entry points. The `sdk` profile looks simpler, but its JSON-RPC surface has only **3 requests and 4 notifications** — and it lacks three things that make an agent unusable in practice. The `acp` profile (Agent Client Protocol) has all of them. Everything below was verified against DSH `0.2.1-rc.5`.

| Capability | `sdk` profile | `acp` profile (**this project**) |
|---|---|---|
| **Resume a conversation** | ❌ no resume method; reusing an id fails with `already exists` | ✅ `session/resume` — verified **across processes** |
| **Interrupt a running turn** | ❌ only by killing the process | ✅ `session/cancel` — the same path as the user's own stop button |
| **Answer approval prompts** | ❌ no channel; operations silently fail closed | ✅ `session/request_permission` round-trip |
| List / close sessions | ❌ none | ✅ `session/list`, `session/close` |
| Gray vs. black streaming | one message, split by a `type` field | ✅ two separate channels: `agent_thought_chunk` / `agent_message_chunk` |
| Per-session MCP servers | ❌ process-wide | ✅ `mcpServers` accepted by `session/new` and `session/resume` |

**Core idea: the process is a cache, not the identity.** A conversation's identity is DSH's `sessionId`, persisted under `~/.dsh/sessions`. If the process is reaped, crashes, or the whole MCP server restarts, the next call transparently `session/resume`s it — history intact.

<details>
<summary>How the clients, server and DSH connect</summary>

```
  any MCP client                       ← Claude Code, Codex, Cursor, Zed, Cline, your own…
  (Claude/Codex/Cursor/…)              │
         │ MCP over stdio              │ newline-delimited JSON-RPC (ACP)
         ▼                             ▼
   ┌─────────────┐            ┌──────────────────────────┐
   │dsh-any-agent│───────────▶│ dsh --profile dsh-mcp    │  one long-lived process
   └─────────────┘            │                          │  per conversation
                              └────────────┬─────────────┘
                                           │
                              ┌────────────┴─────────────┐
                              │ DSH's own tools          │ files, shell, search,
                              │                          │ skills, subagents, workflows
                              ├──────────────────────────┤
                              │ dsh-mcp-client           │ → your other MCP servers
                              └──────────────────────────┘
```

**MCP compatibility.** The server uses only `initialize`, `ping`, `tools/list` and `tools/call`. It has also been verified with a bare-bones client that negotiates an older protocol version and never sends `notifications/initialized`.

</details>
