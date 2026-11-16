> Back to [README](../../README.md)

# 🧑‍🤝‍🧑 Team mode (opt-in)

**Off by default since 0.5.0.** Turn it on with one command; no client config editing.

When enabled, the profile defaults to `dsh-team`. From DSH `0.2.2-rc.2`, new
sessions get the shared task board and standard subagent tools. DSH preserves
the saved team setting when resuming a session.

DSH `0.1.7-rc.1` through `0.2.2-rc.1` uses the experimental team tools and gets
a hint from `dsh_send` to form a team when needed.

## Commands

```bash
dsh-any-agent team on       # enable (writes settings.json)
dsh-any-agent team off      # disable
dsh-any-agent team status   # show the effective value, source and profile
```

`team on/off` writes the `team` field in `<DSH_HOME>/.dsh-any-agent/settings.json`;
it does **not** touch client configs. Reconnect the MCP server (or restart the
client) for the change to take effect.

## Enable

1. Run:

   ```bash
   dsh-any-agent team on
   ```

2. Reconnect: in Claude Code, `/mcp` → `dsh-any-agent` → reconnect; other clients
   restart or reconnect in their MCP panel.
3. Run `dsh_doctor`. The `team` check should be `on` and report which team mode is in use.

## Disable

```bash
dsh-any-agent team off
```

After reconnecting, new sessions default to `dsh-mcp` again. Use the DSH interface
to turn off team mode for an existing session with a saved setting. Custom
profiles control their own team settings.

For the experimental team mode, `dsh_send(team=false)` suppresses the hint for one dispatch.

## Precedence

1. `DSH_MCP_TEAM` environment variable (`1` / `0`) — **highest**;
2. the `team` field in `settings.json`;
3. off by default.

If an older client config still carries `DSH_MCP_TEAM`, it overrides `team on/off`.
`dsh-any-agent team status` shows the source (`env` / `file` / `default`), and
`team on/off` warns when the env var is present.

## Notes

- After upgrading to DSH `0.2.2-rc.2` or later, the managed team profile migrates
  when DSH starts. In a custom profile, remove the experimental team plugin
  entries, re-enable standard subagent tools, and set `defaultEnabled: true` in
  the native `agent-team` entry's `config`.
- `dsh_doctor` warns when the team configuration is incompatible with the DSH
  version. Without an explicit profile override, the server falls back to `dsh-mcp`.
