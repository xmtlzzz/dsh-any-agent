## What and why · 改了什么、为什么

<!-- One or two sentences. Link the issue if there is one. · 一两句话，有 issue 就链接。 -->

## Checklist · 检查

- [ ] `npm test` passes (offline suites) · 离线套件通过
- [ ] `npm run lint` passes · lint 通过
- [ ] Tests changed → ran `npm run docs:counts` · 改了测试就同步检查数
- [ ] New behaviour has an offline test (fake hub / fake ACP — no DSH, no tokens) · 新行为有离线测试
- [ ] User-visible change → `CHANGELOG.md` and `CHANGELOG.zh.md` `[Unreleased]` entries · 用户可见的改动写进中英两份 CHANGELOG
- [ ] Docs changed in **both** `docs/zh` and `docs/en` (and both READMEs if relevant) · 中英文文档同步
- [ ] No reasoning text written to disk by this server; previews go through `sanitizeApprovalContext` · 守住隐私红线
- [ ] Still zero runtime dependencies · 仍然零运行时依赖

## Verification · 怎么验证的

<!-- What you ran or checked by hand. Model-backed suites (npm run test:all) need a real DSH — say if you ran them. · 你实际跑了什么；需要真实 DSH 的套件跑没跑请说明。 -->
