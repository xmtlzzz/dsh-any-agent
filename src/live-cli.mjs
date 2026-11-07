/**
 * `dsh-any-agent watch` / `dsh-any-agent dashboard` 两个子命令的入口。
 *
 * 两者都是**独立进程**、只读 live 事件流，与 MCP 服务进程无关：不碰写锁、不连 DSH、
 * 不需要服务在跑（没有事件时就显示空）。
 */

import { LIVE_DIR, STATE_FILE } from './config.mjs';
import { LiveTail, renderText } from './live-view.mjs';
import { readConversationMeta } from './titles.mjs';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[k] = args[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const intFlag = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function makeTail(dir = LIVE_DIR) {
  return new LiveTail(dir, {
    stateFile: STATE_FILE,
    readTitle: (id) => readConversationMeta(id)?.title ?? null,
  });
}

export const WATCH_USAGE =
  '用法: dsh-any-agent watch [会话id前缀] [--once] [--interval 毫秒] [--runs N] [--items N] [--no-color]\n';

/** watch：终端里实时显示调用链（Ctrl+C 退出）。`--once` 打印一次就退出。 */
export async function runWatch(args, { out = process.stdout } = {}) {
  const { flags, positional } = parseFlags(args);
  if (flags.help || flags.h) {
    out.write(WATCH_USAGE);
    return 0;
  }
  const tail = makeTail(typeof flags.dir === 'string' ? flags.dir : LIVE_DIR);
  const opts = {
    conv: positional[0] ?? null,
    runs: intFlag(flags.runs, 3, 1, 30),
    items: intFlag(flags.items, 12, 1, 300),
    color: !flags['no-color'] && Boolean(out.isTTY),
  };
  tail.poll();
  if (flags.once) {
    out.write(renderText(tail.view(), opts) + '\n');
    return 0;
  }
  const interval = intFlag(flags.interval, 500, 100, 10_000);
  const draw = () => {
    // 清屏 + 光标回到左上角，再整屏重画（树会变长变短，增量刷新不值得）。
    out.write('\x1b[2J\x1b[H' + renderText(tail.view(), opts) + `\n\n${'\x1b[2m'}live 目录: ${tail.dir} · Ctrl+C 退出${'\x1b[0m'}\n`);
  };
  draw();
  let lastDraw = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      // 有新事件就重画；没有也每 5 秒重画一次（刷新"写者是否还活着"）。
      if (tail.poll() || Date.now() - lastDraw > 5000) {
        draw();
        lastDraw = Date.now();
      }
    }, interval);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

export const DASHBOARD_USAGE = '用法: dsh-any-agent dashboard [--port 端口] [--interval 毫秒]\n';

/** dashboard：起一个只读本地页面（127.0.0.1 + 一次性 token），Ctrl+C 退出。 */
export async function runDashboard(args, { out = process.stdout } = {}) {
  const { flags } = parseFlags(args);
  if (flags.help || flags.h) {
    out.write(DASHBOARD_USAGE);
    return 0;
  }
  const { startDashboard } = await import('./live-dashboard.mjs');
  const tail = makeTail(typeof flags.dir === 'string' ? flags.dir : LIVE_DIR);
  const dash = await startDashboard({
    tail,
    port: intFlag(flags.port, 0, 0, 65535),
    pollMs: intFlag(flags.interval, 500, 100, 10_000),
  });
  out.write(
    `DSH live dashboard（只读）\n` +
      `  打开: ${dash.url}\n` +
      `  live 目录: ${tail.dir}\n` +
      `  链接里带一次性 token，只在本机 127.0.0.1 可访问；Ctrl+C 退出。\n`,
  );
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await dash.close();
  return 0;
}
