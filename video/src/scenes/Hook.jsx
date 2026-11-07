import React from 'react';
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from 'remotion';
import { HOOK } from '../timeline.mjs';
import { C } from '../theme.js';
import { TinyLabel, ease, enter, jitter, settle } from '../ui.jsx';

const LINES = ['编辑器一关，agent 就没了。', '想改口？只能等它跑完。', '几小时的长活，你得一直守着。'];

export const Hook = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const glitching = f >= HOOK.strike && f < HOOK.strike + 9;

  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 250px' }}>
      <TinyLabel style={{ marginBottom: 44, ...enter(f, 0, fps, 12) }}>Your coding agent, today</TinyLabel>
      {LINES.map((text, i) => {
        const s = settle(f, HOOK.lines[i], fps);
        const next = HOOK.lines[i + 1];
        const dim = next == null ? 0 : ease(f, next, next + 12);
        const strike = ease(f, HOOK.strike + i * 3, HOOK.strike + i * 3 + 10, 0, 1, Easing.inOut(Easing.cubic));
        const jx = glitching ? jitter(f, i, 16) : 0;
        return (
          <div
            key={text}
            style={{
              position: 'relative',
              alignSelf: 'flex-start',
              fontSize: 80,
              fontWeight: 700,
              lineHeight: 1.25,
              letterSpacing: '-0.01em',
              marginBottom: 28,
              color: C.ink,
              opacity: s * (1 - dim * 0.5) * (1 - strike * 0.35),
              transform: `translateX(${(1 - s) * -48 + jx}px)`,
              textShadow: glitching ? `${jitter(f, i + 5, 7)}px 0 ${C.red}, ${jitter(f, i + 9, 7)}px 0 ${C.accent}` : 'none',
            }}
          >
            {text}
            <div
              style={{
                position: 'absolute',
                left: -10,
                top: '53%',
                height: 7,
                borderRadius: 4,
                width: `calc(${strike * 100}% + ${strike * 20}px)`,
                background: C.red,
                boxShadow: `0 0 22px ${C.red}99`,
              }}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
