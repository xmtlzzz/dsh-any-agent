/**
 * 首启 profile bootstrap：在发布形态（零依赖、无 runtime/）下也必须可用。
 *
 * 这里用临时 DSH_HOME 跑真实的 ensureProfile，断言：
 *   [1] 能从本机已有 profile 复制路由，生成 ACP 需要的 provider/model
 *   [2] 密钥/headers 不被抄进受管 profile
 *   [3] 生成文件带 managed 标记、幂等；用户手写（无标记）绝不被覆盖
 *   [4] 只有 llm-deepseek、没有默认模型时明确失败，而不是生成空 acp config
 *   [5] 坏 YAML 不会被"猜"成半个配置
 *   [6] yaml-lite 对 profile-example 的解析/序列化往返一致
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { load as yamlLoad, dump as yamlDump } from '../src/yaml-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT = pathToFileURL(join(HERE, '..', 'src', 'bootstrap.mjs')).href;
const EXAMPLE = join(HERE, '..', 'profile-example', 'cordis.patch.yml');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const root = mkdtempSync(join(tmpdir(), 'dsh-any-agent-bootstrap-'));
const home = join(root, 'home');

function seedProfile(name, text) {
  const dir = join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cordis.patch.yml'), text, 'utf8');
  return dir;
}

function runBootstrap(profile = 'test-mcp') {
  const script =
    `import { ensureProfile } from ${JSON.stringify(BOOT)};\n` +
    'console.log(JSON.stringify(ensureProfile()));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_MCP_PROFILE: profile,
      DSH_MCP_BOOTSTRAP: '',
      DSH_MCP_ROUTE_SOURCE: '',
    },
  });
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let result = null;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch {}
  return { result, code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const SOURCE = `# source profile
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      testprov:
        displayName: Test Provider
        apiKeyEnv: TEST_API_KEY
        api: openai-completions
        baseURL: https://user:pass@api.example.com/v1
        headers:
          Authorization: "Bearer sk-should-not-be-copied"
        models:
          - id: test-model
            name: test-model
            headers:
              X-Api-Key: sk-model-level-leak
            input:
              - text
              - image
            contextWindow: 100000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: testprov
    model: test-model
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
    defaultPreset: danger-full-access
- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: acp-default
    model: acp-default
`;

try {
  console.log('\n[1] 从已有 profile 复制路由并生成受管 profile');
  seedProfile('desktop', SOURCE);
  const first = runBootstrap();
  check('ensureProfile 成功', first.result?.ok === true, JSON.stringify(first.result));
  check('首次写入 created/written', first.result?.created === true && first.result?.written === true, JSON.stringify(first.result));

  const outPath = join(home, 'profiles', 'test-mcp', 'cordis.patch.yml');
  check('生成了 cordis.patch.yml', existsSync(outPath), outPath);
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  check('带 managed 标记', text.includes('dsh-mcp:managed'));
  const doc = text ? yamlLoad(text) : null;
  const acp = Array.isArray(doc) ? doc.find((e) => e?.id === 'acp') : null;
  check('acp 指向复制来的 provider/model', acp?.config?.provider === 'testprov' && acp?.config?.model === 'test-model', JSON.stringify(acp));
  const adm = Array.isArray(doc) ? doc.find((e) => e?.id === 'agent-default-model') : null;
  check('agent-default-model 也写入了', adm?.config?.provider === 'testprov' && adm?.config?.model === 'test-model', JSON.stringify(adm));

  console.log('\n[2] 密钥不进入受管 profile');
  check('不含 headers', !text.includes('headers'), 'generated text contains headers');
  check('不含字面密钥', !/sk-should-not-be-copied/.test(text));
  check('不含模型级嵌套密钥', !/sk-model-level-leak|X-Api-Key/.test(text));
  check('baseURL 里的 userinfo 被清掉', !/user:pass@/.test(text) && text.includes('https://api.example.com/v1'), text.match(/baseURL:[^\n]*/)?.[0] ?? '');
  check('不含 defaultPreset（否则会覆盖权限档）', !/defaultPreset/.test(text));
  const perm = Array.isArray(doc) ? doc.find((e) => e?.id === 'permission') : null;
  check('权限三档显式写入', perm?.config?.presets?.['read-only']?.sandbox === 'read-only' && perm?.config?.presets?.['workspace-write']?.sandbox === 'workspace-write' && perm?.config?.presets?.['danger-full-access']?.sandbox === 'danger-full-access', JSON.stringify(perm));

  console.log('\n[3] 幂等 + 用户手写文件不覆盖');
  const second = runBootstrap();
  check('第二次 written=false', second.result?.ok === true && second.result?.written === false, JSON.stringify(second.result));
  check('第二次字节不变', readFileSync(outPath, 'utf8') === text);

  const userText = '# user maintained\n- id: acp\n  name: "@deepseek-ai/dsh-acp"\n  config:\n    provider: mine\n    model: mine\n';
  seedProfile('user-mcp', userText);
  const userRun = runBootstrap('user-mcp');
  check('用户文件被跳过', userRun.result?.ok === true && /用户维护/.test(String(userRun.result?.skipped)), JSON.stringify(userRun.result));
  check('用户文件字节不变', readFileSync(join(home, 'profiles', 'user-mcp', 'cordis.patch.yml'), 'utf8') === userText);

  console.log('\n[4] 只有 llm-deepseek 时明确失败');
  const deepseekOnly = `- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
`;
  seedProfile('only-deepseek', deepseekOnly);
  // 让路由来源只认这个 profile
  const deepseekScript =
    `process.env.DSH_MCP_ROUTE_SOURCE='only-deepseek';` +
    `const { ensureProfile } = await import(${JSON.stringify(BOOT)});` +
    'console.log(JSON.stringify(ensureProfile()));';
  const dr = spawnSync(process.execPath, ['--input-type=module', '-e', deepseekScript], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DSH_HOME: home, DSH_MCP_PROFILE: 'deepseek-mcp', DSH_MCP_BOOTSTRAP: '', DSH_MCP_ROUTE_SOURCE: 'only-deepseek' },
  });
  let dres = null;
  try { dres = JSON.parse(String(dr.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
  check('没有默认 provider/model 时 ok=false', dres?.ok === false, JSON.stringify(dres || dr.stderr));
  check('错误信息说明缺少默认模型', /默认 provider\/model/.test(String(dres?.error)), JSON.stringify(dres));
  check('没有写出空 acp 配置', !existsSync(join(home, 'profiles', 'deepseek-mcp', 'cordis.patch.yml')));

  console.log('\n[5] 坏 YAML 不猜');
  seedProfile('broken', '- id: llm-pi-ai\n  config:\n    providers: [unclosed\n');
  const br = spawnSync(process.execPath, ['--input-type=module', '-e',
    `process.env.DSH_MCP_ROUTE_SOURCE='broken'; const { ensureProfile } = await import(${JSON.stringify(BOOT)}); console.log(JSON.stringify(ensureProfile()));`],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DSH_HOME: home, DSH_MCP_PROFILE: 'broken-mcp', DSH_MCP_BOOTSTRAP: '', DSH_MCP_ROUTE_SOURCE: 'broken' } });
  let bres = null;
  try { bres = JSON.parse(String(br.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
  check('坏 YAML 时 ok=false', bres?.ok === false, JSON.stringify(bres || br.stderr));
  check('坏 YAML 时不写 cordis.patch.yml', !existsSync(join(home, 'profiles', 'broken-mcp', 'cordis.patch.yml')));

  console.log('\n[6] yaml-lite 对 profile-example 往返');
  const example = yamlLoad(readFileSync(EXAMPLE, 'utf8'));
  check('profile-example 解析为数组', Array.isArray(example) && example.length >= 4, `length=${example?.length}`);
  const dumped = yamlDump(example);
  const again = yamlLoad(dumped);
  check('dump→load 结构一致', JSON.stringify(again) === JSON.stringify(example));
  const model = example.find((e) => e?.id === 'llm-pi-ai')?.config?.providers?.myprovider?.models?.[0];
  check('嵌套 models/input 解析正确', model?.id === 'my-model' && JSON.stringify(model?.input) === JSON.stringify(['text', 'image']), JSON.stringify(model));
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== bootstrap profile 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
