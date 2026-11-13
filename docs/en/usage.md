> Back to [README](../../README.md)

## 📋 Workflow: dispatch, then collect later

MCP tool calls **block**, so `dsh_send` **does not block by default** (`wait=false`): you get a receipt immediately, the turn runs in the background, and the sentinel file wakes you when it finishes. The whole flow:

```text
1. dsh_send(conversation_id, prompt, wait=false)
     → { run_id: "run-abc123", background: true }        # returns without waiting for the turn

2. …keep working on something else (verified: another conversation ran a full turn meanwhile)…

3. dsh_status(conversation_id)
     → state=running | elapsed=3.5s | current_tool=pwsh | out=37 chars

4. dsh_read(conversation_id, cursor)                      # peek mid-flight
     → [me] … | [turn] turn 1 started | [tool] pwsh [in_progress]

5. dsh_get(conversation_id, run_id)                       # collect the result
     → status=done, elapsed=20.3s, full answer,
       review: { status: "pending", checklist: [...], submit: { tool: "dsh_review", ... } }

6. dsh_review(conversation_id, run_id, verdict="pass", notes="checked the diff and ran the tests")
     → review: { status: "pass", reviewed_at: "...", review_file: "..." }
```

**A returned result is not "done" until the caller has reviewed it.** Every result carries a `review` ticket: a checklist derived from the turn (did it change files? did it end normally? which tools ran?) plus the evidence needed to check it. Use your own tools to verify at least one claim — read the changed files, inspect `git diff`, run the relevant test — then submit a verdict with `dsh_review`. The default `advisory` mode does **not** block the next `dsh_send`; it only makes the review request part of the returned payload instead of something the caller has to remember. `fail` / `partial` require `notes` (or `findings`). A failed review is **not** fed back to DSH automatically — dispatch a fix with `dsh_send` when you decide to.

`run_id` is the receipt. Use it or the original `client_run_id` with `dsh_get` during sentinel retention, including after a restart. With only `conversation_id`, the tool checks memory for the current or most recently started turn and falls back to disk. Look up an unstarted queued run by its ID.

The server saves receipt metadata before accepting a run. On restart, it marks unstarted queued runs as cancelled and turns that did not return an ACP result as interrupted. If the ACP result was already saved, recovery preserves its original outcome and redacted answer. A recovered result with `git_snapshot_incomplete: true` needs a manual workspace check. Reuse the original key to retrieve the result and use a new key when you intend to execute the task again.

If the host cancels a blocking MCP request, the server stops waiting and sending progress. A dispatched turn continues to its sentinel. Use `dsh_interrupt` to stop a running turn.

## 🔔 Workflow: get notified on completion (no polling)

Besides `run_id`, `wait=false` returns a **`sentinel_file`** path plus **`sentinel_file_posix`** (the Bash/MSYS form — use it directly; hand-converting Windows paths is the easiest way to make your waiter hang until timeout). When the turn ends — **whether it succeeds, fails, or is cancelled** — the service **atomically writes** a small file there containing the final `status`, `result` and the **review ticket** (`result.review`). So you neither poll nor block: **wait for that file with a background task in your own host (Claude/Codex); the moment it appears, you're woken up.**

```bash
# sent="$sentinel_file_posix"   ← copy it straight from the tool result
sent='/c/Users/you/.dsh/.dsh-any-agent/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 7500 ))          # the turn's maximum duration (2h by default) + 5 min; the receipt's command uses the actual limit
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # task exits → host wakes you → read the file to collect
```

On a Windows host where Git Bash is unavailable (or hangs), wait on the native `sentinel_file` with PowerShell. On Windows the background receipt's structured content carries a ready-made, escaped **`sentinel_wait_powershell`** — use it directly:

```powershell
$f='C:\Users\you\.dsh\.dsh-any-agent\runs\<conversation_id>\<run_id>.json'   # write ' as '' inside the path
$dl=(Get-Date).AddSeconds(7500)
while(-not (Test-Path -LiteralPath $f)){ if((Get-Date) -gt $dl){ 'TIMEOUT'; exit 1 }; Start-Sleep -Seconds 2 }
'DONE'
```

Once the file exists: **read it** for `status` and `result` (preferred — immune to the in-memory window and survives restarts), or use `dsh_get(conversation_id, run_id)`. When a turn used many tools, the full result (every tool's complete input included) can exceed the client's per-call tool-result limit; pass `max_chars` (e.g. 8000) to `dsh_get`: the budget now applies to **both** text and structured — the answer is truncated and each tool keeps only its name/status plus `input_chars`. The full version is always in the sentinel file.

Design notes (especially under **concurrent multi-session** use):

- **No cross-talk**: the path is `<state dir>/runs/<conversation_id>/<run_id>.json`, namespaced by conversation. `run_id` sequence numbers are counted per-conversation, so two conversations *can* mint the same `run_id` in the same millisecond — the per-conversation directory keeps them apart. Arm one background task per run; each completes and wakes you independently.
- **Latch semantics**: the file is written once and kept. Even if the run finishes *before* you arm the waiter, `[ -f ]` is immediately true — you never miss it.
- **Atomic write**: `tmp` + `rename`; if the file exists its contents are complete. Each run uses its own tmp, so concurrent writes never clobber.
- **Completion is not pushed**: "completion notification" is entirely the sentinel file plus your background waiter; the server sends no MCP notification for it. The only notifications it sends are progress: when a call carries a `progressToken`, a blocking call (`dsh_send(wait=true)`, `dsh_interject`) reports every 5 seconds how long it has waited, the current tool name and how many characters the turn has produced — never commands, paths or text.
- **Review survives the sentinel**: `result.review` is written with the result, so a caller that only reads the file still sees the checklist. `dsh_review` then **atomically rewrites** that review block (`status` → `pass`/`partial`/`fail`, plus `notes`, `reviewed_at`, `review_file`); the latch itself never disappears. Review records live under `<state dir>/reviews/` and are pruned on the same 7-day TTL as sentinels.
- **★ No reasoning in the sentinel**: the payload carries the answer, thinking *statistics*, usage and (credential-redacted) tool inputs, but never reasoning text — `result.thinking` is stripped and replaced by a boolean `thinking_omitted` (`true` when reasoning was removed, `false` when there was none), because this server's rule is that reasoning never reaches its own disk artifacts. `dsh_get(run_id)` still returns it from memory while the record lives. `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` breaks that guarantee deliberately. Note that **DSH's own session log does contain reasoning** — see [Logging and privacy](security.md).

> On startup, the service prunes sentinels and review records older than seven days by default. Set `DSH_MCP_SENTINEL_TTL_MS` to change the retention period or set it to `0` to disable pruning. Keep the sentinel while you still need the result or its idempotency key.

## 🧵 Workflow: many conversations at once

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵 running (9s, tool=pwsh, 40 chars this turn) | cwd=…
     - … | id=33427096… | 🔵 running (8s, 34 chars this turn)        | cwd=…
2. dsh_read(id,  cursor=0)      # read the first, note the cursor
3. dsh_read(id2, cursor=0)      # switch to the second
4. dsh_read(id,  cursor=<prev>) # switch back; entries that grew since <prev> reappear (match by seq)
```

## 🌿 Workflow: editing the same repository as the caller (worktree isolation)

While DSH works in the background you (the caller) are often still editing the same repository. Both sides touching the same files overwrite each other, and `workspace_changed` and the review evidence pick up the other side's changes. Use `dsh_start(isolation="worktree")`:

- The server creates a worktree for the git repository `cwd` is in (under this server's state directory, not inside the repository) and a branch `dsh/<time>-<random>`, and the conversation works there; a `cwd` in a subdirectory maps to the same subdirectory in the worktree;
- It starts from the main checkout's current **HEAD**: **uncommitted** changes there are not carried over (the start result says so);
- The new worktree has no `node_modules`, virtual environment or build output, so DSH often has to install dependencies first — which is why it is off by default;
- The changes stay on that branch for **you to review and merge**; the server never merges;
- `dsh_release(forget=true)` deletes the worktree directory if it is clean (the branch and its commits stay); with uncommitted changes it is kept and the path is reported;
- For safety the repository's own git hooks and filter drivers (`smudge` / `clean`) **do not run** when the worktree is created, checked or removed (the repository may be untrusted), so hooks such as husky's that install things on checkout do not run either, and files tracked with Git LFS are pointer files in the worktree (DSH can run `git lfs pull` there if it needs them).
## 👀 Side view: what the dispatched work is doing

The calling agent can `dsh_read`, but you, sitting in front of the client, usually only see one `dsh_send`. The server writes each conversation's activity to a live event stream (`<state dir>/live/<conversation_id>/events.jsonl`), so you can watch the call chain **without going through the agent**:

```text
client (who dispatched) → conversation → run (send / queue / interject) → tool calls · approvals
```

```bash
dsh-any-agent watch
```

```bash
dsh-any-agent dashboard
```

- `watch [conversation id prefix]`: live call chain in the terminal (`--once` prints once and exits, `--runs N` shows the last N runs per conversation).
- `dashboard`: a **read-only** local page; prints a URL with a one-time token (binds `127.0.0.1` only, checks the Host header, has no control that changes state); add `--open` to launch it in your default browser.
- **Interface language**: both follow your system language (`DSH_MCP_LANG` / `LANG` / the OS locale); pass `--lang en|zh` to choose. The page also has a switch in its top-right corner, and remembers your choice.
- Both are separate processes: they don't start the server, never touch the write lock and never talk to DSH, and they show conversations dispatched from every client (Claude Code, Codex, Cursor, …) together.
- A run whose writer process has exited without finishing is shown as interrupted.
- **Token usage**: each run's input / output / cache read-write delta, the session total and context-window use, updated while the run is going (numbers come from DSH's own session record). The dashboard's side column has a "Token 消耗" panel and a per-turn chart.
- Tune with `DSH_MCP_LIVE`: `detail` (default; redacted command/path/prompt previews), `meta` (tool names, status, timing, approval kinds only), `off`. **Reasoning is never written at any level.** Event files share the sentinels' 7-day TTL; `dsh_release(forget=true)` deletes them too.

## 🤫 Reasoning: hidden by default

DSH separates reasoning from answer text at the model layer, and ACP exposes them as **two independent streams**. This server hides reasoning by default and returns only **statistics** (characters, duration, chunk count) — so the caller knows thinking happened without paying for it in context.

- `reasoning=hide` (default) — content dropped, stats returned
- `reasoning=marker` / `summary` / `full` — progressively more content (mind your context budget)
- `dsh_read(include_reasoning=true)` — live reasoning of the *currently running* turn only; it is never buffered and is discarded when the turn ends

> ⚠️ This server never writes reasoning to its own logs, state file or sentinels — but **DSH's own session log (`~/.dsh/sessions/**/session.v4.jsonl.zstd`) does contain the full reasoning text**, even when `reasoning=hide`. That is DSH's storage (it is what makes resume possible) and is outside this server's control; account for it when analyzing sensitive data.
