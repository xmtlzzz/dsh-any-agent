> 返回 [README](../../README.zh.md)

# 📦 发布流程

发版清单。顺序有讲究 —— 其中两步是因为跳过它们发过一次坏版本才补上的。

```bash
# 1. 升版本号。SERVER_VERSION 读的是 package.json，别处不用改
#    （以前这里有两份数字，漂移过）
npm version patch --no-git-tag-version
#    然后手工改 CHANGELOG.md：
#      - 把 [Unreleased] 变成新版本一节（这一节就是 GitHub Release 的说明，写给用户看）
#      - 文末链接区：[Unreleased] 改成 compare/vx.y.z...HEAD，并加一行 [x.y.z]: …/compare/v上一版...vx.y.z

# 2. 本地跑一遍离线套件（和 CI 相同，不花 token、不需要 DSH）
node test/run.mjs
node test/package-check.mjs
npm run check:release   # 版本号 / CHANGELOG 这一节与文末链接 / 能否生成 Release 说明 / 文档链接 / 打包清单
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

1. **GitHub Release**：说明取自 CHANGELOG 里这个版本的那一节（`scripts/release-notes.mjs`），末尾附安装命令和 compare 链接。Release 已存在时只更新说明，所以重跑是安全的。
2. **npm 发布**：先核对 tag 与 `package.json` 版本一致，再跑 `check:release` 与 `package-check`，然后用 **npm Trusted Publishing**（GitHub OIDC）发布并附带 provenance —— 不需要 `NPM_TOKEN`，npm 页面上会显示"由这个仓库的 GitHub Actions 构建"。这个版本已经在 npm 上就跳过。

**一次性配置（只需做一次）**：npmjs.com → 包 `dsh-any-agent` → Settings → Trusted Publisher → GitHub Actions，填仓库 `xmtlzzz/dsh-any-agent`、工作流文件 `release.yml`。没配之前，npm 那一步会报认证错误（GitHub Release 不受影响）；这时可以在本机手动 `npm publish` 兜底，之后在 Actions 里重跑也只会跳过 npm。

**重发某个旧版本的 Release 说明**：Actions → release → Run workflow，填已有的 tag（如 `v0.6.2`）。npm 那一步会因为版本已存在而跳过。

**发布后看到 404，不要当成失败。** npm 对新版本是异步入库（返回 `PUT 202` 而不是 `200`），几秒后去查 registry 仍然是 404，看起来像没发成功。CI 发布时看 npm 那一步的日志；本机手动发布时确认 npm 日志里有这一行：

```
grep 'http fetch PUT 202' "$LOCALAPPDATA/npm-cache/_logs/<最新的>.log"
```

然后等一两分钟再查 `npm view dsh-any-agent dist-tags`。
