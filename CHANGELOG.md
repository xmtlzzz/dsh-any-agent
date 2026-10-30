# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Both items below come from actually driving dsh-any-agent from Claude Code,
not from reading the code.

### Added

- **The home directory is rejected as a working directory, with the reason.**
  DSH's own ACL sandbox requires its temp directory to be *outside* the
  workspace. On Windows `%TEMP%` is `C:/Users/<name>/AppData/Local/Temp`, which
  sits inside the home directory, so choosing `cwd: C:/Users/<name>` made the
  first shell command fail with
  `Windows ACL: temp root must be outside the workspace` — several layers away
  from the cause, and easy to mistake for a broken install. `hub.create` now
  refuses that combination up front and names both escapes: a narrower project
  directory, or `permission=read-only` / `danger-full-access`.
- `snapshot()` now returns `title_hint` alongside `title`. DSH's own title is a
  truncated prefix of the first message (13–15 characters, e.g.
  `这是一次连通性冒烟测试，请`), which is fine for identifying a session but
  useless as a label. A `title_hint` given at `dsh_start` was already stored
  and already used as a fallback, but never surfaced once DSH produced its
  own title. Both are now returned, and `dsh_start` / `dsh_get` print the hint
  next to the native title.
- `test/workspace-titles.mjs` — 15 checks over both behaviours: the guard's
  case-insensitive and trailing-separator handling, that `read-only` is still
  allowed, that the message names the real DSH error and both escapes, and
  that the two title fields do not overwrite each other.

### Changed

- The `title_hint` tool description now says what actually happens — DSH's
  generated title wins for display, and the hint is returned separately —
  instead of the vaguer "fallback display".

## [0.3.1] — 2026-10-30

0.3.0 could overwrite a client config the user had deliberately made
read-only. Caught by CI on Linux, not on Windows, which is the interesting
part.

### Fixed

- **A read-only config was silently replaced on POSIX.** Writes go through
  write-to-temp then `rename`, and `rename` only requires the *directory* to
  be writable — not the target file. A `chmod 444` `~/.codex/config.toml`
  was therefore replaced as if the bit were not there. Windows `rename`
  returns EPERM for a read-only target, so the same code passed on
  `windows-latest` and failed on `ubuntu-latest`; the bug had been in 0.3.0
  the whole time. Writability is now checked with `access(W_OK)` before
  writing, so both platforms refuse.
- **`--force` never actually overrode anything.** It was parsed, documented
  and passed to neither the read-only check nor the writer. It now clears the
  read-only bit, writes, and **restores the original mode** — verified, so it
  does not leave a file whose permissions were quietly changed.

### Changed

- A file the current identity cannot write to is reported as
  `config file is read-only, refusing to overwrite it (use --force to
  override)` rather than a generic write failure, and no backup or temp file
  is left behind.

### Tests

- 633 offline checks across nine suites, all green, on Ubuntu and Windows for
  Node 22 and 24. The read-only section now asserts refusal, an untouched
  file, no stray temp file, and that `--force` writes *and* restores the
  mode. The root skip remains for hosts where permission bits genuinely do
  not apply.

## [0.3.0] — 2026-10-30

**Configuration impact is now a bounded, auditable property.** Registering this
server with any of nine MCP clients changes exactly one entry per client and
nothing else — including in configs with comments, CRLF endings, a BOM or keys
that collide only by letter case. `package.json` reports `0.3.0`; both
`dsh-any-agent --version` and `dsh-any-agent-setup --version` print it.

### Added

- **Nine clients, up from five.** `dsh-any-agent-setup` now detects and
  registers with Claude Code (`claude-code`), Claude Desktop
  (`claude-desktop`), Codex (`codex`), Cursor (`cursor`), Windsurf
  (`windsurf`), Zed (`zed`), Gemini CLI (`gemini`), opencode (`opencode`)
  and VS Code (`vscode`) — these ids are what `--only` and the `--json`
  output use. A client that is not installed is still skipped, never failed.
- **Per-client config shapes, written correctly rather than generically.**
  VS Code keeps MCP servers under `servers` (not `mcpServers`); opencode
  takes one `command` array (`{ type: "local", command: [exe, ...args],
  enabled: true }`) instead of separate `command`/`args`; Zed uses
  `context_servers`; Codex gets the two `[mcp_servers.dsh-any-agent]`
  sections. Claude Code is now edited like every other JSON client — a
  text-level `mcpServers` edit of `~/.claude.json` with a `type: "stdio"`
  entry — rather than registered through `claude mcp add`.
- **A JSON scanner that does not build a value object.** `~/.claude.json`
  really does hold a `projects` map with keys differing only in letter case
  (`.../Rust` next to `.../rust`), which is enough to break a naive
  `JSON.parse`; rewriting the file wholesale would destroy the user's project
  list. The scanner walks the text into a tree of byte ranges (tolerating
  comments and trailing commas, because Zed and VS Code configs allow them),
  so the case-colliding keys are never materialised — only the range of our
  own entry is touched.
- **JSON writes are text-level now: exactly one entry is rewritten, in place.**
  Earlier versions re-serialised the whole file, so values survived but
  formatting did not. Setup now locates its own entry in the existing text and
  replaces only that span, so indentation (2-space, 4-space, tabs), key order,
  CRLF line endings, a UTF-8 BOM and a missing trailing newline all come back
  byte-identical apart from the entry itself.
- `--json` — **stdout is one parseable object and nothing else; every
  human-readable line moves to stderr.** Shape: `{ ok, mode, clients: [{ id,
  label, path, status, summary, error? }], changed, skipped, failed }` with
  `mode` being `plan`, `apply` or `remove`. That split is the contract — a
  caller can pipe stdout straight into a JSON parser. Exit code still reports
  failure (`0` / `1`).
- `--home <dir>` — point setup at a sandbox (or any) home directory instead of
  the real `HOME`/`USERPROFILE`/`APPDATA`, so registering, re-registering and
  removing can be exercised without touching a live config.
- `--force` — exactly two effects: create a missing directory or file (the
  default does that too; the flag makes it dependable under automation and
  when the client itself is not detected), and overwrite a same-named entry
  whose shape is not what this program expects. It never removes another
  entry and never skips validation.

### Changed

- **The blast radius is now stated as a property, not a promise.** For every
  client, setup writes one entry named `dsh-any-agent` and `--remove` deletes
  exactly that entry. Nothing else in the file is re-serialised, re-indented or
  reordered.
- **Codex (`config.toml`) is edited line-wise.** Other `[tables]`, their
  comments, top-level keys (`model`, `approval_policy`, `sandbox_mode`) and
  CRLF endings are carried over unchanged; `--remove` puts the file back the
  way it was.
- **`dsh-any-agent-restore`** — a companion CLI for the backups. Setups and
  removals both leave `<file>.bak-dsh-<stamp>` copies of the pre-operation
  bytes, which is only useful if you can find the right one and put it back:
  `--list` shows every copy newest-first, `--latest` / `--stamp` / `--file`
  restore one, and `--dry-run` previews. A restore backs up the current file
  as `.bak-dsh-pre-restore-<stamp>` first, so a mistaken restore can itself be
  undone. Covered by 9 checks in `test/config-safety.mjs`, including
  recovering a deliberately corrupted config.
- **Backups can no longer overwrite each other.** Two runs inside the same
  millisecond produced the same filename, so the second copy silently replaced
  the first — and the replaced one could be the only state worth going back to.
  A colliding name now gets a `-2`, `-3` suffix instead.
- **The backup path is reported.** `--json` gained a `backup` field per client
  and the human output prints `backup: <path>` under each written entry;
  before this, a backup was created but you had to guess where it went.
- **A backup before every write**: `<file>.bak-dsh-<timestamp>`, one per run
  per file, holding the exact pre-write bytes. No backup is left behind by a
  preview.
- **Measured on seven real configs, not fixtures.** Registering added exactly
  one `dsh-any-agent` entry per client and preserved every pre-existing line —
  comments, CRLF endings, a 238-line Codex config, the 182693-byte
  `~/.claude.json` — and a subsequent `--remove` restored all seven files
  byte for byte.
- **The round trip was run on the real home, with backups.** `--yes` then
  `--remove --yes` were executed against the developer machine's actual
  configs after backing all seven up. Removal is verified as the strict inverse
  of registration: taking our single entry out of the backup with the same
  editing engine must reproduce the file then on disk, byte for byte. All seven
  match. Other MCP servers were unchanged field by field (Cursor still has
  stitch / obsidian-mcp-server / codegraph / rea), Zed still has all 32
  top-level settings keys, and `~/.claude.json` still parses with its 67
  top-level keys, 60 project entries and both case-only duplicate keys.
  `codex mcp list` reads the file normally afterwards, so nothing needs hand
  repair.
- **One deliberate change to an existing entry**: because the launch command is
  derived from where setup runs, registering from this checkout replaced the
  bundled `node/node.exe` in the pre-existing Cursor entry with the system
  `node.exe`. That is the one entry we own; no other server was touched.
- **Preview mode is a hard guarantee, not a report.** Without `--yes` nothing
  is written and no subprocess that writes is started. The Claude Code path
  used to shell out to `claude mcp add`, which writes immediately — and, worse,
  rewrites `~/.claude.json` in its own formatting with no backup we could
  restore. It is now a text-level edit like every other client, and a preview
  is a pure read: no CLI is invoked at all.
- **`claude mcp get` is used only as a read-only confirmation.** When the
  `claude` CLI happens to be installed, a completed write is followed by one
  `claude mcp get` probe and the summary says
  `(confirmed by claude mcp get)`; if the client has not picked the entry up
  yet the summary says so instead. The probe never writes.
- README (both languages): a per-client table of config file paths and exactly
  what install / update / remove / undo touch, replacing the older "JSON is
  re-serialised" caveat.
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

- **Setup used to reformat a config it was only supposed to add one key to.**
  The previous writer parsed each JSON client config and re-emitted it with
  `JSON.stringify(..., null, 2)`, which silently normalised indentation, key
  order, line endings and the trailing newline of every unrelated entry — the
  values survived, the formatting did not. Writes now replace only the bytes
  belonging to setup's own entry, and the invariant is asserted in
  `test/config-safety.mjs` rather than described in prose.
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

### Tests

- **632 offline checks, all green on 0.3.0** — `guards` 31, `prune` 11,
  `approval-details` 24, `sandbox-guard` 18, `setup` 41, `removal-scope`
  24, `config-safety` 403, `real-configs` 66, `package-check` 14. Every
  suite exited 0; none needs a model, a DSH install or a provider. **619 of
  those assertions are in the client-registration suites** (`setup`,
  `removal-scope`, `config-safety`, `real-configs`), which is where this
  release's work actually is. The model-backed suites (462 checks) were last
  measured in full for 0.1.2 and are re-run with `node test/run.mjs --all`.
- `test/real-configs.mjs` — **66 checks against real configs rather than
  fixtures.** It copies this machine's actual client files into a temp
  directory — the 182693-byte `~/.claude.json` with its hundreds of
  `projects` entries and case-colliding keys, a 238-line Codex
  `config.toml`, Zed's full `settings.json` — registers, then removes, and
  requires every file back byte for byte. Where those files do not exist (CI),
  the suite prints `skipped` explicitly instead of passing vacuously.
- `test/config-safety.mjs` — **403 checks**, the fixture matrix for the
  property this release is about, per client and against a throwaway home: a
  preview leaves every file byte-identical and creates no backup;
  register-then-remove restores every other entry byte-for-byte and leaves no
  top-level key behind; 4-space, 2-space and tab indentation, single-line
  JSON, a missing trailing newline, CRLF endings and a UTF-8 BOM all survive a
  write; malformed JSON and a read-only file are refused without damaging the
  original, while a missing directory is created safely; the second `--yes`
  is a no-op with no new backup; removing an entry that was never written
  writes nothing and exits `0`; and every `.bak-dsh-<stamp>` appears once
  and equals the pre-write bytes.
- `test/removal-scope.mjs` — 24 checks; `test/setup.mjs` — 41 checks,
  including spawning the command written into a config and requiring a valid
  `initialize` answer.
- **Verified against a real home, read-only.** Running `setup --json` (plan
  mode) over an operator's actual profile left all seven existing client
  configs — `~/.claude.json` (182693 B), `~/.cursor/mcp.json` (1396 B),
  `~/.codex/config.toml` (6647 B), `~/.gemini/settings.json` (465 B),
  `~/.config/opencode/opencode.json` (441 B), Zed's `settings.json`
  (5647 B) and Claude Desktop's `claude_desktop_config.json` (247 B) — with
  identical size, mtime and SHA-256, created no `.bak-dsh-*` file and created
  no new config. All nine clients were reported. With `--home <tmp>` every
  reported path moved inside that directory, `APPDATA` included.

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

[Unreleased]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.2...v0.3.0
[0.1.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmtlzzz/dsh-any-agent/releases/tag/v0.1.0