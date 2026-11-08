> Back to [README](../../README.md) · 中文版：[实时查看设计](../zh/live-view-design.md)

# Design: let users see what DSH is doing (live event stream + viewers)

> Status: **shipped.** The event stream, `watch` and `dashboard` landed in 0.6.1; token usage and the viewer improvements (in-place `watch`, inspector column, scrollable runs) in 0.6.2; English UI, `--open` and `dsh_doctor`'s live check after that (see the CHANGELOG). This document describes the design as built.
>
> Code: `src/live.mjs` (writing), `src/live-view.mjs` (reading, merging, terminal rendering), `src/live-cli.mjs` (the `watch` / `dashboard` subcommands), `src/live-dashboard.mjs` + `src/live-dashboard.html` (the page). Tests: `test/live-events.mjs`, `test/live-view.mjs`.
>
> Scope: a **lightweight feature** — an event stream plus two read-only viewers. No status line, no host-embedded view, no control plane.

## 1. The problem

This server dispatches work to DSH. For the **calling agent** the process is visible: it can `dsh_read` incrementally, wait for the sentinel, `dsh_get` the result. For the **person sitting at Claude Code / Codex / Cursor**, it is mostly a black box:

- The screen shows one `dsh_send` call and a receipt (run_id, sentinel path), then waiting.
- Which files DSH read, which commands it ran, whether an approval escalated the sandbox to `danger-full-access` — the user cannot see any of it unless the agent calls `dsh_read` and relays it, which costs tokens and depends on the agent choosing to.
- When something goes wrong (stuck on a tool, failing repeatedly, waiting on an approval) the user cannot tell whether to wait or interrupt.

The goal is a **side view that does not go through the agent**.

## 2. Goals and non-goals

**Goals**

1. See every conversation live: whether it is running, which tool it is on, which tools this run has called and their status.
2. Make approvals — especially auto-allowed ones and sandbox escalations — stand out.
3. See conversations dispatched by every client and every server instance at once.
4. Keep the privacy red line: **reasoning never travels this path**.
5. A write failure never affects dispatching.

**Non-goals**

- No control plane: the viewers cannot approve, interject or interrupt (see §9, item 4).
- No status-line output and no host-embedded view (Claude Code side panel, MCP Apps). If they come later they only read the same stream; the server does not change.
- `dsh_read`, sentinels and the audit log keep their exact semantics.
- DSH's own `~/.dsh/sessions` is never read.

## 3. Where the data was

DSH's tool activity reaches this server through ACP `session/update` (`tool_call` / `tool_call_update`). Before the live view it went to:

| Where | What | Live | Who can see it |
|---|---|---|---|
| the `Conversation.out` ring buffer (`onUpdate` → `pushOut` in `src/conversation.mjs`) | tool names + status snapshots, answer text, turn boundaries | yes | only `dsh_read`, i.e. only the agent |
| the run collector `collector.tools` / `autoApprovals` | tool inputs, auto-approval summaries | yes | sentinel / `dsh_get` after the run |
| the sentinel `<RUNS_DIR>/<conv>/<run>.json` | answer, tool inputs (redacted) | no, written at the end | a file, 7-day TTL |
| the audit log `DSH_MCP_AUDIT_FILE` | who did what to which conversation (no tools) | yes | off by default |
| DSH's `~/.dsh/sessions` | everything, including reasoning | written by DSH | internal format |

So the live data existed only in the server process's memory, and its only exit was an MCP tool the agent calls.

## 4. Constraints

1. **The server is a stdio child.** Every MCP client spawns its own `dsh-any-agent`; there is no port for a page to connect to.
2. **Several instances.** With Claude Code, Codex and Cursor in use at once there are several server processes whose memory does not overlap. The view has to merge them.
3. **Shared ACP processes.** Conversations with the same `(cwd, permission)` share one DSH process (`src/host.mjs`), but events are routed to each `Conversation` by `sessionId`, so organising data per conversation is unaffected.
4. **The write lock.** One writer per conversation at a time (see [write lock](locking.md)), which makes "one file per conversation, single appender" hold naturally.
5. **No MCP notifications.** The existing design never relies on a client handling pushes; neither should this.
6. **Privacy.** Logs, sentinels and the registry never hold reasoning; anything new written to disk follows the same rule and the redaction in `src/redact.mjs`.
7. **Test isolation.** `test/cleanup.mjs` removes test sessions, so real runs and test runs must not share a directory.

## 5. Options

| Option | How | Pros | Main problem | Verdict |
|---|---|---|---|---|
| A. HTTP/SSE inside the server process | push to a local port from `pushOut` | live, small change | instances race for ports and need discovery; lifetime tied to the client; a local port is a CSRF / DNS-rebinding surface needing a token; Windows firewall prompts | no |
| B. Viewer reads `~/.dsh/sessions` | no server change | smallest change | couples to DSH's internal (pre-release) format; contains reasoning | no |
| C. Server appends an event file; viewers only read | JSONL per conversation, any viewer tails it | works across instances and restarts; same "files as IPC" idea as sentinels; viewers evolve independently | needs a stable schema, rotation and cleanup | **chosen** |
| D. MCP progress notifications / MCP Apps | the host's native UI | nice UX | `dsh_send` returns immediately, so there is no long-lived call to carry progress; host support varies | no (beyond the lightweight scope) |

## 6. Data contract: the live event stream

### 6.1 Location and switch

- Directory: `DSH_MCP_LIVE_DIR`, default `<dirname(STATE_FILE)>/live/`, next to `runs/` and `reviews/`.
- File: `<live>/<conversation_id>/events.jsonl`, one event per line, UTF-8, `\n`-terminated. One sub-directory per conversation so the existing `pruneDirTree` cleans it; the rolled `events.jsonl.1` lives there too.
- Level: `DSH_MCP_LIVE=off | meta | detail`, **default `detail`**.
  - `meta`: tool name, kind, status, timing, counts, approval mode and escalation, token counts. **No** tool inputs, commands, paths, prompts or answer text.
  - `detail`: `meta` plus redacted short previews (command / path, prompt, tool title). The sentinels already store full answers and untruncated tool inputs by default, so `detail` exposes no more than they do — and without the previews the call chain cannot say *which file* or *which command*.
  - `off`: write nothing.

### 6.2 Common fields

```json
{"v":1,"ts":"2026-11-08T09:12:03.120Z","conv":"…","run":"run-…","turn":3,"w":"<pid>:<instance>","n":42,"type":"tool"}
```

- `v`: schema version; a viewer that does not know it shows only the common fields.
- `w`: writer id (server pid + a random id per start), used to tell whether the writer is still alive.
- `n`: per-writer sequence number; ordering across writers uses `ts`.

### 6.3 Event types

| type | When | `meta` fields | `detail` adds |
|---|---|---|---|
| `conv.open` | `dsh_start` created the conversation | `cwd`, `permission`, `on_approval`, `model`, `client` | `title_hint` |
| `conv.close` | released without `forget` | `stopped` | — |
| `run.queued` | `dsh_send(queue=true)` | `position`, `cwd`, `client` | `prompt_preview` |
| `run.start` | a run starts | `via` (send / queue / interject), `permission`, `on_approval`, `cwd`, `client` | `prompt_preview` (≤200, redacted) |
| `tool` | `tool_call` / `tool_call_update`, **only when the status changes** or the input first arrives | `tool_call_id`, `name`, `kind`, `status`, `elapsed_ms` | `title`, `input_preview` (≤300, redacted) |
| `approval` | `request_permission` arrived | `mode` (auto-allow / auto-deny / ask / read-only-deny), `escalation`, `approval_id` (ask), `tool`, `tool_call_id` | `title`, `command_preview` |
| `approval.decided` | `dsh_approval_decide`, timeout, run end or close | `approval_id`, `by` (caller / timeout / turn_end / close), `decision`, `effective` | — |
| `interject` / `interrupt` | interjecting, interrupting | `mode`, `pending_run` / `busy` | `text_preview` |
| `usage` | during a run (≤ every 2 s, only on change) and once more with `final: true` after it ends | `tokens` (this run's delta: input, output, cache_read, cache_write), `session_tokens`, `context {used, window}` | — |
| `run.end` | the run ended (done / error / cancelled) | `status`, `stop_reason`, `duration_ms`, `tool_count`, `auto_approvals`, `auto_escalations` | `error` |

Notes from building it:

- **No `text` events**: answer text stays in the sentinel.
- **No writer hand-over events**: every event carries `w`, and the viewer checks whether the last writer's pid is alive (§6.5).
- A cancelled queued run, an interject that timed out and a run that could not start all get a `run.end`, so no run stays "queued" or "running" forever.
- **Token numbers** come from DSH's projection cache (`tokenUsage.totals`, `contextPressure`). Measured against real DSH: it updates them after every model step, so the server records a baseline when the run starts and emits the delta; the final value is emitted after the git snapshot, by which time DSH has written its totals.
- **Real DSH `tool_call`s carry no `name`**: the tool name is in `title` (`read`, `glob`, `write`, `pwsh`) and `kind` is always `other`. An identifier-only `title` is therefore used as the `name` at `meta` level; a `title` with spaces (which may contain a command) stays `detail`-only. Viewers show paths relative to the conversation's directory and hide `other`.

### 6.4 Writing

- Same discipline as `src/audit.mjs`: append one line synchronously, swallow every error, never throw into the main path.
- A line over 4 KB drops its `detail` fields and is marked `truncated: true`.
- All writes go through `emitLive(conv, type, fields, detail)`, called from existing hooks in `Conversation` — not generically from `pushOut`, so the internal buffer format never becomes an external contract.
- Reasoning (`agent_thought_chunk`) **has no event type**, so it cannot be written by construction; `DSH_MCP_SENTINEL_INCLUDE_REASONING` does not affect this.

### 6.5 Consistency and edge cases

- **Takeover**: the viewer trusts the `w` of the latest event per run / conversation; a writer that lost the lock emits nothing more.
- **Crash**: a run without `run.end` might still be running; if the pid in `w` is dead the viewer shows it as *interrupted*. No heartbeat needed.
- **Half lines**: viewers split on bytes and keep an incomplete trailing line for the next read.
- **Rotation**: over 5 MB the file rolls to `.1` (one generation kept); a new viewer reads `.1` first.
- **Cleanup**: pruned at startup with `DSH_MCP_SENTINEL_TTL_MS` (a separate `pruneLive` call, leaving `Hub.pruneSentinels`' return shape alone); deleted on `forget`; test-residue cleanup (`src/residue.mjs`) removes `live/<id>/` too.

## 7. Viewers

Both viewers only read `live/` and `conversations.json` (for titles), are independent processes, never touch the write lock or DSH, and add no dependencies. Titles prefer the caller's `title_hint` over DSH's native title, which is only a truncated prefix of the first prompt.

### 7.1 Terminal: `dsh-any-agent watch [conversation id prefix]`

A tree — client → conversation → run → tool calls / approvals — with per-run tokens. It runs on the terminal's alternate screen like `top` and rewrites only changed lines (clearing the screen each tick piled frames into Windows Terminal's scrollback). Lines are clipped to the terminal width (CJK counts as two columns) and the frame to its height; leaving restores the screen. `--once` prints once.

### 7.2 Page: `dsh-any-agent dashboard [--open]`

- A **separate process**, so option A's port and lifetime problems do not apply.
- Binds `127.0.0.1` on a random port; a one-time token is generated at start and put in the printed URL; the `Host` header is checked against DNS rebinding; GET only; a strict CSP.
- One inline static HTML file, no CDN; data over SSE. Files are polled (`fs.watch` is unreliable on Windows).
- Layout: conversations grouped by client on the left; the run timeline in the middle, with a timing bar per tool call and long runs scrolling inside their card; an inspector on the right (overview, token usage, tools, files read/written, approvals).

### 7.3 Language

Both viewers come in Chinese and English: `--lang zh|en`, else `DSH_MCP_LANG`, `LC_ALL` / `LC_MESSAGES` / `LANG`, then the OS locale. The page can also switch from its top-right corner and remembers the choice.

## 8. Relation to existing mechanisms

| Mechanism | Relation |
|---|---|
| `dsh_read` | Unchanged. It serves the agent; the live view serves the user. Same source, different exit. |
| Sentinels | Unchanged. The sentinel is the "run finished" latch and result carrier; the live stream is the process. `run.end` does not replace it. |
| Audit log | Unchanged. Audit answers "who did what to the conversation"; the live stream answers "what the conversation itself is doing". |
| Write lock | The live stream holds no lock; viewers never touch it, so looking never affects the GUI or a takeover. |
| `dsh_doctor` | Its `live` check reports the level, whether the directory is writable, the number of conversations, size and the last event — warnings only. |

## 9. Privacy and security

1. Reasoning has no place in the schema (§6.4).
2. Every string field goes through `sanitizeApprovalContext`, then is truncated per field.
3. The default `detail` level adds only redacted short previews, no more than the sentinels hold; `meta` drops them and `off` writes nothing.
4. **Why no control plane**: pending approvals, interjects and interrupts live in some server process's memory (`pendingApprovals` and friends). A separate dashboard process could only act on them through a reverse channel (say, a command directory the server watches), which would hand "anything that can write a local file" a way to approve escalations. That needs its own authentication design and does not fit the lightweight scope.
5. The dashboard listens on loopback only; the token is printed at start and never written to disk.

## 10. Tests

- Offline, through a fake hub and a fake ACP process: event order and fields, status de-duplication, level filtering, redaction, the 4 KB cap, approval decisions, failure / queue / cancel / forget, token deltas against a fake projection cache, and that a non-writable live directory does not fail a run.
- Reasoning regression: an `agent_thought_chunk` never appears in the file at any level.
- Viewers: byte-level line splitting, half lines, rotation, removal, unknown types, interrupted runs, rendering in both languages, in-place frame diffs, the dashboard's token / Host / read-only checks and SSE.
- Every suite uses its own temporary live directory; suites that drive `Conversation` directly import `test/live-sandbox.mjs` so running them alone never writes into the real `~/.dsh`.

## 11. Open questions

1. **Are DSH subagents' tool calls reported over ACP?** Not verified. If not, the view shows a subagent as one tool.
2. **Remote / multi-machine**: the live directory is local; remote or cloud sessions are out of scope.
