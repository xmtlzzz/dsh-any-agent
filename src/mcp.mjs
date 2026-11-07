/**
 * MCP 服务端（stdio，换行分隔 JSON-RPC 2.0）。
 *
 * 只有 stdout 是协议通道，任何诊断一律走 stderr——这是硬要求，
 * 因为混进 stdout 的日志会直接破坏报文。日志默认静默（见 config.createLogger）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandlers, TOOL_DEFS } from './tools.mjs';
import { DEFAULT_PERMISSION } from './config.mjs';
import { LineDecoder } from './line-decoder.mjs';
import { setLiveClient } from './live.mjs';

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
const FALLBACK_PROTOCOL = '2025-06-18';

/**
 * 服务说明（initialize.instructions）。★ 必须短：客户端会截断过长的说明（实测 Claude Code 在
 * 约 4000 字处截断，旧版 4.4k 字的末尾 —— 包括【不要做】—— 根本到不了模型）。所以：最要紧的
 * 规则放最前，细节留给各工具自己的 description 与收据文本（收据里有现成的等待/读取命令）。
 * test/smoke.mjs 守住长度上限 INSTRUCTIONS_MAX_CHARS。
 */
export const INSTRUCTIONS_MAX_CHARS = 2400;

export const INSTRUCTIONS = `本服务把 DeepSeek Harness (DSH) 当作可长期共事的编码 agent 驱动。DSH 自带文件/shell/搜索/技能/子代理；你给**目标**，它自己决定怎么做。

【铁律】
- 给目标，不要给命令；DSH 内部工具名（read/pwsh…）不是本服务的工具，本服务只有 dsh_*。
- 会话在忙时不要再 dsh_send：改口用 dsh_interject，排到本轮之后用 dsh_interject(mode='queue') 或 dsh_send(queue=true)，停下用 dsh_interrupt。
- 结果当作"完成"之前，先用你自己的工具独立核验（读文件、git diff、跑测试），再 dsh_review 提交 pass/partial/fail（fail/partial 要写理由）。
- 本服务驱动的会话**不要在 DSH GUI 里打开**：点开即被 GUI 拿走写锁且不释放。要在 GUI 看，先 dsh_release。

【三个 id】conversation_id = 长期会话（进程只是缓存，回收/崩溃后下次派活自动 resume）；run_id = 一次派活；cursor = dsh_read 的增量游标。

【流程】dsh_start(cwd?) → dsh_send(conversation_id, prompt) 默认不阻塞，立刻返回 run_id + sentinel_file → 等哨兵 → 读哨兵或 dsh_get 验收 → dsh_review。随时可用 dsh_status / dsh_read / dsh_list(only_running=true)。用完 dsh_release。

【等结果：哨兵文件，不要轮询】每个回合结束（成功/失败/取消）都会原子写出哨兵 JSON。用你的**后台任务**等它出现（收据里给了现成命令：sentinel_file_posix 给 Bash，sentinel_wait_powershell 给 PowerShell），文件一到宿主就唤醒你；读它拿 status 与 result（Windows PowerShell 读取要 -Encoding UTF8，收据里有 sentinel_read_powershell）。wait=true 会原地阻塞，等超时只转后台、不取消回合。本服务不发 MCP 通知。

【写锁】一个会话同时只能有一个写者。撞上 "already owned by an active write handle"（或笼统的 Internal error）时别重试，先看 dsh_status 的 lock_holder：stale-mcp → dsh_takeover；live-mcp → 那边 dsh_release，确需再 dsh_takeover(force=true)；none 多半是 GUI 持有 → 请用户在 GUI 里关掉，本服务绝不杀 GUI。

【默认值】权限 ${DEFAULT_PERMISSION}，审批 ${process.env.DSH_MCP_APPROVAL ?? 'auto-allow'}；read-only 强制 auto-deny（分析不信任样本用它）。思考默认隐藏（reasoning='full' 才返回），思考深度默认 max（reasoning_effort 可调低）。

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

export function createMcpServer({ hub, toolDefs = TOOL_DEFS, handlers = createHandlers(hub), log }) {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const lineDecoder = new LineDecoder();
  let initialized = false;
  let clientCapabilities = {};
  let rootsSeq = 0;
  const pendingRoots = new Map();
  /** 客户端当前打开的项目目录（来自 MCP roots）。null 表示还没有/不支持。 */
  let clientRoots = null;
  let rootsRequested = false;

  /**
   * 主动向客户端要一次 roots。
   * 这不是 JSON-RPC 的“请求-响应”对称用法：MCP 的服务端可以反向发请求，
   * 客户端用同一个 stdout 回响应。所以这里带 id 发出去，再等 onData 收到
   * 对应 id 的消息来完成 promise。超时/不支持都必须安静降级 —— roots 只是
   * 一个更聪明的默认值，拿不到就让调用方显式传 cwd。
   */
  function requestRoots(timeoutMs = 1500) {
    if (rootsRequested) return Promise.resolve(clientRoots);
    rootsRequested = true;
    const caps = clientCapabilities?.roots;
    if (!caps) return Promise.resolve(null);
    const id = 'roots-' + (rootsSeq++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRoots.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pendingRoots.set(id, (roots) => {
        clearTimeout(timer);
        clientRoots = roots;
        resolve(roots);
      });
      write({ jsonrpc: '2.0', id, method: 'roots/list', params: {} });
    });
  }

  /** 从 roots 里挑一个最像“项目目录”的路径。 */
  function pickRoot(roots) {
    if (!Array.isArray(roots) || !roots.length) return null;
    const uris = roots.map((r) => r && typeof r.uri === 'string' ? r.uri : null).filter(Boolean);
    if (!uris.length) return null;
    for (const uri of uris) {
      const asPath = fileURLToPathSafe(uri);
      if (asPath) return asPath;
    }
    return null;
  }

  const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;

    // 客户端对我们反向请求（roots/list）的响应：没有 method，只有 result/error。
    if (method === undefined && pendingRoots.has(id)) {
      const done = pendingRoots.get(id);
      pendingRoots.delete(id);
      done(msg.error ? [] : (msg.result?.roots ?? []));
      return;
    }

    // 通知（无 id）：不需要回包
    if (id === undefined) {
      if (method === 'notifications/initialized') initialized = true;
      // 客户端换了打开的项目：丢掉缓存并重新问一次，下一次 dsh_start 才会用新目录。
      if (method === 'notifications/roots/list_changed') {
        clientRoots = null;
        rootsRequested = false;
        requestRoots().catch(() => {});
      }
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        // 记住客户端声明了哪些能力：有 roots 的客户端（Claude Code / Cursor /
        // VS Code 等）会告诉我们它当前打开的项目目录，那是 dsh_start 最合理的
        // 默认 cwd —— 用户在客户端里看到哪个项目，就在这里干活。
        const caps = params?.capabilities;
        clientCapabilities = caps && typeof caps === 'object' ? caps : {};
        // live 事件流用客户端名把会话挂到"谁派的"下面（仅名字/版本，不含其它字段）。
        setLiveClient(params?.clientInfo);
        ok(id, {
          protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'roots/list': {
        // 有的客户端会主动问；我们不需要“暴露自己的根”，回空即可。
        ok(id, { roots: [] });
        return;
      }
      case 'ping':
        ok(id, {});
        return;
      case 'tools/list':
        ok(id, {
          tools: toolDefs.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        // 只认 handlers 自己的属性：`constructor` / `toString` / `__proto__` 之类的
        // 原型链名字不能被当成工具调用。
        const fn = Object.hasOwn(handlers, name) ? handlers[name] : null;
        if (typeof fn !== 'function') {
          ok(id, { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true });
          return;
        }
        try {
          const out = await fn(args);
          const result = { content: [{ type: 'text', text: out.text ?? '' }] };
          if (out.structured !== undefined) result.structuredContent = out.structured;
          ok(id, result);
        } catch (e) {
          // 只记错误摘要，不记工具内容（可能含对话正文或思考）
          log?.debug(`[tools/call ${name}] 失败: ${e.message}`);
          ok(id, { content: [{ type: 'text', text: `工具执行失败: ${e.message}` }], isError: true });
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
        log?.debug('[mcp] 收到非 JSON 行（已忽略）');
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
      process.stdin.on('data', onData);
      process.stdin.on('end', () => log?.debug('[mcp] stdin 结束'));
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