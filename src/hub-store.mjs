/**
 * Hub 的两类磁盘小状态：会话元数据侧车与 forget 墓碑。
 *
 * 从 hub.mjs 拆出来：两者都只是"按 id 一个小 JSON 文件"的读写，不依赖 Hub/Conversation
 * 的运行期状态（写侧车只用 `conv.toMeta()` 与 `conv.id`）。红线不变：只存元数据，
 * 不存任何对话/思考正文。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DSH_HOME, STATE_FILE } from './config.mjs';
import { findSessionHeaderStatus } from './workspace.mjs';

/** 没有注入 logger 时的占位（Hub 构造器与 pruneStaleTombstones 的默认值共用）。 */
export const NOOP_LOG = { info: () => {}, debug: () => {}, dshStderr: () => {} };

/**
 * 会话元数据侧车（`.state/meta/<id>.json`）。
 *
 * 为什么需要：`forget=true` 只从注册表移除；之后按 id 查询时，`Hub.get()` 会从
 * DSH 会话存储重建会话（这是多实例恢复的刻意设计）。但 DSH 的会话记录里**没有**
 * 本服务选择的 `onApproval` / `reasoning_effort` / `title_hint` / 轮数，
 * 重建就会悄悄回落到默认值（实测 auto-allow→ask、low→max）。这个侧车保存
 * **仅元数据**（不含任何对话/思考正文），让重建后仍与原会话一致。
 */
export const META_DIR = join(dirname(STATE_FILE), 'meta');
const metaFilePath = (id) => join(META_DIR, `${id}.json`);

export function writeConversationMeta(conv) {
  try {
    mkdirSync(META_DIR, { recursive: true });
    const file = metaFilePath(conv.id);
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(conv.toMeta(), null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 元数据侧车只是辅助信息，写失败不影响主流程 */
  }
}

export function readConversationMetaFile(id) {
  try {
    return JSON.parse(readFileSync(metaFilePath(id), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * forget 墓碑：`release(forget=true)` 之后，按 id 查询必须**明确失败**，
 * 而不是从 DSH 会话存储里悄悄复活。墓碑只含 id 与时间，不含任何内容；
 * 删除 `.state/forgotten/<id>.json` 即可恢复按 id 找回（手动、可审计）。
 */
// 墓碑放在 DSH home 下而不是注册表旁边：不同实例即使注册表路径不同，
// 也应该对同一个会话的 forget 达成一致（forget 是会话级终态，不是注册表级）。
const FORGOTTEN_DIR = process.env.DSH_MCP_FORGOTTEN_DIR ?? join(DSH_HOME, '.dsh-any-agent-forgotten');
export const forgottenPath = (id) => join(FORGOTTEN_DIR, `${id}.json`);

/**
 * 写墓碑；返回 null 表示成功，否则返回失败原因。
 * ★ 失败必须让调用方知道：墓碑是 forget 唯一的持久效力，写不进去还报“已 forget”，
 *   同一会话随即就能从 DSH 会话存储里被按 id 找回（审计 B04）。
 */
export function writeTombstone(id) {
  try {
    mkdirSync(FORGOTTEN_DIR, { recursive: true });
    const file = forgottenPath(id);
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify({ id, forgottenAt: Date.now() }, null, 2), 'utf8');
    renameSync(tmp, file);
    return null;
  } catch (e) {
    return e?.message ?? String(e);
  }
}

export function isForgotten(id) {
  try {
    return existsSync(forgottenPath(id));
  } catch {
    return false;
  }
}

/**
 * 启动时清掉“会话文件已经不存在”的墓碑：它们不再阻止任何 resurrection，
 * 留着只会让测试/临时会话在 `$DSH_HOME/.dsh-any-agent-forgotten` 里堆积。
 * 会话文件还在的墓碑必须保留 —— 那正是 forget 的效力所在。
 */
export async function pruneStaleTombstones(log = NOOP_LOG) {
  let removed = 0;
  try {
    if (!existsSync(FORGOTTEN_DIR)) return 0;
    for (const f of readdirSync(FORGOTTEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      // 异步读会话头：启动路径不能被大日志的同步解压卡住。
      // ★ 只有确认会话文件不存在时才删墓碑；读超时/损坏时保留，
      //   否则一次慢盘/挂载异常就会让 forget 失效。
      const found = await findSessionHeaderStatus(id);
      if (found.status === 'found' || found.status === 'error') {
        if (found.status === 'error') log.info(`[hub] 墓碑 ${id} 暂不清理：${found.reason}`);
        continue;
      }
      try {
        rmSync(join(FORGOTTEN_DIR, f), { force: true });
        removed++;
      } catch {}
    }
  } catch {
    /* 清理失败不影响启动 */
  }
  return removed;
}
