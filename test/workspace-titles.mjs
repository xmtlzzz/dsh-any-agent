/**
 * 工作区与标题的两个真实行为回归。
 *
 * 两个问题都是在 Claude Code 里实跑 dsh-any-agent 时发现的，不是猜出来的：
 *
 *   1. cwd 选成用户家目录本身时，DSH 自己的 ACL 沙箱起不来，因为 Windows 的
 *      %TEMP% 就在家目录里面，而沙箱要求临时目录在工作区之外。报错出现在
 *      第一次起 shell 的时候，看起来像这个服务坏了。现在在建会话时就拦下，
 *      并把原因和两条出路说清楚。
 *
 *   2. dsh_get 里的 title 是「这是一次连通性冒烟测试，请」这种被截断的 prompt
 *      前缀 —— 那是 DSH 自己的标题行为（首条消息截断），不是 title_hint 被覆盖。
 *      但调用方给了 title_hint 却完全看不到，所以现在两者分开返回。
 *
 * 都只加载模块、不拉起 DSH，可以进 CI。
 */

import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Conversation, Hub, homeWorkspaceProblem } from '../src/hub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};

const home = homedir();
const temp = tmpdir();

// ── 1. 家目录当选工作区 ─────────────────────────────────────────────

console.log('\n[1] cwd = 家目录：建会话前就拦住，并说清楚原因');

check('workspace-write 下拒绝', Boolean(homeWorkspaceProblem(home, 'workspace-write')));
check('danger-full-access 下拒绝', Boolean(homeWorkspaceProblem(home, 'danger-full-access')));
check('read-only 下放行（不写盘，不需要 ACL 沙箱）',
  homeWorkspaceProblem(home, 'read-only') === null);
check('普通项目目录放行',
  homeWorkspaceProblem(join(home, 'some-project'), 'workspace-write') === null);
check('大小写不敏感（Windows）',
  Boolean(homeWorkspaceProblem(home.toUpperCase(), 'workspace-write')));
check('带尾部分隔符也认得出', Boolean(homeWorkspaceProblem(home + sep, 'workspace-write')));

{
  const msg = homeWorkspaceProblem(home, 'workspace-write') || '';
  check('文案点名了 DSH 真正会报的那句',
    msg.includes('temp root must be outside the workspace'), msg);
  check('文案给出了两条出路',
    msg.includes('read-only') && msg.includes('danger-full-access'), msg);
  check('文案没有把家目录路径写错', msg.includes(home), msg);
  if (temp.toLowerCase().startsWith(home.toLowerCase())) {
    check('文案指出 temp 就在工作区里（本机确实如此）', msg.includes(temp), msg);
  } else {
    console.log('  ---  本机 temp 不在家目录内，相关断言跳过');
  }
}

// ── 2. title_hint 不被 DSH 自动标题吞掉 ─────────────────────────────

console.log('\n[2] title_hint 与 DSH 自动标题分成两个字段返回');

check('Hub 与 Conversation 都可以导入',
  typeof Hub === 'function' && typeof Conversation === 'function');

// snapshot() 依赖磁盘投影缓存；这里直接验证字段约定：两个字段都存在且互不覆盖。
{
  // 用一个最小替身走 snapshot 的标题决策，避免拉起 DSH。
  // snapshot 属于 Conversation，不属于 Hub —— 这里曾经写错，被断言抓到了。
  const conv = Object.create(Conversation.prototype);
  conv.id = 'nonexistent-session-for-test';
  conv.titleHint = '可读标签';
  // snapshot 会读几个宿主字段，补齐它们但**不拉起 DSH**。
  conv.turnCount = 0;
  conv.createdAt = Date.now();
  conv.lastUsedAt = Date.now();
  conv.cfg = {};
  conv.workspace = null;
  conv.pendingApprovals = new Map();
  let snap = null;
  try {
    snap = conv.snapshot();
  } catch (e) {
    console.log('         snapshot threw: ' + e.message);
    snap = null;
  }
  check('snapshot 可以被调用（会话不存在也不抛）', snap !== null);
  if (snap) {
    check('title 字段存在', 'title' in snap);
    check('title_hint 字段单独存在并保留原值',
      snap.title_hint === '可读标签', JSON.stringify(snap.title_hint));
    check('会话不存在时 title 退回 title_hint',
      snap.title === '可读标签', JSON.stringify(snap.title));
  }
}

console.log('\n===== workspace & titles: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);