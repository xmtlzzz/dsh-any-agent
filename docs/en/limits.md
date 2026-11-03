> Back to [README](../../README.md)

# ⚠️ Known limitations

1. **No token-level streaming into model context** — an MCP limitation, not DSH's. Callers get per-step results; humans can follow progress via stderr logs.
2. **True mid-turn steering is impossible** — ACP rejects concurrent prompts (`a prompt is already in flight for this session`). `dsh_interject` is the practical equivalent: cancel, then immediately start a new turn, history preserved.
3. **Image prompts are unsupported** — ACP advertises `promptCapabilities: {image: false}`.
4. **Restarting the MCP server takes its children with it** — when this service is restarted or killed, the DSH children it spawned exit too (their stdio is a pipe to us): **in-flight turns are interrupted and no sentinel lands** (judge by inspecting the workspace, don't just wait for the file). The good news: the **write lock is released automatically**, so a restart always gets it back. The service also pushes no MCP notifications; "completion notification" is the sentinel file plus the caller's background waiter.
5. **A conversation that dies before its first successful turn may never have materialized on disk** — resume then fails with a clear error. Safe after the first message.
6. **No renaming** — DSH's title subsystem has no external rename API (`SessionTitleService.rename` requires a live in-process session). Titles are auto-generated from the first message.
7. **`session/list` returns only `{sessionId, cwd}` and excludes already-open sessions** — titles are filled in by this server from DSH's projection cache.
8. **Memory (measured 300–480 MB per active conversation)** — since 0.4.0 the defaults are **10-minute idle reaping + `MAX_LIVE=4`**, so the worst case is ≈1.2–1.9 GB; `keep_alive=true` sessions are exempt from idle reaping (at the cost of staying resident). You can also: ① cap by measured RSS with `DSH_MCP_MAX_RSS_MB`; ② cap the child heap with `DSH_MCP_CHILD_MAX_OLD_SPACE_MB`; ③ set `DSH_MCP_SHARED_PROCESS=1` to share one ACP process across sessions with the same `(cwd, permission)` (experimental: saves memory and cold start, but a crash takes down the group). To drop to zero right after a batch of work: **`dsh_release(all=true)`** ✓ (releases idle conversations; busy turns are skipped and keep running — pass `force=true` to interrupt them too. Everything resumes on demand).

## ❓ Why is the profile still called `dsh-mcp`?

Because renaming it would break things that already exist on disk.

When you first start this server it creates a DSH profile under `~/.dsh/profiles/dsh-mcp/`. That directory name is referenced by three other persisted things:

| Persisted identifier | Location | What breaks if renamed |
|---|---|---|
| profile directory | `~/.dsh/profiles/dsh-mcp/` | existing sessions can no longer resolve their provider (`no adapter registered for provider "…"`) |
| `DSH_MCP_*` environment variables | your client configs | every deployment must change at once |
| `# dsh-mcp:managed` marker line | first line of the generated `cordis.patch.yml` | bootstrap no longer recognizes the file as its own and stops syncing it |

So the **product name** is `dsh-any-agent`, while the **on-disk identifiers** deliberately keep the old name. This is a compatibility decision, not an oversight. For a fresh deployment that wants a different profile name, set `DSH_MCP_PROFILE` — the server will use the name you give it.
