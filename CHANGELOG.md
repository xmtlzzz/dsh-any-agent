# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Website

- Playground: step backward, stateful connection-line status, sentinel receipt
  pulse, and a "try interject" cross-scenario action on dispatch frames.
- Code snippets now use one-pass syntax highlighting (quoted keys, values,
  comments and arrows) without nested spans; the Cursor config tab and copy
  success icon were added; `/en/` HTML is explicitly revalidated.
- Navigation now surfaces the FAQ; English and Chinese nav order match.

### Documentation

- Fix the profile-creation command in `USAGE-NOTES.md` / `.en.md`: it needs
  `dsh --profile dsh-mcp --from-default-profile acp`, and 0.5.0+ normally
  bootstraps the profile automatically.
- Correct the team-mode profile default in `docs/zh/limits.md` and the
  architecture diagrams: `dsh-mcp` is default; `dsh-team` is used only when
  team mode is on.
- Clarify the website README's Node.js floor (website build ≥ 22; the MCP
  server itself requires ≥ 22.15).

## [0.5.1] — 2026-11-04

### Security

- **Path-safe ids before any state-file join.** `conversation_id` and `run_id`
  are now validated as single path segments before building sentinel, review,
  metadata or tombstone paths. Values containing `/`, `\`, `:`, `..` or other
  separators are rejected instead of being passed to `path.join`; this closes
  a traversal in `dsh_get`'s sentinel read-back and in `dsh_review`'s
  `<state>/reviews/<conv>/<run>.review.json` write.
- **Filesystem-root `cwd` is rejected for writable tiers.** Choosing `/` or
  `C:\` with `workspace-write` made the sandbox root the whole disk; symlinked
  paths are resolved before the home/root guard, so a symlink to the root or
  home cannot bypass it.
- **`title_hint` is capped at 200 characters** (schema + runtime). It is
  persisted in the registry and sidecar on every turn; an unbounded value was
  a stable disk/memory amplifier.
- **`dsh_doctor` checks `reviews/` writability**, alongside `runs/` and
  `locks/`.
- **MCP tool dispatch only accepts own handler properties**, so names such as
  `constructor`, `toString` or `__proto__` are reported as unknown tools
  instead of reaching the prototype chain.

### Features

- **Caller review (`dsh_review`).** Every completed turn now carries a
  `review` ticket in its result, `structuredContent`, `dsh_get` output and
  async sentinel: a checklist derived from the turn (workspace changed? normal
  stop? which tools ran?), the evidence needed to check it, and a `dsh_review`
  entry. The calling agent can record `pass` / `partial` / `fail` with notes
  and findings; the verdict is written atomically to
  `<state dir>/reviews/<conversation_id>/<run_id>.review.json` and written back
  into the in-memory run and the sentinel (so an async caller no longer sees a
  stale `pending`). `fail`/`partial` require a reason; running/unknown runs are
  refused. Default `advisory`: the ticket is loud but **does not block** the
  next `dsh_send`, and a failed review is not fed back to DSH automatically.
  Set `DSH_MCP_REVIEW=off` (or pass `review: "off"`) to disable tickets.
  Review records share the sentinel's 7-day TTL and credential redaction,
  including checklist items interpolated from `result.error` (Codex review
  finding on #2).

## [0.5.0] — 2026-11-03

### Process model

- **The shared ACP process is now the default.** Sessions with the same `(cwd, permission)`
  land on one DSH process: a second session costs ≈300 ms instead of a ≈4 s cold start, and the
  300–480 MB is paid once per group instead of once per conversation.
  `DSH_MCP_SHARED_PROCESS=0` restores one process per conversation (worth it when you need hard
  isolation). Different workspaces or permission tiers still get separate processes —
  `dsh-base` keeps the sandbox root and the approval policy process-wide.
- **`dsh_takeover` no longer kills a shared process blind.** When the PID it is about to kill
  still carries other sessions, it refuses unless `force=true` and reports them as
  `shared_sessions`; with `force` it says how many went down with it.
- **`dsh_doctor` de-duplicates RSS by PID** and reports the shared host count, so "live processes"
  and "RSS total" stop multiplying by the number of sessions riding one process.
- Stale comments corrected: `DSH_MCP_IDLE_TTL_MS=0` is no longer the default (10 minutes since 0.4.0).

### Team mode and defaults

- **Agent Teams is now opt-in.** `DSH_MCP_TEAM` defaults to off. Enable with
  `dsh-any-agent team on` (writes `<DSH_HOME>/.dsh-any-agent/settings.json`),
  disable with `team off`, inspect with `team status`; no client config editing.
  When on, the profile switches to `dsh-team`, the legacy subagent tools are
  disabled, and `dsh_send` adds the "form a team when needed" line.
- **The default session permission is now `workspace-write`** (was
  `danger-full-access`). `permission=danger-full-access` additionally requires
  `DSH_MCP_ALLOW_FULL_ACCESS=1` on the machine, so a bare `dsh_start` can no
  longer hand the caller whole-machine write access.
- `dsh_doctor` has a dedicated `team` check: on / off / requested-but-unavailable.

### Demo

- **`npm run demo`** — a five-minute, end-to-end case: create a conversation, dispatch a task with
  `wait=false`, interject twice while it runs, collect the sentinel, then verify the artifacts on
  disk (including `node --test`) instead of trusting the model's own summary. It runs against an
  isolated registry / sentinel / lock directory, so it never touches your daily
  `~/.dsh/.dsh-any-agent`. `--replay` walks a recorded transcript with no DSH and no tokens;
  `--keep` keeps the workspace. Ships as `demo/` in the npm package.

## [0.4.0] — 2026-11-03

### Memory

- **Idle reaping is on by default.** `DSH_MCP_IDLE_TTL_MS` now defaults to
  10 minutes (was `0` = never). Idle sessions release their DSH process and
  resume automatically on the next call; the write lock is released with it.
  Set `0` to restore the old "hold the lock forever" behavior.
- **`DSH_MCP_MAX_LIVE` defaults to 4** (was 8), keeping the worst case around
  1.2–1.9 GB instead of 2.5–4 GB at the documented 300–480 MB/session.
- **`keep_alive` on `dsh_start`.** A session created with `keep_alive: true`
  is exempt from idle TTL and `MAX_LIVE`; it keeps its DSH process (and write
  lock) until `dsh_release`. Use it for "must stay attached" sessions.
- **Global RSS budget** via `DSH_MCP_MAX_RSS_MB` (default `0` = off). When the
  sum of live child RSS exceeds the budget, the least-recently-used idle
  sessions are reaped until it fits. `keep_alive` sessions are reaped last.
- **`dsh_list` / `dsh_status` report `rss_mb`** (and `keep_alive`), so the cost
  is visible instead of guessed.
- **Optional child heap cap** via `DSH_MCP_CHILD_MAX_OLD_SPACE_MB` (default
  `0` = off). It appends `--max-old-space-size=<n>` to the child's
  `NODE_OPTIONS` without clobbering existing options.
- **Experimental shared ACP process** via `DSH_MCP_SHARED_PROCESS=1`. Sessions
  with the same `(cwd, permission)` share one DSH process; ACP supports
  concurrent sessions over one connection and DSH gives each session its own
  Agent. Measured on DSH 0.1.7: two sessions → one PID, second `session/new`
  took ~300 ms instead of ~4 s. Same `(cwd, permission)` is required because
  `sandbox-policy.workspaceRoot`/`mode` and `approval.policy` are process-wide
  in `dsh-base`. Trade-off: a process crash takes down the whole group; the
  host writes error sentinels for every in-flight run and each session resumes
  on the next call.

### Dispatch surface

- **`dsh_inbox`** — a cross-conversation approval inbox. `dsh_status` remains
  single-conversation; this tool lists every pending approval with
  conversation id/title, approval id, tool, reason, input, options and age.
- **`client_run_id` idempotency** on `dsh_send` / `dsh_interject`: resubmitting
  the same key returns the first run (`replayed=true`) instead of creating a
  second one. The key is written into the sentinel and evicted together with
  the run record.
- **Session queue** via `dsh_send(queue=true)` (explicit opt-in; the default
  busy behavior stays "error") plus **`dsh_queue`** for list/remove/update/
  promote. Sentinels are written only at terminal state; removing a queued
  item writes a `cancelled` sentinel.
- **`dsh_get` text budget**: `max_chars` truncates only the rendered text
  (structured content keeps the full result) and reports
  `answer_truncated` / `next_offset`.
- **`dsh_doctor`** — read-only health check: DSH binary/version, profile
  existence/drift, state file, `runs`/`locks` writability, orphan lock holders,
  session/RSS totals, effective config.
- **Optional metadata audit** via `DSH_MCP_AUDIT_FILE`: JSONL records for
  start/send/queue/interject/interrupt/approve/release/takeover. It records
  IDs, decisions and counts only — never prompts, answers, thinking or tool
  input. Rotates at 10 MB.
- **`resolveDshBin` prefers the newest cached DSH** instead of the first
  directory it finds. This machine had both 0.1.5 and 0.1.7 cached; picking
  0.1.5 silently hid the experimental Agent Teams packages.
- **README positioning section**: the server is a dispatcher, not a capability
  aggregator; DSH owns its tools/skills/teams, and dispatch is on demand.

### Team mode

- **Agent Teams is on by default** (`DSH_MCP_TEAM=1`). The default profile is
  now `dsh-team`, auto-created from the same routing source with
  `@deepseek-ai/dsh-experimental-agent-team` +
  `@deepseek-ai/dsh-experimental-tool-agent-team`; the legacy `subagent` tools
  are disabled, matching the official team profile layer. Requires DSH
  `>= 0.1.7-0` (the packages ship with 0.1.7-rc.1).
- `dsh_send` injects a short "form a team if this needs parallel or multi-role
  work" line before the caller's prompt; simple tasks are not forced into a
  team. `dsh_send(team=false)` disables it for one call; `DSH_MCP_TEAM=0`
  returns to `dsh-mcp` and disables injection.
- `TEAM_ACTIVE` is false when the selected profile does not actually contain
  the team package, so an explicit `DSH_MCP_PROFILE` pointing at a non-team
  profile does not inject a tool the agent cannot use.
- **Switching**: `DSH_MCP_TEAM=0` returns to `dsh-mcp` and disables injection;
  `dsh_send(team=false)` disables it for one call; `DSH_MCP_PROFILE` still
  wins over the default profile. `dsh_start` / `dsh_doctor` report the
  effective team mode and profile.

### Correctness

- **A failed `ensureAlive` now has a terminal state.** It wakes every
  `dsh_interject` waiter, writes an `error` sentinel, and attaches
  `runId`/`status`/`sentinelFile` to the thrown error. Previously an interject
  that arrived during a lock-conflict/cold-start window could wait forever
  (`timeout_ms=0` has no timer).
- **`dsh_approval_decide` reports the effective outcome.** `decideApproval`
  returns `effective: 'selected' | 'cancelled'` (plus `reason: 'no_option'`);
  the tool text no longer claims "decided as allow" when ACP actually received
  `cancelled`.
- **`dsh_get` can read a run back from its sentinel.** On a memory miss it
  reads `RUNS_DIR/<conversation>/<run_id>.json`, returns
  `run.source='sentinel'`, and always includes `sentinel_file` /
  `sentinel_file_posix`.
- **Reap/respawn race fixed.** `stop()` is registered as `recycling` and
  `proc` is cleared only after the child is confirmed gone, so a concurrent
  `dsh_send` waits instead of spawning a new process against an unreleased
  write lock. `lastChildPid` is updated only after a successful resume, so a
  failed resume no longer loses the previous generation's takeover clue.
- **`timeout_ms` is validated.** Non-finite or negative values now raise
  instead of silently becoming `NaN`/immediate background receipts.

### Tests

- New `failure-terminal.mjs` (interject wake + error sentinel + approval
  effective + sentinel read-back).
- New `shared-host.mjs` (session routing, exit fan-out, refcount teardown,
  RSS helper).
- New `shared-process.mjs` (real-DSH shared process; skips without DSH).
- New `dispatch-tools.mjs` (`dsh_inbox`, `client_run_id` idempotency, session
  queue operations, `dsh_get` text budget).
- `guards.mjs` and `smoke.mjs` updated for the new defaults and the
  `keepAlive` metadata field.

## [0.3.9] — 2026-11-02

### Security / robustness

- **UTF-8 stream framing is lossless.** MCP and ACP now use a shared
  `LineDecoder` backed by `StringDecoder`, so a multi-byte Chinese/emoji
  character split across stream chunks is no longer silently replaced by
  U+FFFD. Covers both input prompts and DSH output.
- **Concurrent adoption of the same disk session is deduplicated.** `Hub.get`
  now shares one in-flight `findSessionHeader`/adoption promise per id and
  rechecks the registry, preventing two Conversation objects (and the
  unreachable child/write-lock leak that followed).
- **`read-only` runtime verification fails closed.** It waits up to ~10s
  (covering DSH's projection-cache flush window); if no recorded permission is
  available, the call is refused instead of relying on an approval layer that
  a danger sandbox may never invoke.
- **`spawned_at` is reset when the child PID changes.** PID-reuse protection no
  longer rejects takeover of a legitimate restarted child.
- **`forget` tombstones survive unreadable session headers.** Header read is
  three-state (found / missing / error); only a genuinely missing session file
  prunes a tombstone.
- **`DSH_MCP_SENTINEL_INCLUDE_REASONING=1` no longer disables redaction.**
  Thinking is kept, but answer/error/title/tool inputs are still sanitized.
- **`close`/`releaseAll`/`shutdown` keep lock registrations until the child is
  confirmed dead.** If stop times out, the registration is retained so
  takeover can still attribute the orphan; `forget` is refused while the child
  is alive.
- setup preserves the target file's mode (e.g. 0600) and rejects an invalid
  `--permission` with exit code 2.
- `restore --latest` excludes its own `pre-restore-*` safety copies, so running
  it twice no longer undoes the first restore.

### Behavior

- `workspace_changed` compares git-status entry snapshots instead of object
  identity; output now says "workspace state changed" rather than claiming a
  per-turn file count.
- `dsh_takeover` prefers a live `known_child_pid` when the marker points at a
  dead child.

### Website

- Mobile navigation keeps the language switch visible; the footer also carries
  a language link.
- `hero.jpg` and `favicon.svg` are content-hashed; all `/assets/*` can stay
  immutable.
- Light-theme muted/faint/accent colors were darkened to meet WCAG AA on the
  surfaces they are used on.

### Docs / tests

- README/Chinese README/USAGE-MIGRATION: workspace-write approval semantics,
  setup's `workspace-write` default, Zed `context_servers`, English npm publish
  step, current route/limit links.
- New `line-decoder` suite (4), expanded sentinel redaction (19), tombstone
  pruning (10), permission adoption (17), state/lock safety (26), sandbox guard
  (21), setup (45), config-safety (407). Offline total 843 / 879 with nine
  client fixtures; website 29.

## [0.3.8] — 2026-11-02

### Changed

- `npm test` now works without a local DSH: smoke still checks handshake and
  the tool table, then skips session-dependent sections instead of failing, so
  all offline suites run. `npm run test:all` is the explicit full-suite entry.
- Added the `model-suites` workflow for a self-hosted runner with DSH and
  provider credentials; hosted runners print an explicit skip.
- Added an English `USAGE-MIGRATION.en.md` and linked it from the English
  README and `/en/` install section.

### Testing

- Removed the remaining always-true `check(..., true)` assertions; cleanup
  checks now assert actual release/forget results or timeout state.
- `prune` runs with an isolated `DSH_HOME` so it cannot touch real tombstones.
- Added 8 static accessibility tests for both locales (28 website tests total
  counting the existing site/release/demo suites).
- `readHeaderAsync` now uses `StringDecoder` for multi-byte UTF-8 boundaries.

### Website

- `robots.txt` now mirrors the complete Cloudflare Managed crawler list, not
  just the four most common bots.

## [0.3.7] — 2026-11-02

### Fixed

- **Session-header lookup no longer blocks the event loop.** `Hub.get()`,
  `Hub.load()` and `pruneStaleTombstones()` now use a streaming
  `readHeaderAsync()` that stops at the first newline, with a 5 s timeout and
  1 MiB header cap. Large session logs can no longer stall MCP requests,
  heartbeat renewal, or approval handling while recovering an unknown
  conversation. The synchronous reader remains only in the explicit
  workspace CLI/test-cleanup path.
- **Website robots policy mirrors Cloudflare Managed content.** The generated
  `robots.txt` now states `Content-Signal: search=yes, ai-train=no` and
  disallows GPTBot/ClaudeBot/Google-Extended/CCBot, so non-Cloudflare hosts
  and the repository agree with the production policy.
- Website tests now cover the English locale, robots policy, hreflang, CSP
  hash, and bilingual pages (20 tests).

## [0.3.6] — 2026-11-02

Post-0.3.5 hardening (remaining completeness-audit items).

### Fixed

- `dsh_status` now reports `lock_holder_reason` and no longer calls `none`
  "your GUI" when the conversation is simply idle/released; the GUI hint is
  only shown after an actual lock conflict.
- `dsh_get` reports `title_source` (`native` / `title_hint` / `null`) and no
  longer labels a `title_hint` fallback as "DSH generated".
- `dsh_read` caps a single output entry at 200k characters (keeps the tail)
  so one runaway tool output cannot grow the in-memory buffer without bound.
- `dsh_list` exposes `probe_ok` / `probe_error` / `probe_cached`; a failed
  on-disk probe is no longer indistinguishable from "no sessions".
- MCP clients that send `notifications/roots/list_changed` now invalidate the
  cached project directory and re-request `roots/list`.
- Client config backups rotate (default 20 per file, `DSH_MCP_BACKUP_KEEP`);
  `dsh-any-agent-restore` writes atomically and preserves the target mode.
- The shared `workspace.json` writer keeps a `<file>.bak-dsh` last-known-good
  copy before replacing it.
- `dsh_takeover` now compares the child's OS start time with the registration
  before sending SIGKILL; a mismatched PID (reuse) is refused.
- Website: full English page at `/en/`, hreflang alternates, bilingual sitemap,
  JSON-LD, Cloudflare Insights domains in CSP, and a pre-paint theme script
  (CSP sha256) so light-system users no longer see a dark flash.

### Known residual items

- Cloudflare Managed robots.txt / Content Signals are dashboard-managed; the
  repository documents the split instead of trying to override them.
- Session-log header decompression is still synchronous; it is bounded by the
  fact that only the header is parsed, but a very large log can still block
  the event loop briefly. A fully async reader needs a broader refactor of
  `Hub.get`/`findSessionHeader`.

## [0.3.5] — 2026-11-02

Completeness-audit follow-up. Data-safety and privilege boundaries first,
then documentation/CI truthfulness.

### Security

- **Unknown permission on an adopted external session now fails closed to
  `read-only`.** It previously fell back to `danger-full-access` when the
  projection cache had no permission record.
- **Runtime permission read-back.** After `session/new` and every
  `session/resume`, the session's own recorded `permissions.preset` is read
  back; a mismatch (for example a profile `defaultPreset`) fails the call
  instead of silently escalating. `dsh_get` exposes `permission_verified`.
- **Workspace-write semantics documented honestly.** Out-of-workspace
  requests are auto-allowed by default; pass `on_approval=ask` to adjudicate.

### Fixed

- **Temp-path prefix bug could delete real sessions.** `isTempPath` now
  compares path segments, so `tmpdir()+'Suffix'` and `/tmpfoo` are no longer
  treated as the OS temp directory. Automatic cleanup only deletes
  test-created sessions (`tmpdir()/dsh-any-agent-*` and the Desktop test
  folders); `tempOnly` remains an explicit manual flag.
- **`setup` no longer invokes `claude mcp get`.** That probe made Claude Code
  rewrite `~/.claude.json` (dropping `projects[*].history` and adding keys).
- **First-start profile bootstrap works in the published package.** The
  undeclared `js-yaml` dependency is replaced by a built-in YAML subset parser
  (`src/yaml-lite.mjs`); generated profiles include the three permission
  presets but never `defaultPreset`. A route without a default provider/model
  fails with an actionable error instead of writing an empty `acp` config.
- **State/sentinel/lock storage moved to `$DSH_HOME/.dsh-any-agent`.** The
  old in-package `.state` location is migrated once (including metadata
  sidecars). Startup now fails loudly if the directories are unwritable, and
  a sentinel write failure is surfaced as `sentinel_error`.
- **Corrupt `workspace.json` is no longer overwritten** with an empty
  document; register/prune report the error and leave the file byte-identical.
  The temp filename is unique per writer.
- **`defaultLaunch` uses `fileURLToPath`**, so install paths containing
  spaces or non-ASCII characters no longer become percent-encoded.
- **`release(all=true)` now skips busy conversations by default** (pass
  `force=true` to interrupt them); the interject timeout description matches
  the busy-path behavior.
- Numeric env guards: negative sentinel TTL no longer deletes every sentinel;
  empty permission/reasoning-effort values fall back to defaults.
- `ACP clientInfo.version` now comes from `package.json`.

### Tests

- New offline suites: `bootstrap-profile`, `workspace-safety`,
  `permission-adopt`, `state-safety` (81 checks total). `package-check` is
  part of `node test/run.mjs`; `acceptance` is part of `--all` (it self-skips
  without IDA); `reasoning-check` now asserts rather than only printing.
- CI runs every offline suite and the website build/tests; stale counts in
  the SCOPE header and READMEs were corrected (815 checks on five client
  fixtures, 851 with nine; CI offline 786/822).

## [0.3.4] — 2026-11-02

Docs-only release. No runtime code changed; this publishes the updated
README (Star History, corrected setup wording) and the website source so the
npm package page matches the repository. The site is deployed separately at
<https://dsh-any-agent.xmtlz.dev/>.

### Changed

- README / README.zh: add the Star History chart and keep the measured
  setup impact-scope note.
- Website: the release version is read at runtime from npm (fallback:
  GitHub release/tag) instead of being baked at build time; the CSP allows
  those endpoints; canonical and Open Graph URLs use the public domain.
- Website wording now states that copying the model route into the ACP
  profile needs a YAML parser (js-yaml), that external MCP servers are
  configured in the DSH profile, and that `setup --yes` writes absolute
  node/entry paths plus env.

## [0.3.3] — 2026-11-02

An adversarial audit of the 0.3.2 MCP surface found one safety boundary that
could be bypassed and several places where the implementation and the docs
disagreed. This release closes them, with regressions for each.

### Security

- **`read-only` is now a hard boundary.** `dsh_start` rejects
  `permission=read-only` combined with `on_approval=auto-allow`/`ask`, and the
  approval layer refuses every permission request from a read-only
  conversation. Previously DSH could ask for a `sandbox_permissions` escalation
  and a permissive policy would let the write through while the session record
  still said `read-only`.

### Fixed

- **`dsh_read` no longer loses streamed text.** The cursor is a revision
  number: text appended to an already-read entry is delivered again, so a
  polling caller sees the rest of the message. `limit` is clamped to 1..500.
- **`dsh_release(forget=true)` is terminal.** It writes a tombstone under
  `$DSH_HOME/.dsh-any-agent-forgotten`; by-id lookups fail with a recovery
  path, lists exclude the session, and stale tombstones are pruned at startup.
- **A failed `dsh_start` no longer leaves a write-lock marker.** It was
  visible as an orphan holder after an invalid provider/model.
- **Real approval context.** The permission request's `toolCallId` is
  correlated with the earlier `tool_call` update, so
  `pending_approval_details` carries the command and reason instead of an
  opaque id.
- **Sentinels redact tool inputs** with the approval credential rules, and
  `thinking_omitted` is always a boolean.
- **Empty prompts fail synchronously** instead of producing an accepted
  receipt for a turn that immediately errors.
- **`dsh_start` rejects an unknown provider/model** instead of silently
  falling back to the profile default model.
- **Pending approvals are cancelled and cleared** when a turn ends or a
  conversation closes.
- **`queue`-mode interject honors `timeout_ms`** (0 = wait forever).
- Tests: `read-cursor`, `sentinel-redaction` and `forget-tombstone`
  regressions; `real-configs` checks entry keys rather than a bare substring;
  test teardown removes only the conversation ids it created; acceptance
  skips explicitly when no IDA MCP is configured.

### Changed

- `dsh_read` cursor semantics: entries reappear when their text grows; match
  by `seq` and replace the text.
- Documentation now states that **DSH's own session log contains reasoning**
  (even with `reasoning=hide`); the "never reaches disk" guarantee covers this
  server's logs, sentinels and registry only.
- README links the official site at <https://dsh-any-agent.xmtlz.dev/> and
  records the measured config impact scope for the nine supported clients.

## [0.3.2] — 2026-10-30

Two fixes and one feature, all from driving this server from Claude Code
rather than from reading the code.

### Added

- **`cwd` is optional and defaults to the project the client has open.** The
  client already knows which folder the user is working in, but nothing asked
  it. `initialize` now records the client's `roots` capability, and
  `dsh_start` without `cwd` sends one `roots/list` request and converts the
  returned `file://` URI to a path. "DSH works where the client is looking"
  becomes the default, which also removes the usual way to land on the home
  directory by building the path by hand. A client that does not advertise
  roots, or does not answer in time, gets an actionable error naming an example
  `cwd` — it never guesses a directory. `projectDir()` is exposed on the
  server object for callers that want the raw value.
- **The home directory is rejected as a working directory, with the reason.**
  DSH's own ACL sandbox requires its temp directory to be *outside* the
  workspace. On Windows `%TEMP%` is `C:/Users/<name>/AppData/Local/Temp`,
  inside the home directory, so `cwd: C:/Users/<name>` made the first shell
  command fail with `Windows ACL: temp root must be outside the workspace` —
  several layers away from the cause and easy to mistake for a broken install.
  The combination is now refused up front, naming both escapes: a narrower
  project directory, or `permission=read-only` / `danger-full-access`.
- `snapshot()` returns `title_hint` alongside `title`. DSH's own title is a
  truncated prefix of the first message (13–15 characters, e.g.
  `这是一次连通性冒烟测试，请`), which is what the GUI shows. `title` is
  unchanged — it stays the field the GUI reads, so the two agree — and the
  hint is returned separately rather than replacing it.

### Changed

- The `title_hint` tool description now states what happens: DSH's generated
  title wins for display, and the hint is returned alongside it, instead of
  the vaguer "fallback display".

### Tests

- `test/roots.mjs` — 12 checks over a real stdio handshake: that the server
  sends `roots/list` when the client advertises it, that an answered root
  becomes the working directory, that an unsupported client gets the
  actionable message, and that a nonexistent explicit `cwd` still reports
  cleanly.
- `test/workspace-titles.mjs` — 15 checks: the home-directory guard's
  case-insensitive and trailing-separator handling (asserted only where the
  filesystem actually has it), that `read-only` is still allowed, and that the
  two title fields do not overwrite each other.
- 660 offline checks across eleven suites, green on Ubuntu and Windows for
  Node 22 and 24.

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

[Unreleased]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.9...HEAD
[0.3.9]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.2...v0.3.0
[0.1.2]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xmtlzzz/dsh-any-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmtlzzz/dsh-any-agent/releases/tag/v0.1.0