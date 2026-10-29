/**
 * 首启引导：为本机 DSH 准备 MCP 专用的 ACP profile。
 *
 * 设计原则（v0.2 起）：**本服务自己不带任何密钥、也不拥有独立的 DSH home**。
 * 它只是"驱动本机 dsh"的一层壳，模型路由与凭据都复用用户已经配好的那一份。
 *
 * 为什么需要这个模块：ACP 这个表层必须由 @deepseek-ai/dsh-acp-app 提供，而该组合包
 * 的 patch 里把 provider/model 写死成 deepseek-official/deepseek-v4-flash。直接用它会要求
 * DEEPSEEK_API_KEY，而不是用户实际在用的那条路由。所以：
 *   1) 在 $DSH_HOME/profiles/<DSH_MCP_PROFILE>/ 建一个基于 acp 模板的 profile；
 *   2) 从本机**已有**的 profile（或 home 层 patch）里把模型路由抄过来；
 *   3) 清掉 acp 行写死的 provider/model，让会话按复制过来的路由走。
 *
 * ★ 抄过来的东西**只有路由声明**（apiKeyEnv / baseURL / api / models），任何看起来像
 *   密钥的值都会被挡掉 —— 因为这份文件会进版本库、会随包发布。真正的凭据由 DSH
 *   自己的凭据服务在每次请求时解析（$DSH_HOME/.credentials.yaml > 继承环境 > .env），
 *   与 GUI 完全同一条路径。
 *
 * 幂等性：用户手改过 profile 就不覆盖（用内容指纹判断），只报告。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOOTSTRAP_ENABLED, DSH_HOME, DSH_PROFILE, ROUTE_SOURCE_PROFILE } from './config.mjs';

/** server 包根目录（本文件位于 <server>/src/）。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 与 dsh 内置 acp 模板一致的组合包列表。 */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];

/** 抄路由时依次尝试的来源（前面的优先）。'__home__' 指 $DSH_HOME/cordis.patch.yml。 */
const DEFAULT_SOURCES = ['__home__', 'desktop', 'web', 'headless', 'acp'];

/** 生成文件里的管理标记：既当注释，也用来认出"这是本模块写的"。 */
const MANAGED_MARKER = 'dsh-mcp:managed';

/** 记下我们上次写了什么，用来区分"没人动过"与"用户手改过"。 */
const MANAGED_STATE = '.dsh-mcp-bootstrap.json';

/** apiKeyEnv 必须长成环境变量名的样子；否则视为疑似密钥，一律丢弃。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 一眼像密钥的值（防止有人把字面密钥写进 apiKeyEnv）。 */
const LOOKS_LIKE_SECRET = /^(sk-|ak-|Bearer\s|eyJ)/i;

/**
 * 载入 YAML 解析器。自包含导出包从兄弟 runtime 目录取（包内没有 node_modules），
 * 普通 npm 安装走正常的模块解析。
 */
function loadYaml() {
  const anchors = [
    join(PKG_ROOT, 'src', 'anchor.mjs'),
    join(PKG_ROOT, '..', 'runtime', 'node_modules', 'anchor.cjs'),
    join(PKG_ROOT, '..', '..', 'runtime', 'node_modules', 'anchor.cjs'),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('js-yaml');
    } catch {
      /* 换下一个锚点 */
    }
  }
  return null;
}

/** profile 目录：$DSH_HOME/profiles/<name>。 */
export function profileDir() {
  return join(DSH_HOME, 'profiles', DSH_PROFILE);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readManagedState() {
  const p = join(profileDir(), MANAGED_STATE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 丢掉一切可能携带密钥的字段，只留下纯路由声明。
 * @returns {object|null} 清洗后的 providers 字典
 */
function sanitizeProviders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [route, profile] of Object.entries(raw)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    const clean = {};
    for (const [k, v] of Object.entries(profile)) {
      // apiKey 是适配器从不读取的字段；headers 里可能夹部署凭据。两者都不复制。
      if (k === 'apiKey' || k === 'headers') continue;
      clean[k] = v;
    }
    if (typeof clean.apiKeyEnv === 'string') {
      if (LOOKS_LIKE_SECRET.test(clean.apiKeyEnv) || !ENV_NAME.test(clean.apiKeyEnv)) {
        // 疑似把字面密钥写进了 apiKeyEnv：丢掉引用，而不是把密钥抄进新文件
        delete clean.apiKeyEnv;
      }
    }
    if (Array.isArray(clean.models)) {
      clean.models = clean.models.map((m) => {
        if (!m || typeof m !== 'object') return m;
        const copy = {};
        for (const [k, v] of Object.entries(m)) {
          if (k === 'apiKey') continue;
          copy[k] = v;
        }
        return copy;
      });
    }
    out[route] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeAgentDefaultModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  if (!provider || !model) return null;
  const out = { provider, model };
  if (raw.reasoningEffort !== undefined) out.reasoningEffort = raw.reasoningEffort;
  return out;
}

/**
 * 把一份 patch 数组里的路由相关条目抽出来。
 * @returns {{providers: object|null, agentDefaultModel: object|null, llmDeepseek: object|null}|null}
 */
function extractRouting(entries) {
  if (!Array.isArray(entries)) return null;
  const byId = new Map();
  for (const e of entries) if (e && typeof e === 'object' && e.id) byId.set(e.id, e);

  const providers = sanitizeProviders(byId.get('llm-pi-ai')?.config?.providers);
  const agentDefaultModel = sanitizeAgentDefaultModel(byId.get('agent-default-model')?.config);
  const deepseek = byId.get('llm-deepseek');
  const llmDeepseek = deepseek ? sanitizeDeepseek(deepseek.config ?? {}) : null;

  if (!providers && !agentDefaultModel && !llmDeepseek) return null;
  return { providers, agentDefaultModel, llmDeepseek };
}

/** llm-deepseek 只保留连接相关字段（apiKeyEnv 是引用，不是密钥）。 */
function sanitizeDeepseek(config) {
  const out = {};
  for (const key of ['apiKeyEnv', 'baseURL', 'reasoningEffort']) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  if (typeof out.apiKeyEnv === 'string' && (!ENV_NAME.test(out.apiKeyEnv) || LOOKS_LIKE_SECRET.test(out.apiKeyEnv))) {
    delete out.apiKeyEnv;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 依次从候选来源里找第一份能用的路由。 */
function findRouting(yaml) {
  const candidates = ROUTE_SOURCE_PROFILE ? [ROUTE_SOURCE_PROFILE] : DEFAULT_SOURCES;
  const tried = [];
  for (const name of candidates) {
    const file =
      name === '__home__'
        ? join(DSH_HOME, 'cordis.patch.yml')
        : join(DSH_HOME, 'profiles', name, 'cordis.patch.yml');
    if (!existsSync(file)) {
      tried.push({ source: name, file, reason: '文件不存在' });
      continue;
    }
    let entries;
    try {
      entries = yaml.load(readFileSync(file, 'utf8'));
    } catch (e) {
      tried.push({ source: name, file, reason: '解析失败: ' + e.message });
      continue;
    }
    const routing = extractRouting(entries);
    if (routing) return { source: name, file, routing, tried };
    tried.push({ source: name, file, reason: '没有 llm-pi-ai / agent-default-model 配置' });
  }
  return { source: null, file: null, routing: null, tried };
}

/** 从抄来的路由里挑一个默认 provider/model（来源没给 agent-default-model 时用）。 */
function firstRoute(providers) {
  if (!providers) return null;
  for (const [route, profile] of Object.entries(providers)) {
    const hit = Array.isArray(profile?.models) ? profile.models.find((m) => m && m.id) : undefined;
    if (hit) return { provider: route, model: hit.id };
  }
  return null;
}

/** 生成 profile 目录里除 cordis.patch.yml 之外的文件（与 dsh 的 initProfile 一致）。 */
function ensureProfileScaffold(dir) {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    const manifest = {
      name: 'dsh-profile-' + DSH_PROFILE,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n');
  }
  const rootPath = join(dir, 'cordis.yml');
  if (!existsSync(rootPath)) {
    writeFileSync(
      rootPath,
      '# dsh profile root — an empty entry list. The tree is composed as patches:\n' +
        "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n" +
        '# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n',
    );
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    writeFileSync(
      workspacePath,
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    );
  }
}

/** 组装要写入的 patch 条目。 */
function buildEntries(routing) {
  const entries = [];
  if (routing.providers) {
    entries.push({
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: routing.providers },
    });
  }
  if (routing.llmDeepseek) {
    entries.push({
      id: 'llm-deepseek',
      name: '@deepseek-ai/dsh-llm-deepseek-api-key',
      config: routing.llmDeepseek,
    });
  }

  const fallback = firstRoute(routing.providers);
  const defaultModel = routing.agentDefaultModel || fallback;

  // ★ acp 这一行必须给出 provider/model：
  //   - acp-app 包里把它写死成 deepseek-official/deepseek-v4-flash（会去找 DEEPSEEK_API_KEY）；
  //   - 若清成 {}，ACP 会话就没有初始模型选择，settings 里的 reasoning_effort 也就无处可设。
  //   所以这里显式指向本机自己的默认路由 —— 与 GUI 会话用的是同一个模型。
  entries.push({
    id: 'acp',
    name: '@deepseek-ai/dsh-acp',
    config: defaultModel ? { provider: defaultModel.provider, model: defaultModel.model } : {},
  });

  if (defaultModel) entries.push({ id: 'agent-default-model', config: defaultModel });
  return entries;
}

function renderDocument(yaml, entries, source) {
  const where =
    source === '__home__' ? join(DSH_HOME, 'cordis.patch.yml') : 'profile "' + source + '"';
  const header = [
    '# ' + MANAGED_MARKER + ': 本文件由 dsh-any-agent 首次启动时自动生成，可安全删除后重建。',
    '# 也可以手改：手改之后 dsh-any-agent 不会再覆盖它（用内容指纹判断）。',
    '#',
    '# 这里**不含任何密钥**：路由只声明 apiKeyEnv / baseURL / api / models，',
    '# 真正的凭据由 DSH 在每次请求时从 $DSH_HOME/.credentials.yaml（或环境变量）解析，',
    '# 与 GUI 走同一条路径。所以换机器、重装、挪目录都不必重新填 key。',
    '#',
    '# 路由来源: ' + where,
    '',
  ].join('\n');
  return header + yaml.dump(entries, { lineWidth: 200, noRefs: true });
}

/**
 * 确保 $DSH_HOME/profiles/<DSH_MCP_PROFILE>/ 可用，并把本机已有路由同步进来。
 *
 * 调用时机：拉起 DSH 子进程之前（懒执行）。失败**不阻断**启动 —— 让 DSH 自己报出
 * 它的问题，比在这里吞掉更有用。
 *
 * @param {{log?: {info: Function, debug: Function}}} [options]
 * @returns {object} 结构化的结果，供日志与测试断言
 */
export function ensureProfile({ log } = {}) {
  const info = (m) => log?.info?.(m);
  const debug = (m) => log?.debug?.(m);

  if (!BOOTSTRAP_ENABLED) return { ok: true, skipped: 'DSH_MCP_BOOTSTRAP=0' };

  const dir = profileDir();
  try {
    ensureProfileScaffold(dir);
  } catch (e) {
    return { ok: false, error: '创建 profile 目录失败: ' + e.message };
  }

  const yaml = loadYaml();
  if (!yaml) {
    return {
      ok: false,
      error: '未找到 YAML 解析器（js-yaml）：无法从本机已有 profile 复制模型路由',
      reason: '请在 server/ 下安装 js-yaml，或使用自包含导出包',
    };
  }

  const patchPath = join(dir, 'cordis.patch.yml');
  const existed = existsSync(patchPath);
  const state = readManagedState();

  /**
   * 归属判断：**只看文件里有没有 MANAGED_MARKER**。
   *
   * 为什么不用内容指纹：DSH 自己也会写这个文件 —— settings 里 agent-default-model
   * 等字段是 volatile 的，ACP 会话一改模型/思考深度，DSH 就把结果持久化进 profile
   * patch。于是"内容变了"并不等于"用户手改了"，用指纹判断会把 DSH 的正常写入
   * 误判成人改，从此再也不同步（实测踩到）。
   *
   * 语义因此变成：
   *   - 有标记 → 这是本模块生成的 → 每次启动按来源重新生成（幂等、确定）；
   *     代价是 DSH 在 MCP 会话里持久化的模型选择，会在下次启动时复位成来源 profile 的选择。
   *   - 无标记（用户手写 / 删掉标记） → 完全不动它。
   */
  const currentText = existed ? readFileSync(patchPath, 'utf8') : null;
  if (currentText !== null && !currentText.includes(MANAGED_MARKER)) {
    debug('[bootstrap] profile 由用户维护（无管理标记），跳过自动同步');
    return { ok: true, skipped: 'profile 由用户维护（无管理标记），保持原样' };
  }

  const found = findRouting(yaml);
  if (!found.routing) {
    if (existed) return { ok: true, skipped: '本机没有可复制的模型路由，且 profile 已存在' };
    return {
      ok: false,
      error: '本机所有 profile 里都没有找到可用的模型路由（llm-pi-ai / agent-default-model）',
      reason: '请先在 DSH GUI 的 Models 页面配置一个 provider，再重试',
      tried: found.tried,
    };
  }

  const entries = buildEntries(found.routing);
  const text = renderDocument(yaml, entries, found.source);
  const hash = sha256(text);

  // 与磁盘上的实际内容比对（不用 state.hash：DSH 自己也会改写这个文件）
  if (currentText === text) {
    return { ok: true, written: false, source: found.source };
  }

  try {
    writeFileSync(patchPath, text);
    writeFileSync(
      join(dir, MANAGED_STATE),
      JSON.stringify(
        {
          version: 1,
          hash,
          source: found.source,
          routes: Object.keys(found.routing.providers || {}),
          generatedAt: new Date().toISOString(),
        },
        undefined,
        2,
      ) + '\n',
    );
  } catch (e) {
    return { ok: false, error: '写入 profile 失败: ' + e.message };
  }

  info(
    '[bootstrap] ' +
      (existed ? '同步' : '创建') +
      ' DSH profile "' +
      DSH_PROFILE +
      '"（路由来源: ' +
      found.source +
      '）',
  );
  return {
    ok: true,
    created: !existed,
    written: true,
    source: found.source,
    routes: Object.keys(found.routing.providers || {}),
  };
}

/** 供诊断/测试用：当前 profile 的状态，不改动任何东西。 */
export function inspectProfile() {
  const dir = profileDir();
  const patchPath = join(dir, 'cordis.patch.yml');
  const state = readManagedState();
  const yaml = loadYaml();
  let routes = [];
  let agentDefaultModel = null;
  if (yaml && existsSync(patchPath)) {
    try {
      const routing = extractRouting(yaml.load(readFileSync(patchPath, 'utf8')));
      routes = Object.keys(routing?.providers || {});
      agentDefaultModel = routing?.agentDefaultModel || null;
    } catch {
      /* 读不出来就当空 */
    }
  }
  return {
    home: DSH_HOME,
    profile: DSH_PROFILE,
    dir,
    exists: existsSync(patchPath),
    managed: Boolean(state),
    // 只表示"当前文件内容与本模块上次生成的不同"，DSH 自己写入也会造成它
    drifted: Boolean(state && state.hash && existsSync(patchPath) && sha256(readFileSync(patchPath, 'utf8')) !== state.hash),
    source: state ? state.source : null,
    routes,
    agent_default_model: agentDefaultModel,
  };
}
