> Back to [README](../../README.md)

# 🔐 Permissions

| Tier | Approval default | Use for |
|---|---|---|
| `workspace-write` (default) | `auto-deny` | DSH limits writes to the workspace. Escalation requests are denied by default. |
| `danger-full-access` | `auto-allow` | Whole-machine write access, and DSH no longer asks for approvals. Simplest for personal use: `dsh-any-agent-setup --yes --permission danger-full-access` makes it the default tier, which by itself counts as allowing it on the machine; if the default is another tier and only some conversations should get it, also set `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `read-only` | `auto-deny` | Analyzing untrusted samples (malware, unknown dumps) |

`DSH_MCP_APPROVAL` sets the machine's default and ceiling, in order from strictest to most permissive: `auto-deny`, `ask`, `auto-allow`. Callers may pick a stricter `on_approval`. Stored conversations are capped when restored. Set `DSH_MCP_APPROVAL=ask` and reconnect to handle requests with `dsh_approval_decide`.

DSH applies the requested sandbox tier. Under `danger-full-access`, commands run with the user's privileges and DSH skips approval requests. Use `read-only` when inspecting untrusted material.

When you opt in to `auto-allow`, DSH can obtain `sandbox_permissions: danger-full-access` for blocked operations. Turn results record `auto_approvals_total`, `auto_escalations_total` and up to 20 redacted approval summaries. The review ticket includes those counts.

**`read-only` is enforced, not merely a default**: it always runs with `auto-deny`; passing `auto-allow` or `ask` for a read-only conversation is rejected at `dsh_start`, and the approval layer refuses any permission request from a read-only conversation. After create/resume the server reads back the session's recorded tier; for read-only it **fails closed** if the projection cache has no permission record within the DSH flush window, rather than relying on the approval layer alone. Without that, a profile `defaultPreset` plus a permissive approval policy could let a write through (found by the adversarial audit).

## 🧷 Input boundaries

- **`conversation_id` / `run_id` are path-safe ids.** They are used in sentinel, review, metadata and tombstone paths; the server accepts only a single segment (letters/digits/`._-`, max 200) and rejects separators or `..` before any `join()`. This covers `dsh_get`'s sentinel read-back and `dsh_review`'s `<state>/reviews/<conv>/<run>.review.json` write.
- **`cwd` cannot be the filesystem root for writable tiers.** `workspace-write` at `/` or `C:\` would make the sandbox root the whole disk; the home/root guard resolves symlinks first, so a symlink to the root or home is rejected too. `danger-full-access` remains an explicit opt-in.
- **`title_hint` is capped at 200 characters** (schema + runtime), because it is persisted in the registry and sidecar on every turn.

## 🪟 Workspace visibility in the DSH GUI

Two different things — don't confuse them:

| | Depends on | Status |
|---|---|---|
| **Workspace effectiveness** | the conversation's `cwd` | ✅ Always correct. Process working directory, file placement and sandbox write root all follow it |
| **GUI grouping** | `sessionIds` in `~/.dsh/storages/workspace.json` | ⚠️ This server registers it, but **the running DSH server caches the registry in memory** — external file edits only take effect after a DSH restart |

Verified experimentally ([`test/workspace-effect.mjs`](../../test/workspace-effect.mjs)): two conversations in two desktop folders, given **no path at all**, each wrote its file into its own workspace, self-reported the correct working directory, and leaked nothing into the server's cwd / home / temp / the other workspace (24/24 checks).

Maintenance CLI:

```bash
node bin/dsh-any-agent-workspaces.mjs --list                  # inspect the registry
node bin/dsh-any-agent-workspaces.mjs --backfill              # register every session found on disk
node bin/dsh-any-agent-workspaces.mjs --prune-temp            # drop temp-directory entries
node bin/dsh-any-agent-workspaces.mjs --prune-empty           # drop empty workspaces whose path is gone
node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions   # delete test sessions (strict rules)
```

> ⚠️ Before restarting DSH, **don't touch workspaces in the GUI** — the server will write its in-memory state back over the file.

## 🕶️ Logging and privacy

Silent by default — **not one byte is written**.

1. MCP's **stdout is the protocol channel**; anything mixed in corrupts the stream.
2. This server is launched by Claude/Codex, so its stderr lands in *their* logs.
3. DSH's own stderr may carry model output **including reasoning**, so it is never forwarded by default.

| Level | Behavior |
|---|---|
| `silent` (default) | nothing at all |
| `info` | this server's own lifecycle events only — **never any DSH output** |
| `debug` | more of our own events; still no DSH output |
| `DSH_MCP_LOG_STDERR=1` | additionally forward DSH's raw stderr (**may contain reasoning**) |

**This server never writes reasoning to disk** — it does persist the content a caller needs to collect or review a result offline, but never reasoning text:

- Not in logs (silent by default). The state file and the per-conversation metadata sidecars under `<state dir>/meta/` hold metadata only (id, cwd, permissions, counters, title hint) — a smoke-test assertion guards the registry.
- **The async completion sentinel persists the answer, usage and tool inputs** (it must, so a caller can collect offline) but **strips `result.thinking`** and always reports `thinking_omitted` (true when reasoning was removed, false when there was none). Tool inputs are passed through the same credential redaction as approvals, but the sentinel still contains commands and file contents — treat it as sensitive. A test asserts that even when `reasoning=full` is requested, no reasoning text appears in the sentinel — while `dsh_get(run_id)` still returns it from memory. Set `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` to break this on purpose.
- **Review records are the second intentional on-disk artifact.** `<state dir>/reviews/<conversation_id>/<run_id>.review.json` holds the verdict, the reviewer's `notes`/`findings`, the checklist and an evidence summary. `notes`/`findings`, the task preview, the evidence **and each checklist item** pass through the same credential redaction (the checklist can interpolate `result.error`); reasoning is never included. Treat review records as sensitive too (they can quote code or paths).
- Sentinels **and review records** are pruned after 7 days by default (`DSH_MCP_SENTINEL_TTL_MS`; `0` keeps them forever).
- The live event stream (`<state dir>/live/`, read by `watch` / `dashboard`) carries **redacted** command, path and prompt previews by default — no more than the sentinels already hold — never reasoning, and is pruned on the same 7-day TTL. Set `DSH_MCP_LIVE=meta` to drop the previews or `off` to write nothing. `dashboard` binds `127.0.0.1` only, requires a one-time token, checks the Host header, and is read-only.

> ⚠️ **DSH writes its own session log under `~/.dsh/sessions` and that log contains the full reasoning text** (even with `reasoning=hide`). It is what makes resume possible and is outside this server's control. The absolute "reasoning never reaches disk" claim applies to *this server's* artifacts only.

### 📁 What this server writes to disk

`<state dir>` is `~/.dsh/.dsh-any-agent/` by default (it follows `DSH_MCP_STATE`). None of these holds reasoning text.

| Path | Contents | Kept for | How to turn off / clean up |
|---|---|---|---|
| `<state dir>/conversations.json`, `meta/<conversation_id>.json` | Conversation registry and metadata: id, cwd, permissions, counters, title hint; no message text | Until the conversation is forgotten | `dsh_release(forget=true)` |
| `<state dir>/runs/<conversation_id>/<run_id>.json` | Completion sentinel: answer, usage, review ticket, tool inputs (all redacted) | 7 days (`DSH_MCP_SENTINEL_TTL_MS`) | `DSH_MCP_SENTINEL_TOOL_INPUTS=0` keeps only each tool input's length (and drops auto-approval command previews); keep it while the result or its idempotency key is needed |
| `<state dir>/runs/<conversation_id>/<run_id>.running` | Accepted receipt: run ID, caller's idempotency key, redacted prompt preview, queue or execution status, owning process, and the redacted result saved before the final Git snapshot | Removed when the sentinel is written | Keep the state directory on a filesystem that supports hard links |
| `<state dir>/reviews/<conversation_id>/<run_id>.review.json` | Review record: verdict, notes, checklist, evidence summary (redacted) | Same as sentinels, 7 days | `DSH_MCP_REVIEW=off` stops automatic tickets |
| `<state dir>/live/<conversation_id>/events.jsonl` | Live event stream: event type, time, tool name, client name; by default also redacted command / path / prompt previews | Same as sentinels, 7 days; rolled at 5 MB | `DSH_MCP_LIVE=meta` drops the previews, `off` writes nothing |
| `<state dir>/locks/<conversation_id>.json` | Write-lock holder record: PIDs of this server and the DSH child, cwd | Cleared on release or once the processes exit | — |
| `<state dir>/worktrees/` | Conversation directories for `isolation=worktree` (a checkout plus DSH's changes) | A clean one is deleted on forget; one with uncommitted changes is kept; the branch is always kept | Don't use `isolation=worktree`; move it with `DSH_MCP_WORKTREES_DIR` |
| `<state dir>/daemon-<id>.json`, `daemon-<id>.log` (plus `.sock` on POSIX) | The resident process's PID and random token (readable by the user only); its stderr | The info file goes when the process exits; the log rolls to `.1` at 10 MB | Don't enable `DSH_MCP_DAEMON` |
| `$DSH_HOME/.dsh-any-agent-forgotten/<conversation_id>.json` | Forget tombstone: conversation id and time | Cleared at startup once the session file is gone | — |
| The file `DSH_MCP_AUDIT_FILE` points to | Metadata audit: events, ids, decisions, counts; no prompts, answers, reasoning or tool inputs | Rolled to `.1` at 10 MB | Off unless the variable is set |
| `<state dir>/update-check.json` | The latest version number `dsh_doctor` last read from npm, and when | Re-checked and overwritten after 24 hours | `DSH_MCP_UPDATE_CHECK=0` (also stops the network request) |
| `.bak-dsh-<stamp>` next to client configs | The config as it was before `dsh-any-agent-setup` wrote to it | Up to 20 per config file (`DSH_MCP_BACKUP_KEEP`) | Delete by hand |

Network: this server itself contacts `registry.npmjs.org` only when `dsh_doctor` is called (to read this package's latest version; the request carries no user data; `DSH_MCP_UPDATE_CHECK=0` turns it off). Model requests are made by DSH, not by this server.

On the DSH side (not under this server's control): the session logs in `~/.dsh/sessions` (with full reasoning, see above); this server also registers each conversation's workspace in DSH's `workspace.json` so the GUI shows it (`DSH_MCP_REGISTER_WORKSPACE=0` turns that off).
