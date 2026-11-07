/**
 * 冒烟测试：不消耗 token，只验证管道是否通。
 *   1) MCP 握手 + tools/list
 *   2) dsh_start 建会话（拉起 DSH ACP 进程 + session/new）
 *   3) dsh_get / dsh_list
 *   4) dsh_release 释放进程（并确认可以再次拉起，即 resume 路径可用）
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from './mcp-client.mjs';
import { resolveDshBin } from '../src/config.mjs';

let hasDsh = true;
try { resolveDshBin(); } catch { hasDsh = false; }

let pass = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const STATE = join(tmpdir(), `dsh-any-agent-smoke-state-${Date.now()}.json`);
const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();

try {
  console.log('\n[1] MCP 握手');
  const init = await client.initialize();
  check('initialize 返回 serverInfo', init?.serverInfo?.name === 'dsh-any-agent', JSON.stringify(init?.serverInfo));
  check('声明 tools 能力', !!init?.capabilities?.tools);
  // ★ 客户端会截断过长的 instructions（Claude Code 约 4000 字），旧版 4.4k 字的
  //   末尾规则根本到不了模型。守住上限，并确认最要紧的规则在最前面。
  const { INSTRUCTIONS_MAX_CHARS } = await import('../src/mcp.mjs');
  const instr = String(init?.instructions ?? '');
  check(
    `★ instructions 不超过 ${INSTRUCTIONS_MAX_CHARS} 字（不会被客户端截断）`,
    instr.length > 0 && instr.length <= INSTRUCTIONS_MAX_CHARS,
    `${instr.length} 字`,
  );
  check('铁律在前 600 字内（截断时也能保住）', /铁律/.test(instr.slice(0, 600)) && /dsh_review/.test(instr.slice(0, 600)), instr.slice(0, 120));

  console.log('\n[2] tools/list');
  const tools = await client.listTools();
  check(`工具数量 = 15（实际 ${tools.length}）`, tools.length === 15);
  const names = tools.map((t) => t.name);
  for (const n of ['dsh_start', 'dsh_send', 'dsh_list', 'dsh_read', 'dsh_get', 'dsh_review', 'dsh_interject', 'dsh_interrupt', 'dsh_release', 'dsh_takeover', 'dsh_approval_decide', 'dsh_status']) {
    check(`含工具 ${n}`, names.includes(n));
  }

  let ws = null;
  if (!hasDsh) {
    console.log('\n[3-5] 跳过 DSH 会话部分（未找到 DSH CLI；其余离线套件仍会执行）');
  } else {
  console.log('\n[3] dsh_start（只读档，临时工作区）');
  ws = mkdtempSync(join(tmpdir(), 'dsh-any-agent-smoke-ws-'));
  const startRes = await client.callTool('dsh_start', { cwd: ws, permission: 'read-only' }, 90_000);
  const startText = McpClient.text(startRes);
  const convId = startRes?.structuredContent?.conversation_id;
  check('返回 conversation_id', !!convId, startText.slice(0, 300));
  check('权限档 = read-only', startRes?.structuredContent?.permission === 'read-only');
  check('审批策略按档位推导为 auto-deny', startRes?.structuredContent?.on_approval === 'auto-deny');
  check('进程活着', startRes?.structuredContent?.alive === true);
  check(
    '思考深度默认 max（ACP 自身默认是 Provider default）',
    startRes?.structuredContent?.reasoning_effort === 'max',
    String(startRes?.structuredContent?.reasoning_effort),
  );
  check(
    '思考深度确实套用到了会话上',
    (startRes?.structuredContent?.config_applied ?? []).some((x) => x.includes('思考深度=max')),
    JSON.stringify(startRes?.structuredContent?.config_applied),
  );
  check(
    '工作区登记按模式生效：临时目录默认跳过（真实目录会被登记，由边界测试覆盖）',
    startRes?.structuredContent?.workspace_registered === false,
    JSON.stringify(startRes?.structuredContent?.workspace_registered),
  );
  console.log(`    conversation_id = ${convId}`);

  console.log('\n[4] dsh_get / dsh_list');
  const getRes = await client.callTool('dsh_get', { conversation_id: convId });
  check('dsh_get 能读到该会话', getRes?.structuredContent?.conversation_id === convId);
  const listRes = await client.callTool('dsh_list', { cwd: ws });
  const listed = listRes?.structuredContent?.conversations ?? [];
  check('dsh_list 含该会话', listed.some((c) => c.conversation_id === convId));

  console.log('\n[5] dsh_release → 进程释放，会话保留');
  const relRes = await client.callTool('dsh_release', { conversation_id: convId });
  check('release 成功', relRes?.structuredContent?.closed === true);
  const getAfter = await client.callTool('dsh_get', { conversation_id: convId });
  check('释放后会话仍在注册表（未打开）', getAfter?.structuredContent?.alive === false);
  }

  console.log('\n[6] 未知工具应返回 isError 而不是崩溃');
  const bad = await client.callTool('dsh_nope', {});
  check('未知工具 isError', bad?.isError === true);
  const protoTool = await client.callTool('constructor', {});
  check(
    '原型链名字不会被当成工具',
    protoTool?.isError === true && /未知工具/.test(McpClient.text(protoTool)),
    McpClient.text(protoTool).slice(0, 120),
  );

  console.log('\n[7] 默认日志静默（stderr 必须干净）');
  check(
    `默认不产生任何 stderr 输出（实际 ${client.stderr.length} 行）`,
    client.stderr.length === 0,
    client.stderr.slice(0, 5).join(' | '),
  );

  if (hasDsh) {
    console.log('\n[8] 会话注册表只存元数据（不含对话内容）');
    const stateRaw = readFileSync(STATE, 'utf8');
    const parsed = JSON.parse(stateRaw);
    const allowed = [
      'id', 'cwd', 'permission', 'onApproval', 'createdAt', 'lastUsedAt',
      'turnCount', 'titleHint', 'keepAlive', 'reasoningEffort', 'provider', 'model', 'review', 'workspace',
    ];
    const keys = Object.keys(parsed.conversations?.[0] ?? {});
    check('注册表条目字段仅元数据', keys.every((k) => allowed.includes(k)), keys.join(','));
    // 按精确 JSON 键判断，避免把 reasoningEffort（配置值）误判成思考内容
    const contentKeys = ['"answer"', '"thinking"', '"live_thinking"', '"result"', '"entries"', '"prompt_preview"', '"text"'];
    const leaked = contentKeys.filter((k) => stateRaw.includes(k));
    check('注册表里没有正文/思考等对话内容', leaked.length === 0, `命中=${leaked.join(',')}`);
  } else {
    console.log('\n[8] 跳过注册表内容检查（没有建会话）');
  }

  if (ws) rmSync(ws, { recursive: true, force: true });
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}`);
  console.log(client.stderr.slice(-25).join('\n'));
} finally {
  await client.close();
  try {
    rmSync(STATE, { force: true });
  } catch {}
}

// 检查数随有没有 DSH 变化（有 = 会话段也跑，没有 = 跳过），报告里要记下是哪一种。
console.log(`[report] dsh=${hasDsh ? 1 : 0}`);
console.log(`\n===== 冒烟测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);