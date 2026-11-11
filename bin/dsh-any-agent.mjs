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
 *   DSH_MCP_IDLE_TTL_MS         空闲多久回收会话进程（默认 600000 = 10 分钟；0 = 永不回收）
 *   DSH_MCP_MAX_LIVE            最多同时保活几个会话进程（默认 4；0 = 不限）
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

const { createLogger, DAEMON_MODE } = await import('../src/config.mjs');
const { keepAliveOnRejection, runStdioServer } = await import('../src/boot.mjs');

const log = createLogger();
keepAliveOnRejection(log);

/**
 * 三种运行方式（见 src/daemon.mjs）：
 *   --daemon            常驻进程本体（由转发进程以 detached 方式拉起，不要手动运行）；
 *   DSH_MCP_DAEMON=1    转发进程：连上（必要时拉起）常驻进程，只搬字节；起不来就退回下面的普通模式；
 *   默认                本进程就是 MCP stdio 服务端，客户端断开就收尾退出。
 */
if (argv[0] === '--daemon') {
  const { runDaemon } = await import('../src/daemon.mjs');
  await runDaemon({ log });
} else if (!(DAEMON_MODE && (await (await import('../src/daemon.mjs')).runProxy({ log })))) {
  await runStdioServer(log);
}