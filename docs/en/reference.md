> Back to [README](../../README.md)

# ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_BIN` | auto-detected | Path to `@deepseek-ai/dsh/lib/bin.js` |
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
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000` (7 days) | Startup pruning age for sentinels; `0` disables pruning |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | unset | `1` writes `result.thinking` into the sentinel (**breaks the never-on-disk guarantee**); answer/error/title/tool inputs are still credential-redacted |
| `DSH_MCP_PERMISSION` | `workspace-write` | Default tier for `dsh_start`. `danger-full-access` additionally requires `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `DSH_MCP_ALLOW_FULL_ACCESS` | `0` | Whether `permission=danger-full-access` is allowed. Denied by default: it hands the caller whole-machine write access |
| `DSH_MCP_REASONING_EFFORT` | `max` | Default reasoning effort |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0` (no timeout) | Wait bound for **`wait=true` only**; on expiry the turn merely moves to the background |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_GIT_STATUS` | on | `0` disables the per-turn `git status` summary. Useful for untrusted repos (git can run repo-configured fsmonitor/filters outside DSH's sandbox) |
| `DSH_MCP_BACKUP_KEEP` | `20` | How many `.bak-dsh-*` copies to keep per client config (rotation is best-effort) |
| `DSH_MCP_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout on the ACP channel (initialize, session/new, …) |
| `DSH_MCP_REAP_INTERVAL_MS` | `30000` | How often the idle reaper checks for conversations to reclaim. Values below the safe floor fall back to the default |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | unset | `1` forwards DSH's raw stderr |
