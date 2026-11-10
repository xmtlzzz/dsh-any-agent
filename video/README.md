# 宣传视频

用 [Remotion](https://www.remotion.dev/) 渲染的 54 秒宣传片（1920×1080，30fps）。不属于 npm 包（根目录 `package.json` 的 `files` 白名单不含 `video/`），主项目仍是零依赖。

```bash
cd video
npm install
npm run render          # → out/dsh-any-agent-promo.mp4
npm run dev             # Remotion Studio，边改边看
npm run stills -- 300 760 1350   # 只渲染几帧 PNG，检查排版用
```

首次渲染会自动下载 Remotion 用的 Chrome Headless Shell（约 130 MB）。

**发布到哪里**：网页版（720p、约 3 MB）放在 `website/src/media/promo.mp4`，封面是 `promo-poster.jpg`（第 300 帧，品牌画面），官网构建时按内容哈希命名；README 用封面图链接到官网的 `#video`。1080p 完整版作为 GitHub Release 附件上传。重新渲染后用下面"分两步"里的系统 ffmpeg 命令重出这两份：

```bash
ffmpeg -framerate 30 -i out/frames/element-%04d.jpeg -i public/bgm.wav -vf scale=1280:720:flags=lanczos -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -movflags +faststart ../website/src/media/promo.mp4
ffmpeg -i out/frames/element-0300.jpeg -vf scale=1280:720:flags=lanczos -q:v 3 ../website/src/media/promo-poster.jpg
```

如果 `npm run render` 在编码阶段报 `EPIPE` / `Permission denied` / `write EOF`（Remotion 自带的 ffmpeg 写不了临时目录，常见于沙箱环境），可以分两步：先只出帧，再用系统 ffmpeg 合成并混入配乐。

```bash
npm run music
npx remotion render src/index.jsx Promo out/frames --sequence --image-format=jpeg --jpeg-quality=95
ffmpeg -framerate 30 -i out/frames/element-%04d.jpeg -i public/bgm.wav -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart out/dsh-any-agent-promo.mp4
```

## 结构

| 场景 | 时长 | 内容 |
|---|---|---|
| hook | 6s | 痛点：编辑器一关就没、想改口只能等、长活得守着 |
| brand | 6s | README 主视觉（`docs/brand/header.jpg`）+ 标语 |
| clients | 6s | 10 个 MCP 客户端 → dsh-any-agent → DSH |
| run | 16s | 回放 `demo/transcript.json` 的真实运行：派活、插话、哨兵、复核 |
| caps | 12s | 断线 resume、多会话并发、调用方验收、只读档 |
| outro | 8s | 安装命令、官网、GitHub |

- **时间轴只有一份**：`src/timeline.mjs`。场景和配乐都从它读，所以改了某个动画的帧数，音效会跟着走。场景切换都落在小节线上（120 BPM，一小节 = 60 帧）。
- **终端内容是真实数据**：`run` 场景按行首前缀从 `demo/transcript.json` 取行，只把临时目录路径缩写了（画面上注明了）。重新 `npm run demo -- --save` 录一份，视频就跟着更新。
- **配色**取自 `website/src/style.css` 的深色主题变量。

## 配乐

`npm run music`（`render` / `dev` 会自动先跑）用 `scripts/make-music.mjs` 合成 `public/bgm.wav`：

- 全部由振荡器和噪声生成，**没有采样、没有第三方素材**，版权上没有顾虑；种子固定，每次生成结果一致。
- 120 BPM lo-fi house，和弦走"王道进行"（IV△7 – V7 – iii7 – vi7），最后一小节解决到 C△9。
- 音效（敲键盘、插话时的故障音和音乐压低、哨兵落地的"叮"、验收通过的和弦、PASS 盖章……）按 `timeline.mjs` 里的 `cues()` 精确对帧。

想换成外部曲子：把文件放进 `public/`，改 `src/Promo.jsx` 里 `<Html5Audio src=…>` 的文件名即可；如果还想保留合成的音效，需要把 `make-music.mjs` 里的乐器部分关掉、只留 `cues()` 那段。外部曲子请确认授权允许商用 / 二次分发。
