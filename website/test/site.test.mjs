import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const dist=resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const html=await readFile(resolve(dist,'index.html'),'utf8');
test('Every linked local asset exists in the deployable output',async()=>{
  const paths=[...html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)].map(m=>m[1]);
  assert.ok(paths.length>=4);
  for(const path of paths)assert.ok((await stat(resolve(dist,'.'+path))).isFile(),path);
  const module=await readFile(resolve(dist,'.'+paths.find(p=>p.endsWith('.mjs'))),'utf8');
  const imported=module.match(/from '\.\/(demo\.[a-f0-9]+\.mjs)'/)[1];
  assert.ok((await stat(resolve(dist,'assets',imported))).isFile());
});
test('Navigation anchors resolve and public output contains no build placeholders or machine paths',()=>{
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  for(const match of html.matchAll(/href="#([^"\s]+)"/g))assert.ok(ids.has(match[1]),match[1]);
  assert.doesNotMatch(html,/\{\{\w+\}\}|[CD]:\\|127\.0\.0\.1:8770/);
});
test('Unknown routes have a real error page and metadata points to the selected brand asset',async()=>{
  const notFound=await readFile(resolve(dist,'404.html'),'utf8');
  assert.match(notFound,/href="\/"/);
  assert.match(html,/property="og:image" content="(?:https:\/\/[^\"]+)?\/assets\/hero\.jpg"/);
  const image=await readFile(resolve(dist,'assets/hero.jpg'));
  assert.equal(image[0],0xff);assert.equal(image[1],0xd8);
  assert.ok(image.length<400_000);
});
