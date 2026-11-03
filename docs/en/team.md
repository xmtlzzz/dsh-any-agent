> Back to [README](../../README.md)

# 🧑‍🤝‍🧑 Team mode (opt-in)

**Off by default since 0.5.0.** Turn it on with one command; no client config editing.

When enabled: the profile switches to `dsh-team` (the experimental Agent Teams
packages, with the legacy `subagent` tools disabled), and `dsh_send` adds a short
"form a team if this needs parallel or multi-role work" line; simple tasks are not
forced into a team.

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
3. Verify: `dsh_start` should report:

   ```
   Team mode: on (profile=dsh-team; dispatch prompts suggest a team when needed)
   ```

   or run `dsh_doctor` and look for the `team` check (`on`).

## Disable

```bash
dsh-any-agent team off
```

After reconnecting, the profile is back to `dsh-mcp`: no team tools, no injection.

**One call only** (profile stays `dsh-team`):

```
dsh_send(..., team=false)
```

## Precedence

1. `DSH_MCP_TEAM` environment variable (`1` / `0`) — **highest**;
2. the `team` field in `settings.json`;
3. off by default.

If an older client config still carries `DSH_MCP_TEAM`, it overrides `team on/off`.
`dsh-any-agent team status` shows the source (`env` / `file` / `default`), and
`team on/off` warns when the env var is present.

## Notes

- Team mode requires DSH `>= 0.1.7-0`; an older runtime stays off even after
  `team on`, and `dsh_doctor` marks it `warn`.
- The team profile disables the legacy `subagent` tools and replaces them with
  nine team tools; teammates share one workspace.
- Agent Teams is **experimental** and carries no stability promise.
- You do not need to delete `~/.dsh/profiles/dsh-team`; it is simply unused when
  team mode is off.
