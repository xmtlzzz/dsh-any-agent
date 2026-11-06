/**
 * `dsh_list` 的开销与语义边界（**实测驱动**，不是猜的）。
 *
 * 背景：列会话时若要包含磁盘上未打开的会话，就得 spawn 一个 DSH 进程做 `session/list`
 * —— 实测约 1 秒。这条测试把开销钉住，防止以后悄悄退化：
 *   [1] 默认调用（含磁盘探测）第一次要付出探测代价
 *   [2] ★ 连续调用命中缓存 → 毫秒级（从 ~1000ms 降到个位数）
 *   [3] ★ only_running=true 跳过探测 → 毫秒级，且**不包含**磁盘上的未打开会话（语义等价）
 *   [4] include_closed=false 也不探测，且仍能看到本服务已打开的会话
 *
 * 阈值取得很宽松（500ms），只抓"是否又变成拉进程"这种量级差异，不会因机器抖动误报。
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-any-agent-list-'));
const { McpClient } = await import('./mcp-client.mjs');
const client = new McpClient({ env: { DSH_MCP_STATE: join(ROOT, 'state.json') } }).start();

let pass = 0;
let failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const timed = async (args) => {
  const t = Date.now();
  const r = await client.callTool('dsh_list', args, 300_000);
  return { ms: Date.now() - t, s: r?.structuredContent ?? {} };
};

let trackedId = null;
try {
  await client.initialize();
  const ws = join(ROOT, 'ws');
  mkdirSync(ws, { recursive: true });
  const st = await client.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 180_000);
  const conv = st?.structuredContent?.conversation_id;
  trackedId = conv ?? null;
  check('会话已建', !!conv, McpClient.text(st).slice(0, 140));

  console.log('\n[1] 默认调用：第一次要付磁盘探测的代价');
  const first = await timed({});
  console.log(`    第一次 ${first.ms}ms，会话数 ${first.s.count}`);
  check('默认调用能列出会话', (first.s.count ?? 0) >= 1, JSON.stringify(first.s.count));
  check('并包含本服务已打开的那个会话', (first.s.conversations ?? []).some((c) => c.conversation_id === conv));

  console.log('\n[2] ★ 连续调用命中缓存（不该再拉进程）');
  const second = await timed({});
  const third = await timed({});
  console.log(`    第 2 次 ${second.ms}ms，第 3 次 ${third.ms}ms（第一次 ${first.ms}ms）`);
  // ★ 判定“缓存生效”看结构化字段，不看墙钟：Windows 上实测第 2 或第 3 次偶尔会多出
  //   ~700ms（服务端还在收尾上一次的探测子进程），500ms 阈值因此稳定误报。
  //   耗时只做宽松的健全性检查：远低于一次真实探测（拉 DSH 进程要数秒）。
  check('第一次确实做了磁盘探测（未命中缓存）', first.s.probe_cached === false && first.s.probe_ok === true, JSON.stringify({ c: first.s.probe_cached, ok: first.s.probe_ok }));
  check('★ 第 2 次命中缓存（probe_cached=true，没有再拉进程）', second.s.probe_cached === true, JSON.stringify(second.s.probe_cached));
  check('★ 第 3 次同样命中缓存', third.s.probe_cached === true, JSON.stringify(third.s.probe_cached));
  check('命中缓存的调用远快于真实探测（< 1500ms）', second.ms < 1500 && third.ms < 1500, `${second.ms}ms / ${third.ms}ms`);
  check('缓存没有改变结果（会话数一致）', second.s.count === first.s.count && third.s.count === first.s.count, `${first.s.count}/${second.s.count}/${third.s.count}`);

  console.log('\n[3] ★ only_running=true：跳过探测，且语义等价');
  const only = await timed({ only_running: true });
  console.log(`    only_running ${only.ms}ms，会话数 ${only.s.count}（全为 running）`);
  check('★ only_running 跳过磁盘探测（probe_ok=null）', only.s.probe_ok === null, JSON.stringify(only.s.probe_ok));
  check('only_running 很快（< 1500ms）', only.ms < 1500, `${only.ms}ms`);
  check(
    '★ 且只返回正在跑的会话（不含磁盘上未打开的）',
    (only.s.conversations ?? []).every((c) => c.state === 'running'),
    JSON.stringify((only.s.conversations ?? []).map((c) => c.state)),
  );
  check(
    '磁盘上的未打开会话没有被算进来（数量不多于默认调用）',
    (only.s.count ?? 0) <= (first.s.count ?? 0),
    `${only.s.count} vs ${first.s.count}`,
  );

  console.log('\n[4] include_closed=false：也不探测，但能看到本服务已打开的');
  const closed = await timed({ include_closed: false });
  console.log(`    include_closed=false ${closed.ms}ms，会话数 ${closed.s.count}`);
  check('不做磁盘探测（probe_ok=null）', closed.s.probe_ok === null, JSON.stringify(closed.s.probe_ok));
  check('很快（< 1500ms）', closed.ms < 1500, `${closed.ms}ms`);
  check('仍包含本服务已打开的会话', (closed.s.conversations ?? []).some((c) => c.conversation_id === conv));
  check(
    '比默认调用少（列表里没有磁盘上的 detached 会话）',
    (closed.s.conversations ?? []).every((c) => c.state !== 'detached'),
    JSON.stringify((closed.s.conversations ?? []).map((c) => c.state)),
  );

  console.log('\n[5] 收尾');
  const rel = await client.callTool('dsh_release', { conversation_id: conv, forget: true }, 60_000);
  check('已释放', rel?.structuredContent?.closed === true, JSON.stringify(rel?.structuredContent));
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  await client.close();
  const { purgeTestSessions } = await import('../src/workspace.mjs');
  // 只删本套件自己创建的会话（idsOnly），绝不再用 tempOnly —— 那会删掉
  // 其他进程/测试正在使用的临时工作区会话（实测导致 ENOENT 与跨套件误杀）。
  purgeTestSessions({ ids: trackedId ? [trackedId] : [], idsOnly: true });
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

console.log(`\n===== dsh_list 开销测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);