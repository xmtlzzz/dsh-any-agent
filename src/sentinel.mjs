/**
 * 哨兵 / 审核记录这类"落盘副本"的卫生：写盘前的脱敏，以及过期清理。
 *
 * 从 hub.mjs 拆出来：两件事都只处理 plain object / 目录，不依赖 Hub 的运行期状态。
 * 红线不变：思考内容默认不落盘（见 hub.mjs 文件头说明）。hub.mjs 仍然重新导出
 * `sanitizeResultForSentinel`，外部的导入路径不变。
 */

import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SENTINEL_INCLUDE_REASONING, SENTINEL_TOOL_INPUTS } from './config.mjs';
import { sanitizeApprovalContext } from './redact.mjs';

/**
 * 哨兵 JSON 的格式版本（哨兵顶层的 `schema` 字段）。同一版本内只加字段，不删、不改名、不改类型；
 * 要做这些就加一，并在 CHANGELOG 里写明。test/contract.mjs 对着快照守这条。
 */
export const SENTINEL_SCHEMA = 1;

/** 工具输入的长度（字符串按字符数，其它按 JSON 长度）。 */
function inputChars(input) {
  try {
    return typeof input === 'string' ? input.length : (JSON.stringify(input)?.length ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 哨兵文件里的 result 是否要剥离思考内容。
 * 默认剥离以维持"思考不落盘"的保证，并留下 thinking_omitted 标记，
 * 免得调用方以为字段是意外丢失的。
 */
export function sanitizeResultForSentinel(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const { thinking, ...rest } = result;
  // ★ 即使 DSH_MCP_SENTINEL_INCLUDE_REASONING=1，也只额外保留 thinking；
  //   answer/error/title/tools_used 仍然必须脱敏（以前这个开关会跳过整段清洗）。
  // 正文/错误/标题同样可能夹带密钥；哨兵是落盘副本，统一套脱敏。
  for (const key of ['answer', 'error', 'title']) {
    if (typeof rest[key] === 'string') rest[key] = sanitizeApprovalContext(rest[key], key);
  }
  // 工具输入里会有完整命令、路径，甚至写入的文件内容。哨兵会保留 7 天，
  // 所以按审批上下文同一套规则脱敏（密钥/令牌/密码类字段与常见内联字面量）。
  if (Array.isArray(rest.tools_used)) {
    rest.tools_used = rest.tools_used.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const { input, ...meta } = t;
      const safeMeta = sanitizeApprovalContext(meta);
      if (input === undefined) return safeMeta;
      // DSH_MCP_SENTINEL_TOOL_INPUTS=0：输入一个字都不落盘，只留长度（同 dsh_get 的 max_chars 预算）。
      if (!SENTINEL_TOOL_INPUTS) return { ...safeMeta, input_chars: inputChars(input) };
      return { ...safeMeta, input: sanitizeApprovalContext(input) };
    });
  }
  // 自动放行审批摘要记录时已脱敏；落盘前再过一遍，防止将来有人加字段漏掉。
  // command_preview 是命令原文的开头，也算工具输入：开关关掉时一并不落盘，条数与裁决信息照留。
  if (Array.isArray(rest.auto_approvals)) {
    rest.auto_approvals = rest.auto_approvals.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const { command_preview, ...meta } = a;
      return sanitizeApprovalContext(SENTINEL_TOOL_INPUTS ? a : meta);
    });
  }
  // 审核单里可能有原任务预览、审核理由与证据摘要；哨兵会保留 7 天，同样要脱敏。
  if (rest.review && typeof rest.review === 'object') {
    const rv = { ...rest.review };
    for (const key of ['prompt_preview', 'notes']) {
      if (typeof rv[key] === 'string') rv[key] = sanitizeApprovalContext(rv[key], key);
    }
    if (Array.isArray(rv.checklist)) rv.checklist = rv.checklist.map((x) => sanitizeApprovalContext(x));
    if (Array.isArray(rv.findings)) rv.findings = rv.findings.map((x) => sanitizeApprovalContext(x));
    if (rv.evidence) rv.evidence = sanitizeApprovalContext(rv.evidence);
    rest.review = rv;
  }
  // 始终给出布尔值：调用方才能区分“思考被剥离”与“本来没有思考”。
  const out = { ...rest, thinking_omitted: Boolean(thinking) && !SENTINEL_INCLUDE_REASONING };
  if (SENTINEL_INCLUDE_REASONING && thinking !== undefined) out.thinking = thinking;
  return out;
}

/**
 * 清掉 `dir` 下超过 TTL 的文件与空会话目录；`.tmp` 残留不论年龄都按同一 cutoff 清。
 * 只遍历一层会话目录，绝不递归进别处 —— 调用方（哨兵/审核目录）都是本服务自己的。
 */
export function pruneDirTree(dir, ttlMs) {
  if (!ttlMs || !existsSync(dir)) return { pruned: 0, dirs_removed: 0 };
  let pruned = 0;
  let dirsRemoved = 0;
  const cutoff = Date.now() - ttlMs;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        if (!f.isFile() || f.name.endsWith('.running')) continue;
        const fp = join(sub, f.name);
        try {
          if (statSync(fp).mtimeMs < cutoff) {
            rmSync(fp, { force: true });
            pruned++;
          }
        } catch {
          /* 单个文件失败就跳过 */
        }
      }
      try {
        if (readdirSync(sub).length === 0) {
          rmdirSync(sub);
          dirsRemoved++;
        }
      } catch {
        /* 目录清理失败无所谓 */
      }
    }
  } catch {
    /* 目录读不了就跳过 */
  }
  return { pruned, dirs_removed: dirsRemoved };
}
