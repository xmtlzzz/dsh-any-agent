#!/usr/bin/env node
// Render a handful of frames as PNGs with a single bundle — much faster than
// one `remotion still` per frame when checking layout.
//
//   npm run stills -- 300 800 1320      -> out/still-0300.png …
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frames = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (!frames.length) {
  console.error('usage: npm run stills -- <frame> [frame …]');
  process.exit(1);
}

const serveUrl = await bundle({ entryPoint: join(root, 'src', 'index.jsx') });
const composition = await selectComposition({ serveUrl, id: 'Promo' });
mkdirSync(join(root, 'out'), { recursive: true });
for (const frame of frames) {
  const output = join(root, 'out', `still-${String(frame).padStart(4, '0')}.png`);
  await renderStill({ composition, serveUrl, output, frame });
  console.log(output);
}
