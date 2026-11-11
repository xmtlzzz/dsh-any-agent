> Back to [README](../../README.md)

# ⚠️ Known limitations

1. **No token-level streaming into model context** — an MCP limitation, not DSH's. Callers get per-step results; humans can follow progress via stderr logs.
2. **True mid-turn steering is impossible** — ACP rejects concurrent prompts (`a prompt is already in flight for this session`). `dsh_interject` is the practical equivalent: cancel, then immediately start a new turn, history preserved.
3. **Image prompts are unsupported** — ACP advertises `promptCapabilities: {image: false}`.
4. **Restarting the MCP server takes its children with it (by default)** — when this service is restarted or killed, the DSH children it spawned exit too (their stdio is a pipe to us; on Windows the client's job object kills the whole tree): **in-flight turns are interrupted**, and files they changed are not rolled back. An interrupted turn still gets a sentinel (`status: "error"`, `stop_reason: "interrupted"`): on a normal shutdown the service writes it before exiting; when killed outright, the turn's `<run_id>.running` marker lets the next server process that starts write it (only when the owning PID is gone or was reused), so a background waiter wakes only once a server starts again. The good news: the **write lock is released automatically**, so a restart always gets it back. **To keep turns running across client restarts, set `DSH_MCP_DAEMON=1`**: the process the client launches only forwards, and turns run in a detached resident process that outlives the client (it still goes away if the whole desktop app that owns the job is closed, or when the machine restarts). The service also pushes no MCP notifications; "completion notification" is the sentinel file plus the caller's background waiter.
5. **A conversation that dies before its first successful turn may never have materialized on disk** — resume then fails with a clear error. Safe after the first message.
6. **No renaming** — DSH's title subsystem has no external rename API (`SessionTitleService.rename` requires a live in-process session). Titles are auto-generated from the first message.
7. **`session/list` returns only `{sessionId, cwd}` and excludes already-open sessions** — titles are filled in by this server from DSH's projection cache.
8. **Memory (measured 300–480 MB per live process)** — since 0.5.0 sessions with the same `(cwd, permission)` **share one ACP process by default**, so that cost is once per group rather than once per conversation; combined with the 0.4.0 defaults (**10-minute idle reaping + `MAX_LIVE=4`**) the worst case is ≈1.2–1.9 GB. `keep_alive=true` sessions are exempt from idle reaping (at the cost of staying resident). You can also: ① cap by measured RSS with `DSH_MCP_MAX_RSS_MB`; ② cap the child heap with `DSH_MCP_CHILD_MAX_OLD_SPACE_MB`. To drop to zero right after a batch of work: **`dsh_release(all=true)`** ✓ (releases idle conversations; busy turns are skipped and keep running — pass `force=true` to interrupt them too. Everything resumes on demand).
9. **A shared process takes its group down with it** — the default shared host puts sessions with the same `(cwd, permission)` on one PID. Sessions do not interfere with each other (each has its own Agent and context), but **if the process crashes or is killed, every in-flight turn in the group dies at once** (error sentinels are written and waiters wake up; each session resumes on its next call — the conversation itself is intact). Hence: ① `dsh_takeover` requires `force=true` to kill such a process, and lists the other sessions riding on it; ② for strict isolation (untrusted samples, mutually untrusted tasks) set `DSH_MCP_SHARED_PROCESS=0`; ③ different workspaces or permission tiers still get separate processes — that follows from `dsh-base`'s process-wide sandbox and approval config, not a choice.
10. **Live view (`watch` / `dashboard`) boundaries** —
   ① **local only**: events are written to this machine's `$DSH_HOME/.dsh-any-agent/live/`, so remote or cloud sessions are not visible;
   ② **read-only**: you cannot approve, interject or interrupt from the page — use the MCP tools (`dsh_approval_decide` / `dsh_interject` / `dsh_interrupt`);
   ③ **only tool calls reported over ACP are visible**: whether a DSH subagent's internal calls are reported is up to DSH, and this server does not infer them;
   ④ **token numbers come from DSH's session record**: before DSH writes them the panel shows no data, and session totals include runs from before the live view;
   ⑤ **no backfill**: runs before 0.6.1 have no call chain, and runs before 0.6.2 have no token data.

## ❓ Why is the profile still called `dsh-mcp`?

Because renaming it would break things that already exist on disk.

When you first start this server it creates a DSH profile under `~/.dsh/profiles/dsh-mcp/`. That directory name is referenced by three other persisted things:

| Persisted identifier | Location | What breaks if renamed |
|---|---|---|
| profile directory | `~/.dsh/profiles/dsh-mcp/` | existing sessions can no longer resolve their provider (`no adapter registered for provider "…"`) |
| `DSH_MCP_*` environment variables | your client configs | every deployment must change at once |
| `# dsh-mcp:managed` marker line | first line of the generated `cordis.patch.yml` | bootstrap no longer recognizes the file as its own and stops syncing it |

So the **product name** is `dsh-any-agent`, while the **on-disk identifiers** deliberately keep the old name — `dsh-mcp` is what this server was called in [Deepseek-DSH-MCP](https://github.com/Moer2831/Deepseek-DSH-MCP), the project it started from. This is a compatibility decision, not an oversight. For a fresh deployment that wants a different profile name, set `DSH_MCP_PROFILE` — the server will use the name you give it.
