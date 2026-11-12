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
import { cleanupSuite } from './residue.mjs';
import { resolveDshBin } from '../src/config.mjs';

let hasDsh = true;
try { resolveDshBin(); } catch { hasDsh = false; }

let pass = 0;
let failCount = 0;
/** 极简 schema 校验（零依赖）：required 的键都在，声明了类型的键类型对得上。返回不符之处。 */
function schemaMismatches(schema, value) {
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  const fits = (v, type) => [].concat(type).some((t) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer'));
  if (typeOf(value) !== 'object') return [`structuredContent 是 ${typeOf(value)}，不是对象`];
  const bad = [];
  for (const key of schema.required ?? []) if (!(key in value)) bad.push(`缺 ${key}`);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in value)) continue;
    if (prop.type && !fits(value[key], prop.type)) bad.push(`${key} 是 ${typeOf(value[key])}，声明的是 ${prop.type}`);
    if (prop.enum && !prop.enum.includes(value[key])) bad.push(`${key}=${value[key]} 不在枚举里`);
  }
  return bad;
}

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// ★ 状态目录必须收在自己的临时根里：DSH_MCP_STATE 直接放 %TEMP% 根下的话，runs/reviews/locks/meta
//   会散落在 %TEMP% 根下，没有 dsh-any-agent-* 目录兜着，永远清不掉。
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-any-agent-smoke-'));
const STATE = join(ROOT, 'state.json');
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
  const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
  const unhinted = tools.filter((t) => !HINTS.every((h) => typeof t.annotations?.[h] === 'boolean')).map((t) => t.name);
  check('每个工具的四个注解都是布尔值', unhinted.length === 0, unhinted.join(','));
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort().join(',');
  check('只读工具是 doctor/get/inbox/list/read/status', readOnly === 'dsh_doctor,dsh_get,dsh_inbox,dsh_list,dsh_read,dsh_status', readOnly);
  check('只读工具不标成破坏性', tools.every((t) => !(t.annotations?.readOnlyHint && t.annotations?.destructiveHint)));
  check('每个工具都有标题', tools.every((t) => typeof t.title === 'string' && t.title.length > 0));
  const withSchema = tools.filter((t) => t.outputSchema).map((t) => t.name).sort().join(',');
  check('核心工具声明 outputSchema', withSchema === 'dsh_get,dsh_inbox,dsh_list,dsh_send,dsh_start,dsh_status', withSchema);
  // 声明了 schema 的工具，客户端会按它校验返回值：这里用同一份 schema 自己先验一遍。
  for (const [name, args] of [['dsh_list', { include_closed: false }], ['dsh_inbox', {}]]) {
    const res = await client.callTool(name, args, 30_000);
    const bad = schemaMismatches(tools.find((t) => t.name === name).outputSchema, res?.structuredContent);
    check(`${name} 的返回值符合它声明的 outputSchema`, bad.length === 0, bad.join('; '));
  }

  console.log('\n[2b] DSH_MCP_LANG=en：标题、描述、说明都是英文');
  {
    const en = new McpClient({ env: { DSH_MCP_STATE: join(ROOT, 'state-en.json'), DSH_MCP_LANG: 'en' } }).start();
    try {
      const { INSTRUCTIONS_EN_MAX_CHARS } = await import('../src/mcp.mjs');
      const enInit = await en.initialize();
      const enInstr = String(enInit?.instructions ?? '');
      const enTools = await en.listTools();
      const cjk = /[㐀-鿿]/;
      check(`英文说明不超过 ${INSTRUCTIONS_EN_MAX_CHARS} 字`, enInstr.length > 0 && enInstr.length <= INSTRUCTIONS_EN_MAX_CHARS, `${enInstr.length} 字`);
      check('英文说明里铁律在前 800 字内', /Iron rules/.test(enInstr.slice(0, 800)) && /dsh_review/.test(enInstr.slice(0, 1100)));
      check('英文说明里没有中文', !cjk.test(enInstr));
      const leftover = [];
      for (const t of enTools) {
        if (cjk.test(`${t.title}${t.description}`)) leftover.push(t.name);
        for (const [key, p] of Object.entries(t.inputSchema.properties)) if (p.description && cjk.test(p.description)) leftover.push(`${t.name}.${key}`);
      }
      check('英文工具清单里没有中文', leftover.length === 0, leftover.join(','));
      // 体检报告是英文用户排查问题最先看的东西。路径可能含中文（用户名），所以只查
      // 我们自己写的文字：标题行 + 每条检查去掉路径/异常原文之后不该剩中文标点或"体检"字样。
      const enDoc = await en.callTool('dsh_doctor', {});
      const enDocText = String(enDoc?.content?.[0]?.text ?? '');
      check('★ 英文 dsh_doctor：标题行是英文', /^(All checks passed|Some checks failed)/.test(enDocText), enDocText.slice(0, 80));
      const zhOnly = /体检|会话|孤儿|级别|运行时|来源|桌面版|目录|检查权限|首次启动|[，；（）：]/;
      // dsh_bin 找不到 DSH 时 detail 是 resolveDsh 的原始报错（另一处的文字，不在本次范围）。
      const enDocLeft = enDocText.split('\n').filter((l) => zhOnly.test(l) && !/^✗ dsh_bin:/.test(l));
      check('★ 英文 dsh_doctor：各检查项没有残留中文文案', enDocLeft.length === 0, enDocLeft.join(' | ').slice(0, 300));
      // 中文那份有描述的参数，英文那份也必须有：新加的参数不能悄悄漏翻。
      const untranslated = [];
      for (const t of tools) {
        const other = enTools.find((e) => e.name === t.name);
        for (const [key, p] of Object.entries(t.inputSchema.properties)) {
          if (p.description && !other?.inputSchema.properties[key]?.description) untranslated.push(`${t.name}.${key}`);
        }
      }
      check('每个有描述的参数都有英文描述', untranslated.length === 0, untranslated.join(','));
      const shape = (list) => JSON.stringify(list.map((t) => [t.name, Object.keys(t.inputSchema.properties), t.inputSchema.required, t.annotations, t.outputSchema]));
      check('两种语言的名字、参数、注解与 schema 完全一致', shape(tools) === shape(enTools));
      // 工具返回的正文也跟语言走：正常结果、未知工具、参数校验报错各验一条。
      const unknown = await en.callTool('dsh_nope', {}).catch((error) => error);
      check('英文未知工具返回协议错误', unknown.code === -32602 && /Unknown tool/.test(unknown.message));
      for (const [name, args] of [
        ['dsh_list', { include_closed: false }],
        ['dsh_inbox', {}],
        ['dsh_start', { cwd: 'relative/path' }],
        ['dsh_start', { cwd: ROOT, permission: 'read-only', on_approval: 'ask' }],
      ]) {
        const text = McpClient.text(await en.callTool(name, args, 30_000));
        check(`英文模式下 ${name}(${Object.keys(args).join(',')}) 的返回正文是英文`, text.length > 0 && !cjk.test(text), text.slice(0, 120));
      }
    } finally {
      await en.close();
    }
  }
  let ws = null;
  if (!hasDsh) {
    console.log('\n[3-5] 跳过 DSH 会话部分（未找到 DSH CLI；其余离线套件仍会执行）');
  } else {
  console.log('\n[3] dsh_start（只读档，临时工作区）');
  ws = mkdtempSync(join(ROOT, 'ws-'));
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
  const statusRes = await client.callTool('dsh_status', { conversation_id: convId });
  const statusBad = schemaMismatches(tools.find((t) => t.name === 'dsh_status').outputSchema, statusRes?.structuredContent);
  check('dsh_status 的返回值符合它声明的 outputSchema', statusBad.length === 0, statusBad.join('; '));
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

  console.log('\n[6] 未知工具返回 JSON-RPC 参数错误');
  const bad = await client.callTool('dsh_nope', {}).catch((error) => error);
  check('未知工具 -32602', bad?.code === -32602);
  const protoTool = await client.callTool('constructor', {}).catch((error) => error);
  check(
    '原型链名字不会被当成工具',
    protoTool instanceof Error && /未知工具/.test(protoTool.message),
    protoTool?.message,
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
      // isolation=worktree 的位置信息（路径 / 分支名 / 基准提交），不含对话内容；没开时是 null。
      'worktree',
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
  // 收尾：删掉本套件造的会话及其全部产物，再删临时根（含状态目录）
  cleanupSuite({ clients: [client], roots: [ROOT] });
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
}

// 检查数随有没有 DSH 变化（有 = 会话段也跑，没有 = 跳过），报告里要记下是哪一种。
console.log(`[report] dsh=${hasDsh ? 1 : 0}`);
console.log(`\n===== 冒烟测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);
