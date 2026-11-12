> 返回 [README](../../README.zh.md)

## 📋 用法：先派活，回头再验收

MCP 工具调用是**阻塞**的，所以 `dsh_send` **默认就不阻塞**（`wait=false`）：派完立刻拿到收据，回合在后台跑，跑完由哨兵文件唤醒你。整个流程是这样：

```text
1. dsh_send(conversation_id, prompt, wait=false)
     → { run_id: "run-abc123", background: true }        # 不等回合跑完就返回

2. …继续做你自己的事（实测：期间在另一个会话上跑完了一整个回合）…

3. dsh_status(conversation_id)
     → state=running | elapsed=3.5s | current_tool=pwsh | out=37 chars

4. dsh_read(conversation_id, cursor)                      # 中途偷看
     → [我] … | [轮次] 第 1 轮开始 | [工具] pwsh [in_progress]

5. dsh_get(conversation_id, run_id)                       # 验收
     → status=done, elapsed=20.3s, 完整答复,
       review: { status: "pending", checklist: [...], submit: { tool: "dsh_review", ... } }

6. dsh_review(conversation_id, run_id, verdict="pass", notes="已看 diff 并跑过测试")
     → review: { status: "pass", reviewed_at: "...", review_file: "..." }
```

**结果返回 ≠ 已完成。** 每个结果都带一张 `review` 审核单：根据这一轮的情况生成核验清单（有没有改文件、回合是否正常结束、用了哪些工具），并附上证据摘要。调用方应该用自己的工具独立核验至少一项关键声明（读改动的文件、看 `git diff`、跑相关测试），再用 `dsh_review` 提交裁决。默认 `advisory` **不阻塞**下一次 `dsh_send`，它的作用是把"先审核"放进返回载荷本身，而不是依赖调用方记得。`fail` / `partial` 必须给 `notes` 或 `findings`。审核不通过**不会**自动回灌给 DSH——要不要再派修复回合由调用方自己决定。

`run_id` 是验收凭据。在哨兵保留期内，即使服务重启，也可以用 `run_id` 或原 `client_run_id` 调用 `dsh_get` 查询。服务接单前先落盘收据元数据。排队正文留在内存，服务重启后，未执行任务会写出取消哨兵，已开跑的回合会写出中断哨兵。用原幂等键重试会取回原结果。确认需要重新执行时使用新键。

宿主取消阻塞中的 MCP 请求时，服务停止等待和发送进度。已派发的回合会继续运行并写出哨兵。要停止回合，请调用 `dsh_interrupt`。

## 🔔 用法：跑完自动通知（不轮询）

`wait=false` 除了 `run_id`，还会返回 **`sentinel_file`**（哨兵文件路径）以及 **`sentinel_file_posix`**（Bash/MSYS 形式，**直接用它，别无手工转换**——转错了等待任务会一直挂到超时）。回合结束时——**无论成功、失败还是被取消**——本服务都会往这个路径**原子写出**一个含最终 `status`、`result` 与**审核单**（`result.review`）的小文件。于是你不用轮询、也不用傻等：**用你自己宿主（Claude/Codex）的后台任务等这个文件出现即可，文件一到就会唤醒你。**

```bash
# sent="$sentinel_file_posix"   ← 直接用工具返回里那个字段
sent='/c/Users/you/.dsh/.dsh-any-agent/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 7500 ))          # 回合总时长上限（默认 2h）+ 5min；收据里的命令已按实际上限算好
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # 后台任务退出 → 宿主唤醒你 → 读文件收活
```

Windows 宿主上 Git Bash 不可用（或会挂住）时，用 PowerShell 等原生路径 `sentinel_file`。在 Windows 上，后台收据的 structured 里有拼好、已转义的 **`sentinel_wait_powershell`**，直接用它：

```powershell
$f='C:\Users\you\.dsh\.dsh-any-agent\runs\<conversation_id>\<run_id>.json'   # 路径里的 ' 写成 ''
$dl=(Get-Date).AddSeconds(7500)
while(-not (Test-Path -LiteralPath $f)){ if((Get-Date) -gt $dl){ 'TIMEOUT'; exit 1 }; Start-Sleep -Seconds 2 }
'DONE'
```

文件出现后：**直接读它**即得 `status` 和 `result`（推荐——不受内存窗口限制、还扛服务重启），或用 `dsh_get(conversation_id, run_id)` 验收。一个回合用了很多工具时，完整结果（含每个工具的完整输入）可能超过客户端单次工具结果的上限；这时给 `dsh_get` 传 `max_chars`（如 8000）：预算**同时**作用于 text 与 structured，正文截断、工具只留名字/状态与 `input_chars`，完整版本始终在哨兵文件里。

设计要点（尤其**多会话并发**）：

- **不串台**：哨兵路径为 `<状态目录>/runs/<conversation_id>/<run_id>.json`，按会话分目录。`run_id` 的序号是每会话独立计数的，不同会话在同一毫秒可能生成同名 `run_id`——分目录后各写各的，绝不互相覆盖。每个 run 起一个独立后台任务即可，各自完成、各自唤醒。
- **闩锁语义**：文件写一次并保留。即便 run 在你启动等待任务**之前**就已完成，`[ -f ]` 也立刻为真，不会漏。
- **原子落地**：`tmp` + `rename`，文件一旦存在内容必然完整；每个 run 用独立 tmp，并发写互不干扰。
- **完成不靠推送**："跑完通知"完全由这个哨兵文件 + 你的后台等待任务实现，本服务不为此发 MCP 通知。唯一会发的通知是进度：调用带 `progressToken` 时，阻塞中的调用（`dsh_send(wait=true)`、`dsh_interject`）每 5 秒回报一次已等时长、当前工具名和本轮已产出字数，不含命令、路径或正文。
- **审核不随哨兵消失**：`result.review` 随结果一起写入，所以只读文件的调用方也能看到清单。之后 `dsh_review` 会**原子重写**这个审核块（`status` → `pass`/`partial`/`fail`，并写入 `notes`、`reviewed_at`、`review_file`），闩锁文件本身始终存在。审核记录在 `<状态目录>/reviews/` 下，和哨兵一样按 7 天 TTL 清理。
- **★ 哨兵里没有思考内容**：载荷含正文、思考**统计**、用量与（已脱敏的）工具输入，但没有思考正文；`result.thinking` 会被剥掉，并始终给出布尔 `thinking_omitted`（剥离了为 `true`，本来没有为 `false`）——本服务自己的落盘物里不写思考。`dsh_get(run_id)` 在内存里仍能看到它（记录还在时）。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可以故意打破这条保证。注意：**DSH 自己的会话日志仍含思考**，见“日志与隐私”。

> 清理：哨兵与审核记录内含完整正文/理由，所以服务**启动时会清掉超过 7 天的哨兵与审核记录**（用 `DSH_MCP_SENTINEL_TTL_MS` 调；`0` 关闭）。等待任务消费后仍建议自行 `rm`。

## 🧵 用法：同时控制多个会话

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵进行中(已跑9s, 工具=pwsh, 本轮输出=40字) | cwd=…
     - … | id=33427096… | 🔵进行中(已跑8s, 本轮输出=34字)        | cwd=…
2. dsh_read(id,  cursor=0)      # 读第一个，记下 cursor
3. dsh_read(id2, cursor=0)      # 切到第二个
4. dsh_read(id,  cursor=<上次>) # 切回来；上次之后被追加过的条目会再次出现（按 seq 替换全文）
```

## 🌿 用法：和调用方同时改同一个仓库（worktree 隔离）

DSH 在后台跑的时候，你（调用方）多半还在同一个仓库里继续改文件。两边改同一批文件会互相覆盖，`workspace_changed` 和审核单的证据里也会混进对方的改动。这时用 `dsh_start(isolation="worktree")`：

- 服务为 `cwd` 所在的 git 仓库新建一个 worktree（放在本服务的状态目录下，不在仓库里）和分支 `dsh/<时间>-<随机>`，会话在里面干活；`cwd` 是子目录时映射到 worktree 里的同一子目录；
- 基于主检出当前的 **HEAD**：主检出里**未提交**的改动不会带过去（建会话的返回里会提示）；
- 新 worktree 里没有 `node_modules`、虚拟环境、构建产物，DSH 往往要先装依赖 —— 这是默认不开的原因；
- 改动留在那个分支上，**由你审核后自己合并**，服务从不自动合并；
- `dsh_release(forget=true)` 时 worktree 干净就删目录（分支保留，提交不会丢）；有未提交的改动就保留并告诉你路径；
- 出于安全，建、查、删 worktree 时**不跑仓库自带的 git 钩子和 filter 驱动**（`smudge` / `clean`；仓库可能不可信），所以 husky 这类在 checkout 时装东西的钩子也不会跑，Git LFS 管理的文件在 worktree 里只是指针文件（需要的话 DSH 可以在 worktree 里自己 `git lfs pull`）。
## 👀 旁路查看：派出去的活在干什么

调用方 agent 能 `dsh_read`，但坐在客户端前的你通常只看到一次 `dsh_send`。服务会把每个会话的活动写成 live 事件流（`<状态目录>/live/<会话id>/events.jsonl`），你可以**不经过 agent**直接看调用链：

```text
客户端（谁派的） → 会话 → 回合（派活 / 排队 / 插话） → 工具调用 · 审批
```

```bash
dsh-any-agent watch
```

```bash
dsh-any-agent dashboard
```

- `watch [会话id前缀]`：在终端里实时显示调用链（`--once` 打印一次就退出，`--runs N` 每个会话显示最近几轮）。
- `dashboard`：起一个**只读**本地页面，打印出带一次性 token 的地址（只监听 `127.0.0.1`，校验 Host 头，没有任何能改变状态的按钮）；加 `--open` 直接用默认浏览器打开。
- **界面语言**：两者默认跟随系统语言（`DSH_MCP_LANG` / `LANG` / 系统区域设置），`--lang zh|en` 可指定；网页右上角也能切换，选择会被记住。
- 两者都是独立进程：不启动服务、不碰写锁、不连 DSH，所有客户端（Claude Code、Codex、Cursor…）派出去的会话都能一起看到。
- 写者进程已退出而回合没有结束的，显示为"中断"。
- **token 用量**：每个回合的输入 / 输出 / 缓存读写增量、会话累计和上下文窗口占用，回合进行中就会更新（数字取自 DSH 自己的会话记录）。dashboard 右栏有"Token 消耗"面板和每回合用量图。
- 级别用 `DSH_MCP_LIVE` 调：`detail`（默认，带脱敏后的命令/路径/prompt 预览）、`meta`（只有工具名、状态、计时、审批类型）、`off`。**思考内容在任何级别都不写**。事件文件和哨兵同一个 7 天 TTL；`dsh_release(forget=true)` 会一并删掉。

## 🤫 思考内容：默认隐藏

DSH 在模型层就把思考与正文分开，ACP 又把它们做成**两条独立流**。本服务默认隐藏思考内容，只返回**统计**（字数、耗时、段数）——调用方知道它想过，但不必为思考内容付上下文成本。

- `reasoning=hide`（默认）—— 丢弃内容，返回统计
- `reasoning=marker` / `summary` / `full` —— 逐步放出更多内容（注意上下文预算）
- `dsh_read(include_reasoning=true)` —— 只返回**当前正在跑那一轮**的实时思考；不进缓冲，回合结束即丢弃
