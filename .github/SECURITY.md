# Security policy · 安全策略

## Reporting a vulnerability · 报告漏洞

**Please do not open a public issue for security problems.** Report privately through GitHub:
**[Security → Report a vulnerability](https://github.com/xmtlzzz/dsh-any-agent/security/advisories/new)**.

请**不要**在公开 issue 里报告安全问题，通过 GitHub 私下报告：仓库页面 **Security → Report a vulnerability**（链接见上）。

Please include · 请尽量附上：

- the dsh-any-agent version (`dsh-any-agent --version`) and DSH version (from `dsh_doctor`) · 版本号；
- the permission tier and `on_approval` of the session involved · 会话的权限档与审批策略；
- minimal steps or a proof of concept, and what you expected instead · 最小复现步骤与预期行为。

This is a small, volunteer-maintained project. Reports are acknowledged on a best-effort basis, usually within a week; fixes for confirmed issues ship as a patch release with a CHANGELOG entry crediting the reporter (unless you prefer otherwise).

这是个人维护的小项目：会尽力在一周内回复；确认的问题会以补丁版本修复，并在 CHANGELOG 里致谢（如不希望署名请说明）。

## Supported versions · 支持的版本

Only the **latest minor release line** receives security fixes. Upgrade with `npm install -g dsh-any-agent@latest`.

只有**最新的次版本线**会收到安全修复。使用 `npm install -g dsh-any-agent@latest` 升级。

## In scope · 属于本项目的安全问题

dsh-any-agent sits between an MCP client and DeepSeek Harness. Issues in what *this server* promises are in scope, for example:

- **Permission tiers**: a `read-only` session that can write or receives an approval, or a per-session request for `danger-full-access` that bypasses the machine-side permission settings.
- **Path handling**: a `conversation_id` / `run_id` / `cwd` that escapes its directory (traversal into sentinel, review, lock, tombstone or live-event paths); a writable `cwd` at a filesystem root or home directory.
- **Disk hygiene**: reasoning text written to this server's own files (sentinels, reviews, live events, registry, logs) without `DSH_MCP_SENTINEL_INCLUDE_REASONING=1`; credentials that survive redaction in sentinels, approval context or live-event previews.
- **Write-lock handling**: `dsh_takeover` killing a process it could not prove it owns (the GUI, an unrelated process).
- **Client configuration**: `dsh-any-agent-setup` / `restore` changing entries other than its own, or losing a user's config without a backup.
- **Live dashboard**: reaching it without the one-time token, from a non-loopback address, or with a foreign `Host` header; any request that changes state; script injection through event content.

## Out of scope · 不属于本项目

- **DeepSeek Harness itself** (its sandbox, model behaviour, its own session logs, which do contain reasoning) — report to the DSH project.
- **Side effects of external MCP tools** that DSH is configured to use — they are not constrained by DSH's sandbox; see the usage notes.
- **Documented behaviour**. The default tier is `workspace-write` with `auto-deny`. Explicitly enabling `DSH_MCP_APPROVAL=auto-allow` can grant DSH requests for `sandbox_permissions: danger-full-access`. Results report those grants in `auto_escalations_total`. Set `DSH_MCP_APPROVAL=ask` to review requests individually. 默认档是 `workspace-write`，越界审批默认拒绝。可设置 `DSH_MCP_APPROVAL=ask` 逐条裁决。
- Anything that requires an attacker who can already write to your `~/.dsh` directory or run code as your user.

## More · 更多

How permissions, approvals, logging and the live view behave: [docs/en/security.md](../docs/en/security.md) · [docs/zh/security.md](../docs/zh/security.md).
