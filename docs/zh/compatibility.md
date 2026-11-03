> 返回 [README](../../README.zh.md)

# 🧩 兼容性矩阵

`dsh-any-agent` 依赖 DSH 的 ACP profile；团队模式还依赖 DSH 0.1.7 起才有的实验性 Agent Teams 包。
升级 DSH 之前先对照这张表，并在升级后跑一遍 `dsh_doctor`。

## 版本

| dsh-any-agent | DSH | 状态 | 说明 |
|---|---|---|---|
| 0.5.x | `0.1.7-rc.1` 及以上 | ✅ 已验证 | ACP + 实验性 Agent Teams 包均可用；团队模式需 `dsh-any-agent team on` |
| 0.5.x | `0.1.5-rc.1` | ⚠️ 部分可用 | ACP 基本路径可用；缺 team 包，团队模式会自动保持关闭 |
| 0.5.x | `0.2.x` | ⚠️ 未验证 | ACP 的 `session/*` 面可能变化；team 包必须与 DSH 版本匹配。升级前先跑 `dsh_doctor` 和离线套件 |
| 0.4.x | `0.1.7-rc.1` | ✅ 已验证 | 团队模式当时默认开启 |
| 0.4.x | `0.1.5-rc.1` | ⚠️ 部分可用 | 无 team 包 |

> 实验性包（`dsh-experimental-agent-team`、`dsh-experimental-tool-agent-team`）**没有稳定性承诺**。
> 它们随 DSH 版本发布，不能跨大版本混用。

## 运行时要求

- **Node.js ≥ 22.15**（用到 `node:zlib` 的 `zstdDecompressSync` 读 DSH 会话头）；
- DSH 已安装，且 `~/.dsh` 下已有可用的 provider 与凭据（GUI 能正常聊天即可）；
- 团队模式额外要求 DSH `>= 0.1.7-0`，并且 profile 里真的挂上了两个 team 包。

## 怎么确认

```bash
dsh-any-agent --version          # 本服务版本
node <DSH_BIN> --version         # DSH 版本（DSH_BIN 可用环境变量指定）
dsh-any-agent team status        # 团队开关与 profile
```

在 MCP 客户端里调用 `dsh_doctor`，重点看：

- `dsh_bin`：DSH 入口与版本；
- `profile`：是否存在、是否漂移、路由来源；
- `team`：`on` / `off` / `requested but unavailable`（版本或 profile 不含 team 包）；
- `config`：当前 permission、空闲回收、共享进程等生效值。

## 升级建议

1. 升级 DSH 前先记录 `dsh_doctor` 的输出；
2. 升级后重新跑 `node test/run.mjs`（离线）和 `node test/run.mjs --all`（需要 provider）；
3. 如果团队模式打不开，先看 `dsh-any-agent team status` 和 `dsh_doctor` 的 `team` 检查，
   再确认 `~/.dsh/profiles/dsh-team/cordis.patch.yml` 是否包含
   `@deepseek-ai/dsh-experimental-agent-team`；
4. 需要固定 DSH 版本时，显式设置 `DSH_BIN`，不要让 npx 缓存自动挑版本。
