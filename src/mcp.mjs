/**
 * MCP 服务端（stdio，换行分隔 JSON-RPC 2.0）。
 *
 * 只有 stdout 是协议通道，任何诊断一律走 stderr——这是硬要求，
 * 因为混进 stdout 的日志会直接破坏报文。日志默认静默（见 config.createLogger）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandlers } from './tools.mjs';
import { localizeToolDefs } from './tool-defs.mjs';
import { INSTRUCTIONS_EN } from './tool-defs.en.mjs';
import { L, LANG } from './lang.mjs';
import { DEFAULT_PERMISSION, defaultApprovalPolicy } from './config.mjs';
import { LineDecoder } from './line-decoder.mjs';
import { withLiveClient } from './live.mjs';
import { isObject, schemaIssue } from './tool-schema.mjs';

const SERVER_NAME = 'dsh-any-agent';
/**
 * Version comes from package.json so it cannot drift from the published
 * artifact. The old hard-coded copy is exactly the kind of duplicated fact
 * that goes stale the moment someone runs `npm version`.
 */
export const SERVER_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN_PROTOCOL = '2026-07-28';
const SUPPORTED_PROTOCOLS = [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS];
const PROTOCOL_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const validId = (id) => typeof id === 'string' || Number.isFinite(id);

/**
 * 服务说明（initialize.instructions）。★ 必须短：客户端会截断过长的说明（实测 Claude Code 在
 * 约 4000 字处截断，旧版 4.4k 字的末尾 —— 包括【不要做】—— 根本到不了模型）。所以：最要紧的
 * 规则放最前，细节留给各工具自己的 description 与收据文本（收据里有现成的等待/读取命令）。
 * test/smoke.mjs 守住长度上限 INSTRUCTIONS_MAX_CHARS。
 */
export const INSTRUCTIONS_MAX_CHARS = 2400;
/** 英文说明的上限：同样的内容英文更长，但仍要留在客户端的截断点（约 4000 字符）之内。 */
export const INSTRUCTIONS_EN_MAX_CHARS = 3600;

/**
 * 工具描述与服务说明用哪种语言：DSH_MCP_LANG 优先，否则跟系统语言走（与 watch / dashboard 同一条规则）。
 * 进程启动时定一次；工具返回的正文不在此列，仍是中文。
 */
export { LANG };

export const INSTRUCTIONS = `本服务把 DeepSeek Harness (DSH) 当作可长期共事的编码 agent 驱动。DSH 自带文件/shell/搜索/技能/子代理；你给**目标**，它自己决定怎么做。

【铁律】
- 给目标，不要给命令；DSH 内部工具名（read/pwsh…）不是本服务的工具，本服务只有 dsh_*。
- 会话在忙时不要再 dsh_send：排到本轮之后用 dsh_send(queue=true)（立即返回）；打断并改口用 dsh_interject（阻塞到新回合跑完）；只停下用 dsh_interrupt。
- 结果当作"完成"之前，先用你自己的工具独立核验（读文件、git diff、跑测试），再 dsh_review 提交 pass/partial/fail（fail/partial 要写理由）。
- 本服务驱动的会话**不要在 DSH GUI 里打开**：点开即被 GUI 拿走写锁且不释放。要在 GUI 看，先 dsh_release。

【三个 id】conversation_id = 长期会话（进程只是缓存，回收/崩溃后下次派活自动 resume）；run_id = 一次派活；cursor = dsh_read 的增量游标。

【流程】dsh_start(cwd?) → dsh_send(conversation_id, prompt) 默认不阻塞，立刻返回 run_id + sentinel_file → 等哨兵 → 读哨兵或 dsh_get 验收 → dsh_review。随时可用 dsh_status / dsh_read / dsh_list(only_running=true)。用完 dsh_release。

【等结果：哨兵文件，不要轮询】每个回合结束（成功/失败/取消）都会原子写出哨兵 JSON。用你的**后台任务**等它出现（收据里给了现成命令：sentinel_file_posix 给 Bash，sentinel_wait_powershell 给 PowerShell），文件一到宿主就唤醒你；读它拿 status 与 result（Windows PowerShell 读取要 -Encoding UTF8，收据里有 sentinel_read_powershell）。wait=true 会原地阻塞，等超时只转后台、不取消回合。只有调用带 progressToken 时才发进度通知。

【写锁】一个会话同时只能有一个写者。撞上 "already owned by an active write handle"（或笼统的 Internal error）时别重试，先看 dsh_status 的 lock_holder：stale-mcp → dsh_takeover；live-mcp → 那边 dsh_release，确需再 dsh_takeover(force=true)；none 多半是 GUI 持有 → 请用户在 GUI 里关掉，本服务绝不杀 GUI。

【默认值】权限 ${DEFAULT_PERMISSION}，审批上限 ${defaultApprovalPolicy(DEFAULT_PERMISSION)}；read-only 强制 auto-deny（分析不信任样本用它）。思考默认隐藏（reasoning='full' 才返回），思考深度默认 max（reasoning_effort 可调低）。

【隐私】本服务的日志/哨兵/注册表不写思考正文；但 DSH 自己的 ~/.dsh/sessions 会保存 reasoning。哨兵含正文与工具输入（常见密钥已脱敏），保留 7 天。`;

/**
 * 把 MCP root 的 file:// URI 转成本地路径。
 * 只接受 file 协议；其它（http/内嵌工作区等）一律当作“用不了”，
 * 宁可退回要求显式 cwd，也不要把一个奇怪的字符串当成目录。
 */
function fileURLToPathSafe(uri) {
  try {
    if (!uri.startsWith('file:')) return null;
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export function createMcpServer({
  hub,
  toolDefs = localizeToolDefs(LANG),
  handlers = createHandlers(hub),
  log,
  instructions = LANG === 'en' ? INSTRUCTIONS_EN : INSTRUCTIONS,
  progressIntervalMs = 5000,
  // 默认就是 stdio；常驻进程模式下每个客户端连接一对 socket 流（见 daemon.mjs）。
  input = process.stdin,
  output = process.stdout,
}) {
  const write = (obj) => {
    // 常驻进程里客户端可能已经断开：往关掉的 socket 写会抛错，丢掉即可。
    if (output.writable === false || output.destroyed) return;
    output.write(JSON.stringify(obj) + '\n');
  };
  const lineDecoder = new LineDecoder();
  const toolSchemas = new Map(toolDefs.map((tool) => [tool.name, tool]));
  const inflight = new Map();
  const capabilities = { tools: { listChanged: false } };
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  let legacyVersion;
  let initialized = false;
  let clientCapabilities = {};
  /** 这个连接的 clientInfo：live 事件流用它把会话挂到"谁派的"下面（仅名字/版本）。 */
  let clientInfo = null;
  let rootsSeq = 0;
  const pendingRoots = new Map();
  /**
   * 当前这一代 roots 的查询（进行中或已完成）。null 表示还没问过 / 客户端说换了项目。
   * ★ 缓存的是 **promise** 而不是结果：并发的第二个 dsh_start 必须等同一次回包，
   *   而不是在回包到达前拿到 null、误报“没有工作目录”（审计 B03）。
   */
  let rootsPromise = null;
  /** roots 的代数：每次 list_changed 加一，旧代的迟到回包不再生效。 */
  let rootsGen = 0;

  /**
   * 主动向客户端要一次 roots。
   * 这不是 JSON-RPC 的“请求-响应”对称用法：MCP 的服务端可以反向发请求，
   * 客户端用同一个 stdout 回响应。所以这里带 id 发出去，再等 onData 收到
   * 对应 id 的消息来完成 promise。超时/不支持都必须安静降级 —— roots 只是
   * 一个更聪明的默认值，拿不到就让调用方显式传 cwd。
   */
  function requestRoots(timeoutMs = 1500) {
    if (rootsPromise) return rootsPromise;
    const caps = clientCapabilities?.roots;
    if (!caps) return (rootsPromise = Promise.resolve(null));
    const gen = rootsGen;
    const id = 'roots-' + (rootsSeq++);
    rootsPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRoots.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pendingRoots.set(id, (roots) => {
        clearTimeout(timer);
        resolve(roots);
      });
      write({ jsonrpc: '2.0', id, method: 'roots/list', params: {} });
    }).then((roots) =>
      // ★ 等待期间客户端换了项目：这份回包已经过时，改等新一代的结果（审计 B03）。
      gen === rootsGen ? roots : requestRoots(timeoutMs),
    );
    return rootsPromise;
  }

  /** 从 roots 里挑一个最像“项目目录”的路径。 */
  function pickRoot(roots) {
    if (!Array.isArray(roots) || !roots.length) return null;
    const uris = roots.map((r) => r && typeof r.uri === 'string' ? r.uri : null).filter(Boolean);
    if (!uris.length) return null;
    const paths = [...new Set(uris.map(fileURLToPathSafe).filter(Boolean))];
    if (paths.length > 1) {
      throw new Error(L('客户端提供了多个工作区，请显式传入 cwd。', 'The client provided multiple workspace roots. Pass cwd explicitly.'));
    }
    return paths[0] ?? null;
  }

  /**
   * 调用方带了 progressToken 才发进度通知（MCP 的约定：不带就是不想要）。
   * 只有会阻塞的调用才等得到第一条：dsh_send(wait=true) 与 dsh_interject。
   * 内容只有已等时长、当前工具名和本轮已产出字数 —— 不含命令、路径或正文。
   * 返回一个停止函数。
   */
  function startProgress(token, args) {
    if ((typeof token !== 'string' && typeof token !== 'number') || !(progressIntervalMs > 0)) return () => {};
    const startedAt = Date.now();
    let progress = 0;
    const timer = setInterval(() => {
      const conv = hub?.conversations?.get?.(args?.conversation_id);
      const bits = [Math.round((Date.now() - startedAt) / 1000) + 's'];
      if (conv?.currentTool) bits.push(String(conv.currentTool));
      if (conv?.turnOutChars) bits.push(conv.turnOutChars + ' chars');
      progress += 1;
      write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, message: bits.join(' | ') } });
    }, progressIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  const fail = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, data } });

  async function handle(msg) {
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || (msg.id !== undefined && !validId(msg.id))) {
      fail(validId(msg?.id) ? msg.id : undefined, -32600, 'Invalid JSON-RPC request');
      return;
    }
    const { id, method, params } = msg;

    // 客户端对我们反向请求（roots/list）的响应：没有 method，只有 result/error。
    if (method === undefined && pendingRoots.has(id)) {
      const done = pendingRoots.get(id);
      pendingRoots.delete(id);
      done(msg.error ? [] : (msg.result?.roots ?? []));
      return;
    }
    if (typeof method !== 'string') {
      if (!Object.hasOwn(msg, 'result') && !Object.hasOwn(msg, 'error')) fail(id, -32600, 'Invalid JSON-RPC request');
      return;
    }

    // 通知（无 id）：不需要回包
    if (id === undefined) {
      if (method === 'notifications/initialized' && legacyVersion) initialized = true;
      if (method === 'notifications/cancelled') inflight.get(params?.requestId)?.abort();
      // 客户端换了打开的项目：丢掉缓存并重新问一次，下一次 dsh_start 才会用新目录。
      if (method === 'notifications/roots/list_changed' && legacyVersion) {
        rootsGen += 1;
        rootsPromise = null;
        requestRoots().catch(() => {});
      }
      return;
    }
    if (params !== undefined && !isObject(params)) {
      fail(id, -32602, 'params must be an object');
      return;
    }
    const version = params?._meta?.[PROTOCOL_META];
    const modern = version === MODERN_PROTOCOL;
    if ((version !== undefined && !modern) || (method === 'server/discover' && !modern)) {
      fail(id, -32022, 'Unsupported protocol version', {
        requested: typeof version === 'string' ? version : '',
        supported: SUPPORTED_PROTOCOLS,
      });
      return;
    }
    if (!modern && !legacyVersion && method !== 'initialize' && method !== 'ping') {
      fail(id, -32002, 'Initialize the MCP connection or provide a supported per-request protocol version');
      return;
    }
    const ok = (result) => write({
      jsonrpc: '2.0', id,
      result: modern ? { resultType: 'complete', ...result, _meta: { [SERVER_INFO_META]: serverInfo } } : result,
    });

    switch (method) {
      case 'initialize': {
        if (modern) {
          fail(id, -32601, 'Use server/discover with MCP 2026-07-28');
          return;
        }
        const requested = params?.protocolVersion;
        // 记住客户端声明了哪些能力：有 roots 的客户端（Claude Code / Cursor /
        // VS Code 等）会告诉我们它当前打开的项目目录，那是 dsh_start 最合理的
        // 默认 cwd —— 用户在客户端里看到哪个项目，就在这里干活。
        const caps = params?.capabilities;
        clientCapabilities = caps && typeof caps === 'object' ? caps : {};
        // 按连接记，不是按进程：常驻进程模式下一个进程同时服务好几个客户端（见 tools/call）。
        clientInfo = params?.clientInfo ?? null;
        legacyVersion = LEGACY_PROTOCOLS.includes(requested) ? requested : LEGACY_PROTOCOLS[0];
        ok({
          protocolVersion: legacyVersion,
          capabilities,
          serverInfo,
          instructions,
        });
        return;
      }
      case 'server/discover':
        ok({ supportedVersions: SUPPORTED_PROTOCOLS, capabilities, instructions });
        return;
      case 'roots/list': {
        // 有的客户端会主动问；我们不需要“暴露自己的根”，回空即可。
        if (modern) fail(id, -32601, 'Use an explicit cwd with MCP 2026-07-28');
        else ok({ roots: [] });
        return;
      }
      case 'ping':
        ok({});
        return;
      case 'tools/list':
        ok({
          tools: toolDefs.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
          })),
        });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments === undefined ? {} : params.arguments;
        if (typeof name !== 'string' || !isObject(args)) {
          fail(id, -32602, 'tools/call requires a name and object arguments');
          return;
        }
        // 只认 handlers 自己的属性：`constructor` / `toString` / `__proto__` 之类的
        // 原型链名字不能被当成工具调用。
        const fn = Object.hasOwn(handlers, name) ? handlers[name] : null;
        if (typeof fn !== 'function') {
          fail(id, -32602, L(`未知工具: ${name}`, `Unknown tool: ${name}`));
          return;
        }
        const schema = toolSchemas.get(name);
        const invalid = schemaIssue(schema?.inputSchema, args, 'arguments');
        if (invalid) {
          ok({ content: [{ type: 'text', text: invalid }], isError: true });
          return;
        }
        if (inflight.has(id)) {
          fail(id, -32600, 'Request ID is already in use');
          return;
        }
        const controller = new AbortController();
        inflight.set(id, controller);
        const stopProgress = startProgress(params?._meta?.progressToken, args);
        controller.signal.addEventListener('abort', stopProgress, { once: true });
        const caller = modern ? params?._meta?.[CLIENT_INFO_META] : clientInfo;
        try {
          // 进度通知必须在响应之前停下：协议不允许对已结束的请求再发进度。
          // 工具调用的整条异步链上写出的 live 事件都记在这个连接的客户端名下。
          const out = await withLiveClient(caller, () => fn(args, { signal: controller.signal, modern }));
          if (controller.signal.aborted) return;
          stopProgress();
          const result = { content: [{ type: 'text', text: out.text ?? '' }] };
          if (out.isError) result.isError = true;
          if (out.structured !== undefined) result.structuredContent = out.structured;
          const badOutput = out.isError ? null : schemaIssue(schema?.outputSchema, out.structured, 'structuredContent');
          if (badOutput) fail(id, -32603, badOutput);
          else ok(result);
        } catch (e) {
          // 只记错误摘要，不记工具内容（可能含对话正文或思考）
          log?.debug(`[tools/call ${name}] 失败: ${e.message}`);
          stopProgress();
          if (!controller.signal.aborted) ok({ content: [{ type: 'text', text: L(`工具执行失败: ${e.message}`, `Tool failed: ${e.message}`) }], isError: true });
        } finally {
          stopProgress();
          inflight.delete(id);
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  }

  function onData(chunk) {
    for (const line of lineDecoder.push(chunk)) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(undefined, -32700, 'Invalid JSON');
        continue;
      }
      Promise.resolve()
        .then(() => handle(msg))
        .catch((e) => {
          log?.debug(`[mcp] 处理 ${msg?.method} 异常: ${e.message}`);
          if (msg?.id !== undefined) fail(msg.id, -32603, `Internal error: ${e.message}`);
        });
    }
  }

  return {
    start() {
      input.on('data', onData);
      const abortPending = () => {
        for (const request of inflight.values()) request.abort();
      };
      input.once('end', abortPending);
      input.once('close', abortPending);
      output.once('close', abortPending);
      return this;
    },
    /** 客户端当前打开的项目目录；不支持 roots 的客户端返回 null。 */
    async projectDir() {
      const roots = await requestRoots();
      return pickRoot(roots);
    },
    get initialized() {
      return initialized;
    },
  };
}
