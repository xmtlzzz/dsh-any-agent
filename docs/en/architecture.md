> Back to [README](../../README.md)

# ⚡ Why not just wrap the DSH CLI?

Storage constants live in `src/dsh-contract.mjs`. The read-only `dsh_storage` check inspects the workspace schema and samples session log filenames. `src/fs-atomic.mjs` replaces files using same-directory temporary files. Workspace writers hold a lock across each update. Eviction credits a shared host’s RSS only when all its sessions can be released.

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
   │dsh-any-agent│───────────▶│ dsh --profile dsh-mcp     │  sessions with the same
   └─────────────┘            │ (dsh-team when team on)   │  (cwd, permission) share
                              └────────────┬──────────────┘  one process (default since 0.5.0)
                                           │
                              ┌────────────┴─────────────┐
                              │ DSH's own tools          │ files, shell, search,
                              │                          │ skills, subagents, workflows
                              ├──────────────────────────┤
                              │ dsh-mcp-client           │ → your other MCP servers
                              └──────────────────────────┘
```

**Process model.** A conversation's identity is its `sessionId`; the process is a disposable carrier. Since 0.5.0, sessions with the same `(cwd, permission)` share one ACP process by default (`src/host.mjs`): DSH's ACP server accepts multiple sessions per connection, each with its own Agent, but the sandbox root and approval policy are **process-wide**, so grouping can only follow those two. The win: the second session costs ≈300 ms instead of a ≈4 s cold start, and memory is paid once per group. The price: if that one process dies, every in-flight turn in the group dies with it (the conversations themselves are intact and resume on the next call) — which is why `dsh_takeover` refuses to kill a shared process without `force`. Set `DSH_MCP_SHARED_PROCESS=0` for one process per conversation.

**Resident daemon mode (`src/daemon.mjs`, enabled by default via `dsh-any-agent-setup --yes` with `DSH_MCP_DAEMON=1`).** The process spawned by the MCP client acts as a thin forwarding proxy over an authenticated local named pipe / Unix socket to a detached resident daemon. Client connections with matching identity (`DSH_*`, locale vars, `*_KEY`/`*_TOKEN`/`*_SECRET`, `*_PROXY`, and `team` settings) share one `Hub`, keeping in-flight turns alive across client closes and reconnects. Use `dsh-any-agent daemon status|stop` to inspect or gracefully stop daemons (requesting `hub.shutdown()` over the authenticated local control channel, falling back to `SIGTERM` only if unresponsive), or `--no-daemon` for direct stdio.

**Live view (since 0.6.1).** In direct stdio mode each client spawns a separate server instance; in daemon mode matching configurations share one `Hub` while differing configurations still run separate instances. Live viewing therefore goes through files rather than a socket: each server appends conversation activity (runs, tool calls, approvals, token usage, tagged with the calling connection's client identity) to `<state dir>/live/<conversation_id>/events.jsonl`. The write lock already guarantees one writer per conversation, so one file per conversation needs no extra locking. `dsh-any-agent watch` and `dsh-any-agent dashboard` are separate read-only processes that tail those files, so in both modes they show work from every client and every instance at once, survive server restarts, and never touch the write lock or DSH:

```
 MCP clients ─▶ dsh-any-agent (one per client) ──append──▶ live/<id>/events.jsonl
                                                                  │ tail (read-only)
                                                   ┌──────────────┴──────────────┐
                                          dsh-any-agent watch          dsh-any-agent dashboard
                                          (terminal, in place)         (127.0.0.1 + token, SSE)
```

Token numbers are read from DSH's own projection cache (`tokenUsage` / `contextPressure`), which DSH updates after every model step. Design notes: [live view design](live-view-design.md).

**MCP compatibility.** The server uses only `initialize`, `ping`, `tools/list` and `tools/call`. It has also been verified with a bare-bones client that negotiates an older protocol version and never sends `notifications/initialized`.

</details>

The [run store](../../src/run-store.mjs) writes receipts, checkpoints and completion files. It also reads older run formats during recovery. The [hub](../../src/hub.mjs) owns the live sessions and supplies their permission when an interrupted turn needs a review record.

[Conversation](../../src/conversation.mjs) controls dispatch, cancellation and finalization. Its [live event tracker](../../src/conversation-live.mjs) deduplicates tool updates and measures token use against each run’s starting values. A late finalization can flush usage only for its own run.
