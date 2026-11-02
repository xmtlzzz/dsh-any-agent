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

🧪 815 checks green on 0.3.5 on this machine (851 when all nine client fixtures exist); 519 of them are in the client-registration suites (555 with all fixtures) · 🔌 MCP over stdio · 📦 Zero dependencies · 📜 MIT

An MCP server that drives DeepSeek Harness as a **long-lived coding agent**. Hand it a goal, let it write code and run scripts, steer it mid-flight, and collect the result when you are ready.

**Claude Code · Claude Desktop · Codex · Cursor · Windsurf · Zed · Gemini CLI · opencode · VS Code** — or any client that speaks MCP over stdio.

## Quick start

Requires **Node.js ≥ 22.15** and **DSH installed with a working model route and credentials**. See [Requirements](#-requirements) for details.

```bash
npm install -g dsh-any-agent
dsh-any-agent-setup
dsh-any-agent-setup --yes
```

The second command previews the changes; `--yes` applies them. Reconnect your client's MCP server, then ask your agent to start a DSH conversation in your project, dispatch a task, and collect the result. The [dispatch workflow](#-workflow-dispatch-then-collect-later) shows the tool sequence.

> **Before your first task:** read the [Usage Notes](USAGE-NOTES.en.md), especially the model-config and external-MCP permission boundaries. External MCP tools bypass DSH's sandbox. For a fresh machine, follow the [migration guide](USAGE-MIGRATION.md).

<details>
<summary>Full contents</summary>

- **Quick start** — [Install and connect](#quick-start) · [Changelog](CHANGELOG.md)
- **Start here** — [The problem](#-the-problem-this-solves) · [Why it's different](#-why-its-different) · [Why not just wrap the DSH CLI](#-why-not-just-wrap-the-dsh-cli) · [Requirements](#-requirements) · [Setup](#-setup)
- **Using it** — [Tools](#-tools) · [Dispatch then collect](#-workflow-dispatch-then-collect-later) · [Completion notifications](#-workflow-get-notified-on-completion-no-polling) · [Many conversations](#-workflow-many-conversations-at-once)
- **Behavior** — [Permissions](#-permissions) · [Reasoning](#-reasoning-hidden-by-default) · [Logging and privacy](#-logging-and-privacy) · [Workspace & GUI](#-workspace-visibility-in-the-dsh-gui)
- **Hard parts** — [The write lock](#-the-write-lock-one-writer-per-conversation-at-a-time)
- **Reference** — [Environment](#-environment-variables) · [Tests](#-tests) · [Known limitations](#-known-limitations) · [Why the old profile name?](#-why-is-the-profile-still-called-dsh-mcp)

</details>

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

## ⚡ Why not just wrap the DSH CLI?

DSH ships two programmable entry points. The `sdk` profile looks simpler, but its JSON-RPC surface has only **3 requests and 4 notifications** — and it lacks three things that make an agent unusable in practice. The `acp` profile (Agent Client Protocol) has all of them. Everything below was verified against DSH `0.2.1-rc.5`.

| Capability | `sdk` profile | `acp` profile (**this project**) |
|---|---|---|
| **Resume a conversation** | ❌ no resume method; reusing an id fails with `already exists` | ✅ `session/resume` — verified **across processes** |
| **Interrupt a running turn** | ❌ only by killing the process | ✅ `session/cancel` — the same path as the user's own stop button |
| **Answer approval prompts** | ❌ no channel; operations silently fail closed | ✅ `session/request_permission` round-trip |
| List / close sessions | ❌ none | ✅ `session/list`, `session/close` |
| Gray vs. black streaming | one message, split by a `type` field | ✅ two separate channels: `agent_thought_chunk` / `agent_message_chunk` |
| Per-session MCP servers | ❌ process-wide | ✅ `mcpServers` accepted by `session/new` and `session/resume` |

**Core idea: the process is a cache, not the identity.** A conversation's identity is DSH's `sessionId`, persisted under `~/.dsh/sessions`. If the process is reaped, crashes, or the whole MCP server restarts, the next call transparently `session/resume`s it — history intact.

<details>
<summary>How the clients, server and DSH connect</summary>

```
  any MCP client                       ← Claude Code, Codex, Cursor, Zed, Cline, your own…
  (Claude/Codex/Cursor/…)              │
         │ MCP over stdio              │ newline-delimited JSON-RPC (ACP)
         ▼                             ▼
   ┌─────────────┐            ┌──────────────────────────┐
   │dsh-any-agent│───────────▶│ dsh --profile dsh-mcp    │  one long-lived process
   └─────────────┘            │                          │  per conversation
                              └────────────┬─────────────┘
                                           │
                              ┌────────────┴─────────────┐
                              │ DSH's own tools          │ files, shell, search,
                              │                          │ skills, subagents, workflows
                              ├──────────────────────────┤
                              │ dsh-mcp-client           │ → your other MCP servers
                              └──────────────────────────┘
```

**MCP compatibility.** The server uses only `initialize`, `ping`, `tools/list` and `tools/call`. It has also been verified with a bare-bones client that negotiates an older protocol version and never sends `notifications/initialized`.

</details>

## 📦 Requirements

- **Node.js ≥ 22.15** — the server uses `zstdDecompressSync` from `node:zlib` to read DSH session headers, and that API does not exist before 22.15
- **DSH installed** (`@deepseek-ai/dsh`), with working credentials under `~/.dsh`
- A working provider/model route in your local DSH configuration. The server prepares its `dsh-mcp` ACP profile automatically from that route; no provider config or credentials are bundled.

## 🚀 Setup

### 1. Prepare the DSH profile

On first launch, the server prepares a `dsh-mcp` profile from the shipped ACP template and copies the model route from your existing DSH configuration. Credentials stay with DSH. Use `DSH_MCP_ROUTE_SOURCE` to choose a source profile, or `DSH_MCP_BOOTSTRAP=0` to manage the profile yourself. See [Environment variables](#-environment-variables).

<details>
<summary>Manual profile setup and ACP configuration details</summary>

```bash
dsh --profile dsh-mcp --from-default-profile acp
```

Then edit `~/.dsh/profiles/dsh-mcp/cordis.patch.yml`, remove its `# dsh-mcp:managed` marker if present, and declare your provider and model. Start from [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml).

> ⚠️ **Two traps here** (both learned the hard way):
>
> 1. **ACP's model does NOT come from `agent-default-model`.** It comes from the `dsh-acp` plugin's own `config.provider` / `config.model`, which the `acp` bundle hard-codes to `deepseek-official`. If you don't override the `acp` row, your sessions silently run on the wrong provider and fail with `no API key for provider route "deepseek-official"`.
> 2. **ACP's `reasoning_effort` defaults to empty** (= "Provider default"), not to the maximum. This server explicitly sets it to `max` on every `session/new` and after every `session/resume` — because a fresh process does not remember the previous choice.

</details>

### 2. Register the server

Run the three commands in [Quick start](#quick-start), then reconnect your client. For a manual configuration, expand the client examples below.

`setup` finds the MCP clients on your machine — **Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Zed, Gemini CLI, opencode, VS Code** — and writes the entry into each one it finds, skipping the rest. It is safe by construction:

- **dry-run by default**; `--yes` is required to write anything, and a preview starts **no subprocess at all** — it only reads the files it would touch
- every file is backed up to `<file>.bak-dsh-<timestamp>` first, holding the exact **pre-write bytes**
- the config is parsed before and after writing, so a broken config never lands; malformed JSON and a read-only file are refused rather than forced, while a missing directory is created safely
- **text-level writes**: only the bytes of setup's own entry are replaced, so indentation (2-space, 4-space, tabs), key order, CRLF endings, a UTF-8 BOM and a missing trailing newline all survive untouched
- **idempotent** — re-running only changes what differs, and a second `--yes` writes nothing and adds no `.bak`

**Measured impact scope (2026-11-02, plan mode on this machine):** 5 of the 9 clients were detected (Claude Code, Codex, Cursor, Zed, VS Code) and 4 were skipped; `--json` reported `mode=plan, changed=5, skipped=4, failed=0`. The SHA-256, size and mtime of every existing client config were unchanged. A real `--yes` is additive: only the single `dsh-any-agent` entry is written, every other byte is preserved, and a `.bak-dsh-<timestamp>` copy is taken first; `--remove` deletes only that entry.

```bash
dsh-any-agent-setup --yes --only cursor,zed     # just these
dsh-any-agent-setup --yes --permission read-only
dsh-any-agent-setup --remove --yes               # take it back out; only its own entry is removed
```

<details>
<summary>Advanced flags and client configuration paths</summary>

**Three new flags**

| Flag | What it does |
|---|---|
| `--json` | **stdout carries one parseable JSON object and nothing else** — every human-readable line goes to stderr. Shape: `{ ok, mode, clients: [{ id, label, path, status, summary, error? }], changed, skipped, failed }` with `mode` being `plan`, `apply` or `remove`. This is a contract, not a convenience: a script can pipe stdout straight into a JSON parser |
| `--home <dir>` | use this directory instead of the real `HOME` / `USERPROFILE` / `APPDATA`, so a register-then-remove cycle can be rehearsed without touching a live config |
| `--force` | only two things: (a) create a directory or file that does not exist yet (it does that by default too — the flag makes it reliable for automation, including when the client itself was not detected); (b) overwrite a same-named entry that exists but is not the shape this program expects. It never deletes somebody else's entry and never skips validation |

**Which file each client actually gets**

A `.bak-dsh-<timestamp>` backup lands beside every file before it is written. Paths are generic examples; "its own entry" means the single entry/section named `dsh-any-agent`.

| Client (`--only` id) | Config file | Container key | Install / update | `--remove` | Undo |
|---|---|---|---|---|---|
| Claude Code (`claude-code`) | `~/.claude.json` | `mcpServers` | its own entry only, with `type: "stdio"` | deletes its own entry only | copy the backup back |
| Claude Desktop (`claude-desktop`) | Windows `%APPDATA%\Claude\claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers` | adds or rewrites its own entry only | deletes its own entry only | copy the backup back |
| Codex (`codex`) | `~/.codex/config.toml` | `[mcp_servers.dsh-any-agent]` | appends its two TOML sections line-wise | deletes those two sections and nothing else | copy the backup back |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | `mcpServers` | its own entry only | its own entry only | copy the backup back |
| Windsurf (`windsurf`) | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | its own entry only | its own entry only | copy the backup back |
| Zed (`zed`) | Windows `%APPDATA%\Zed\settings.json`; elsewhere `~/.config/zed/settings.json` | `context_servers` | its own entry only | its own entry only | copy the backup back |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json` | `mcpServers` | its own entry only | its own entry only | copy the backup back |
| opencode (`opencode`) | `~/.config/opencode/opencode.json` | `mcp` | its own entry only, written in opencode's shape: `{ type: "local", command: [exe, ...args], enabled: true }` — one array, not separate `command`/`args` | its own entry only | copy the backup back |
| VS Code (`vscode`) | Windows `%APPDATA%\Code\User\mcp.json`; elsewhere the same `mcp.json` under your VS Code user directory | `servers` — not `mcpServers` | its own entry only | its own entry only | copy the backup back |

For the exact path on your machine, read the `path` field for each client in `--json` output — that is the file this run would write, on your OS, which beats any table in a README.

Three shapes worth spelling out, because getting them wrong is silent. **VS Code** stores MCP servers under `servers`, not `mcpServers`; writing the usual key there produces a config the editor ignores. **opencode** takes a single `command` array (`{ type: "local", command: [exe, ...args], enabled: true }`) rather than separate `command`/`args` fields. **Claude Code** is the reason this release does not use a JSON library at all: `~/.claude.json` really does hold a `projects` map with keys that differ only by letter case (`.../Rust` next to `.../rust`), so a naive `JSON.parse` fails on it and any whole-file rewrite would destroy the user's project list. A byte-range scanner that never builds a value object handles it, and an earlier design that shelled out to `claude mcp add` was dropped for the same reason — that command rewrites the file in its own formatting with no backup you could restore.

</details>

<details>
<summary>Registration checks and round-trip verification</summary>

**What `setup` will and will not touch**

It is additive, and it only ever touches its own entry. Verified against a real machine holding existing MCP servers (Cursor with four, Codex with two, Claude Code with five, Zed with 33 settings keys): every pre-existing entry survived **byte for byte**, key order included, and the only diff was one new entry per client.

```
Cursor       4 -> 5 entries   existing entries byte-identical
Codex        2 -> 3 sections  node_repl and rea bodies unchanged
Claude Code  5 -> 6 servers   all four originals still listed
Zed          33 -> 33 keys    only context_servers gained a child
```

What changed since 0.1.x: JSON configs used to be **re-serialised whole** (values preserved, layout lost), which is why the docs said whitespace was not guaranteed. Writes are text-level now — apart from its own entry, the file comes back byte-identical, whether it was indented with 4 spaces, 2 spaces or tabs, laid out as one long line, missing its trailing newline, using CRLF, or carrying a UTF-8 BOM.

Codex's `config.toml` gets the same treatment line-wise: your other `[tables]` and their comments, the top-level keys (`model`, `approval_policy`, `sandbox_mode`, …) and CRLF endings come back exactly as they were — `--remove` deletes only the two `[mcp_servers.dsh-any-agent]` sections and leaves the rest intact.

The coverage for each of those claims is in [`test/`](test/) (`test/config-safety.mjs` asserts them one by one, 406 checks).

**Checked against a real home, read-only.** Running `setup --json` (plan mode) against an actual developer profile reported all nine clients and left every existing config untouched — identical size, mtime and SHA-256, no `.bak-dsh-*` created, no new file created:

```
~/.claude.json                            182693 B   unchanged
~/.cursor/mcp.json                          1396 B   unchanged
~/.codex/config.toml                        6647 B   unchanged
~/.gemini/settings.json                      465 B   unchanged
~/.config/opencode/opencode.json             441 B   unchanged
%APPDATA%/Zed/settings.json                 5647 B   unchanged
%APPDATA%/Claude/claude_desktop_config.json   247 B   unchanged
```

The same run with `--home <tmp>` put **every** reported path inside that directory, `APPDATA` included — which is what makes the register/remove cycle safe to rehearse.

**A full register -> remove round trip on the real home, not just a preview.** All seven configs were backed up, `--yes` was run for real, then `--remove --yes`, and everything was verified byte by byte:

| Client | Before | After register | After remove | Other MCP servers |
|---|---|---|---|---|
| ~/.claude.json | 182693 B | 182693 B (already current) | byte-identical to baseline | untouched; 67 top-level keys, 60 projects entries and both case-only duplicate keys still there |
| ~/.cursor/mcp.json | 1396 B | 1389 B | 1009 B | stitch / obsidian-mcp-server / codegraph / rea identical field by field |
| ~/.codex/config.toml | 6647 B | 6647 B (already current) | 6239 B | every other table, comment and top-level key kept |
| %APPDATA%/Zed/settings.json | 5647 B | 5647 B (already current) | 5240 B | all 32 top-level settings keys kept |
| ~/.gemini/settings.json | 465 B | 845 B | 465 B | restored byte for byte |
| ~/.config/opencode/opencode.json | 441 B | 869 B | 441 B | `$schema` and the pencil entry kept |
| %APPDATA%/Claude/claude_desktop_config.json | 247 B | 627 B | 247 B | restored byte for byte |

Removal is not accepted because it *looks* right: the check is that **taking our one entry out of the backup with the same editing engine reproduces the file now on disk, byte for byte**. All seven files pass. That proves removal is the strict inverse of registration and cannot quietly take anything else with it.

Afterwards every JSON config still parses and `codex mcp list` still reads the file; no client needs hand repair.

</details>

**`cwd` is optional: it defaults to the project the client has open**

The client already knows which folder the user is working in (MCP roots). `dsh_start` without `cwd` now sends one `roots/list` request and converts the returned `file://` URI into a path, so "DSH works where the client is looking" is the default - which also removes the usual way to end up on the home directory by building the path by hand. A client that does not advertise roots, or does not answer in time, gets an actionable error instead of a guessed directory.

**Do not use the home directory as `cwd`**

DSH's own ACL sandbox requires its temp directory to be **outside** the workspace. On Windows `%TEMP%` is `C:/Users/<you>/AppData/Local/Temp`, inside the home directory, so `cwd` set to home makes the first shell command fail with `Windows ACL: temp root must be outside the workspace`. `dsh_start` now rejects that combination and names both escapes: a narrower project directory, or `permission=read-only` / `danger-full-access`.

**Backups and rollback**

Both registering and removing snapshot the file first: `<config>.bak-dsh-<timestamp>`, holding the exact pre-operation bytes. Both directions, because the state you want back differs — the pre-register backup undoes a bad install, the pre-remove backup reinstalls after a bad removal.

After every real write, each client entry in `--json` carries a `backup` field, and the human-readable output prints `backup: <path>` under each written entry.

The copies live next to each client's config, so picking the right one by hand is error-prone. There is a companion command:

| What | Command |
|---|---|
| List backups, newest first | `dsh-any-agent-restore --list` |
| Restore the newest backup per file | `dsh-any-agent-restore --latest` |
| Restore one batch | `dsh-any-agent-restore --stamp 2026-10-30T01-35` |
| Restore one specific copy | `dsh-any-agent-restore --file <backup path>` |
| See what would happen | add `--dry-run` |

A restore is itself destructive, so it copies the **current** file aside as `.bak-dsh-pre-restore-<timestamp>` before overwriting — a restore can be undone.

**Install / update / remove**

| Task | Command |
|---|---|
| Preview what would change | `dsh-any-agent-setup` |
| Register with every client found | `dsh-any-agent-setup --yes` |
| Register with just some | `dsh-any-agent-setup --yes --only cursor,zed` |
| Change the permission tier in place | `dsh-any-agent-setup --yes --permission read-only` |
| Update after upgrading the package | `dsh-any-agent-setup --yes` (idempotent; only differing entries are rewritten) |
| Unregister from every client | `dsh-any-agent-setup --remove --yes` |
| Unregister from just some | `dsh-any-agent-setup --remove --yes --only codex` |
| Undo one bad write | copy `.bak-dsh-<stamp>` back over the config |

<details>
<summary>What removal changes: verification details</summary>

**What `--remove` actually does — measured**

Unregistering touches exactly one key per client and leaves everything else alone. Measured on a real machine, before → after:

```
Cursor       { keep, dsh-any-agent }  ->  { keep }
             the hand-written entry survived untouched
Claude Code  6 servers                ->  5 servers
             all five originals still listed
Zed          33 top-level keys        ->  33 keys
             only context_servers lost its child, now empty
Codex        our two TOML blocks      ->  removed
             model, approval_policy, sandbox_mode, node_repl and rea all intact
```

Nothing outside those entries is read, rewritten or deleted. Your credentials, other MCP servers and unrelated settings are not touched. The package itself is *not* uninstalled by `--remove` — that is `npm uninstall -g dsh-any-agent`, and the two are independent: you can keep the package installed with no clients registered, or unregister without removing it.

To verify by hand afterwards: `claude mcp list`, `codex mcp list`, and inspect `~/.cursor/mcp.json` / the `context_servers` key of Zed's settings.

</details>

**The recorded path is absolute**

`setup` writes the absolute path of the installation it ran from. **If you move or delete that directory, every client will fail with `CONNECTION_CLOSED`** until you either re-run `setup` from the new location or `--remove` the stale entries. This bites when you install into a temporary folder to try things out, then clean it up: the configs still point into the void.

<details>
<summary>Manual client configuration: Claude Code, Codex and generic MCP</summary>

**From a local checkout**

Clone or unzip anywhere, then point `command` at `node` and `args` at `<checkout>/bin/dsh-any-agent.mjs` (shown below).

---

**Claude Code**

```bash
# global install
claude mcp add dsh-any-agent -- dsh-any-agent

# local checkout
claude mcp add dsh-any-agent -- node /absolute/path/to/server/bin/dsh-any-agent.mjs
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dsh-any-agent]
command = "dsh-any-agent"          # or "node" + path to bin/dsh-any-agent.mjs
args = []
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
```

**Generic MCP client** — anything that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "dsh-any-agent": {
      "command": "dsh-any-agent",
      "args": []
    }
  }
}
```

For a local checkout, use `"command": "node"` and `"args": ["/absolute/path/to/server/bin/dsh-any-agent.mjs"]`.

> Cursor, Windsurf, Zed, Cline, Continue and most other clients use this same `mcpServers` shape — if it can launch a stdio MCP server, it works.

</details>

### 3. Try it

```bash
dsh-any-agent --version      # prints the version, starts nothing
dsh-any-agent --help         # flags, key env vars, docs link
node test/smoke.mjs          # no LLM calls, verifies the whole plumbing
```

## 🧰 Tools

| Tool | What it does |
|---|---|
| `dsh_start` | Create a conversation: workspace, permission tier, approval policy, **reasoning effort (default `max`)**, model |
| `dsh_send` | Hand it a task. **Defaults to `wait=false`: returns a `run_id` + `sentinel_file` immediately**, the turn runs in the background and the sentinel file notifies you when it's done (recommended). `wait=true` blocks until the turn ends; hitting `timeout_ms` (default `0` = wait forever) **only downgrades to background — the turn is never cancelled and the result is never lost** |
| `dsh_list` | All conversations with live state: `running` / `idle` / `detached`, elapsed time, current tool, output so far. `only_running=true` for active ones |
| `dsh_read` | **Cursor-based incremental read** of what a *running* conversation is producing right now. The cursor is a **revision number**: an entry whose text grew since your last read reappears — match it by `seq` and replace its text, don't append again |
| `dsh_get` | Conversation details; with `run_id`, the **final result of that dispatch** (the "collect the result later" entry point). Run records live in memory (last 20) — use the sentinel file after a restart |
| `dsh_interject` | Interject while it's busy: `interject` = stop and redirect, `queue` = wait for the current turn, then speak. **This round writes a sentinel too**, and the reply carries its `sentinel_file`. On an idle conversation it behaves like `wait=true` and **blocks until the turn ends** |
| `dsh_takeover` | **Preempt the write lock.** The only way out when another DSH process holds it (DSH has no steal API — preempting means killing the holder). It classifies the holder first: our own orphaned child → taken automatically; another live instance → needs `force`; **GUI/unknown → never killed**, reported instead |
| `dsh_interrupt` | Stop the current turn (the conversation stays healthy) |
| `dsh_release` | Hand the conversation back (frees the write lock so you can open it in your own DSH GUI). Still resumable; `forget=true` writes a tombstone — by-id lookups are refused until you delete `$DSH_HOME/.dsh-any-agent-forgotten/<id>.json` |
| `dsh_approval_decide` | Adjudicate a pending approval (only when `on_approval=ask`) |
| `dsh_status` | Lightweight status check |

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
     → status=done, elapsed=20.3s, full answer
```

`run_id` is the receipt. Run records are **memory-only, last 20 kept**; under many concurrent runs old ones get evicted and `dsh_get` will fail — which is exactly why the completion sentinel below carries the result.

## 🔔 Workflow: get notified on completion (no polling)

Besides `run_id`, `wait=false` returns a **`sentinel_file`** path plus **`sentinel_file_posix`** (the Bash/MSYS form — use it directly; hand-converting Windows paths is the easiest way to make your waiter hang until timeout). When the turn ends — **whether it succeeds, fails, or is cancelled** — the service **atomically writes** a small file there containing the final `status` and `result`. So you neither poll nor block: **wait for that file with a background task in your own host (Claude/Codex); the moment it appears, you're woken up.**

```bash
# sent="$sentinel_file_posix"   ← copy it straight from the tool result
sent='/c/Users/you/.dsh/.dsh-any-agent/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 2100 ))          # 35min safety net so a dead service can't hang you forever
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # task exits → host wakes you → read the file to collect
```

Once the file exists: **read it** for `status` and `result` (preferred — immune to the in-memory window and survives restarts), or use `dsh_get(conversation_id, run_id)`.

Design notes (especially under **concurrent multi-session** use):

- **No cross-talk**: the path is `<state dir>/runs/<conversation_id>/<run_id>.json`, namespaced by conversation. `run_id` sequence numbers are counted per-conversation, so two conversations *can* mint the same `run_id` in the same millisecond — the per-conversation directory keeps them apart. Arm one background task per run; each completes and wakes you independently.
- **Latch semantics**: the file is written once and kept. Even if the run finishes *before* you arm the waiter, `[ -f ]` is immediately true — you never miss it.
- **Atomic write**: `tmp` + `rename`; if the file exists its contents are complete. Each run uses its own tmp, so concurrent writes never clobber.
- **No server push**: the service only answers requests over MCP (it sends no notifications). "Completion notification" is entirely the sentinel file plus your background waiter.
- **★ No reasoning in the sentinel**: the payload carries the answer, thinking *statistics*, usage and (credential-redacted) tool inputs, but never reasoning text — `result.thinking` is stripped and replaced by a boolean `thinking_omitted` (`true` when reasoning was removed, `false` when there was none), because this server's rule is that reasoning never reaches its own disk artifacts. `dsh_get(run_id)` still returns it from memory while the record lives. `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` breaks that guarantee deliberately. Note that **DSH's own session log does contain reasoning** — see [Logging and privacy](#️-logging-and-privacy).

> Cleanup: sentinels contain full answers, so the service **prunes sentinels older than 7 days at startup** (tune with `DSH_MCP_SENTINEL_TTL_MS`; `0` disables). Your waiter should still `rm` the file after consuming it.

## 🧵 Workflow: many conversations at once

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵 running (9s, tool=pwsh, 40 chars this turn) | cwd=…
     - … | id=33427096… | 🔵 running (8s, 34 chars this turn)        | cwd=…
2. dsh_read(id,  cursor=0)      # read the first, note the cursor
3. dsh_read(id2, cursor=0)      # switch to the second
4. dsh_read(id,  cursor=<prev>) # switch back; entries that grew since <prev> reappear (match by seq)
```

## 🤫 Reasoning: hidden by default

DSH separates reasoning from answer text at the model layer, and ACP exposes them as **two independent streams**. This server hides reasoning by default and returns only **statistics** (characters, duration, chunk count) — so the caller knows thinking happened without paying for it in context.

- `reasoning=hide` (default) — content dropped, stats returned
- `reasoning=marker` / `summary` / `full` — progressively more content (mind your context budget)
- `dsh_read(include_reasoning=true)` — live reasoning of the *currently running* turn only; it is never buffered and is discarded when the turn ends

> ⚠️ This server never writes reasoning to its own logs, state file or sentinels — but **DSH's own session log (`~/.dsh/sessions/**/session.v4.jsonl.zstd`) does contain the full reasoning text**, even when `reasoning=hide`. That is DSH's storage (it is what makes resume possible) and is outside this server's control; account for it when analyzing sensitive data.

## 🔐 Permissions

| Tier | Approval default | Use for |
|---|---|---|
| `danger-full-access` (default) | `auto-allow` | Zero friction |
| `workspace-write` | `auto-allow` | Out-of-workspace operations surface as pending approvals |
| `read-only` | `auto-deny` | Analyzing untrusted samples (malware, unknown dumps) |

`on_approval` can be `auto-allow`, `auto-deny`, or `ask` (which exposes a pending approval for `dsh_approval_decide` to adjudicate).

**`read-only` is enforced, not merely a default**: it always runs with `auto-deny`; passing `auto-allow` or `ask` for a read-only conversation is rejected at `dsh_start`, and the approval layer refuses any permission request from a read-only conversation. Without that, DSH can ask for a `sandbox_permissions` escalation and a permissive approval policy would let the write through (found by the adversarial audit).

## 🪟 Workspace visibility in the DSH GUI

Two different things — don't confuse them:

| | Depends on | Status |
|---|---|---|
| **Workspace effectiveness** | the conversation's `cwd` | ✅ Always correct. Process working directory, file placement and sandbox write root all follow it |
| **GUI grouping** | `sessionIds` in `~/.dsh/storages/workspace.json` | ⚠️ This server registers it, but **the running DSH server caches the registry in memory** — external file edits only take effect after a DSH restart |

Verified experimentally ([`test/workspace-effect.mjs`](test/workspace-effect.mjs)): two conversations in two desktop folders, given **no path at all**, each wrote its file into its own workspace, self-reported the correct working directory, and leaked nothing into the server's cwd / home / temp / the other workspace (24/24 checks).

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

**This server never writes reasoning to disk** — with exactly one deliberate exception:

- Not in logs (silent by default). The state file and the per-conversation metadata sidecars under `<state dir>/meta/` hold metadata only (id, cwd, permissions, counters, title hint) — a smoke-test assertion guards the registry.
- **The async completion sentinel persists the answer, usage and tool inputs** (it must, so a caller can collect offline) but **strips `result.thinking`** and always reports `thinking_omitted` (true when reasoning was removed, false when there was none). Tool inputs are passed through the same credential redaction as approvals, but the sentinel still contains commands and file contents — treat it as sensitive. A test asserts that even when `reasoning=full` is requested, no reasoning text appears in the sentinel — while `dsh_get(run_id)` still returns it from memory. Set `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` to break this on purpose.
- Sentinels are pruned after 7 days by default (`DSH_MCP_SENTINEL_TTL_MS`; `0` keeps them forever).

> ⚠️ **DSH writes its own session log under `~/.dsh/sessions` and that log contains the full reasoning text** (even with `reasoning=hide`). It is what makes resume possible and is outside this server's control. The absolute "reasoning never reaches disk" claim applies to *this server's* artifacts only.

## ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_BIN` | auto-detected | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `DSH_HOME` | `~/.dsh` | DSH home shared with the GUI (credentials, sessions, workspace registry). Point it elsewhere only for isolation/multi-account |
| `DSH_MCP_PROFILE` | `dsh-mcp` | DSH profile to drive. ⚠️ The stale name is deliberate — see [Why is the profile still called `dsh-mcp`?](#-why-is-the-profile-still-called-dsh-mcp) |
| `DSH_MCP_BOOTSTRAP` | on | Whether this server may create/sync the DSH profile on first start. `0` makes it drive an existing profile only and never write a file |
| `DSH_MCP_ROUTE_SOURCE` | unset | Pin where model routes are copied from during bootstrap: a profile name (`desktop`, `web`, …) or `__home__` for `$DSH_HOME/cordis.patch.yml`. Unset = try home → desktop → web → headless → acp |
| `DSH_MCP_STATE` | `$DSH_HOME/.dsh-any-agent/conversations.json` | Conversation registry, survives restarts. The old `<repo>/.state` location is migrated once on startup |
| `DSH_MCP_APPROVAL` | `auto-allow` (non-read-only) | Default approval policy. `ask` makes out-of-workspace requests surface as pending approvals instead of being auto-allowed |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | How long a pending `ask` approval waits before being cancelled |
| `DSH_MCP_FORGOTTEN_DIR` | `$DSH_HOME/.dsh-any-agent-forgotten` | Tombstones written by `dsh_release(forget=true)` |
| `DSH_MCP_RUNS_DIR` | `<state file dir>/runs` | Root for async completion sentinels (`<this>/<conversation_id>/<run_id>.json`) |
| `DSH_MCP_LOCKS_DIR` | `<state file dir>/locks` | Holder registrations for the write lock. ⚠️ **All instances must agree on this value**, or they cannot see each other's registrations and will misread each other as an unidentifiable holder (a GUI) and refuse to preempt |
| `DSH_MCP_LOCK_STALE_MS` | `90000` | How long without a heartbeat before a holder counts as lost (and becomes auto-preemptible by `dsh_takeover`) |
| `DSH_MCP_IDLE_TTL_MS` | `0` (never reap) | How long a conversation may sit idle before its DSH process is reaped. ★★ **`0` means never reap (the default)**: the server keeps holding the write lock, so **the GUI cannot take it** — opening the conversation there is read-only and still works. Cost: one resident DSH process per conversation (**measured 300 MB and 476 MB in two cold starts**). Set a millisecond value (e.g. `300000`) to save memory and accept that the lock can be taken |
| `DSH_MCP_MAX_LIVE` | `8` (≈2.5–4 GB worst case; see note 8) | ★ **How many conversation processes to keep alive at once** (`0` = unlimited). Going over the cap reaps the **least recently used** one (a running turn is never reaped) — "**bounded memory, locks kept where it matters**". Use `4` when memory is tight, `0` on a big machine. To free idle conversations at once: `dsh_release(all=true)` (busy turns are skipped unless `force=true`) |
| `DSH_MCP_LIST_PROBE_TTL_MS` | `10000` | Cache lifetime for `dsh_list`'s on-disk probe (the probe spawns a DSH process and takes ~1 s) |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000` (7 days) | Startup pruning age for sentinels; `0` disables pruning |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | unset | `1` writes `result.thinking` into the sentinel (**breaks the never-on-disk guarantee**) |
| `DSH_MCP_PERMISSION` | `danger-full-access` | Default tier for `dsh_start` |
| `DSH_MCP_REASONING_EFFORT` | `max` | Default reasoning effort |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0` (no timeout) | Wait bound for **`wait=true` only**; on expiry the turn merely moves to the background |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_GIT_STATUS` | on | `0` disables the per-turn `git status` summary. Useful for untrusted repos (git can run repo-configured fsmonitor/filters outside DSH's sandbox) |
| `DSH_MCP_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout on the ACP channel (initialize, session/new, …) |
| `DSH_MCP_REAP_INTERVAL_MS` | `30000` | How often the idle reaper checks for conversations to reclaim. Values below the safe floor fall back to the default |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | unset | `1` forwards DSH's raw stderr |

## 🧪 Tests

```bash
node test/run.mjs          # all offline suites (no LLM calls; needs DSH for smoke)
node test/run.mjs --all    # offline + model-backed suites
node test/cleanup.mjs      # suite teardown on its own (test-created dirs only; --dry-run to preview)
```

The suite **cleans up after itself**: `run.mjs` always ends with `cleanup.mjs`, which removes sessions and workspace registrations whose cwd is **a test-created directory** (`tmpdir()/dsh-any-agent-*` or `Desktop/dsh-any-agent-test-*`). Real project sessions — including projects under `%TEMP%` — and your live state directory are never touched. To remove `Desktop/dsh-any-agent-test-*` artifacts explicitly, run `node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions`.

| Suite | Checks | Covers |
|---|---|---|
| `smoke` | 29 | handshake, tool table, conversation creation, config, registry purity |
| `boundary` | 46 | protocol edges (double initialize, malformed lines, unknown method), argument validation (including read-only + permissive approval rejection, unknown provider/model, and no stale write-lock marker on a failed create), unknown ids, cursor edges, lifecycle idempotence, unicode |
| `integration` | 30 | resume-with-memory across processes, interrupt, both interject modes |
| `async` | 16 | fire-and-forget + later collection |
| `sentinel` | 36 | completion sentinel: atomicity, latch semantics, per-conversation namespacing under concurrency, cancelled runs still land it, and **reasoning never reaching the file** |
| `prune` | 11 | **sentinel retention**: prunes over-age and crash-leftover files, keeps fresh ones, removes empty shells, `TTL=0` disables pruning, and never touches the conversation registry beside it (no tokens, runs every time) |
| `guards` | 31 | **environment-variable guards**: odd numbers always land on the safe side — `IDLE_TTL_MS` values like `-1` or garbage mean "never reap" (never give the write lock away), a too-small reap interval falls back to the default (no busy loop), and the **lost-holder threshold is floored at 30 s** (so another instance cannot "legitimately" preempt and kill our turn) (no tokens, runs every time) |
| `sandbox-guard` | 18 | **the test sandbox itself**: a "throwaway HOME" that resolves to the real user profile, to the filesystem root, or to anywhere outside the OS temp dir is refused with an error instead of being written to and deleted. Every other suite builds its HOME through `test/sandbox-home.mjs` and can only destroy what it created there (no tokens, runs every time) |
| `approval-details` | 27 | **approval review context**: the pending-approval snapshot carries the command, reason, cwd and original approval ID — not just a bare ID — so a caller can actually adjudicate; missing `rawInput` is correlated from the earlier `tool_call` update by ID; credential-shaped fields and common inline literals are redacted; closing a conversation cancels pending approvals. Verified end-to-end over real stdio MCP |
| `read-cursor` | 10 | **`dsh_read` cursor semantics**: text appended to an already-read entry is delivered again (revision cursor, match by `seq`), and `limit` is clamped to 1..500 so `0`/negative cannot spin or drop the tail (no tokens) |
| `sentinel-redaction` | 15 | **sentinel disk hygiene**: `result.thinking` is stripped, `thinking_omitted` is always a boolean, and `answer`/`error`/`title`/`tools_used[].input` all pass the same credential redaction as approvals (no tokens) |
| `forget-tombstone` | 7 | **`forget` is terminal**: `release(forget=true)` writes a tombstone, by-id lookups fail with a recovery path, lists exclude it, and deleting the tombstone restores the normal unknown-session path (no tokens) |
| `bootstrap-profile` | 24 | **first-start profile works in the published zero-dependency form**: copies routing with the built-in YAML subset parser, strips `apiKey`/`headers`/literal secrets, never writes `defaultPreset`, is idempotent, and leaves a user-maintained profile byte-identical (no tokens) |
| `workspace-safety` | 23 | **data-loss boundaries**: `isTempPath` is segment-aware (`tmpdir()+'Suffix'` and `/tmpfoo` are *not* temp), a corrupt `workspace.json` is never overwritten, an unreadable session root never wipes `sessionIds`, and automatic cleanup deletes only test-created sessions (no tokens) |
| `permission-adopt` | 13 | **no silent privilege escalation**: adopting an external session with no permission record fails closed to `read-only`; a recorded `read-only` cannot be promoted by the sidecar; the runtime read-back rejects a recorded/requested mismatch (no tokens) |
| `state-safety` | 21 | **state/sentinel/lock storage**: defaults live under `$DSH_HOME/.dsh-any-agent`, an unwritable directory fails startup loudly, sentinel write failures return `null` + `sentinel_error`, and bad numeric env values land on the safe side (no tokens) |
| `setup` | 41 | **the registration CLI**: preview writes nothing, `--remove` takes out only its own entry, an absent client is skipped rather than failed, the Codex TOML block round-trips, and the command recorded in a config is actually spawned and must answer `initialize` (no tokens). It never invokes `claude mcp get` — that CLI rewrites `~/.claude.json` |
| `removal-scope` | 24 | **unregistering touches only its own entry**: configs holding unrelated MCP servers, top-level Codex settings and sibling Zed settings are registered and then removed, asserting every other value is byte-identical; removing something never written is a no-op with no write (no tokens) |
| `config-safety` | 406 | **the property the 0.3 line is about**, per client: preview leaves files byte-identical with no `.bak`; register-then-remove restores every other entry byte-for-byte, keeps key order and drops no top-level key; 4-space / 2-space indentation, single-line JSON, missing trailing newline, CRLF and a UTF-8 BOM all survive a write; malformed JSON and read-only files are refused without damage; the second `--yes` is a no-op with no new backup; every `.bak-dsh-<stamp>` appears once and equals the pre-write bytes; a `claude` on PATH is never invoked (no tokens) |
| `real-configs` | 84 (66 with 7/9, 48 with 5/9 fixtures) | **round-trip on the real thing**: copies this machine's actual client configs (an 182693-byte `~/.claude.json` holding hundreds of `projects` entries and case-colliding keys, a 238-line Codex TOML, Zed's full `settings.json`) into a temp dir, registers, then removes, and requires every file back **byte for byte**; entry-presence is checked by key (not a bare substring), and missing fixtures are reported as skipped rather than green (no tokens) |
| `commit-script` | 26 | commit messages go through stdin, never a temp file that `git add -A` could capture (no tokens) |
| `roots` | 12 | `dsh_start` without `cwd` asks the client for MCP roots; a client without roots gets an actionable error (no tokens) |
| `workspace-titles` | 15 | home-as-workspace is rejected before DSH starts; `title_hint` is returned separately from DSH's automatic title (no tokens) |
| `package-check` | 14 | `files` whitelist, zero runtime dependencies, Node floor, and bin shebangs (no tokens) |
| `timeout` | 38 | **timeout semantics**: `wait=false` is unaffected by `timeout_ms`; a `wait=true` expiry merely downgrades to background (turn not cancelled, result not lost, `busy` never lies); `timeout_ms<=0` waits forever; a failed resume invalidates the process instead of wedging the conversation; an empty prompt yields a clear error |
| `lock` | 79 | **write lock and preemption**: four holder classifications, `writeMarker` never overwriting a live holder, malformed/missing registration edge cases; **end-to-end** with two real MCP instances fighting over one conversation → clear error → refusal → `force` takeover; **a crash releases the lock automatically**, **a wedged holder is preempted without `force`**; plus the "one turn, one sentinel" invariant (inline turns and idle interjects included) |
| `cycle` | 36 | **the async dispatch lifecycle**: dispatch → collect the sentinel → idle reap → dispatch again, three rounds with no lock error; re-dispatch right on the reap boundary (widening the race); an immediate re-dispatch after `dsh_release`; and an assertion that reaping leaves no unattributable lock (this suite caught the reaper collecting a freshly spawned process as if it were idle) |
| `concurrency` | 31 | three simultaneous conversations + live incremental reads |
| `capability` | 22 | writing code, running scripts, **spawning its own subagents** (verified on disk via child session headers) |
| `workspace-effect` | 24 | workspace actually effective when no path is given |
| `acceptance` | 36 | two folders × two conversations doing a read-only IDA Pro analysis |
| `multi` | 19 | **several instances and non-ASCII paths**: reproduces "two instances share the registry and the later save drops the earlier instance's conversation", then proves **that conversation is recoverable by id alone from the session store and actually usable** (registry loss, not an explicit `forget` — forget is a terminal tombstone); **recovery never silently escalates privileges** (a read-only conversation stays read-only); no `.tmp` residue; and **CJK / emoji workspace paths** create sessions, do real work, and place files in the right directory |
| `permission` | 11 | ★ **whether the permission tiers actually take effect** (a safety property): it ignores our own return values (the very thing that used to lie) and reads **the session's own record** (`permissions.preset` / `sandboxMode` in the projection cache), checking all three tiers and that their recorded values differ. **This suite caught a silent privilege escalation**: a `defaultPreset` in the profile overrides `DSH_PERMISSION_MODE` at session creation |
| `list` | 13 | **the cost of `dsh_list`** (measured): a default call with the on-disk probe takes ~1 s (it spawns a DSH process) while **repeated calls hit a cache and drop to single-digit milliseconds**; `only_running=true` and `include_closed=false` **skip the probe** with equivalent semantics (unopened on-disk sessions are simply excluded) |
| `reasoning-check` | 8 | **reasoning visibility**: `reasoning=hide` returns no thinking body but non-zero stats; `reasoning=full` returns the text and the rendered section |

**`node test/run.mjs` runs 815 checks on a machine with five client fixtures (851 with all nine)** — smoke 29 + 786 offline checks (822 with nine). Every suite exited 0 on 0.3.5; none needs a provider (smoke needs a DSH install for its session-creation section).

That is **519 assertions in the client-registration suites alone** (`setup` 41, `removal-scope` 24, `config-safety` 406, `real-configs` 48; 555 with all nine fixtures), which is where the 0.3 work actually is.

The model-backed suites (`smoke` 29, `boundary` 46, `integration` 30, `async` 16, `sentinel` 36, `timeout` 38, `lock` 79, `cycle` 36, `concurrency` 31, `capability` 22, `workspace-effect` 24, `acceptance` 36, `multi` 19, `permission` 11, `list` 13, `reasoning-check` 8) total 474 and were last measured in full on 0.3.5 — they need a working provider, so re-run them yourself before trusting a release: `node test/run.mjs --all`. `acceptance` now **skips explicitly** when the DSH profile has no IDA MCP (`mcp__ida__*`).

> Three different totals are intentional: `node test/run.mjs` (815/851), the CI offline job (786/822, no smoke), and the model-backed set (474 nominal). Counts are the numbers each suite prints itself; don't use one number for a different runner.

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

## 🔒 The write lock: one writer per conversation at a time

DSH conversations carry a **cross-process write lock**: **it never expires while the holder lives, and no API can take it from a live holder** — so **whoever gets there first decides everything**. This server turns that into "**you can look, we can write**":

| Situation | Outcome |
|---|---|
| **This server holds the lock** (the default) | ✅ Opening it in the GUI is **read-only**: you still **see the content**, but you **cannot take the lock**. The default `DSH_MCP_IDLE_TTL_MS=0` (never reap) keeps the lock from ever going free |
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
> The full measurements (the A/B probe method, the evidence that the GUI opens read-only, why even archiving does not release the lock, and crash-vs-wedge) are in [Usage Notes §3.5–3.12](USAGE-NOTES.en.md).

## ⚠️ Known limitations

1. **No token-level streaming into model context** — an MCP limitation, not DSH's. Callers get per-step results; humans can follow progress via stderr logs.
2. **True mid-turn steering is impossible** — ACP rejects concurrent prompts (`a prompt is already in flight for this session`). `dsh_interject` is the practical equivalent: cancel, then immediately start a new turn, history preserved.
3. **Image prompts are unsupported** — ACP advertises `promptCapabilities: {image: false}`.
4. **Restarting the MCP server takes its children with it** — when this service is restarted or killed, the DSH children it spawned exit too (their stdio is a pipe to us): **in-flight turns are interrupted and no sentinel lands** (judge by inspecting the workspace, don't just wait for the file). The good news: the **write lock is released automatically**, so a restart always gets it back. The service also pushes no MCP notifications; "completion notification" is the sentinel file plus the caller's background waiter.
5. **A conversation that dies before its first successful turn may never have materialized on disk** — resume then fails with a clear error. Safe after the first message.
6. **No renaming** — DSH's title subsystem has no external rename API (`SessionTitleService.rename` requires a live in-process session). Titles are auto-generated from the first message.
7. **`session/list` returns only `{sessionId, cwd}` and excludes already-open sessions** — titles are filled in by this server from DSH's projection cache.
8. **"Never reap" costs memory (measured 300–480 MB per conversation)** — that is what buys "the GUI can never take the write lock". Two fresh-start measurements of one active conversation gave 476 MB and 295 MB of added resident memory (the DSH child plus this server); expect the higher figures on a cold process. Two ways to spend less: ① **`DSH_MCP_MAX_LIVE` (default 8** — over the cap, the least recently used process is reaped → bounded memory, locks still held where it matters); ② set `DSH_MCP_IDLE_TTL_MS` to a millisecond value (at the cost of the lock being takeable). To drop to zero right after a batch of work: **`dsh_release(all=true)`** ✓ (releases idle conversations; busy turns are skipped and keep running — pass `force=true` to interrupt them too. Everything resumes on demand).

## ❓ Why is the profile still called `dsh-mcp`?

Because renaming it would break things that already exist on disk.

When you first start this server it creates a DSH profile under `~/.dsh/profiles/dsh-mcp/`. That directory name is referenced by three other persisted things:

| Persisted identifier | Location | What breaks if renamed |
|---|---|---|
| profile directory | `~/.dsh/profiles/dsh-mcp/` | existing sessions can no longer resolve their provider (`no adapter registered for provider "…"`) |
| `DSH_MCP_*` environment variables | your client configs | every deployment must change at once |
| `# dsh-mcp:managed` marker line | first line of the generated `cordis.patch.yml` | bootstrap no longer recognizes the file as its own and stops syncing it |

So the **product name** is `dsh-any-agent`, while the **on-disk identifiers** deliberately keep the old name. This is a compatibility decision, not an oversight. For a fresh deployment that wants a different profile name, set `DSH_MCP_PROFILE` — the server will use the name you give it.

## 📦 Release process

The order matters; two of these steps exist because a bad release shipped without them.

```bash
# 1. Bump the version. SERVER_VERSION reads package.json, nothing else.
npm version patch --no-git-tag-version
#    Then edit CHANGELOG.md: turn [Unreleased] into the new version.

# 2. Run the offline suites locally (same set as CI, no tokens, no DSH needed for most).
node test/run.mjs
node test/package-check.mjs

# 3. Verify the tarball itself: builds, installs, starts.
npm pack --dry-run
#    Then in a temp dir: npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. Tag and push (wait for CI before publishing).
git add -A && git commit -m "chore: release x.y.z"
git tag vx.y.z && git push origin main --tags
```

## Star History

<a href="https://www.star-history.com/?repos=xmtlzzz%2Fdsh-any-agent&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xmtlzzz/dsh-any-agent&type=date&legend=top-left" />
 </picture>
</a>
