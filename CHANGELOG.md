# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `test/sandbox-home.mjs` + `test/sandbox-guard.mjs` (18 checks) — a test
  sandbox can no longer point at real user data. The guard refuses the real
  `home`, its subdirectories, case variants, the filesystem root, and any path
  outside `os.tmpdir()`; `setup` and `removal-scope` now create and destroy
  their HOME only through this module and fail if they go back to calling
  `mkdtempSync`/`rmSync` directly.
- `test/removal-scope.mjs` — 24 checks proving unregistering touches only
  its own entry. Given configs holding unrelated MCP servers, top-level Codex
  settings (`model`, `approval_policy`, `sandbox_mode`) and Zed settings
  (`theme`, `vim_mode`, a sibling `context_servers` child), it registers and
  then removes, and asserts every other value is byte-identical afterwards.
  Also covers removing something that was never there: no error, no write.
- README (both languages): a table for install / update / remove / undo, the
  measured before-after of `--remove` per client, and an explicit note that
  `--remove` does **not** uninstall the package.
- `dsh-any-agent-setup --help` now states that only one entry per client is
  added and exactly that entry is removed, that other MCP servers are never
  read or rewritten, and that the recorded path is absolute — moving or
  deleting the installation leaves clients reporting `CONNECTION_CLOSED`
  until setup is re-run from the new location.

### Fixed

- **A throwaway verification script deleted parts of the operator's real
  home directory.** Not a bug in `setup` — a bug in the harness used to
  verify it. The script kept its sandbox path in `$home`, which is a
  read-only automatic variable in PowerShell; with
  `$ErrorActionPreference = 'Continue'` the failed assignment was silent, so
  `$env:USERPROFILE` still pointed at the intended sandbox name while the
  cleanup line `Remove-Item $home -Recurse -Force` resolved to the real
  profile. Three runs, each killed by a 120 s timeout mid-delete, removed part
  of `~/.codex`, `~/.cursor` and `~/.claude` (the package's own config
  entries survived; user data around them did not).

  Evidence it was a sandbox-escape rather than a write: stray
  `~/.cursor/mcp.json.bak-dsh-*` files contained the fixture the script had
  written (`{"mcpServers":{"keep":...}}`), i.e. it was writing to the real
  profile. `sandbox-guard` now makes that impossible to do silently.

## [0.1.2] — 2026-10-29

One-line fix, but it decides whether `dsh-any-agent-setup` can register
Claude Code on Windows at all.

### Fixed

- **Registration with Claude Code failed on any path containing a space.**
  `process.execPath` is `C:\Program Files\nodejs\node.exe` on a default
  Windows install, and setup passed it to the `claude` CLI through a shell
  without quoting. cmd split the argument:

      Command: C:\Program
      Args:    Files\nodejs\node.exe D:\...\bin\dsh-any-agent.mjs

  Nothing reported an error. `claude mcp add` exited 0, and the JSON written
  to the config was correct — the only symptom was `CONNECTION_CLOSED` when
  Claude Code tried to start the server. Cursor, Zed and Codex were unaffected
  because they receive a JSON/TOML value rather than a shell argument.
  Arguments containing whitespace are now quoted.

### Added

- `test/setup.mjs` grew a ninth group that closes the gap which let the above
  through: it takes the entry setup just wrote, spawns it exactly as a client
  would, and requires a valid `initialize` response. Every earlier check
  asserted file contents; none asked whether the command in that file runs.
  35 → 41 checks.

### Documented

- **What setup does and does not touch**, with before/after counts measured on
  a machine holding real MCP servers: Cursor 4→5 entries, Codex 2→3 sections,
  Claude Code 5→6 servers, Zed 33→33 keys, every pre-existing entry unchanged.
  Also states the one thing that does change: JSON configs are re-serialised,
  so values are preserved but whitespace is not.
- **A release checklist**, including the two traps hit while shipping 0.1.0
  and 0.1.1 — npm returning 202 while the registry still 404s for a minute,
  and shields.io serving five-minute-stale badges (`license: package not
  found` is its generic failure text, not a missing licence) — plus the
  `npm deprecate` step for a broken published version and the fact that it
  requires interactive OTP and therefore cannot run in CI.

## [0.1.1] — 2026-10-29

A correctness release. Two of the fixes matter if you are on Node 20 or were
relying on `dsh-any-agent-setup` to preview before writing.

### Fixed

- **`engines` was wrong: this needs Node ≥ 22.15, not ≥ 20.** `src/workspace.mjs`
  imports `zstdDecompressSync` from `node:zlib` to read DSH session headers;
  that API does not exist before 22.15, and a named import of a missing export
  is a load-time error. On Node 20 the server exited with code 1 before it
  could answer a single request, and `package.json` had been telling people
  Node 20 was fine. Both `engines` and the README now say 22.15.
- **`dsh-any-agent-setup` wrote files during a dry run.** Every writer path
  called the backup-and-write helper unconditionally and only *reported*
  "would write" afterwards, so a preview run with no `--yes` modified the
  client configs it found and left `.bak-dsh-*` files behind. The Claude Code
  path shelled out to `claude mcp add` during the preview, which writes
  immediately. All three paths now return a preview and stop before touching
  disk, and a dry run performs no subprocess that can mutate state.
- **Claude Code registration broke on paths containing spaces.** On Windows
  `process.execPath` is `C:\Program Files\nodejs\node.exe`, and the setup
  command handed it to the `claude` CLI through a shell without quoting, so it
  was split into `C:\Program` plus a stray `Files\nodejs\node.exe` argument.
  The written config looked correct and Claude Code reported
  `CONNECTION_CLOSED`. Every argument is now quoted when it contains a space.

### Added

- `dsh-any-agent --version` / `--help`, answered before the hub starts, so
  asking for a version spawns no reaper and touches no registry. Same for
  `dsh-any-agent-setup`.
- `test/setup.mjs` — 41 checks over the client-config writer, run against a
  throwaway HOME: dry run is byte-identical, existing entries survive, writes
  are idempotent, `--remove` takes out only its own entry, a corrupt config is
  refused rather than rewritten, absent clients are skipped, the Codex TOML
  block round-trips, and — added after the quoting bug — the command written
  into the config is spawned for real and must answer `initialize`.
- `test/package-check.mjs` — catches what only a tarball reveals: a missing
  `bin` field, a path without `./`, a missing shebang, `private:true`, test or
  state paths in `files`, and an `engines` floor that contradicts what the
  source actually imports.
- GitHub Actions: guards, prune, approval-details and setup across Node 22/24
  on Linux and Windows, plus a packaging job that packs, installs into a
  scratch project and asserts the tarball carries no state, tests or
  credentials.

### Changed

- `SERVER_VERSION` now comes from `package.json` instead of a hard-coded copy
  in `src/mcp.mjs`, so `npm version` cannot leave it stale.

## [0.1.0] — 2026-10-29

First public release, published to npm as [`dsh-any-agent`](https://www.npmjs.com/package/dsh-any-agent).

### Added

- **MCP server over stdio** that drives DeepSeek Harness (DSH) as a long-lived
  background coding agent. Speaks only the four standard MCP methods
  (`initialize`, `ping`, `tools/list`, `tools/call`), so any client that can
  launch a stdio server works — no host-specific extensions.
- **11 `dsh_*` tools**: `dsh_start`, `dsh_send`, `dsh_list`, `dsh_read`,
  `dsh_get`, `dsh_interject`, `dsh_interrupt`, `dsh_takeover`,
  `dsh_release`, `dsh_approval_decide`, `dsh_status`.
- **Resume across processes.** Conversation identity is DSH's `sessionId` on
  disk, not the process. A crash, an idle reap, or restarting this whole server
  costs nothing: the next call transparently resumes the session, memory intact.
- **Asynchronous dispatch with sentinel files.** `dsh_send(wait=false)` returns
  a `run_id` and a `sentinel_file` immediately; the turn writes that file
  atomically when it finishes, so a background task in the host wakes the caller
  instead of polling. Sentinels are namespaced per conversation, latched, and
  carry the answer but never the reasoning.
- **Mid-turn steering.** `dsh_interject` redirects a running turn (cancel, then
  immediately start a new one with history preserved); `dsh_interject(mode=queue)`
  defers a remark until the current turn ends. `dsh_interrupt` stops a turn
  without damaging the conversation.
- **Write-lock handling.** DSH conversations carry a cross-process write lock
  that never expires while the holder lives and has no steal API. `dsh_status`
  reports `lock_holder` (`self` / `stale-mcp` / `live-mcp` / `none`), and
  `dsh_takeover` preempts only the cases that are provably safe — it never kills
  a GUI, because GUI conversations live inside the single `dsh web` process.
- **Approval bridging** to the calling client, with credential-shaped fields
  redacted from both the structured context and the displayed title.
- **First-start profile bootstrap.** On first use the server scaffolds
  `~/.dsh/profiles/dsh-mcp/` from the shipped `acp` template and copies model
  routes from an existing profile. Only route *declarations* are copied
  (`apiKeyEnv`, `baseURL`, `api`, `models`, `reasoningEfforts`); `apiKey`
  — a field the adapter never reads — and `headers` are stripped. No credential
  is ever requested, stored or written by this project.
- **Reasoning hidden by default.** Only statistics (characters, duration, chunk
  count) reach the caller; reasoning never reaches disk, with one deliberate
  opt-out (`DSH_MCP_SENTINEL_INCLUDE_REASONING=1`).
- **Silent by default.** Not one byte on stderr, so nothing pollutes the host's
  logs; stdout carries the protocol and nothing else.
- **Workspace maintenance CLI** (`dsh-any-agent-workspaces`): `--list`,
  `--backfill`, `--prune-temp`, `--prune-empty`, `--purge-test-sessions`.
- Documentation: `README.md` / `README.zh.md`, `USAGE-NOTES.md` /
  `USAGE-NOTES.en.md` (gotchas), `USAGE-MIGRATION.md` (new-environment setup),
  `DESIGN.md` (protocol-level design notes).

### Verified

- **528 checks green** across 18 suites (492 in-suite + 36 acceptance), including
  resume-with-memory across processes, sentinel atomicity under concurrency,
  four lock-holder classifications, permission-tier enforcement read back from
  the session's own record, and real model calls through a provider.
- **Zero runtime dependencies** — Node built-ins only
  (`child_process`, `crypto`, `fs`, `module`, `os`, `path`, `url`, `zlib`).
- Installation from the published tarball: `npm install -g dsh-any-agent`
  creates the `dsh-any-agent` / `.cmd` / `.ps1` shims, the server answers
  `initialize` with `serverInfo: dsh-any-agent@0.1.0`, exposes all 11 tools, and
  returns a real model reply with zero bytes on stderr.
- Documentation claims were re-measured before release rather than trusted.
  Three figures did not survive: `dsh_send(wait=false)` was documented as
  returning "in ~1 ms" (measured 81 ms), interruption as converging in
  "~18 ms" (no test produced it; four samples of the `waited_ms` field gave
  91/102/105/119 ms), and a conversation as costing "~120 MB"
  (measured 295–476 MB, and self-contradictory in the original sentence).
  The README's Tests section now states the rule: every number is either
  printed by a suite or measured with a command the reader can re-run, and
  measured values carry their method.

### Known limitations

- No token-level streaming into model context (an MCP limitation).
- True mid-turn steering is impossible — ACP rejects concurrent prompts, so
  interjection is implemented as cancel-then-restart.
- Image prompts are unsupported (ACP advertises `promptCapabilities.image: false`).
- Restarting the MCP server takes its child processes with it: in-flight turns
  are interrupted and no sentinel lands. The write lock *is* released, so a
  restart always gets it back.
- A conversation that dies before its first successful turn may never have
  materialized on disk; resume then fails with a clear error.
- No renaming — DSH's title subsystem has no external rename API.
- `session/list` returns only `{sessionId, cwd}` and excludes already-open
  sessions; titles are filled in from DSH's projection cache.

### Notes

- The DSH profile is intentionally still named `dsh-mcp`, as are the
  `DSH_MCP_*` environment variables and the `# dsh-mcp:managed` marker line.
  These are persisted identifiers: renaming them would disconnect existing
  profiles, sessions and client configs. The product name changed; the on-disk
  contract did not. See the README FAQ.

[Unreleased]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmtlzzz/dsh-any-agent/releases/tag/v0.1.0
