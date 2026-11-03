/**
 * 凭证脱敏。
 *
 * 审批上下文、哨兵文件和调用方审核记录都会落盘保留一段时间，
 * 里面可能夹带完整命令、URL 里的密码、`api_key=…` 之类的字面量。
 * 这里只做一件事：把常见凭证形状替换成 `[REDACTED]`，保持其余内容可读、可审核。
 *
 * 注意：这是**形状匹配**，不是数据分类器。它挡的是常见误写，不是"绝对安全"。
 */

const SECRET_KEY =
  /^(?:api[_-]?key|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|credentials?|headers|env|environment)$/i;

export function sanitizeApprovalContext(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/\bBearer\s+[^\s'";]+/gi, 'Bearer [REDACTED]')
      .replace(
        /((?:api[_-]?key|password|passwd|secret|(?:access[_-]?)?token)\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/(--(?:api[_-]?key|password|passwd|secret|token)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeApprovalContext(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sanitizeApprovalContext(item, name)]),
    );
  }
  return value ?? null;
}
