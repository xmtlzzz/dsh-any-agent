> 返回 [README](../../README.zh.md)

# 🔐 权限

| 档位 | 审批默认 | 用途 |
|---|---|---|
| `workspace-write`（服务端裸默认；`setup` 也默认写入它） | `auto-allow` | DSH 沙箱限制可写范围；越界请求默认放行，传 `on_approval=ask` 才挂起审批 |
| `danger-full-access` | `auto-allow` | 整机写权限，DSH 不再发审批。个人使用最省事：`dsh-any-agent-setup --yes --permission danger-full-access` 把它设成默认档，这本身就算机器侧允许；默认档是别的、只想让个别会话用时，另设 `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `read-only` | `auto-deny` | 分析不信任样本（恶意软件、来路不明 dump） |

`on_approval` 可选 `auto-allow` / `auto-deny` / `ask`（`ask` 会把审批挂起，交给 `dsh_approval_decide` 裁决）。

**信任模型：本服务只是派发层，权限跟着 DSH 和你自己的配置走。** 它不额外加一层权限判断：你在客户端配置里给了什么档位，DSH 就按什么档位跑；`danger-full-access` 下 DSH 根本不发审批，所以是全放行。这意味着：**谁能调用这些 MCP 工具，谁就能在你的机器上执行命令** —— 包括读了恶意网页或 issue、被提示注入的调用方 agent。个人在自己机器上用，接受这个风险通常没问题；处理不可信内容时用 `read-only`（唯一的硬边界：审批一律拒绝，传 `auto-allow` / `ask` 会被直接拒绝）。

**`auto-allow` 下 `workspace-write` 是软边界。** DSH 碰到沙箱挡住的操作（例如 Windows 上子进程管道被拦）会申请 `sandbox_permissions: danger-full-access`，`auto-allow` 会直接放行。默认值不变，但放行**不再是静默的**：每个回合结果都带 `auto_approvals_total`、`auto_escalations_total` 和最多 20 条脱敏后的 `auto_approvals` 摘要（工具、提权档、理由、命令预览）；审核单的证据与清单会点名"本轮有 N 次自动放行，其中 M 次提权"。要逐次把关，就用 `on_approval=ask` 新建会话。

**`read-only` 是强制边界，不只是默认值**：它固定使用 `auto-deny`；给只读会话传 `auto-allow` / `ask` 会在 `dsh_start` 被直接拒绝，审批层也会拒绝来自只读会话的任何权限请求。建会话/resume 后还会回读会话自己记录的权限档；只读档如果在 DSH 投影缓存刷盘窗口内仍读不到记录，会 **fail-closed 拒绝继续**，而不是只依赖审批层兜底。否则 profile 的 `defaultPreset` 加宽松审批策略可能放行写操作（对抗审计实测过）。

## 🧷 输入边界

- **`conversation_id` / `run_id` 是路径安全的单段 id**：它们会参与哨兵、审核、元数据与墓碑的路径拼接；服务只接受字母/数字/`._-` 组成的单段（最长 200），带分隔符或 `..` 的值在 `join()` 之前就被拒绝。覆盖 `dsh_get` 的哨兵回读与 `dsh_review` 的 `<状态目录>/reviews/<会话>/<run>.review.json` 写入。
- **可写档位下 `cwd` 不能是文件系统根目录**：`workspace-write` 选 `/` 或 `C:\` 会让沙箱根变成整个磁盘；家目录/根目录守卫会先解析 symlink，所以指向根目录或家目录的软链也会被拒绝。`danger-full-access` 仍需显式开启。
- **`title_hint` 最长 200 字**（schema + 运行时）：它会写进注册表与侧车，且每轮都会重复落盘。

## 🪟 会话在 DSH GUI 里的可见性

两件事，别混淆：

| | 取决于 | 现状 |
|---|---|---|
| **工作区是否生效** | 会话的 `cwd` | ✅ 永远正确。进程工作目录、文件落点、沙箱可写根都跟着它 |
| **GUI 里是否分组** | `~/.dsh/storages/workspace.json` 的 `sessionIds` | ⚠️ 本服务会登记，但**正在运行的 DSH 服务把注册表缓存在内存里**，外部改文件要重启 DSH 才生效 |

**"生效"有实测**（[`test/workspace-effect.mjs`](../../test/workspace-effect.mjs)）：桌面两个文件夹各开一个会话，派活时**不给任何路径**，结果两个会话各自把文件写进了自己的工作区、自报的当前目录正确、没有泄漏到 MCP 服务工作目录 / 家目录 / 临时目录 / 另一个工作区（24/24 全过）。

维护命令：

```bash
node bin/dsh-any-agent-workspaces.mjs --list                  # 查看注册表
node bin/dsh-any-agent-workspaces.mjs --backfill              # 扫描磁盘上的会话，全部补登记
node bin/dsh-any-agent-workspaces.mjs --prune-temp            # 清掉临时目录条目
node bin/dsh-any-agent-workspaces.mjs --prune-empty           # 清掉"无会话且路径已不存在"的工作区
node bin/dsh-any-agent-workspaces.mjs --purge-test-sessions   # 删测试会话（规则写得很死）
```

> ⚠️ 重启 DSH 之前**别在 GUI 里操作工作区**，否则服务会用内存状态把文件覆盖回去。

## 🕶️ 日志与隐私

默认**完全静默**，一个字节都不输出。

1. MCP 的 **stdout 是协议通道**，混进任何东西都会破坏报文；
2. 本服务被 Claude/Codex 拉起，它的 stderr 会进**对方的日志**；
3. DSH 子进程的 stderr 可能夹带模型输出（**含思考内容**），所以默认既不转发也不落盘。

| 级别 | 行为 |
|---|---|
| `silent`（默认） | 什么都不输出 |
| `info` | 只输出本服务自己的生命周期事件，**绝不含 DSH 的任何输出** |
| `debug` | 更细的本服务事件；仍不打印 DSH 输出 |
| `DSH_MCP_LOG_STDERR=1` | 额外转发 DSH 原始 stderr（**可能含思考内容**） |

**本服务不把思考内容写进自己的落盘物**；它只会落盘调用方离线收活/审核所需的正文，但从不落盘思考文本：

- 不写日志（默认静默）；状态文件与 `<状态目录>/meta/` 下的会话元数据侧车都只有元数据（id、cwd、权限、计数、标题提示），冒烟测试里有一条断言专门守注册表。
- **异步完成哨兵需要把正文写进文件**（否则调用方无法离线收活），载荷还包含用量与（已按审批规则脱敏的）工具输入，但 `result.thinking` 会被**剥掉**，并始终给出布尔 `thinking_omitted`。测试里专门验证了：即使请求 `reasoning=full`，哨兵里也不出现任何思考文本——而同一 run 在内存（`dsh_get`）里仍能看到。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可刻意打破这条。
- **审核记录是第二个刻意落盘的产物**：`<状态目录>/reviews/<会话id>/<run_id>.review.json` 保存裁决、理由/findings、清单与证据摘要。理由、findings、任务预览、证据**以及每个清单项**都走同一套凭证脱敏（清单会拼接 `result.error`），且**不含思考正文**；但它可能引用代码或路径，同样按敏感数据对待。
- 哨兵**与审核记录**默认 7 天后由启动清理删除（`DSH_MCP_SENTINEL_TTL_MS`，`0` 表示永久保留）。
- live 事件流（`<状态目录>/live/`，供 `watch` / `dashboard` 查看）默认带**脱敏后的**命令、路径与 prompt 预览，暴露面不超过哨兵；不含思考内容，同样按 7 天清理。不想落这些预览就设 `DSH_MCP_LIVE=meta`，完全不要就设 `off`。`dashboard` 只监听 `127.0.0.1`，要求一次性 token 并校验 Host 头，且是只读的。

> ⚠️ **DSH 自己会在 `~/.dsh/sessions` 写会话日志，而且其中包含完整 reasoning 文本**（即使 `reasoning=hide` 也照存）。那是 resume 的依据，不在本服务控制范围内；“思考不落盘”的绝对表述只适用于**本服务自己的**日志/哨兵/注册表。

### 📁 本服务写到磁盘上的东西

`<状态目录>` 默认是 `~/.dsh/.dsh-any-agent/`（跟着 `DSH_MCP_STATE` 走）。下面没有一处保存思考正文。

| 路径 | 内容 | 保留多久 | 怎么关 / 清 |
|---|---|---|---|
| `<状态目录>/conversations.json`、`meta/<会话id>.json` | 会话注册表与元数据：id、cwd、权限、计数、标题提示；不含正文 | 到会话被 forget | `dsh_release(forget=true)` |
| `<状态目录>/runs/<会话id>/<run_id>.json` | 完成哨兵：正文、用量、审核单、工具输入（均已脱敏） | 7 天（`DSH_MCP_SENTINEL_TTL_MS`） | `DSH_MCP_SENTINEL_TOOL_INPUTS=0` 只留工具输入的长度；读完可以直接删 |
| `<状态目录>/runs/<会话id>/<run_id>.running` | 回合进行中标记：run_id、任务预览（已脱敏）、本服务进程的 PID 与启动时刻 | 写出哨兵时删 | — |
| `<状态目录>/reviews/<会话id>/<run_id>.review.json` | 审核记录：裁决、理由、清单、证据摘要（已脱敏） | 同哨兵，7 天 | `DSH_MCP_REVIEW=off` 不自动出审核单 |
| `<状态目录>/live/<会话id>/events.jsonl` | live 事件流：事件类型、时间、工具名、客户端名；默认还带脱敏后的命令 / 路径 / prompt 预览 | 同哨兵，7 天；5 MB 滚动 | `DSH_MCP_LIVE=meta` 去掉预览，`off` 不写 |
| `<状态目录>/locks/<会话id>.json` | 写锁持有者登记：本服务与 DSH 子进程的 PID、cwd | 释放会话或进程退出后清 | — |
| `<状态目录>/worktrees/` | `isolation=worktree` 的会话目录（仓库检出 + DSH 的改动） | 干净的随 forget 删；有未提交改动的保留；分支始终保留 | 不用 `isolation=worktree`；`DSH_MCP_WORKTREES_DIR` 换位置 |
| `<状态目录>/daemon-<id>.json`、`daemon-<id>.log`（POSIX 上还有 `.sock`） | 常驻进程的 PID 与随机令牌（仅本用户可读）；它的 stderr | 信息文件随进程退出删；日志 10 MB 滚动成 `.1` | 不开 `DSH_MCP_DAEMON` |
| `$DSH_HOME/.dsh-any-agent-forgotten/<会话id>.json` | forget 墓碑：会话 id 与时间 | 会话文件不在了就在启动时清 | — |
| `DSH_MCP_AUDIT_FILE` 指向的文件 | 元数据审计：事件、id、裁决、计数；不含 prompt、正文、思考、工具输入 | 10 MB 滚动成 `.1` | 默认不写（不设该变量） |
| 客户端配置旁的 `.bak-dsh-<时间戳>` | `dsh-any-agent-setup` 写入前的原配置 | 每个配置文件最多 20 份（`DSH_MCP_BACKUP_KEEP`） | 手动删 |

DSH 那一侧（不归本服务管）：`~/.dsh/sessions` 里的会话日志（含完整思考，见上）；本服务还会把会话的工作区登记进 DSH 的 `workspace.json`，GUI 才看得到这些会话（`DSH_MCP_REGISTER_WORKSPACE=0` 关闭）。
