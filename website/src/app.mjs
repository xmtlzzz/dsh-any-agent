import { scenarios, getFrame, advance, isFinished, statusNames } from './demo.mjs';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let mode = 'dispatch', step = 0, client = 'Codex', selectedJob = 0;
let playing = !motion.matches, inView = false, timer, toastTimer;
const siteTheme = (() => { try { return localStorage.getItem('dsh-theme'); } catch { return null; } })();
let theme = ['dark', 'light'].includes(siteTheme) ? siteTheme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function renderTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}模式`);
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0a101c' : '#fafbfd';
}
renderTheme();
$('#theme-toggle').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'; renderTheme();
  try { localStorage.setItem('dsh-theme', theme); } catch {}
});

function announce(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2300);
}
function renderPlayback() {
  const ended = isFinished(mode, step);
  $('#play-icon').textContent = playing && !ended ? 'Ⅱ' : '▶';
  $('#play-label').textContent = ended ? '播放' : playing ? '暂停' : '播放';
  $('#play-pause').setAttribute('aria-pressed', String(playing && !ended));
  $('#next-step').disabled = ended;
}
function schedule() {
  clearTimeout(timer); renderPlayback();
  if (!playing || !inView || document.hidden || isFinished(mode, step)) return;
  timer = setTimeout(() => { step = advance(mode, step); render(); schedule(); }, 3100);
}
function render() {
  const frame = getFrame(mode, step), scenario = scenarios[mode];
  $('#frame-title').textContent = frame.title;
  $('#frame-detail').textContent = frame.detail;
  $('#tool-name').textContent = frame.tool;
  $('#tool-code').textContent = frame.code;
  $('#tool-client').textContent = `${client} → DSH`;
  $('#step-number').textContent = String(step + 1).padStart(2, '0');
  $('#scenario-summary').textContent = scenario.summary;
  $('#scenario-description').textContent = scenario.description;
  $('#demo-panel').setAttribute('aria-labelledby', `tab-${mode}`);
  $('[data-scenario="dispatch"]').parentElement.querySelectorAll('button').forEach(button => {
    const selected = button.dataset.scenario === mode;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  $$('[data-client]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.client === client)));
  const names = ['配置加载器重构', '配置模块回归测试', '配置使用文档'];
  const jobProgress = frame.jobs;
  const progress = jobProgress ? jobProgress[selectedJob] : frame.progress;
  const status = jobProgress ? progress === 100 ? 'done' : progress ? 'running' : 'idle' : frame.status;
  $('#conversation-title').textContent = mode === 'parallel' ? names[selectedJob] : '配置加载器重构';
  $('#task-goal').textContent = mode === 'parallel' ? ['完成配置模块重构。', '补齐回归测试并核对行为。', '更新使用说明与配置示例。'][selectedJob] : mode === 'interject' && step >= 2 ? '先补回归测试，再继续配置加载器重构。' : '重构配置加载器，补齐回归测试。';
  $('#status-badge').dataset.status = status;
  $('#status-badge').replaceChildren(document.createElement('i'), document.createTextNode(statusNames[status]));
  $('#runtime-state').replaceChildren(document.createElement('i'), document.createTextNode(statusNames[frame.status]));
  $('#progress-label').textContent = status === 'idle' ? mode === 'resume' && step > 0 ? '会话已恢复，等待派活' : '等待派活' : status === 'done' ? '本次演示任务已完成' : status === 'interrupted' ? '当前回合已中断' : status === 'detached' ? '会话已落盘，等待连接' : '演示任务执行进度';
  $('#progress-percent').textContent = `${progress}%`;
  $('#progress-fill').style.width = `${progress}%`;
  $('#progress-track').setAttribute('aria-valuenow', String(progress));
  $('#progress-track').classList.toggle('done', status === 'done');
  $('#identity-note').textContent = frame.preserved ? '同一会话 · 历史已保留' : frame.persisted ? 'sessionId 已落盘 · 可恢复' : '会话身份 · 始终保留';
  $('.identity-card code').textContent = mode === 'parallel' ? ['conv-app', 'conv-test', 'conv-docs'][selectedJob] : 'conv-app';
  $('.receipt-row').classList.toggle('received', Boolean(frame.sentinel));
  $('#receipt-icon').textContent = frame.collected ? '✓' : frame.sentinel ? '●' : step ? '↳' : '○';
  $('#receipt-label').textContent = frame.collected ? '结果已收取' : frame.sentinel ? '完成哨兵已落地' : frame.status === 'interrupted' ? '回合已中断' : step ? '派活回执已收到' : '等待回执';
  $('#receipt-value').textContent = frame.sentinel ? `run-${mode === 'dispatch' || mode === 'parallel' ? '001' : '002'}.json` : step ? 'run_id: run-001' : 'conversation_id: conv-app';
  const action = $('#context-action');
  action.hidden = !(mode === 'interject' && step < 2 || mode === 'resume' && step === 0);
  action.textContent = mode === 'resume' ? '模拟进程中断 ↗' : '插话：先补测试 ↗';
  $('#job-stack').hidden = mode !== 'parallel';
  if (jobProgress) $$('[data-job]').forEach((button, index) => {
    button.setAttribute('aria-pressed', String(index === selectedJob));
    button.querySelector('b').style.width = `${jobProgress[index]}%`;
    button.querySelector('small').textContent = `${jobProgress[index]}%`;
  });
  $('#event-log').replaceChildren(...scenario.frames.slice(Math.max(0, step - 2), step + 1).map((entry, index) => {
    const p = document.createElement('p'), time = document.createElement('span');
    time.textContent = `00:${String((Math.max(0, step - 2) + index) * 3).padStart(2, '0')}`;
    p.append(time, document.createTextNode(entry.log)); return p;
  }));
  $('#timeline').replaceChildren(...scenario.frames.map((entry, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('aria-label', `第 ${index + 1} 步：${entry.title}`);
    button.dataset.state = index < step ? 'passed' : 'pending';
    if (index === step) button.setAttribute('aria-current', 'step');
    button.addEventListener('click', () => { step = index; playing = false; render(); schedule(); });
    return button;
  }));
  renderPlayback();
}
function selectScenario(value) {
  if (!scenarios[value]) return;
  mode = value; step = 0; selectedJob = 0; playing = !motion.matches;
  render(); schedule();
}
$$('[data-scenario]').forEach(button => button.addEventListener('click', () => selectScenario(button.dataset.scenario)));
$$('[data-client]').forEach(button => button.addEventListener('click', () => { client = button.dataset.client; render(); }));
$$('[data-job]').forEach(button => button.addEventListener('click', () => { selectedJob = Number(button.dataset.job); render(); }));
$('#play-pause').addEventListener('click', () => {
  if (isFinished(mode, step)) { step = 0; playing = true; } else playing = !playing;
  render(); schedule();
});
$('#replay').addEventListener('click', () => { step = 0; playing = !motion.matches; render(); schedule(); });
$('#next-step').addEventListener('click', () => { step = advance(mode, step); playing = false; render(); schedule(); });
$('#context-action').addEventListener('click', () => { step = mode === 'resume' ? 1 : 2; playing = !motion.matches; render(); schedule(); });
document.addEventListener('visibilitychange', schedule);
motion.addEventListener('change', () => { if (motion.matches) { playing = false; schedule(); } });
if ('IntersectionObserver' in window) new IntersectionObserver(entries => { inView = entries[0].isIntersecting; schedule(); }, { threshold: .12 }).observe($('#demo-panel'));
else { inView = true; schedule(); }

const configs = {
  codex: { path: '~/.codex/config.toml', code: '[mcp_servers.dsh-any-agent]\ncommand = "dsh-any-agent"\nargs = []\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 120.0' },
  claude: { path: '终端执行', code: 'claude mcp add dsh-any-agent -- dsh-any-agent' },
  generic: { path: '客户端 MCP 配置 · mcpServers', code: '{\n  "mcpServers": {\n    "dsh-any-agent": {\n      "command": "dsh-any-agent",\n      "args": []\n    }\n  }\n}' },
};
let config = 'codex';
$$('[data-config]').forEach(button => button.addEventListener('click', () => {
  config = button.dataset.config;
  $('#config-path').textContent = configs[config].path; $('#config-code').textContent = configs[config].code;
  $('#config-panel').setAttribute('aria-labelledby', button.id);
  $$('[data-config]').forEach(tab => { const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
}));
$$('[role="tablist"]').forEach(list => list.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')], active = tabs.indexOf(document.activeElement);
  if (active < 0) return;
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (active + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[index].focus(); tabs[index].click();
}));
async function copy(text, button) {
  try {
    if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text); button.classList.add('copied'); announce('已复制到剪贴板');
    setTimeout(() => button.classList.remove('copied'), 1800);
  } catch {
    const pre = button.closest('.command-row')?.querySelector('code') || $('#config-code');
    const range = document.createRange(); range.selectNodeContents(pre); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    announce('已选中文本，请按 Ctrl/Cmd + C 复制');
  }
}
$$('[data-copy]').forEach(button => button.addEventListener('click', () => copy(button.dataset.copy, button)));
$('#copy-config').addEventListener('click', event => copy(configs[config].code, event.currentTarget));
render();
