/**
 * dsh_doctor：只读体检（DSH 可执行文件与版本、profile、状态文件、runs/locks 目录、
 * live 事件流、孤儿锁、会话数与 RSS、生效配置）。只报告，不修改任何东西
 * （目录可写性用一个临时探测文件，写完立刻删掉）。
 *
 * 从 tools.mjs 拆出来：它是处理器表里最长的一项，且只依赖 `hub` 的两个只读字段
 * （conversations / hosts）与一批探测函数。返回值形状与原处理器一致：
 * `{ structured: { ok, verdict, checks }, text }`。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { refreshRssMap, rssMb } from './procstat.mjs';
import { liveSettings } from './live.mjs';
import { L } from './lang.mjs';

/** DSH 来源的英文叫法（中文用 dsh-locate 的 SOURCE_LABEL）。 */
const SOURCE_LABEL_EN = { env: 'DSH_BIN', desktop: 'desktop app', global: 'npm global', npx: 'npx cache' };
const sourceLabel = (source) => L(SOURCE_LABEL[source] ?? source, SOURCE_LABEL_EN[source] ?? source);

/** live 目录占用超过这个值就提醒（TTL 正常时远到不了）。 */
const LIVE_WARN_BYTES = 500 * 1024 * 1024;

/**
 * 体检 live 事件流：级别、目录可写、会话数、占用、最近一条事件的时间。
 * 返回 `[status, detail, fix]`，供 add('live', …) 使用。
 */
export function inspectLive({ dir = liveSettings().dir, level = liveSettings().level, now = Date.now() } = {}) {
  if (level === 'off') {
    return [
      'ok',
      L(
        `已关闭（DSH_MCP_LIVE=off）：watch / dashboard 看不到新的派活；目录 ${dir}`,
        `off (DSH_MCP_LIVE=off): watch / dashboard will not see new work; directory ${dir}`,
      ),
      null,
    ];
  }
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (e) {
    return [
      'warn',
      L(
        `级别=${level}，但目录不可写：${dir}（${e.message}）—— 派活不受影响，只是 watch / dashboard 看不到事件`,
        `level=${level}, but the directory is not writable: ${dir} (${e.message}) -- dispatching still works, watch / dashboard just see no events`,
      ),
      L('检查权限，或用 DSH_MCP_LIVE_DIR 指向可写目录', 'check permissions, or point DSH_MCP_LIVE_DIR at a writable directory'),
    ];
  }
  let convs = 0;
  let bytes = 0;
  let newest = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    convs++;
    for (const f of readdirSync(join(dir, ent.name), { withFileTypes: true })) {
      if (!f.isFile()) continue;
      try {
        const st = statSync(join(dir, ent.name, f.name));
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* 正在滚动 / 被清理：跳过 */
      }
    }
  }
  const mb = (bytes / 1024 / 1024).toFixed(1);
  const age = newest ? Math.round((now - newest) / 60000) : null;
  const last = newest
    ? age < 1
      ? L('最近一条事件：刚刚', 'last event: just now')
      : L(`最近一条事件：${age} 分钟前`, `last event: ${age} min ago`)
    : L('还没有任何事件', 'no events yet');
  const big = bytes > LIVE_WARN_BYTES;
  return [
    big ? 'warn' : 'ok',
    L(`级别=${level}，${dir}，${convs} 个会话，${mb}MB；${last}`, `level=${level}, ${dir}, ${convs} conversation(s), ${mb}MB; ${last}`),
    big
      ? L(
          '占用偏大：检查 DSH_MCP_SENTINEL_TTL_MS 是否被设成 0（关闭清理），或改用 DSH_MCP_LIVE=meta',
          'large: check whether DSH_MCP_SENTINEL_TTL_MS is 0 (cleanup disabled), or switch to DSH_MCP_LIVE=meta',
        )
      : null,
  ];
}

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
      `${bin}${version ? ` (DSH ${version})` : ''}` +
        L(`；来源=${sourceLabel(dsh.source)}；运行时=`, `; source=${sourceLabel(dsh.source)}; runtime=`) +
        (dsh.runtime === 'node' ? `node ${process.versions.node}` : dsh.command) +
        (fromNpx ? L(' —— 位于 npx 缓存，清缓存后会失效', ' -- inside the npx cache, gone once the cache is cleaned') : ''),
      fromNpx
        ? L(
            '安装 DeepSeek Harness 桌面版（会被自动识别），或 npm i -g @deepseek-ai/dsh',
            'install the DeepSeek Harness desktop app (detected automatically), or npm i -g @deepseek-ai/dsh',
          )
        : null,
    );

    // DSH 的 engines.node 与实际拉起它的运行时是否匹配（0.2.2 起要求 Node >= 24.9）。
    const runtimeNode = probeRuntimeNode(dsh);
    const engOk = satisfiesNodeRange(dsh.enginesNode, runtimeNode);
    add(
      'dsh_runtime',
      engOk === false ? 'warn' : 'ok',
      L(
        `运行时 Node ${runtimeNode ?? '未知'}，DSH 要求 ${dsh.enginesNode ?? '未声明'}`,
        `runtime Node ${runtimeNode ?? 'unknown'}, DSH requires ${dsh.enginesNode ?? 'nothing declared'}`,
      ) + (engOk === false ? L(' —— 不满足，部分能力可能异常', ' -- not satisfied, some features may misbehave') : ''),
      engOk === false
        ? dsh.runtime === 'node'
          ? L(
              '安装桌面版（自带满足要求的运行时，会被优先选用），或升级本机 Node，或用 DSH_RUNTIME 指定一个满足要求的 node',
              'install the desktop app (it bundles a runtime that qualifies and is preferred), upgrade the local Node, or point DSH_RUNTIME at a node that qualifies',
            )
          : L('更新桌面版，或用 DSH_RUNTIME 指定一个满足要求的 node', 'update the desktop app, or point DSH_RUNTIME at a node that qualifies')
        : null,
    );

    // GUI（桌面版）与本服务是不是同一份 DSH：两边共用 ~/.dsh 会话存储。
    const desktops = all.filter((c) => c.source === 'desktop');
    if (desktops.length === 0) {
      add('dsh_desktop', 'ok', L('未发现 DeepSeek Harness 桌面版（不影响使用）', 'DeepSeek Harness desktop app not found (not required)'));
    } else {
      const gui = desktops[0];
      const same = gui.version === version;
      add(
        'dsh_desktop',
        same ? 'ok' : 'warn',
        L(`桌面版 ${gui.version ?? '?'}（${gui.installDir}）`, `desktop app ${gui.version ?? '?'} (${gui.installDir})`) +
          (same
            ? L('，与本服务所用 DSH 一致', ', the same DSH this server uses')
            : L(
                `；本服务用的是 ${version ?? '?'}（${sourceLabel(dsh.source)}）—— 两者共用 ~/.dsh 会话，版本不一致时新版本写的会话可能被旧版本 resume`,
                `; this server uses ${version ?? '?'} (${sourceLabel(dsh.source)}) -- both share the ~/.dsh sessions, so a session written by the newer version may be resumed by the older one`,
              )),
        same
          ? null
          : dsh.source === 'env'
            ? L('去掉 DSH_BIN 让服务自动选用桌面版，或把 DSH_BIN 指向同版本', 'unset DSH_BIN so the server picks the desktop app, or point DSH_BIN at the same version')
            : L('升级/统一两边的 DSH 版本', 'bring both DSH installs to the same version'),
      );
    }
    if (all.length > 1) {
      add(
        'dsh_candidates',
        'ok',
        all.map((c) => `${sourceLabel(c.source)} ${c.version ?? '?'}${c === all[0] ? L('（自动选用）', ' (picked)') : ''}`).join(L('；', '; ')),
      );
    }

    const vs = dshVersionStatus(version);
    add(
      'dsh_version',
      vs.status,
      `${vs.level}: ${L(vs.note, vs.noteEn)}`,
      vs.status === 'ok'
        ? null
        : vs.level === 'unverified'
          ? L(
              '对照 docs/zh/compatibility.md；升级后跑一遍 npm test，必要时 npm run test:all',
              'see docs/en/compatibility.md; after upgrading run npm test, and npm run test:all if needed',
            )
          : L('升级到 DSH 0.1.7-rc.1 及以上', 'upgrade to DSH 0.1.7-rc.1 or newer'),
    );
  } catch (e) {
    add(
      'dsh_bin',
      'fail',
      e.message,
      L(
        '安装 DeepSeek Harness 桌面版（自动识别），或设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js',
        'install the DeepSeek Harness desktop app (detected automatically), or point DSH_BIN at @deepseek-ai/dsh/lib/bin.js',
      ),
    );
  }

  try {
    const p = inspectProfile();
    add(
      'profile',
      p.exists ? (p.drifted ? 'warn' : 'ok') : 'warn',
      `${p.dir} exists=${p.exists} managed=${p.managed} drifted=${p.drifted} routes=${p.routes.join(',') || 'none'}`,
      p.exists ? null : L('让服务首启自动创建，或运行 dsh-any-agent-setup', 'let the server create it on first start, or run dsh-any-agent-setup'),
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
    add('state', 'warn', `${STATE_FILE}: ${e.message}`, L('首次启动会自动创建', 'created automatically on first start'));
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
      add(id, 'fail', `${dir}: ${e.message}`, L('检查权限，或用对应环境变量指向可写目录', 'check permissions, or point the matching environment variable at a writable directory'));
    }
  }

  // live 事件流（watch / dashboard 的数据源）。可选功能、写失败不影响派活，
  // 所以有问题只报 warn，不报 fail；但"为什么 watch 里什么都看不到"要能从这里查出来。
  try {
    add('live', ...inspectLive());
  } catch (e) {
    add('live', 'warn', e.message);
  }

  try {
    const orphans = listOrphans();
    add(
      'orphan_locks',
      orphans.length ? 'warn' : 'ok',
      orphans.length
        ? L(`${orphans.length} 个孤儿锁持有者（可 dsh_takeover）`, `${orphans.length} orphaned lock holder(s) (use dsh_takeover)`)
        : L('没有孤儿锁', 'no orphaned locks'),
    );
  } catch (e) {
    add('orphan_locks', 'warn', e.message);
  }

  const all = [...hub.conversations.values()];
  const alive = all.filter((c) => c.proc?.alive);
  // ★ 共享进程下多个会话共用一个 PID：必须按 PID 去重，否则同一份 RSS 会被按会话
  //   重复累加，"RSS 合计"就会凭空翻几倍，把这行诊断变成误导。
  const livePids = new Set(alive.map((c) => c.proc?.pid).filter(Boolean));
  // 体检要准确数字：先异步刷新进程表（不阻塞事件循环），rssMb 读的就是刚刷新的缓存。
  await refreshRssMap({ force: true });
  let totalRss = 0;
  for (const pid of livePids) totalRss += rssMb(pid) ?? 0;
  add(
    'sessions',
    'ok',
    L(`共 ${all.length} 个会话，活进程 ${livePids.size} 个`, `${all.length} conversation(s), ${livePids.size} live process(es)`) +
      (SHARED_PROCESS
        ? L(`（共享宿主 ${hub.hosts?.size ?? 0} 个）`, ` (${hub.hosts?.size ?? 0} shared host(s))`)
        : L('（一会话一进程）', ' (one process per conversation)')) +
      L(`，RSS 合计 ${totalRss}MB`, `, RSS total ${totalRss}MB`),
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
      ? L(`on（profile=${DSH_PROFILE}）`, `on (profile=${DSH_PROFILE})`)
      : TEAM_MODE
        ? L(
            'requested but unavailable：DSH < 0.1.7-0，或该 profile 不含 team 包',
            'requested but unavailable: DSH < 0.1.7-0, or the profile lacks the team packages',
          )
        : L('off（opt-in：dsh-any-agent team on）', 'off (opt-in: dsh-any-agent team on)'),
    TEAM_ACTIVE
      ? null
      : TEAM_MODE
        ? L('检查 DSH 版本 / profile，或 dsh-any-agent team off', 'check the DSH version / profile, or run dsh-any-agent team off')
        : null,
  );

  const ok = !checks.some((c) => c.status === 'fail');
  const lines = checks.map(
    (c) =>
      `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗'} ${c.id}: ${c.detail}` +
      (c.fix ? ` → ${c.fix}` : ''),
  );
  return {
    structured: { ok, verdict: ok ? 'ok' : 'fail', checks },
    text: `${ok ? L('体检通过', 'All checks passed') : L('体检发现失败项', 'Some checks failed')}\n${lines.join('\n')}`,
  };
}
