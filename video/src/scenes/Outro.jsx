import React from 'react';
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from 'remotion';
import header from '../../../docs/brand/header.jpg';
import { OUTRO } from '../timeline.mjs';
import { C, MONO } from '../theme.js';
import { TinyLabel, ease, enter, pop } from '../ui.jsx';

// Crop the right half of the README banner: the whale-girl and her rice.
const CARD = { w: 760, h: 640 };
const IMG_W = Math.round((CARD.h * 1983) / 793);

const Typed = ({ f, at, text }) => {
  const n = Math.max(0, Math.min(text.length, Math.floor((f - at) / OUTRO.typeStep) + 1));
  if (f < at) return null;
  return (
    <div style={{ fontFamily: MONO, fontSize: 28, lineHeight: '46px', whiteSpace: 'pre' }}>
      <span style={{ color: C.green }}>$ </span>
      <span>{text.slice(0, n)}</span>
    </div>
  );
};

export const Outro = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = pop(f, 6, fps, { damping: 18, stiffness: 110 });
  const float = Math.sin(f / 22) * 8;
  const end = ease(f, OUTRO.fade, OUTRO.fade + 36);

  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 140, top: 250, width: 880 }}>
        <TinyLabel style={enter(f, OUTRO.title, fps, 14)}>A coding buddy that sticks around.</TinyLabel>
        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 800, lineHeight: 1.18, letterSpacing: '-0.015em', ...enter(f, OUTRO.title + 4, fps) }}>
          把长任务交出去，
          <br />
          <span style={{ color: C.accent }}>把掌控留在手里。</span>
        </div>

        <div
          style={{
            marginTop: 46,
            padding: '20px 28px',
            borderRadius: 18,
            background: C.surface,
            border: `1px solid ${C.line}`,
            height: 140,
            ...enter(f, OUTRO.cmd1 - 10, fps, 16),
          }}
        >
          <Typed f={f} at={OUTRO.cmd1} text="npm install -g dsh-any-agent" />
          <Typed f={f} at={OUTRO.cmd2} text="dsh-any-agent-setup --yes" />
        </div>

        <div style={{ marginTop: 34, display: 'flex', gap: 34, fontSize: 26, ...enter(f, OUTRO.links, fps, 14) }}>
          <div>
            <span style={{ color: C.faint }}>官网 </span>
            <span style={{ color: C.accent, fontWeight: 600 }}>dsh-any-agent.xmtlz.dev</span>
          </div>
          <div>
            <span style={{ color: C.faint }}>GitHub </span>
            <span style={{ color: C.ink, fontWeight: 600 }}>xmtlzzz/dsh-any-agent</span>
          </div>
        </div>
        <div style={{ marginTop: 14, fontFamily: MONO, fontSize: 19, color: C.faint, ...enter(f, OUTRO.links + 8, fps, 10) }}>
          MIT · 零依赖 · Node ≥ 22.15 · 9+ MCP 客户端
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 110,
          top: 220 + float,
          width: CARD.w,
          height: CARD.h,
          borderRadius: 32,
          overflow: 'hidden',
          border: `1px solid ${C.line}`,
          boxShadow: `0 50px 140px #000000bb, 0 0 80px ${C.accentStrong}22`,
          opacity: card,
          transform: `scale(${0.9 + 0.1 * card}) rotate(${(1 - card) * 3}deg)`,
        }}
      >
        <Img src={header} style={{ position: 'absolute', height: CARD.h, width: IMG_W, left: -(IMG_W - CARD.w) }} />
      </div>

      <AbsoluteFill style={{ background: '#000', opacity: end }} />
    </AbsoluteFill>
  );
};
