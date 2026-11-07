import React from 'react';
import { AbsoluteFill, Html5Audio, Sequence, staticFile } from 'remotion';
import { SCENES } from './timeline.mjs';
import { C, SANS } from './theme.js';
import { Backdrop, Scene } from './ui.jsx';
import { Brand } from './scenes/Brand.jsx';
import { Caps } from './scenes/Caps.jsx';
import { Clients } from './scenes/Clients.jsx';
import { Hook } from './scenes/Hook.jsx';
import { Outro } from './scenes/Outro.jsx';
import { Run } from './scenes/Run.jsx';

const ORDER = [
  ['hook', Hook, { fadeIn: 10 }],
  ['brand', Brand, { fadeIn: 0 }],
  ['clients', Clients, {}],
  ['run', Run, {}],
  ['caps', Caps, {}],
  ['outro', Outro, { fadeOut: 0 }],
];

export const Promo = () => (
  <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: SANS }}>
    <Backdrop />
    {ORDER.map(([id, Comp, fade]) => (
      <Sequence key={id} name={id} from={SCENES[id].from} durationInFrames={SCENES[id].duration}>
        <Scene duration={SCENES[id].duration} {...fade}>
          <Comp />
        </Scene>
      </Sequence>
    ))}
    <Html5Audio src={staticFile('bgm.wav')} />
  </AbsoluteFill>
);
