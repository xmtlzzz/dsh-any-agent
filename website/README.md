# dsh-any-agent 官网

中英双语静态官网（`/` 与 `/en/`，带 hreflang），使用现有品牌头图和浏览器本地演示介绍项目。包含异步派活、中途改向、断线恢复、多会话并行、安装配置与常见问题。支持明暗主题、暂停/单步播放、减少动态效果与键盘切换。

[`DESIGN.md`](DESIGN.md) 是用 `npx getdesign@latest add claude` 生成的参考设计规范（暖奶油底、衬线标题、珊瑚色主按钮、深色代码卡片），供改版或让编码 agent 写 UI 前参考；它不是 Anthropic 官方规范，目前站点样式尚未按它改动。仓库根目录的 `DESIGN.md` 是项目早期的架构草案，与此无关。

## 本地开发

需要 Node.js ≥ 22（仅官网构建；MCP 服务本体要求 Node.js ≥ 22.15），无需安装前端依赖。

```bash
cd website
npm run dev
```

预览地址为 `http://127.0.0.1:8770`。修改源码后重新执行构建或重启预览。

```bash
npm run check
npm run build
```

`dist/` 是可独立托管的静态产物；构建从 `../docs/brand/header.jpg` 复制品牌图。页面在运行时从 npm latest 读取版本号（失败时回退 GitHub release/tag），构建不再把版本写死进页面；`src/release.mjs` 负责同步，`src/_headers` 的 CSP `connect-src` 放行这些端点。JS/CSS 使用内容哈希文件名。

## Cloudflare Workers 部署

使用 Cloudflare Workers Static Assets，不需要数据库、API 密钥或后台服务。已有 Wrangler 登录时：

```bash
npm run deploy
```

Wrangler 版本固定为 `4.125.0`，目标名称在 `wrangler.jsonc` 中。首次运行可能下载该版本。后续可在 Cloudflare 控制台为此 Worker 添加自定义域名。

当前部署地址：<https://dsh-any-agent.xmtlz.dev/>（Workers 直连：<https://dsh-any-agent-site.xmtlzloveasuka.workers.dev>）。

`site.config.json` 保存官网地址，用于生成 canonical、Open Graph 图片绝对地址和 sitemap。绑定自定义域名后，更新这个文件并重新构建部署；也可在构建时用 `SITE_URL` 覆盖：

```powershell
$env:SITE_URL = 'https://your-domain.example'
npm run build
```

Cloudflare Workers Git 集成可将根目录设为 `website`，构建命令设为 `npm run build`，部署命令设为 `npx wrangler@4.125.0 deploy`。

### 部署侧行为（不在仓库中）

- Cloudflare Web Analytics 可能自动注入 `https://static.cloudflareinsights.com/beacon.min.js`；`src/_headers` 的 CSP 已放行该脚本与 `https://cloudflareinsights.com` 上报域。若关闭 Web Analytics，不会注入，CSP 放行也不产生影响。
- Cloudflare 的 Managed robots.txt / Content Signals 在**控制台**管理，会在源站 `robots.txt` 之前追加内容。构建生成的 `dist/robots.txt` 现在**镜像同一套完整策略**（`Content-Signal: search=yes, ai-train=no, use=reference`，并 Disallow Cloudflare Managed 列表中的全部训练/抓取 bot），让非 Cloudflare 主机与仓库不再漂移；若控制台策略改变，请同步 `scripts/build.mjs` 并重新部署。
- 主题在首屏前由内联脚本恢复（CSP 使用构建时生成的 sha256 哈希），避免浅色系统用户先看到深色页面。

## Cloudflare Pages（可选）

同一份 `dist/` 也可以直接部署到 Pages。Git 集成的根目录为 `website`，构建命令为 `npm run build`，输出目录为 `dist`。

## 内容与演示

- 中文页面：`src/index.html`
- English page: `src/index.en.html`
- 视觉样式：`src/style.css`
- 演示场景与状态：`src/demo.mjs`
- 播放控制、复制配置与主题：`src/app.mjs`

演示不连接访客本机的 DSH，不调用模型，也不修改文件。示例状态是说明工作流的演示数据。进程中断场景明确区分了“会话可恢复”和“当前回合已中断”。

参考 Magpie 官网的可切换场景、连线和动态状态演示方式；页面代码与产品叙事均针对 dsh-any-agent 编写。形象及生图来源见项目 `docs/brand/README.md`。
