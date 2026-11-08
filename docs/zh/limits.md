> 返回 [README](../../README.zh.md)

# ⚠️ 已知限制

1. **逐字流式进不了模型上下文** —— MCP 的固有限制，不是 DSH 的。调用方拿到的是分步结果；人能通过 stderr 日志跟进。
2. **真·中途改向做不到** —— ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`）。`dsh_interject` 是实用等价物：取消 + 立刻开新回合，历史保留。
3. **图片提示不支持** —— ACP 自报 `promptCapabilities: {image: false}`。
4. **MCP 服务重启会连坐** —— 本服务被重启/杀掉时，它拉起的 DSH 子进程会随 stdio 管道关闭一起退出：**进行中的回合会中断、哨兵不会落地**（此时要靠核对工作区状态判断，别干等哨兵）。好消息是**写锁会自动释放**，重启后总能拿回来。
   另注：本服务不会主动发 MCP 通知，"跑完通知"靠哨兵文件 + 调用方的后台等待任务实现。
5. **首次成功回合之前就死掉的会话可能尚未落盘** —— 此时 resume 会报清晰错误。发出第一条消息后就安全了。
6. **不能改名** —— DSH 的标题子系统没有对外改名接口（`SessionTitleService.rename` 需要进程内的活会话）。标题一律由首条消息自动生成。
7. **`session/list` 只返回 `{sessionId, cwd}`，且排除已打开的会话** —— 对话名由本服务从 DSH 投影缓存补全。
8. **内存（实测 300–480MB/活跃进程）** —— 0.5.0 起同 `(cwd, permission)` 的会话**默认共用一个 ACP 进程**，所以这份开销是**每组一份**，不再按会话翻倍；再加上 0.4.0 起的默认 **空闲 10 分钟回收 + `MAX_LIVE=4`**，最坏约 1.2–1.9GB。`keep_alive=true` 的会话不因空闲被回收（代价是常驻）。还可以：① `DSH_MCP_MAX_RSS_MB` 按实际 RSS 预算回收；② `DSH_MCP_CHILD_MAX_OLD_SPACE_MB` 给子进程设堆上限。一批活干完想立刻归零：**`dsh_release(all=true)`** ✓（默认只释放空闲会话，**正在跑的回合会跳过、继续跑**；要连它们一起停掉传 `force=true`。之后照样 resume）。
9. **共享进程会连坐** —— 默认开启的共享宿主让同 `(cwd, permission)` 的会话共用一个 PID：会话之间互不干扰（各自有 Agent 与上下文），但**进程一旦崩溃/被杀，同组所有会话的进行中回合会一起断**（会统一写 error 哨兵并唤醒等待者，下次派活各自 resume，会话本体无损）。所以：① `dsh_takeover` 杀这类进程前要求 `force=true`，并列出"车上还有谁"；② 需要严格隔离（分析不可信样本、跑互不信任的任务）就设 `DSH_MCP_SHARED_PROCESS=0`；③ 不同工作区/不同权限档本来就各起一个进程 —— 那是 `dsh-base` 的进程级沙箱与审批配置决定的，不是可选项。
10. **实时查看（`watch` / `dashboard`）的边界** ——
   ① **只看本机**：事件写在本机的 `$DSH_HOME/.dsh-any-agent/live/`，远程或云端的会话看不到；
   ② **只读**：不能在页面上批准、插话或中断，这些仍走 MCP 工具（`dsh_approval_decide` / `dsh_interject` / `dsh_interrupt`）；
   ③ **只看得到经 ACP 上报的工具调用**：DSH 子代理内部的调用是否上报由 DSH 决定，本服务不额外推断；
   ④ **token 数字来自 DSH 的会话记录**：DSH 还没写入时显示"暂无数据"；会话累计包含 live 之前的回合；
   ⑤ **事件不追溯**：0.6.1 之前跑过的回合没有调用链，0.6.2 之前的回合没有 token；
   ⑥ 界面文字目前是中文。

## ❓ 为什么 profile 还叫 `dsh-mcp`？

因为改名会打断一堆已经落盘的东西。

本服务首次启动时会在 `~/.dsh/profiles/dsh-mcp/` 建一个 DSH profile。0.5.0 起团队模式按需开启：开启时 profile 切到 `dsh-team`（同样由本服务自动创建），默认或关闭时仍用 `dsh-mcp`。两者共用同一套 `DSH_MCP_*` 变量与 `# dsh-mcp:managed` 标记。

这个目录名被另外三样持久化标识引用着：

| 持久标识 | 位置 | 改名的后果 |
|---|---|---|
| profile 目录 | `~/.dsh/profiles/dsh-mcp/` | 已有会话解析不到 provider（`no adapter registered for provider "…"`） |
| `DSH_MCP_*` 环境变量 | 你的客户端配置 | 所有部署都得同时改 |
| `# dsh-mcp:managed` 标记行 | 生成的 `cordis.patch.yml` 首行 | bootstrap 不再认它是自己写的，从此不再同步 |

所以**产品名**是 `dsh-any-agent`，**持久标识**故意保留旧名。这是刻意的兼容决定，不是漏改。如果你是全新部署、想要别的 profile 名，直接设 `DSH_MCP_PROFILE` —— 服务会照你给的名字用。
