> 返回 [README](../../README.zh.md)

# 📦 发布流程

发版清单。顺序有讲究 —— 其中两步是因为跳过它们发过一次坏版本才补上的。

```bash
# 1. 升版本号。SERVER_VERSION 读的是 package.json，别处不用改
#    （以前这里有两份数字，漂移过）
npm version patch --no-git-tag-version
#    同步 server.json 里的两个 version（顶层与 packages[0]），check:release 会核对
#    然后手工改 CHANGELOG.md：
#      - 把 [Unreleased] 变成新版本一节（这一节就是 GitHub Release 的说明，写给用户看）
#      - 文末链接区：[Unreleased] 改成 compare/vx.y.z...HEAD，并加一行 [x.y.z]: …/compare/v上一版...vx.y.z
#    CHANGELOG.zh.md 照样改一遍（同一个版本标题、同样的文末链接，内容是中文译文）；
#    两份的版本标题或链接对不上时 check:release 会失败

# 2. 本地跑一遍离线套件（和 CI 相同，不花 token、不需要 DSH）
node test/run.mjs
node test/package-check.mjs
npm run check:release   # 版本号 / CHANGELOG 这一节与文末链接 / 中英 CHANGELOG 版本一致 / 能否生成 Release 说明 / 文档链接 / 打包清单
npm run docs:counts:check   # tests.md 与 CI 注释里的检查数 = 刚才 node test/run.mjs 写出的报告
#    不一致就是改过测试没更新数字：node test/run.mjs --all --report .state/test-report.json && npm run docs:counts
#    （模型套件的数字只有带 --all 的报告才会更新，见 docs/zh/tests.md「改了测试之后」）
node scripts/release-notes.mjs x.y.z   # 预览 Release 页面上会显示的说明

# 3. 确认 tarball 本身：打得出来、装得上、起得来
npm pack --dry-run
#    再在临时目录里：npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. 合进 main（走 PR，CI 绿了再合），然后在 main 的那个提交上打 tag 并推送
git tag -a vx.y.z <main 上的提交> -m "vx.y.z"
git push origin vx.y.z
```

**推送 tag 之后的事都由 `.github/workflows/release.yml` 完成，不需要再在本机 `npm publish`：**

1. **npm 发布**：先核对 tag 与 `package.json` 版本一致，再跑 `check:release` 与 `package-check`，然后用 **npm Trusted Publishing**（GitHub OIDC）发布并附带 provenance —— 不需要 `NPM_TOKEN`，npm 页面上会显示"由这个仓库的 GitHub Actions 构建"。这个版本已经在 npm 上就跳过。发布后一直等到 npm 真能查到这个版本，这一步才算完成。
2. **GitHub Release**：npm 那一步完成后才创建。说明取自 CHANGELOG 里这个版本的那一节（`scripts/release-notes.mjs`），末尾附安装命令和 compare 链接。Release 已存在时只更新说明，所以重跑是安全的。之所以排在 npm 之后：Glama 等目录在新的 GitHub Release 出现时会重新构建并 `npm install -g dsh-any-agent`，Release 先出来就会装到上一个版本（v0.6.4 时 Release 比 npm 可用早了约 2.7 分钟）。
3. **MCP Registry**：npm 发布之后，用工作流自己的 GitHub OIDC 登录官方 MCP Registry（`io.github.xmtlzzz/*` 命名空间），把 `server.json` 登记上去。Registry 通过 npm 包里的 `mcpName` 字段确认归属，所以必须在 npm 之后。`mcp-publisher` 版本固定，并用 cosign 校验签名后才执行。

**可选的发版闸门（模型套件）**：在仓库 Settings → Secrets and variables → Actions → Variables 里加一个 `MODEL_SUITE_RUNNER`，值是一台装了 DSH、配好 provider 与凭据的自托管 runner 的标签。设了之后，推送 tag 时会先在这台 runner 上对被打 tag 的提交跑 `node test/run.mjs --all`，npm 发布等它通过；失败就在发布任何东西之前停下。没设这个变量时该任务被跳过，流程与以前完全一样。手动重跑旧 tag（刷新 Release 说明）不会触发它。注意：真机套件不能并发（`cleanup.mjs` 会删掉所有测试会话），工作流已用 concurrency 组串行化，但这台 runner 上不要同时手动跑 `--all`。
**一次性配置（只需做一次）**：npmjs.com → 包 `dsh-any-agent` → Settings → Trusted Publisher → GitHub Actions，填仓库 `xmtlzzz/dsh-any-agent`、工作流文件 `release.yml`。没配之前，npm 那一步会报认证错误，GitHub Release 也不会创建；这时可以在本机手动 `npm publish` 兜底，再在 Actions 里重跑：npm 那一步会跳过，GitHub Release 照常创建。

**重发某个旧版本的 Release 说明**：Actions → release → Run workflow，填已有的 tag（如 `v0.6.2`）。npm 那一步会因为版本已存在而跳过。

**发布后看到 404，不要当成失败。** npm 对新版本是异步入库（返回 `PUT 202` 而不是 `200`），几秒后去查 registry 仍然是 404，看起来像没发成功。CI 发布时看 npm 那一步的日志；本机手动发布时确认 npm 日志里有这一行：

```
grep 'http fetch PUT 202' "$LOCALAPPDATA/npm-cache/_logs/<最新的>.log"
```

然后等一两分钟再查 `npm view dsh-any-agent dist-tags`。
