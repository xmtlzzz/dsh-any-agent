/**
 * 会话 id / run id 的路径安全校验。
 *
 * 这两个 id 会直接参与 `<state>/runs/<conversation_id>/<run_id>.json` 与
 * `<state>/reviews/<conversation_id>/<run_id>.review.json` 的路径拼接。
 * DSH 生成的是 UUID / `run-<base36>-<n>`，但 MCP 调用方可以传任意字符串；
 * 带 `/`、`\`、`:` 或 `..` 的 id 一旦进入 join()，就能读写状态目录之外的文件。
 *
 * 规则刻意保守：单段、字母数字开头、只允许 `._-`，最长 200。合法的 DSH
 * UUID 和本服务生成的 run_id 都满足；不满足的 id 在触盘之前就拒绝。
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function assertSafeId(value, label = 'id') {
  if (typeof value !== 'string' || value === '.' || value === '..' || !SAFE_ID.test(value)) {
    throw new Error(
      `${label} 非法：只允许字母/数字开头、由字母/数字/._- 组成的单段 id（最长 200）: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
