> Back to [README](../../README.md)

# 🔐 Permissions

| Tier | Approval default | Use for |
|---|---|---|
| `workspace-write` (raw server default; also what `setup` writes) | `auto-allow` | Writes are limited to the workspace by DSH's sandbox; out-of-workspace requests are auto-allowed unless you pass `on_approval=ask` |
| `danger-full-access` | `auto-allow` | Whole-machine write access; creating or resuming a session in this tier requires `DSH_MCP_ALLOW_FULL_ACCESS=1` on the machine |
| `read-only` | `auto-deny` | Analyzing untrusted samples (malware, unknown dumps) |

`on_approval` can be `auto-allow`, `auto-deny`, or `ask` (which exposes a pending approval for `dsh_approval_decide` to adjudicate).

**Under `auto-allow`, `workspace-write` is a soft boundary.** When DSH's sandbox blocks something (e.g. child-process pipes on Windows), DSH asks for `sandbox_permissions: danger-full-access` and `auto-allow` grants it. The default is unchanged, but the grant is **no longer silent**: every turn result carries `auto_approvals_total`, `auto_escalations_total` and up to 20 redacted `auto_approvals` summaries (tool, escalation tier, justification, command preview), and the review ticket's evidence and checklist call out "N auto-approved this turn, M of them escalations". To gate each one, start a conversation with `on_approval=ask`.

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
