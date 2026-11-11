/**
 * 环境变量守卫测试（**不花 token**，纯模块加载 + 子进程）。
 *
 * 为什么值得钉住：这几个数值开关一旦被"猜错语义"，后果是不对称的 ——
 *   - `DSH_MCP_IDLE_TTL_MS=-1` 若被当成"立刻回收"，就等于主动把写锁让给 GUI ✗
 *   - `DSH_MCP_REAP_INTERVAL_MS=0` 会变成空转的紧循环 ✗
 *   - `DSH_MCP_LOCK_STALE_MS=0` 会让别的实例把我们看成"失联"，**合法地抢占并杀掉我们的回合** ✗✗
 * 所以约定：**非法/过小的值一律压到安全侧**，并由本测试固定下来。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

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

/** 在一个干净子进程里加载配置模块，读出三个数值。 */
function read(env) {
  // ★ Windows 上动态 import 必须用 file:// URL（否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  const cfg = pathToFileURL(join(REPO, 'src/config.mjs')).href;
  const lk = pathToFileURL(join(REPO, 'src/locks.mjs')).href;
  const code = `
    const a = await import(${JSON.stringify(cfg)});
    const b = await import(${JSON.stringify(lk)});
    process.stdout.write(JSON.stringify({
      ttl: a.IDLE_TTL_MS, reap: a.REAP_INTERVAL_MS, stale: b.STALE_MS, maxLive: a.MAX_LIVE,
      team: a.TEAM_MODE, active: a.TEAM_ACTIVE, profile: a.DSH_PROFILE,
      permission: a.DEFAULT_PERMISSION, allowFull: a.ALLOW_FULL_ACCESS,
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, ...env },
  });
  return JSON.parse(out.trim());
}

// 清掉可能从父进程继承来的值，保证"默认值"这一项测的是真默认
const cleanEnv = {
  DSH_MCP_IDLE_TTL_MS: '',
  DSH_MCP_REAP_INTERVAL_MS: '',
  DSH_MCP_LOCK_STALE_MS: '',
  DSH_MCP_PERMISSION: '',
  DSH_MCP_ALLOW_FULL_ACCESS: '',
  DSH_MCP_TEAM: '',
};
for (const k of Object.keys(cleanEnv)) delete process.env[k];

console.log('\n[1] 默认值');
const def = read({
  DSH_MCP_IDLE_TTL_MS: '',
  DSH_MCP_REAP_INTERVAL_MS: '',
  DSH_MCP_LOCK_STALE_MS: '',
  DSH_MCP_MAX_LIVE: '',
  DSH_MCP_PERMISSION: '',
  DSH_MCP_ALLOW_FULL_ACCESS: '',
  DSH_MCP_TEAM: '',
});
console.log('  ', JSON.stringify(def));
check('★ 默认 IDLE_TTL_MS = 600000（空闲 10 分钟回收）', def.ttl === 600_000, String(def.ttl));
check('默认回收间隔 30 秒', def.reap === 30_000, String(def.reap));
check('默认失联阈值 = 3×间隔', def.stale === 90_000, String(def.stale));
check('★★ 默认 MAX_LIVE = 4（内存有界是默认行为，不是要用户自己配）', def.maxLive === 4, String(def.maxLive));

console.log('\n[1a] 权限与团队：默认 workspace-write / 团队 opt-in');
check('★ 默认 permission = workspace-write', def.permission === 'workspace-write', def.permission);
check('★★ 默认不允许 danger-full-access', def.allowFull === false, String(def.allowFull));
check('默认 TEAM_MODE = false（opt-in）', def.team === false, String(def.team));
check('默认 profile 跟随团队是否可用', def.profile === (def.active ? 'dsh-team' : 'dsh-mcp'), def.profile);
const fullDefault = read({ DSH_MCP_PERMISSION: 'danger-full-access', DSH_MCP_ALLOW_FULL_ACCESS: '' });
check(
  '★ 客户端配置把默认档设成 danger-full-access 本身就算机器侧允许（setup --permission danger-full-access 写出的配置能用）',
  fullDefault.permission === 'danger-full-access' && fullDefault.allowFull === true,
  JSON.stringify(fullDefault),
);
const writeDefault = read({ DSH_MCP_PERMISSION: 'workspace-write', DSH_MCP_ALLOW_FULL_ACCESS: '' });
check('★ 默认档是 workspace-write 时，调用方不能自己要 full access', writeDefault.allowFull === false, String(writeDefault.allowFull));
check('DSH_MCP_ALLOW_FULL_ACCESS=1 仍然单独生效', read({ DSH_MCP_ALLOW_FULL_ACCESS: '1' }).allowFull === true);
const teamOn = read({ DSH_MCP_TEAM: '1' });
check('DSH_MCP_TEAM=1 → 团队开', teamOn.team === true, String(teamOn.team));
check('DSH_MCP_TEAM=1 时 profile 跟随可用性', teamOn.profile === (teamOn.active ? 'dsh-team' : 'dsh-mcp'), teamOn.profile);
const teamOff = read({ DSH_MCP_TEAM: '0' });
check('DSH_MCP_TEAM=0 → 团队关', teamOff.team === false, String(teamOff.team));
check('DSH_MCP_TEAM=0 → profile=dsh-mcp', teamOff.profile === 'dsh-mcp', teamOff.profile);
const explicitProfile = read({ DSH_MCP_PROFILE: 'my-team' });
check('显式 DSH_MCP_PROFILE 优先', explicitProfile.profile === 'my-team', explicitProfile.profile);

console.log('\n[1b] ★ 空串 = 未设置（`.env` 里写 `VAR=` 不该改变行为）');
// 这是实测踩到的坑：Number('') === 0，而 0 在这些开关里是有含义的极值
const blanks = read({
  DSH_MCP_IDLE_TTL_MS: '   ',
  DSH_MCP_REAP_INTERVAL_MS: '',
  DSH_MCP_LOCK_STALE_MS: '',
  DSH_MCP_MAX_LIVE: '',
});
console.log('  ', JSON.stringify(blanks));
check('★ 空串的 IDLE_TTL_MS → 默认 600000（10 分钟）', blanks.ttl === 600_000, String(blanks.ttl));
check('★ 空串的 REAP_INTERVAL_MS → 默认 30000（不是 0）', blanks.reap === 30_000, String(blanks.reap));
check('★ 空串的 LOCK_STALE_MS → 默认 90000', blanks.stale === 90_000, String(blanks.stale));
check('★★ 空串的 MAX_LIVE → 默认 4（不是 0=不限）', blanks.maxLive === 4, String(blanks.maxLive));

console.log('\n[1c] ★ MAX_LIVE 的取值边界');
for (const [v, want, label] of [
  ['4', 4, '4'],
  ['0', 0, '0（不限）'],
  ['-1', 0, '-1（压成不限）'],
  ['abc', 4, 'abc（非法 → 用默认 4，不是"不限"）'],
  ['2.7', 2, '2.7（取整）'],
]) {
  const r = read({ DSH_MCP_MAX_LIVE: v });
  check(`MAX_LIVE=${label} → ${want}`, r.maxLive === want, String(r.maxLive));
}

console.log('\n[2] ★ 奇怪的 IDLE_TTL_MS：显式 0/负数 = 永不回收，非法/空串 = 默认 10 分钟');
for (const [v, want, label] of [
  ['0', 0, '0'],
  ['-1', 0, '-1（负数 → 永不回收）'],
  ['abc', 600_000, 'abc（非法 → 默认 600000）'],
  ['', 600_000, '（空串 → 默认 600000）'],
]) {
  const r = read({ DSH_MCP_IDLE_TTL_MS: v });
  check(`IDLE_TTL_MS=${label} → ${want}`, r.ttl === want, String(r.ttl));
}
for (const v of ['1000', '60000']) {
  const r = read({ DSH_MCP_IDLE_TTL_MS: v });
  check(`IDLE_TTL_MS=${v} → 原样生效`, r.ttl === Number(v), String(r.ttl));
}

console.log('\n[3] ★ 回收间隔过小会变紧循环 → 压回默认');
for (const v of ['0', '-5', '10', '199']) {
  const r = read({ DSH_MCP_REAP_INTERVAL_MS: v });
  check(`间隔=${v} → 30000（下限 200ms）`, r.reap === 30_000, String(r.reap));
}
for (const v of ['200', '400', '1500']) {
  const r = read({ DSH_MCP_REAP_INTERVAL_MS: v });
  check(`间隔=${v} 原样生效（测试要靠它调小时序）`, r.reap === Number(v), String(r.reap));
}

console.log('\n[4] ★★ 失联阈值过小会让别的实例"合法地"抢占我们 → 下限 30 秒');
for (const v of ['0', '-1', '1000', '29999']) {
  const r = read({ DSH_MCP_LOCK_STALE_MS: v });
  check(`失联阈值=${v} → 被压到 ≥30000`, r.stale >= 30_000, String(r.stale));
}
const okStale = read({ DSH_MCP_LOCK_STALE_MS: '120000' });
check('失联阈值=120000 原样生效', okStale.stale === 120_000, String(okStale.stale));

console.log(`\n===== 环境变量守卫测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);