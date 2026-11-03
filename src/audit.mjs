/**
 * 元数据审计日志（可选，默认关闭）。
 *
 * 只记录"谁在什么时候对哪个会话/回合做了什么"，**不记录** prompt、正文、思考、
 * 工具输入 —— 项目的隐私红线不变。设 `DSH_MCP_AUDIT_FILE` 指向一个文件即可开启；
 * 单文件超过 10 MB 时滚动成 `<file>.1`（只保留一份旧档，避免无限增长）。
 *
 * 审计写入失败绝不能影响主流程：所有异常吞掉。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

export function audit(event, data = {}) {
  const file = process.env.DSH_MCP_AUDIT_FILE;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
      'utf8',
    );
  } catch {
    // 审计失败不影响派活
  }
}
