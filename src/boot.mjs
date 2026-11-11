/**
 * 启动 Hub 的公共流程：stdio 模式（默认）与常驻进程模式（DSH_MCP_DAEMON=1）共用。
 *
 * 从 bin/dsh-any-agent.mjs 挪过来，内容不变：载入注册表、起回收器、清过期哨兵 / live 事件、
 * 清失效写锁登记并报告孤儿持有者。
 */

import { Hub } from './hub.mjs';
import { listOrphans, pruneDeadMarkers } from './locks.mjs';
import { pruneLive } from './live.mjs';
import { SENTINEL_TTL_MS } from './config.mjs';
import { createMcpServer } from './mcp.mjs';
import { createHandlers } from './tools.mjs';

/** 建好并启动一个 Hub（注册表、回收器、启动清理）。 */
export async function startHub(log) {
  const hub = new Hub({ log });
  await hub.load();
  hub.startReaper();
  // 启动时清一次过期哨兵（哨兵内含正文，长期不清理会无声堆积）
  const prunedSentinels = hub.pruneSentinels();
  // live 事件流与哨兵同一 TTL（单独调用，不改 pruneSentinels 的返回形状）
  try {
    const prunedLive = pruneLive(SENTINEL_TTL_MS);
    if (prunedLive.pruned) log.info(`[dsh-any-agent] 启动清理：删除 ${prunedLive.pruned} 个过期 live 事件文件`);
  } catch {
    /* 清理失败不影响启动 */
  }
  // 上一个进程没跑完就死掉的回合：补写"已中断"哨兵，别让调用方一直等一个不会出现的文件。
  const recovered = hub.recoverInterruptedRuns();
  if (recovered.length) {
    log.info(`[dsh-any-agent] 为 ${recovered.length} 个被中断的回合补写了哨兵: ${recovered.map((r) => r.run_id).join(', ')}`);
  }
  if (prunedSentinels.pruned || prunedSentinels.reviews_pruned) {
    log.info(
      `[dsh-any-agent] 启动清理：删除 ${prunedSentinels.pruned} 个过期哨兵、` +
        `${prunedSentinels.reviews_pruned ?? 0} 条过期审核记录、` +
        `${prunedSentinels.dirs_removed + (prunedSentinels.review_dirs_removed ?? 0)} 个空目录`,
    );
  }
  // 写锁登记清理：删掉"MCP 已死 + 子进程也死了"的记录；**保留**子进程还活着的那些 ——
  // 它们是"孤儿持有者"（上一代 MCP 崩了但子进程还握着锁），是 dsh_takeover 要抢占的目标。
  const deadMarkers = pruneDeadMarkers();
  const orphans = listOrphans();
  if (deadMarkers.removed || orphans.length) {
    log.info(
      `[dsh-any-agent] 写锁登记：清理 ${deadMarkers.removed} 条失效记录；发现 ${orphans.length} 个孤儿持有者` +
        (orphans.length ? `（会话 ${orphans.map((o) => o.conversation_id.slice(0, 8)).join(', ')} 可用 dsh_takeover 抢占）` : ''),
    );
  }
  if (orphans.length) log.info(`[dsh-any-agent] 孤儿持有者会话: ${orphans.map((o) => o.conversation_id).join(', ')}`);
  return hub;
}

/**
 * 在一对流上跑一个 MCP 会话（每个客户端连接一个）。
 * dsh_start 不传 cwd 时，用**这个**客户端当前打开的项目目录（MCP roots）。
 */
export function serveMcp({ hub, log, input, output }) {
  const server = createMcpServer({
    hub,
    log,
    input,
    output,
    handlers: createHandlers(hub, { projectDir: () => server.projectDir() }),
  });
  return server.start();
}

/** 默认模式：本进程就是 MCP stdio 服务端，客户端断开（stdin 结束）就收尾退出。 */
export async function runStdioServer(log) {
  const hub = await startHub(log);
  serveMcp({ hub, log });
  log.info(`[dsh-any-agent] 已启动（注册表载入 ${hub.conversations.size} 个会话，日志级别 ${log.level}）`);
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[dsh-any-agent] 收到 ${signal}，正在收尾…`);
    try {
      await hub.shutdown();
    } catch (e) {
      log.info(`[dsh-any-agent] 收尾异常: ${e.message}`);
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('end', () => shutdown('stdin EOF'));
}

/**
 * 一个后台路径的 Promise 拒绝不该让整个服务死掉（那会连带丢掉所有会话的活进程）。
 * 记一行就继续。**故意不接管 uncaughtException**：同步未捕获异常意味着状态不可知，
 * 让它崩掉更干净 —— 会话本体都在磁盘上，重启后会 resume。
 */
export function keepAliveOnRejection(log) {
  process.on('unhandledRejection', (e) => {
    log.info(`[dsh-any-agent] 未处理的 Promise 拒绝（已忽略，服务继续）: ${e?.message ?? e}`);
  });
}
