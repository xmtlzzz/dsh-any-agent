/**
 * 运行期配置与路径解析。
 *
 * 设计原则：所有外部依赖（DSH 安装位置、profile 名、状态文件位置）都能用环境变量覆盖，
 * 因为本服务是被 Codex/Claude 以未知环境拉起的。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmpVersion, resolveDsh } from './dsh-locate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(HERE, '..');

/** 包版本（与 package.json 单一来源；ACP clientInfo 也用它，避免硬编码漂移）。 */
export const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * DSH 的发现与拉起方式见 dsh-locate.mjs：自动识别桌面版（asar + 自带 Electron 运行时）、
 * npm 全局与 npx 缓存，DSH_BIN 只作显式覆盖。这里转出给其余模块用。
 */
export { cmpVersion, discoverDsh, isNpxCachePath, resolveDsh } from './dsh-locate.mjs';

/**
 * 只要 DSH 入口路径（兼容旧调用方；桌面版时是 asar 内部路径，普通 fs 读不到）。
 * 要拉起 DSH 请用 resolveDsh()：它同时给出运行时与环境变量。
 */
export function resolveDshBin() {
  return resolveDsh().bin;
}

/**
 * 兼容性矩阵（docs/zh/compatibility.md）的机器可读版本，供 dsh_doctor 使用。
 * 改矩阵时同步改这里：`[verifiedMin, verifiedBelow)` 是“已验证”区间。
 * 用 `-0` 后缀是为了把同号的 rc 版本也算进去（semver 里 `0.1.7-rc.1 < 0.1.7`）。
 * 0.2.x：2026-11-06 用 0.2.1-rc.5（npm）与 0.2.2-rc.1（桌面版自带运行时）跑过全量套件。
 *
 * `[rerunMin, rerunBelow)` 是**当前这条发布线**（rerunLine）重新跑过全量套件的 DSH 版本；
 * 已验证区间里的其它版本，最近一次实测停在 earlierLine。体检要把这两种情况说清楚，
 * 不能把"上一条线验证过"说成"本版本验证过"。
 */
export const DSH_COMPAT = Object.freeze({
  partialMin: '0.1.5-0',
  verifiedMin: '0.1.7-0',
  verifiedBelow: '0.2.3-0',
  verifiedLabel: '0.1.7 ~ 0.2.2',
  rerunMin: '0.2.1-0',
  rerunBelow: '0.2.2-0',
  rerunLine: '0.6.x',
  earlierLine: '0.5.x',
});

/**
 * 给一个 DSH 版本打兼容性档位：ok（已验证）/ warn（部分可用、未验证或读不到）。
 * 只是体检提示，不拦启动 —— 未验证不等于不能用。
 *
 * `note` 是中文、`noteEn` 是英文：config 不能 import lang.mjs（lang → live-view → live → config
 * 会成环），所以两种文字都给，由调用方按语言挑。
 */
export function dshVersionStatus(version) {
  const C = DSH_COMPAT;
  if (!version) {
    return {
      status: 'warn',
      level: 'unknown',
      note: '读不到 DSH 版本（package.json 缺失或不可读）',
      noteEn: 'could not read the DSH version (package.json missing or unreadable)',
    };
  }
  if (cmpVersion(version, C.partialMin) < 0) {
    return {
      status: 'warn',
      level: 'unsupported',
      note: `DSH ${version} 低于已知可用的最低版本 0.1.5`,
      noteEn: `DSH ${version} is older than 0.1.5, the lowest version known to work`,
    };
  }
  if (cmpVersion(version, C.verifiedMin) < 0) {
    return {
      status: 'warn',
      level: 'partial',
      note: `DSH ${version} 部分可用：ACP 基本路径可用，缺 team 包`,
      noteEn: `DSH ${version} partly works: the ACP basics do, the team packages are missing`,
    };
  }
  if (cmpVersion(version, C.verifiedBelow) < 0) {
    const rerun = cmpVersion(version, C.rerunMin) >= 0 && cmpVersion(version, C.rerunBelow) < 0;
    return {
      status: 'ok',
      level: 'verified',
      rerun,
      note: rerun
        ? `DSH ${version} 已用 ${C.rerunLine} 跑过全量套件`
        : `DSH ${version} 在已验证区间（${C.verifiedLabel}），但最近一次全量实测是 ${C.earlierLine}；${C.rerunLine} 没有对它重跑`,
      noteEn: rerun
        ? `DSH ${version} passed the full suite on ${C.rerunLine}`
        : `DSH ${version} is in the verified range (${C.verifiedLabel}), but its last full run was on ${C.earlierLine}; ${C.rerunLine} did not re-run it`,
    };
  }
  return {
    status: 'warn',
    level: 'unverified',
    note: `DSH ${version} 未经本版本验证（兼容性矩阵覆盖 ${C.verifiedLabel}），ACP session/* 面可能有变化`,
    noteEn: `DSH ${version} is not verified with this version (the compatibility matrix covers ${C.verifiedLabel}); the ACP session/* surface may have changed`,
  };
}

/**
 * DSH 主目录。**默认就是本机用户自己的 ~/.dsh** —— 本服务不拥有独立的 home，
 * 因此凭据（.credentials.yaml）、会话历史、工作区登记与 GUI 完全共用一份。
 *
 * 环境变量仍然保留，但只作高级用途（隔离测试、多账号）：
 * 一旦指向别的目录，就要自己准备那个目录下的凭据与 profile。
 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/**
 * 团队开关（0.5.0 起默认关闭，按需开启）。
 *
 * 优先级：`DSH_MCP_TEAM` 环境变量 > `<DSH_HOME>/.dsh-any-agent/settings.json`
 * 的 `team` 字段 > 默认关闭。用 `dsh-any-agent team on|off` 写这个文件，
 * 不必手改客户端配置。
 */
export const TEAM_SETTINGS_FILE =
  process.env.DSH_MCP_SETTINGS ?? join(DSH_HOME, '.dsh-any-agent', 'settings.json');

function readTeamSetting() {
  try {
    const j = JSON.parse(readFileSync(TEAM_SETTINGS_FILE, 'utf8'));
    return typeof j.team === 'boolean' ? j.team : null;
  } catch {
    return null;
  }
}

export const TEAM_MODE_SOURCE = (() => {
  const v = process.env.DSH_MCP_TEAM;
  if (v !== undefined && String(v).trim() !== '') return 'env';
  return readTeamSetting() === null ? 'default' : 'file';
})();

export const TEAM_MODE = (() => {
  const v = process.env.DSH_MCP_TEAM;
  if (v !== undefined && String(v).trim() !== '') {
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
  }
  return readTeamSetting() ?? false;
})();

/** 运行中的 DSH 版本（读不到为 null）。 */
export const DSH_VERSION = (() => {
  try {
    return resolveDsh().version ?? null;
  } catch {
    return null;
  }
})();

// 注意用 `0.1.7-0` 而不是 `0.1.7`：semver 里 `0.1.7-rc.1 < 0.1.7`，
// 但 team 包正是随 0.1.7-rc.1 发布的。
const teamVersionOk = DSH_VERSION === null || cmpVersion(DSH_VERSION, '0.1.7-0') >= 0;

/** 用于驱动 DSH 的 profile（由 bootstrap 在首启时按 acp 模板创建）。 */
export const DSH_PROFILE =
  process.env.DSH_MCP_PROFILE ?? (TEAM_MODE && teamVersionOk ? 'dsh-team' : 'dsh-mcp');

/**
 * 团队能力是否真正可用：
 *   - 用户没有关（TEAM_MODE）；
 *   - DSH >= 0.1.7（team 包从 0.1.7 才有）；
 *   - **profile 里真的含 team 包**（显式指定了不含 team 的 profile 时不注入，
 *     否则模型会看到一个不存在的工具）。
 * profile 还不存在时（首启）交给 bootstrap 创建，视为可用。
 */
const profileTeamText = (() => {
  try {
    return readFileSync(join(DSH_HOME, 'profiles', DSH_PROFILE, 'cordis.patch.yml'), 'utf8');
  } catch {
    return null;
  }
})();

export const TEAM_ACTIVE =
  TEAM_MODE &&
  teamVersionOk &&
  (profileTeamText === null || profileTeamText.includes('@deepseek-ai/dsh-experimental-agent-team'));

/**
 * 是否允许 bootstrap 自动创建/同步 DSH profile（默认开）。
 * 关掉（DSH_MCP_BOOTSTRAP=0）后本服务只驱动已存在的 profile，不再写任何文件。
 */
export const BOOTSTRAP_ENABLED = (() => {
  const v = process.env.DSH_MCP_BOOTSTRAP;
  if (v === undefined || String(v).trim() === '') return true;
  return !(v === '0' || v.toLowerCase() === 'false');
})();

/**
 * 抄路由时**只**用这个 profile（默认空 = 按 home 层 → desktop → web → headless → acp 顺序找）。
 * 需要固定来源时设成 profile 名，或设成 '__home__' 表示只认 $DSH_HOME/cordis.patch.yml。
 */
export const ROUTE_SOURCE_PROFILE = (() => {
  const v = process.env.DSH_MCP_ROUTE_SOURCE;
  return v === undefined || String(v).trim() === '' ? null : String(v).trim();
})();

/**
 * 会话注册表（跨 MCP 服务重启存活）。
 *
 * ★ 默认放在 **$DSH_HOME/.dsh-any-agent/**，不再放在包安装目录里。
 *   全局安装到只读位置（sudo / Program Files / 只读挂载）时，包目录不可写，
 *   注册表、哨兵、锁登记会全部静默失败 —— 调用方等哨兵会永远等不到。
 *   DSH_HOME 本身就是用户目录，天然可写，且与 DSH 自己的数据放在一起。
 *
 * 兼容：旧版本的 `<包目录>/.state/conversations.json` 会在首次启动时复制过来
 * （只在没有显式设置 DSH_MCP_STATE 时做，见 LEGACY_STATE_FILE / USING_DEFAULT_STATE）。
 */
const DEFAULT_STATE_DIR = join(DSH_HOME, '.dsh-any-agent');
export const STATE_FILE =
  process.env.DSH_MCP_STATE ?? join(DEFAULT_STATE_DIR, 'conversations.json');
/** 旧默认位置；仅用于一次性迁移。 */
export const LEGACY_STATE_FILE = join(PKG_ROOT, '.state', 'conversations.json');
/** 是否仍在使用默认状态路径（显式设置 DSH_MCP_STATE 时不做自动迁移）。 */
export const USING_DEFAULT_STATE = !process.env.DSH_MCP_STATE;

/**
 * 确认一个目录可写；不可写就抛出可直接展示给用户的错误。
 *
 * 在 Hub.load() 启动时调用：宁可服务明确起不来，也不要"看起来正常、
 * 哨兵永远不出现、锁也无法归因"的静默降级。
 */
export function assertWritableDir(dir, label = '目录') {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
  } catch (e) {
    throw new Error(
      `${label}不可写: ${dir}\n` +
        `  ${e.message}\n` +
        '  请用 DSH_MCP_STATE / DSH_MCP_RUNS_DIR / DSH_MCP_LOCKS_DIR 指向可写目录。',
    );
  }
}

/**
 * 异步派活"完成哨兵"文件的根目录。每个 run 终止时在这里写一个独立小文件，
 * 供调用方用文件系统等待完成（无需轮询 MCP 工具）。默认与状态文件同目录下的 runs/。
 * 路径实际为 <RUNS_DIR>/<conversation_id>/<run_id>.json —— 按会话分目录，
 * 杜绝不同会话在同一毫秒生成同名 run_id 时相撞（run_id 的序号是每会话独立计数的）。
 */
export const RUNS_DIR = process.env.DSH_MCP_RUNS_DIR ?? join(dirname(STATE_FILE), 'runs');

/**
 * 调用方审核记录的落盘目录（默认与状态文件同目录下的 reviews/）。
 *
 * 每个 run 一份 `<REVIEWS_DIR>/<conversation_id>/<run_id>.review.json`，
 * 里面是调用方的裁决（pass/partial/fail）、理由、审核清单和证据摘要。
 * 审核记录与哨兵分开存放：哨兵是"回合完成"的闩锁，审核是"调用方已验收"的独立事实，
 * 后者可能在服务重启、run 记录被挤出内存之后才发生。
 */
export const REVIEWS_DIR = process.env.DSH_MCP_REVIEWS_DIR ?? join(dirname(STATE_FILE), 'reviews');

/**
 * live 事件流目录（默认与状态文件同目录下的 live/）。
 *
 * 每个会话一份 `<LIVE_DIR>/<conversation_id>/events.jsonl`：派活、工具调用、审批、回合结束，
 * 给用户用 `dsh-any-agent watch` / `dashboard` 旁路查看（不经过调用方 agent）。
 * 详见 docs/zh/live-view-design.md。**思考内容在事件格式里没有位置，任何级别都不落盘。**
 */
export const LIVE_DIR = process.env.DSH_MCP_LIVE_DIR ?? join(dirname(STATE_FILE), 'live');

/**
 * live 事件流级别：
 *   detail（默认）—— 在 meta 之上带脱敏后的预览：prompt、工具 title / 输入、审批命令。
 *                    暴露面与哨兵相同（哨兵默认就落完整正文与工具输入）。
 *   meta         —— 只有工具名 / kind / 状态 / 计时 / 计数 / 审批类型，不含任何输入或正文。
 *   off          —— 不写。
 */
export const LIVE_LEVELS = ['off', 'meta', 'detail'];
export const LIVE_LEVEL = (() => {
  const raw = String(process.env.DSH_MCP_LIVE ?? '').trim().toLowerCase();
  if (raw === '') return 'detail';
  if (raw === '0' || raw === 'false' || raw === 'no') return 'off';
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return 'detail';
  return LIVE_LEVELS.includes(raw) ? raw : 'detail';
})();

/**
 * 调用方审核策略：
 *   advisory（默认）—— 每个回合结果都附审核单（清单 + dsh_review 入口 + 证据），
 *                      但**不阻塞**后续 dsh_send；调用方仍可自己决定先做什么。
 *   off              —— 不生成审核单；dsh_review 仍可对旧 run 显式提交。
 *
 * 默认开着的原因：返回值是"另一个 agent 的自述"，调用方最容易犯的错就是直接转述。
 * 审核单把"先核验"放进返回载荷本身，而不是依赖调用方记得要审核。
 */
export const REVIEW_MODES = ['off', 'advisory'];
export const DEFAULT_REVIEW = (() => {
  const raw = process.env.DSH_MCP_REVIEW;
  if (raw === undefined || String(raw).trim() === '') return 'advisory';
  const v = String(raw).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === '1' || v === 'true' || v === 'on' || v === 'advisory' || v === 'yes') return 'advisory';
  return 'advisory';
})();

/**
 * 哨兵文件里是否带上**思考内容**。
 *
 * 默认 **不带** —— 本项目的红线是"思考内容不落盘、不写日志"。哨兵的用途是
 * "跑完了 + 拿结果"，正文（answer）与思考统计已足够；`result.thinking` 会被剥掉并
 * 标记 `thinking_omitted: true`，避免调用方以为字段丢了。
 *
 * 确实需要把思考一并落盘时，设 DSH_MCP_SENTINEL_INCLUDE_REASONING=1（会打破上面那条保证）。
 */
export const SENTINEL_INCLUDE_REASONING = process.env.DSH_MCP_SENTINEL_INCLUDE_REASONING === '1';

/**
 * 哨兵文件的保留时长（毫秒）。服务**启动时**清理超过此时长的哨兵与残留 tmp。
 * 默认 7 天；设为 0 关闭清理（哨兵将永久保留）。
 *
 * 为什么要清理：哨兵内含完整正文，长期不清理会无声地堆积占用磁盘。
 */
const rawSentinelTtl = numEnv('DSH_MCP_SENTINEL_TTL_MS', 7 * 24 * 60 * 60 * 1000);
/** ★ 负数/NaN 一律当作 0（关闭清理），绝不能把 cutoff 推到未来删光全部哨兵。 */
export const SENTINEL_TTL_MS = Number.isFinite(rawSentinelTtl) && rawSentinelTtl > 0 ? rawSentinelTtl : 0;

/**
 * 把 Windows 路径转成 Bash / MSYS 形式（`D:\a\b` → `/d/a/b`），非 Windows 原样返回。
 *
 * 存在的意义：调用方的后台等待任务通常跑在 Bash 里，而 sentinel_file 是 Windows 形式，
 * 手工转换（盘符小写 + 反斜杠改斜杠）很容易写错 —— 写错就会一直等到超时。
 */
export function toPosixPath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * `wait=true` 时的**等待**上限（毫秒）。**默认 0 = 不设超时（一直等）**。
 *
 * 为什么不给默认值：只有调用方知道任务要多久，我们凭空发明一个"30 分钟"只会误伤长任务。
 * 而且现在超时**不再破坏任何东西**（到期只是降级为后台：回合继续跑、结果照常由哨兵送达），
 * 所以"等多久"纯粹是调用方的偏好，不该由我们替他决定。
 * 需要全局兜底时设 DSH_MCP_PROMPT_TIMEOUT_MS。
 *
 * 另注：`dsh_send` **默认 `wait=false`**，压根不走等待路径，这个值通常用不上。
 */
export const PROMPT_TIMEOUT_MS = numEnv('DSH_MCP_PROMPT_TIMEOUT_MS', 0);

/**
 * 回合看门狗（判定规则见 watchdog.mjs）。三个值都是毫秒，`<= 0` 或非法值 = 关掉那一项。
 *
 *   DSH_MCP_WATCHDOG_AFTER_MS  回合开始多久后才开始判"卡住"（默认 15 分钟）。DSH 的回合本来就常跑
 *                              十几分钟，这之前一律不打扰。
 *   DSH_MCP_STALL_MS           多久没有任何进展算卡住（默认 10 分钟；有工具在执行时放大 3 倍）。
 *   DSH_MCP_TURN_MAX_MS        单个回合的总时长上限（默认 2 小时），不看进展 —— 陷在循环里的回合
 *                              一直有"进展"，只有它拦得住。
 *
 * 触发时发 session/cancel（与 dsh_interrupt 同一条路径：已有输出保留，文件改动不回滚），
 * 回合照常收尾、写哨兵，结果里带 `watchdog: {reason, …}`。
 */
const positiveOrOff = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
export const WATCHDOG_AFTER_MS = positiveOrOff(numEnv('DSH_MCP_WATCHDOG_AFTER_MS', 15 * 60 * 1000));
export const STALL_MS = positiveOrOff(numEnv('DSH_MCP_STALL_MS', 10 * 60 * 1000));
export const TURN_MAX_MS = positiveOrOff(numEnv('DSH_MCP_TURN_MAX_MS', 2 * 60 * 60 * 1000));

/**
 * 常驻进程模式（见 daemon.mjs），默认关。
 *
 *   DSH_MCP_DAEMON=1          客户端拉起的进程只做转发；会话、DSH 进程和正在跑的回合都在一个
 *                             detached 的常驻进程里，客户端关掉、重连、崩溃都不会打断回合。
 *   DSH_MCP_DAEMON_IDLE_MS    没有客户端连着、也没有回合在跑多久后常驻进程自己退出（默认 10 分钟；
 *                             `<= 0` = 不自动退出）。
 */
export const DAEMON_MODE = ['1', 'true', 'on', 'yes'].includes(String(process.env.DSH_MCP_DAEMON ?? '').trim().toLowerCase());
export const DAEMON_IDLE_MS = positiveOrOff(numEnv('DSH_MCP_DAEMON_IDLE_MS', 10 * 60 * 1000));

/** 普通 ACP 请求的超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = numEnv('DSH_MCP_REQUEST_TIMEOUT_MS', 60_000);

/**
 * 会话空闲多久后回收其 DSH 进程（毫秒）。
 *
 * ★★ **默认 10 分钟**（0.4.0 起；之前默认 `0` = 永不回收）。设 `0` = 永不回收（MCP 一直握着写锁，GUI 抢不走）。
 *   `0` 的好处：空闲回收是写锁**唯一**会变空的时刻，而锁一空，用户在 web 里点开那条
 *   会话就会让 `dsh web` **永久**持有它（实测：切走 ✗ 等待 ✗ 归档 ✗ 都不释放），
 *   本服务之后每一次 resume 都失败 —— 这正是"任务跑完后接不回去"的成因。
 *   不回收时（实测）：**你在 GUI 里点开那条会话是"只读打开"** —— 你照样能看到内容 ✓，
 *   而写锁留在本服务手里 ✓（用独立实例探测确认过：持有者是本服务的 PID、心跳新鲜）。
 *   也就是"**你看得见，我们写得动**"，两边都不受影响。
 *   代价：每个会话常驻一个 DSH 进程（例如 10 个会话约 1~3 GB）—— 所以默认改为按 TTL 回收，
 *   回到了"锁可能被 GUI 抢走"的世界；个别必须握锁的会话用 `dsh_start(keep_alive=true)`。
 *   （无论哪种模式，锁心跳都会一直续 —— 否则别的实例会误判我们卡死并抢占。）
 */
/**
 * 读一个数值型环境变量。**空串/纯空白一律当作"未设置"→ 用默认值**。
 *
 * 为什么必须这样：`.env` 与各种配置界面很容易产出空串（`DSH_MCP_MAX_LIVE=`），
 * 而 `Number('')` 是 **0** —— 于是"我什么都没设"会被读成"我要 0"，
 * 而 0 在这些开关里往往是个**有含义的极值**（0 = 不限 / 永不回收）✗。
 * 这类"看起来没配、行为却变了"的坑最难查，所以统一在这里挡掉。
 */
export function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// 0.4.0：默认从"永不回收"改为 10 分钟。
// 代价是锁可能空出来被 GUI 拿走；收益是并发一高不会把内存堆到几 GB。
// 需要"永远握住写锁"的会话用 dsh_start(keep_alive=true) 显式保活。
const rawIdle = numEnv('DSH_MCP_IDLE_TTL_MS', 10 * 60 * 1000);
/** ★ `<= 0` 或非法值一律当作"永不回收"。
 *  否则 `-1` 会被算成 `cutoff = now + 1` → **立刻回收**（谁会想到负数=马上收 ✗），
 *  `NaN` 更糟：比较永远为假，行为取决于具体分支。宁可把"奇怪的输入"统一压到安全侧。 */
export const IDLE_TTL_MS = Number.isFinite(rawIdle) && rawIdle > 0 ? rawIdle : 0;

/** 后台回收扫描间隔（毫秒）。**下限 200 毫秒**：0/负数会变成空转的紧循环 ✗（还会把心跳刷爆）。
 *  下限留得比较低，是为了让测试能把间隔调小去观察心跳与回收时序。 */
const rawReap = numEnv('DSH_MCP_REAP_INTERVAL_MS', 30_000);
export const REAP_INTERVAL_MS = Number.isFinite(rawReap) && rawReap >= 200 ? rawReap : 30_000;

/**
 * 最多同时保活多少个会话进程（`0` = 不限）。
 *
 * 为什么需要它：`IDLE_TTL_MS=0`（永不回收）能保证"GUI 抢不走写锁"，但代价是
 * **每个用过的会话永久占一个 DSH 子进程** —— 实测约 300-480MB/个（近似线性），10 个可达 3-5GB ✗。
 * 超过上限时**回收最久没用过的那个**（busy 的绝不回收）：
 *   - 保活窗口内的会话：写锁在手，GUI 抢不走 ✓
 *   - 窗口外的：进程回收、内存释放 ✓（下次派活自动 resume，无损 ✓）
 * 即"**内存有界，锁尽量在手**"。
 *
 * **默认 4**（按实测 300-480MB/个，最坏约 1.2-1.9GB）：让"内存有界"成为默认行为。
 * 被回收是无损的（会话日志在磁盘上 ✓），代价只是那个会话的写锁会空出来、
 * 且下次派活要 cold start。想做更多并行就调大；机器大也可以设 0（不限）。
 * `keep_alive=true` 的会话不受本上限约束（由调用方自己负责内存）。
 */
const rawMaxLive = numEnv('DSH_MCP_MAX_LIVE', 4);
export const MAX_LIVE = Number.isFinite(rawMaxLive) && rawMaxLive > 0 ? Math.floor(rawMaxLive) : 0;

/**
 * 全局子进程内存预算（MB）。`0` = 关闭。
 *
 * 超过预算时按"最久未用"回收空闲会话，直到回到预算内。
 * 与 `MAX_LIVE` 的区别：那个按**会话数**，这个按**实际 RSS**——
 * 会话的上下文大小差异很大，按个数限制经常低估。
 * 读 RSS 失败时静默跳过（不能因为量不到就把会话全收了）。
 */
const rawMaxRss = numEnv('DSH_MCP_MAX_RSS_MB', 0);
export const MAX_RSS_MB = Number.isFinite(rawMaxRss) && rawMaxRss > 0 ? Math.floor(rawMaxRss) : 0;

/**
 * 给每个 DSH 子进程的 V8 老生代设上限（MB）。`0` = 不设。
 *
 * 只是兜底：DSH 正常不会吃满默认堆，但失控的上下文可以把 RSS 顶到很高。
 * 设太小会让长会话 OOM，所以默认关闭、由用户按机器情况调。
 */
const rawChildHeap = numEnv('DSH_MCP_CHILD_MAX_OLD_SPACE_MB', 0);
export const CHILD_MAX_OLD_SPACE_MB =
  Number.isFinite(rawChildHeap) && rawChildHeap > 0 ? Math.floor(rawChildHeap) : 0;

/**
 * 同一 `(cwd, permission)` 的多个会话共享一个 ACP 进程（0.4.0 引入，**0.5.0 起默认开启**）。
 *
 * 为什么默认开：DSH 的 ACP 服务端支持一条连接上多会话，且每个 session 有独立 Agent。
 * 实测（DSH 0.1.7）：两个会话 → 一个 PID，第二个 `session/new` 约 300ms，独立进程约 4s；
 * 内存也从"每会话 300-480MB"降到"每个 (cwd, 权限) 组一份"。
 *
 * 为什么仍然分组：`sandbox-policy.workspaceRoot` / `mode` 与 `approval.policy` 在
 * `dsh-base` 里是**进程级**配置，不同工作区/权限档混进一个进程会让沙箱边界失真 ——
 * 那两种情况仍各起一个进程（硬约束，不是实现偷懒）。
 *
 * 代价（已写进文档，别当它不存在）：共享进程崩溃会连坐同组的**所有**会话。崩溃时统一写
 * error 哨兵并唤醒等待者，下次派活各自 resume —— 会话本体无损，但进行中的回合会断。
 * 所以 `dsh_takeover` 在杀一个还挂着其它会话的共享进程前，会要求显式 `force=true`。
 *
 * 设 `DSH_MCP_SHARED_PROCESS=0` 回到"一会话一进程"（拿内存换隔离性）。
 */
export const SHARED_PROCESS = numEnv('DSH_MCP_SHARED_PROCESS', 1) === 1;

/**
 * `dsh_list` 的"磁盘探测"结果缓存多久（毫秒）。
 *
 * 为什么要缓存：列会话时要 spawn 一个 DSH 进程做 `session/list`（**实测约 1 秒**），
 * 连着调几次就反复拉进程。缓存 10 秒既省掉这些开销，也不至于让"别的实例刚建的会话"久等。
 * 想排除磁盘上未打开的会话可传 `include_closed=false`（只列本服务已打开的，毫秒级）。
 */
export const LIST_PROBE_TTL_MS = numEnv('DSH_MCP_LIST_PROBE_TTL_MS', 10_000);

/** 权限档 → 该档下的默认审批策略。 */
export const PERMISSION_TIERS = ['read-only', 'workspace-write', 'danger-full-access'];
/**
 * 新建会话的默认权限档。0.5.0 起默认 **workspace-write**（沙箱把写入限制在工作区内），
 * 不再是 danger-full-access；空串/非法值也回落到它。
 *
 * `danger-full-access` 需要机器侧显式允许，见下面的 ALLOW_FULL_ACCESS。
 */
export const DEFAULT_PERMISSION = PERMISSION_TIERS.includes(process.env.DSH_MCP_PERMISSION)
  ? process.env.DSH_MCP_PERMISSION
  : 'workspace-write';

/**
 * 是否允许 `permission=danger-full-access`。
 *
 * 本服务只是派发层，权限跟着机器所有者自己的配置走。两种情况算"机器侧已允许"：
 *   - 客户端配置里把默认档设成了 danger-full-access（`DSH_MCP_PERMISSION=danger-full-access`，
 *     也就是 `dsh-any-agent-setup --permission danger-full-access` 写进去的那一项）—— 那就是你的选择；
 *   - 或者显式 `DSH_MCP_ALLOW_FULL_ACCESS=1`（默认档是别的、只想让个别会话用 full access 时）。
 *
 * 两样都没有时，调用方（模型）不能在 dsh_start 里自己把档位要成 danger-full-access。
 * 以前只认第二种，于是 `setup --permission danger-full-access` 写出来的配置每次 dsh_start 都被拒绝。
 */
export const ALLOW_FULL_ACCESS =
  process.env.DSH_MCP_ALLOW_FULL_ACCESS === '1' || DEFAULT_PERMISSION === 'danger-full-access';

/**
 * 审批处理策略：
 *   auto-allow —— 直接放行（适合 danger-full-access 之外的档位要跑通时）
 *   auto-deny  —— 一律拒绝（保持"真只读"）
 *   ask        —— 挂起为待决审批，交给调用方用 dsh_approval_decide 裁决
 */
export const APPROVAL_POLICIES = ['auto-allow', 'auto-deny', 'ask'];

/** 未显式指定时，按权限档推导审批策略：只读档一律拒绝，其余放行。 */
export function defaultApprovalPolicy(permission) {
  if (permission === 'read-only') return 'auto-deny';
  const configured = process.env.DSH_MCP_APPROVAL;
  return APPROVAL_POLICIES.includes(configured) ? configured : 'auto-allow';
}

/** 思考内容展示档位。 */
export const REASONING_MODES = ['hide', 'marker', 'summary', 'full'];
export const DEFAULT_REASONING = 'hide';

/**
 * 会话的"思考深度"（ACP 的 reasoning_effort 配置项）。
 * ACP 默认值是空串（= Provider default），不是我们想要的；默认显式设成 max。
 */
export const REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 空串/非法值回落到 max；否则 Hub.create 的合法性校验会让**所有** dsh_start 失败。 */
export const DEFAULT_REASONING_EFFORT = REASONING_EFFORTS.includes(process.env.DSH_MCP_REASONING_EFFORT)
  ? process.env.DSH_MCP_REASONING_EFFORT
  : 'max';

/**
 * 工作区登记模式：
 *   project（默认）—— 登记，但跳过系统临时目录（%TEMP% 那种"工作区"不该进 GUI）
 *   all           —— 全都登记（含临时目录，适合跑测试时观察）
 *   0             —— 完全关闭（关闭后 MCP 建的会话在你的 DSH GUI 里看不到）
 */
export const REGISTER_WORKSPACE = (() => {
  const v = process.env.DSH_MCP_REGISTER_WORKSPACE;
  if (v === '0' || v === 'false') return false;
  if (v === 'all') return 'all';
  return 'project';
})();

/**
 * 日志策略。
 *
 * 默认 **silent：一个字都不输出**。MCP 的 stdout 是协议通道，stdout 必须干净；
 * 而 stderr 也默认保持安静，原因有二：
 *   1) 本服务是被 Codex/Claude 拉起的，它的 stderr 会直接进对方的日志/终端；
 *   2) DSH 进程本身的 stderr 可能夹带模型输出（含**思考内容**），绝不能顺手转发。
 *
 * 因此：
 *   silent（默认）—— 什么都不打印
 *   info          —— 只打印本服务自己的生命周期事件，**绝不包含 DSH 的任何输出**
 *   debug         —— 追加更细的本服务事件；仍然不打印 DSH 的输出内容
 *   DSH_MCP_LOG_STDERR=1 才额外打印 DSH 的 stderr（**可能含思考内容**，默认关闭）
 *
 * 另外：任何情况下都不把思考内容写进日志或落盘。会话状态文件里只有元数据。
 */
export const LOG_LEVEL = String(process.env.DSH_MCP_LOG ?? 'silent').toLowerCase();
export const LOG_DSH_STDERR = process.env.DSH_MCP_LOG_STDERR === '1';

/** 造一个分级 logger。所有模块统一用它，避免散落的 console/process.stderr 调用。 */
export function createLogger(level = LOG_LEVEL) {
  const rank = { silent: 0, info: 1, debug: 2 }[level] ?? 0;
  const write = (m) => {
    try {
      process.stderr.write(`${m}\n`);
    } catch {
      /* stderr 不可写时静默忽略，绝不影响协议通道 */
    }
  };
  return {
    level,
    rank,
    info: (m) => rank >= 1 && write(m),
    debug: (m) => rank >= 2 && write(m),
    /** 仅当显式开启 DSH_MCP_LOG_STDERR 时才转发子树进程的原始输出。 */
    dshStderr: (m) => LOG_DSH_STDERR && write(m),
  };
}
