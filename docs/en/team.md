> Back to [README](../../README.md)

# 🧑‍🤝‍🧑 Team mode (on by default since 0.4.0)

The default profile is `dsh-team`: created on first start, it mounts the
experimental Agent Teams packages and disables the legacy `subagent` tools.
`dsh_send` injects a short "form a team when this needs parallel or multi-role
work" line before the caller's prompt; simple tasks are not forced into a team.

## Three ways to turn it off

| What you want | How | Effect |
|---|---|---|
| **Global off** | Add `DSH_MCP_TEAM=0` to the MCP server entry and reconnect | Back to the `dsh-mcp` profile; no team tools; no injection |
| **One call only** | `dsh_send(..., team=false)` | Profile stays `dsh-team`; the agent still has team tools, but this call is not prompted to use them |
| **Custom profile** | `DSH_MCP_PROFILE=<name>` | The server checks whether that profile actually contains the team package and suppresses injection if it does not |

> `DSH_MCP_PROFILE` wins over the default. If you point it at `dsh-team`,
> setting `DSH_MCP_TEAM=0` does not remove the team tools from that profile;
> to disable completely, also change `DSH_MCP_PROFILE` to `dsh-mcp` (or unset it).

## Steps (Claude Code example)

### 1. Find the entry

```bash
claude mcp get dsh-any-agent
```

It shows the scope and command. You can also inspect:

- user scope: `mcpServers.dsh-any-agent` in `~/.claude.json`
- project scope: `mcpServers.dsh-any-agent` in the project's `.mcp.json`

### 2. Add the env key

Append `DSH_MCP_TEAM`; do not replace other env values:

```json
{
  "mcpServers": {
    "dsh-any-agent": {
      "command": "npx",
      "args": ["-y", "dsh-any-agent"],
      "env": {
        "DSH_MCP_TEAM": "0"
      }
    }
  }
}
```

### 3. Reconnect

The MCP server reads env only at process start, so reconnect or restart:

- Claude Code: `/mcp` → `dsh-any-agent` → reconnect, or restart Claude Code.
- Other clients: restart, or disconnect/reconnect in their MCP panel.

### 4. Verify

`dsh_start` should report:

```
Team mode: off (DSH_MCP_TEAM=0 or DSH < 0.1.7)
```

`dsh_doctor`'s `config` check should show:

```
profile=dsh-mcp team=off
```

`dsh_send` will no longer inject the "【团队】…" line.

## Per-client env

| Client | Location | Shape |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `"env": { "DSH_MCP_TEAM": "0" }` |
| Cursor | `~/.cursor/mcp.json` | same |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | same |
| Codex | `~/.codex/config.toml` | `[mcp_servers.dsh-any-agent.env]` with `DSH_MCP_TEAM = "0"` |
| VS Code | `.vscode/mcp.json` | `"env": { "DSH_MCP_TEAM": "0" }` |
| opencode | its MCP config | the field is `environment` |
| Zed | `settings.json` → `context_servers` | under `command.env` |

## Notes

- Team mode requires DSH `>= 0.1.7-0`; an older runtime falls back to `dsh-mcp`
  even if `DSH_MCP_TEAM=1`.
- The team profile disables the legacy `subagent` tools and replaces them with
  nine team tools; teammates share one workspace.
- Agent Teams is **experimental** and carries no stability promise.
- You do not need to delete `~/.dsh/profiles/dsh-team`; it is simply unused
  when team mode is off. Delete it only if you want to clean up.

## Revert

Remove `"DSH_MCP_TEAM": "0"` (or set it to `"1"`) and reconnect.
