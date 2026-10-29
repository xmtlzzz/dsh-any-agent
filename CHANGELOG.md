# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmtlzzz/dsh-any-agent/releases/tag/v0.1.0
