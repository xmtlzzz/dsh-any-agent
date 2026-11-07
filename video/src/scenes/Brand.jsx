import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import header from '../../../docs/brand/header.jpg';
import { BRAND } from '../timeline.mjs';
import { C } from '../theme.js';
import { CLAMP, ease, enter, pop } from '../ui.jsx';

const W = 1640;
const H = Math.round((W * 793) / 1983);

export const Brand = () => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inS = pop(f, 0, fps, { damping: 18, stiffness: 120 });
  const zoom = interpolate(f, [0, durationInFrames], [1.07, 1.0], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const flash = ease(f, 0, 14, 0.55, 0);
  const sweep = interpolate(f, [16, 80], [-30, 130], CLAMP);

  return (
    <AbsoluteFill style={{ alignItems: 'center' }}>
      <div
        style={{
          marginTop: 88,
          width: W,
          height: H,
          borderRadius: 28,
          overflow: 'hidden',
          position: 'relative',
          border: `1px solid ${C.line}`,
          boxShadow: '0 40px 120px #000000aa',
          opacity: inS,
          transform: `scale(${0.93 + 0.07 * inS})`,
        }}
      >
        <Img src={header} style={{ width: '100%', height: '100%', transform: `scale(${zoom})`, transformOrigin: '72% 50%' }} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(105deg, transparent ${sweep - 10}%, #ffffff1f ${sweep}%, transparent ${sweep + 10}%)`,
          }}
        />
      </div>
      <div style={{ marginTop: 60, fontSize: 56, fontWeight: 700, letterSpacing: '-0.01em', ...enter(f, BRAND.tagline, fps) }}>
        给任何 MCP 客户端，配一个<span style={{ color: C.accent }}>能长期共事</span>的编码搭子。
      </div>
      <div style={{ marginTop: 20, fontSize: 28, color: C.muted, ...enter(f, BRAND.sub, fps) }}>
        开个会话、扔个目标 —— 它自己写代码、跑脚本、派子代理；你随时能看、能插话、能验收。
      </div>
      <AbsoluteFill style={{ background: '#ffffff', opacity: flash }} />
    </AbsoluteFill>
  );
};
