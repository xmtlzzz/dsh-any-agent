import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import transcript from '../../../demo/transcript.json';
import { RUN } from '../timeline.mjs';
import { C, MONO } from '../theme.js';
import { CLAMP, TinyLabel, ease, jitter, pop, settle } from '../ui.jsx';

// ── Transcript → display lines ──────────────────────────────────────────
// Lines are looked up by their prefix so a re-recorded transcript still works.
const L = transcript.lines;
const find = (prefix) => {
  const i = L.findIndex((l) => l.trimStart().startsWith(prefix));
  if (i < 0) throw new Error(`transcript has no line starting with "${prefix}"`);
  return i;
};
const line = (prefix) => L[find(prefix)];
// Long temp paths would overflow; shorten them (and say so on screen).
const short = (s) =>
  s
    .replace(/[A-Z]:\\[^\s]*?\\dsh-any-agent-demo-[\w]+/g, '%TEMP%\\demo')
    .replace(/\\runs\\([0-9a-f]{8})-[0-9a-f-]+\\/g, '\\runs\\$1…\\');

const S = RUN.steps.map((s) => s.at);
const ENTRIES = [
  { text: L[0], at: 50, kind: 'title' },
  { text: L[1], at: 52, kind: 'rule' },
  { gap: true, at: S[0] },
  { text: line('[1/6]'), at: S[0], kind: 'step' },
  { text: line('已连接').replace(/(dsh_read), .*$/, '$1, …'), at: S[0] + 6 },
  { gap: true, at: S[1] },
  { text: line('[2/6]'), at: S[1], kind: 'step' },
  { text: line('会话 '), at: S[1] + 6 },
  { gap: true, at: S[2] },
  { text: line('[3/6]'), at: S[2], kind: 'step' },
  { text: line('run_id='), at: S[2] + 6 },
  { text: short(line('哨兵=')), at: S[2] + 12 },
  { gap: true, at: S[3] },
  { text: line('[4/6]'), at: S[3], kind: 'step' },
  { text: line('插话 #1'), at: S[4] },
  { text: line('插话 #2'), at: S[5] },
  { gap: true, at: S[6] },
  { text: line('[5/6]'), at: S[6], kind: 'step' },
  { text: line('第 1 轮'), at: S[6] + 6 },
  { text: short(line('最后一轮哨兵')), at: S[7] },
  { gap: true, at: S[8] },
  { text: line('[6/6]'), at: S[8], kind: 'step' },
  { text: L[find('[6/6]') + 1], at: S[8] + 6, rows: 2 },
  { gap: true, at: S[9] },
  { text: line('————'), at: S[9], kind: 'rule' },
  { text: line('复核'), at: S[9], kind: 'title' },
  { text: line('产出文件'), at: S[9] + 6 },
  { text: line('node --test'), at: S[10] },
  { gap: true, at: S[11] },
  { text: line('完成 ·'), at: S[11], kind: 'final' },
];

const HL = /(\[\d\/6\])|(\+\d+(?:\.\d+)?s)|(status=cancelled)|(status=done|exit=0|4\/4 通过)|(dsh_\w+(?:\([^)]*\))?|initialize|run_id=[\w-]+)|(←.*$)/g;
const HL_STYLE = [
  { color: C.accent, fontWeight: 700 },
  { color: C.amber },
  { color: C.amber, fontWeight: 700 },
  { color: C.green, fontWeight: 700 },
  { color: C.accent },
  { color: C.faint, fontStyle: 'italic' },
];

const highlight = (text) => {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(HL)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const g = m.slice(1).findIndex((x) => x !== undefined);
    out.push(
      <span key={m.index} style={HL_STYLE[g]}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

// ── Callouts on the right ───────────────────────────────────────────────
const CALLOUTS = [
  { title: '4 个标准方法就能接', body: 'initialize · tools/list —— 任何 MCP 客户端都行' },
  { title: '长驻会话', body: '身份落在磁盘上，进程只是缓存' },
  { title: '派完就走', body: 'wait=false 立刻拿回 run_id，回合在后台跑' },
  { title: '中途改口', body: '打断当前回合重新下令，已做的工作不丢', tone: C.amber },
  { title: '跑完自动通知', body: '一个回合一个哨兵文件，不用轮询', file: true },
  { title: '自己验收', body: '看磁盘上有什么，而不是模型说了什么', tone: C.green, check: true },
];
const CALLOUT_AT = RUN.steps.filter((s) => s.callout != null).map((s) => s.at);

const TERM = { x: 72, y: 88, w: 1140, h: 896 };
const ROW = 31;
const GAP = 14;
const VIEWPORT = TERM.h - 52 - 44;

const realSeconds = (f) => {
  const pts = RUN.steps;
  if (f < pts[0].at) return 0;
  return interpolate(
    f,
    pts.map((p) => p.at),
    pts.map((p) => p.real),
    CLAMP,
  );
};

export const Run = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const termIn = settle(f, 0, fps);
  const typed = Math.max(0, Math.min(RUN.command.length, Math.floor((f - RUN.typeStart) / RUN.typeStep) + 1));
  const cursorOn = Math.floor(f / 8) % 2 === 0;

  // auto-scroll: grow with each revealed line, then scroll once the viewport is full
  let content = ROW;
  for (const e of ENTRIES) content += (e.gap ? GAP : ROW * (e.rows ?? 1)) * ease(f, e.at, e.at + 6);
  const scroll = Math.max(0, content - VIEWPORT);

  const hit = f - RUN.interrupt;
  const shaking = hit >= 0 && hit < 8;
  const alarm = hit >= 0 ? 1 - ease(hit, 6, 30) : 0;
  const done = ease(f, RUN.finished, RUN.finished + 12);
  const border = alarm > 0.01 ? `rgba(226,189,123,${0.35 + 0.65 * alarm})` : done > 0 ? `rgba(132,213,176,${0.25 + 0.5 * done})` : C.line;
  const banner = hit >= 0 && f < RUN.steps[4].at + 20 ? ease(hit, 0, 6) * (1 - ease(f, RUN.steps[4].at + 10, RUN.steps[4].at + 20)) : 0;

  const active = CALLOUT_AT.reduce((a, at, i) => (f >= at ? i : a), -1);

  return (
    <AbsoluteFill>
      {/* terminal */}
      <div
        style={{
          position: 'absolute',
          left: TERM.x,
          top: TERM.y,
          width: TERM.w,
          height: TERM.h,
          borderRadius: 20,
          overflow: 'hidden',
          background: C.surface,
          border: `2px solid ${border}`,
          boxShadow: `0 40px 120px #000000aa${alarm > 0.01 ? `, 0 0 60px rgba(226,189,123,${0.35 * alarm})` : ''}${done > 0 ? `, 0 0 70px rgba(132,213,176,${0.18 * done})` : ''}`,
          opacity: termIn,
          transform: `translate(${shaking ? jitter(f, 3, 9) : 0}px, ${(1 - termIn) * 70}px)`,
        }}
      >
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 22px',
            background: C.panel,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          {['#f29191', '#e2bd7b', '#84d5b0'].map((c) => (
            <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c, opacity: 0.85 }} />
          ))}
          <div style={{ marginLeft: 14, fontFamily: MONO, fontSize: 18, color: C.muted }}>npm run demo — 真实运行记录</div>
          <div style={{ flex: 1 }} />
          <div
            style={{
              fontFamily: MONO,
              fontSize: 17,
              color: C.bg,
              background: C.amber,
              borderRadius: 8,
              padding: '4px 12px',
              marginRight: 12,
              opacity: banner,
              transform: `scale(${0.85 + 0.15 * banner})`,
            }}
          >
            dsh_interject → 已打断，新回合接着干
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 18,
              color: done > 0.5 ? C.green : C.ink,
              background: C.raised,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              padding: '4px 12px',
            }}
          >
            实际耗时 +{realSeconds(f).toFixed(1)}s
          </div>
        </div>

        <div style={{ position: 'absolute', top: 52, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 22, left: 28, right: 28, transform: `translateY(${-scroll}px)` }}>
          <div style={{ fontFamily: MONO, fontSize: 20, lineHeight: `${ROW}px`, height: ROW, whiteSpace: 'pre' }}>
            <span style={{ color: C.green }}>$ </span>
            <span style={{ color: C.ink }}>{RUN.command.slice(2, typed)}</span>
            {f < ENTRIES[0].at && <span style={{ background: cursorOn ? C.ink : 'transparent', marginLeft: 1 }}>&nbsp;</span>}
          </div>
          {ENTRIES.map((e, i) => {
            const p = ease(f, e.at, e.at + 6);
            if (e.gap) return <div key={i} style={{ height: GAP * p }} />;
            const color = e.kind === 'title' ? C.accent : e.kind === 'rule' ? C.faint : e.kind === 'final' ? C.green : e.kind === 'step' ? C.ink : C.muted;
            return (
              <div
                key={i}
                style={{
                  fontFamily: MONO,
                  fontSize: 20,
                  lineHeight: `${ROW}px`,
                  height: ROW * (e.rows ?? 1) * p,
                  overflow: 'hidden',
                  whiteSpace: e.rows ? 'pre-wrap' : 'pre',
                  color,
                  fontWeight: e.kind === 'title' || e.kind === 'final' ? 700 : 400,
                  opacity: p,
                  transform: `translateX(${(1 - p) * 14}px)`,
                }}
              >
                {highlight(e.text)}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      <div style={{ position: 'absolute', left: TERM.x + 4, top: TERM.y + TERM.h + 18, fontFamily: MONO, fontSize: 16, color: C.faint, opacity: termIn }}>
        真实运行记录 · 数据来自 demo/transcript.json · 路径已缩写
      </div>

      {/* callouts */}
      <TinyLabel style={{ position: 'absolute', left: 1252, top: 92, opacity: termIn, textTransform: 'none', letterSpacing: '0.12em' }}>
        一次真实的 npm run demo
      </TinyLabel>
      {CALLOUTS.map((c, i) => {
        const at = CALLOUT_AT[i];
        const s = pop(f, at, fps, { damping: 16, stiffness: 150, mass: 0.7 });
        const isActive = i === active;
        const tone = c.tone ?? C.accent;
        const fileIn = c.file ? pop(f, RUN.sentinelDone, fps) : 0;
        const checkIn = c.check ? pop(f, RUN.verified, fps) : 0;
        return (
          <div
            key={c.title}
            style={{
              position: 'absolute',
              left: 1248,
              top: 136 + i * 136,
              width: 604,
              height: 120,
              borderRadius: 18,
              padding: '18px 24px',
              background: isActive ? C.raised : C.panel,
              border: `${isActive ? 2 : 1}px solid ${isActive ? tone : C.line}`,
              boxShadow: isActive ? `0 0 40px ${tone}33` : 'none',
              opacity: s * (isActive ? 1 : 0.62),
              transform: `translateX(${(1 - s) * 80}px)`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <div style={{ fontFamily: MONO, fontSize: 20, color: tone }}>{String(i + 1).padStart(2, '0')}</div>
              <div style={{ fontSize: 30, fontWeight: 700 }}>{c.title}</div>
            </div>
            <div style={{ marginTop: 8, marginLeft: 38, fontSize: 21, color: C.muted }}>{c.body}</div>
            {c.file && (
              <div
                style={{
                  position: 'absolute',
                  right: 18,
                  top: 16,
                  fontFamily: MONO,
                  fontSize: 15,
                  color: C.green,
                  border: `1px solid ${C.green}88`,
                  background: '#84d5b014',
                  borderRadius: 8,
                  padding: '3px 10px',
                  opacity: fileIn,
                  transform: `translateY(${(1 - fileIn) * -26}px)`,
                }}
              >
                run-…-3.json · done
              </div>
            )}
            {c.check && (
              <div
                style={{
                  position: 'absolute',
                  right: 18,
                  top: 16,
                  fontFamily: MONO,
                  fontSize: 15,
                  color: C.bg,
                  background: C.green,
                  borderRadius: 8,
                  padding: '3px 10px',
                  opacity: checkIn,
                  transform: `scale(${0.6 + 0.4 * checkIn})`,
                }}
              >
                ✓ node --test exit=0
              </div>
            )}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
