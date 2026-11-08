/**
 * `dsh-any-agent watch` / `dsh-any-agent dashboard` 两个子命令的入口。
 *
 * 两者都是**独立进程**、只读 live 事件流，与 MCP 服务进程无关：不碰写锁、不连 DSH、
 * 不需要服务在跑（没有事件时就显示空）。
 */

import { LIVE_DIR, STATE_FILE } from './config.mjs';
import { LiveTail, diffFrame, layoutFrame, renderText } from './live-view.mjs';
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
  const tty = Boolean(out.isTTY);
  const clock = () => new Date().toTimeString().slice(0, 8);
  const frameText = () =>
    renderText(tail.view(), opts) + `\n\n\x1b[2m更新于 ${clock()} · live 目录: ${tail.dir} · Ctrl+C 退出\x1b[0m`;

  // ★ 在 TTY 上用"备用屏幕"原地刷新（同 top / htop）：每帧只重写变化的行。
  //   旧实现每次 `ESC[2J` 清屏，Windows Terminal 会把被清掉的整屏推进回滚区，
  //   往上一翻就是一摞重复的帧。备用屏幕没有回滚区，退出时原样恢复用户的终端。
  let prev = null;
  let lastText = '';
  const draw = (force = false) => {
    const text = frameText();
    if (!tty) {
      // 管道 / 重定向：没有光标控制，内容变了才追加一帧（去掉时间行再比较，免得每次都算变化）。
      const body = text.slice(0, text.lastIndexOf('\n\n'));
      if (body !== lastText) out.write(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') + '\n\n');
      lastText = body;
      return;
    }
    const next = layoutFrame(text, { cols: out.columns ?? 120, rows: out.rows ?? 40 });
    const seq = diffFrame(force ? null : prev, next);
    if (seq) out.write(seq);
    prev = next;
  };
  const restore = () => {
    if (tty) out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  if (tty) out.write('\x1b[?1049h\x1b[?25l');
  process.once('exit', restore);
  draw(true);
  const onResize = () => draw(true);
  if (tty) out.on?.('resize', onResize);
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      // 有新事件才重算；时间行每秒在变，所以每次都会写，但 diffFrame 只重写真正变了的那几行。
      tail.poll();
      draw();
    }, interval);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  out.off?.('resize', onResize);
  restore();
  process.off('exit', restore);
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
