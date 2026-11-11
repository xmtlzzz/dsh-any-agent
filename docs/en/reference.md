> Back to [README](../../README.md)

# ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_BIN` | auto-detected (desktop app → npm global → npx cache) | Explicit path to `@deepseek-ai/dsh/lib/bin.js` (may point inside the desktop app's `app.asar`) |
| `DSH_RUNTIME` | auto | Explicit executable that launches DSH (e.g. a Node 24). Used with `DSH_BIN`, or on its own for auto-discovered npm global / npx installs (their `engines.node` is re-checked against it); the desktop app always keeps its bundled runtime (only it can read the asar). Unset: the desktop app's bundled runtime, otherwise this server's node |
| `DSH_HOME` | `~/.dsh` | DSH home shared with the GUI (credentials, sessions, workspace registry). Point it elsewhere only for isolation/multi-account |
| `DSH_MCP_PROFILE` | `dsh-mcp` (`dsh-team` when team is on) | DSH profile to drive; an explicit value wins |
| `DSH_MCP_TEAM` | `0` (off) | Team mode, opt-in. `dsh-any-agent team on` writes the settings file; this env var overrides it. When on, uses the `dsh-team` profile and injects a "form a team when needed" line before `dsh_send`; per call use `dsh_send(team=false)` |
| `DSH_MCP_SETTINGS` | `$DSH_HOME/.dsh-any-agent/settings.json` | Settings file written by `dsh-any-agent team on/off` |
| `DSH_MCP_BOOTSTRAP` | on | Whether this server may create/sync the DSH profile on first start. `0` makes it drive an existing profile only and never write a file |
| `DSH_MCP_ROUTE_SOURCE` | unset | Pin where model routes are copied from during bootstrap: a profile name (`desktop`, `web`, …) or `__home__` for `$DSH_HOME/cordis.patch.yml`. Unset = try home → desktop → web → headless → acp |
| `DSH_MCP_STATE` | `$DSH_HOME/.dsh-any-agent/conversations.json` | Conversation registry, survives restarts. The old `<repo>/.state` location is migrated once on startup |
| `DSH_MCP_APPROVAL` | `auto-allow` (non-read-only) | Default approval policy. `ask` makes out-of-workspace requests surface as pending approvals instead of being auto-allowed |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | How long a pending `ask` approval waits before being cancelled |
| `DSH_MCP_FORGOTTEN_DIR` | `$DSH_HOME/.dsh-any-agent-forgotten` | Tombstones written by `dsh_release(forget=true)` |
| `DSH_MCP_RUNS_DIR` | `<state file dir>/runs` | Root for async completion sentinels (`<this>/<conversation_id>/<run_id>.json`) |
| `DSH_MCP_LOCKS_DIR` | `<state file dir>/locks` | Holder registrations for the write lock. ⚠️ **All instances must agree on this value**, or they cannot see each other's registrations and will misread each other as an unidentifiable holder (a GUI) and refuse to preempt |
| `DSH_MCP_LOCK_STALE_MS` | `90000` (3× `REAP_INTERVAL_MS`, floor 30 s) | How long without a heartbeat before a holder counts as lost (and becomes auto-preemptible by `dsh_takeover`); changing the reap interval changes the derived default |
| `DSH_MCP_IDLE_TTL_MS` | `600000` (10 minutes) | How long a conversation may sit idle before its DSH process is reaped. **Default 10 minutes**: the memory is released and the next call resumes the conversation transparently; the cost is that the write lock goes free and the GUI may take it. Set `0` to never reap (hold the lock forever; ~300–480 MB per conversation), or use `dsh_start(keep_alive=true)` for the specific sessions that must stay attached |
| `DSH_MCP_MAX_LIVE` | `4` (≈1.2–1.9 GB worst case) | ★ **How many conversation processes to keep alive at once** (`0` = unlimited). Going over the cap reaps the **least recently used** one (a running turn is never reaped). `keep_alive=true` sessions are exempt. To free idle conversations at once: `dsh_release(all=true)` (busy turns are skipped unless `force=true`) |
| `DSH_MCP_MAX_RSS_MB` | `0` (off) | Global child-process memory budget in MB. When the measured RSS exceeds it, idle conversations are reaped least-recently-used first; `keep_alive` sessions are reaped last |
| `DSH_MCP_CHILD_MAX_OLD_SPACE_MB` | `0` (unset) | Appends `--max-old-space-size` to each DSH child's `NODE_OPTIONS`. A backstop for runaway contexts; too small will OOM long conversations |
| `DSH_MCP_SHARED_PROCESS` | `1` (on) | **On by default**: sessions with the same `(cwd, permission)` share one ACP process. Large memory and cold-start win (measured: second `session/new` ≈300 ms vs ≈4 s standalone), and `dsh_doctor` de-dupes RSS by PID. Trade-off: a process crash takes down the whole group (error sentinels are written; each session resumes on the next call), so `dsh_takeover` requires `force=true` to kill such a process. Set `0` for one process per conversation |
| `DSH_MCP_AUDIT_FILE` | empty (off) | Metadata audit JSONL path. Records events, conversation/run ids, decisions and counts; **never** prompts, answers, thinking or tool input. Rotates at 10 MB |
| `DSH_MCP_LIST_PROBE_TTL_MS` | `10000` | Cache lifetime for `dsh_list`'s on-disk probe (the probe spawns a DSH process and takes ~1 s) |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000` (7 days) | Startup pruning age for sentinels **and review records**; `0` disables pruning |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | unset | `1` writes `result.thinking` into the sentinel (**breaks the never-on-disk guarantee**); answer/error/title/tool inputs are still credential-redacted |
| `DSH_MCP_UPDATE_CHECK` | `1` | Whether `dsh_doctor` asks npm for a newer version (only when doctor is called; requests this package's latest only; 4 s at most; cached 24 hours). `0` = no network |
| `DSH_MCP_SENTINEL_TOOL_INPUTS` | `1` | `0` = sentinels carry no tool inputs (commands, paths, written file contents); each tool keeps its name, status and `input_chars`. `dsh_get` from memory is unaffected |
| `DSH_MCP_REVIEW` | `advisory` | Caller-review policy. `advisory` (default) attaches a review ticket (checklist + evidence + `dsh_review` entry) to every result and sentinel **without blocking later sends**; `off` disables automatic tickets. Per-conversation/per-send overrides use the `review` argument |
| `DSH_MCP_REVIEWS_DIR` | `<state file dir>/reviews` | Where review verdicts are written (`<this>/<conversation_id>/<run_id>.review.json`). Must be writable, or startup fails loudly |
| `DSH_MCP_LIVE` | `detail` | Live event stream level (the data behind `watch` / `dashboard`). `detail` adds redacted prompt / command / path previews; `meta` keeps tool names, status, timing and approval kinds only; `off` writes nothing. Reasoning is never written at any level |
| `DSH_MCP_LIVE_DIR` | `<state file dir>/live` | Live event stream directory (`<this>/<conversation_id>/events.jsonl`, rolled to `.1` at 5 MB). Write failures are skipped silently and never affect a run; pruned by `DSH_MCP_SENTINEL_TTL_MS` |
| `DSH_MCP_LANG` | follows the system | Language, `zh` or `en`. It covers two things: the `watch` / `dashboard` interface, and the text the caller sees — tool titles, tool and parameter descriptions, the server instructions and what a tool returns (a few less common error messages are still Chinese only). When unset: `LC_ALL` / `LC_MESSAGES` / `LANG`, then the OS locale; the `--lang` flag wins over it |
| `DSH_MCP_PERMISSION` | `workspace-write` | Default tier for `dsh_start`. `danger-full-access` additionally requires `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `DSH_MCP_ALLOW_FULL_ACCESS` | `0` | Whether `permission=danger-full-access` is allowed. Denied by default: it hands the caller whole-machine write access |
| `DSH_MCP_REASONING_EFFORT` | `max` | Default reasoning effort |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0` (no timeout) | Wait bound for **`wait=true` only**; on expiry the turn merely moves to the background |
| `DSH_MCP_WATCHDOG_AFTER_MS` | `900000` (15 min) | How long into a turn the watchdog starts judging whether it is stuck. `0` = no stall check |
| `DSH_MCP_STALL_MS` | `600000` (10 min) | How long with no progress at all (answer, thinking, tool status or usage updates from DSH) counts as stuck; 3× while a tool is running, never while waiting on the caller's approval decision. A stuck turn gets `session/cancel` (same as `dsh_interrupt`) and its result carries `watchdog` |
| `DSH_MCP_TURN_MAX_MS` | `7200000` (2 h) | Total duration cap for one turn, **regardless of progress** (catches a turn looping while it keeps producing output). `0` = no cap |
| `DSH_MCP_DAEMON` | off | `1` = resident process mode: the process the client launches only forwards, and conversations, DSH processes and running turns live in one detached resident process, so closing, reconnecting or crashing the client no longer interrupts a turn. Clients with the same configuration share one resident process. `dsh-any-agent-setup --yes --daemon` writes it into the client configs |
| `DSH_MCP_DAEMON_IDLE_MS` | `600000` (10 min) | How long the resident process waits with no clients connected and no turn running before it exits. `0` = never exits on its own |
| `DSH_MCP_WORKTREES_DIR` | `<state dir>/worktrees` | Where `dsh_start(isolation="worktree")` puts its worktrees |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_GIT_STATUS` | on | `0` disables the per-turn `git status` summary. Useful for untrusted repos (git can run repo-configured fsmonitor/filters outside DSH's sandbox) |
| `DSH_MCP_BACKUP_KEEP` | `20` | How many `.bak-dsh-*` copies to keep per client config (rotation is best-effort) |
| `DSH_MCP_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout on the ACP channel (initialize, session/new, …) |
| `DSH_MCP_REAP_INTERVAL_MS` | `30000` | How often the idle reaper checks for conversations to reclaim. Values below the safe floor fall back to the default |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | unset | `1` forwards DSH's raw stderr |
