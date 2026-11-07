/**
 * dsh_doctor：只读体检（DSH 可执行文件与版本、profile、状态文件、runs/locks 目录、
 * 孤儿锁、会话数与 RSS、生效配置）。只报告，不修改任何东西。
 *
 * 从 tools.mjs 拆出来：它是处理器表里最长的一项，且只依赖 `hub` 的两个只读字段
 * （conversations / hosts）与一批探测函数。返回值形状与原处理器一致：
 * `{ structured: { ok, verdict, checks }, text }`。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION,
  IDLE_TTL_MS,
  MAX_LIVE,
  MAX_RSS_MB,
  REVIEWS_DIR,
  RUNS_DIR,
  SHARED_PROCESS,
  STATE_FILE,
  TEAM_ACTIVE,
  TEAM_MODE,
  DSH_PROFILE,
  dshVersionStatus,
} from './config.mjs';
import {
  SOURCE_LABEL,
  discoverDsh,
  isNpxCachePath,
  probeRuntimeNode,
  resolveDsh,
  satisfiesNodeRange,
} from './dsh-locate.mjs';
import { inspectProfile } from './bootstrap.mjs';
import { listOrphans, LOCKS_DIR } from './locks.mjs';
import { rssMb } from './procstat.mjs';

export async function runDoctor(hub) {
  const checks = [];
  const add = (id, status, detail, fix = null) => checks.push({ id, status, detail, fix });

  try {
    // 体检总是重新探测（不吃 60 秒缓存）：用户刚装/升级完桌面版就来查，必须看到新结果。
    const all = discoverDsh({ fresh: true });
    const dsh = resolveDsh();
    const { bin, version } = dsh;
    const fromNpx = isNpxCachePath(bin);
    add(
      'dsh_bin',
      fromNpx ? 'warn' : 'ok',
      `${bin}${version ? ` (DSH ${version})` : ''}；来源=${SOURCE_LABEL[dsh.source] ?? dsh.source}` +
        `；运行时=${dsh.runtime === 'node' ? `node ${process.versions.node}` : dsh.command}` +
        (fromNpx ? ' —— 位于 npx 缓存，清缓存后会失效' : ''),
      fromNpx
        ? '安装 DeepSeek Harness 桌面版（会被自动识别），或 npm i -g @deepseek-ai/dsh'
        : null,
    );

    // DSH 的 engines.node 与实际拉起它的运行时是否匹配（0.2.2 起要求 Node >= 24.9）。
    const runtimeNode = probeRuntimeNode(dsh);
    const engOk = satisfiesNodeRange(dsh.enginesNode, runtimeNode);
    add(
      'dsh_runtime',
      engOk === false ? 'warn' : 'ok',
      `运行时 Node ${runtimeNode ?? '未知'}，DSH 要求 ${dsh.enginesNode ?? '未声明'}` +
        (engOk === false ? ' —— 不满足，部分能力可能异常' : ''),
      engOk === false
        ? dsh.runtime === 'node'
          ? '安装桌面版（自带满足要求的运行时，会被优先选用），或升级本机 Node，或用 DSH_RUNTIME 指定一个满足要求的 node'
          : '更新桌面版，或用 DSH_RUNTIME 指定一个满足要求的 node'
        : null,
    );

    // GUI（桌面版）与本服务是不是同一份 DSH：两边共用 ~/.dsh 会话存储。
    const desktops = all.filter((c) => c.source === 'desktop');
    if (desktops.length === 0) {
      add('dsh_desktop', 'ok', '未发现 DeepSeek Harness 桌面版（不影响使用）');
    } else {
      const gui = desktops[0];
      const same = gui.version === version;
      add(
        'dsh_desktop',
        same ? 'ok' : 'warn',
        `桌面版 ${gui.version ?? '?'}（${gui.installDir}）` +
          (same ? '，与本服务所用 DSH 一致' : `；本服务用的是 ${version ?? '?'}（${SOURCE_LABEL[dsh.source]}）—— 两者共用 ~/.dsh 会话，版本不一致时新版本写的会话可能被旧版本 resume`),
        same ? null : dsh.source === 'env' ? '去掉 DSH_BIN 让服务自动选用桌面版，或把 DSH_BIN 指向同版本' : '升级/统一两边的 DSH 版本',
      );
    }
    if (all.length > 1) {
      add(
        'dsh_candidates',
        'ok',
        all.map((c) => `${SOURCE_LABEL[c.source]} ${c.version ?? '?'}${c === all[0] ? '（自动选用）' : ''}`).join('；'),
      );
    }

    const vs = dshVersionStatus(version);
    add(
      'dsh_version',
      vs.status,
      `${vs.level}: ${vs.note}`,
      vs.status === 'ok'
        ? null
        : vs.level === 'unverified'
          ? '对照 docs/zh/compatibility.md；升级后跑一遍 npm test，必要时 npm run test:all'
          : '升级到 DSH 0.1.7-rc.1 及以上',
    );
  } catch (e) {
    add('dsh_bin', 'fail', e.message, '安装 DeepSeek Harness 桌面版（自动识别），或设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js');
  }

  try {
    const p = inspectProfile();
    add(
      'profile',
      p.exists ? (p.drifted ? 'warn' : 'ok') : 'warn',
      `${p.dir} exists=${p.exists} managed=${p.managed} drifted=${p.drifted} routes=${p.routes.join(',') || 'none'}`,
      p.exists ? null : '让服务首启自动创建，或运行 dsh-any-agent-setup',
    );
  } catch (e) {
    add('profile', 'fail', e.message);
  }

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    add(
      'state',
      raw.version === 1 ? 'ok' : 'warn',
      `${STATE_FILE} version=${raw.version} conversations=${raw.conversations?.length ?? 0}`,
    );
  } catch (e) {
    add('state', 'warn', `${STATE_FILE}: ${e.message}`, '首次启动会自动创建');
  }

  for (const [id, dir] of [
    ['runs_dir', RUNS_DIR],
    ['reviews_dir', REVIEWS_DIR],
    ['locks_dir', LOCKS_DIR],
  ]) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.doctor-${process.pid}`);
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
      add(id, 'ok', dir);
    } catch (e) {
      add(id, 'fail', `${dir}: ${e.message}`, '检查权限，或用对应环境变量指向可写目录');
    }
  }

  try {
    const orphans = listOrphans();
    add(
      'orphan_locks',
      orphans.length ? 'warn' : 'ok',
      orphans.length ? `${orphans.length} 个孤儿锁持有者（可 dsh_takeover）` : '没有孤儿锁',
    );
  } catch (e) {
    add('orphan_locks', 'warn', e.message);
  }

  const all = [...hub.conversations.values()];
  const alive = all.filter((c) => c.proc?.alive);
  // ★ 共享进程下多个会话共用一个 PID：必须按 PID 去重，否则同一份 RSS 会被按会话
  //   重复累加，"RSS 合计"就会凭空翻几倍，把这行诊断变成误导。
  const livePids = new Set(alive.map((c) => c.proc?.pid).filter(Boolean));
  let totalRss = 0;
  for (const pid of livePids) totalRss += rssMb(pid) ?? 0;
  add(
    'sessions',
    'ok',
    `共 ${all.length} 个会话，活进程 ${livePids.size} 个` +
      (SHARED_PROCESS ? `（共享宿主 ${hub.hosts?.size ?? 0} 个）` : '（一会话一进程）') +
      `，RSS 合计 ${totalRss}MB`,
  );
  add(
    'config',
    'ok',
    `profile=${DSH_PROFILE} team=${TEAM_ACTIVE ? 'on' : 'off'} permission=${DEFAULT_PERMISSION} ` +
      `idle_ttl=${IDLE_TTL_MS}ms max_live=${MAX_LIVE} max_rss=${MAX_RSS_MB}MB shared=${SHARED_PROCESS}`,
  );
  add(
    'team',
    TEAM_ACTIVE ? 'ok' : TEAM_MODE ? 'warn' : 'ok',
    TEAM_ACTIVE
      ? `on（profile=${DSH_PROFILE}）`
      : TEAM_MODE
        ? 'requested but unavailable：DSH < 0.1.7-0，或该 profile 不含 team 包'
        : 'off（opt-in：dsh-any-agent team on）',
    TEAM_ACTIVE ? null : TEAM_MODE ? '检查 DSH 版本 / profile，或 dsh-any-agent team off' : null,
  );

  const ok = !checks.some((c) => c.status === 'fail');
  const lines = checks.map(
    (c) =>
      `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗'} ${c.id}: ${c.detail}` +
      (c.fix ? ` → ${c.fix}` : ''),
  );
  return {
    structured: { ok, verdict: ok ? 'ok' : 'fail', checks },
    text: `${ok ? '体检通过' : '体检发现失败项'}\n${lines.join('\n')}`,
  };
}
