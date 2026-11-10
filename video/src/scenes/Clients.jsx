import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { CLIENTS } from '../timeline.mjs';
import { C, MONO } from '../theme.js';
import { TinyLabel, WhaleMark, ease, enter, pop } from '../ui.jsx';

const NAMES = ['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'Windsurf', 'Zed', 'Gemini CLI', 'Antigravity', 'opencode', 'VS Code'];

const CHIP = { x: 130, w: 340, h: 58, top: 262, gap: 66 };
const HUB = { x: 760, y: 452, w: 420, h: 236 };
const HUB_CY = HUB.y + HUB.h / 2;
const DSH = { x: 1400, y: HUB_CY - 175, w: 400, h: 350 };

const bez = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const wire = (i) => {
  const y0 = CHIP.top + i * CHIP.gap + CHIP.h / 2;
  const x0 = CHIP.x + CHIP.w;
  const x3 = HUB.x;
  const y3 = HUB_CY + (i - (NAMES.length - 1) / 2) * 16;
  const cx = (x0 + x3) / 2;
  return { x0, y0, x1: cx, y1: y0, x2: cx, y2: y3, x3, y3 };
};

export const Clients = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wires = NAMES.map((_, i) => wire(i));
  const hubIn = pop(f, CLIENTS.wires - 10, fps);
  const dshIn = pop(f, CLIENTS.dsh, fps);
  const flow = f - CLIENTS.packets;

  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', top: 70, left: 0, right: 0, textAlign: 'center', ...enter(f, CLIENTS.title, fps) }}>
        <TinyLabel>One buddy, any MCP client</TinyLabel>
        <div style={{ marginTop: 14, fontSize: 54, fontWeight: 700 }}>
          你习惯的客户端，<span style={{ color: C.accent }}>都能雇它干活。</span>
        </div>
      </div>

      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0 }}>
        {wires.map((w, i) => {
          const p = ease(f, CLIENTS.wires + i * 2, CLIENTS.wires + i * 2 + 18);
          return (
            <path
              key={i}
              d={`M${w.x0},${w.y0} C${w.x1},${w.y1} ${w.x2},${w.y2} ${w.x3},${w.y3}`}
              fill="none"
              stroke={C.accentStrong}
              strokeOpacity={0.55}
              strokeWidth={2}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - p}
            />
          );
        })}
        <line
          x1={HUB.x + HUB.w}
          y1={HUB_CY}
          x2={HUB.x + HUB.w + (DSH.x - HUB.x - HUB.w) * ease(f, CLIENTS.dsh - 6, CLIENTS.dsh + 10)}
          y2={HUB_CY}
          stroke={C.amber}
          strokeWidth={3}
          strokeOpacity={0.8}
        />
        {flow > 0 &&
          wires.map((w, i) => {
            const t = (flow / 34 + i * 0.137) % 1;
            return (
              <circle
                key={i}
                cx={bez(w.x0, w.x1, w.x2, w.x3, t)}
                cy={bez(w.y0, w.y1, w.y2, w.y3, t)}
                r={5}
                fill={C.accent}
                opacity={ease(flow, 0, 8) * Math.sin(Math.PI * t)}
              />
            );
          })}
        {flow > 0 &&
          [0, 0.33, 0.66].map((o) => {
            const t = (flow / 26 + o) % 1;
            return <circle key={o} cx={HUB.x + HUB.w + (DSH.x - HUB.x - HUB.w) * t} cy={HUB_CY} r={6} fill={C.amber} opacity={Math.sin(Math.PI * t)} />;
          })}
      </svg>

      {NAMES.map((name, i) => {
        const s = pop(f, CLIENTS.chipStart + i * CLIENTS.chipStep, fps);
        return (
          <div
            key={name}
            style={{
              position: 'absolute',
              left: CHIP.x,
              top: CHIP.top + i * CHIP.gap,
              width: CHIP.w,
              height: CHIP.h,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '0 22px',
              borderRadius: 14,
              background: C.panel,
              border: `1px solid ${C.line}`,
              fontSize: 25,
              fontWeight: 600,
              opacity: s,
              transform: `translateX(${(1 - s) * -60}px)`,
            }}
          >
            <div style={{ width: 10, height: 10, borderRadius: 5, background: C.accent, boxShadow: `0 0 12px ${C.accent}` }} />
            {name}
          </div>
        );
      })}

      <div
        style={{
          position: 'absolute',
          left: HUB.x,
          top: HUB.y,
          width: HUB.w,
          height: HUB.h,
          borderRadius: 24,
          background: `linear-gradient(160deg, ${C.raised}, ${C.panel})`,
          border: `2px solid ${C.accent}`,
          boxShadow: `0 0 ${40 + 20 * Math.sin(f / 8)}px ${C.accentStrong}55`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          opacity: hubIn,
          transform: `scale(${0.8 + 0.2 * hubIn})`,
        }}
      >
        <WhaleRow />
        <div style={{ fontSize: 22, color: C.muted }}>MCP 服务端 · 派发层</div>
        <div style={{ fontFamily: MONO, fontSize: 18, color: C.accent }}>派活 · 插话 · 验收 · resume</div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: (HUB.x + HUB.w + DSH.x) / 2 - 80,
          top: HUB_CY - 50,
          width: 160,
          textAlign: 'center',
          fontFamily: MONO,
          fontSize: 18,
          color: C.amber,
          opacity: ease(f, CLIENTS.dsh, CLIENTS.dsh + 10),
        }}
      >
        ACP · 长驻
      </div>

      <div
        style={{
          position: 'absolute',
          left: DSH.x,
          top: DSH.y,
          width: DSH.w,
          height: DSH.h,
          borderRadius: 24,
          background: C.panel,
          border: `1px solid ${C.amber}88`,
          padding: '30px 34px',
          opacity: dshIn,
          transform: `translateX(${(1 - dshIn) * 60}px)`,
        }}
      >
        <TinyLabel color={C.amber}>DeepSeek Harness</TinyLabel>
        <div style={{ fontSize: 46, fontWeight: 800, marginTop: 6, marginBottom: 18 }}>DSH</div>
        {['文件 · shell · 搜索 · 编辑', '技能 · 子代理 · Agent Teams', '沙箱 · 审批 · 模型路由', '还能挂别的 MCP 工具'].map((t, i) => (
          <div
            key={t}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 23,
              color: C.ink,
              marginBottom: 14,
              opacity: ease(f, CLIENTS.dsh + 6 + i * 4, CLIENTS.dsh + 16 + i * 4),
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: 4, background: C.amber }} />
            {t}
          </div>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 62,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 25,
          color: C.muted,
          ...enter(f, CLIENTS.footer, fps, 16),
        }}
      >
        只传目标，不传工具清单 · DSH 自己挑能力 · <span style={{ color: C.ink }}>零依赖 · MIT</span>
      </div>
    </AbsoluteFill>
  );
};

const WhaleRow = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
    <WhaleMark size={56} />
    <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.01em' }}>dsh-any-agent</div>
  </div>
);
