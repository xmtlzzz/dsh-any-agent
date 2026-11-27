> 返回 [README](../../README.zh.md)

# 🧩 兼容性矩阵

已验证的标准 ACP 区间为 `0.1.7 ~ 0.2.2`。

`dsh-any-agent` 依赖 DSH 的 ACP profile。团队模式随 DSH 版本选择实验版插件或会话团队模式。
升级 DSH 之前先对照这张表，并在升级后跑一遍 `dsh_doctor`。

## 版本

| dsh-any-agent | DSH | 状态 | 说明 |
|---|---|---|---|
| 0.8.1 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（全量套件、升级） | Windows（Node 22.19.0）全量测试 42 个离线套件（2069 项）全过，15 个真实模型套件中 14 个一次全过、`concurrency` 复跑 31/31 全过（共 429 项，可选 `acceptance` 因未配 IDA MCP 跳过）；并用真实模型通过了从 npm 0.8.0 原地升级到候选安装包的完整流程（重连取回原结果、幂等重试、继续原会话）。 |
| 0.7.9 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（常规 ACP、升级） | Windows 上用支持 roots 的 MCP 客户端从 npm 0.7.8 原地升级到 0.7.9 安装包。真实模型验证了重连后取回原结果、继续原会话，以及删除旧结果文件后用原键重试 send 和 interject。Codex CLI 使用候选安装包完成了真实模型派发、后台等待和跨连接幂等重试。 |
| 0.7.8 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（常规 ACP、升级） | Windows 上用支持 roots 的 MCP 客户端从 npm 0.7.7 原地升级至 0.7.8 安装包。使用真实模型验证了重连后取回旧回答、在同一会话继续下一轮，以及删除旧结果文件后用原幂等键调用 send 和 interject 均返回原回合 ID。 |
| 0.7.7 | `0.2.2-rc.5`（桌面版） | ✅ 已验证（常规 ACP、升级） | Windows 上用支持 roots 的测试客户端从 npm 0.7.6 升级到候选包，在桌面版 Node 24.21.0 下验证真实模型派发、重连、删除结果后幂等重试和继续原会话。另用 Codex CLI 0.162.0 加载同一版本安装包，通过模拟 ACP 验证派发和重连重试。 |
| 0.7.6 | `0.2.2-rc.5`（桌面版） | ✅ 已验证（常规 ACP） | Windows 使用 npm 已发布的 MCP 和桌面版自带的 Node 24.21.0。真实模型派发、临时工作区写入、重连取回结果、幂等重试和继续原测试会话均通过。离线回归通过。 |
| 0.7.6 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（ACP、升级） | Windows 使用真实模型从 npm 0.7.5 原地升级，验证了重连取结果、幂等重试和继续原会话 |
| 0.7.5 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（ACP、升级） | Windows 使用真实模型从 npm 0.7.4 原地升级，验证了旧结果读回、幂等重试和原会话继续派活 |
| 0.7.4 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（ACP、团队） | Windows 实测常规派活与从 npm 0.7.3 原地升级。桌面版 DSH 配合本地模拟模型接口验证团队默认关闭，开启后可同时使用原生任务板与普通子代理 |
| 0.7.3 | `0.2.2-rc.3`（桌面版） | ✅ 已验证（常规 ACP） | Windows 全量回归通过，真实模型通过安装和从 0.7.2 升级；IDA MCP 验收因缺少配置跳过。此组合需更新 MCP 才能使用新版团队模式 |
| 0.7.3 | `0.2.2-rc.1`（桌面版） | ✅ 已验证（升级） | Windows 使用真实模型，从 npm 已发布的 0.7.2 原地换装 0.7.3，验证了旧结果读回、幂等重试，以及在原会话完成新回合 |
| 0.7.2 | `0.2.2-rc.1`（桌面版） | ✅ 已验证（安装包工作流） | Windows 使用桌面版自带运行时和真实模型。Codex 验证了派活、取消客户端等待和重连后取结果。[发版验收记录](https://github.com/xmtlzzz/dsh-any-agent/pull/27)。[托管 CI](https://github.com/xmtlzzz/dsh-any-agent/actions/runs/43357420994)在 Windows、Linux 和 macOS 上用模拟 ACP 验证安装包 |
| 0.7.1 | `0.2.1-rc.5` | ✅ 已验证 | Windows 候选版用 npx 启动 DSH，Node 22.19。全量测试的 41 个离线套件全过，模型套件 `boundary` 有一条本地化错误断言失败，修复后复跑 46 项全过。可选的 `acceptance` 因 profile 未配 IDA MCP 跳过 |
| 0.7.0 | `0.2.2-rc.1`（桌面版） | ✅ 已验证（离线） | 2026-11-11 的 41 个离线套件（1892 项）全过。实测常驻进程模式时，Claude 桌面版在回合中途退出后重新打开，回合照常跑完并写出 `done` 哨兵 |
| 0.6.x | `0.2.1-rc.5` | ✅ 已验证 | 2026-11-10 用 0.6.9 全量套件实测（离线 + 需要模型，DSH 走 npx、Node 22.19）全过；`acceptance` 因 profile 未配 IDA MCP 跳过。其它 DSH 版本未针对 0.6.x 重新验证，最近一次实测见下面的 0.5.x 行 |
| 0.5.x | `0.1.7-rc.1` 至 `0.2.2-rc.1` | ✅ 已验证 | ACP 与实验版团队工具可用；团队模式需 `dsh-any-agent team on` |
| 0.5.x | `0.1.5-rc.1` | ⚠️ 部分可用 | ACP 基本路径可用；缺 team 包，团队模式会自动保持关闭 |
| 0.5.x | `0.2.1-rc.5` ~ `0.2.2-rc.1` | ✅ 已验证 | 2026-11-06 全量套件实测（0.2.1-rc.5 走 npm，0.2.2-rc.1 走桌面版自带运行时）；0.2.2 起 DSH 要求 Node ≥ 24.9 |
| 0.5.x | `0.2.3` 及以上 | ⚠️ 未验证 | ACP 的 `session/*` 面可能变化；team 包必须与 DSH 版本匹配。升级前先跑 `dsh_doctor` 和离线套件 |
| 0.4.x | `0.1.7-rc.1` | ✅ 已验证 | 团队模式当时默认开启 |
| 0.4.x | `0.1.5-rc.1` | ⚠️ 部分可用 | 无 team 包 |

> 实验性包（`dsh-experimental-agent-team`、`dsh-experimental-tool-agent-team`）**没有稳定性承诺**。
> 它们随 DSH 版本发布，不能跨大版本混用。

## 对外契约（调用方可以依赖的东西）

- **MCP stdio** 支持 `2026-07-28` 的逐请求元数据和服务发现，也兼容 `2024-11-05` 至 `2025-11-25` 的握手版本。使用 `2026-07-28` 时显式传入 `cwd`。旧版客户端可提供一个本地 MCP root。
- **哨兵 JSON**：顶层 `schema` 是格式版本，当前为 `1`（更早的版本没有这个字段，形状与 1 相同）。同一个 `schema` 内**只加字段**，不删、不改名、不改类型；调用方要忽略不认识的字段。需要做破坏性改动时 `schema` 加一，并在 CHANGELOG 里写明。
- **MCP 工具面**：工具名、参数名与类型、哪些必填、枚举值。新增工具、可选参数、枚举值是兼容的；删除、改类型、把参数改成必填、删枚举值是破坏性的，只在次版本号变化时做（1.0 之前），并写进 CHANGELOG。工具描述文本和返回的 `text` 不算契约（给模型读的，随时会改）。
- **live 事件流**：每条事件的 `v` 是格式版本，字段见 [live-view-design.md](live-view-design.md) §6。

`test/contract.mjs` 把前两项的形状和 `test/contract.snapshot.json` 对比，有任何差异就失败；哨兵有破坏性改动而 `schema` 没加一时，`node test/contract.mjs --update` 拒绝重写快照。

## 运行时要求

- **Node.js ≥ 22.15**（本服务自身；用到 `node:zlib` 的 `zstdDecompressSync` 读 DSH 会话头）；
- DSH 已安装，且 `~/.dsh` 下已有可用的 provider 与凭据（GUI 能正常聊天即可）；
- **DSH 自己的 Node 要求**（`engines.node`，0.2.2 起是 ≥ 24.9）由拉起 DSH 的运行时满足：
  用桌面版时是桌面版自带的运行时（无需本机 Node 24）；用 npm/npx 安装时是本服务所在的 node；

## DSH 从哪里来（自动识别，无需配置）

服务按下面的顺序自动找 DSH，**不需要手填 `DSH_BIN`**：

1. **DeepSeek Harness 桌面版**：Windows 读卸载注册表（HKCU/HKLM）里的安装目录，
   各平台再查默认安装位置。CLI 在 `resources/app.asar` 里，服务用桌面版自带的 Electron
   以 Node 模式（`ELECTRON_RUN_AS_NODE=1`）运行它 —— 与 GUI 用的是同一份 DSH、同一个运行时；
2. **npm 全局安装**（`npm i -g @deepseek-ai/dsh`）；
3. **npx 缓存**（随时可能被清掉，同等条件下最低优先）。

多个来源同时存在时：当前运行时能满足 `engines.node` 的优先 → 版本高的优先 → 桌面版 > 全局 > npx。
`DSH_BIN` 指定 DSH 入口文件，可指向 `.asar` 内部。`DSH_RUNTIME` 指定拉起 DSH 的可执行文件。两者都不能指向目录。
- `0.1.7-rc.1` 至 `0.2.2-rc.1` 使用实验版团队包。从 `0.2.2-rc.2` 起使用 DSH 的会话团队模式，详见[团队模式](team.md)。

## 怎么确认

```bash
dsh-any-agent --version          # 本服务版本
dsh-any-agent team status        # 团队开关与 profile
```

在 MCP 客户端里调用 `dsh_doctor`。标题会区分全部通过、有警告和存在失败项。只有存在失败项时，结构化结果的 `ok` 才为 `false`。

- `dsh_bin`：DSH 入口、版本、来源（桌面版 / npm 全局 / npx 缓存 / DSH_BIN）与运行时；入口落在 npx 缓存（`_npx/<hash>/`）时 **warn** —— 清缓存就会失效；
- `dsh_runtime`：实际拉起 DSH 的 Node 版本是否满足 `engines.node`。从 0.7.6 起，遇到无效的 `DSH_RUNTIME` 路径或确认版本不兼容时报告 **fail**。读不到版本时报告 **warn**；
- `dsh_desktop`：桌面版版本，与本服务所用 DSH 不一致时 **warn**（两边共用 `~/.dsh` 会话存储）；
- `dsh_candidates`：列出自动发现的备选安装。设置了 `DSH_BIN` 时会标明实际生效的路径。
- `dsh_version`：`verified` 为 ok。体检说明引用的是全量套件记录，表中也列出了 0.7.2 安装包工作流等专项验证。`partial` / `unsupported` / `unverified`（如 0.2.3+）/ 读不到版本为 **warn**；
- `registry_lock` 显示写锁状态和持有进程，`runs_dir` 检查结果目录能否写入和建立硬链接，`worktrees` 在占用超过 500 MiB 或扫描不完整时提示警告。
- `profile`：是否存在、是否漂移、路由来源；
- `daemon`：当前运行模式（常驻进程 `daemon`、直连 `direct`，以及因启动失败自动回退到直连时的原因和日志路径）；
- `workspace_sync`：检查注册表里已登记会话是否缺少 DSH 侧工作区同步条目（便于排查 GUI 列表可见性）；
- `team`：`on` / `off` / `requested but unavailable`（版本或 profile 缺少兼容的团队配置）；
- `config`：当前 permission、空闲回收、共享进程等生效值；
- `update`：本服务的版本和 npm 上的最新版比；有新版本时 **warn**（一天最多查一次，4 秒超时；离线算未知，不算问题；`DSH_MCP_UPDATE_CHECK=0` 不查）。

## 升级建议

1. 升级 DSH 前先记录 `dsh_doctor` 的输出；
2. 升级后重新跑 `node test/run.mjs`（离线）和 `node test/run.mjs --all`（需要 provider）；
3. 如果团队模式打不开，先看 `dsh-any-agent team status` 和 `dsh_doctor` 的 `team` 检查，再对照[团队 profile 配置](team.md)；
4. 默认跟随桌面版：桌面版升级后服务会在下次拉起 DSH 时自动用上新版本（发现结果缓存 60 秒）。
   确实需要固定某个版本时才显式设置 `DSH_BIN`。

换机恢复旧会话时，原工作区路径也要可用。从 0.7.6 起，目录不存在时会给出路径和恢复提示。可以恢复原目录，或在新路径调用 `dsh_start` 开新会话。
