// Deterministic, browser-local examples. No requests are sent to DSH.
const frame = (title, detail, tool, code, status, progress, log, extra = {}) => ({ title, detail, tool, code, status, progress, log, ...extra });
export const scenarios = {
  dispatch: {
    label: '异步派活', summary: '把任务交出去，你的工作继续。',
    description: '拿到回执就能离开。进度随时可读，回合结束后，哨兵文件带回完整结果。',
    frames: [
      frame('在项目里，认识你的新搭子', '一个会话，一份可恢复的工作上下文。', 'dsh_start', '{ cwd: "/workspace/app" }', 'idle', 0, '创建会话 conv-app · 工作区 /workspace/app'),
      frame('派出任务，立即拿到回执', '不用等任务跑完，当前客户端可以继续做别的事。', 'dsh_send', '{ conversation_id: "conv-app",\n  prompt: "重构配置加载器，补齐回归测试",\n  wait: false }', 'running', 12, '收到 run-001 · background: true'),
      frame('它在工作，你不用守着', 'DSH 读取文件、修改代码、运行脚本。', 'files · shell', 'read src/config.mjs\nedit src/config.mjs\nnode --test test/config.test.mjs', 'running', 43, '读取配置模块 · 编写实现与测试'),
      frame('想看进度？只取新增部分', '游标增量读，不必反复把全部输出塞进上下文。', 'dsh_read', '{ conversation_id: "conv-app",\n  cursor: 12 }\n// → next_cursor: 18', 'running', 78, '增量输出 6 条 · 测试执行中'),
      frame('结果落地，有据可收', '回合结束时，原子写出含 status 与 result 的哨兵文件。', 'sentinel_file', '.state/runs/conv-app/run-001.json\n{ "status": "done", "result": "…" }', 'done', 100, '完成哨兵已写入 · 等待方可读取结果', { sentinel: true }),
      frame('回头验收，接着共事', '读取哨兵，或用 run_id 取回这次任务的完整答复。', 'dsh_get', '{ conversation_id: "conv-app",\n  run_id: "run-001" }\n// → status: done, result: "配置重构完成"', 'done', 100, '结果已收取 · 会话继续保留', { sentinel: true, collected: true }),
    ],
  },
  interject: {
    label: '中途改向', summary: '想法变了，随时把方向拨回来。',
    description: '插话会取消当前回合，再带着原有历史开启下一轮。也可以排队，等本轮结束再说。',
    frames: [
      frame('重构进行到一半', '实现已经开始，但你想先验证旧行为。', 'dsh_status', '{ state: "running",\n  current_tool: "edit", history: "preserved" }', 'running', 35, 'run-001 · 正在重构配置加载器'),
      frame('把新要求说清楚', '“先补回归测试，再继续重构。”', '你的新要求', '先补回归测试，确认旧行为不变，\n再继续重构配置加载器。', 'running', 38, '收到方向调整 · 准备插话'),
      frame('中止当前回合，历史保留', '通过 ACP 的取消路径结束当前回合，不销毁会话。', 'dsh_interject', '{ conversation_id: "conv-app",\n  mode: "interject",\n  prompt: "先补回归测试，再继续重构" }', 'interrupted', 38, 'run-001 已取消 · conversation_id 保持不变', { preserved: true }),
      frame('带着上下文，按新方向继续', '同一会话开启新回合，之前的工作仍在。', '新回合 run-002', 'history → preserved\nnext → write regression tests', 'running', 62, 'run-002 · 先补回归测试', { preserved: true }),
      frame('先验证，再重构', '测试成为这轮工作的第一步。', 'shell · edit', 'node --test test/config.test.mjs\n// 基线确认后继续修改实现', 'running', 86, '基线已验证 · 继续重构', { preserved: true }),
      frame('新的结果，也有自己的回执', '每一轮独立验收，不混淆中止与完成。', 'sentinel_file', '.state/runs/conv-app/run-002.json\n{ "status": "done", "result": "…" }', 'done', 100, 'run-002 完成 · 新哨兵已写入', { preserved: true, sentinel: true, collected: true }),
    ],
  },
  resume: {
    label: '断线恢复', summary: '进程会结束，会话身份留下来。',
    description: '恢复已落盘的对话，接着下一轮。进程中断会打断正在执行的回合，需要重新派活。',
    frames: [
      frame('上下文已经留在磁盘', '会话使用 DSH sessionId 持久化身份。', 'sessionId', 'conv-app → ~/.dsh/sessions/…\nprogress → implementation started', 'running', 56, '会话历史已落盘 · 当前回合执行中', { persisted: true }),
      frame('进程中断了', '当前回合随进程停止，不会在后台凭空继续。', 'process exit', 'process → stopped\ncurrent turn → interrupted\nsession history → on disk', 'interrupted', 56, '进程退出 · 当前回合已中断', { persisted: true }),
      frame('会话身份仍然在', '历史保留，工作区里已经写入的文件也仍在。', '磁盘上的 sessionId', 'conversation_id: "conv-app"\nprocess: none\nhistory: persisted', 'detached', 56, '找到已落盘的会话 · 等待重新连接', { persisted: true }),
      frame('下次调用，自动接回对话', '拉起新进程，通过 ACP session/resume 恢复。', 'session/resume', '{ sessionId: "conv-app" }\n// → history restored', 'idle', 56, '新进程已连接 · 同一会话历史已恢复', { persisted: true, preserved: true }),
      frame('重新派活，继续剩下的工作', '先核对工作区状态，再给下一轮明确目标。', 'dsh_send', '{ conversation_id: "conv-app",\n  prompt: "检查已完成修改，继续剩余测试",\n  wait: false }', 'running', 80, 'run-002 · 核对修改后继续测试', { persisted: true, preserved: true }),
      frame('恢复的是合作关系', '进程只是缓存，会话才是长期共事的单位。', 'dsh_get', '{ run_id: "run-002" }\n// → status: done', 'done', 100, '新回合完成 · 历史延续', { persisted: true, preserved: true, sentinel: true, collected: true }),
    ],
  },
  parallel: {
    label: '多会话并行', summary: '几件事同时做，进度分别看。',
    description: '为独立任务开启独立会话，切换查看增量输出。每个会话都有自己的工作区与回执。',
    frames: [
      frame('让独立任务各自开工', '分别为实现、测试和文档建立会话。', 'dsh_start × 3', 'conv-app  → /workspace/app\nconv-test → /workspace/tests\nconv-docs → /workspace/docs', 'idle', 0, '3 个独立会话就绪', { jobs: [0, 0, 0] }),
      frame('一次派活，各自推进', '每个调用都会返回自己的 run_id。', 'dsh_send · wait=false', '实现 → run-001\n测试 → run-001\n文档 → run-001', 'running', 18, '3 个回合已在后台运行', { jobs: [18, 12, 25] }),
      frame('一眼看清谁在忙', '只列运行中的会话，再按需查看。', 'dsh_list', '{ only_running: true }\n// → app: running\n// → test: running, docs: running', 'running', 45, '切换会话即可查看独立增量输出', { jobs: [45, 35, 65] }),
      frame('文档先完成，其他任务继续', '每条会话独立运行、独立验收。', 'dsh_read', '{ conversation_id: "conv-test",\n  cursor: 8 }\n// → 测试执行进度…', 'running', 68, '文档哨兵已落地 · 实现和测试继续', { jobs: [68, 62, 100] }),
      frame('按会话分目录，不串结果', '即便 run_id 相同，哨兵也有独立路径。', 'sentinel_file', 'runs/conv-app/run-001.json\nruns/conv-test/run-001.json\nruns/conv-docs/run-001.json', 'running', 91, '实现完成 · 测试即将结束', { jobs: [100, 91, 100] }),
      frame('收齐结果，继续下一步', '完成一项收一项，每个结果都可追溯。', 'dsh_get × 3', 'app  → done\ntest → done\ndocs → done', 'done', 100, '3 项结果已就绪 · 互不覆盖', { jobs: [100, 100, 100], sentinel: true, collected: true }),
    ],
  },
};
export function getFrame(mode, index) {
  const scenario = scenarios[mode];
  if (!scenario) throw new RangeError('Unknown demo scenario');
  if (!Number.isInteger(index) || index < 0 || index >= scenario.frames.length) throw new RangeError('Invalid demo frame');
  return scenario.frames[index];
}
export function advance(mode, index) { getFrame(mode, index); return Math.min(index + 1, scenarios[mode].frames.length - 1); }
export function isFinished(mode, index) { return index === scenarios[mode].frames.length - 1; }
export const statusNames = { idle: '待命', running: '执行中', interrupted: '已中断', detached: '已分离', done: '已完成' };
