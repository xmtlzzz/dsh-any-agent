# Contributing · 参与贡献

Thanks for helping. This project is small and opinionated; reading this first saves a round of review.
谢谢参与。这是个小而有主见的项目，先读完这页能少一轮来回。

> Security issues: **don't** open an issue — see [SECURITY.md](SECURITY.md). · 安全问题请看 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## Ground rules · 基本原则

- **A dispatcher, not a capability aggregator.** DSH already has files, shell, search, skills and subagents; this server only adds what *dispatching* needs (sessions, async runs, interjecting, approvals, review, the live view). A PR that proxies a DSH tool through MCP will likely be declined. · 本服务只做派发层，不代理 DSH 已有的能力。
- **Zero runtime dependencies.** `package.json` has no `dependencies`, and `test/package-check.mjs` fails if one appears. Use Node built-ins. (`website/` has none either; `video/` has its own and is not shipped.) · 运行时零依赖，有测试守着。
- **Privacy red line.** Reasoning text is never written to this server's own files (sentinels, reviews, live events, registry, logs), and anything persisted that may hold commands, paths or prompts goes through `sanitizeApprovalContext` first. · 思考内容不落盘；落盘的命令/路径/prompt 先脱敏。
- **Never make a run fail for a side feature.** Audit, live events and similar writes swallow their own errors. · 旁路功能写失败绝不影响派活。
- **Both languages.** User-facing docs live in `docs/zh` and `docs/en` (and `README.zh.md` / `README.md`); change both. · 用户文档中英文同步改。

## Setup · 开发环境

Node.js **≥ 22.15**. No install step for the server itself.
需要 Node.js ≥ 22.15，服务本体无需安装依赖。

```bash
git clone https://github.com/xmtlzzz/dsh-any-agent.git
cd dsh-any-agent
npm test
```

## Tests · 测试

```bash
npm test              # offline suites: no DSH, no model, no tokens — same set as CI · 离线套件，与 CI 相同
npm run lint          # syntax, import paths (case-sensitive), named exports, unused imports
npm run test:all      # + model-backed suites: needs a real DSH with a working provider; spends tokens
```

- **Prefer offline tests.** Most behaviour can be driven with a fake hub and a fake ACP process (see `test/live-events.mjs`, `test/failure-terminal.mjs`). Add the new suite to the `OFFLINE` list in `test/run.mjs` **and** as a step in `.github/workflows/tests.yml`, plus a row in `docs/zh/tests.md` and `docs/en/tests.md`. · 新行为优先写离线测试，并在 run.mjs、CI 与两份 tests.md 里登记。
- **After changing tests**, refresh the documented check counts: `npm run docs:counts` (CI fails on a mismatch via `docs:counts:check`). · 改了测试就同步检查数。
- **Model-backed suites: one run at a time.** `test/cleanup.mjs` (run at the end of every `test/run.mjs`) deletes test sessions under the current `tmpdir()/dsh-any-agent-*`. Two overlapping runs that share a temp root will delete each other's sessions; run them sequentially, or give each runner its own `TMP`. · 真机套件不要并发跑，或给每个 runner 单独的 TMP。
- A suite that drives `Conversation` directly without its own `DSH_MCP_STATE` should `import './live-sandbox.mjs'` first, so running it alone never writes live events into your real `~/.dsh`. · 直接驱动会话对象的套件先引入 `live-sandbox.mjs`。
- Files named `test/_*.mjs` are git-ignored on purpose (scratch scripts). Don't give a real helper an underscore name. · 下划线开头的测试文件会被忽略，正式文件别这样命名。

The website has its own checks: `cd website && npm run check`. · 官网单独检查。

## Commits · 提交

Use the project's commit helper — it reads the message from arguments or stdin, never from a temp file, and refuses to commit `_*` scratch files or `*.tmp-dsh-*` leftovers:
用仓库自带的提交脚本：提交信息不落临时文件，并拦截临时文件入库。

```bash
node scripts/commit.mjs -m "fix(live): short summary" -m "Why, in a sentence or two."
```

Conventional prefixes are used throughout (`feat`, `fix`, `docs`, `test`, `chore`, `ci`), with an optional scope (`feat(live): …`). · 使用约定式前缀。

## Pull requests · PR

- One topic per PR. Fill in the checklist in the template. · 一个 PR 一件事，按模板勾选。
- User-visible changes get a line under `## [Unreleased]` in `CHANGELOG.md` — that section becomes the GitHub Release notes — and the same line in Chinese in `CHANGELOG.zh.md`. · 用户可见的改动写进 `CHANGELOG.md` 的 Unreleased（它会成为 Release 说明），并在 `CHANGELOG.zh.md` 里写同一条的中文。
- Releases are cut by the maintainer; the process is in [docs/en/release.md](../docs/en/release.md) · [docs/zh/release.md](../docs/zh/release.md).

## Where things are · 代码地图

| Path | What |
|---|---|
| `bin/dsh-any-agent.mjs` | entry: MCP stdio server, plus `team`, `watch`, `dashboard` subcommands |
| `src/mcp.mjs`, `src/tools.mjs`, `src/tool-defs.mjs` | MCP protocol and the `dsh_*` tools |
| `src/hub.mjs`, `src/conversation.mjs`, `src/host.mjs`, `src/acp*.mjs` | conversations, shared ACP processes, the ACP wire |
| `src/locks.mjs` | write-lock registration, holder classification, takeover |
| `src/live*.mjs` | live event stream and the `watch` / `dashboard` viewers |
| `src/doctor.mjs` | `dsh_doctor` |
| `bin/setup.mjs`, `bin/restore.mjs`, `src/clients.mjs` | client registration and rollback |
| `test/` | suites; `test/run.mjs` is the entry |
| `website/`, `video/` | the site and the promo video (not shipped in the npm package) |
