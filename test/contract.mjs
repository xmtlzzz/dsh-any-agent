/**
 * 对外契约快照（离线：假 ACP 进程，不调用模型、不花 token）。
 *
 * 调用方会解析两样东西：MCP 工具（名字、参数、哪些必填、枚举值）与哨兵 JSON（字段与类型）。
 * 这里把它们的"形状"和 test/contract.snapshot.json 对比：
 *   - 新增（新工具、新的可选参数、新枚举值、哨兵新字段）= 兼容；
 *   - 删除、改类型、改成必填、删枚举值 = 破坏性。哨兵的破坏性改动必须把 SENTINEL_SCHEMA 加一。
 * 有差异就失败并列出来。确认无误后：
 *
 *   node test/contract.mjs --update
 *
 * 重写快照。哨兵有破坏性差异而 SENTINEL_SCHEMA 没变时，--update 拒绝写。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, 'contract.snapshot.json');
const UPDATE = process.argv.includes('--update');
const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-contract-'));
const env = {
  DSH_MCP_STATE: join(root, 'state', 'conversations.json'),
  DSH_MCP_RUNS_DIR: join(root, 'runs'),
  DSH_MCP_REVIEWS_DIR: join(root, 'reviews'),
  DSH_MCP_LOCKS_DIR: join(root, 'locks'),
  DSH_MCP_LIVE_DIR: join(root, 'live'),
  DSH_MCP_FORGOTTEN_DIR: join(root, 'forgotten'),
  DSH_HOME: join(root, 'home'),
  DSH_MCP_GIT_STATUS: '0',
  DSH_MCP_SHARED_PROCESS: '0',
  DSH_BIN: join(HERE, 'fake-acp.mjs'),
  FAKE_ACP_DIR: join(root, 'fake-acp'),
  FAKE_ACP_PROMPT_MS: '100',
  DSH_MCP_LOG: 'silent',
};
Object.assign(process.env, env);
for (const k of ['DSH_MCP_REVIEW', 'DSH_MCP_SENTINEL_TOOL_INPUTS', 'DSH_MCP_SENTINEL_INCLUDE_REASONING', 'DSH_MCP_DAEMON']) delete process.env[k];

// ★ 项目模块在设好环境之后才导入（config.mjs 导入时就定下各目录）。
const config = await import('../src/config.mjs');
if (config.RUNS_DIR !== env.DSH_MCP_RUNS_DIR) {
  console.log(`✗ 状态目录没落在临时目录（${config.RUNS_DIR}），拒绝继续`);
  process.exit(1);
}
const { Hub } = await import('../src/hub.mjs');
const { SENTINEL_SCHEMA } = await import('../src/sentinel.mjs');
const { TOOL_DEFS } = await import('../src/tool-defs.mjs');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`);
  }
}

// ── 形状 ──────────────────────────────────────────────────────────

/** 值的形状 → 扁平的 `路径 → 类型`。数组取第一个元素的形状（`a[]`），空数组记 `[]`。 */
function flattenShape(value, path = '', out = {}) {
  if (value === null) out[path] = 'null';
  else if (Array.isArray(value)) {
    if (value.length) flattenShape(value[0], `${path}[]`, out);
    else out[path] = '[]';
  } else if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) out[path] = '{}';
    for (const k of keys) flattenShape(value[k], path ? `${path}.${k}` : k, out);
  } else out[path] = typeof value;
  return out;
}

/** 工具面：`工具.参数.type / .required / .enum.<值>`（描述不算契约）。 */
function toolSurface(defs) {
  const out = {};
  for (const t of defs) {
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    out[`${t.name}`] = 'tool';
    for (const [p, s] of Object.entries(props)) {
      out[`${t.name}.${p}.type`] = JSON.stringify(s.type ?? s.anyOf?.map((x) => x.type) ?? 'any');
      out[`${t.name}.${p}.required`] = required.has(p);
      for (const v of s.enum ?? []) out[`${t.name}.${p}.enum.${v}`] = true;
    }
  }
  return out;
}

/** 快照场景里"没有内容"的值：以后在这里出现了具体形状，算细化，不算改类型。 */
const EMPTY_SHAPES = new Set(['null', '[]', '{}']);

/**
 * 对比两份扁平形状。added = 兼容；removed / changed = 破坏性
 * （新增的必填参数虽然是"新增"，也算破坏性）。
 */
function diffContract(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) {
      if (k.endsWith('.required') && v === true) changed.push(`${k}: (新参数) → true`);
      else added.push(k);
    } else if (JSON.stringify(before[k]) !== JSON.stringify(v)) {
      // 必填改成可选、原来为空的值有了具体类型：都不破坏调用方
      const relaxed = k.endsWith('.required') && before[k] === true && v === false;
      if (relaxed || EMPTY_SHAPES.has(before[k])) added.push(k);
      else changed.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(v)}`);
    }
  }
  for (const k of Object.keys(before)) {
    if (k in after) continue;
    // 原来为空（null / [] / {}）、现在展开成了子字段：细化
    const refined = EMPTY_SHAPES.has(before[k]) && Object.keys(after).some((a) => a.startsWith(`${k}.`) || a.startsWith(`${k}[]`));
    if (!refined) removed.push(k);
  }
  return { added, removed, changed, breaking: removed.length + changed.length > 0 };
}

const describe = (d) =>
  [
    d.removed.length ? `删除: ${d.removed.join(', ')}` : '',
    d.changed.length ? `改变: ${d.changed.join('; ')}` : '',
    d.added.length ? `新增: ${d.added.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

// ── 取当前形状 ────────────────────────────────────────────────────

const current = { sentinel_schema: SENTINEL_SCHEMA, tools: toolSurface(TOOL_DEFS), sentinels: {} };
let doneRaw = null;
let interruptedRaw = null;
try {
  const hub = new Hub({ log: { info() {}, debug() {} } });
  await hub.load();
  const conv = await hub.create({ cwd: root });
  const r = await conv.prompt('做一件小事', { wait: true, timeoutMs: 0 });
  doneRaw = JSON.parse(readFileSync(r.sentinel_file, 'utf8'));
  // 被中断的回合：服务进程死掉后由下一个进程补写（见 test/run-recovery.mjs）。
  const marker = join(env.DSH_MCP_RUNS_DIR, conv.id, 'run-dead.running');
  writeFileSync(marker, JSON.stringify({ conversation_id: conv.id, run_id: 'run-dead', review_mode: 'advisory', owner_pid: 2147483000 }));
  const [rec] = hub.recoverInterruptedRuns({ alive: () => false });
  interruptedRaw = rec ? JSON.parse(readFileSync(rec.sentinel_file, 'utf8')) : null;
  await hub.shutdown();
} catch (e) {
  failed += 1;
  console.log(`✗ 取哨兵失败: ${e.stack ?? e.message}`);
}
if (doneRaw) current.sentinels.done = flattenShape(doneRaw);
if (interruptedRaw) current.sentinels.interrupted = flattenShape(interruptedRaw);

// ── 对比 ──────────────────────────────────────────────────────────

console.log('\n[1] 判定规则自检');
{
  const d1 = diffContract({ a: 'string', b: 'number' }, { a: 'string', c: 'boolean' });
  check('删字段 = 破坏性，加字段 = 兼容', d1.breaking && d1.removed.join() === 'b' && d1.added.join() === 'c');
  const d2 = diffContract({ 't.x.required': false }, { 't.x.required': false, 't.y.required': true, 't.y.type': '"string"' });
  check('新增必填参数 = 破坏性', d2.breaking && d2.changed.some((c) => c.startsWith('t.y.required')));
  const d3 = diffContract({ 't.x.required': true, 't.x.enum.a': true, 't.x.enum.b': true }, { 't.x.required': false, 't.x.enum.a': true });
  check('必填改可选 = 兼容；删枚举值 = 破坏性', d3.removed.join() === 't.x.enum.b' && !d3.changed.length);
  const d4 = diffContract({ 'r.error': 'string' }, { 'r.error': 'number' });
  check('改类型 = 破坏性', d4.breaking && d4.changed.length === 1);
  const d5 = diffContract(
    { 'r.usage': 'null', 'r.tools_used': '[]', 'r.error': 'null' },
    { 'r.usage.input_tokens': 'number', 'r.tools_used[].name': 'string', 'r.error': 'string' },
  );
  check('原来为空的值有了具体形状（null/[] → 对象/元素/类型）= 兼容', !d5.breaking, describe(d5));
  const d6 = diffContract({ 'r.usage.input_tokens': 'number' }, { 'r.usage': 'null' });
  check('有形状的字段变成 null = 破坏性', d6.breaking);
}

console.log('\n[2] 哨兵带格式版本');
check('完成哨兵的 schema = SENTINEL_SCHEMA', doneRaw?.schema === SENTINEL_SCHEMA, JSON.stringify(doneRaw?.schema));
check('补写的中断哨兵也带 schema', interruptedRaw?.schema === SENTINEL_SCHEMA, JSON.stringify(interruptedRaw?.schema));

const snapshot = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : null;
const diffs = {
  tools: diffContract(snapshot?.tools ?? {}, current.tools),
  done: diffContract(snapshot?.sentinels?.done ?? {}, current.sentinels.done ?? {}),
  interrupted: diffContract(snapshot?.sentinels?.interrupted ?? {}, current.sentinels.interrupted ?? {}),
};
const sentinelBreaking = diffs.done.breaking || diffs.interrupted.breaking;

if (UPDATE) {
  console.log('\n[--update] 重写快照');
  if (!doneRaw || !interruptedRaw) {
    console.log('✗ 没取到哨兵，不写');
    failed += 1;
  } else if (snapshot && sentinelBreaking && snapshot.sentinel_schema === SENTINEL_SCHEMA) {
    console.log(
      `✗ 哨兵有破坏性改动，但 SENTINEL_SCHEMA 还是 ${SENTINEL_SCHEMA}：先在 src/sentinel.mjs 里加一并写进 CHANGELOG，或者把字段改回去。\n` +
        describe(diffs.done) + '\n' + describe(diffs.interrupted),
    );
    failed += 1;
  } else {
    writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2) + '\n', 'utf8');
    console.log(`  已写 ${SNAPSHOT}`);
    for (const [k, d] of Object.entries(diffs)) if (d.added.length || d.removed.length || d.changed.length) console.log(`  ${k}:\n    ${describe(d).replace(/\n/g, '\n    ')}`);
  }
} else {
  console.log('\n[3] 和快照对比（改动确认无误后用 --update 重写快照）');
  check('快照文件存在', Boolean(snapshot), `没有 ${SNAPSHOT}；跑一次 node test/contract.mjs --update`);
  check('快照记的 schema 与代码一致', snapshot?.sentinel_schema === SENTINEL_SCHEMA, `快照 ${snapshot?.sentinel_schema}，代码 ${SENTINEL_SCHEMA}`);
  check('MCP 工具面没有变化', !Object.values(diffs.tools).some((v) => Array.isArray(v) && v.length), describe(diffs.tools));
  check('完成哨兵的字段没有变化', !Object.values(diffs.done).some((v) => Array.isArray(v) && v.length), describe(diffs.done));
  check('中断哨兵的字段没有变化', !Object.values(diffs.interrupted).some((v) => Array.isArray(v) && v.length), describe(diffs.interrupted));
}

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(`\n===== contract: passed ${passed}, failed ${failed} =====`);
process.exit(failed ? 1 : 0);
