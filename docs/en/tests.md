> Back to [README](../../README.md)

# 🧪 Tests

```bash
npm test                   # offline suites; smoke skips DSH sections if no DSH
npm run test:all           # offline + model-backed suites (needs DSH/provider)
node test/cleanup.mjs      # suite teardown on its own (test-created dirs only; --dry-run to preview)
node test/run.mjs --all --report .state/test-report.json   # same, writing the JSON report to a chosen path (every run writes .state/test-report.json by default)
npm run docs:counts       # write the report's check counts back into this page and the CI comment (see "After changing tests")
npm run docs:counts:check # check that the docs agree with the report; exit 1 and print the diff if not
```

Model-backed suites are not part of the hosted CI matrix (they need a real DSH
install and provider credentials). Run them locally, or dispatch the
`model-suites` workflow with a self-hosted runner that has DSH configured.

The suite **cleans up after itself**: `run.mjs` always ends with `cleanup.mjs`, which removes sessions and workspace registrations whose cwd is **a test-created directory** (`tmpdir()/dsh-any-agent-*` or `Desktop/dsh-any-agent-test-*`). Real project sessions — including projects under `%TEMP%` — and your live state directory are never touched. To remove `Desktop/dsh-any-agent-test-*` artifacts explicitly, run `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`.

| Suite | Checks | Covers |
|---|---|---|
| `smoke` | 33 (20 without DSH) | handshake, **instructions length cap** (clients truncate long instructions) with the core rules up front, tool table (15 tools), conversation creation, config, registry purity, prototype-name tool rejection |
| `dsh-locate` | 19 | **DSH auto-discovery**: a synthetic `app.asar` is read with plain Node (version, `engines.node`, entry existence), a desktop install dir maps to its bundled Electron runtime with `ELECTRON_RUN_AS_NODE=1`, candidate ranking (runnable first → newer → desktop > global > npx), `DSH_BIN` pointing inside an asar picks the desktop runtime, `DSH_RUNTIME` override, `engines.node` range evaluation, and parsing of `reg export` output (no tokens, no registry access) |
| `boundary` | 46 | protocol edges (double initialize, malformed lines, unknown method), argument validation (including read-only + permissive approval rejection, unknown provider/model, and no stale write-lock marker on a failed create), unknown ids, cursor edges, lifecycle idempotence, unicode |
| `integration` | 30 | resume-with-memory across processes, interrupt, both interject modes |
| `async` | 21 | fire-and-forget + later collection, including the review ticket in the receipt/result/sentinel and a real `dsh_review` round trip |
| `sentinel` | 36 | completion sentinel: atomicity, latch semantics, per-conversation namespacing under concurrency, cancelled runs still land it, and **reasoning never reaching the file** |
| `prune` | 11 | **sentinel retention**: prunes over-age and crash-leftover files, keeps fresh ones, removes empty shells, `TTL=0` disables pruning, and never touches the conversation registry beside it (no tokens, runs every time) |
| `guards` | 40 | **environment-variable guards**: odd numbers always land on the safe side — `IDLE_TTL_MS=-1` means "never reap", garbage/empty falls back to the 10-minute default, a too-small reap interval falls back to the default (no busy loop), and the **lost-holder threshold is floored at 30 s** (so another instance cannot "legitimately" preempt and kill our turn); plus the team-mode default and precedence (`DSH_MCP_TEAM` > `settings.json` > off) (no tokens, runs every time) |
| `sandbox-guard` | 21 | **the test sandbox itself**: a "throwaway HOME" that resolves to the real user profile, to the filesystem root, or to anywhere outside the OS temp dir is refused with an error instead of being written to and deleted. Every other suite builds its HOME through `test/sandbox-home.mjs` and can only destroy what it created there (no tokens, runs every time) |
| `approval-details` | 37 | **approval review context**: the pending-approval snapshot carries the command, reason, cwd and original approval ID — not just a bare ID — so a caller can actually adjudicate; missing `rawInput` is correlated from the earlier `tool_call` update by ID; credential-shaped fields and common inline literals are redacted; closing a conversation cancels pending approvals. Verified end-to-end over real stdio MCP |
| `failure-terminal` | 10 | **terminal state on failure**: an `ensureAlive` failure wakes `dsh_interject` waiters, writes an `error` sentinel, and attaches `runId` to the error; an approval with no matching option reports `effective=cancelled` instead of a fake allow; `dsh_get` reads a run back from its sentinel (no tokens) |
| `shared-host` | 25 | **shared process host**: notifications and permission requests route by `sessionId`, unknown-session approvals are cancelled, a process exit fans out to every attached conversation, the child stops only when the last conversation detaches; **on by default and switchable off with `=0`** (an empty value counts as unset); the pre-takeover collision check for a shared process; RSS helper (no tokens) |
| `shared-process` | 8 (skips without DSH) | **real-DSH shared process**: two conversations with the same `(cwd, permission)` share one PID, closing one leaves the other alive, closing both clears the host and exits the PID (needs a local DSH; runs with `--all`) |
| `dispatch-tools` | 58 (55 off Windows) | **dispatch surface**: `dsh_inbox` aggregates pending approvals across conversations, `client_run_id` idempotency hits and evicts with its run, queue list/update/promote/remove (remove writes a cancelled sentinel), `dsh_get(max_chars)` compacts both text and structured (answer truncated, tool inputs reduced to `input_chars`; `max_chars=0` still returns everything), `dsh_doctor` DSH-version grading (0.2.1-rc.5 / 0.2.2-rc.1 verified, 0.2.3+ unverified) and npx-cache detection, PowerShell sentinel-waiter escaping plus a real run, and the sentinel **reader** command (`-Encoding UTF8`, parses CJK content under Windows PowerShell 5.1; real run on Windows only), audit records metadata only, `dsh_doctor` essential checks (no tokens) |
| `line-decoder` | 4 | **UTF-8 line framing**: multi-byte characters split across MCP/ACP stream chunks are preserved (no U+FFFD), including CRLF and EOF-without-newline (no tokens) |
| `read-cursor` | 19 | **`dsh_read` cursor semantics**: text appended to an already-read entry is delivered again (revision cursor, match by `seq`); **each tool call gets its own entry** and a status update replaces that entry in place (they used to be concatenated into one entry under the first call's id); an empty turn's start/end stay two entries; **message segments separated by tool calls get a blank line between them in `answer`** (they used to run together); and `limit` is clamped to 1..500 so `0`/negative cannot spin or drop the tail (no tokens) |
| `sentinel-redaction` | 19 | **sentinel disk hygiene**: `result.thinking` is stripped, `thinking_omitted` is always a boolean, and `answer`/`error`/`title`/`tools_used[].input` all pass the same credential redaction as approvals (no tokens) |
| `review` | 70 | **caller review**: default `advisory` tickets carry a checklist + evidence + `dsh_review` entry; `dsh_review` writes the verdict to disk and back into the run and sentinel; `fail`/`partial` require notes; running/unknown runs are refused; review still works after a restart (sentinel-backed); queue and `client_run_id` replay receipts carry the ticket; review records share the sentinel TTL; notes, previews, evidence **and checklist items** are credential-redacted; **path-traversal ids are rejected before any file I/O** (no tokens) |
| `forget-tombstone` | 10 | **`forget` is terminal**: `release(forget=true)` writes a tombstone, by-id lookups fail with a recovery path, lists exclude it, and deleting the tombstone restores the normal unknown-session path (no tokens) |
| `bootstrap-profile` | 24 | **first-start profile works in the published zero-dependency form**: copies routing with the built-in YAML subset parser, strips `apiKey`/`headers`/literal secrets, never writes `defaultPreset`, is idempotent, and leaves a user-maintained profile byte-identical (no tokens) |
| `workspace-safety` | 23 | **data-loss boundaries**: `isTempPath` is segment-aware (`tmpdir()+'Suffix'` and `/tmpfoo` are *not* temp), a corrupt `workspace.json` is never overwritten, an unreadable session root never wipes `sessionIds`, and automatic cleanup deletes only test-created sessions (no tokens) |
| `permission-adopt` | 17 | **no silent privilege escalation**: adopting an external session with no permission record fails closed to `read-only`; a recorded `read-only` cannot be promoted by the sidecar; the runtime read-back rejects a recorded/requested mismatch (no tokens) |
| `state-safety` | 26 | **state/sentinel/lock storage**: defaults live under `$DSH_HOME/.dsh-any-agent`, an unwritable directory fails startup loudly, sentinel write failures return `null` + `sentinel_error`, and bad numeric env values land on the safe side (no tokens) |
| `workspace-snapshot` | 21 | **workspace snapshot**: `workspace_changed` must see full file contents (same status line with different content, changes past the 41st entry, inside untracked directories) and `gitStatus` runs asynchronously so it never blocks the shared MCP event loop (filesystem + a temp git repo, no tokens) |
| `setup` | 45 | **the registration CLI**: preview writes nothing, `--remove` takes out only its own entry, an absent client is skipped rather than failed, the Codex TOML block round-trips, and the command recorded in a config is actually spawned and must answer `initialize` (no tokens). It never invokes `claude mcp get` — that CLI rewrites `~/.claude.json` |
| `removal-scope` | 24 | **unregistering touches only its own entry**: configs holding unrelated MCP servers, top-level Codex settings and sibling Zed settings are registered and then removed, asserting every other value is byte-identical; removing something never written is a no-op with no write (no tokens) |
| `config-safety` | 407 (406 without client configs) | **the property the 0.3 line is about**, per client: preview leaves files byte-identical with no `.bak`; register-then-remove restores every other entry byte-for-byte, keeps key order and drops no top-level key; 4-space / 2-space indentation, single-line JSON, missing trailing newline, CRLF and a UTF-8 BOM all survive a write; malformed JSON and read-only files are refused without damage; the second `--yes` is a no-op with no new backup; every `.bak-dsh-<stamp>` appears once and equals the pre-write bytes; a `claude` on PATH is never invoked (no tokens) |
| `real-configs` | 84 (66 with 7/9 fixtures, 48 with 5/9 fixtures) | **round-trip on the real thing**: copies this machine's actual client configs (an 182693-byte `~/.claude.json` holding hundreds of `projects` entries and case-colliding keys, a 238-line Codex TOML, Zed's full `settings.json`) into a temp dir, registers, then removes, and requires every file back **byte for byte**; entry-presence is checked by key (not a bare substring), and missing fixtures are reported as skipped rather than green (no tokens) |
| `commit-script` | 26 | commit messages go through stdin, never a temp file that `git add -A` could capture (no tokens) |
| `test-counts` | 92 | **check-count sync**: parsing suite output (Chinese/English summary lines, whole-suite skip, `✓`/`✗` fallback, `[report]` environment tags), report assembly, round-trips of the "main number (other environments)" cell, rewriting the Chinese and English docs and `tests.yml`, `--check` diffs and `--portable`, model-suite numbers left alone, failing reports refused (no tokens) |
| `roots` | 12 | `dsh_start` without `cwd` asks the client for MCP roots; a client without roots gets an actionable error (no tokens) |
| `workspace-titles` | 18 (17 with TEMP outside the home directory, 16 case-sensitive with TEMP outside home) | home-as-workspace **and filesystem-root cwd** are rejected before DSH starts; `title_hint` is returned separately from DSH's automatic title (no tokens) |
| `package-check` | 14 | `files` whitelist, zero runtime dependencies, Node floor, and bin shebangs (no tokens) |
| `timeout` | 40 | **timeout semantics**: `wait=false` is unaffected by `timeout_ms`; a `wait=true` expiry merely downgrades to background (turn not cancelled, result not lost, `busy` never lies); `timeout_ms=0` waits forever and a **negative `timeout_ms` is rejected with a clear error** (no run dispatched, conversation still usable); a failed resume invalidates the process instead of wedging the conversation; an empty prompt yields a clear error |
| `lock` | 79 | **write lock and preemption**: four holder classifications, `writeMarker` never overwriting a live holder, malformed/missing registration edge cases; **end-to-end** with two real MCP instances fighting over one conversation → clear error → refusal → `force` takeover; **a crash releases the lock automatically**, **a wedged holder is preempted without `force`**; plus the "one turn, one sentinel" invariant (inline turns and idle interjects included) |
| `cycle` | 36 | **the async dispatch lifecycle**: dispatch → collect the sentinel → idle reap → dispatch again, three rounds with no lock error; re-dispatch right on the reap boundary (widening the race); an immediate re-dispatch after `dsh_release`; and an assertion that reaping leaves no unattributable lock (this suite caught the reaper collecting a freshly spawned process as if it were idle) |
| `concurrency` | 31 | three simultaneous conversations + live incremental reads |
| `capability` | 22 | writing code, running scripts, **spawning its own subagents** (verified on disk via child session headers) |
| `workspace-effect` | 24 | workspace actually effective when no path is given |
| `acceptance` | 36 (skips without IDA MCP) | two folders × two conversations doing a read-only IDA Pro analysis |
| `multi` | 19 | **several instances and non-ASCII paths**: reproduces "two instances share the registry and the later save drops the earlier instance's conversation", then proves **that conversation is recoverable by id alone from the session store and actually usable** (registry loss, not an explicit `forget` — forget is a terminal tombstone); **recovery never silently escalates privileges** (a read-only conversation stays read-only); no `.tmp` residue; and **CJK / emoji workspace paths** create sessions, do real work, and place files in the right directory |
| `permission` | 11 | ★ **whether the permission tiers actually take effect** (a safety property): it ignores our own return values (the very thing that used to lie) and reads **the session's own record** (`permissions.preset` / `sandboxMode` in the projection cache), checking all three tiers and that their recorded values differ. **This suite caught a silent privilege escalation**: a `defaultPreset` in the profile overrides `DSH_PERMISSION_MODE` at session creation |
| `list` | 17 | **the cost of `dsh_list`**: a default call runs the on-disk probe (it spawns a DSH process — seconds with many sessions) while **repeated calls hit the cache** (asserted via `probe_cached`, not wall-clock: Windows occasionally adds ~700 ms to one cached call); `only_running=true` and `include_closed=false` **skip the probe** (`probe_ok=null`) with equivalent semantics (unopened on-disk sessions are simply excluded) |
| `reasoning-check` | 8 | **reasoning visibility**: `reasoning=hide` returns no thinking body but non-zero stats; `reasoning=full` returns the text and the rendered section |

> **2026-11-06**: `node test/run.mjs` now runs **every** suite and lists all failures at the end (`--bail` restores stop-at-first-failure) — a single stale assertion in `timeout.mjs` used to hide eleven model-backed suites. Model-backed suites re-run in full against DSH 0.2.2-rc.1 on the desktop app's bundled runtime.

<!-- counts:begin (generated by scripts/sync-test-counts.mjs; do not edit by hand) -->
**`node test/run.mjs` ran 1159 checks in 28 offline suites on this machine (Windows, no DSH, 5/9 client config fixtures), all passing.** Parenthesised numbers in the table depend on the environment (DSH present or not, platform, filesystem case sensitivity, how many client configs the machine has), so the total moves with it; this line records the environment of the report used for the last sync.

That is **524 assertions in the client-registration suites alone** (`setup` 45, `removal-scope` 24, `config-safety` 407, `real-configs` 48), which is where the 0.3 work actually is.

The model-backed suites (`boundary` 46, `integration` 30, `async` 21, `sentinel` 36, `timeout` 40, `lock` 79, `multi` 19, `list` 17, `permission` 11, `shared-process` 8, `cycle` 36, `concurrency` 31, `capability` 22, `workspace-effect` 24, `acceptance` 36, `reasoning-check` 8) total **464 checks** nominally; with DSH present `smoke` runs 13 more checks in its session sections. They need a working DSH and provider, so re-run them yourself before trusting a release: `node test/run.mjs --all`. `acceptance` **skips explicitly** when the DSH profile has no IDA MCP (`mcp__ida__*`); `shared-process` also skips without DSH.

> Three different totals are intentional: `node test/run.mjs` on this machine (1159), the CI offline job (nominal 1106 on Linux/macOS, 1111 on Windows; hosted runners have no DSH and no client fixtures, so `smoke` skips its session sections and `real-configs` skips entirely), and the model-backed set (464 nominal). Counts are the numbers each suite prints itself, written back from the report by `npm run docs:counts`; don't copy them by hand and don't use one number for a different runner.
<!-- counts:end -->

### 🔢 After changing tests: counts are computed

The check counts in this page are not typed by hand. Every `node test/run.mjs` run collects each suite's output and parses it into a JSON report (default `.state/test-report.json`, which is gitignored; `--report <path>` picks another location, `--no-report` skips it): per suite `passed` / `failed` / `skipped` / `exitCode` / `durationMs`, plus the platform, Node and DSH versions and how many client-config fixtures the machine had. The numbers come from each suite's own summary line (`===== ...: passed N, failed M =====`); an older suite without one falls back to counting its `✓`/`✗` lines; a new suite should print the standard summary line.

**After changing tests:**

```bash
node test/run.mjs --all --report .state/test-report.json   # needs DSH/provider; drop --all to refresh only the offline numbers
npm run docs:counts                                        # rewrite this table, the totals above (both languages) and the scope comment in .github/workflows/tests.yml
git diff docs .github                                      # review what changed, then commit
```

- **Without `--all`** the report has no model-backed suites, so their numbers are left untouched (the script says so).
- **Environment-dependent suites** are written as "main number (other environments)": `smoke` (DSH present or not), `dispatch-tools` (Windows also runs the real PowerShell sentinel checks), `config-safety` and `real-configs` (how many client configs the machine has), `workspace-titles` (filesystem case sensitivity, whether `TEMP` is inside the home directory). **Only the cell this run measured is updated**; the others stay as they were. To refresh another cell, run in that environment and pass the reports in order with several `--report` flags.
- **Suites that skip as a whole** (`shared-process` without DSH, `acceptance` without IDA MCP, `real-configs` without client configs) keep their numbers.
- **A report with a failing suite is refused** (exit 2): a failing suite's count is not trustworthy.
- **A new suite**: add it to `OFFLINE`/`MODEL` in `test/run.mjs`, then add a table row (the script does not write the "covers" text; a missing row exits 1 and names the suite).

**Keeping it from drifting:** `npm run docs:counts:check` writes nothing; if the docs disagree with the report it prints the diff and exits 1. The CI offline job runs `node test/run.mjs --report` and then `docs:counts:check --portable`, which only checks environment-independent suites plus `smoke` / `config-safety` in the cell hosted runners land in (no DSH, no client configs); platform-dependent suites are left to the full local check (a step in the release checklist). The `test-counts` suite covers the parser and the rewriting itself.

### 🧯 Why `sandbox-guard` exists

On 2026-10-29 a throwaway verification script stored its sandbox path in a **PowerShell** variable named `$home`. `$home` is a read-only automatic variable, so the assignment failed silently (the script ran with `$ErrorActionPreference = 'Continue'`), `$env:USERPROFILE` was pointed at the sandbox name anyway, and the cleanup line — `Remove-Item $home -Recurse -Force` — resolved to the **real user profile**. The run timed out at 120 s mid-delete, taking part of `~/.codex`, `~/.cursor` and `~/.claude` with it.

Nothing in the test suites was ever green-but-wrong about the *writer*; what was missing was any assertion about the *sandbox*. `sandbox-guard` is that assertion: it refuses the real home, its subdirectories, case variants, the filesystem root, and any path outside `os.tmpdir()`. `test/sandbox-home.mjs` is now the only place a sandbox is created or destroyed, and `setup`/`removal-scope` no longer call `mkdtempSync` or `rmSync` themselves — the suite fails if they go back to doing so.

### 📏 Numbers in this README must be reproducible

Every figure in this document is either **printed by a test** or **measured with a command you can re-run**. If you change a number, change it to a measurement — not to an estimate, and never to a plausible-looking value.

This section exists because that rule was violated. An early draft claimed `dsh_send(wait=false)` returned "in ~1 ms" (measured: 81 ms), that interruption converged in "~18 ms" (no test ever produced that number — `integration.mjs` only asserts `waited_ms` is between 0 and 25 s; four manual samples gave 91/102/105/119 ms), and that a conversation costs "~120 MB" (measured: 295–476 MB) — the last one contradicting itself in a single sentence, quoting both "120 MB each" and "three = 428 MB".

**Three tiers, and how to state each:**

| Tier | What it means | How to write it |
|---|---|---|
| **Tested** | A suite asserts it | Give the number; the suite is the authority |
| **Measured** | You ran a command | Give the number **and the method**, so a reader can reproduce it |
| **Estimated** | Derived or bounded | Say so ("roughly", "worst case", "≈") and show the arithmetic |

**Recording a measurement inline.** The memory figures model the pattern — they name the tool, the before/after, and both samples:

```text
measured 300-480 MB per conversation
  (Get-Process node: WorkingSet64 summed before vs. after one active
   conversation reached end_turn; two cold starts gave 476 MB and 295 MB)
```

**When yours disagrees, say so.** Figures depend on machine, DSH version and load. A measurement outside a documented range is worth an issue — the range is a claim, not decoration.
