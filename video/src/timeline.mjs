// Single source of truth for timing. Both the Remotion scenes and
// scripts/make-music.mjs import this file, so every sound effect lands on
// the frame where its visual happens, and every scene cut lands on a bar.
//
// Plain .mjs on purpose: Node (the music script) and webpack (Remotion) both
// load it without a build step.

export const FPS = 30;
export const BPM = 120;
export const BEAT = (FPS * 60) / BPM; // 15 frames
export const BAR = BEAT * 4; // 60 frames = 2 s
export const WIDTH = 1920;
export const HEIGHT = 1080;

const SCENE_BARS = [
  ['hook', 3], // the problem
  ['brand', 3], // whale-girl + tagline
  ['clients', 3], // any MCP client -> dsh-any-agent -> DSH
  ['run', 8], // replay of a real `npm run demo`
  ['caps', 6], // four capabilities, animated
  ['outro', 4], // install + links
];

export const SCENES = {};
{
  let at = 0;
  for (const [id, bars] of SCENE_BARS) {
    SCENES[id] = { from: at, duration: bars * BAR };
    at += bars * BAR;
  }
}
export const TOTAL_FRAMES = SCENE_BARS.reduce((n, [, bars]) => n + bars * BAR, 0);
export const TOTAL_BARS = TOTAL_FRAMES / BAR;

// ── Scene-internal timing (frames relative to the scene start) ──────────

export const HOOK = {
  lines: [15, 60, 105],
  strike: 150,
};

export const BRAND = {
  tagline: 60,
  sub: 105,
};

export const CLIENTS = {
  title: 15,
  chipStart: 30,
  chipStep: 7.5, // one chip per 8th note
  wires: 105,
  dsh: 120,
  packets: 135,
  footer: 150,
};

// Real offsets come from demo/transcript.json; `at` is when the line shows
// up in the video. `real` drives the elapsed-time badge.
export const RUN = {
  typeStart: 15,
  typeStep: 2,
  command: '$ npm run demo',
  // [transcript line index | special, appear frame, real seconds]
  steps: [
    { at: 75, real: 0.1, callout: 0 },
    { at: 120, real: 0.2, callout: 1 },
    { at: 165, real: 7.6, callout: 2 },
    { at: 210, real: 7.7, callout: 3 },
    { at: 240, real: 38.7 },
    { at: 270, real: 56.1 },
    { at: 300, real: 56.1, callout: 4 },
    { at: 315, real: 56.1 },
    { at: 345, real: 56.1 },
    { at: 375, real: 56.1, callout: 5 },
    { at: 405, real: 57.6 },
    { at: 420, real: 57.6 },
  ],
  interrupt: 213,
  sentinelDone: 315,
  verified: 405,
  finished: 420,
};

export const CAPS = {
  title: 0,
  first: 30,
  step: 75, // five beats per capability
  // per-panel sub-events, relative to that panel's activation
  resume: { crash: 20, back: 45 },
  parallel: { done: [55, 70, 35] },
  review: { checks: [12, 24, 36], stamp: 50 },
  readonly: { deny: 30 },
  footer: 330,
};

export const OUTRO = {
  title: 0,
  cmd1: 45,
  cmd2: 90,
  typeStep: 1.5,
  links: 150,
  fade: 200,
};

// ── Sound cues (absolute frames) ────────────────────────────────────────

export function cues() {
  const list = [];
  const add = (frame, type, extra = {}) => list.push({ frame, type, ...extra });

  const h = SCENES.hook.from;
  HOOK.lines.forEach((f, i) => add(h + f, 'pluck', { note: [76, 79, 83][i] }));
  add(h + HOOK.strike, 'glitch');
  add(SCENES.brand.from - BAR * 0.75, 'riser', { length: BAR * 0.75 });

  const b = SCENES.brand.from;
  add(b, 'impact');
  add(b + BRAND.tagline, 'pluck', { note: 72 });
  add(b + BRAND.sub, 'pluck', { note: 79 });

  const c = SCENES.clients.from;
  add(c, 'whoosh');
  const penta = [72, 74, 76, 79, 81, 84, 86, 88, 91];
  for (let i = 0; i < 9; i++) add(c + CLIENTS.chipStart + i * CLIENTS.chipStep, 'blip', { note: penta[i] });
  add(c + CLIENTS.wires, 'sweep');
  add(c + CLIENTS.dsh, 'pluck', { note: 84 });
  add(c + CLIENTS.footer, 'pluck', { note: 88 });

  const r = SCENES.run.from;
  add(r, 'whoosh');
  for (let i = 0; i < RUN.command.length - 2; i++) add(r + RUN.typeStart + i * RUN.typeStep, 'key', { seed: i });
  add(r + RUN.typeStart + RUN.command.length * RUN.typeStep + 4, 'enter');
  RUN.steps.forEach((s) => add(r + s.at, 'tick'));
  add(r + RUN.interrupt, 'glitch');
  add(r + RUN.interrupt, 'duck', { length: BEAT });
  add(r + RUN.sentinelDone, 'ding');
  add(r + RUN.verified, 'chime');

  const k = SCENES.caps.from;
  add(k, 'whoosh');
  for (let i = 0; i < 4; i++) {
    const p = k + CAPS.first + i * CAPS.step;
    add(p, 'pluck', { note: [72, 76, 79, 84][i] });
    if (i === 0) {
      add(p + CAPS.resume.crash, 'thunk');
      add(p + CAPS.resume.back, 'ding');
    }
    if (i === 1) CAPS.parallel.done.forEach((d, j) => add(p + d, 'blip', { note: [84, 88, 91][j] }));
    if (i === 2) {
      CAPS.review.checks.forEach((d) => add(p + d, 'tick'));
      add(p + CAPS.review.stamp, 'stamp');
    }
    if (i === 3) add(p + CAPS.readonly.deny, 'deny');
  }
  add(k + CAPS.footer, 'pluck', { note: 79 });

  const o = SCENES.outro.from;
  add(o, 'whoosh');
  for (const [at, cmd] of [[OUTRO.cmd1, 'npm install -g dsh-any-agent'], [OUTRO.cmd2, 'dsh-any-agent-setup --yes']]) {
    for (let i = 0; i < cmd.length; i += 2) add(o + at + i * OUTRO.typeStep, 'key', { seed: i + at });
  }
  add(o + OUTRO.links, 'chime');

  return list.sort((a, b2) => a.frame - b2.frame);
}
