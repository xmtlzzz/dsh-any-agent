> Back to [README](../../README.md)

# 🧩 Compatibility matrix

`dsh-any-agent` drives DSH through its ACP profile; team mode additionally needs the
experimental Agent Teams packages shipped since DSH 0.1.7. Check this table before
upgrading DSH, and run `dsh_doctor` afterwards.

## Versions

| dsh-any-agent | DSH | Status | Notes |
|---|---|---|---|
| 0.5.x | `0.1.7-rc.1` or newer | ✅ Verified | ACP and the experimental Agent Teams packages are available; team mode is opt-in via `dsh-any-agent team on` |
| 0.5.x | `0.1.5-rc.1` | ⚠️ Partial | ACP basics work; no team packages, so team mode stays off |
| 0.5.x | `0.2.x` | ⚠️ Unverified | The ACP `session/*` surface may change; team packages must match the DSH version. Run `dsh_doctor` and the offline suite before upgrading |
| 0.4.x | `0.1.7-rc.1` | ✅ Verified | Team mode was on by default at that time |
| 0.4.x | `0.1.5-rc.1` | ⚠️ Partial | No team packages |

> The experimental packages (`dsh-experimental-agent-team`,
> `dsh-experimental-tool-agent-team`) carry **no stability promise**. They ship with
> a DSH version and must not be mixed across major versions.

## Runtime requirements

- **Node.js ≥ 22.15** (uses `zstdDecompressSync` from `node:zlib` to read DSH session headers);
- DSH installed and `~/.dsh` already has a working provider and credentials (the GUI can chat);
- Team mode also requires DSH `>= 0.1.7-0` and a profile that actually mounts both team packages.

## How to check

```bash
dsh-any-agent --version          # this server
node <DSH_BIN> --version         # DSH version (set DSH_BIN to pin it)
dsh-any-agent team status        # team switch and profile
```

In an MCP client, call `dsh_doctor` and look at:

- `dsh_bin`: DSH entry point and version; **warn** when it resolves from an npx cache (`_npx/<hash>/`), which disappears on cache cleanup — install DSH globally or pin `DSH_BIN`;
- `dsh_version`: the version graded against the table above — `verified` is ok; `partial` / `unsupported` / `unverified` (e.g. 0.2.x) / unreadable are **warn**;
- `profile`: exists, drift, route source;
- `team`: `on` / `off` / `requested but unavailable` (version or profile lacks the team package);
- `config`: effective permission, idle reaping, shared process, and so on.

## Upgrade advice

1. Record `dsh_doctor` before upgrading DSH;
2. After upgrading, run `node test/run.mjs` (offline) and `node test/run.mjs --all` (needs a provider);
3. If team mode will not turn on, check `dsh-any-agent team status` and `dsh_doctor`'s
   `team` check, then verify `~/.dsh/profiles/dsh-team/cordis.patch.yml` contains
   `@deepseek-ai/dsh-experimental-agent-team`;
4. To pin a DSH version, set `DSH_BIN` explicitly instead of letting the npx cache pick one.
