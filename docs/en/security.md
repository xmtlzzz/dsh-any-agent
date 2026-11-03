> Back to [README](../../README.md)

# 🔐 Permissions

| Tier | Approval default | Use for |
|---|---|---|
| `danger-full-access` (raw server default) | `auto-allow` | Zero friction; `setup` writes `workspace-write` by default |
| `workspace-write` | `auto-allow` | Writes are limited to the workspace by DSH's sandbox; out-of-workspace requests are auto-allowed unless you pass `on_approval=ask` |
| `read-only` | `auto-deny` | Analyzing untrusted samples (malware, unknown dumps) |

`on_approval` can be `auto-allow`, `auto-deny`, or `ask` (which exposes a pending approval for `dsh_approval_decide` to adjudicate).

**`read-only` is enforced, not merely a default**: it always runs with `auto-deny`; passing `auto-allow` or `ask` for a read-only conversation is rejected at `dsh_start`, and the approval layer refuses any permission request from a read-only conversation. After create/resume the server reads back the session's recorded tier; for read-only it **fails closed** if the projection cache has no permission record within the DSH flush window, rather than relying on the approval layer alone. Without that, a profile `defaultPreset` plus a permissive approval policy could let a write through (found by the adversarial audit).

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
- **Review records are the second intentional on-disk artifact.** `<state dir>/reviews/<conversation_id>/<run_id>.review.json` holds the verdict, the reviewer's `notes`/`findings`, the checklist and an evidence summary. `notes`/`findings`, the task preview and the evidence pass through the same credential redaction; reasoning is never included. Treat review records as sensitive too (they can quote code or paths).
- Sentinels **and review records** are pruned after 7 days by default (`DSH_MCP_SENTINEL_TTL_MS`; `0` keeps them forever).

> ⚠️ **DSH writes its own session log under `~/.dsh/sessions` and that log contains the full reasoning text** (even with `reasoning=hide`). It is what makes resume possible and is outside this server's control. The absolute "reasoning never reaches disk" claim applies to *this server's* artifacts only.
