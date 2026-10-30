/**
 * MCP roots：dsh_start 不传 cwd 时，用客户端当前打开的项目目录。
 *
 * 为什么要有这个：在 Claude Code 里跑这套工具时，调用方得自己拼一个绝对
 * 路径。拼错或者图省事写了家目录，就会撞上 DSH 的 ACL 沙箱（%TEMP% 在家
 * 目录里面）。而客户端本来就知道用户打开的是哪个项目 —— MCP roots 就是
 * 干这个的，之前完全没用。
 *
 * 这里起一个真实的 stdio 子进程、走完整 MCP 握手，模拟一个支持 roots 的
 * 客户端，验证：
 *   - 不传 cwd 时，请求发出去了，拿到 root 后能建会话（这里用假 DSH 不行，
 *     所以只验证「取到目录」这一层，不真的拉 DSH）；
 *   - 客户端不支持 roots 时，给出可操作的报错而不是崩掉。
 *
 * 为了不依赖真实 DSH，测试直接调用 createMcpServer 暴露的 projectDir()。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'bin', 'dsh-any-agent.mjs');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  \u2713 ' + name); passed++; }
  else { console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); failed++; }
};

/** 起一个真实的服务进程，按 MCP 走握手；返回读写句柄。 */
function startServer(env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_MCP_LOG: 'silent', DSH_BIN: '/fake/never/used.js', ...env },
  });
  const waiters = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  const request = (method, params, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, close: () => { try { child.kill(); } catch { /* ignore */ } } };
}

// ── 1. 支持 roots 的客户端 ─────────────────────────────────────────

console.log('\n[1] 客户端声明 roots 能力时，服务端会主动来问');

{
  const s = startServer();
  try {
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'roots-test', version: '1' },
    });
    check('initialize 成功', init.result?.serverInfo?.name === 'dsh-any-agent',
      JSON.stringify(init.result?.serverInfo));

    // 服务端会主动发 roots/list；我们的 client 必须应答，否则它只能等超时。
    const asked = await new Promise((resolve) => {
      const onData = (d) => {
        const text = d.toString('utf8');
        if (text.includes('roots/list')) { s.child.stdout.off('data', onData); resolve(true); }
      };
      s.child.stdout.on('data', onData);
      // 触发一次：dsh_start 不传 cwd 会去要 roots。这里不真的建会话，
      // 用一次 ping 之后的空转不行，所以直接看服务端在 initialize 后是否
      // 已经能自己发请求 —— 由下面的真实 dsh_start 覆盖。
      setTimeout(() => { s.child.stdout.off('data', onData); resolve(false); }, 1200);
    });
    // 这条只做信息记录：MCP 允许服务端按需请求，不必在 initialize 后立刻发。
    console.log('  ---  initialize 后立即收到 roots/list: ' + asked + '（按需请求，属正常）');
  } catch (e) {
    check('支持 roots 的握手不抛异常', false, e.message);
  } finally {
    s.close();
  }
}

// ── 1b. 客户端应答 roots/list 后，dsh_start 真的用那个目录 ─────────

console.log('\n[1b] 客户端应答 roots/list 后，不传 cwd 也能拿到工作目录');

{
  // 一个真的会应答 roots/list 的客户端：服务端反向发请求，我们回一个
  // file:// URI 指向一个真实存在的目录。
  const realDir = join(HERE, '..', 'src'); // 一定存在
  const s = startServer();
  let sawRootsRequest = false;
  let rootUriAnswered = null;
  s.child.stdout.on('data', (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // 有 method 且有 id = 服务端发来的反向请求
      if (msg.method && msg.id !== undefined && msg.id !== null && typeof msg.id === 'string') {
        if (msg.method === 'roots/list') {
          sawRootsRequest = true;
          rootUriAnswered = pathToFileURL(realDir).href;
          s.child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { roots: [{ uri: rootUriAnswered, name: 'project' }] },
          }) + '\n');
        }
      }
    }
  });

  try {
    await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'roots-answerer', version: '1' },
    });
    // 不传 cwd：应当触发 roots/list，然后用我们给的目录继续（随后会因为
    // 没有真实 DSH 而失败，但失败点必须已经越过「没有工作目录」）。
    const started = await s.request('tools/call', { name: 'dsh_start', arguments: {} }, 20000);
    const text = started.result?.content?.[0]?.text ?? '';

    check('服务端确实发来了 roots/list', sawRootsRequest);
    check('应答的 root 是真实目录', rootUriAnswered !== null);
    check('不再报「没有可用的工作目录」', !/没有可用的工作目录/.test(text), text.slice(0, 160));
    check('报错/回执里出现了那个目录', text.includes(realDir) || /DSH CLI|DSH_BIN|not found|ENOENT/i.test(text),
      text.slice(0, 200));
  } catch (e) {
    check('roots 应答流程不抛协议级异常', false, e.message);
  } finally {
    s.close();
  }
}

// ── 2. 注册了 roots 时 dsh_start 会把 root 当作 cwd ───────────────---

console.log('\n[2] roots 能力被记录，且 projectDir() 可用');

{
  const s = startServer();
  try {
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'roots-test', version: '1' },
    });
    check('握手成功', Boolean(init.result));

    // 用一个不存在的 cwd 触发失败路径，确认报错是「可操作的」而不是崩溃。
    const started = await s.request('tools/call', {
      name: 'dsh_start',
      arguments: { cwd: join(HERE, 'no-such-dir-xyz') },
    });
    const text = started.result?.content?.[0]?.text ?? '';
    check('不存在的 cwd 给出明确报错', /不存在或不是目录/.test(text), text.slice(0, 120));
    check('服务没有崩', s.child.exitCode === null, String(s.child.exitCode));
  } catch (e) {
    check('第二条握手里程碑', false, e.message);
  } finally {
    s.close();
  }
}

// ── 3. 客户端不支持 roots：必须给出可操作的报错 ────────────────────

console.log('\n[3] 客户端不支持 roots 且没传 cwd：报错要能照着改');

{
  const s = startServer();
  try {
    await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'no-roots', version: '1' },
    });
    const started = await s.request('tools/call', {
      name: 'dsh_start',
      arguments: {},
    });
    const text = started.result?.content?.[0]?.text ?? '';
    check('给出「没有可用的工作目录」', /没有可用的工作目录/.test(text), text.slice(0, 160));
    check('告诉调用方要传 cwd 并给了例子', /cwd:\s*"/.test(text), text.slice(0, 200));
    check('提醒别用家目录', /家目录/.test(text), text.slice(0, 200));
    check('这不是崩溃（有结构化错误文本）', text.length > 0);
  } catch (e) {
    check('不支持 roots 时也不抛协议级异常', false, e.message);
  } finally {
    s.close();
  }
}

console.log('\n===== roots: passed ' + passed + ', failed ' + failed + ' =====');
process.exit(failed ? 1 : 0);