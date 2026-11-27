import {
  scenarios as scenariosZh,
  scenariosEn,
  getFrame,
  advance,
  isFinished,
  statusNames as statusNamesZh,
  statusNamesEn,
} from './demo.mjs';
import { fetchLatestVersion, readCachedVersion, fetchGitHubStars, formatStars } from './release.mjs';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const LANG = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
const scenarios = LANG === 'en' ? scenariosEn : scenariosZh;
const statusNames = LANG === 'en' ? statusNamesEn : statusNamesZh;
const STEP_MS = 3100;

const UI = {
  zh: {
    themeToLight: '切换到浅色模式', themeToDark: '切换到深色模式',
    menuOpen: '打开导航菜单', menuClose: '关闭导航菜单',
    play: '播放', pause: '暂停',
    waiting: '等待派活', restoredWaiting: '会话已恢复，等待派活', done: '本次演示任务已完成',
    interrupted: '当前回合已中断', detached: '会话已落盘，等待连接', running: '演示任务执行进度',
    identityDefault: '会话身份 · 已落盘保留', identityPersisted: 'sessionId 已落盘 · 可恢复', identityPreserved: '同一会话 · 历史已保留',
    receiptWait: '等待回执', receiptSent: '派活回执已收到', receiptInterrupted: '回合已中断',
    receiptLanded: '完成哨兵已落地', receiptCollected: '结果已收取',
    actionInterject: '插话：先补测试 ↗', actionInterrupt: '模拟进程中断 ↗', actionInterjectBranch: '需求变了？试试中途插话 ↗',
    step: '步', copied: '已复制到剪贴板', selected: '已选中文本，请按 Ctrl/Cmd + C 复制',
    faqLinkCopied: '已复制问题链接',
    jumpedConfig: (name) => `已定位到 ${name} 手工配置`,
    toolReadOnly: '只读 · readOnlyHint', toolWrite: '写入 / 控制', toolWatchDemo: '看演示 ↗',
    terminal: '终端执行', genericPath: '通用 JSON (Claude Desktop / Windsurf / Gemini CLI / Antigravity) · mcpServers',
    vscodePath: '用户级 mcp.json（或项目 .vscode/mcp.json · servers）',
    zedPath: '~/.config/zed/settings.json（Windows: %APPDATA%\\Zed\\settings.json）',
    conversations: ['配置加载器重构', '配置模块回归测试', '配置使用文档'],
    goals: ['完成配置模块重构。', '补齐回归测试并核对行为。', '更新使用说明与配置示例。'],
    interjectGoal: '先补回归测试，再继续配置加载器重构。',
    defaultGoal: '重构配置加载器，补齐回归测试。',
  },
  en: {
    themeToLight: 'Switch to light mode', themeToDark: 'Switch to dark mode',
    menuOpen: 'Open navigation menu', menuClose: 'Close navigation menu',
    play: 'Play', pause: 'Pause',
    waiting: 'Waiting for a task', restoredWaiting: 'Session restored; waiting for a task', done: 'Demo task complete',
    interrupted: 'Current turn interrupted', detached: 'Session persisted; waiting to connect', running: 'Demo task progress',
    identityDefault: 'Session identity · persisted on disk', identityPersisted: 'sessionId persisted · resumable', identityPreserved: 'Same session · history preserved',
    receiptWait: 'Waiting for a receipt', receiptSent: 'Dispatch receipt received', receiptInterrupted: 'Turn interrupted',
    receiptLanded: 'Completion sentinel landed', receiptCollected: 'Result collected',
    actionInterject: 'Interject: tests first ↗', actionInterrupt: 'Simulate process exit ↗', actionInterjectBranch: 'Need to steer? Try interject ↗',
    step: 'Step', copied: 'Copied to clipboard', selected: 'Text selected; press Ctrl/Cmd + C to copy',
    faqLinkCopied: 'Question link copied',
    jumpedConfig: (name) => `Jumped to ${name} manual config`,
    toolReadOnly: 'Read-only · readOnlyHint', toolWrite: 'Write / Control', toolWatchDemo: 'Watch in demo ↗',
    terminal: 'Terminal command', genericPath: 'Generic JSON (Claude Desktop / Windsurf / Gemini CLI / Antigravity) · mcpServers',
    vscodePath: 'User mcp.json (or project .vscode/mcp.json · servers)',
    zedPath: '~/.config/zed/settings.json (Windows: %APPDATA%\\Zed\\settings.json)',
    conversations: ['Config loader refactor', 'Config module regression tests', 'Config usage docs'],
    goals: ['Finish the config module refactor.', 'Add regression tests and verify behaviour.', 'Update docs and config examples.'],
    interjectGoal: 'Add regression tests first, then continue the config loader refactor.',
    defaultGoal: 'Refactor the config loader and add regression tests.',
  },
};
const t = (key) => UI[LANG][key] ?? UI.zh[key];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const colorSchemeQuery = matchMedia('(prefers-color-scheme: light)');

/* ---------- Theme Switching (View Transitions + synchronized fallback) ---------- */
const siteTheme = (() => { try { return localStorage.getItem('dsh-theme'); } catch { return null; } })();
let hasManualTheme = ['dark', 'light'].includes(siteTheme);
let theme = hasManualTheme ? siteTheme : (colorSchemeQuery.matches ? 'light' : 'dark');
let themeVtToken = 0;
let activeThemeTransition = null;
let themeFallbackTimer = null;

function renderTheme() {
  document.documentElement.dataset.theme = theme;
  const label = theme === 'dark' ? t('themeToLight') : t('themeToDark');
  const toggle = $('#theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
  }
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0a101c' : '#fafbfd';
}

function applyThemeTransition(nextTheme, originEl = null) {
  if (nextTheme === theme) return;
  theme = nextTheme;
  const root = document.documentElement;

  // Reduced motion: instant swap with scattered transitions disabled to prevent contrast flash.
  if (motion.matches) {
    root.classList.add('theme-vt');
    renderTheme();
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove('theme-vt'));
    return;
  }

  // Modern browsers: single-pass GPU circular reveal from the toggle button.
  if (typeof document.startViewTransition === 'function') {
    // If the user clicks again mid-transition, skip the in-flight animation and snap cleanly
    // instead of stacking back-to-back View Transitions on the compositor.
    if (activeThemeTransition) {
      themeVtToken += 1;
      try { activeThemeTransition.skipTransition?.(); } catch {}
      activeThemeTransition = null;
      root.classList.add('theme-vt');
      renderTheme();
      void root.offsetHeight;
      requestAnimationFrame(() => root.classList.remove('theme-vt'));
      return;
    }

    const rect = originEl?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    themeVtToken += 1;
    const token = themeVtToken;
    root.classList.add('theme-vt');
    const transition = document.startViewTransition(() => {
      renderTheme();
    });
    activeThemeTransition = transition;
    transition.ready
      .then(() => {
        if (token !== themeVtToken) return;
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
          { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
        );
      })
      .catch(() => {});
    transition.finished.finally(() => {
      if (token === themeVtToken) {
        activeThemeTransition = null;
        root.classList.remove('theme-vt');
      }
    });
    return;
  }

  // Fallback: synchronize every surface/text/border transition so nothing lags behind.
  clearTimeout(themeFallbackTimer);
  root.classList.add('theme-switching');
  renderTheme();
  themeFallbackTimer = setTimeout(() => root.classList.remove('theme-switching'), 280);
}

renderTheme();
$('#theme-toggle')?.addEventListener('click', (event) => {
  hasManualTheme = true;
  const next = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('dsh-theme', next); } catch {}
  applyThemeTransition(next, event.currentTarget);
});
colorSchemeQuery.addEventListener('change', (event) => {
  if (hasManualTheme) return;
  applyThemeTransition(event.matches ? 'light' : 'dark', null);
});

/* ---------- Header: Mobile Menu, Scroll Elevation & Scroll Spy ---------- */
const header = $('#site-header') || $('.header');
const menuToggle = $('#menu-toggle');
const navLinks = $('#nav-links');
const compactNavQuery = matchMedia('(max-width: 880px)');

function setMenuOpen(open) {
  if (!header || !menuToggle) return;
  header.classList.toggle('menu-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? t('menuClose') : t('menuOpen'));
}

menuToggle?.addEventListener('click', () => {
  setMenuOpen(!header.classList.contains('menu-open'));
});
navLinks?.addEventListener('click', (event) => {
  if (event.target.closest('a')) setMenuOpen(false);
});
document.addEventListener('click', (event) => {
  if (header?.classList.contains('menu-open') && !header.contains(event.target)) setMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && header?.classList.contains('menu-open')) {
    setMenuOpen(false);
    menuToggle?.focus();
  }
});
compactNavQuery.addEventListener('change', (event) => {
  if (!event.matches) setMenuOpen(false);
});

const spyEntries = $$('#nav-links a[href^="#"]')
  .map((link) => ({ link, section: $(link.getAttribute('href')) }))
  .filter((item) => item.section);

const scrollProgressBar = $('#scroll-progress-bar');
let scrollRaf = 0;
function syncScrollState() {
  scrollRaf = 0;
  if (header) header.classList.toggle('scrolled', window.scrollY > 12);
  if (scrollProgressBar) {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = Math.min(1, Math.max(0, window.scrollY / maxScroll));
    scrollProgressBar.style.transform = `scaleX(${ratio})`;
  }
  if (!spyEntries.length) return;
  const offset = 150;
  let active = null;
  for (const item of spyEntries) {
    if (item.section.getBoundingClientRect().top <= offset) active = item;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24) {
    active = spyEntries.at(-1);
  }
  for (const item of spyEntries) {
    if (item === active) item.link.setAttribute('aria-current', 'location');
    else item.link.removeAttribute('aria-current');
  }
}
window.addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(syncScrollState);
}, { passive: true });
syncScrollState();

/* ---------- Toast Notifications ---------- */
let toastTimer;
function announce(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2300);
}

/* ---------- Code Highlighting Helpers ---------- */
function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCode(raw) {
  // 单次 token 化：先 HTML 转义，再用一个 alternation 一次性包 span。
  // 不要逐条 replace —— 先插入的 `<span class="code-str">` 会被后面的 key/boolean
  // 正则再次匹配，产生嵌套 span，把 JSON 字符串里的 `key: value` 也误染成键。
  const escaped = escapeHtml(raw);
  return escaped.split('\n').map(line => {
    if (line.trim().startsWith('//')) return `<span class="code-comment">${line}</span>`;
    return line.replace(
      /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(\b[a-zA-Z0-9_]+(?=\s*:))|(\btrue\b|\bfalse\b|\bnull\b|\b\d+(?:\.\d+)?\b)|(→)/g,
      (match, quotedKey, str, key, val, arrow) => {
        if (quotedKey) return `<span class="code-key">${quotedKey}</span>`;
        if (str) return `<span class="code-str">${str}</span>`;
        if (key) return `<span class="code-key">${key}</span>`;
        if (val) return `<span class="code-val">${val}</span>`;
        return `<span class="code-arrow">${arrow}</span>`;
      },
    );
  }).join('\n');
}

function formatConfigCode(raw, kind) {
  const escaped = escapeHtml(raw);
  if (kind === 'codex') {
    return escaped.split('\n').map(line => {
      if (/^\s*\[.+\]\s*$/.test(line)) return `<span class="code-section">${line}</span>`;
      return line.replace(
        /^(\s*[a-zA-Z0-9_]+)(\s*=\s*)(.+)$/,
        (_, key, eq, rhs) => {
          const valHtml = rhs.replace(
            /("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\b\d+(?:\.\d+)?\b)/g,
            (m, str, val) => (str ? `<span class="code-str">${str}</span>` : `<span class="code-val">${val}</span>`),
          );
          return `<span class="code-key">${key}</span>${eq}${valHtml}`;
        },
      );
    }).join('\n');
  }
  if (kind === 'claude') {
    return escaped.replace(/^(\S+)(\s+mcp\s+add\s+)(\S+)(\s+--\s+)(\S+)$/, '<span class="code-section">$1</span><span class="code-key">$2</span><span class="code-str">$3</span>$4<span class="code-val">$5</span>');
  }
  return formatCode(raw);
}

function triggerEntrance(el, cls = 'frame-enter') {
  if (!el || motion.matches) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/* ---------- Interactive Playground ---------- */
let mode = 'dispatch', step = 0, client = 'Codex', selectedJob = 0;
let playing = !motion.matches, inView = false, hoverPaused = false;
let timer = null, stepStartedAt = 0, stepRemaining = STEP_MS;
let lastFrameKey = '';

function canAutoPlay() {
  return playing && inView && !document.hidden && !motion.matches && !isFinished(mode, step, scenarios);
}

function syncTimelinePlayback() {
  const demoPanel = $('#demo-panel');
  if (demoPanel) demoPanel.classList.toggle('is-hover-paused', hoverPaused);
  const currentBtn = $('#timeline button[aria-current="step"]');
  if (currentBtn) {
    currentBtn.classList.toggle('is-playing', canAutoPlay());
  }
}

function renderPlayback() {
  const ended = isFinished(mode, step, scenarios);
  $('#play-icon').textContent = playing && !ended ? 'Ⅱ' : '▶';
  $('#play-label').textContent = ended ? t('play') : playing ? t('pause') : t('play');
  $('#play-pause').setAttribute('aria-pressed', String(playing && !ended));
  $('#next-step').disabled = ended;
  const prev = $('#prev-step');
  if (prev) prev.disabled = step === 0;
  syncTimelinePlayback();
}

function schedule(resetDuration = true) {
  clearTimeout(timer);
  timer = null;
  if (resetDuration) stepRemaining = STEP_MS;
  renderPlayback();
  if (!canAutoPlay() || hoverPaused) return;
  stepStartedAt = Date.now();
  timer = setTimeout(() => {
    step = advance(mode, step, scenarios);
    render();
    schedule(true);
  }, stepRemaining);
}

const scenarioTabsEl = $('.scenario-tabs');
const scenarioSlider = $('#scenario-slider');
let sliderInitialized = false;

function syncScenarioSlider(immediate = false) {
  if (!scenarioTabsEl || !scenarioSlider) return;
  const activeTab = scenarioTabsEl.querySelector('button[aria-selected="true"]');
  if (!activeTab || !activeTab.offsetWidth) return;
  if (immediate || !sliderInitialized) scenarioTabsEl.classList.add('slider-init');
  scenarioSlider.style.width = `${activeTab.offsetWidth}px`;
  scenarioSlider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
  scenarioTabsEl.classList.add('has-slider');
  if (immediate || !sliderInitialized) {
    void scenarioSlider.offsetWidth;
    scenarioTabsEl.classList.remove('slider-init');
    sliderInitialized = true;
  }
}

if (scenarioTabsEl && 'ResizeObserver' in window) {
  new ResizeObserver(() => syncScenarioSlider(true)).observe(scenarioTabsEl);
}
window.addEventListener('resize', () => syncScenarioSlider(true), { passive: true });

function render() {
  const frame = getFrame(mode, step, scenarios), scenario = scenarios[mode];
  const frameKey = `${mode}:${step}`;
  const frameChanged = Boolean(lastFrameKey && frameKey !== lastFrameKey);

  $('#frame-title').textContent = frame.title;
  $('#frame-detail').textContent = frame.detail;
  $('#tool-name').textContent = frame.tool;
  $('#tool-code').innerHTML = formatCode(frame.code);
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
  const runtimeState = $('#runtime-state');
  runtimeState.dataset.status = frame.status;
  runtimeState.replaceChildren(document.createElement('i'), document.createTextNode(statusNames[frame.status]));
  $('#progress-label').textContent = status === 'idle' ? mode === 'resume' && step > 0 ? t('restoredWaiting') : t('waiting') : status === 'done' ? t('done') : status === 'interrupted' ? t('interrupted') : status === 'detached' ? t('detached') : t('running');
  $('#progress-percent').textContent = `${progress}%`;
  $('#progress-fill').style.width = `${progress}%`;
  $('#progress-track').setAttribute('aria-valuenow', String(progress));
  $('#progress-track').classList.toggle('done', status === 'done');
  const connLine = $('.connection-line');
  if (connLine) connLine.dataset.status = frame.status;
  $('#identity-note').textContent = frame.preserved ? t('identityPreserved') : frame.persisted ? t('identityPersisted') : t('identityDefault');
  const sessionCode = mode === 'parallel' ? ['conv-app', 'conv-test', 'conv-docs'][selectedJob] : 'conv-app';
  $('.identity-card code').textContent = sessionCode;
  const mobileTag = $('#mobile-session-tag');
  if (mobileTag) mobileTag.textContent = sessionCode;
  $('.receipt-row').classList.toggle('received', Boolean(frame.sentinel));
  $('.receipt-row').classList.toggle('landed', Boolean(frame.sentinel && !frame.collected));
  $('#receipt-icon').textContent = frame.collected ? '✓' : frame.sentinel ? '●' : step ? '↳' : '○';
  $('#receipt-label').textContent = frame.collected ? t('receiptCollected') : frame.sentinel ? t('receiptLanded') : frame.status === 'interrupted' ? t('receiptInterrupted') : step ? t('receiptSent') : t('receiptWait');
  $('#receipt-value').textContent = frame.sentinel ? `run-${mode === 'dispatch' || mode === 'parallel' ? '001' : '002'}.json` : step ? 'run_id: run-001' : 'conversation_id: conv-app';
  const action = $('#context-action');
  const showBranch = mode === 'dispatch' && (step === 2 || step === 3);
  const showAction = (mode === 'interject' && step < 2) || (mode === 'resume' && step === 0) || showBranch;
  action.hidden = !showAction;
  if (showAction) {
    action.textContent = mode === 'resume' ? t('actionInterrupt') : showBranch ? t('actionInterjectBranch') : t('actionInterject');
  }
  $('#job-stack').hidden = mode !== 'parallel';
  if (jobProgress) $$('[data-job]').forEach((button, index) => {
    button.setAttribute('aria-pressed', String(index === selectedJob));
    button.querySelector('b').style.width = `${jobProgress[index]}%`;
    button.querySelector('small').textContent = `${jobProgress[index]}%`;
  });
  const logEntries = scenario.frames.slice(Math.max(0, step - 2), step + 1);
  $('#event-log').replaceChildren(...logEntries.map((entry, index) => {
    const p = document.createElement('p'), time = document.createElement('span');
    time.textContent = `00:${String((Math.max(0, step - 2) + index) * 3).padStart(2, '0')}`;
    p.append(time, document.createTextNode(entry.log));
    if (frameChanged && index === logEntries.length - 1) p.className = 'log-enter';
    return p;
  }));
  $('#timeline').replaceChildren(...scenario.frames.map((entry, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('aria-label', LANG === 'en' ? `Step ${index + 1}: ${entry.title}` : `第 ${index + 1} 步：${entry.title}`);
    button.dataset.state = index < step ? 'passed' : 'pending';
    const track = document.createElement('span'); track.className = 'timeline-track';
    const fill = document.createElement('i'); fill.className = 'timeline-fill';
    track.append(fill); button.append(track);
    if (index === step) {
      button.setAttribute('aria-current', 'step');
      if (canAutoPlay()) button.classList.add('is-playing');
    }
    button.addEventListener('click', () => { step = index; playing = false; render(); schedule(true); });
    return button;
  }));
  if (frameChanged) {
    triggerEntrance($('.demo-story'));
    triggerEntrance($('#tool-code'));
  }
  lastFrameKey = frameKey;
  renderPlayback();
  syncScenarioSlider(false);
}

function selectScenario(value, initialStep = 0) {
  if (!scenarios[value]) return;
  mode = value; step = initialStep; selectedJob = 0; playing = !motion.matches;
  render(); schedule(true);
}

$$('[data-scenario]').forEach(button => button.addEventListener('click', () => selectScenario(button.dataset.scenario)));
$$('[data-client]').forEach(button => button.addEventListener('click', () => { client = button.dataset.client; render(); }));
$$('[data-job]').forEach(button => button.addEventListener('click', () => { selectedJob = Number(button.dataset.job); render(); }));
$('#play-pause').addEventListener('click', () => {
  if (isFinished(mode, step, scenarios)) { step = 0; playing = true; } else playing = !playing;
  render(); schedule(true);
});
$('#replay').addEventListener('click', () => { step = 0; playing = !motion.matches; render(); schedule(true); });
$('#prev-step')?.addEventListener('click', () => {
  if (step > 0) { step -= 1; playing = false; render(); schedule(true); }
});
$('#next-step').addEventListener('click', () => { step = advance(mode, step, scenarios); playing = false; render(); schedule(true); });
$('#context-action').addEventListener('click', () => {
  if (mode === 'dispatch') {
    selectScenario('interject', 1);
  } else {
    step = mode === 'resume' ? 1 : 2;
    playing = !motion.matches;
    render();
    schedule(true);
  }
});

// Keyboard shortcuts when focus is inside the demo shell: ←/→ step, Space play/pause, R replay.
$('#demo-panel')?.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, select')) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (step > 0) { step -= 1; playing = false; render(); schedule(true); }
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (!isFinished(mode, step, scenarios)) { step = advance(mode, step, scenarios); playing = false; render(); schedule(true); }
  } else if (event.key === ' ' && event.target === event.currentTarget) {
    event.preventDefault();
    if (isFinished(mode, step, scenarios)) { step = 0; playing = true; } else playing = !playing;
    render(); schedule(true);
  } else if ((event.key === 'r' || event.key === 'R') && !event.target.closest('a')) {
    event.preventDefault();
    step = 0; playing = !motion.matches; render(); schedule(true);
  }
});

// Pause auto-advance while a mouse pointer inspects the workspace so code never jumps mid-read.
const workspaceGrid = $('.workspace-grid');
workspaceGrid?.addEventListener('pointerenter', (event) => {
  if (event.pointerType !== 'mouse') return;
  if (!canAutoPlay()) { hoverPaused = true; syncTimelinePlayback(); return; }
  hoverPaused = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    stepRemaining = Math.max(250, stepRemaining - (Date.now() - stepStartedAt));
  }
  syncTimelinePlayback();
});
workspaceGrid?.addEventListener('pointerleave', (event) => {
  if (event.pointerType !== 'mouse' || !hoverPaused) return;
  hoverPaused = false;
  schedule(false);
});

document.addEventListener('visibilitychange', () => schedule(true));
motion.addEventListener('change', () => { if (motion.matches) { playing = false; schedule(true); } });
if ('IntersectionObserver' in window) {
  new IntersectionObserver(entries => {
    const nextInView = entries[0].isIntersecting;
    if (nextInView === inView) return;
    inView = nextInView;
    render();
    schedule(true);
  }, { threshold: .12 }).observe($('#demo-panel'));
} else {
  inView = true;
  schedule(true);
}

/* ---------- Manual Config Tabs & Copy Buttons ---------- */
const configs = {
  codex: { path: '~/.codex/config.toml', code: '[mcp_servers.dsh-any-agent]\ncommand = "dsh-any-agent"\nargs = []\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 120.0' },
  claude: { path: t('terminal'), code: 'claude mcp add dsh-any-agent -- dsh-any-agent' },
  cursor: { path: '~/.cursor/mcp.json', code: '{\n  "mcpServers": {\n    "dsh-any-agent": {\n      "command": "dsh-any-agent",\n      "args": []\n    }\n  }\n}' },
  vscode: { path: t('vscodePath'), code: '{\n  "servers": {\n    "dsh-any-agent": {\n      "type": "stdio",\n      "command": "dsh-any-agent",\n      "args": []\n    }\n  }\n}' },
  zed: { path: t('zedPath'), code: '{\n  "context_servers": {\n    "dsh-any-agent": {\n      "command": {\n        "path": "dsh-any-agent",\n        "args": []\n      }\n    }\n  }\n}' },
  opencode: { path: '~/.config/opencode/opencode.json', code: '{\n  "mcp": {\n    "dsh-any-agent": {\n      "type": "local",\n      "command": ["dsh-any-agent"],\n      "enabled": true\n    }\n  }\n}' },
  generic: { path: t('genericPath'), code: '{\n  "mcpServers": {\n    "dsh-any-agent": {\n      "command": "dsh-any-agent",\n      "args": []\n    }\n  }\n}' },
};
let config = 'codex';
function renderConfig(animate = false) {
  $('#config-path').textContent = configs[config].path;
  const codeEl = $('#config-code');
  codeEl.innerHTML = formatConfigCode(configs[config].code, config);
  if (animate) triggerEntrance(codeEl);
}
renderConfig(false);

$$('[data-config]').forEach(button => button.addEventListener('click', () => {
  config = button.dataset.config;
  renderConfig(true);
  $('#config-panel').setAttribute('aria-labelledby', button.id);
  $$('[data-config]').forEach(tab => { const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
}));

const configTabs = $('.config-tabs');
const compactTabs = matchMedia('(max-width: 540px)');
function syncConfigOrientation() {
  if (configTabs) configTabs.setAttribute('aria-orientation', compactTabs.matches ? 'horizontal' : 'vertical');
}
syncConfigOrientation();
compactTabs.addEventListener('change', syncConfigOrientation);

$$('[role="tablist"]').forEach(list => {
  list.addEventListener('keydown', event => {
    const vertical = list.getAttribute('aria-orientation') === 'vertical';
    const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
    if (![prevKey, nextKey, 'Home', 'End'].includes(event.key)) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')], active = tabs.indexOf(document.activeElement);
    if (active < 0) return;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (active + (event.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[index].focus(); tabs[index].click();
  });
});

const copyTimers = new WeakMap();
async function copy(text, button) {
  try {
    if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    clearTimeout(copyTimers.get(button));
    if (!button.dataset.label) button.dataset.label = button.getAttribute('aria-label') || '';
    button.classList.add('copied');
    button.setAttribute('aria-label', t('copied'));
    const row = button.closest('.command-row');
    row?.classList.add('copied-row');
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', '#check');
    announce(t('copied'));
    copyTimers.set(button, setTimeout(() => {
      button.classList.remove('copied');
      row?.classList.remove('copied-row');
      if (button.dataset.label) button.setAttribute('aria-label', button.dataset.label);
      if (use) use.setAttribute('href', '#copy');
    }, 1800));
  } catch {
    const pre = button.closest('.command-row')?.querySelector('code') || $('#config-code');
    const range = document.createRange(); range.selectNodeContents(pre); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    announce(t('selected'));
  }
}
function selectOnlyClient(id) {
  const chip = $(`[data-only-client="${id}"]`);
  if (!chip) return;
  const preview = `dsh-any-agent-setup --only ${id}`;
  const apply = `${preview} --yes`;
  $('#only-preview-cmd').textContent = preview;
  $('#only-apply-cmd').textContent = apply;
  $('#copy-only-preview').dataset.copy = preview;
  $('#copy-only-apply').dataset.copy = apply;
  const copyBoth = $('#copy-only-all');
  if (copyBoth) copyBoth.dataset.copy = `${preview}\n${apply}`;
  $$('[data-only-client]').forEach(btn => btn.setAttribute('aria-pressed', String(btn === chip)));
}
$$('[data-only-client]').forEach(button => button.addEventListener('click', () => selectOnlyClient(button.dataset.onlyClient)));
$$('[data-copy]').forEach(button => button.addEventListener('click', () => copy(button.dataset.copy, button)));
$('#copy-config').addEventListener('click', event => copy(configs[config].code, event.currentTarget));

// Allow clicking anywhere on a command row (when not selecting text) to copy its command.
$$('.command-row').forEach(row => {
  row.addEventListener('click', (event) => {
    if (event.target.closest('button, a')) return;
    if (getSelection()?.toString()) return;
    row.querySelector('.copy-button')?.click();
  });
});

/* ---------- Client Cloud -> Jump to Matching Config & Playground ---------- */
let configFlashTimer = null;
$$('[data-jump-config]').forEach(button => {
  button.addEventListener('click', () => {
    const targetConfig = button.dataset.jumpConfig;
    const targetClient = button.dataset.jumpClient;
    if (targetClient) {
      client = targetClient;
      render();
    }
    const details = $('.manual-config');
    if (details) details.open = true;
    const tab = $(`[data-config="${targetConfig}"]`);
    if (tab) tab.click();
    const target = details || $('#install');
    target?.scrollIntoView({ behavior: motion.matches ? 'auto' : 'smooth', block: 'center' });
    const codeBox = $('.config-code');
    if (codeBox) {
      clearTimeout(configFlashTimer);
      codeBox.classList.add('config-flash');
      configFlashTimer = setTimeout(() => codeBox.classList.remove('config-flash'), 1200);
    }
    const label = button.textContent.replace(/^[✳✦⌘◈≋⌁✧◬⬡▣＋]\s*/, '').trim();
    const onlyMap = { 'Claude Code': 'claude-code', 'Claude Desktop': 'claude-desktop', Codex: 'codex', Cursor: 'cursor', Windsurf: 'windsurf', Zed: 'zed', 'Gemini CLI': 'gemini', Antigravity: 'antigravity', opencode: 'opencode', 'VS Code': 'vscode' };
    if (onlyMap[label]) selectOnlyClient(onlyMap[label]);
    announce(t('jumpedConfig')(label));
  });
});

/* ---------- Video Custom Play Overlay ---------- */
const videoFrame = $('#video-frame');
const promoVideo = $('#promo-video');
const videoOverlay = $('#video-overlay');
if (videoFrame && promoVideo && videoOverlay) {
  videoOverlay.addEventListener('click', () => {
    videoFrame.classList.add('is-playing');
    const playPromise = promoVideo.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => videoFrame.classList.remove('is-playing'));
    }
  });
  promoVideo.addEventListener('play', () => videoFrame.classList.add('is-playing'));
  promoVideo.addEventListener('ended', () => videoFrame.classList.remove('is-playing'));
}

/* ---------- Interactive 15 MCP Tools Inspector ---------- */
const TOOL_INFO = {
  dsh_start: { ro: false, demo: ['dispatch', 0], zh: ['新建会话', '在指定工作区创建可持久恢复的 DSH 会话，支持权限档与 git worktree 隔离。'], en: ['Start conversation', 'Create a persistent DSH session for a workspace with permission tier or git worktree isolation.'] },
  dsh_send: { ro: false, demo: ['dispatch', 1], zh: ['派发任务', '默认异步派活立即返回 run_id 与哨兵路径，也支持阻塞等待与 progressToken 进度推送。'], en: ['Dispatch task', 'Dispatches asynchronously by default with run_id and sentinel path, or blocks with progressToken updates.'] },
  dsh_interject: { ro: false, demo: ['interject', 2], zh: ['插话改向', '通过 ACP 取消当前回合并保留会话历史，立即按新指令开启下一轮。'], en: ['Interject', 'Cancels the active turn over ACP while keeping history intact, then starts the next turn with new guidance.'] },
  dsh_interrupt: { ro: false, demo: ['interject', 2], zh: ['中断回合', '优雅停止正在执行的回合，保存已有输出并写出 cancelled 哨兵。'], en: ['Interrupt turn', 'Stops the running turn cleanly, saves partial output, and writes a cancelled sentinel.'] },
  dsh_queue: { ro: false, demo: null, zh: ['管理队列', '查看、修改、重排或移除排队等待执行的后续任务，不打断当前进行中的回合。'], en: ['Manage queue', 'Inspect, edit, reorder, or remove queued follow-up tasks without interrupting the active turn.'] },
  dsh_list: { ro: true, demo: ['parallel', 2], zh: ['列出会话', '列出当前活跃或已落盘的会话与运行状态，支持仅筛选运行中的会话。'], en: ['List conversations', 'Lists active and persisted sessions with live run state, optionally filtering to running ones.'] },
  dsh_status: { ro: true, demo: ['interject', 0], zh: ['会话状态', '查询单个会话的实时状态、当前工具、回合计数与写锁归属。'], en: ['Conversation status', 'Inspects a single session’s live state, active tool, turn count, and write-lock status.'] },
  dsh_read: { ro: true, demo: ['dispatch', 3], zh: ['读取运行输出', '按游标增量读取后台任务的新增输出，避免把整段历史重复塞入上下文。'], en: ['Read live output', 'Reads incremental output via cursor without flooding caller context with full history.'] },
  dsh_get: { ro: true, demo: ['dispatch', 5], zh: ['获取回合结果', '按会话或 run_id 读取落盘的正文、结束原因、Git 快照摘要与待核验审核单。'], en: ['Get run result', 'Fetches persisted answer, stop reason, git snapshot summary, and review checklist by session or run_id.'] },
  dsh_review: { ro: false, demo: ['dispatch', 5], zh: ['提交审核裁决', '调用方核验产物后，在审核单上记录 pass / partial / fail 裁决与备注。'], en: ['Submit review verdict', 'Records a pass, partial, or fail verdict and notes on the completed run’s review ticket.'] },
  dsh_inbox: { ro: true, demo: null, zh: ['审批收件箱', '查看 DSH_MCP_APPROVAL=ask 模式下等待人工裁决的越界权限审批请求。'], en: ['Approval inbox', 'Lists pending sandbox escalation requests waiting for a decision under DSH_MCP_APPROVAL=ask.'] },
  dsh_approval_decide: { ro: false, demo: null, zh: ['裁决审批', '对收件箱中的指定审批请求执行放行或拒绝，并驱动会话继续执行。'], en: ['Decide approval', 'Approves or denies a pending approval request so the blocked turn can proceed.'] },
  dsh_takeover: { ro: false, demo: null, zh: ['抢占写锁', '核实持锁进程的系统启动时间确认原宿主失联后接管写锁（绝不终止 GUI），支持安全接力。'], en: ['Take over write lock', 'Verifies the holder’s OS start time before preempting a stale or sibling MCP lock (never kills the GUI).'] },
  dsh_release: { ro: false, demo: null, zh: ['释放会话', '释放单个或全部空闲会话的进程与写锁，便于回收内存或转入 DSH GUI 接手。'], en: ['Release conversation', 'Releases one or all idle sessions and their write locks to reclaim memory or hand off to DSH GUI.'] },
  dsh_doctor: { ro: true, demo: null, zh: ['环境体检', '检查实际生效的 DSH 安装（含 DSH_BIN 覆盖）与候选版本、Node 运行时、profile、常驻进程模式与数量、存储格式（dsh_storage）、工作区同步（workspace_sync）、团队模式、注册表锁、结果目录硬链接、工作树占用、孤儿锁及更新，并在摘要中区分警告与失败。'], en: ['Health check', 'Checks the active DSH installation (including DSH_BIN overrides), runtime, profile, daemon mode and count, storage format (dsh_storage), workspace sync, team mode, registry locks, hard-link support, worktree usage, orphan locks and updates, distinguishing warnings from failures.'] },
};

const toolDetailEl = $('#tool-detail');
let activeToolName = null;

function renderToolDetail(name) {
  if (!toolDetailEl) return;
  if (!name || !TOOL_INFO[name]) {
    activeToolName = null;
    toolDetailEl.hidden = true;
    toolDetailEl.replaceChildren();
    $$('.tool-chip').forEach(btn => btn.setAttribute('aria-pressed', 'false'));
    return;
  }
  activeToolName = name;
  const info = TOOL_INFO[name];
  const [title, desc] = info[LANG] || info.zh;
  $$('.tool-chip').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.tool === name)));

  const code = document.createElement('code');
  code.className = 'tool-detail-name';
  code.textContent = `${name} · ${title}`;

  const badge = document.createElement('span');
  badge.className = `tool-detail-badge${info.ro ? ' is-ro' : ''}`;
  badge.textContent = info.ro ? t('toolReadOnly') : t('toolWrite');

  const text = document.createElement('span');
  text.className = 'tool-detail-desc';
  text.textContent = desc;

  const nodes = [code, badge, text];
  if (info.demo) {
    const [demoMode, demoStep] = info.demo;
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'inline-action';
    jump.textContent = t('toolWatchDemo');
    jump.addEventListener('click', () => {
      selectScenario(demoMode, demoStep);
      playing = false;
      render();
      schedule(true);
      $('#playground')?.scrollIntoView({ behavior: motion.matches ? 'auto' : 'smooth', block: 'start' });
    });
    nodes.push(jump);
  }
  toolDetailEl.replaceChildren(...nodes);
  toolDetailEl.hidden = false;
  triggerEntrance(toolDetailEl);
}

$$('.tool-chip').forEach(button => {
  button.addEventListener('click', () => {
    const name = button.dataset.tool;
    renderToolDetail(activeToolName === name ? null : name);
  });
});

/* ---------- FAQ Deep-Link Anchors ---------- */
$$('.faq-anchor').forEach(anchor => {
  anchor.addEventListener('click', async (event) => {
    event.preventDefault();
    const hash = anchor.getAttribute('href');
    if (!hash) return;
    try { history.replaceState(null, '', hash); } catch {}
    const row = anchor.closest('.faq-row');
    if (row) {
      row.classList.remove('faq-pulse');
      void row.offsetWidth;
      row.classList.add('faq-pulse');
      setTimeout(() => row.classList.remove('faq-pulse'), 1400);
    }
    const fullUrl = `${location.origin}${location.pathname}${hash}`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(fullUrl);
      announce(t('faqLinkCopied'));
    } catch {
      announce(t('faqLinkCopied'));
    }
  });
});

/* ---------- Dashboard Lightbox ---------- */
const lightbox = $('#image-lightbox');
const dashboardZoom = $('#dashboard-zoom');
const lightboxClose = $('#lightbox-close');
if (lightbox && dashboardZoom && typeof lightbox.showModal === 'function') {
  dashboardZoom.addEventListener('click', () => lightbox.showModal());
  lightboxClose?.addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
}

/* ---------- Restrained Progressive Scroll Reveal ---------- */
if ('IntersectionObserver' in window && !motion.matches) {
  const revealNodes = $$('[data-reveal]').filter(el => el.getBoundingClientRect().top > window.innerHeight * 0.94);
  if (revealNodes.length) {
    document.documentElement.classList.add('has-reveal');
    for (const el of revealNodes) el.classList.add('reveal-pending');
    const revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        el.classList.remove('reveal-pending');
        revealObserver.unobserve(el);
        setTimeout(() => el.classList.add('reveal-done'), 560);
      }
    }, { threshold: .08, rootMargin: '0px 0px -24px 0px' });
    for (const el of revealNodes) revealObserver.observe(el);
  }
}

render();

/* ---------- Runtime Metadata: Release Version & GitHub Stars ---------- */
const updateVersionUI = (version, source) => {
  const target = $('#release-version');
  if (!target) return;
  target.textContent = version ? `v${version}` : 'v—';
  if (source) target.dataset.source = source;
};
const cachedVersion = readCachedVersion();
if (cachedVersion?.version) updateVersionUI(cachedVersion.version, 'cache');
fetchLatestVersion().then(({ version, source }) => {
  if (version || !cachedVersion?.version) updateVersionUI(version, source);
});

const updateStarsUI = (stars) => {
  const label = formatStars(stars);
  if (!label) return;
  $$('[data-github-stars]').forEach(el => {
    el.textContent = label;
    el.closest('.github-nav')?.setAttribute('aria-label', LANG === 'en' ? `Star dsh-any-agent on GitHub (★ ${label})` : `GitHub 上的 dsh-any-agent (★ ${label})`);
  });
};
try {
  const cached = JSON.parse(localStorage.getItem('dsh_gh_stars_cache') || 'null');
  if (typeof cached?.stars === 'number') updateStarsUI(cached.stars);
} catch {}
fetchGitHubStars().then(({ stars }) => {
  if (typeof stars === 'number') updateStarsUI(stars);
});
