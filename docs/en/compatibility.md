> Back to [README](../../README.md)

# 🧩 Compatibility matrix

`dsh-any-agent` drives DSH through its ACP profile; team mode additionally needs the
experimental Agent Teams packages shipped since DSH 0.1.7. Check this table before
upgrading DSH, and run `dsh_doctor` afterwards.

## Versions

| dsh-any-agent | DSH | Status | Notes |
|---|---|---|---|
| 0.6.x | `0.2.1-rc.5` | ✅ Verified | Full suite run against 0.6.9 on 2026-11-10 (offline + model-backed; DSH via npx, Node 22.19), all passing; `acceptance` skipped because the profile has no IDA MCP. Other DSH versions were not re-verified for 0.6.x — the 0.5.x rows below are their last runs |
| 0.5.x | `0.1.7-rc.1` or newer | ✅ Verified | ACP and the experimental Agent Teams packages are available; team mode is opt-in via `dsh-any-agent team on` |
| 0.5.x | `0.1.5-rc.1` | ⚠️ Partial | ACP basics work; no team packages, so team mode stays off |
| 0.5.x | `0.2.1-rc.5` – `0.2.2-rc.1` | ✅ Verified | Full suites run on 2026-11-06 (0.2.1-rc.5 from npm, 0.2.2-rc.1 on the desktop app's bundled runtime); from 0.2.2 DSH requires Node ≥ 24.9 |
| 0.5.x | `0.2.3` or newer | ⚠️ Unverified | The ACP `session/*` surface may change; team packages must match the DSH version. Run `dsh_doctor` and the offline suite before upgrading |
| 0.4.x | `0.1.7-rc.1` | ✅ Verified | Team mode was on by default at that time |
| 0.4.x | `0.1.5-rc.1` | ⚠️ Partial | No team packages |

> The experimental packages (`dsh-experimental-agent-team`,
> `dsh-experimental-tool-agent-team`) carry **no stability promise**. They ship with
> a DSH version and must not be mixed across major versions.

## Public contract (what callers can rely on)

- **Sentinel JSON**: the top-level `schema` is the format version, currently `1` (older releases omit the field; their shape is the same as 1). Within one `schema`, fields are **only added**, never removed, renamed or retyped; callers should ignore fields they do not know. A breaking change bumps `schema` and is called out in the CHANGELOG.
- **MCP tool surface**: tool names, parameter names and types, which parameters are required, enum values. New tools, optional parameters and enum values are compatible; removing anything, changing a type, making a parameter required or dropping an enum value is breaking, happens only with a minor version change (before 1.0), and is called out in the CHANGELOG. Tool descriptions and the returned `text` are not part of the contract (they are written for the model and change freely).
- **Live event stream**: each event's `v` is its format version; fields are listed in [live-view-design.md](live-view-design.md) §6.

`test/contract.mjs` compares the shape of the first two with `test/contract.snapshot.json` and fails on any difference; `node test/contract.mjs --update` refuses to rewrite the snapshot when sentinels changed incompatibly without a `schema` bump.

## Runtime requirements

- **Node.js ≥ 22.15** for this server (uses `zstdDecompressSync` from `node:zlib` to read DSH session headers);
- DSH installed and `~/.dsh` already has a working provider and credentials (the GUI can chat);
- **DSH's own Node requirement** (`engines.node`, ≥ 24.9 from 0.2.2) is met by whatever runtime launches DSH:
  the desktop app's bundled runtime when DSH comes from the desktop app (no local Node 24 needed), or this server's node for npm/npx installs;
- Team mode also requires DSH `>= 0.1.7-0` and a profile that actually mounts both team packages.

## Where DSH comes from (auto-detected, no configuration)

The server finds DSH on its own, in this order — **no need to set `DSH_BIN`**:

1. **DeepSeek Harness desktop app**: on Windows the install directory comes from the uninstall
   registry (HKCU/HKLM); default install locations are checked on every platform. The CLI lives
   inside `resources/app.asar`, so the server runs it with the app's bundled Electron in Node mode
   (`ELECTRON_RUN_AS_NODE=1`) — the same DSH and the same runtime the GUI uses;
2. **npm global install** (`npm i -g @deepseek-ai/dsh`);
3. **npx cache** (can vanish at any time; lowest priority when otherwise equal).

When several exist: candidates whose runtime satisfies `engines.node` first → higher version →
desktop > global > npx. `DSH_BIN` (may point inside an `.asar`) and `DSH_RUNTIME` (the executable
that launches DSH) are explicit overrides only.

## How to check

```bash
dsh-any-agent --version          # this server
dsh-any-agent team status        # team switch and profile
```

In an MCP client, call `dsh_doctor` and look at:

- `dsh_bin`: DSH entry point, version, source (desktop / npm global / npx cache / DSH_BIN) and runtime; **warn** when it resolves from an npx cache (`_npx/<hash>/`), which disappears on cache cleanup;
- `dsh_runtime`: whether the launching runtime's Node satisfies DSH's `engines.node`; **warn** if not;
- `dsh_desktop`: the desktop app's version; **warn** when it differs from the DSH this server uses (both share the `~/.dsh` session store);
- `dsh_candidates`: every DSH found and which one was picked;
- `dsh_version`: the version graded against the table above — `verified` is ok (the note says whether the current release line re-ran the full suite on that version, or its last full run was on the previous line); `partial` / `unsupported` / `unverified` (e.g. 0.2.3+) / unreadable are **warn**;
- `profile`: exists, drift, route source;
- `team`: `on` / `off` / `requested but unavailable` (version or profile lacks the team package);
- `config`: effective permission, idle reaping, shared process, and so on.

## Upgrade advice

1. Record `dsh_doctor` before upgrading DSH;
2. After upgrading, run `node test/run.mjs` (offline) and `node test/run.mjs --all` (needs a provider);
3. If team mode will not turn on, check `dsh-any-agent team status` and `dsh_doctor`'s
   `team` check, then verify `~/.dsh/profiles/dsh-team/cordis.patch.yml` contains
   `@deepseek-ai/dsh-experimental-agent-team`;
4. By default the server follows the desktop app: after the app updates, the next DSH launch picks
   up the new version (discovery is cached for 60 s). Set `DSH_BIN` only to pin a specific version.
