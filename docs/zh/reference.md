> 返回 [README](../../README.zh.md)

# ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动探测（桌面版 → npm 全局 → npx 缓存） | 显式指定 `@deepseek-ai/dsh/lib/bin.js` 路径（可指进桌面版 `app.asar` 内部） |
| `DSH_RUNTIME` | 自动 | 显式指定拉起 DSH 的可执行文件（如一个 Node 24）。配合 `DSH_BIN` 使用，或单独设置时作用于自动发现的 npm 全局 / npx 版 DSH（并按它的 Node 版本重新判定 `engines.node`）；桌面版始终用其自带运行时（asar 只有它读得了）。不设时：桌面版用自带运行时，其余用本服务的 node |
| `DSH_MCP_PROFILE` | `dsh-mcp`（团队开启时 `dsh-team`） | 驱动用的 DSH profile；显式设置优先 |
| `DSH_MCP_TEAM` | `0`（关闭） | `1`/`0` 覆盖 `dsh-any-agent team on/off` 的设置。开启后默认选择 `dsh-team`。DSH `0.2.2-rc.2` 起按会话启用团队工具；`dsh_send(team=false)` 只用于关闭实验版的单次提示 |
| `DSH_MCP_SETTINGS` | `$DSH_HOME/.dsh-any-agent/settings.json` | 团队开关的设置文件（`dsh-any-agent team on/off` 写它） |
| `DSH_HOME` | `~/.dsh` | DSH 主目录。**默认就用本机用户自己的**，凭据与会话历史因此与 GUI 共用。指向别处即隔离环境（那就得自己准备那个目录的凭据与 profile） |
| `DSH_MCP_BOOTSTRAP` | 开 | `0` 关闭首启 profile 自动创建/同步（关掉后只驱动已存在的 profile，不写任何文件） |
| `DSH_MCP_ROUTE_SOURCE` | 自动 | 复制模型路由的来源 profile 名；`__home__` 表示只认 `$DSH_HOME/cordis.patch.yml` |
| `DSH_MCP_STATE` | `$DSH_HOME/.dsh-any-agent/conversations.json` | 会话注册表，跨重启存活。同一台机器上的多个服务进程共用该文件时会依次合并写入。支持带 BOM 的 UTF-8。读取失败时会保留原件并报告路径，可修复文件或从备份恢复后重连。旧版 `<仓库>/.state` 会在首次启动时自动迁移一次 |
| `DSH_MCP_RUNS_DIR` | `<状态文件同目录>/runs` | 异步完成哨兵的根目录（`<此目录>/<会话id>/<run_id>.json`） |
| `DSH_MCP_LOCKS_DIR` | `<状态文件同目录>/locks` | 写锁"持有者登记"的目录。⚠️ **多个实例必须指向同一个值**，否则彼此看不见对方的持锁登记、会把对方误判成"无法识别的持有者（GUI）"而拒绝抢占 |
| `DSH_MCP_APPROVAL` | `workspace-write` 和 `read-only` 为 `auto-deny` | 本机审批默认值和上限。设成 `ask` 可逐条裁决越界请求。只读始终拒绝审批。 |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | 待决 `ask` 审批的等待上限；超时按拒绝处理 |
| `DSH_MCP_FORGOTTEN_DIR` | `$DSH_HOME/.dsh-any-agent-forgotten` | `dsh_release(forget=true)` 写的墓碑目录 |
| `DSH_MCP_LOCK_STALE_MS` | `90000`（3× `REAP_INTERVAL_MS`，下限 30 秒） | 持锁登记多久没续心跳就算"持有者失联"（`dsh_takeover` 核实进程身份后可接管）；改回收间隔会改变推导出的默认值 |
| `DSH_MCP_IDLE_TTL_MS` | `600000`（10 分钟） | 会话空闲多久回收其 DSH 进程。**默认 10 分钟**：回收后内存释放，下次派活自动 resume（对话不丢），代价是写锁会空出来、GUI 可能拿走。设 `0` = 永不回收（一直握锁，代价是每会话常驻 300–480MB）；需要长期握锁的个别会话用 `dsh_start(keep_alive=true)` |
| `DSH_MCP_MAX_LIVE` | `4`（最坏约 1.2–1.9GB） | ★ **最多同时保活几个会话进程**（`0` = 不限）。共享宿主按 PID 计数。超标时回收**最久没用过**的（**在跑的回合绝不回收**）。`keep_alive=true` 的会话不受本上限约束。用完想立刻放掉空闲会话：`dsh_release(all=true)`（busy 回合默认跳过，`force=true` 才中断） |
| `DSH_MCP_MAX_RSS_MB` | `0`（关闭） | 按 PID 统计子进程 RSS（MB）。超过预算时，仅回收所有会话都空闲的进程，按组内最近一次使用时间从早到晚选择。含 `keep_alive` 会话的组排在最后。 |
| `DSH_MCP_CHILD_MAX_OLD_SPACE_MB` | `0`（不设） | 给每个 DSH 子进程追加 `--max-old-space-size`，兜底失控的上下文。设太小会让长会话 OOM |
| `DSH_MCP_SHARED_PROCESS` | `1`（开启） | **默认开启**：同 `(cwd, permission)` 的会话共享一个 ACP 进程。显著省内存与冷启动（实测第二个会话 `session/new` 约 300ms，独立进程约 4s），`dsh_doctor` 的 RSS 也按 PID 去重。代价：进程崩溃会连坐同组会话（统一写 error 哨兵，之后各自 resume），所以 `dsh_takeover` 杀这类进程时要求 `force=true`。设 `0` 回到"一会话一进程" |
| `DSH_MCP_AUDIT_FILE` | 空（关闭） | 元数据审计 JSONL 路径。只记事件、会话/回合 ID、决定与计数；**不记** prompt、正文、思考、工具输入。10MB 滚动到 `.1` |
| `DSH_MCP_LIST_PROBE_TTL_MS` | `10000` | `dsh_list` 磁盘探测结果的缓存时长（探测要 spawn 一个 DSH 进程，实测约 1 秒） |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000`（7 天） | 启动时清理超过此时长的哨兵、幂等收据和审核记录。`0` 关闭清理 |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | 未设置 | 设为 `1` 后，回合返回的 `result.thinking` 会存入临时 `.running` 结果检查点和完成哨兵。答复、错误、标题和工具输入仍会脱敏。 |
| `DSH_MCP_UPDATE_CHECK` | `1` | `dsh_doctor` 是否去 npm 查新版本（只在调用 doctor 时、只请求本包的 latest、最多 4 秒、缓存 24 小时）。`0` = 不联网 |
| `DSH_MCP_SENTINEL_TOOL_INPUTS` | `1` | `0` = 哨兵里不写工具输入（命令、路径、写入的文件内容），每个工具只留名字、状态与 `input_chars`，自动放行审批摘要也去掉 `command_preview`。内存里的 `dsh_get` 不受影响 |
| `DSH_MCP_REVIEW` | `advisory` | 调用方审核策略。`advisory`（默认）给每个结果/哨兵附审核单（清单 + 证据 + `dsh_review` 入口），**但不阻塞**后续派活；`off` 关闭自动审核单。单会话/单次派活可用 `review` 参数覆盖 |
| `DSH_MCP_REVIEWS_DIR` | `<状态文件同目录>/reviews` | 审核裁决的落盘目录（`<此目录>/<会话id>/<run_id>.review.json`）。不可写会让服务启动时明确失败 |
| `DSH_MCP_LIVE` | `detail` | live 事件流级别（`watch` / `dashboard` 的数据源）。`detail` 带脱敏后的 prompt / 命令 / 路径预览；`meta` 只有工具名、状态、计时、审批类型；`off` 不写。思考内容任何级别都不写 |
| `DSH_MCP_LIVE_DIR` | `<状态文件同目录>/live` | live 事件流目录（`<此目录>/<会话id>/events.jsonl`，5MB 滚动到 `.1`）。写不进去只会静默跳过，不影响派活；按 `DSH_MCP_SENTINEL_TTL_MS` 清理 |
| `DSH_MCP_LANG` | 跟随系统 | 语言：`zh` 或 `en`。管两处 —— `watch` / `dashboard` 的界面，以及调用方看到的文字：工具标题、工具描述、参数描述、服务说明、工具返回正文与报错信息。未设置时依次看 `LC_ALL` / `LC_MESSAGES` / `LANG`、系统区域设置；命令行 `--lang` 优先于它 |
| `DSH_MCP_PERMISSION` | `workspace-write` | `dsh_start` 未指定时的权限档。将其设为 `danger-full-access` 本身即表示机器侧允许完全权限；默认档是其他档位、仅需个别会话使用完全权限时，另设 `DSH_MCP_ALLOW_FULL_ACCESS=1` |
| `DSH_MCP_ALLOW_FULL_ACCESS` | `0` | 是否允许 `permission=danger-full-access`。默认拒绝：该档把整机写权限交给调用方 |
| `DSH_MCP_REASONING_EFFORT` | `max` | 默认思考深度 |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0`（不设超时） | **仅 `wait=true` 时**的等待上限；到期只转后台，不取消回合 |
| `DSH_MCP_WATCHDOG_AFTER_MS` | `900000`（15 分钟） | 回合开始多久后看门狗才开始判"卡住"。`0` = 关掉卡住判定 |
| `DSH_MCP_WATCHDOG_GRACE_MS` | `5000`（5 秒） | 看门狗发出取消后等待 ACP 响应的时间。超时会隔离并终止该 ACP 进程，记录 `watchdog_timeout`。同一共享进程上的其他回合也会中断。 |
| `DSH_MCP_STALL_MS` | `600000`（10 分钟） | 多久没有任何进展（DSH 推来的正文、思考、工具状态、用量更新）算卡住；有工具在执行时放大 3 倍，等调用方裁决审批时不判。卡住就发 `session/cancel`（同 `dsh_interrupt`），结果带 `watchdog` |
| `DSH_MCP_TURN_MAX_MS` | `7200000`（2 小时） | 单个回合的总时长上限，**不看进展**（拦得住陷在循环里、一直在输出的回合）。`0` = 不设上限 |
| `DSH_MCP_DAEMON` | 运行时默认关（`setup` 默认写入 `1`） | `1` = 常驻进程模式：客户端拉起的进程只做转发，会话、DSH 进程和正在跑的回合都在一个 detached 的常驻进程里，客户端关掉、重连或崩溃都不会打断回合。同一配置（`DSH_*` 与语言变量、名字以 `_KEY`、`_TOKEN` 或 `_SECRET` 结尾的凭据变量如 `DEEPSEEK_API_KEY` 或 profile 里 `apiKeyEnv` 指的变量、`*_PROXY`，以及 `dsh-any-agent team on/off` 的设置）的客户端共用一个常驻进程，DSH 继承的是它的环境；凭据放在别的名字的变量里不在此列，请改名或别开这个模式。`dsh-any-agent-setup --yes` 默认写入 `DSH_MCP_DAEMON=1`，加 `--no-daemon` 退回直连 stdio（`0`），可用 `dsh-any-agent daemon status|stop` 查看与停止 |
| `DSH_MCP_DAEMON_IGNORE_ENV` | 空 | 逗号分隔的变量名或含 `*` 的模式（如 `FOO_TOKEN,BAR_*`）。排除这些变量后复用常驻进程；常见 IDE 会话令牌默认忽略。仅排除无关变量，凭据和代理通常应参与身份区分。 |
| `DSH_MCP_DAEMON_IDLE_MS` | `600000`（10 分钟） | 常驻进程在没有客户端连着、也没有回合在跑时，空闲多久后自己退出。`0` = 不自动退出 |
| `DSH_MCP_WORKTREES_DIR` | `<状态目录>/worktrees` | `dsh_start(isolation="worktree")` 建的 worktree 放在哪里 |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_GIT_STATUS` | 开 | `0` 关闭每回合的 `git status` 摘要。快照在 DSH 沙箱外运行，从 PATH 的绝对路径条目选择 Git，并关闭 fsmonitor 和仓库配置的过滤器 |
| `DSH_MCP_BACKUP_KEEP` | `20` | 每个客户端配置最多保留多少份 `.bak-dsh-*`（尽力轮转） |
| `DSH_MCP_REQUEST_TIMEOUT_MS` | `60000` | ACP 通道单请求超时（initialize、session/new 等） |
| `DSH_MCP_REAP_INTERVAL_MS` | `30000` | 空闲回收器多久检查一次。低于安全下限的值会回落到默认值 |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | 未设置 | `1` 才转发 DSH 原始 stderr |
