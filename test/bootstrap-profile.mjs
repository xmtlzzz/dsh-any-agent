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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { load as yamlLoad, dump as yamlDump } from '../src/yaml-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT = pathToFileURL(join(HERE, '..', 'src', 'bootstrap.mjs')).href;
const CONFIG = pathToFileURL(join(HERE, '..', 'src', 'config.mjs')).href;
const ACP = pathToFileURL(join(HERE, '..', 'src', 'acp.mjs')).href;
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

function runBootstrap(profile = 'test-mcp', overrides = {}) {
  const script =
    `import { ensureProfile } from ${JSON.stringify(BOOT)};\n` +
    `import { resolveTeamProfile } from ${JSON.stringify(CONFIG)};\n` +
    'const teamProfile = resolveTeamProfile();\n' +
    'console.log(JSON.stringify({ ...ensureProfile({ teamProfile }), profile: teamProfile.profile, team: !!teamProfile.backend }));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_MCP_PROFILE: profile,
      DSH_MCP_BOOTSTRAP: '',
      DSH_MCP_ROUTE_SOURCE: '',
      ...overrides,
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

  console.log('\n[4b] ★ 旧式 llm-deepseek.baseURL 里的用户名/密码不进受管 profile（审计 B06）');
  seedProfile('legacy-deepseek', `- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://legacyuser:legacypass@api.deepseek.example/v1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek
    model: deepseek-chat
`);
  const lr = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { ensureProfile } = await import(${JSON.stringify(BOOT)}); console.log(JSON.stringify(ensureProfile()));`],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DSH_HOME: home, DSH_MCP_PROFILE: 'legacy-mcp', DSH_MCP_BOOTSTRAP: '', DSH_MCP_ROUTE_SOURCE: 'legacy-deepseek' } });
  let lres = null;
  try { lres = JSON.parse(String(lr.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
  const legacyOut = join(home, 'profiles', 'legacy-mcp', 'cordis.patch.yml');
  const legacyText = existsSync(legacyOut) ? readFileSync(legacyOut, 'utf8') : '';
  check('旧式路由也能生成受管 profile', lres?.ok === true && legacyText.length > 0, JSON.stringify(lres || lr.stderr));
  check('★ baseURL 里的用户名/密码被清掉', !/legacyuser|legacypass/.test(legacyText), legacyText.match(/baseURL:[^\n]*/)?.[0] ?? '');
  check('baseURL 的主机与路径保留', legacyText.includes('https://api.deepseek.example/v1'), legacyText.match(/baseURL:[^\n]*/)?.[0] ?? '');

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

  console.log('\n[7] DSH 新旧团队实现与 profile 迁移');
  function teamEnv(version) {
    const pkg = join(root, 'runtime', version, '@deepseek-ai', 'dsh');
    const bin = join(pkg, 'lib', 'bin.js');
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, '');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version }));
    return { DSH_BIN: bin, DSH_RUNTIME: '', DSH_MCP_TEAM: '1' };
  }
  // 未提供显式 profile 时让 config 自选，避免从执行测试的客户端继承覆盖。
  const useDefault = { DSH_MCP_PROFILE: undefined, DSH_MCP_SETTINGS: join(home, 'team-settings.json') };
  const teamOff = { ...teamEnv('0.2.2-rc.3'), ...useDefault, DSH_MCP_TEAM: '' };
  const defaultMode = runBootstrap('dsh-team', teamOff);
  const ordinaryPatch = join(home, 'profiles', 'dsh-mcp', 'cordis.patch.yml');
  check('rc.3 未配置团队开关时使用普通 profile', defaultMode.result?.profile === 'dsh-mcp' && defaultMode.result?.team === false && !readFileSync(ordinaryPatch, 'utf8').includes('agent-team'));
  const legacy = runBootstrap('dsh-team', teamEnv('0.2.2-rc.1'));
  const teamPatch = join(home, 'profiles', 'dsh-team', 'cordis.patch.yml');
  const legacyTeamText = readFileSync(teamPatch, 'utf8');
  check('rc.1 保留实验版团队 profile', legacy.result?.team && legacyTeamText.includes('dsh-experimental-agent-team'));
  const native = runBootstrap('dsh-team', teamEnv('0.2.2-rc.3'));
  const nativeText = readFileSync(teamPatch, 'utf8');
  const nativeEntries = yamlLoad(nativeText);
  check('rc.3 迁移已有受管团队 profile', native.result?.ok && native.result?.team && native.result?.written && !nativeText.includes('dsh-experimental-agent-team'));
  check('新团队 profile 为新会话开启原生任务板', nativeEntries.some((e) => e.id === 'agent-team' && e.config?.defaultEnabled === true));
  check('原生团队保留普通子代理工具', !nativeEntries.some((e) => e.id?.startsWith('tool-subagent') && e.disabled));
  const againNative = runBootstrap('dsh-team', teamEnv('0.2.2-rc.3'));
  check('原生团队 profile 幂等', againNative.result?.team && againNative.result?.written === false);
  const disabledBootstrap = runBootstrap('dsh-team', { ...teamEnv('0.2.2-rc.3'), DSH_MCP_BOOTSTRAP: '0' });
  check('已配置原生团队的 profile 在关闭引导后仍被识别', disabledBootstrap.result?.team && disabledBootstrap.result?.skipped);
  const sourcePatch = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  renameSync(sourcePatch, sourcePatch + '.bak');
  try {
    writeFileSync(teamPatch, legacyTeamText);
    const migrated = runBootstrap('dsh-team', { ...teamEnv('0.2.2-rc.3'), DSH_MCP_ROUTE_SOURCE: 'desktop' });
    check('原来源消失时用旧受管团队 profile 的路由完成迁移', migrated.result?.written && readFileSync(teamPatch, 'utf8').includes('defaultEnabled: true'));
    for (const [label, previous] of [['原生', nativeText], ['实验版', legacyTeamText]]) {
      writeFileSync(ordinaryPatch, previous);
      const off = runBootstrap('dsh-team', { ...teamOff, DSH_MCP_ROUTE_SOURCE: 'desktop' });
      const restored = yamlLoad(readFileSync(ordinaryPatch, 'utf8'));
      check(`原来源消失时默认关闭受管 profile 残留的${label}团队设置`,
        off.result?.written && off.result?.team === false &&
        !restored.some((entry) => /agent-team|tool-subagent/.test(entry.id)) &&
        restored.some((entry) => entry.id === 'acp' && entry.config?.provider === 'testprov'));
    }
  } finally {
    renameSync(sourcePatch + '.bak', sourcePatch);
  }
  const manualTeam = legacyTeamText.replace('dsh-mcp:managed', 'user-owned');
  writeFileSync(teamPatch, manualTeam);
  const fallback = runBootstrap('dsh-team', { ...teamEnv('0.2.2-rc.3'), ...useDefault });
  check('过时的手写 team profile 保留，隐式选择退回普通模式', fallback.result?.team === false && fallback.result?.profile === 'dsh-mcp' && readFileSync(teamPatch, 'utf8') === manualTeam);

  writeFileSync(teamPatch, legacyTeamText);
  const hotEnv = teamEnv('0.2.2-rc.1');
  const manifest = join(dirname(hotEnv.DSH_BIN), '..', 'package.json');
  const hot = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { AcpProcess } from ${JSON.stringify(ACP)};
    const before = new AcpProcess({ cwd: process.cwd(), permission: 'workspace-write' });
    before.start();
    writeFileSync(${JSON.stringify(manifest)}, '{"version":"0.2.2-rc.3"}');
    const after = new AcpProcess({ cwd: process.cwd(), permission: 'workspace-write' });
    after.start();
    console.log(JSON.stringify([before.teamProfile, after.teamProfile]));
  `], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ...useDefault, ...hotEnv, DSH_HOME: home, DSH_MCP_BOOTSTRAP: '', DSH_MCP_ROUTE_SOURCE: '' },
  });
  const selections = hot.status === 0 ? JSON.parse(hot.stdout) : [];
  check('同一服务内，已启动宿主保留原 profile 实现，新宿主使用升级后的原生团队',
    selections[0]?.backend === 'experimental' && selections[1]?.backend === 'native' &&
    selections.every((entry) => entry.profile === 'dsh-team') && readFileSync(teamPatch, 'utf8') === nativeText,
    hot.stderr);
} catch (e) {
  failed++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== bootstrap profile 测试：通过 ${passed}，失败 ${failed} =====`);
process.exit(failed ? 1 : 0);
