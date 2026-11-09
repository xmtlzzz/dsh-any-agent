# Moving to a new machine / first-time setup (English)

This is the short English version of `USAGE-MIGRATION.md`. It covers a fresh
install, registering the MCP server with your client, and the checks worth
doing before you trust it with real work.

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Node.js | **≥ 22.15** (`zstdDecompressSync` is required) |
| DSH | DeepSeek Harness installed and able to answer a normal chat turn |
| Provider | A model route configured in DSH, with credentials available through `~/.dsh/.credentials.yaml` or environment variables |

> The order matters. This server does **not** ship a provider or credentials.
> On first start it copies the model route from an existing DSH profile. If DSH
> itself is not configured, the first call fails with a provider error.

## 2. Install and register

```bash
npm install -g dsh-any-agent

# Preview only: reads configs, writes nothing
dsh-any-agent-setup

# Apply
dsh-any-agent-setup --yes

# Limit to some clients, or choose a permission tier
dsh-any-agent-setup --yes --only cursor,zed
dsh-any-agent-setup --yes --permission workspace-write

# Remove only this server's entry
dsh-any-agent-setup --remove --yes
```

Supported clients: **Claude Code, Claude Desktop, Codex, Cursor, Windsurf,
Zed, Gemini CLI, opencode, VS Code**. Clients that are not installed are
reported as skipped, not failed.

The writer is deliberately conservative:

- preview mode never writes and never starts a child process;
- every changed file is backed up as `<file>.bak-dsh-<stamp>`;
- JSON/JSONC/TOML edits are text-level and only touch the
  `dsh-any-agent` entry (indentation, key order, CRLF, BOM and comments are
  preserved);
- malformed or read-only configs are refused rather than overwritten;
- a second `--yes` is a no-op;
- `setup` does **not** invoke client CLIs such as `claude mcp get` (that can
  make Claude Code rewrite `~/.claude.json`).

## 3. Manual configuration (optional)

If your client is not covered by setup, add a stdio MCP server. For example:

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.dsh-any-agent]
command = "dsh-any-agent"
args = []
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
```

Generic JSON client:

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

`setup --yes` writes the absolute node path, the entry file, and
`DSH_MCP_PERMISSION` / `DSH_MCP_LOG`; the examples above assume
`dsh-any-agent` is on `PATH`.

## 4. First start and profile bootstrap

On first start the server creates `~/.dsh/profiles/dsh-mcp/` and copies the
model route from an existing DSH profile (`home` → `desktop` → `web` →
`headless` → `acp`, first usable one). It uses a built-in zero-dependency YAML
subset parser, so no extra npm package is needed.

What is copied: `apiKeyEnv`, `baseURL`, `api`, `models`, reasoning metadata.
What is stripped: literal API keys, nested `headers`, and URL userinfo. The
generated profile includes the three permission presets but **never**
`defaultPreset` (that would override the permission tier at session creation).

Credentials remain in DSH's own credential store; this project never owns them.
Set `DSH_MCP_BOOTSTRAP=0` to disable profile writing entirely, or
`DSH_MCP_ROUTE_SOURCE=<profile>` / `__home__` to pin the route source.

## 5. Permission tiers

| Tier | Meaning |
|---|---|
| `read-only` | DSH's sandbox is read-only; approvals are forced to `auto-deny` |
| `workspace-write` | Writes are limited to the workspace by DSH's sandbox |
| `danger-full-access` | No workspace sandbox |

The server's raw default is `workspace-write` when `DSH_MCP_PERMISSION` is
not set, and `setup` writes the same into the client config;
`danger-full-access` is refused unless the machine sets
`DSH_MCP_ALLOW_FULL_ACCESS=1`. Out-of-
workspace approval requests default to `auto-allow`; pass `on_approval=ask`
when creating a session if you want `dsh_approval_decide` to adjudicate them.

`read-only` is a hard boundary at this layer: `read-only + auto-allow/ask` is
rejected, and the server reads back the session's recorded permission tier
after create/resume. If the projection cache has no record within the DSH
flush window, read-only **fails closed** instead of relying on approvals.
External MCP tools mounted in DSH are outside DSH's sandbox; read
`USAGE-NOTES.en.md` before using them with untrusted data.

## 6. Verify

```bash
dsh-any-agent --version
dsh-any-agent-setup --help
dsh-any-agent-setup                 # preview should show your clients
```

In the client, ask the agent to call `dsh_start` with a small project
directory, then `dsh_send` a short prompt and `dsh_get` the result. If the
client cannot see the server, restart the client after setup.

## 7. Common problems

- **`DSH CLI entry not found`** — set `DSH_BIN` to
  `.../node_modules/@deepseek-ai/dsh/lib/bin.js`, or install DSH in a location
  the server can discover.
- **`no adapter registered for provider` / no API key** — DSH itself is not
  configured, or the profile route was not copied. Open DSH once, configure a
  model, then restart the MCP server.
- **`session ... is already owned by an active write handle`** — the session
  is held by another process (often the DSH GUI). Use `dsh_status` to see
  `lock_holder`; use `dsh_release` on the other instance or `dsh_takeover`
  when the holder is a stale dsh-any-agent process. Never kill a GUI process.
- **Nothing happens when waiting for completion** — use the returned
  `sentinel_file`; a turn that is interrupted by a process exit may not land
  one. Inspect the workspace and re-dispatch.
- **Old state after upgrading** — the registry moved from
  `<repo>/.state/conversations.json` to
  `$DSH_HOME/.dsh-any-agent/conversations.json`; the first 0.3.x start
  migrates it automatically. Use `DSH_MCP_STATE` to override.

## 8. Upgrade / rollback

`npm install -g dsh-any-agent@latest` upgrades the server. Client configs are
not rewritten by an upgrade; run `dsh-any-agent-setup` again only if you want
to refresh the entry or permission env. `dsh-any-agent-restore` can restore a
client config from a `.bak-dsh-*` backup.

For the full Chinese guide, environment-variable reference and write-lock
measurements, see `USAGE-MIGRATION.md`, `README.md` and `USAGE-NOTES.en.md`.
Website build/deploy notes live in `website/README.md`.
