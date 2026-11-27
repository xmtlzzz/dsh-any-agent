import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const defaults = {
  PERMISSION: 'DEFAULT_PERMISSION', REASONING_EFFORT: 'DEFAULT_REASONING_EFFORT', REVIEW: 'DEFAULT_REVIEW',
  MAX_LIVE: 'MAX_LIVE', IDLE_TTL_MS: 'IDLE_TTL_MS', SENTINEL_TTL_MS: 'SENTINEL_TTL_MS', DAEMON_IDLE_MS: 'DAEMON_IDLE_MS',
};
// This CLI measures factory defaults even when invoked from a configured MCP client.
for (const suffix of Object.keys(defaults)) delete process.env['DSH_MCP_' + suffix];
const config = await import('../src/config.mjs');
const { TOOL_DEFS } = await import('../src/tool-defs.mjs');
const { TOOL_TEXT_EN } = await import('../src/tool-defs.en.mjs');
const names = TOOL_DEFS.map((t) => t.name).sort();
assert.equal(names.length, 15);
assert.equal(new Set(names).size, names.length);
assert.deepEqual(names, Object.keys(TOOL_TEXT_EN).sort());
for (const file of ['README.md', 'README.zh.md', 'website/src/index.html', 'website/src/index.en.html', 'website/src/app.mjs']) {
  const content = read(file);
  for (const name of names) assert.match(content, new RegExp('\\b' + name + '\\b'), file + ' missing ' + name);
}

const inspector = /^const TOOL_INFO\s*=\s*\{([\s\S]*?)^\};/m.exec(read('website/src/app.mjs'));
assert.ok(inspector, 'Missing website TOOL_INFO declaration');
const readOnlyHints = new Map();
for (const [, name, ro] of inspector[1].matchAll(/^\s*(dsh_\w+)\s*:\s*\{\s*ro\s*:\s*(true|false)\s*,/gm)) {
  assert.ok(!readOnlyHints.has(name), 'Duplicate TOOL_INFO entry for ' + name);
  readOnlyHints.set(name, ro === 'true');
}
assert.deepEqual([...readOnlyHints.keys()].sort(), names, 'Website TOOL_INFO entries differ from TOOL_DEFS');
for (const tool of TOOL_DEFS) {
  assert.equal(readOnlyHints.get(tool.name), Boolean(tool.annotations?.readOnlyHint), 'Incorrect TOOL_INFO ro for ' + tool.name);
}

const server = JSON.parse(read('server.json'));
const guides = (lang) => readdirSync(new URL('docs/' + lang + '/', root)).filter((f) => f.endsWith('.md')).sort();
assert.deepEqual(guides('en'), guides('zh'), 'Bilingual guide filenames differ');

function referenceVariables(lang) {
  const rows = read('docs/' + lang + '/reference.md').matchAll(/^\|\s*`(DSH_[A-Z0-9_]+)`\s*\|/gm);
  return [...new Set(Array.from(rows, (row) => row[1]))].sort();
}
assert.deepEqual(referenceVariables('zh'), referenceVariables('en'), 'Bilingual reference.md environment variables differ');

for (const lang of ['en', 'zh']) {
  const ref = 'docs/' + lang + '/reference.md';
  const lines = read(ref).split(/\r?\n/);
  for (const pkg of server.packages) {
    for (const { name } of pkg.environmentVariables ?? []) {
      assert.ok(lines.some((line) => line.startsWith('| ' + quote(name) + ' |')), ref + ' missing ' + name);
    }
  }
  for (const [suffix, field] of Object.entries(defaults)) {
    const name = 'DSH_MCP_' + suffix;
    const row = lines.find((line) => line.startsWith('| ' + quote(name) + ' |'));
    assert.ok(row?.split('|')[2].trim().startsWith(quote(config[field])), ref + ' incorrect default for ' + name);
  }
  for (const file of ['docs/' + lang + '/compatibility.md', 'website/src/index' + (lang === 'en' ? '.en' : '') + '.html']) {
    assert.ok(read(file).includes(config.DSH_COMPAT.verifiedLabel), file + ' missing verified DSH range');
  }
}
console.log('Documentation matches tool names, read-only hints, bilingual environment variables, defaults and compatibility range.');

function quote(value) {
  return "`" + value + "`";
}
