/**
 * 测试用：把 live 事件流目录指到一个临时目录（仅当调用方没指定时），进程退出时删掉。
 *
 * 为什么需要：有些离线套件直接用假 hub 驱动 Conversation、不设 DSH_MCP_STATE。
 * 通过 `npm test`（test/run.mjs）跑时，入口已经统一设好了 DSH_MCP_LIVE_DIR；
 * 但单独 `node test/xxx.mjs` 时没有，事件就会写进用户真实的 ~/.dsh/.dsh-any-agent/live，
 * 出现在 watch / dashboard 里。
 *
 * 用法：在测试文件里作为**第一条** import（ESM 按书写顺序求值，必须早于 src/ 的模块）：
 *   import './live-sandbox.mjs';
 *
 * 注意：文件名不能以下划线开头 —— .gitignore 的 `test/_*.mjs` 会把它当成临时文件忽略掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.DSH_MCP_LIVE_DIR) {
  // 前缀 dsh-any-agent- 让 test/cleanup.mjs 也能兜底清掉（进程被强杀时）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-any-agent-live-'));
  process.env.DSH_MCP_LIVE_DIR = dir;
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 被占用就留给 cleanup.mjs */
    }
  });
}
