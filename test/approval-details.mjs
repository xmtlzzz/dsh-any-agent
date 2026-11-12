/** Approval context and lifecycle regression: no DSH process or model request. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-approval-details-'));
process.env.DSH_MCP_STATE = join(root, 'state.json');
process.env.DSH_MCP_APPROVAL = 'auto-allow';
const { Hub, Conversation } = await import('../src/hub.mjs');
const { createHandlers } = await import('../src/tools.mjs');
const logs = [];
const hub = new Hub({ log: { info: (s) => logs.push(s), debug() {} } });
const conv = new Conversation({ id: 'approval-context-test', cwd: root, permission: 'workspace-write', onApproval: 'ask' }, hub);
hub.conversations.set(conv.id, conv);
const handlers = createHandlers(hub);
const options = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];
const request = (rawInput = {}, title = 'Run local probe') => ({
  toolCall: { toolCallId: 'call-approval-test', name: 'pwsh', title, kind: 'execute', rawInput, locations: [{ path: join(root, 'probe.cjs') }] },
  options,
});
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`  ✓ ${name}`); }

try {
  console.log('\n[1] ask exposes actionable context without replacing the ID list');
  const outcome = conv.onPermissionRequest(request({ command: 'node ./probe.cjs', description: 'Run read-only production probe', justification: 'Allow local child process', workdir: root }));
  const snap = conv.snapshot();
  const id = snap.pending_approvals[0];
  check('existing pending_approvals remains an ID array', () => assert.deepEqual(snap.pending_approvals, [id]));
  const detail = snap.pending_approval_details[0];
  check('details correlate with the original approval ID', () => assert.equal(detail.approval_id, id));
  check('tool identity and call ID are available', () => assert.deepEqual([detail.tool, detail.tool_call_id, detail.kind], ['pwsh', 'call-approval-test', 'execute']));
  check('exact non-sensitive command and working directory are available', () => assert.deepEqual([detail.input.command, detail.input.workdir], ['node ./probe.cjs', root]));
  check('reason, description, locations and choices are available', () => {
    assert.equal(detail.reason, 'Allow local child process');
    assert.equal(detail.description, 'Run read-only production probe');
    assert.equal(detail.locations[0].path, join(root, 'probe.cjs'));
    assert.deepEqual(detail.options, options);
  });
  const get = await handlers.dsh_get({ conversation_id: conv.id });
  const status = await handlers.dsh_status({ conversation_id: conv.id });
  check('dsh_get returns approval details and a brief readable summary', () => {
    assert.equal(get.structured.pending_approval_details[0].input.command, 'node ./probe.cjs');
    assert.match(get.text, /Allow local child process/);
  });
  check('dsh_status returns the same actionable details', () => assert.deepEqual(status.structured.pending_approval_details, get.structured.pending_approval_details));
  check('readable summary avoids dumping the whole command input', () => assert.ok(!get.text.includes('node ./probe.cjs')));
  hub.save();
  const persisted = readFileSync(process.env.DSH_MCP_STATE, 'utf8');
  check('approval context is absent from the saved registry', () => {
    assert.ok(!persisted.includes('pending_approval'));
    assert.ok(!persisted.includes('node ./probe.cjs'));
    assert.ok(!persisted.includes('Allow local child process'));
  });
  check('operation context is absent from the logger', () => assert.ok(!logs.some((line) => line.includes('node ./probe.cjs'))));
  await handlers.dsh_approval_decide({ conversation_id: conv.id, approval_id: id, decision: 'allow' });
  const allowed = await outcome;
  check('allow selects the original ACP option', () => assert.deepEqual(allowed, { outcome: { outcome: 'selected', optionId: 'allow-once' } }));
  check('allow clears both pending lists', () => {
    assert.deepEqual(conv.snapshot().pending_approvals, []);
    assert.deepEqual(conv.snapshot().pending_approval_details, []);
  });

  console.log('\n[2] credential fields and common inline literals are redacted');
  const hidden = conv.onPermissionRequest(request({
    command: 'node ./probe.cjs --api-key SYNTHETIC_FLAG_CREDENTIAL; TOKEN=SYNTHETIC_ASSIGNMENT; Write-Output sk-SYNTHETIC_CREDENTIAL_123',
    justification: 'Authorization: Bearer SYNTHETIC_BEARER_CREDENTIAL',
    apiKey: 'SYNTHETIC_FIELD_CREDENTIAL',
    nested: { password: 'SYNTHETIC_PASSWORD', access_token: 'SYNTHETIC_ACCESS_TOKEN' },
    env: { KEY: 'SYNTHETIC_ENV_CREDENTIAL' },
    headers: { Authorization: 'SYNTHETIC_HEADER_CREDENTIAL' },
    endpoint: 'https://user:SYNTHETIC_URL_PASSWORD@example.invalid/api',
  }, 'Run local probe token=SYNTHETIC_TITLE_CREDENTIAL'));
  const secretSnap = conv.snapshot();
  check('structured context and displayed title redact synthetic credentials', () => assert.ok(!JSON.stringify(secretSnap.pending_approval_details).includes('SYNTHETIC_')));
  check('command shape remains reviewable after redaction', () => assert.match(secretSnap.pending_approval_details[0].input.command, /^node \.\/probe\.cjs --api-key \[REDACTED\]/));
  check('secret values in titles are not logged', () => assert.ok(!logs.some((line) => line.includes('SYNTHETIC_'))));
  conv.decideApproval(secretSnap.pending_approvals[0], 'deny');
  const rejected = await hidden;
  check('deny selects the original reject option and clears context', () => {
    assert.deepEqual(rejected, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
    assert.deepEqual(conv.snapshot().pending_approval_details, []);
  });

  console.log('\n[3] timeout and automatic policies keep their previous behavior');
  hub.approvalTimeoutMs = 5;
  const timed = await conv.onPermissionRequest(request({ command: 'node ./probe.cjs' }));
  check('expired approval is cancelled and details disappear', () => {
    assert.deepEqual(timed, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(conv.snapshot().pending_approvals, []);
    assert.deepEqual(conv.snapshot().pending_approval_details, []);
  });
  conv.onApproval = 'auto-allow';
  const automaticAllow = await conv.onPermissionRequest(request());
  check('auto-allow does not introduce pending context', () => {
    assert.equal(automaticAllow.outcome.optionId, 'allow-once');
    assert.deepEqual(conv.snapshot().pending_approval_details, []);
  });
  conv.onApproval = 'auto-deny';
  const automaticDeny = await conv.onPermissionRequest(request());
  check('auto-deny does not introduce pending context', () => {
    assert.equal(automaticDeny.outcome.optionId, 'reject-once');
    assert.deepEqual(conv.snapshot().pending_approval_details, []);
  });

  console.log('\n[3b] real DSH payload: correlate toolCallId with the recorded tool_call update');
  // 真实 DSH 的 session/request_permission 只带 toolCallId，不带 rawInput。
  // 参数通常在先前的 tool_call 更新里，必须按 id 关联回来，否则审批上下文为空。
  const correlated = new Conversation({ id: 'approval-correlated-test', cwd: root, permission: 'workspace-write', onApproval: 'ask' }, hub);
  correlated.collector = {
    tools: new Map([
      ['call-correlated', { name: 'pwsh', title: 'Run correlated probe', kind: 'execute', input: { command: 'node ./correlated.cjs', justification: 'seen in tool_call update' } }],
    ]),
  };
  const correlatedOutcome = correlated.onPermissionRequest({ toolCall: { toolCallId: 'call-correlated' }, options });
  const correlatedSnap = correlated.snapshot();
  const correlatedDetail = correlatedSnap.pending_approval_details[0];
  check('missing rawInput is filled from the recorded tool_call update', () => {
    assert.equal(correlatedDetail.input.command, 'node ./correlated.cjs');
    assert.equal(correlatedDetail.reason, 'seen in tool_call update');
    assert.deepEqual([correlatedDetail.tool, correlatedDetail.kind], ['pwsh', 'execute']);
  });
  correlated.decideApproval(correlatedSnap.pending_approvals[0], 'deny');
  await correlatedOutcome;
  correlated.collector = null;

  console.log('\n[3c] closing a conversation cancels and clears pending approvals');
  const closing = new Conversation({ id: 'approval-close-test', cwd: root, permission: 'workspace-write', onApproval: 'ask' }, hub);
  const closingOutcome = closing.onPermissionRequest(request());
  check('pending approval is registered before close', () => assert.equal(closing.snapshot().pending_approvals.length, 1));
  await closing.close();
  const closedApproval = await closingOutcome;
  check('close resolves the approval as cancelled and clears the list', () => {
    assert.deepEqual(closedApproval, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(closing.snapshot().pending_approvals, []);
    assert.deepEqual(closing.snapshot().pending_approval_details, []);
  });

  console.log('\n[3d] auto-allow records what it approved (visible to the caller, redacted)');
  {
    const { buildReviewTicket } = await import('../src/review.mjs');
    const { sanitizeResultForSentinel } = await import('../src/hub.mjs');
    const auto = new Conversation({ id: 'approval-auto-test', cwd: root, permission: 'workspace-write', onApproval: 'auto-allow' }, hub);
    auto.collector = { tools: new Map(), autoApprovals: [], autoApprovalTotal: 0, autoEscalationTotal: 0 };
    await auto.onPermissionRequest(request({
      command: 'npm test --token sk-abcdefghijklmnop1234',
      sandbox_permissions: 'danger-full-access',
      justification: 'child_process pipes are blocked by the sandbox',
    }));
    await auto.onPermissionRequest(request({ command: 'git status' }));
    const c = auto.collector;
    check('every auto-allowed approval is counted', () => assert.equal(c.autoApprovalTotal, 2));
    check('sandbox escalations are counted separately', () => assert.equal(c.autoEscalationTotal, 1));
    check('summary keeps tool, escalation and reason', () => {
      assert.equal(c.autoApprovals[0].tool, 'pwsh');
      assert.equal(c.autoApprovals[0].escalation, 'danger-full-access');
      assert.match(c.autoApprovals[0].reason, /child_process pipes/);
      assert.equal(c.autoApprovals[1].escalation, null);
    });
    check('command preview is redacted', () => {
      assert.match(c.autoApprovals[0].command_preview, /^npm test --token \[REDACTED\]/);
      assert.ok(!JSON.stringify(c.autoApprovals).includes('sk-abcdefghijklmnop1234'));
    });
    for (let i = 0; i < 30; i++) await auto.onPermissionRequest(request({ command: `echo ${i}` }));
    check('kept summaries are capped but the total keeps counting', () => {
      assert.equal(c.autoApprovals.length, 20);
      assert.equal(c.autoApprovalTotal, 32);
    });
    auto.collector = null;
    const outsideTurn = await auto.onPermissionRequest(request());
    check('approval outside a turn is still allowed and does not throw', () => assert.equal(outsideTurn.outcome.optionId, 'allow-once'));

    const result = {
      stop_reason: 'end_turn',
      tools_used: [{ title: 'pwsh' }],
      workspace_changed: true,
      diff_stat: { changed_files: 1 },
      auto_approvals_total: 32,
      auto_escalations_total: 1,
      auto_approvals: c.autoApprovals,
    };
    const ticket = buildReviewTicket({ conversationId: auto.id, runId: 'run-auto-1', result, permission: 'workspace-write' });
    check('review evidence carries the auto-approval counts', () => {
      assert.equal(ticket.evidence.auto_approvals, 32);
      assert.equal(ticket.evidence.auto_escalations, 1);
    });
    check('review checklist names the escalations and points at on_approval=ask', () => {
      const item = ticket.checklist.find((x) => x.includes('自动放行'));
      assert.ok(item, JSON.stringify(ticket.checklist));
      assert.match(item, /32 次/);
      assert.match(item, /1 次申请了沙箱提权/);
      assert.match(item, /on_approval=ask/);
    });
    const quiet = buildReviewTicket({ conversationId: auto.id, runId: 'run-auto-2', result: { ...result, auto_approvals_total: 0, auto_escalations_total: 0, auto_approvals: [] } });
    check('no auto-approval item when nothing was auto-approved', () =>
      assert.ok(!quiet.checklist.some((x) => x.includes('自动放行'))));
    const sentinelCopy = sanitizeResultForSentinel({
      ...result,
      auto_approvals: [{ tool: 'pwsh', command_preview: 'curl -H "Authorization: Bearer abc.def.ghi" https://x', reason: 'password=hunter2' }],
    });
    check('sentinel copy re-redacts auto-approval summaries', () => {
      const s = JSON.stringify(sentinelCopy.auto_approvals);
      assert.ok(!s.includes('abc.def.ghi'), s);
      assert.ok(!s.includes('hunter2'), s);
    });
  }

  console.log('\n[3e] approval rules as a pure function (approval-policy.mjs)');
  {
    const { approvalDecision, escalationOf } = await import('../src/approval-policy.mjs');
    check('read-only denies even when configured auto-allow or ask', () => {
      assert.equal(approvalDecision({ permission: 'read-only', onApproval: 'auto-allow' }), 'deny');
      assert.equal(approvalDecision({ permission: 'read-only', onApproval: 'ask' }), 'deny');
    });
    check('writable tiers follow on_approval', () => {
      assert.equal(approvalDecision({ permission: 'workspace-write', onApproval: 'auto-allow' }), 'allow');
      assert.equal(approvalDecision({ permission: 'workspace-write', onApproval: 'auto-deny' }), 'deny');
      assert.equal(approvalDecision({ permission: 'danger-full-access', onApproval: 'ask' }), 'ask');
    });
    check('escalationOf reads sandbox_permissions only when it is a string', () => {
      assert.equal(escalationOf({ sandbox_permissions: 'danger-full-access' }), 'danger-full-access');
      assert.equal(escalationOf({ sandbox_permissions: 1 }), null);
      assert.equal(escalationOf(null), null);
    });
  }

  console.log('\n[4] actual stdio MCP structuredContent preserves review context');
  const harness = `
    import { Hub, Conversation } from ${JSON.stringify(new URL('../src/hub.mjs', import.meta.url).href)};
    import { createMcpServer } from ${JSON.stringify(new URL('../src/mcp.mjs', import.meta.url).href)};
    const hub = new Hub();
    const conv = new Conversation({id:'approval-stdio-test',cwd:${JSON.stringify(root)},permission:'workspace-write',onApproval:'ask'},hub);
    hub.conversations.set(conv.id,conv);
    void conv.onPermissionRequest({toolCall:{title:'Local read-only probe',name:'pwsh',toolCallId:'stdio-probe',rawInput:{command:'node ./probe.cjs',justification:'Review local execution'}},options:[{optionId:'yes',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Deny'}]});
    createMcpServer({hub}).start();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    env: { ...process.env, DSH_HOME: join(root, 'protocol-home') },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let serial = 0;
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    clearTimeout(handler.timer);
    message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    check('stdio initialization uses the actual MCP server', () => assert.equal(initialized.serverInfo.name, 'dsh-any-agent'));
    const transportGet = await rpc('tools/call', { name: 'dsh_get', arguments: { conversation_id: 'approval-stdio-test' } });
    const transportDetail = transportGet.structuredContent.pending_approval_details[0];
    check('dsh_get stdio result includes command, reason and original approval ID', () => {
      assert.equal(transportDetail.input.command, 'node ./probe.cjs');
      assert.equal(transportDetail.reason, 'Review local execution');
      assert.equal(transportDetail.approval_id, transportGet.structuredContent.pending_approvals[0]);
    });
    const transportStatus = await rpc('tools/call', { name: 'dsh_status', arguments: { conversation_id: 'approval-stdio-test' } });
    check('dsh_status stdio result includes the same approval context', () => assert.deepEqual(transportStatus.structuredContent.pending_approval_details, [transportDetail]));
    await rpc('tools/call', { name: 'dsh_approval_decide', arguments: { conversation_id: 'approval-stdio-test', approval_id: transportDetail.approval_id, decision: 'deny' } });
    const transportAfter = await rpc('tools/call', { name: 'dsh_get', arguments: { conversation_id: 'approval-stdio-test' } });
    check('stdio decision clears the pending operation', () => assert.deepEqual(transportAfter.structuredContent.pending_approval_details, []));
    check('stdio test emits no diagnostic stderr', () => assert.equal(stderr, ''));
  } finally {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(new Error('test closing')); }
    lines.close();
    child.stdin.end();
    child.kill();
  }
  console.log(`\n===== Approval details regression: passed ${checks}, failed 0 =====`);
} finally {
  for (const id of conv.pendingApprovals.keys()) conv.decideApproval(id, 'deny');
  rmSync(root, { recursive: true, force: true });
}
