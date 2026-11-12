> 返回 [README](../../README.zh.md)

# 🧩 兼容性矩阵

`dsh-any-agent` 依赖 DSH 的 ACP profile；团队模式还依赖 DSH 0.1.7 起才有的实验性 Agent Teams 包。
升级 DSH 之前先对照这张表，并在升级后跑一遍 `dsh_doctor`。

## 版本

| dsh-any-agent | DSH | 状态 | 说明 |
|---|---|---|---|
| 0.7.1 | `0.2.1-rc.5` | ✅ 已验证 | Windows 候选版用 npx 启动 DSH，Node 22.19。全量测试的 41 个离线套件全过，模型套件 `boundary` 有一条本地化错误断言失败，修复后复跑 46 项全过。可选的 `acceptance` 因 profile 未配 IDA MCP 跳过 |
| 0.7.0 | `0.2.2-rc.1`（桌面版） | ✅ 已验证（离线） | 2026-11-11 的 41 个离线套件（1892 项）全过。实测常驻进程模式时，Claude 桌面版在回合中途退出后重新打开，回合照常跑完并写出 `done` 哨兵 |
| 0.6.x | `0.2.1-rc.5` | ✅ 已验证 | 2026-11-10 用 0.6.9 全量套件实测（离线 + 需要模型，DSH 走 npx、Node 22.19）全过；`acceptance` 因 profile 未配 IDA MCP 跳过。其它 DSH 版本未针对 0.6.x 重新验证，最近一次实测见下面的 0.5.x 行 |
| 0.5.x | `0.1.7-rc.1` 及以上 | ✅ 已验证 | ACP + 实验性 Agent Teams 包均可用；团队模式需 `dsh-any-agent team on` |
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
`DSH_BIN`（可指进 `.asar` 内部）与 `DSH_RUNTIME`（指定拉起 DSH 的可执行文件）只作显式覆盖。
- 团队模式额外要求 DSH `>= 0.1.7-0`，并且 profile 里真的挂上了两个 team 包。

## 怎么确认

```bash
dsh-any-agent --version          # 本服务版本
dsh-any-agent team status        # 团队开关与 profile
```

在 MCP 客户端里调用 `dsh_doctor`，重点看：

- `dsh_bin`：DSH 入口、版本、来源（桌面版 / npm 全局 / npx 缓存 / DSH_BIN）与运行时；入口落在 npx 缓存（`_npx/<hash>/`）时 **warn** —— 清缓存就会失效；
- `dsh_runtime`：拉起 DSH 的运行时的 Node 版本是否满足 DSH 的 `engines.node`，不满足时 **warn**；
- `dsh_desktop`：桌面版版本，与本服务所用 DSH 不一致时 **warn**（两边共用 `~/.dsh` 会话存储）；
- `dsh_candidates`：发现的全部 DSH 来源，以及自动选中了哪一个；
- `dsh_version`：按上表给版本定档 —— `verified` 为 ok（说明里会区分：当前发布线重跑过全量套件的版本，还是最近一次实测停在上一条发布线的版本）；`partial` / `unsupported` / `unverified`（如 0.2.3+）/ 读不到版本为 **warn**；
- `profile`：是否存在、是否漂移、路由来源；
- `team`：`on` / `off` / `requested but unavailable`（版本或 profile 不含 team 包）；
- `config`：当前 permission、空闲回收、共享进程等生效值；
- `update`：本服务的版本和 npm 上的最新版比；有新版本时 **warn**（一天最多查一次，4 秒超时；离线算未知，不算问题；`DSH_MCP_UPDATE_CHECK=0` 不查）。

## 升级建议

1. 升级 DSH 前先记录 `dsh_doctor` 的输出；
2. 升级后重新跑 `node test/run.mjs`（离线）和 `node test/run.mjs --all`（需要 provider）；
3. 如果团队模式打不开，先看 `dsh-any-agent team status` 和 `dsh_doctor` 的 `team` 检查，
   再确认 `~/.dsh/profiles/dsh-team/cordis.patch.yml` 是否包含
   `@deepseek-ai/dsh-experimental-agent-team`；
4. 默认跟随桌面版：桌面版升级后服务会在下次拉起 DSH 时自动用上新版本（发现结果缓存 60 秒）。
   确实需要固定某个版本时才显式设置 `DSH_BIN`。
