> Back to [README](../../README.md)

# 🔒 The write lock: one writer per conversation at a time

DSH conversations carry a **cross-process write lock**: **it never expires while the holder lives, and no API can take it from a live holder** — so **whoever gets there first decides everything**. This server turns that into "**you can look, we can write**":

| Situation | Outcome |
|---|---|
| **This server holds the lock** (recently used, or `keep_alive=true`) | ✅ Opening it in the GUI is **read-only**: you still **see the content**, but you **cannot take the lock**. Since 0.4.0 the process is reaped only after **10 minutes** idle; `keep_alive=true` sessions are never reaped for idleness |
| **You open it in the GUI while the lock is free** | ❌ **The GUI keeps it permanently** (navigating away, waiting and archiving all fail to release it) and this server **can never reconnect** — only restarting `dsh web` helps |
| **Recommended** | Watch progress with **`dsh_read`** (cursor-based incremental reads) or the **sentinel file**; if you must use the GUI, `dsh_release` first (that interrupts a running turn, so it fits the gaps between tasks) |

**Who holds it** is reported by `dsh_status.lock_holder`; `dsh_takeover` handles the four cases:

| `lock_holder` | Meaning | Action |
|---|---|---|
| `self` | this process holds it | nothing to preempt |
| `stale-mcp` | the holder is **alive but silent** (no heartbeat for 90 s — typically that MCP is wedged) | ✅ `dsh_takeover` **kills and takes over** |
| `live-mcp` | another **live** dsh-any-agent instance is using it | ⚠️ refused by default; `force=true` takes it |
| `none` | no registration → most likely **your own DSH GUI** | ❌ **never killed** (GUI conversations live inside the single `dsh web` process, so killing it takes down your whole UI and every GUI conversation with it), reported only |

> **Two measured footnotes.** ① **A crash leaves no orphan lock** — `SIGKILL` the MCP and its children exit with it (their stdio pipe closes), releasing the lock automatically ✓; so `stale-mcp` really means "**alive but wedged**". ② **Several instances**: the registry is last-writer-wins (a later save drops conversations it never saw), but the **session store is authoritative** — any session on disk is recoverable **by id alone**; if you give instances different `DSH_MCP_STATE` files, **point `DSH_MCP_LOCKS_DIR` at one shared directory**, or they cannot see each other's holder registrations.
>
> The full measurements (the A/B probe method, the evidence that the GUI opens read-only, why even archiving does not release the lock, and crash-vs-wedge) are in [Usage Notes §3.5–3.12](caveats.md).
