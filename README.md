<div align="center">

<img src="https://raw.githubusercontent.com/xmtlzzz/dsh-any-agent/main/docs/brand/header.jpg" width="100%" alt="dsh-any-agent — a blue-haired chibi whale-girl eating white rice beside a coding laptop">

**Give any MCP client a coding buddy that sticks around.**

**[Website](https://dsh-any-agent.xmtlz.dev/)** · **English** · [简体中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-any-agent.svg?style=flat-square)](https://www.npmjs.com/package/dsh-any-agent)
[![node](https://img.shields.io/node/v/dsh-any-agent.svg?style=flat-square)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/dsh-any-agent.svg?style=flat-square)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg?style=flat-square)](package.json)

[Website](https://dsh-any-agent.xmtlz.dev/) · [Quick start](#quick-start) · [Features](#-why-its-different) · [Tools](#-tools) · [Usage notes](USAGE-NOTES.en.md) · [Changelog](CHANGELOG.md)

</div>

🧪 0.5.0 offline suite green, including caller review (memory controls, team mode and the dispatch surface are all covered) · 🔌 MCP over stdio · 📦 Zero dependencies · 📜 MIT

An MCP server that drives DeepSeek Harness as a **long-lived coding agent**. Hand it a goal, let it write code and run scripts, steer it mid-flight, and collect the result when you are ready.

**Claude Code · Claude Desktop · Codex · Cursor · Windsurf · Zed · Gemini CLI · opencode · VS Code** — or any client that speaks MCP over stdio.

## 🎯 The problem this solves

You already have a coding agent in your editor. What you do **not** have is one that can:

- **hand a multi-hour job to another agent and walk away** — then collect the result when it's done;
- **keep the job alive across restarts** of your editor, your session, your machine's idle reap;
- **cut in mid-flight** when it's going the wrong way, without destroying the work;
- **run several of them at once** and switch between them.

DSH (DeepSeek Harness) can do all of that — it has file/shell tools, skills, subagents and workflows — but it is a GUI-first application. Its own `sdk` profile exposes only 3 requests and can't resume, cancel, or answer approvals.

**This server is the missing adapter:** it makes DSH into a *well-behaved background agent* that any MCP client can hire, supervise and collect from.

> Think of it as `&job` — like `&` in a shell, but for an agent.

## ✨ Why it's different

| Capability | What you get |
|---|---|
| 🔄 **A dead process never kills a conversation** | The identity lives on disk. A crash, an idle reap, even restarting this whole server costs you nothing — the next call transparently resumes it, memory intact (verified across processes). |
| 🗣️ **You are never stuck waiting** | Steer a conversation mid-flight — **interject** to stop and redirect (~100 ms to reach idle, measured over four cancelled turns), or **queue** a remark for after the current turn. Interrupting never damages the conversation. |
| 📡 **Completion notification, not polling** | Long tasks return instantly with a `run_id`; when the turn ends, a **sentinel file** is written atomically so a background task in *your* host wakes you. No polling, no occupied turn. |
| 🪟 **Many conversations at once** | `dsh_list(only_running)` shows what's live; `dsh_read` gives cursor-based incremental output. Cycle between them like windows. |
| 🧠 **Reasoning hidden by default** | You get "thought for N chars / M seconds" statistics instead of context-burning prose — and it is never logged, never written to disk. |
| 🤫 **Silent by default** | Not one byte on stderr, so nothing pollutes your host's logs. stdout carries the protocol and nothing else. |
| 🧩 **Capabilities compose** | DSH can mount its own MCP servers (IDA Pro, browsers, your internal tooling), so this is a bridge to a whole toolbox. |
| 🛡️ **Read-only that really is read-only** | `read-only` sandbox plus auto-denied approvals, for working on untrusted samples. |
| 🔎 **Caller review, not blind relay** | Every result carries a `review` ticket (checklist + evidence + `dsh_review` entry). The caller verifies with its own tools, then records `pass` / `partial` / `fail`. Advisory by default — it never blocks the next dispatch, and a failed review is not silently fed back to DSH. |

## 🧭 Positioning: a dispatcher, not a capability aggregator

**This server dispatches; it does not re-implement what DSH already does.** The caller
gives a goal, and DSH decides which tools, skills, subagents or team to use. Nothing
from DSH's tool surface is proxied, duplicated or preloaded.

| Owned by DSH (this server stays out) | Owned by this server (dispatch semantics) |
|---|---|
| File I/O, shell, search, editing | Session identity and cross-crash resume |
| Skills, subagents, Agent Teams, task board | Async dispatch, receipts, completion sentinels |
| Model routing, sandbox, approval policy | Incremental read, interject, interrupt |
| Memory/context/compaction | Approval bridge, write-lock governance, queue, inbox |
| worktrees (the agent creates them with git) | Setup, status, doctor, audit |

**Dispatch on demand**: `dsh_send` passes a goal, not a tool manifest, and the caller
does not need to know DSH's tool list. The DSH agent picks what it needs — including
capabilities added after this server was built (for example the experimental Agent
Teams). This server does not grow one MCP tool per DSH feature.

**Team mode (opt-in since 0.5.0)**: off by default. Run `dsh-any-agent team on`
and reconnect; the profile switches to `dsh-team` (the experimental Agent Teams
packages), and `dsh_send` then adds a short "form a team if this needs parallel or
multi-role work" line; simple tasks are not forced into a team. Turn it off with
`dsh-any-agent team off`, or for one call with `dsh_send(team=false)`. The team
profile disables the legacy `subagent` tools and replaces them with nine team
tools; teammates share one workspace.

**Only dispatch semantics become tools**: start, send, read, get, review, interject,
interrupt, approve, queue, inbox, status, release, takeover, doctor. No file I/O, no
shell, no editor, no task board.

**When to add something outside DSH**: only when you need a *guarantee* rather than a
*behavior* — for example, several top-level sessions editing the same repository need
outer worktree isolation. For collaboration, prefer letting DSH run the team itself
(mount the experimental team packages into the profile; teammates share one workspace).

## Quick start

Requires **Node.js ≥ 22.15** and **DSH installed with a working model route and credentials**. See [Requirements](#-requirements) for details.

```bash
npm install -g dsh-any-agent
dsh-any-agent-setup
dsh-any-agent-setup --yes
```

The second command previews the changes; `--yes` applies them. Reconnect your client's MCP server, then ask your agent to start a DSH conversation in your project, dispatch a task, and collect the result. The [dispatch workflow](#-workflow-dispatch-then-collect-later) shows the tool sequence.

> **Before your first task:** read the [Usage Notes](USAGE-NOTES.en.md), especially the model-config and external-MCP permission boundaries. External MCP tools bypass DSH's sandbox. For a fresh machine, follow the [migration guide](USAGE-MIGRATION.en.md).

<details>
<summary>Full contents</summary>

- **Quick start** — [Install and connect](#quick-start) · [Changelog](CHANGELOG.md)
- **Start here** — [The problem](#-the-problem-this-solves) · [Why it's different](#-why-its-different) · [Why not just wrap the DSH CLI](#-why-not-just-wrap-the-dsh-cli) · [Requirements](#-requirements) · [Setup](#-setup)
- **Using it** — [Tools](#-tools) · [Dispatch then collect](#-workflow-dispatch-then-collect-later) · [Completion notifications](#-workflow-get-notified-on-completion-no-polling) · [Many conversations](#-workflow-many-conversations-at-once)
- **Behavior** — [Permissions](#-permissions) · [Reasoning](#-reasoning-hidden-by-default) · [Logging and privacy](#-logging-and-privacy) · [Workspace & GUI](#-workspace-visibility-in-the-dsh-gui)
- **Hard parts** — [The write lock](#-the-write-lock-one-writer-per-conversation-at-a-time)
- **Reference** — [Environment](#-environment-variables) · [Tests](#-tests) · [Known limitations](#-known-limitations) · [Why the old profile name?](#-why-is-the-profile-still-called-dsh-mcp)

</details>

## 🧰 Tools

| Tool | What it does |
|---|---|
| `dsh_start` | Create a conversation: workspace, permission tier, approval policy, **reasoning effort (default `max`)**, model |
| `dsh_send` | Hand it a task. **Defaults to `wait=false`: returns a `run_id` + `sentinel_file` immediately**, the turn runs in the background and the sentinel file notifies you when it's done (recommended). `wait=true` blocks until the turn ends; hitting `timeout_ms` (default `0` = wait forever) **only downgrades to background — the turn is never cancelled and the result is never lost** |
| `dsh_list` | All conversations with live state: `running` / `idle` / `detached`, elapsed time, current tool, output so far. `only_running=true` for active ones |
| `dsh_read` | **Cursor-based incremental read** of what a *running* conversation is producing right now. The cursor is a **revision number**: an entry whose text grew since your last read reappears — match it by `seq` and replace its text, don't append again |
| `dsh_get` | Conversation details; with `run_id`, the **final result of that dispatch** (the "collect the result later" entry point) **plus its review ticket**. Run records live in memory (last 20) — use the sentinel file after a restart |
| `dsh_review` | **Caller review.** Submit `pass` / `partial` / `fail` for a completed run, with notes and optional findings. The verdict is written to `<state dir>/reviews/<conversation_id>/<run_id>.review.json` and back into the in-memory run and sentinel. Advisory by default: it never blocks the next `dsh_send` |
| `dsh_interject` | Interject while it's busy: `interject` = stop and redirect, `queue` = wait for the current turn, then speak. **This round writes a sentinel too**, and the reply carries its `sentinel_file`. On an idle conversation it behaves like `wait=true` and **blocks until the turn ends** |
| `dsh_takeover` | **Preempt the write lock.** The only way out when another DSH process holds it (DSH has no steal API — preempting means killing the holder). It classifies the holder first: our own orphaned child → taken automatically; another live instance → needs `force`; **GUI/unknown → never killed**, reported instead |
| `dsh_interrupt` | Stop the current turn (the conversation stays healthy) |
| `dsh_release` | Hand the conversation back (frees the write lock so you can open it in your own DSH GUI). Still resumable; `forget=true` writes a tombstone — by-id lookups are refused until you delete `$DSH_HOME/.dsh-any-agent-forgotten/<id>.json` |
| `dsh_approval_decide` | Adjudicate a pending approval (only when `on_approval=ask`) |
| `dsh_status` | Lightweight status check (single conversation) |
| `dsh_inbox` | **Cross-conversation approval inbox**: every pending approval with reason, input and age; decide with `dsh_approval_decide` |
| `dsh_queue` | Inspect/modify the session queue: `list` / `remove` / `update` / `promote` (created by `dsh_send(queue=true)`, memory only) |
| `dsh_doctor` | Read-only health check: DSH version, profile, state/dir writability, orphan locks, sessions and RSS, effective config |

## 📚 Documentation map

| Document | Contents |
|---|---|
| [Setup](docs/en/install.md) | Requirements, profile bootstrap, 9 MCP clients |
| [Usage](docs/en/usage.md) | Dispatch/collect, sentinels, many conversations, reasoning |
| [Team mode](docs/en/team.md) | Default behavior, how to disable (per client), verify and revert |
| [Permissions & privacy](docs/en/security.md) | Tiers, approvals, GUI visibility, logging |
| [Write lock](docs/en/locking.md) | Four holder classes, takeover, GUI contention |
| [Environment variables](docs/en/reference.md) | Every switch and its default |
| [Tests](docs/en/tests.md) | Offline/integration suites and coverage |
| [Known limitations](docs/en/limits.md) | Limits, profile naming |
| [Compatibility](docs/en/compatibility.md) | DSH version matrix, team-package requirements, upgrade checks |
| [Architecture](docs/en/architecture.md) | Why ACP, sdk/plugin comparison |
| [Release process](docs/en/release.md) | Release checklist |

## 🧑‍🤝‍🧑 Team mode (opt-in)

Off by default. Run `dsh-any-agent team on` and reconnect; the profile switches
to `dsh-team` (the experimental Agent Teams packages) and `dsh_send` adds a
short "form a team when this needs parallel or multi-role work" line. Simple
tasks are not forced into a team. Turn it off with `dsh-any-agent team off`, or
for one call with `dsh_send(team=false)`.

> Full steps (commands, verification, rollback) are in [Team mode](docs/en/team.md).

## Star History

<a href="https://www.star-history.com/?repos=xmtlzzz%2Fdsh-any-agent&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&legend=top-left" />
 </picture>
</a>
