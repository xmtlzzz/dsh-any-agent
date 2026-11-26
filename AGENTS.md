# Repository Agent Guidelines (`dsh-any-agent`)

Project instructions for coding agents working in this repository.

## 1. Core Invariants

- **Zero runtime and dev dependencies**: `package.json` must have no `dependencies` or `devDependencies` (enforced by `test/package-check.mjs`). Standard Node built-ins only (`node:>=22.15`, ESM `.mjs` only).
- **Zero-repo-dependency static checks**: run `npm run lint` (syntax, relative import path casing, named exports, unused imports, `[cycle]` import-cycle detection) and `npm run typecheck` (`tsc --noEmit --checkJs` over `jsconfig.json`: `src/`, `bin/`, `scripts/`). Fix type diagnostics cleanly without `@ts-ignore`.
- **Safe commits**: always commit through `node scripts/commit.mjs --file -` (message via stdin) rather than creating temporary commit-message files that `git add -A` could capture.
- **Modular architecture**: keep `src/` modules focused and cycle-free (facade + sub-modules where appropriate), preserve existing public exports and wire/contract compatibility (`test/contract.mjs`).

## 2. Mandatory Post-Update & Post-Release Alignment Checklist

Whenever **behavior, CLI flags/subcommands, environment variables, defaults, `dsh_doctor` checks, MCP tools, or test suites** change — **and after every new version release** — audit and synchronize all four surfaces before concluding:

1. **Code & Machine Contracts**
   - `src/config.mjs` (defaults, `DSH_COMPAT`), `src/mcp.mjs` (`INSTRUCTIONS`, `SERVER_VERSION`), `src/tool-defs.mjs` / `src/tool-defs.en.mjs`, and `server.json`.
   - Ensure bilingual parity (`DSH_MCP_LANG=zh|en`) and run `node test/i18n-en.mjs` + `node test/smoke.mjs`.

2. **Bilingual Documentation (`README*.md` & `docs/{zh,en}/*.md`)**
   - `README.md` / `README.zh.md`: quick start, features, 15-tool table, annotations, live view, and documentation map links.
   - `CHANGELOG.md` / `CHANGELOG.zh.md`: matching version headings, accurate summaries, and bottom compare links.
   - Paired guides under `docs/zh/` & `docs/en/`: `install.md`, `usage.md`, `caveats.md`, `locking.md`, `security.md`, `reference.md`, `compatibility.md`, `tests.md`, `limits.md`, `architecture.md`, `team.md`, `release.md`, `live-view-design.md`, `demo.md`.
   - Keep Chinese and English docs symmetric: do not leave English/Chinese-only stale caveats, mixed-language UI labels, or contradictory guidance between sections (for example `caveats.md` §3.5 vs §3.11 on DSH GUI write locks).

3. **Project Website (`website/`)**
   - `website/src/index.html` & `website/src/index.en.html` (especially install notes, `#faq-recovery`, `#faq-locking`, `#faq-permissions`, `#faq-versions`).
   - `website/src/app.mjs` (`TOOL_INFO` 15-tool inspector descriptions & manual client config tabs) and `website/test/site.test.mjs`.
   - Never bake a `vX.Y.Z` literal (with leading `v`) into `website/src/index*.html` — `website/test/site.test.mjs` forbids `\bv\d+\.\d+\.\d+\b` because `#release-version` is loaded dynamically at runtime via `/api/version` (`website/src/release.mjs`). Write bare version numbers such as `0.8.1` when citing tested upgrades in FAQ text.
   - Whenever files under `website/` change, run `npm --prefix website run check` and deploy to Cloudflare Workers via `npm --prefix website run deploy`.

4. **Factual & Numeric Accuracy**
   - Verify every documented default, env-var interaction (e.g. `ALLOW_FULL_ACCESS` in `src/config.mjs`), notification behavior (`progressToken` vs completion sentinels), and recovery rule directly against the implementation.
   - Never guess or hand-copy test or suite counts: verify suite counts directly against `test/run.mjs` (`OFFLINE` / `MODEL`), sync check counts via `npm run docs:counts`, and pass both `npm run docs:counts:check` and `npm run docs:counts:check -- --portable`.

## 3. Standard Verification Gates

Before opening a PR or tagging a release:

```bash
npm run lint
npm run typecheck
npm test
node test/package-check.mjs
npm run docs:counts:check
npm run docs:counts:check -- --portable
npm run check:release
npm --prefix website run check
```
