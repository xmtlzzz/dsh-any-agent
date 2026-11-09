#!/usr/bin/env node
/**
 * dsh-any-agent 入口：以 MCP stdio 服务端方式运行，用 DSH (ACP) 作为后端。
 *
 * 环境变量：
 *   DSH_BIN                     DSH CLI 入口（默认自动识别：桌面版 → npm 全局 → npx 缓存）
 *   DSH_RUNTIME                 拉起 DSH 的可执行文件（默认：桌面版用其自带运行时，其余用本进程 node）
 *   DSH_MCP_PROFILE             驱动用的 DSH profile（默认 dsh-mcp）
 *   DSH_MCP_STATE               会话注册表路径（默认 $DSH_HOME/.dsh-any-agent/conversations.json）
 *   DSH_MCP_PERMISSION          新建会话的默认权限档（默认 workspace-write）
 *   DSH_MCP_APPROVAL            默认审批策略（非只读档默认 auto-allow；ask = 挂起待裁决）
 *   DSH_MCP_REVIEW              调用方审核策略（默认 advisory；off 关闭自动审核单）
 *   DSH_MCP_REVIEWS_DIR         审核记录目录（默认 <状态文件同目录>/reviews）
 *   DSH_MCP_IDLE_TTL_MS         空闲多久回收会话进程（默认 0 = 永不回收）
 *   DSH_MCP_PROMPT_TIMEOUT_MS   wait=true 时的等待上限（默认 0 = 不设超时）
 *   DSH_MCP_LOCK_STALE_MS       写锁登记多久没心跳算"持有者失联"（默认 90 秒）
 *   DSH_MCP_LOG                 silent(默认) | info | debug —— 日志级别
 *   DSH_MCP_LOG_STDERR          1 才转发 DSH 子树进程的原始 stderr（可能含思考内容）
 */

import { SERVER_VERSION } from '../src/mcp.mjs';

/**
 * `--version` / `--help` must be answered *before* the hub starts: the module
 * graph above already pulls in config and locks, and starting the hub would
 * spawn reapers and touch the registry just to print a version string.
 */
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(SERVER_VERSION + '\n');
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'dsh-any-agent ' + SERVER_VERSION + '\n\n' +
    'An MCP server that drives DeepSeek Harness (DSH) as a long-lived coding agent.\n' +
    'Runs as an MCP stdio server; normally launched by your MCP client, not by hand.\n\n' +
    'Usage:\n' +
    '  dsh-any-agent                 run the MCP server on stdio\n' +
    '  dsh-any-agent team on|off     enable/disable Agent Teams (writes settings.json)\n' +
    '  dsh-any-agent team status     show the effective team mode\n' +
    '  dsh-any-agent watch [conv]    live call chain of dispatched runs in this terminal\n' +
    '  dsh-any-agent dashboard       same, as a read-only local web page (127.0.0.1 + token);\n' +
    '                                --open launches it in your browser\n' +
    '  dsh-any-agent --version       print the version and exit\n' +
    '  dsh-any-agent --help          this text\n\n' +
    'Register it with your client:\n' +
    '  dsh-any-agent-setup           detect clients and preview (writes nothing)\n' +
    '  dsh-any-agent-setup --yes     apply\n\n' +
    'Key environment variables (all optional):\n' +
    '  DSH_BIN                  path to @deepseek-ai/dsh/lib/bin.js; auto-detected\n' +
    '                           (desktop app -> npm global -> npx cache)\n' +
    '  DSH_RUNTIME              executable that launches DSH; auto (desktop app\'s own runtime)\n' +
    '  DSH_MCP_PROFILE          DSH profile to drive (default dsh-mcp)\n' +
    '  DSH_MCP_PERMISSION       danger-full-access | workspace-write | read-only\n' +
    '  DSH_MCP_APPROVAL         auto-allow | auto-deny | ask\n' +
    '  DSH_MCP_REVIEW           advisory (default) | off — caller review ticket on results\n' +
    '  DSH_MCP_LOG              silent (default) | info | debug\n' +
    '  DSH_MCP_LIVE             detail (default) | meta | off — live event stream for watch/dashboard\n\n' +
    'Docs: https://github.com/xmtlzzz/dsh-any-agent\n',
  );
  process.exit(0);
}

/**
 * `dsh-any-agent watch` / `dsh-any-agent dashboard`：只读查看 live 事件流（调用链）。
 * 独立进程，不启动 Hub、不碰写锁、不连 DSH —— 必须在启动 Hub 之前分派。
 */
if (argv[0] === 'watch' || argv[0] === 'dashboard') {
  const cli = await import('../src/live-cli.mjs');
  const code = argv[0] === 'watch' ? await cli.runWatch(argv.slice(1)) : await cli.runDashboard(argv.slice(1));
  process.exit(code);
}

/**
 * `dsh-any-agent team on|off|status`
 *
 * 团队开关写 `<DSH_HOME>/.dsh-any-agent/settings.json`，不改客户端配置。
 * 优先级：环境变量 DSH_MCP_TEAM > 该文件 > 默认关。
 */
if (argv[0] === 'team') {
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const cfg = await import('../src/config.mjs');
  const readSettings = () => {
    try {
      return JSON.parse(fs.readFileSync(cfg.TEAM_SETTINGS_FILE, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeSettings = (obj) => {
    fs.mkdirSync(nodePath.dirname(cfg.TEAM_SETTINGS_FILE), { recursive: true });
    const tmp = `${cfg.TEAM_SETTINGS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, cfg.TEAM_SETTINGS_FILE);
  };

  const action = argv[1] ?? 'status';
  if (action === 'on' || action === 'off') {
    const cur = readSettings();
    cur.team = action === 'on';
    writeSettings(cur);
    process.stdout.write(
      `团队模式已${action === 'on' ? '开启' : '关闭'}（${cfg.TEAM_SETTINGS_FILE}）。\n` +
        `DSH 版本: ${cfg.DSH_VERSION ?? '未检测到'}（团队需要 >= 0.1.7-0）。\n`,
    );
    if (cfg.TEAM_MODE_SOURCE === 'env') {
      process.stdout.write(
        '⚠️ 环境变量 DSH_MCP_TEAM 优先级更高；请同时删除它，否则本次设置不会生效。\n',
      );
    }
    process.stdout.write('重新连接 MCP 服务（或重启客户端）后生效。\n');
    process.exit(0);
  }
  if (action === 'status') {
    const file = readSettings();
    process.stdout.write(
      '团队模式状态：\n' +
        `  环境变量 DSH_MCP_TEAM: ${process.env.DSH_MCP_TEAM ?? '(未设置)'}\n` +
        `  设置文件: ${cfg.TEAM_SETTINGS_FILE}（team=${file.team === undefined ? '未设置' : file.team}）\n` +
        `  生效值: ${cfg.TEAM_MODE ? '开' : '关'}（来源: ${cfg.TEAM_MODE_SOURCE}）\n` +
        `  profile: ${cfg.DSH_PROFILE}\n` +
        `  团队能力可用: ${cfg.TEAM_ACTIVE ? '是' : '否'}\n`,
    );
    process.exit(0);
  }
  process.stderr.write('用法: dsh-any-agent team on|off|status\n');
  process.exit(2);
}

const { createLogger } = await import('../src/config.mjs');
const { Hub } = await import('../src/hub.mjs');
const { createMcpServer } = await import('../src/mcp.mjs');
const { listOrphans, pruneDeadMarkers } = await import('../src/locks.mjs');
const { createHandlers } = await import('../src/tools.mjs');

const log = createLogger();

const hub = new Hub({ log });
await hub.load();
hub.startReaper();
// 启动时清一次过期哨兵（哨兵内含正文，长期不清理会无声堆积）
const prunedSentinels = hub.pruneSentinels();
// live 事件流与哨兵同一 TTL（单独调用，不改 pruneSentinels 的返回形状）
try {
  const { pruneLive } = await import('../src/live.mjs');
  const { SENTINEL_TTL_MS } = await import('../src/config.mjs');
  const prunedLive = pruneLive(SENTINEL_TTL_MS);
  if (prunedLive.pruned) log.info(`[dsh-any-agent] 启动清理：删除 ${prunedLive.pruned} 个过期 live 事件文件`);
} catch {
  /* 清理失败不影响启动 */
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

// dsh_start 不传 cwd 时，用客户端当前打开的项目目录（MCP roots）。
// 这样「客户端里看到哪个项目，DSH 就在哪个项目干活」是默认行为。
const server = createMcpServer({ hub, log, handlers: createHandlers(hub, { projectDir: () => server.projectDir() }) });
server.start();

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

// 一个后台路径的 Promise 拒绝不该让整个服务死掉（那会连带丢掉所有会话的活进程）。
// 记一行就继续。**故意不接管 uncaughtException**：同步未捕获异常意味着状态不可知，
// 让它崩掉更干净 —— 会话本体都在磁盘上，重启后会 resume。
process.on('unhandledRejection', (e) => {
  log.info(`[dsh-any-agent] 未处理的 Promise 拒绝（已忽略，服务继续）: ${e?.message ?? e}`);
});