/**
 * live 查看端回归：归并器、增量 tail、终端渲染、dashboard 安全边界。离线，不拉 DSH。
 */
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-live-view-'));
const liveDir = join(root, 'live');
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_MCP_LIVE_DIR = liveDir;

const { LiveState, LiveTail, splitLines, parseEvent, renderText, writerPid } = await import('../src/live-view.mjs');
const { startDashboard } = await import('../src/live-dashboard.mjs');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const ok = fn();
    if (ok === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const ALIVE_W = `${process.pid}:aaaa`;
const DEAD_W = '999999999:dead';
let n = 0;
const ev = (conv, type, extra = {}) => ({ v: 1, ts: new Date(Date.now() + n).toISOString(), conv, w: ALIVE_W, n: ++n, type, ...extra });
const line = (e) => JSON.stringify(e) + '\n';
const writeEvents = (conv, list) => {
  mkdirSync(join(liveDir, conv), { recursive: true });
  appendFileSync(join(liveDir, conv, 'events.jsonl'), list.map(line).join(''));
};

function httpGet(port, path, { host = `127.0.0.1:${port}`, method = 'GET', sse = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (sse && body.includes('\n\ndata: ')) {
          const end = body.indexOf('\n\n', body.indexOf('data: '));
          if (end > 0) {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body });
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => (sse ? resolve({ status: 0, body: '' }) : reject(e)));
    req.end();
  });
}

try {
  console.log('\n[1] 行切分与解析');
  {
    const zh = Buffer.from('{"a":"中文"}\n{"b":1}\n{"c":"半', 'utf8');
    const cut = zh.subarray(0, zh.length - 2); // 把最后一个汉字切成半个
    const { lines, rest } = splitLines(cut);
    check('完整行原样解出，含中文', () => lines.length === 2 && JSON.parse(lines[0]).a === '中文');
    check('半行（含被切开的多字节字符）留在 rest', () => rest.length > 0 && !rest.includes(0x0a));
    check('坏行返回 null', () => parseEvent('{oops') === null && parseEvent('{"type":"x"}') === null);
    check('writerPid 解析', () => writerPid('123:ab') === 123 && writerPid('nope') === null);
  }

  console.log('\n[2] 归并：客户端 → 会话 → 回合 → 工具/审批');
  {
    const s = new LiveState();
    s.apply(ev('c1', 'conv.open', { cwd: 'D:/p', permission: 'workspace-write', client: 'claude-code', title_hint: '修登录' }));
    s.apply(ev('c1', 'run.start', { run: 'r1', turn: 1, via: 'send', client: 'claude-code', prompt_preview: '修登录' }));
    s.apply(ev('c1', 'tool', { run: 'r1', tool_call_id: 't1', name: 'read', status: 'in_progress', input_preview: 'src/a.ts' }));
    s.apply(ev('c1', 'tool', { run: 'r1', tool_call_id: 't1', status: 'completed', elapsed_ms: 12 }));
    s.apply(ev('c1', 'tool', { run: 'r1', tool_call_id: 't2', name: 'pwsh', status: 'in_progress' }));
    s.apply(ev('c1', 'approval', { run: 'r1', tool_call_id: 't2', mode: 'ask', approval_id: 'ap-1', escalation: 'danger-full-access' }));
    let v = s.view({ alive: () => true });
    const c = v.groups[0].conversations[0];
    const r = c.runs[0];
    check('第一层按客户端分组', () => v.groups.length === 1 && v.groups[0].client === 'claude-code' && v.groups[0].pid === process.pid);
    check('会话状态 running、标题取 title_hint', () => c.state === 'running' && c.title === '修登录');
    check('工具原地合并（同一 tool_call_id 一行）', () => r.items.filter((x) => x.kind === 'tool').length === 2 && r.items[0].status === 'completed' && r.items[0].input_preview === 'src/a.ts');
    check('当前工具 = 最后一个未结束的', () => r.current_tool === 'pwsh');
    check('待审批与提权计数', () => r.pending_approvals === 1 && r.escalations === 1 && v.totals.pending_approvals === 1 && v.totals.escalations === 1);
    s.apply(ev('c1', 'approval.decided', { approval_id: 'ap-1', by: 'caller', decision: 'allow', effective: 'selected' }));
    s.apply(ev('c1', 'run.end', { run: 'r1', status: 'done', duration_ms: 1234, tool_count: 2 }));
    v = s.view({ alive: () => true });
    const r2 = v.groups[0].conversations[0].runs[0];
    check('裁决挂回原审批', () => r2.items.find((x) => x.kind === 'approval').decided.decision === 'allow');
    check('回合结束：未结束的工具标为 unfinished，会话回到 idle', () => r2.items.find((x) => x.id === 't2').status === 'unfinished' && v.groups[0].conversations[0].state === 'idle');
    // 写者已退出、回合仍 running → interrupted
    const d = new LiveState();
    d.apply({ ...ev('c2', 'run.start', { run: 'r9' }), w: DEAD_W });
    const dv = d.view();
    check('写者进程已退出的回合显示为 interrupted', () => dv.groups[0].conversations[0].runs[0].status === 'interrupted' && dv.totals.running === 0);
    const q = new LiveState();
    q.apply(ev('c3', 'run.start', { run: 'r1' }));
    q.apply(ev('c3', 'run.queued', { run: 'r2', position: 1 }));
    check('有运行中的回合时会话是 running，即使后面还有排队', () => q.view({ alive: () => true }).groups[0].conversations[0].state === 'running');
    check('未知事件类型不报错', () => {
      d.apply(ev('c2', 'from.the.future', { run: 'r9' }));
      return true;
    });
  }

  console.log('\n[3] 增量 tail：半行、滚动、删除');
  {
    writeEvents('c-tail', [ev('c-tail', 'run.start', { run: 'r1', client: 'codex' })]);
    const half = line(ev('c-tail', 'tool', { run: 'r1', tool_call_id: 't1', name: 'read', status: 'in_progress' }));
    appendFileSync(join(liveDir, 'c-tail', 'events.jsonl'), half.slice(0, 20));
    const tail = new LiveTail(liveDir);
    check('首次 poll 有变化', () => tail.poll() === true);
    check('半行不被当成事件', () => tail.view({ alive: () => true }).groups[0].conversations[0].runs[0].items.length === 0);
    appendFileSync(join(liveDir, 'c-tail', 'events.jsonl'), half.slice(20));
    check('补齐后读到这条工具', () => tail.poll() && tail.view({ alive: () => true }).groups[0].conversations[0].runs[0].items.length === 1);
    check('没有新内容时 poll 返回 false', () => tail.poll() === false);
    // 滚动：旧文件改名为 .1，新文件从头写
    const f = join(liveDir, 'c-tail', 'events.jsonl');
    renameSync(f, `${f}.1`);
    writeFileSync(f, line(ev('c-tail', 'run.end', { run: 'r1', status: 'done' })));
    tail.poll();
    check('滚动后继续读新文件', () => tail.view({ alive: () => true }).groups[0].conversations[0].runs[0].status === 'done');
    const fresh = new LiveTail(liveDir);
    fresh.poll();
    const fr = fresh.view({ alive: () => true }).groups[0].conversations[0].runs[0];
    check('新查看器先读 .1 旧档再读新文件，时间线完整', () => fr.items.length === 1 && fr.status === 'done');
    rmSync(join(liveDir, 'c-tail'), { recursive: true, force: true });
    check('会话目录被删（forget）后从视图移除', () => tail.poll() === true && tail.view().totals.conversations === 0);
    const none = new LiveTail(join(root, 'missing'));
    check('目录不存在时安静为空', () => none.poll() === false && none.view().totals.conversations === 0);
  }

  console.log('\n[4] 终端渲染');
  {
    const s = new LiveState();
    s.apply(ev('abcdef123456', 'run.start', { run: 'run-x', via: 'queue', client: 'claude-code', cwd: 'D:/proj', prompt_preview: '跑测试' }));
    s.apply(ev('abcdef123456', 'tool', { run: 'run-x', tool_call_id: 't', name: 'pwsh', status: 'in_progress', input_preview: 'npm test' }));
    s.apply(ev('abcdef123456', 'approval', { run: 'run-x', mode: 'auto-allow', escalation: 'danger-full-access', command_preview: 'git push' }));
    const txt = renderText(s.view({ alive: () => true }));
    check('树里有客户端、会话、回合、工具、审批', () => ['claude-code', 'abcdef12', 'run-x', '[queue]', 'npm test', '⚠ danger-full-access', 'git push'].every((k) => txt.includes(k)));
    check('无颜色时不含 ANSI', () => !txt.includes('\x1b['));
    check('按会话前缀过滤', () => renderText(s.view({ alive: () => true }), { conv: 'zzz' }).includes('没有匹配'));
  }

  console.log('\n[5] watch --once（真正走 bin 入口，不启动 Hub）');
  {
    writeEvents('c-watch', [ev('c-watch', 'run.start', { run: 'r-watch', client: 'cursor', prompt_preview: 'hello-watch' })]);
    const bin = fileURLToPath(new URL('../bin/dsh-any-agent.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [bin, 'watch', '--once'], { env: { ...process.env, DSH_MCP_LIVE_DIR: liveDir }, encoding: 'utf8', timeout: 30_000 });
    check('watch --once 退出码 0', () => r.status === 0, r.stderr);
    check('watch --once 输出调用链', () => r.stdout.includes('cursor') && r.stdout.includes('r-watch') && r.stdout.includes('hello-watch'), r.stdout);
  }

  console.log('\n[6] dashboard：只读、token、Host 校验');
  {
    const tail = new LiveTail(liveDir);
    const dash = await startDashboard({ tail, token: 'test-token-123', pollMs: 100, html: '<!doctype html><title>t</title>' });
    try {
      const p = dash.port;
      check('只监听 127.0.0.1', () => dash.server.address().address === '127.0.0.1');
      check('URL 带 token', () => dash.url === `http://127.0.0.1:${p}/?t=test-token-123`);
      const okPage = await httpGet(p, '/?t=test-token-123');
      check('带 token 能打开页面', () => okPage.status === 200 && okPage.body.includes('<title>t</title>'));
      check('安全响应头齐全', () => okPage.headers['content-security-policy']?.includes("default-src 'none'") && okPage.headers['referrer-policy'] === 'no-referrer' && okPage.headers['x-frame-options'] === 'DENY');
      const noTok = await httpGet(p, '/');
      check('不带 token 的状态码是 403', () => noTok.status === 403);
      const wrongTok = await httpGet(p, '/api/view?t=test-token-124');
      check('错误 token → 403', () => wrongTok.status === 403);
      const rebinding = await httpGet(p, '/?t=test-token-123', { host: `evil.example:${p}` });
      check('外部 Host 头（DNS rebinding）→ 421', () => rebinding.status === 421);
      const post = await httpGet(p, '/api/view?t=test-token-123', { method: 'POST' });
      check('非 GET → 405（没有控制面）', () => post.status === 405);
      const nf = await httpGet(p, '/nope?t=test-token-123');
      check('未知路径 → 404', () => nf.status === 404);
      const api = await httpGet(p, '/api/view?t=test-token-123');
      const view = JSON.parse(api.body);
      check('/api/view 返回调用链快照', () => api.status === 200 && view.groups.some((g) => g.client === 'cursor'));
      writeEvents('c-sse', [ev('c-sse', 'run.start', { run: 'r-sse', client: 'zed' })]);
      await new Promise((r) => setTimeout(r, 300));
      const sse = await httpGet(p, '/events?t=test-token-123', { sse: true });
      check('SSE 推送包含新会话', () => sse.status === 200 && sse.headers['content-type'].startsWith('text/event-stream') && sse.body.includes('r-sse'));
    } finally {
      await dash.close();
    }
    check('close 之后端口释放', () => !dash.server.listening);
  }
} catch (e) {
  failed += 1;
  console.log(`  ✗ 未捕获异常: ${e.stack ?? e.message}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

console.log(`\n===== live 查看端：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
