> Back to [README](../../README.md)

# 📦 Requirements

- **Node.js ≥ 22.15** — the server uses `zstdDecompressSync` from `node:zlib` to read DSH session headers, and that API does not exist before 22.15
- **DSH installed** (`@deepseek-ai/dsh`), with working credentials under `~/.dsh`
- A working provider/model route in your local DSH configuration. The server prepares its `dsh-mcp` ACP profile automatically from that route; no provider config or credentials are bundled.

## 🚀 Setup

### 1. Prepare the DSH profile

On first launch, the server prepares a `dsh-mcp` profile from the shipped ACP template and copies the model route from your existing DSH configuration. Credentials stay with DSH. Use `DSH_MCP_ROUTE_SOURCE` to choose a source profile, or `DSH_MCP_BOOTSTRAP=0` to manage the profile yourself. See [Environment variables](reference.md).

<details>
<summary>Manual profile setup and ACP configuration details</summary>

```bash
dsh --profile dsh-mcp --from-default-profile acp
```

Then edit `~/.dsh/profiles/dsh-mcp/cordis.patch.yml`, remove its `# dsh-mcp:managed` marker if present, and declare your provider and model. Start from [`profile-example/cordis.patch.yml`](../../profile-example/cordis.patch.yml).

> ⚠️ **Two traps here** (both learned the hard way):
>
> 1. **ACP's model does NOT come from `agent-default-model`.** It comes from the `dsh-acp` plugin's own `config.provider` / `config.model`, which the `acp` bundle hard-codes to `deepseek-official`. If you don't override the `acp` row, your sessions silently run on the wrong provider and fail with `no API key for provider route "deepseek-official"`.
> 2. **ACP's `reasoning_effort` defaults to empty** (= "Provider default"), not to the maximum. This server explicitly sets it to `max` on every `session/new` and after every `session/resume` — because a fresh process does not remember the previous choice.

</details>

### 2. Register the server

Run the three commands in [Quick start](../../README.md#quick-start), then reconnect your client. For a manual configuration, expand the client examples below.

`setup` finds the MCP clients on your machine — **Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Zed, Gemini CLI, Antigravity, opencode, VS Code** — and writes the entry into each one it finds, skipping the rest. It is safe by construction:

- **dry-run by default**; `--yes` is required to write anything, and a preview starts **no subprocess at all** — it only reads the files it would touch
- every file is backed up to `<file>.bak-dsh-<timestamp>` first, holding the exact **pre-write bytes**
- the config is parsed before and after writing, so a broken config never lands; malformed JSON and a read-only file are refused rather than forced, while a missing directory is created safely
- **text-level writes**: only the bytes of setup's own entry are replaced, so indentation (2-space, 4-space, tabs), key order, CRLF endings, a UTF-8 BOM and a missing trailing newline all survive untouched
- **idempotent** — re-running only changes what differs, and a second `--yes` writes nothing and adds no `.bak`
- **install then remove returns to where you started** — `--remove` goes by the backup taken before install: an empty container that was already yours (such as `"mcpServers": {}`) stays, a container we added goes with our entry, and a file that holds nothing but our entry and did not look that way before (typically one created by `--force`) is backed up and then deleted rather than left as an empty shell

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
| Antigravity (`antigravity`) | `~/.gemini/config/mcp_config.json` (shared by the IDE and the CLI); the older `~/.gemini/antigravity/mcp_config.json` is written instead only when it exists and the new file does not. With neither file, detected by the `~/.gemini/antigravity` or `~/.gemini/antigravity-cli` directory | `mcpServers` | its own entry only | its own entry only | copy the backup back |
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

The coverage for each of those claims is in [`test/`](../../test/) (`test/config-safety.mjs` asserts them one by one, 407 checks).

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

> Cursor, Windsurf, Cline, Continue and most other clients use this same `mcpServers` shape — if it can launch a stdio MCP server, it works. Zed is the exception: it uses `context_servers` (shown above).

</details>

### 3. Try it

```bash
dsh-any-agent --version      # prints the version, starts nothing
dsh-any-agent --help         # flags, key env vars, docs link
node test/smoke.mjs          # no LLM calls, verifies the whole plumbing
```
