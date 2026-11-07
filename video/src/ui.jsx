import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame } from 'remotion';
import { C, MONO } from './theme.js';

export const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

export const ease = (f, a, b, from = 0, to = 1, easing = Easing.out(Easing.cubic)) =>
  interpolate(f, [a, b], [from, to], { ...CLAMP, easing });

// Smooth, no overshoot.
export const settle = (f, at, fps) => (f < at ? 0 : spring({ frame: f - at, fps, config: { damping: 200 } }));

// A little bounce.
export const pop = (f, at, fps, config = { damping: 13, stiffness: 170, mass: 0.6 }) =>
  f < at ? 0 : spring({ frame: f - at, fps, config });

export const enter = (f, at, fps, dist = 28) => {
  const s = settle(f, at, fps);
  return { opacity: s, transform: `translateY(${(1 - s) * dist}px)` };
};

// Deterministic per-frame noise in [-amp, amp].
export const jitter = (f, seed = 1, amp = 1) => {
  const r = Math.sin(f * 91.7 + seed * 47.3) * 10000;
  return (r - Math.floor(r) - 0.5) * 2 * amp;
};

export const Scene = ({ duration, fadeIn = 8, fadeOut = 8, children }) => {
  const f = useCurrentFrame();
  const o = Math.min(fadeIn ? ease(f, 0, fadeIn) : 1, fadeOut ? 1 - ease(f, duration - fadeOut, duration) : 1);
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const TinyLabel = ({ children, color = C.accent, style }) => (
  <div style={{ fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em', textTransform: 'uppercase', color, ...style }}>{children}</div>
);

// The site's favicon whale.
export const WhaleMark = ({ size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <rect width="48" height="48" rx="13" fill="#0a1425" />
    <g transform="translate(8 8)" fill={C.accent}>
      <path d="M25 13c1-4 3-6 6-6-1 4-2 6-5 7 0 8-7 13-15 11C4 24 1 20 2 15c1-5 6-8 12-7 5 1 7 4 8 8 2 0 3-1 3-3Z" />
      <path d="M14 5c0-2 1-3 3-3M14 5c-1-2-3-2-4-2" fill="none" stroke={C.accent} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="14" r="1.2" fill="#0a1425" />
    </g>
  </svg>
);

export const Backdrop = () => {
  const f = useCurrentFrame();
  const x = 28 + Math.sin(f / 210) * 8;
  const y = 22 + Math.cos(f / 260) * 6;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 760px at ${x}% ${y}%, #17305a66, transparent 70%), radial-gradient(1000px 640px at ${100 - x}% ${92 - y}%, #e2bd7b12, transparent 70%), ${C.bg}`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.softLine} 1px, transparent 1px), linear-gradient(90deg, ${C.softLine} 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          backgroundPosition: `${(f * 0.15) % 64}px 0`,
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 20%, transparent 72%)',
          maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 72%)',
          opacity: 0.45,
        }}
      />
    </AbsoluteFill>
  );
};
