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
   │dsh-any-agent│───────────▶│ dsh --profile dsh-team   │  sessions with the same
   └─────────────┘            │                          │  (cwd, permission) share
                              └────────────┬─────────────┘  one process (default since 0.5.0)
                                           │
                              ┌────────────┴─────────────┐
                              │ DSH's own tools          │ files, shell, search,
                              │                          │ skills, subagents, workflows
                              ├──────────────────────────┤
                              │ dsh-mcp-client           │ → your other MCP servers
                              └──────────────────────────┘
```

**Process model.** A conversation's identity is its `sessionId`; the process is a disposable carrier. Since 0.5.0, sessions with the same `(cwd, permission)` share one ACP process by default (`src/host.mjs`): DSH's ACP server accepts multiple sessions per connection, each with its own Agent, but the sandbox root and approval policy are **process-wide**, so grouping can only follow those two. The win: the second session costs ≈300 ms instead of a ≈4 s cold start, and memory is paid once per group. The price: if that one process dies, every in-flight turn in the group dies with it (the conversations themselves are intact and resume on the next call) — which is why `dsh_takeover` refuses to kill a shared process without `force`. Set `DSH_MCP_SHARED_PROCESS=0` for one process per conversation.

**MCP compatibility.** The server uses only `initialize`, `ping`, `tools/list` and `tools/call`. It has also been verified with a bare-bones client that negotiates an older protocol version and never sends `notifications/initialized`.

</details>
