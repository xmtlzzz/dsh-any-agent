#!/usr/bin/env node
// Synthesizes the promo soundtrack into public/bgm.wav.
//
// Everything is generated from oscillators and noise — no samples, no
// third-party loops — so the track is ours to use anywhere. Timing comes from
// src/timeline.mjs, the same file the scenes read, so every sound effect lands
// on the frame where its visual happens.
//
// Style: 120 BPM lo-fi house. Chords follow the "royal road" progression
// (IVmaj7 – V7 – iii7 – vi7), resolving to Cmaj9 on the last bar.
//
// Zero dependencies; deterministic (seeded noise), so re-running it gives a
// bit-identical file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FPS, BPM, BAR, SCENES, TOTAL_FRAMES, TOTAL_BARS, cues } from '../src/timeline.mjs';

const SR = 44100;
const N = Math.round((TOTAL_FRAMES / FPS) * SR);
const BEAT_S = 60 / BPM;
const BAR_S = BEAT_S * 4;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261107);
const noise = () => rand() * 2 - 1;

// ── Buses ───────────────────────────────────────────────────────────────
const bus = () => [new Float32Array(N), new Float32Array(N)];
const music = bus(); // pad, bass, arp — sidechained to the kick
const drums = bus();
const sfx = bus(); // never ducked
const revSend = bus();
const dlySend = bus();
const sidechain = new Float32Array(N).fill(1);
const duck = new Float32Array(N).fill(1);

const panGains = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];
const lpCoef = (fc) => 1 - Math.exp((-TAU * Math.min(fc, SR * 0.45)) / SR);

function render(start, dur, gen, { to, gain = 1, pan = 0, rev = 0, dly = 0 }) {
  const i0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  const [gl, gr] = panGains(pan);
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    if (i < 0) continue;
    if (i >= N) break;
    const s = gen(k / SR) * gain;
    to[0][i] += s * gl;
    to[1][i] += s * gr;
    if (rev) {
      revSend[0][i] += s * gl * rev;
      revSend[1][i] += s * gr * rev;
    }
    if (dly) {
      dlySend[0][i] += s * gl * dly;
      dlySend[1][i] += s * gr * dly;
    }
  }
}

function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// ── Instruments ─────────────────────────────────────────────────────────

function kick(t, g = 1) {
  let ph = 0;
  render(t, 0.5, (tt) => {
    ph += (TAU * (42 + 115 * Math.exp(-tt * 30))) / SR;
    const env = Math.min(1, tt / 0.002) * Math.exp(-tt * 6.5);
    return Math.tanh(1.6 * Math.sin(ph)) * env + noise() * Math.exp(-tt * 400) * 0.25;
  }, { to: drums, gain: 0.8 * g });
  const i0 = Math.round(t * SR);
  for (let k = 0; k < SR * 0.45; k++) {
    const i = i0 + k;
    if (i >= N) break;
    const tt = k / SR;
    sidechain[i] = Math.min(sidechain[i], 1 - 0.55 * Math.min(1, tt / 0.004) * Math.exp(-tt / 0.11));
  }
}

function clap(t, g = 1) {
  let lp = 0;
  let hp = 0;
  const a1 = lpCoef(2600);
  const a2 = lpCoef(900);
  render(t, 0.4, (tt) => {
    lp += a1 * (noise() - lp);
    hp += a2 * (lp - hp);
    let env = 0;
    for (const o of [0, 0.011, 0.022]) if (tt >= o) env = Math.max(env, Math.exp(-(tt - o) * 160));
    if (tt >= 0.03) env = Math.max(env, 0.6 * Math.exp(-(tt - 0.03) * 15));
    return (lp - hp) * env * 2.4;
  }, { to: drums, gain: 0.3 * g, pan: 0.05, rev: 0.3 });
}

function hat(t, g = 1, open = false, pan = 0) {
  let lp = 0;
  const a = lpCoef(6500);
  render(t, open ? 0.35 : 0.08, (tt) => {
    const x = noise();
    lp += a * (x - lp);
    return (x - lp) * Math.exp(-tt * (open ? 11 : 55));
  }, { to: drums, gain: 0.12 * g, pan, rev: 0.05 });
}

function bass(t, dur, midi, g = 1, rel = 0.08) {
  const f = mtof(midi);
  let ph = 0;
  render(t, dur + rel, (tt) => {
    ph += (TAU * f) / SR;
    const tail = tt > dur ? Math.max(0, 1 - (tt - dur) / rel) : 1;
    const env = Math.min(1, tt / 0.006) * (0.75 + 0.25 * Math.exp(-tt * 6)) * tail;
    return Math.tanh(1.3 * (Math.sin(ph) + 0.28 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph))) * env;
  }, { to: music, gain: 0.3 * g });
}

function cutoffAt(s) {
  const bar = s / BAR_S;
  const outroBar = SCENES.outro.from / BAR;
  if (bar < 3) return 300 * 8 ** (bar / 3); // the filter opens across the hook
  if (bar < outroBar) return 2400;
  return 2400 - 1000 * Math.min(1, (bar - outroBar) / 4);
}

function padNote(t, dur, midi, { g = 1, attack = 0.3, rel = 0.9 } = {}) {
  const f = mtof(midi);
  for (const [det, pan] of [[-0.07, -0.6], [0.07, 0.6]]) {
    const dt = (f * 2 ** (det / 12)) / SR;
    let ph = rand();
    let z1 = 0;
    let z2 = 0;
    render(t, dur + rel, (tt) => {
      ph += dt;
      if (ph >= 1) ph -= 1;
      const saw = 2 * ph - 1 - polyblep(ph, dt);
      const a = lpCoef(cutoffAt(t + tt));
      z1 += a * (saw - z1);
      z2 += a * (z1 - z2);
      const tail = tt > dur ? Math.max(0, 1 - (tt - dur) / rel) : 1;
      return z2 * Math.min(1, tt / attack) * tail;
    }, { to: music, gain: 0.05 * g, pan, rev: 0.4 });
  }
}

function fm(t, midi, { g = 1, ratio = 2, index = 1.8, decay = 7, dur = 0.7, to = music, pan = 0, rev = 0.2, dly = 0 } = {}) {
  const f = mtof(midi);
  let pc = 0;
  let pm = 0;
  render(t, dur, (tt) => {
    pm += (TAU * f * ratio) / SR;
    pc += (TAU * f) / SR;
    const idx = index * Math.exp(-tt * decay * 1.4);
    return Math.sin(pc + idx * Math.sin(pm)) * Math.min(1, tt / 0.003) * Math.exp(-tt * decay);
  }, { to, gain: g, pan, rev, dly });
}

function bell(t, midi, g = 1, pan = 0) {
  const f = mtof(midi);
  const parts = [[1, 1, 1.6], [2, 0.35, 2.4], [2.76, 0.22, 3.4], [4.07, 0.1, 5.5]];
  const ph = parts.map(() => 0);
  render(t, 2.5, (tt) => {
    let s = 0;
    for (let p = 0; p < parts.length; p++) {
      ph[p] += (TAU * f * parts[p][0]) / SR;
      s += Math.sin(ph[p]) * parts[p][1] * Math.exp(-tt * parts[p][2]);
    }
    return s * Math.min(1, tt / 0.002);
  }, { to: sfx, gain: g, pan, rev: 0.45 });
}

// Filtered noise with a moving cutoff and pan — whooshes and risers.
function sweep(t, dur, { from, peak, to, g, panFrom = -0.6, panTo = 0.6, rise = false }) {
  const i0 = Math.round(t * SR);
  const n = Math.round(dur * SR);
  let z1 = 0;
  let z2 = 0;
  let hp = 0;
  const ah = lpCoef(250);
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    if (i < 0 || i >= N) continue;
    const u = k / n;
    const fc = rise ? from * (peak / from) ** u : u < 0.5 ? from * (peak / from) ** (u * 2) : peak * (to / peak) ** ((u - 0.5) * 2);
    const a = lpCoef(fc);
    const x = noise();
    z1 += a * (x - z1);
    z2 += a * (z1 - z2);
    hp += ah * (z2 - hp);
    const env = rise ? u ** 2.2 : Math.sin(Math.PI * u) ** 1.5;
    const [gl, gr] = panGains(panFrom + (panTo - panFrom) * u);
    const s = (z2 - hp) * env * g;
    sfx[0][i] += s * gl;
    sfx[1][i] += s * gr;
    revSend[0][i] += s * gl * 0.3;
    revSend[1][i] += s * gr * 0.3;
  }
}

function impact(t) {
  let ph = 0;
  let lp = 0;
  const a = lpCoef(900);
  render(t, 1.6, (tt) => {
    ph += (TAU * (36 + 30 * Math.exp(-tt * 8))) / SR;
    lp += a * (noise() - lp);
    return Math.sin(ph) * Math.exp(-tt * 2.2) * 0.9 + lp * Math.exp(-tt * 9) * 1.6;
  }, { to: sfx, gain: 0.55, rev: 0.35 });
}

function glitch(t) {
  const r = rng(Math.round(t * 1000));
  const i0 = Math.round(t * SR);
  const n = Math.round(0.3 * SR);
  const hold = Math.round(0.018 * SR);
  let f = 400;
  let ph = 0;
  let nz = 0;
  let pan = 0;
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    if (i >= N) break;
    if (k % hold === 0) {
      f = 120 + r() * 1400;
      pan = r() * 1.4 - 0.7;
    }
    if (k % 14 === 0) nz = noise();
    ph += f / SR;
    const sq = ph % 1 < 0.5 ? 1 : -1;
    const tt = k / SR;
    const env = tt < 0.24 ? 1 : Math.max(0, (0.3 - tt) / 0.06);
    const s = Math.round((sq * 0.6 + nz * 0.5) * 4) / 4 * env * 0.1;
    const [gl, gr] = panGains(pan);
    sfx[0][i] += s * gl;
    sfx[1][i] += s * gr;
  }
}

function key(t, seed) {
  const r = rng(seed * 7919 + 13);
  const g = 0.07 + r() * 0.04;
  let lp = 0;
  const a = lpCoef(3000);
  let ph = 0;
  const f = 1800 + r() * 900;
  render(t, 0.03, (tt) => {
    const x = noise();
    lp += a * (x - lp);
    ph += (TAU * f) / SR;
    return ((x - lp) * Math.exp(-tt * 450) + Math.sin(ph) * Math.exp(-tt * 900) * 0.4);
  }, { to: sfx, gain: g, pan: r() * 0.4 - 0.2 });
}

function enter(t) {
  key(t, 999);
  let ph = 0;
  render(t, 0.12, (tt) => {
    ph += (TAU * (260 - 900 * tt)) / SR;
    return Math.sin(ph) * Math.exp(-tt * 40);
  }, { to: sfx, gain: 0.16 });
}

function tick(t) {
  let ph = 0;
  render(t, 0.04, (tt) => {
    ph += (TAU * (1900 - 9000 * tt)) / SR;
    return Math.sin(ph) * Math.exp(-tt * 120);
  }, { to: sfx, gain: 0.07, rev: 0.1 });
}

function thunk(t) {
  let ph = 0;
  render(t, 0.35, (tt) => {
    ph += (TAU * (40 + 60 * Math.exp(-tt * 25))) / SR;
    return Math.tanh(3 * (Math.sin(ph) * Math.exp(-tt * 12) + noise() * Math.exp(-tt * 60) * 0.6));
  }, { to: sfx, gain: 0.3 });
}

function stamp(t) {
  let ph = 0;
  render(t, 0.25, (tt) => {
    ph += (TAU * (70 + 70 * Math.exp(-tt * 30))) / SR;
    return Math.sin(ph) * Math.exp(-tt * 18) + noise() * Math.exp(-tt * 200) * 0.5;
  }, { to: sfx, gain: 0.38, rev: 0.25 });
}

function deny(t) {
  for (const o of [0, 0.13]) {
    let ph = 0;
    let lp = 0;
    const a = lpCoef(1400);
    render(t + o, 0.1, (tt) => {
      ph += 140 / SR;
      lp += a * ((ph % 1 < 0.5 ? 1 : -1) - lp);
      return lp * Math.min(1, tt / 0.004) * (tt > 0.085 ? Math.max(0, (0.1 - tt) / 0.015) : 1);
    }, { to: sfx, gain: 0.11 });
  }
}

// ── Arrangement ─────────────────────────────────────────────────────────

const CHORDS = [
  { root: 41, pad: [53, 57, 60, 64], arp: [65, 69, 72, 76] }, // Fmaj7
  { root: 43, pad: [55, 59, 62, 65], arp: [67, 71, 74, 77] }, // G7
  { root: 40, pad: [52, 55, 59, 62], arp: [64, 67, 71, 74] }, // Em7
  { root: 45, pad: [57, 60, 64, 67], arp: [69, 72, 76, 79] }, // Am7
];
const FINAL = { root: 36, pad: [48, 55, 59, 62, 64], arp: [72, 76, 79, 83] }; // Cmaj9
const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];

const barOf = (id) => [SCENES[id].from / BAR, (SCENES[id].from + SCENES[id].duration) / BAR];
const inScene = (b, id) => {
  const [s, e] = barOf(id);
  return b >= s && b < e;
};

for (let b = 0; b < TOTAL_BARS; b++) {
  const t0 = b * BAR_S;
  const last = b === TOTAL_BARS - 1;
  const ch = last ? FINAL : CHORDS[b % 4];
  const hook = inScene(b, 'hook');
  const brand = inScene(b, 'brand');
  const clients = inScene(b, 'clients');
  const groove = inScene(b, 'run') || inScene(b, 'caps');
  const outro = inScene(b, 'outro');

  for (const m of ch.pad) padNote(t0, BAR_S, m, { attack: b === 0 ? 1.6 : 0.3, rel: last ? 2.5 : 0.9 });

  // drums
  for (let beat = 0; beat < 4; beat++) {
    const t = t0 + beat * BEAT_S;
    if (brand && beat % 2 === 0 && !(b === barOf('brand')[0] && beat === 0)) kick(t, 0.9);
    if (clients || groove) kick(t);
    if (outro && b === barOf('outro')[0] && beat === 0) kick(t, 0.8);
    if (groove && beat % 2 === 1) clap(t);
  }
  for (let e = 0; e < 8; e++) {
    const t = t0 + e * (BEAT_S / 2);
    const off = e % 2 === 1;
    if (hook && b > 0 && off) hat(t, 0.5, false, 0.3);
    if (brand && off) hat(t, 0.8, false, 0.25);
    if (clients || groove) {
      if (groove && e === 7 && b % 2 === 1) hat(t, 0.7, true, -0.2);
      else hat(t, off ? 1 : 0.45, false, off ? 0.25 : -0.25);
    }
  }
  if (groove) hat(t0 + 3.75 * BEAT_S, 0.35, false, 0.4); // ghost 16th

  // bass
  if (brand || outro) bass(t0, BAR_S * 0.95, ch.root, 0.9, last ? 1.5 : 0.08);
  if (clients || groove) {
    bass(t0, 0.65, ch.root);
    bass(t0 + 0.75, 0.65, ch.root);
    bass(t0 + 1.5, 0.45, ch.root + 12, 0.85);
  }

  // arp
  const sixteenth = BEAT_S / 4;
  if (clients || groove) {
    const step = clients ? 2 : 1;
    for (let s = 0; s < 16; s += step) {
      let note = ch.arp[ARP_PATTERN[s]];
      if (inScene(b, 'caps') && s % 4 === 2) note += 12;
      const vel = (s % 4 === 0 ? 1 : 0.75) * (0.85 + 0.15 * rand());
      fm(t0 + s * sixteenth, note, { g: (clients ? 0.07 : 0.08) * vel, pan: s % 2 ? 0.35 : -0.35, dly: 0.3, rev: 0.15 });
    }
  }
  if (outro && !last) {
    for (let s = 0; s < 16; s += 2) fm(t0 + s * sixteenth, ch.arp[ARP_PATTERN[s]], { g: 0.055, pan: s % 4 ? 0.35 : -0.35, dly: 0.35, rev: 0.25 });
  }
  if (last) for (const [i, m] of ch.arp.entries()) bell(t0 + i * 0.09, m + 12, 0.05, i % 2 ? 0.3 : -0.3);
}

// ── Sound effects from the shared timeline ──────────────────────────────

for (const c of cues()) {
  const t = c.frame / FPS;
  switch (c.type) {
    case 'pluck':
      fm(t, c.note, { g: 0.15, ratio: 2, index: 1.2, decay: 3.2, dur: 1.6, to: sfx, rev: 0.4 });
      break;
    case 'blip':
      fm(t, c.note, { g: 0.1, ratio: 3, index: 1.5, decay: 9, dur: 0.5, to: sfx, rev: 0.25, pan: 0.2 });
      break;
    case 'riser':
      sweep(t, c.length / FPS, { from: 300, peak: 9000, g: 0.35, panFrom: 0, panTo: 0, rise: true });
      break;
    case 'impact':
      impact(t);
      break;
    case 'whoosh':
      sweep(t - 0.2, 0.6, { from: 500, peak: 4500, to: 700, g: 0.32 });
      break;
    case 'sweep':
      sweep(t, 1.0, { from: 400, peak: 3000, to: 500, g: 0.18, panFrom: -0.8, panTo: 0.8 });
      break;
    case 'key':
      key(t, c.seed);
      break;
    case 'enter':
      enter(t);
      break;
    case 'tick':
      tick(t);
      break;
    case 'glitch':
      glitch(t);
      break;
    case 'duck': {
      const i0 = Math.round(t * SR);
      const n = Math.round((c.length / FPS) * SR);
      for (let k = 0; k < n; k++) {
        const u = k / n;
        const g = u < 0.05 ? 1 - (u / 0.05) * 0.88 : u < 0.7 ? 0.12 : 0.12 + ((u - 0.7) / 0.3) * 0.88;
        if (i0 + k < N) duck[i0 + k] = Math.min(duck[i0 + k], g);
      }
      break;
    }
    case 'ding':
      bell(t, 88, 0.12);
      break;
    case 'chime':
      bell(t, 84, 0.1, -0.2);
      bell(t + 0.09, 91, 0.1, 0.2);
      break;
    case 'thunk':
      thunk(t);
      break;
    case 'stamp':
      stamp(t);
      break;
    case 'deny':
      deny(t);
      break;
    default:
      throw new Error(`unknown cue ${c.type}`);
  }
}

// ── Effects & master ────────────────────────────────────────────────────

function pingpong(time, fb) {
  const d = Math.round(time * SR);
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const a = lpCoef(3200);
  let p = 0;
  let fl = 0;
  let fr = 0;
  for (let n = 0; n < N; n++) {
    const yl = bl[p];
    const yr = br[p];
    fl += a * (yl - fl);
    fr += a * (yr - fr);
    bl[p] = (dlySend[0][n] + dlySend[1][n]) * 0.5 + fr * fb;
    br[p] = fl * fb;
    p = (p + 1) % d;
    music[0][n] += yl * 0.6;
    music[1][n] += yr * 0.6;
  }
}

function freeverb(room = 0.84, damp = 0.3, wet = 0.7) {
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const out = bus();
  for (const ch of [0, 1]) {
    const combs = combT.map((d) => ({ buf: new Float32Array(d + ch * 23), i: 0, store: 0 }));
    const aps = apT.map((d) => ({ buf: new Float32Array(d + ch * 23), i: 0 }));
    for (let n = 0; n < N; n++) {
      const x = (revSend[0][n] + revSend[1][n]) * 0.015;
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        acc += y;
      }
      for (const ap of aps) {
        const bv = ap.buf[ap.i];
        ap.buf[ap.i] = acc + bv * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0;
        acc = bv - acc;
      }
      out[ch][n] = acc * 3 * wet;
    }
  }
  return out;
}

pingpong(BEAT_S * 0.75, 0.38);
const rev = freeverb();

const outL = new Float32Array(N);
const outR = new Float32Array(N);
const fadeOut = Math.round(1.6 * SR);
let peak = 0;
for (let n = 0; n < N; n++) {
  const g = Math.min(1, n / (0.05 * SR)) * Math.min(1, (N - n) / fadeOut);
  const m = sidechain[n] * duck[n];
  outL[n] = (music[0][n] * m + drums[0][n] * duck[n] + sfx[0][n] + rev[0][n]) * g;
  outR[n] = (music[1][n] * m + drums[1][n] * duck[n] + sfx[1][n] + rev[1][n]) * g;
  peak = Math.max(peak, Math.abs(outL[n]), Math.abs(outR[n]));
}

// Normalize, then a gentle tanh saturation so stray peaks round off.
const drive = 1.25;
const norm = 1 / peak;
const sat = (x) => (Math.tanh(drive * x * norm) / Math.tanh(drive)) * 0.89;
let sumSq = 0;
for (let n = 0; n < N; n++) {
  outL[n] = sat(outL[n]);
  outR[n] = sat(outR[n]);
  sumSq += outL[n] ** 2 + outR[n] ** 2;
}

function wav(L, R) {
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + N * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(N * 4, 40);
  const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let n = 0; n < N; n++) {
    buf.writeInt16LE(q(L[n]), 44 + n * 4);
    buf.writeInt16LE(q(R[n]), 46 + n * 4);
  }
  return buf;
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'public', 'bgm.wav');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, wav(outL, outR));
const rmsDb = 10 * Math.log10(sumSq / (2 * N));
console.log(`bgm.wav  ${(N / SR).toFixed(2)}s  ${TOTAL_BARS} bars @ ${BPM} BPM  ${cues().length} cues  RMS ${rmsDb.toFixed(1)} dBFS`);
