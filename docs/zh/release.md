> 返回 [README](../../README.zh.md)

# 📦 发布流程

发版清单。顺序有讲究 —— 其中两步是因为跳过它们发过一次坏版本才补上的。

```bash
# 1. 升版本号。SERVER_VERSION 读的是 package.json，别处不用改
#    （以前这里有两份数字，漂移过）
npm version patch --no-git-tag-version
#    然后手工改 CHANGELOG.md：把 [Unreleased] 变成新版本一节

# 2. 本地跑一遍离线套件（和 CI 相同，不花 token、不需要 DSH）
node test/run.mjs
node test/package-check.mjs

# 3. 确认 tarball 本身：打得出来、装得上、起得来
npm pack --dry-run
#    再在临时目录里：npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. 打 tag 并推送（CI 绿了再发）
git add -A && git commit -m "chore: release x.y.z"
git tag vx.y.z && git push origin main --tags

# 5. 发布
npm publish
```

**发布后看到 404，不要当成失败。** npm 对新版本是异步入库（返回 `PUT 202` 而不是 `200`），几秒后去查 registry 仍然是 404，看起来像没发成功。先确认本地 npm 日志里有这一行：

```
grep 'http fetch PUT 202' "$LOCALAPPDATA/npm-cache/_logs/<最新的>.log"
```

然后等一两分钟再查 `npm view dsh-any-agent dist-tags`。
