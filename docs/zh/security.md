> 返回 [README](../../README.zh.md)

# 🔐 权限

| 档位 | 审批默认 | 用途 |
|---|---|---|
| `workspace-write`（默认） | `auto-deny` | DSH 沙箱限制可写范围，越界审批默认拒绝 |
| `danger-full-access` | `auto-allow` | 整机写权限，DSH 不再发审批。个人使用最省事：`dsh-any-agent-setup --yes --permission danger-full-access` 把它设成默认档，这本身就算机器侧允许；默认档是别的、只想让个别会话用时，另设 `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `read-only` | `auto-deny` | 分析不信任样本（恶意软件、来路不明 dump） |

`DSH_MCP_APPROVAL` 同时是本机的默认审批策略和上限，按从严到宽依次为 `auto-deny`、`ask`、`auto-allow`。调用方可以传更严格的 `on_approval`。恢复已有会话时也会应用当前上限。设 `DSH_MCP_APPROVAL=ask` 后重连，可用 `dsh_approval_decide` 逐条裁决。

DSH 按会话档位应用沙箱。启用 `danger-full-access` 后，命令以当前用户权限执行，DSH 会跳过审批。检查不可信内容时用 `read-only`。

显式启用 `auto-allow` 后，DSH 遇到沙箱拦截时可以申请并获得 `sandbox_permissions: danger-full-access`。回合结果记录 `auto_approvals_total`、`auto_escalations_total` 和最多 20 条脱敏审批摘要。审核单会列出放行和提权的次数。

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
| `<状态目录>/runs/<会话id>/<run_id>.json` | 完成哨兵：正文、用量、审核单、工具输入（均已脱敏） | 7 天（`DSH_MCP_SENTINEL_TTL_MS`） | `DSH_MCP_SENTINEL_TOOL_INPUTS=0` 只留工具输入的长度（自动放行审批的命令预览也去掉）；读完可以直接删 |
| `<状态目录>/runs/<会话id>/<run_id>.running` | 接单回执：run ID、调用方幂等键、脱敏任务预览、排队或执行状态和所属进程 | 写出哨兵时删除 | 状态目录应位于支持硬链接的文件系统 |
| `<状态目录>/reviews/<会话id>/<run_id>.review.json` | 审核记录：裁决、理由、清单、证据摘要（已脱敏） | 同哨兵，7 天 | `DSH_MCP_REVIEW=off` 不自动出审核单 |
| `<状态目录>/live/<会话id>/events.jsonl` | live 事件流：事件类型、时间、工具名、客户端名；默认还带脱敏后的命令 / 路径 / prompt 预览 | 同哨兵，7 天；5 MB 滚动 | `DSH_MCP_LIVE=meta` 去掉预览，`off` 不写 |
| `<状态目录>/locks/<会话id>.json` | 写锁持有者登记：本服务与 DSH 子进程的 PID、cwd | 释放会话或进程退出后清 | — |
| `<状态目录>/worktrees/` | `isolation=worktree` 的会话目录（仓库检出 + DSH 的改动） | 干净的随 forget 删；有未提交改动的保留；分支始终保留 | 不用 `isolation=worktree`；`DSH_MCP_WORKTREES_DIR` 换位置 |
| `<状态目录>/daemon-<id>.json`、`daemon-<id>.log`（POSIX 上还有 `.sock`） | 常驻进程的 PID 与随机令牌（仅本用户可读）；它的 stderr | 信息文件随进程退出删；日志 10 MB 滚动成 `.1` | 不开 `DSH_MCP_DAEMON` |
| `$DSH_HOME/.dsh-any-agent-forgotten/<会话id>.json` | forget 墓碑：会话 id 与时间 | 会话文件不在了就在启动时清 | — |
| `DSH_MCP_AUDIT_FILE` 指向的文件 | 元数据审计：事件、id、裁决、计数；不含 prompt、正文、思考、工具输入 | 10 MB 滚动成 `.1` | 默认不写（不设该变量） |
| `<状态目录>/update-check.json` | `dsh_doctor` 上次从 npm 查到的最新版本号与时间 | 24 小时后重查覆盖 | `DSH_MCP_UPDATE_CHECK=0`（同时不再联网） |
| 客户端配置旁的 `.bak-dsh-<时间戳>` | `dsh-any-agent-setup` 写入前的原配置 | 每个配置文件最多 20 份（`DSH_MCP_BACKUP_KEEP`） | 手动删 |

联网：本服务自己只在调用 `dsh_doctor` 时访问一次 `registry.npmjs.org`（查本包的最新版本号，请求里没有任何用户数据；`DSH_MCP_UPDATE_CHECK=0` 关闭）。模型请求由 DSH 发出，不经过本服务。

DSH 那一侧（不归本服务管）：`~/.dsh/sessions` 里的会话日志（含完整思考，见上）；本服务还会把会话的工作区登记进 DSH 的 `workspace.json`，GUI 才看得到这些会话（`DSH_MCP_REGISTER_WORKSPACE=0` 关闭）。
