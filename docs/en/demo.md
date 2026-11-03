> Back to [README](../../README.md)

# ▶️ Five minutes: dispatch → interject → collect

This page is not a feature list; it is a **path that actually runs**. When you are done you will have seen an agent finish work in the background, you will have changed requirements twice mid-flight, and you will have verified the artifacts yourself — instead of taking "done" for an answer.

```bash
npm run demo
```

## What problem this solves

Your editor already has a coding agent, and it is trapped in your window: close the editor and it is gone; want to change course? Wait for the turn to end.

`dsh-any-agent` turns DSH into **a backend colleague for your other agents**: you dispatch from Claude Code / Codex / Cursor, it works in the background, and a sentinel file tells you when it is done. This demo is the smallest runnable version of that loop.

## 0. Prerequisites

- **Node.js ≥ 22.15** (the server uses `node:zlib`'s `zstdDecompressSync` to read session headers; older versions lack that API)
- **A working DSH**: `npm i -g @deepseek-ai/dsh`, with a usable provider and credentials under `~/.dsh` (if the DSH GUI can chat normally, you are set)
- No Claude Code or Codex required — the demo is its own MCP client

## 1. Run it

```bash
npm run demo
```

It creates an empty workspace in a temp directory, then asks DSH to write two files there (`fib.mjs` and `test-fib.mjs`) and run the tests. **It interjects twice along the way**:

1. `fib(n)` must throw `RangeError` for negatives, with a matching assertion;
2. a comment at the top of `fib.mjs` stating the time complexity.

When the turn ends the script **verifies the artifacts itself**: it checks that both files exist and runs `node --test test-fib.mjs` itself. The model's own summary does not count here.

Measured: one full run took **57.6 s** on this machine (Windows / Node 24.21.0 / default profile) — three turns, two interjections, four test cases passing. It moves with the model, which is why the claim is "five minutes" and not "one minute".

## 2. What the six steps do, and why each one matters

| Step | Tool | Why it matters |
|---|---|---|
| 1 | `initialize` / `tools/list` | Only four standard MCP methods; any MCP-over-stdio client can connect |
| 2 | `dsh_start` | Creates a **long-lived** conversation. The identity is the on-disk `sessionId`; the process is only a cache |
| 3 | `dsh_send(wait=false)` | Returns `run_id` + `sentinel_file` immediately and runs the turn in the background — your client's own timeout cannot kill the work |
| 4 | `dsh_interject` ×2 | Change course mid-turn. It is "cancel + immediately start a new turn"; **work already done is not lost** |
| 5 | read the sentinels | **One turn, one sentinel**: the interrupted turn writes `cancelled`, the last turn writes `done`. The file lands atomically and survives a service restart |
| 6 | `dsh_get` + own verification | `run_id` is the receipt; but the verdict comes from what is on disk, not from what the model says |

## 3. Three design points that are easy to miss

**Why doesn't step 3 wait?** MCP tool calls block, and client response timeouts are usually a few minutes. `wait=false` makes "dispatch" instant and closes the loop with a **sentinel file** — that is the precondition for handing over multi-hour work.

**`dsh_interject` blocks until the turn it started has finished.** It is not a fire-and-forget notification: the elapsed time you see in step 4 includes a whole model turn. That is usually what you want (returning means the redirection took effect), but give it room — use `timeout_ms` to bound the wait; if it never reaches idle the call fails and this interjection lands as `cancelled` (it does **not** sit in a queue and run later).

**Why doesn't an interjection destroy finished work?** ACP explicitly rejects a concurrent prompt (`a prompt is already in flight`), so `dsh_interject` cancels the current turn and starts a new one with the full history. It is a practical equivalent, not true mid-turn steering — see [known limits](limits.md) item 2.

**Why does the demo use `workspace-write` instead of the default tier?** So the sandbox actually does something: the task should only touch two files inside its workspace. `read-only` cannot start a shell at all, and `danger-full-access` is a poor default example.

## 4. A different task / a zero-cost preview

```bash
# your own task (the built-in interjections are skipped)
npm run demo -- --prompt "translate the README in this directory into English and check the Markdown"

# replay the last recorded run: no DSH, no tokens, a few seconds
npm run demo -- --replay

# keep the temp workspace so you can inspect the result
npm run demo -- --keep
```

To record a replayable transcript:

```bash
npm run demo -- --save      # writes demo/transcript.json on success
```

## 5. Isolation: it does not touch your daily state

The registry, sentinels and write-lock markers all live in a temp directory that is deleted at the end. Running the demo **cannot pollute the conversation list you actually use from Claude Code**.

Only one thing stays in `~/.dsh`: DSH's own session log (credentials and providers live there, so it cannot be isolated). The script calls `dsh_release(forget=true)` at the end to remove the conversation from the registry.

## 6. What it proves, and what it does not

**Proves**: the MCP handshake works, a conversation can be created, background dispatch delivers a sentinel, an interjection redirects the task without breaking it, and the artifacts land on disk with tests that really pass.

**Does not prove**: that your model will behave as expected (models differ a lot), that a job is still healthy hours later (the demo runs for minutes), or how it behaves with many concurrent conversations — [the tests](tests.md) cover those separately.

> Be aware: **the demo really calls a model and really spends tokens**. To see the flow before deciding to run it, start with `--replay`.
