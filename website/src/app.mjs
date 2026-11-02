import {
  scenarios as scenariosZh,
  scenariosEn,
  getFrame,
  advance,
  isFinished,
  statusNames as statusNamesZh,
  statusNamesEn,
} from './demo.mjs';
import { fetchLatestVersion } from './release.mjs';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const LANG = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
const scenarios = LANG === 'en' ? scenariosEn : scenariosZh;
const statusNames = LANG === 'en' ? statusNamesEn : statusNamesZh;
const UI = {
  zh: {
    themeToLight: '切换到浅色模式', themeToDark: '切换到深色模式',
    play: '播放', pause: '暂停',
    waiting: '等待派活', restoredWaiting: '会话已恢复，等待派活', done: '本次演示任务已完成',
    interrupted: '当前回合已中断', detached: '会话已落盘，等待连接', running: '演示任务执行进度',
    identityDefault: '会话身份 · 已落盘保留', identityPersisted: 'sessionId 已落盘 · 可恢复', identityPreserved: '同一会话 · 历史已保留',
    receiptWait: '等待回执', receiptSent: '派活回执已收到', receiptInterrupted: '回合已中断',
    receiptLanded: '完成哨兵已落地', receiptCollected: '结果已收取',
    actionInterject: '插话：先补测试 ↗', actionInterrupt: '模拟进程中断 ↗',
    step: '步', copied: '已复制到剪贴板', selected: '已选中文本，请按 Ctrl/Cmd + C 复制',
    terminal: '终端执行', genericPath: '客户端 MCP 配置 · mcpServers',
    conversations: ['配置加载器重构', '配置模块回归测试', '配置使用文档'],
    goals: ['完成配置模块重构。', '补齐回归测试并核对行为。', '更新使用说明与配置示例。'],
    interjectGoal: '先补回归测试，再继续配置加载器重构。',
    defaultGoal: '重构配置加载器，补齐回归测试。',
  },
  en: {
    themeToLight: 'Switch to light mode', themeToDark: 'Switch to dark mode',
    play: 'Play', pause: 'Pause',
    waiting: 'Waiting for a task', restoredWaiting: 'Session restored; waiting for a task', done: 'Demo task complete',
    interrupted: 'Current turn interrupted', detached: 'Session persisted; waiting to connect', running: 'Demo task progress',
    identityDefault: 'Session identity · persisted on disk', identityPersisted: 'sessionId persisted · resumable', identityPreserved: 'Same session · history preserved',
    receiptWait: 'Waiting for a receipt', receiptSent: 'Dispatch receipt received', receiptInterrupted: 'Turn interrupted',
    receiptLanded: 'Completion sentinel landed', receiptCollected: 'Result collected',
    actionInterject: 'Interject: tests first ↗', actionInterrupt: 'Simulate process exit ↗',
    step: 'Step', copied: 'Copied to clipboard', selected: 'Text selected; press Ctrl/Cmd + C to copy',
    terminal: 'Terminal command', genericPath: 'Client MCP config · mcpServers',
    conversations: ['Config loader refactor', 'Config module regression tests', 'Config usage docs'],
    goals: ['Finish the config module refactor.', 'Add regression tests and verify behaviour.', 'Update docs and config examples.'],
    interjectGoal: 'Add regression tests first, then continue the config loader refactor.',
    defaultGoal: 'Refactor the config loader and add regression tests.',
  },
};
const t = (key) => UI[LANG][key] ?? UI.zh[key];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let mode = 'dispatch', step = 0, client = 'Codex', selectedJob = 0;
let playing = !motion.matches, inView = false, timer, toastTimer;
const siteTheme = (() => { try { return localStorage.getItem('dsh-theme'); } catch { return null; } })();
let theme = ['dark', 'light'].includes(siteTheme) ? siteTheme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function renderTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute('aria-label', theme === 'dark' ? t('themeToLight') : t('themeToDark'));
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
  const ended = isFinished(mode, step, scenarios);
  $('#play-icon').textContent = playing && !ended ? 'Ⅱ' : '▶';
  $('#play-label').textContent = ended ? t('play') : playing ? t('pause') : t('play');
  $('#play-pause').setAttribute('aria-pressed', String(playing && !ended));
  $('#next-step').disabled = ended;
}
function schedule() {
  clearTimeout(timer); renderPlayback();
  if (!playing || !inView || document.hidden || isFinished(mode, step, scenarios)) return;
  timer = setTimeout(() => { step = advance(mode, step, scenarios); render(); schedule(); }, 3100);
}
function render() {
  const frame = getFrame(mode, step, scenarios), scenario = scenarios[mode];
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
  const names = t('conversations');
  const jobProgress = frame.jobs;
  const progress = jobProgress ? jobProgress[selectedJob] : frame.progress;
  const status = jobProgress ? progress === 100 ? 'done' : progress ? 'running' : 'idle' : frame.status;
  $('#conversation-title').textContent = mode === 'parallel' ? names[selectedJob] : names[0];
  $('#task-goal').textContent = mode === 'parallel' ? t('goals')[selectedJob] : mode === 'interject' && step >= 2 ? t('interjectGoal') : t('defaultGoal');
  $('#status-badge').dataset.status = status;
  $('#status-badge').replaceChildren(document.createElement('i'), document.createTextNode(statusNames[status]));
  $('#runtime-state').replaceChildren(document.createElement('i'), document.createTextNode(statusNames[frame.status]));
  $('#progress-label').textContent = status === 'idle' ? mode === 'resume' && step > 0 ? t('restoredWaiting') : t('waiting') : status === 'done' ? t('done') : status === 'interrupted' ? t('interrupted') : status === 'detached' ? t('detached') : t('running');
  $('#progress-percent').textContent = `${progress}%`;
  $('#progress-fill').style.width = `${progress}%`;
  $('#progress-track').setAttribute('aria-valuenow', String(progress));
  $('#progress-track').classList.toggle('done', status === 'done');
  $('#identity-note').textContent = frame.preserved ? t('identityPreserved') : frame.persisted ? t('identityPersisted') : t('identityDefault');
  $('.identity-card code').textContent = mode === 'parallel' ? ['conv-app', 'conv-test', 'conv-docs'][selectedJob] : 'conv-app';
  $('.receipt-row').classList.toggle('received', Boolean(frame.sentinel));
  $('#receipt-icon').textContent = frame.collected ? '✓' : frame.sentinel ? '●' : step ? '↳' : '○';
  $('#receipt-label').textContent = frame.collected ? t('receiptCollected') : frame.sentinel ? t('receiptLanded') : frame.status === 'interrupted' ? t('receiptInterrupted') : step ? t('receiptSent') : t('receiptWait');
  $('#receipt-value').textContent = frame.sentinel ? `run-${mode === 'dispatch' || mode === 'parallel' ? '001' : '002'}.json` : step ? 'run_id: run-001' : 'conversation_id: conv-app';
  const action = $('#context-action');
  action.hidden = !(mode === 'interject' && step < 2 || mode === 'resume' && step === 0);
  action.textContent = mode === 'resume' ? t('actionInterrupt') : t('actionInterject');
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
    button.setAttribute('aria-label', LANG === 'en' ? `Step ${index + 1}: ${entry.title}` : `第 ${index + 1} 步：${entry.title}`);
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
  if (isFinished(mode, step, scenarios)) { step = 0; playing = true; } else playing = !playing;
  render(); schedule();
});
$('#replay').addEventListener('click', () => { step = 0; playing = !motion.matches; render(); schedule(); });
$('#next-step').addEventListener('click', () => { step = advance(mode, step, scenarios); playing = false; render(); schedule(); });
$('#context-action').addEventListener('click', () => { step = mode === 'resume' ? 1 : 2; playing = !motion.matches; render(); schedule(); });
document.addEventListener('visibilitychange', schedule);
motion.addEventListener('change', () => { if (motion.matches) { playing = false; schedule(); } });
if ('IntersectionObserver' in window) new IntersectionObserver(entries => { inView = entries[0].isIntersecting; schedule(); }, { threshold: .12 }).observe($('#demo-panel'));
else { inView = true; schedule(); }

const configs = {
  codex: { path: '~/.codex/config.toml', code: '[mcp_servers.dsh-any-agent]\ncommand = "dsh-any-agent"\nargs = []\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 120.0' },
  claude: { path: t('terminal'), code: 'claude mcp add dsh-any-agent -- dsh-any-agent' },
  generic: { path: t('genericPath'), code: '{\n  "mcpServers": {\n    "dsh-any-agent": {\n      "command": "dsh-any-agent",\n      "args": []\n    }\n  }\n}' },
};
let config = 'codex';
$$('[data-config]').forEach(button => button.addEventListener('click', () => {
  config = button.dataset.config;
  $('#config-path').textContent = configs[config].path; $('#config-code').textContent = configs[config].code;
  $('#config-panel').setAttribute('aria-labelledby', button.id);
  $$('[data-config]').forEach(tab => { const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
}));
$$('[role="tablist"]').forEach(list => {
  const vertical = list.getAttribute('aria-orientation') === 'vertical';
  const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
  const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
  list.addEventListener('keydown', event => {
    if (![prevKey, nextKey, 'Home', 'End'].includes(event.key)) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')], active = tabs.indexOf(document.activeElement);
    if (active < 0) return;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (active + (event.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[index].focus(); tabs[index].click();
  });
});
async function copy(text, button) {
  try {
    if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text); button.classList.add('copied'); announce(t('copied'));
    setTimeout(() => button.classList.remove('copied'), 1800);
  } catch {
    const pre = button.closest('.command-row')?.querySelector('code') || $('#config-code');
    const range = document.createRange(); range.selectNodeContents(pre); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    announce(t('selected'));
  }
}
$$('[data-copy]').forEach(button => button.addEventListener('click', () => copy(button.dataset.copy, button)));
$('#copy-config').addEventListener('click', event => copy(configs[config].code, event.currentTarget));
render();

// 版本号运行时同步：npm latest → GitHub release → GitHub tag；失败时保持 v—，绝不写死。
fetchLatestVersion().then(({ version, source }) => {
  const target = $('#release-version');
  if (!target) return;
  target.textContent = version ? `v${version}` : 'v—';
  target.dataset.source = source;
});
