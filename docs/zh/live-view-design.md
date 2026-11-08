> 返回 [README](../../README.zh.md)

# 设计稿：让用户看见 DSH 在做什么（live 事件流 + 查看器）

> 状态：**P1 + P2 已实现**，随 0.6.1 发布；token 用量与查看端改进随 0.6.2 发布（见 CHANGELOG）。实现与本文最初草案的差异已在对应小节标注"实现"。
>
> 代码：`src/live.mjs`（写入）、`src/live-view.mjs`（读取 / 归并 / 终端渲染）、`src/live-cli.mjs`（`watch` / `dashboard` 子命令）、`src/live-dashboard.mjs` + `src/live-dashboard.html`（页面）。测试：`test/live-events.mjs`、`test/live-view.mjs`。
>
> 范围：定位为**轻量功能**，只做 §12 的 P1（事件流 + `watch`）和 P2（只读 `dashboard` 页面）。状态栏、宿主内嵌、控制面都不在本次范围内。

## 1. 问题

本服务把 DSH 当成外包工程师来派活。对**调用方 agent** 来说，过程是透明的：它可以 `dsh_read` 增量拉取、等哨兵、`dsh_get` 取结果。对**坐在 Claude Code / Codex / Cursor 前面的用户**来说，过程基本是黑盒：

- 屏幕上只有一次 `dsh_send` 调用和一张收据（run_id、哨兵路径），然后就是等待。
- DSH 在这期间读了哪些文件、跑了哪些命令、是否借审批把沙箱提升到了 `danger-full-access`，用户看不到——除非 agent 主动去 `dsh_read` 并转述，而这既花 token，也取决于 agent 愿不愿意做。
- 撞到问题（卡在某个工具上、反复失败、一直在等审批）时，用户无从判断是该等还是该打断。

目标是给用户一个**不经过 agent 的旁路视图**。

## 2. 目标与非目标

**目标**

1. 用户能实时看到每个会话：是否在跑、当前在哪个工具上、本轮已调用了哪些工具及其状态。
2. 审批（尤其自动放行和沙箱提权）在视图里显眼。
3. 同时看到所有客户端、所有服务实例派出去的会话。
4. 不破坏现有隐私红线：**思考内容绝不落到这条通路上**。
5. 写入失败绝不影响派活主流程。

**非目标**

- 不做控制面：查看器里不能批准、插话、中断（理由见 §9 第 4 条）。
- 不做状态栏一行输出，也不做宿主内嵌视图（Claude Code 侧边面板、MCP Apps）。将来真要做，也只是读同一份事件流，不需要改服务端。
- 不替代 `dsh_read`、哨兵、审计日志，它们的语义一律不变。
- 不读取 DSH 自己的 `~/.dsh/sessions`。

## 3. 现状：数据在哪

DSH 的工具活动经 ACP 的 `session/update`（`tool_call` / `tool_call_update`）到达本服务，此后的去向：

| 位置 | 内容 | 实时 | 谁能看 |
|---|---|---|---|
| `Conversation.out` 环形缓冲（`src/conversation.mjs` 的 `onSessionUpdate` → `pushOut`） | 工具名 + 状态快照、正文、轮次起止 | 是 | 仅 `dsh_read`，即只有 agent |
| 回合收集器 `collector.tools` / `autoApprovals` | 工具输入、自动放行摘要 | 是 | 回合结束后进哨兵 / `dsh_get` |
| 哨兵 `<RUNS_DIR>/<conv>/<run>.json` | 正文、工具输入（已脱敏） | 否，回合结束才写 | 文件，7 天 TTL |
| 审计 `DSH_MCP_AUDIT_FILE` | 谁对哪个会话做了什么（不含工具） | 是 | 默认关闭 |
| DSH 的 `~/.dsh/sessions` | 全量，含思考内容 | DSH 自己写 | 内部格式 |

结论：实时的数据只存在于服务进程的内存里，唯一的出口是 agent 调用的 MCP 工具。

## 4. 约束

1. **服务是 stdio 子进程。** 每个 MCP 客户端各起一个 `dsh-any-agent`，没有端口，HTML 页面无处可连。
2. **多实例。** Claude Code、Codex、Cursor 同时在用时就有多个服务进程，各自的内存缓冲互不相通。视图必须跨实例聚合。
3. **共享 ACP 进程。** 同一 `(cwd, permission)` 的会话共用一个 DSH 进程（`src/host.mjs`），但事件是按 `sessionId` 分发到各 `Conversation` 的，按会话组织数据不受影响。
4. **写锁。** 同一会话同一时刻只有一个写者（见 [写锁](locking.md)），这让"按会话一个文件、单写者追加"天然成立。takeover 的交接窗口需要单独考虑（§6.5）。
5. **不发 MCP 通知。** 现有设计不依赖客户端处理推送，新方案也不应依赖。
6. **隐私红线。** 日志、哨兵、注册表不写思考正文；新增的任何落盘都要守同一条线，并沿用 `src/redact.mjs` 的脱敏。
7. **测试隔离。** `test/cleanup.mjs` 会清理全部测试会话，真实运行与测试运行不能写同一目录。

## 5. 方案对比

| 方案 | 做法 | 优点 | 主要问题 | 结论 |
|---|---|---|---|---|
| A. 服务进程内嵌 HTTP/SSE | `pushOut` 时推给本进程开的本地端口 | 实时、改动小 | 多实例抢端口要做发现；生命周期绑客户端；本地端口有 CSRF / DNS rebinding 面，要 token；Windows 防火墙弹窗 | 否 |
| B. 查看器直接读 `~/.dsh/sessions` | 服务端零改动 | 改动最小 | 耦合 DSH 内部格式（仍在 rc）；含思考内容，越过隐私红线 | 否 |
| C. 服务端写事件流文件，查看器只读 | 服务端追加 JSONL，任意查看器 tail | 跨实例、跨重启；与哨兵"文件即 IPC"一致；视图可独立迭代 | 要定一份稳定 schema；需处理轮转与清理 | **采用** |
| D. MCP progress 通知 / MCP Apps | 走宿主原生 UI | 体验好 | `dsh_send` 默认立即返回，没有长期挂着的调用承载进度；宿主支持参差 | 不做（超出轻量定位） |

## 6. 数据契约：live 事件流

### 6.1 位置与开关

- 目录：`DSH_MCP_LIVE_DIR`，默认 `<dirname(STATE_FILE)>/live/`，与 `runs/`、`reviews/` 并列。
- 文件：`<live>/<conversation_id>/events.jsonl`，一行一个事件，UTF-8，`\n` 结尾。
  - 实现：按会话分**子目录**而不是扁平文件，因为现有的 `pruneDirTree` 只清理会话子目录；滚动出的 `events.jsonl.1` 也放在同一目录。
- 级别：`DSH_MCP_LIVE=off | meta | detail`。
  - `meta`（建议默认）：工具名、kind、状态、时间、计数、审批类型与是否提权。**不含**任何工具输入、命令、路径、正文。
  - `detail`：在 `meta` 之上加脱敏后的输入预览（命令、路径）、prompt 预览、正文增量摘要。与哨兵已有的暴露面同级。
  - `off`：不写。

> 实现：**默认改为 `detail`**。用途是看调用链，只有工具名看不出"读了哪个文件、跑了什么命令"；而哨兵默认已经落了完整正文和未截断的工具输入，`detail` 的脱敏短预览暴露面不超过它。`meta` 只写 `name` / `kind`，`title` 归 `detail`（§11 第 2 条已按此定）。

### 6.2 公共字段

```json
{"v":1,"ts":"2026-11-08T09:12:03.120Z","conv":"conv-…","run":"run-…","turn":3,"w":"<pid>:<hub-instance>","n":42,"type":"tool"}
```

- `v`：schema 版本，查看器遇到未知版本只展示公共字段。
- `w`：写者标识（服务进程 pid + 本次启动的随机实例 id），用于 takeover 交接与"写者是否还活着"的判定。
- `n`：写者内单调递增序号；跨写者排序以 `ts` 为准、`n` 只用于同写者去重。

### 6.3 事件类型

| type | 何时写 | `meta` 字段 | `detail` 追加 |
|---|---|---|---|
| `run.start` | 派活开始（`第 N 轮开始` 处） | `prompt_chars`、`permission`、`on_approval` | `prompt_preview`（≤200 字，脱敏） |
| `tool` | `tool_call` / `tool_call_update` 且**状态变化**时 | `tool_call_id`、`name`、`kind`、`status`、`elapsed_ms` | `title`、`input_preview`（≤300 字，脱敏） |
| `text` | 正文增量，节流（如每 2 秒或每 2KB 一条） | `chars_total` | `tail_preview`（最后 ≤200 字） |
| `approval` | 收到 `request_permission` | `mode`（auto-allow / auto-deny / ask / read-only-deny）、`escalation`（如 `danger-full-access`）、`approval_id`（ask 时） | `command_preview`、`reason` |
| `approval.decided` | `dsh_approval_decide` 或超时 | `approval_id`、`decision`、`by`（caller / timeout） | — |
| `interject` / `interrupt` | 插话、排队、中断 | `mode` | `text_preview` |
| `run.end` | 回合终止（成功 / 失败 / 取消） | `status`、`stop_reason`、`duration_ms`、`tool_count`、`auto_approvals`、`auto_escalations`、`usage` | — |
| `writer.hello` / `writer.bye` | 写者首次写某会话 / 释放或 takeover 交出 | `reason` | — |

实现与上表的差异（轻量化）：

- 新增 `conv.open`（`dsh_start` 建会话，带 cwd / 权限 / 模型）、`conv.close`（非 forget 的释放）、`run.queued`（`dsh_send(queue=true)` 入队，带位置）。`run.start` 带 `via`（send / queue / interject）与 `cwd`；`conv.open` / `run.queued` / `run.start` 带 `client`（MCP `initialize` 的 `clientInfo.name`），查看端据此把会话挂到"谁派的"下面。
- **不写** `text` 事件：正文只在哨兵里。
- **不写** `writer.hello` / `writer.bye`：每条事件已带 `w`，查看端看最后一个写者的 pid 是否存活即可判断"中断"（§6.5）。
- 排队被取消、插话等待超时、起不来的回合都补一条 `run.end`，查看端不会留下永远"排队 / 运行中"的回合。
- 新增 `usage`（0.6.2）：本回合 token 增量 `tokens`、会话累计 `session_tokens`、上下文占用 `context {used, window}`。数据来自 DSH 投影缓存的 `tokenUsage.totals` / `contextPressure`。真机实测 DSH 在回合中每个模型步之后就更新它，所以回合开始记基线，工具状态变化 / `usage_update` 时按 2 秒节流发增量，回合结束（git 快照之后）再发一条 `final: true` 的最终值。只是计数，属于 meta 级字段。
- 真机验证（DSH ACP）发现：`tool_call` **不带 `name`**，工具名在 `title` 里（`read` / `glob` / `write` / `pwsh`），`kind` 恒为 `other`。所以 `title` 是纯标识符时当作 `name` 写进 meta 级字段；带空格的 `title` 仍只进 detail。查看端把路径显示成相对会话目录的形式，并隐藏 `other`。

`tool` 只在状态变化时落盘，避免 DSH 的快照式重复更新刷屏；`tool_call_id` 让查看器原地替换同一工具的行，语义与 `dsh_read` 的"按 seq 替换"一致。

### 6.4 写入方式

- 与 `src/audit.mjs` 同一纪律：同步追加一行、所有异常吞掉、绝不抛到主流程。
- 单行上限（如 4KB），超出截断并标 `truncated: true`。
- 写入点集中到一个 `live.emit(conv, type, fields)`，由 `Conversation` 在现有钩子处调用：`onSessionUpdate`（工具、正文）、`onPermissionRequest` / `#recordAutoApproval` / `decideApproval`（审批）、回合起止、插话与中断。不在 `pushOut` 里泛化地写，以免把内部条目格式变成对外契约。
- 思考内容（`agent_thought_chunk`）**没有对应事件类型**，从结构上杜绝落盘；`DSH_MCP_SENTINEL_INCLUDE_REASONING` 不影响这里。

### 6.5 一致性与边界情况

- **takeover**：（实现）不写交接事件；查看器以每个回合 / 会话最后一条事件的 `w` 为准。旧写者被抢占后不会再有事件，迟到事件的窗口可以忽略。
- **崩溃**：没有 `run.end` 的 run 视为"可能仍在跑"。查看器用 `w` 里的 pid 判断写者是否存活，已死则显示为"中断（写者已退出）"，不靠心跳。
- **半行**：查看器必须容忍文件末尾的不完整行（写到一半被读）。
- **轮转**：单文件超过上限（如 5MB）滚动成 `.1`，只留一份。
- **清理**：启动时按 `SENTINEL_TTL_MS` 清理 `live/`（实现：在 `bin/` 里单独调用 `pruneLive`，不改 `Hub.pruneSentinels` 的返回形状）；会话被 forget（tombstone）时同步删除其 live 目录；测试残留清理（`src/residue.mjs`）也一并清 `live/<id>/`。

## 7. 查看端

两个查看端都只读 `live/` 与 `conversations.json`（取标题、cwd），彼此独立。CLI 沿用 `bin/dsh-any-agent.mjs` 已有的子命令分派（同 `team`），不新增依赖。

### 7.1 终端：`dsh-any-agent watch [conversation_id]`

tail 一个或全部会话，按会话分组、工具行原地刷新、审批高亮。适合在宿主旁开一个终端标签。

### 7.2 页面：`dsh-any-agent dashboard`

- **独立进程**，与 MCP 服务进程无关，所以 §5 方案 A 的端口、生命周期问题都不存在。
- 只绑定 `127.0.0.1`、随机端口；启动时生成一次性 token，放在打印出来的 URL 里；校验 `Host` 头防 DNS rebinding；只提供 GET。
- 单个内联静态 HTML，不依赖 CDN；数据走 SSE。
- 文件变更检测用 `fs.watch` + 定时轮询兜底（Windows 上 `fs.watch` 不可靠）。
- 视图：左侧会话列表（状态、cwd、标题、最近活动），右侧当前会话的时间线（轮次 → 工具 → 审批 → 结束摘要）。

## 8. 与现有机制的关系

| 机制 | 关系 |
|---|---|
| `dsh_read` | 不变。它服务 agent，live 服务用户；两者数据来源相同、出口不同。 |
| 哨兵 | 不变。哨兵是"回合完成"的闩锁和结果载体，live 是过程流；`run.end` 不替代哨兵。 |
| 审计日志 | 不变。审计回答"谁对会话做了什么"，live 回答"会话自己在做什么"。 |
| 写锁 | live 不持锁；查看器永远不触碰锁，也不会因为"在看"而影响 GUI 或 takeover。 |

## 9. 隐私与安全

1. 思考内容在 schema 里没有位置（§6.4）。
2. 所有字符串字段过 `sanitizeApprovalContext`，再按字段截断。
3. 默认 `meta` 级别不含工具输入；`detail` 需显式开启，文档里说明其暴露面与哨兵同级。
4. **为什么不做控制面**：待决审批、插话、中断的状态都在某个服务进程的内存里（`pendingApprovals` 等）。独立的 dashboard 进程要操作它们，只能再开一条反向通道（例如服务进程监视一个命令目录），这等于给"能写本地文件的任何东西"开了一个批准提权的口子，需要单独的鉴权设计，和"轻量"的定位不符。
5. dashboard 只监听回环地址，token 只在启动时打印，不落盘。

## 10. 测试

- 离线（`test/fake-acp.mjs` 驱动）：发 `tool_call` / `tool_call_update` / `request_permission`，断言 live 文件的行、级别过滤、脱敏、状态去重、单行截断。
- 思考内容回归：fake ACP 发 `agent_thought_chunk`，断言 live 文件里不出现其文本（任何级别）。
- 写入失败：live 目录不可写时派活仍成功。
- takeover / 崩溃：`writer.hello` / `writer.bye` 顺序；无 `run.end` 时查看器的判定。
- 轮转与 TTL 清理、forget 时删除。
- 查看器解析：半行、未知 `v`、未知 `type`。
- 所有测试设置 `DSH_MCP_LIVE_DIR` 到各自临时目录；live 用例不并发跑真实 DSH（与现有 live 测试同一规则）。

## 11. 开放问题

1. **DSH 子代理的工具调用会不会经 ACP 上报？** 未验证。若不上报，用户只能看到子代理这一层的"一个工具"，需要先拿真实会话测，再决定是否在视图里标注"子代理内部不可见"。
2. ~~`meta` 级别要不要写 `title`？~~ 已定：`meta` 只写 `name` / `kind`，`title` 归 `detail`。
3. ~~默认级别~~ 已定：默认 `detail`（理由见 §6.1）。
4. ~~正文要不要进 live~~ 已定：不进，正文只在哨兵里。
5. **多机 / 远程**：live 目录在本机；远程或云端会话的可见性不在本文范围。
6. 英文版文档待方案定稿后补。

## 12. 分期

| 阶段 | 内容 | 交付判定 |
|---|---|---|
| P1 | `live.emit` + 事件 schema v1 + 清理 + 测试；`dsh-any-agent watch` | 真实派活时另开终端能实时看到工具与审批 |
| P2 | `dsh-any-agent dashboard`（只读页面） | 浏览器里能同时看到两个客户端派出的会话 |

到 P2 为止。状态栏、宿主内嵌、控制面不排期（见 §2 非目标）。
