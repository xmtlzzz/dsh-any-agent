import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { CAPS } from '../timeline.mjs';
import { C, MONO } from '../theme.js';
import { TinyLabel, ease, enter, jitter, pop } from '../ui.jsx';

const PANEL = { w: 820, h: 318, x0: 120, y0: 262, gx: 40, gy: 34 };

const Pill = ({ children, color = C.accent, filled = false, style }) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 19,
      padding: '7px 14px',
      borderRadius: 10,
      color: filled ? C.bg : color,
      background: filled ? color : `${color}14`,
      border: `1px solid ${color}88`,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
);

// 1 — the process dies, the conversation survives
const Resume = ({ t, fps }) => {
  const crashed = t >= CAPS.resume.crash;
  const back = pop(t, CAPS.resume.back, fps);
  const shake = t >= CAPS.resume.crash && t < CAPS.resume.crash + 8 ? jitter(t, 2, 7) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Pill style={{ boxShadow: `0 0 ${18 + 8 * Math.sin(t / 5)}px ${C.accent}44` }}>conversation_id: conv-app</Pill>
        <div style={{ color: C.faint, fontSize: 22 }}>→</div>
        {back < 0.5 ? (
          <Pill color={crashed ? C.red : C.green} style={{ transform: `translateX(${shake}px)`, opacity: 1 - back * 2 }}>
            {crashed ? '✕ pid 4120 · exited' : '● pid 4120 · running'}
          </Pill>
        ) : (
          <Pill color={C.green} style={{ opacity: back, transform: `scale(${0.8 + 0.2 * back})` }}>
            ● pid 5388 · resumed
          </Pill>
        )}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 19, color: C.green, opacity: back }}>session/resume ✓ 历史完整恢复，接着干</div>
    </div>
  );
};

// 2 — several sessions in parallel
const Parallel = ({ t }) => {
  const rows = [
    ['conv-app', CAPS.parallel.done[0]],
    ['conv-test', CAPS.parallel.done[1]],
    ['conv-docs', CAPS.parallel.done[2]],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map(([name, doneAt]) => {
        const p = Math.max(0, Math.min(1, t / doneAt));
        const done = p >= 1;
        return (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: MONO, fontSize: 19 }}>
            <div style={{ width: 120, color: C.muted }}>{name}</div>
            <div style={{ flex: 1, height: 12, borderRadius: 6, background: C.surface, border: `1px solid ${C.line}`, overflow: 'hidden' }}>
              <div style={{ width: `${p * 100}%`, height: '100%', background: done ? C.green : C.accent }} />
            </div>
            <div style={{ width: 110, color: done ? C.green : C.accent }}>{done ? '✓ done' : 'running'}</div>
          </div>
        );
      })}
    </div>
  );
};

// 3 — the caller reviews instead of relaying
const Review = ({ t, fps }) => {
  const items = ['对照原任务：真的做完了吗', '独立核验：读文件 / git diff / 跑测试', '确认工作区确实有变化'];
  const stamp = pop(t, CAPS.review.stamp, fps, { damping: 10, stiffness: 220, mass: 0.6 });
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => {
        const on = t >= CAPS.review.checks[i];
        return (
          <div key={it} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 21, color: on ? C.ink : C.faint }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: `2px solid ${on ? C.green : C.line}`,
                background: on ? C.green : 'transparent',
                color: C.bg,
                fontSize: 17,
                fontWeight: 800,
                textAlign: 'center',
                lineHeight: '20px',
              }}
            >
              {on ? '✓' : ''}
            </div>
            {it}
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 2,
          fontFamily: MONO,
          fontSize: 34,
          fontWeight: 800,
          color: C.green,
          border: `4px solid ${C.green}`,
          borderRadius: 12,
          padding: '4px 16px',
          opacity: stamp,
          transform: `rotate(-10deg) scale(${2 - stamp})`,
        }}
      >
        PASS
      </div>
    </div>
  );
};

// 4 — read-only really is read-only
const ReadOnly = ({ t, fps }) => {
  const denied = pop(t, CAPS.readonly.deny, fps);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: MONO, fontSize: 19 }}>
      <div style={{ display: 'flex', gap: 14, opacity: ease(t, 4, 10) }}>
        <span style={{ color: C.muted }}>▸ read  sample/main.js</span>
        <span style={{ color: C.green }}>✓ allowed</span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', opacity: ease(t, 16, 22) }}>
        <span style={{ color: C.muted }}>▸ edit  sample/main.js</span>
        <Pill color={C.red} filled={denied > 0.5} style={{ opacity: denied, transform: `scale(${0.7 + 0.3 * denied})`, fontSize: 17, padding: '3px 10px' }}>
          ✕ denied · auto-deny
        </Pill>
      </div>
      <div style={{ color: C.faint, fontSize: 17, opacity: ease(t, 36, 46) }}>sandbox=read-only · on_approval=auto-deny</div>
    </div>
  );
};

const PANELS = [
  { title: '进程死了，对话不丢', body: '身份在磁盘上。崩溃、回收、重启后，下次调用自动 resume。', Visual: Resume },
  { title: '多个会话，同时开工', body: 'dsh_list 看谁在忙，dsh_read 按游标增量读。', Visual: Parallel },
  { title: '调用方验收，不盲转述', body: '每个结果附审核单；核验后用 dsh_review 记 pass / partial / fail。', Visual: Review },
  { title: '只读档，真的只读', body: 'read-only 沙箱 + 审批一律拒绝，分析不信任样本也放心。', Visual: ReadOnly },
];

export const Caps = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const active = Math.floor((f - CAPS.first) / CAPS.step);

  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', top: 76, left: PANEL.x0, ...enter(f, CAPS.title, fps) }}>
        <TinyLabel>Built for the long run</TinyLabel>
        <div style={{ marginTop: 14, fontSize: 58, fontWeight: 700 }}>
          从一次调用，<span style={{ color: C.accent }}>到长期共事。</span>
        </div>
      </div>

      {PANELS.map(({ title, body, Visual }, i) => {
        const at = CAPS.first + i * CAPS.step;
        const t = f - at;
        const appear = ease(f, 6 + i * 4, 20 + i * 4);
        const on = pop(f, at, fps, { damping: 200 });
        const isActive = i === active && f < CAPS.first + 4 * CAPS.step;
        const col = i % 2;
        const row = Math.floor(i / 2);
        return (
          <div
            key={title}
            style={{
              position: 'absolute',
              left: PANEL.x0 + col * (PANEL.w + PANEL.gx),
              top: PANEL.y0 + row * (PANEL.h + PANEL.gy),
              width: PANEL.w,
              height: PANEL.h,
              borderRadius: 24,
              padding: '28px 34px',
              background: isActive ? C.raised : C.panel,
              border: `${isActive ? 2 : 1}px solid ${isActive ? C.accent : C.line}`,
              boxShadow: isActive ? `0 0 50px ${C.accentStrong}33` : 'none',
              opacity: appear * (0.4 + 0.6 * on),
              transform: `translateY(${(1 - appear) * 30}px) scale(${0.97 + 0.03 * on})`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
              <div style={{ fontFamily: MONO, fontSize: 22, color: C.accent }}>{String(i + 1).padStart(2, '0')}</div>
              <div style={{ fontSize: 36, fontWeight: 700 }}>{title}</div>
            </div>
            <div style={{ marginTop: 10, marginLeft: 42, fontSize: 22, color: C.muted }}>{body}</div>
            <div style={{ marginTop: 28, marginLeft: 42 }}>{t >= 0 ? <Visual t={t} fps={fps} /> : <Visual t={0} fps={fps} />}</div>
          </div>
        );
      })}

      <div
        style={{
          position: 'absolute',
          bottom: 50,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 24,
          color: C.muted,
          ...enter(f, CAPS.footer, fps, 14),
        }}
      >
        还有：写锁治理 · 跨会话审批收件箱 · 排队 · dsh_doctor 体检 · 思考默认隐藏
      </div>
    </AbsoluteFill>
  );
};
