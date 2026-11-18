> Back to [README](../../README.md)

# 🧩 Compatibility matrix

`dsh-any-agent` drives DSH through its ACP profile. Team mode uses experimental
plugins or the session team mode, depending on the DSH version. Check this table before
upgrading DSH, and run `dsh_doctor` afterwards.

## Versions

| dsh-any-agent | DSH | Status | Notes |
|---|---|---|---|
| 0.7.6 | `0.2.2-rc.3` (desktop app) | ✅ Verified (ACP, upgrade) | Upgraded from npm 0.7.5 on Windows with a real provider. Verified result retrieval after a reconnect, idempotent replay, and a new turn in the original session |
| 0.7.5 | `0.2.2-rc.3` (desktop app) | ✅ Verified (ACP, upgrade) | Upgraded the installed npm 0.7.4 package on Windows with a real provider. Verified result retrieval, idempotent replay, and a new turn in the original session |
| 0.7.4 | `0.2.2-rc.3` (desktop app) | ✅ Verified (ACP, team mode) | Standard ACP dispatch and in-place upgrade from npm 0.7.3 on Windows. Desktop DSH with a local simulated model endpoint verified that team mode is off by default and that enabling it exposes both the native task board and standard subagents |
| 0.7.3 | `0.2.2-rc.3` (desktop app) | ✅ Verified (standard ACP) | Full Windows regression and real-provider install and upgrade from 0.7.2 passed. IDA MCP acceptance skipped without a configured server. Using the newer team mode requires an MCP update |
| 0.7.3 | `0.2.2-rc.1` (desktop app) | ✅ Verified (upgrade) | On Windows with a real provider, upgraded the installed npm 0.7.2 package to 0.7.3, retrieved the saved result, replayed the original key, and completed another turn in the existing session |
| 0.7.2 | `0.2.2-rc.1` (desktop app) | ✅ Verified (installed package lifecycle) | Windows with the desktop app's bundled runtime and a real provider. Codex passed dispatch, wait cancellation, and result retrieval after reconnecting. [Release verification](https://github.com/xmtlzzz/dsh-any-agent/pull/27). [Hosted CI](https://github.com/xmtlzzz/dsh-any-agent/actions/runs/43357420994) exercised the installed package on Windows, Linux, and macOS with simulated ACP |
| 0.7.1 | `0.2.1-rc.5` | ✅ Verified | Windows release candidate tested with DSH via npx and Node 22.19. The full run passed 41 offline suites and found one localized error assertion failure in the model-backed `boundary` suite. After the fix, `boundary` passed all 46 checks. The optional `acceptance` suite was skipped because the profile had no IDA MCP |
| 0.7.0 | `0.2.2-rc.1` (desktop app) | ✅ Verified (offline) | All 41 offline suites (1892 checks) passed on 2026-11-11. In a resident process test, the Claude desktop app was quit mid-turn and reopened, and the turn finished with a `done` sentinel |
| 0.6.x | `0.2.1-rc.5` | ✅ Verified | Full suite run against 0.6.9 on 2026-11-10 (offline + model-backed; DSH via npx, Node 22.19), all passing; `acceptance` skipped because the profile has no IDA MCP. Other DSH versions were not re-verified for 0.6.x — the 0.5.x rows below are their last runs |
| 0.5.x | `0.1.7-rc.1` through `0.2.2-rc.1` | ✅ Verified | ACP and the experimental team tools are available. Enable team mode with `dsh-any-agent team on` |
| 0.5.x | `0.1.5-rc.1` | ⚠️ Partial | ACP basics work; no team packages, so team mode stays off |
| 0.5.x | `0.2.1-rc.5` – `0.2.2-rc.1` | ✅ Verified | Full suites run on 2026-11-06 (0.2.1-rc.5 from npm, 0.2.2-rc.1 on the desktop app's bundled runtime); from 0.2.2 DSH requires Node ≥ 24.9 |
| 0.5.x | `0.2.3` or newer | ⚠️ Unverified | The ACP `session/*` surface may change; team packages must match the DSH version. Run `dsh_doctor` and the offline suite before upgrading |
| 0.4.x | `0.1.7-rc.1` | ✅ Verified | Team mode was on by default at that time |
| 0.4.x | `0.1.5-rc.1` | ⚠️ Partial | No team packages |

> The experimental packages (`dsh-experimental-agent-team`,
> `dsh-experimental-tool-agent-team`) carry **no stability promise**. They ship with
> a DSH version and must not be mixed across major versions.

## Public contract (what callers can rely on)

- **MCP stdio** supports the `2026-07-28` request metadata and service discovery, plus handshake revisions from `2024-11-05` through `2025-11-25`. Pass an explicit `cwd` with `2026-07-28`. Older clients can supply a single local MCP root.
- **Sentinel JSON**: the top-level `schema` is the format version, currently `1` (older releases omit the field; their shape is the same as 1). Within one `schema`, fields are **only added**, never removed, renamed or retyped; callers should ignore fields they do not know. A breaking change bumps `schema` and is called out in the CHANGELOG.
- **MCP tool surface**: tool names, parameter names and types, which parameters are required, enum values. New tools, optional parameters and enum values are compatible; removing anything, changing a type, making a parameter required or dropping an enum value is breaking, happens only with a minor version change (before 1.0), and is called out in the CHANGELOG. Tool descriptions and the returned `text` are not part of the contract (they are written for the model and change freely).
- **Live event stream**: each event's `v` is its format version; fields are listed in [live-view-design.md](live-view-design.md) §6.

`test/contract.mjs` compares the shape of the first two with `test/contract.snapshot.json` and fails on any difference; `node test/contract.mjs --update` refuses to rewrite the snapshot when sentinels changed incompatibly without a `schema` bump.

## Runtime requirements

- **Node.js ≥ 22.15** for this server (uses `zstdDecompressSync` from `node:zlib` to read DSH session headers);
- DSH installed and `~/.dsh` already has a working provider and credentials (the GUI can chat);
- **DSH's own Node requirement** (`engines.node`, ≥ 24.9 from 0.2.2) is met by whatever runtime launches DSH:
  the desktop app's bundled runtime when DSH comes from the desktop app (no local Node 24 needed), or this server's node for npm/npx installs;
- Team mode requires DSH `>= 0.1.7-0` and a compatible profile. DSH through `0.2.2-rc.1` uses the experimental team packages. DSH `0.2.2-rc.2` onward uses session team mode. See the [team mode guide](team.md).

## Where DSH comes from (auto-detected, no configuration)

The server finds DSH on its own, in this order — **no need to set `DSH_BIN`**:

1. **DeepSeek Harness desktop app**: on Windows the install directory comes from the uninstall
   registry (HKCU/HKLM); default install locations are checked on every platform. The CLI lives
   inside `resources/app.asar`, so the server runs it with the app's bundled Electron in Node mode
   (`ELECTRON_RUN_AS_NODE=1`) — the same DSH and the same runtime the GUI uses;
2. **npm global install** (`npm i -g @deepseek-ai/dsh`);
3. **npx cache** (can vanish at any time; lowest priority when otherwise equal).

When several exist: candidates whose runtime satisfies `engines.node` first → higher version →
desktop > global > npx. `DSH_BIN` specifies the DSH entry file, which can be inside an `.asar`.
`DSH_RUNTIME` specifies the executable used to launch DSH. Both overrides require files.

## How to check

```bash
dsh-any-agent --version          # this server
dsh-any-agent team status        # team switch and profile
```

In an MCP client, call `dsh_doctor` and look at:

- `dsh_bin`: DSH entry point, version, source (desktop / npm global / npx cache / DSH_BIN) and runtime; **warn** when it resolves from an npx cache (`_npx/<hash>/`), which disappears on cache cleanup;
- `dsh_runtime`: whether the Node runtime used to launch DSH satisfies `engines.node`. From 0.7.6 onwards, an invalid `DSH_RUNTIME` path or confirmed incompatibility reports **fail**. A version that cannot be read reports **warn**;
- `dsh_desktop`: the desktop app's version; **warn** when it differs from the DSH this server uses (both share the `~/.dsh` session store);
- `dsh_candidates`: every DSH found and which one was picked;
- `dsh_version`: `verified` is ok. The note refers to full-suite testing; the table also records narrower checks such as the 0.7.2 installed package lifecycle. `partial` / `unsupported` / `unverified` (e.g. 0.2.3+) / unreadable are **warn**;
- `profile`: exists, drift, route source;
- `team`: `on` / `off` / `requested but unavailable` (the version or profile lacks compatible team configuration);
- `config`: effective permission, idle reaping, shared process, and so on;
- `update`: this server's version against the latest on npm; **warn** when a newer one exists (read at most once a day, 4 s timeout; offline reads as unknown, not a problem; `DSH_MCP_UPDATE_CHECK=0` skips it).

## Upgrade advice

1. Record `dsh_doctor` before upgrading DSH;
2. After upgrading, run `node test/run.mjs` (offline) and `node test/run.mjs --all` (needs a provider);
3. If team mode will not turn on, check `dsh-any-agent team status` and `dsh_doctor`'s
   `team` check, then review the [team profile configuration](team.md);
4. By default the server follows the desktop app: after the app updates, the next DSH launch picks
   up the new version (discovery is cached for 60 s). Set `DSH_BIN` only to pin a specific version.

Resuming an old session on another machine also requires the original workspace path. From 0.7.6 onwards, a missing directory is reported before DSH starts. Restore that directory, or call `dsh_start` with the new path to start a fresh session.
