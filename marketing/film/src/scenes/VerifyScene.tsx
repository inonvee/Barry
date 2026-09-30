import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, cameraPush, connectionTravel, prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Headline, SceneRoot} from '../ui/base';
import {BarryMessage, ChatHeader, CustomerMessage, TypingDots} from '../ui/chat';
import {SystemFact} from '../ui/cards';
import {BarryCore, SystemConnection, VerificationChip} from '../ui/system';

const COL = {left: 480, top: 270, width: 960};
const FS = 44;
// Anchor of Barry's bubble inside the (unscaled) chat column, in LTR design coords.
const BARRY_ANCHOR = {x: COL.left + COL.width - 300, y: COL.top + 96 + 34 + 190 + 34 + 100};
const HOMES = [
  {x: 350, y: 330},
  {x: 300, y: 600},
  {x: 1570, y: 300},
  {x: 1620, y: 590},
  {x: 960, y: 890},
];

/** 0:06 — a simple answer, then the reveal: the invisible system behind it. */
export const VerifyScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang} = useLang();
  const q = Q.verify;
  const v = t.verify;

  const pull = prog(frame, q.pull, 30, EASE.inOut);
  const collapse = prog(frame, q.collapse, 28, EASE.inOut);
  const cam = pull * (1 - collapse);
  const chatScale = 1 - 0.44 * cam;
  const push = cameraPush(frame, 0, 200, 1, 1.035);
  const chatExit = prog(frame, q.h1 - 4, 20, EASE.inOut);
  const anchor = {x: 960 + (mx(BARRY_ANCHOR.x) - 960) * chatScale, y: 540 + (BARRY_ANCHOR.y - 540) * chatScale};
  const showBloom = 0.5 + cam * 0.5;

  return (
    <SceneRoot backdrop={<Backdrop grid={0.5 * cam} bloom={showBloom * (1 - chatExit)} bloomY={58} bloomSize={62} />}>
      {/* the system mark wakes behind Barry's answer while the camera pulls back */}
      <div style={{position: 'absolute', left: anchor.x - 200, top: anchor.y - 200, opacity: cam * 0.9}}>
        <BarryCore size={400} energy={0.8} />
      </div>
      {/* connections (behind cards) */}
      {HOMES.map((h, i) => {
        const at = q.factStart + i * q.factGap;
        const home = {x: mx(h.x), y: h.y};
        return (
          <SystemConnection
            key={i}
            a={anchor}
            b={home}
            curve={i % 2 ? 60 : -60}
            draw={prog(frame, at + 4, 26, EASE.inOut) * (1 - collapse)}
            travel={connectionTravel(frame, q.verify + i * 6, 26)}
            opacity={0.3 * (1 - collapse)}
          />
        );
      })}

      {/* the conversation */}
      <div
        style={{
          position: 'absolute',
          left: mx(COL.left + COL.width / 2) - COL.width / 2,
          top: COL.top,
          width: COL.width,
          scale: chatScale * push,
          transformOrigin: `${960 - (mx(COL.left + COL.width / 2) - COL.width / 2)}px ${540 - COL.top}px`,
          opacity: (1 - chatExit) * (1 - 0.15 * cam),
          filter: cam > 0.05 || chatExit > 0.02 ? `blur(${cam * 1.2 + chatExit * 14}px)` : undefined,
          display: 'flex',
          flexDirection: 'column',
          gap: 34,
        }}
      >
        <div style={{height: 96}}>
          <ChatHeader at={q.header} />
        </div>
        <div style={{position: 'relative', height: 190}}>
          <div style={{position: 'absolute', insetInlineStart: 0, top: 0}}>
            <CustomerMessage at={q.c1} text={v.c1} maxWidth={860} size={FS} />
          </div>
        </div>
        <div style={{position: 'relative', height: 150}}>
          <div style={{position: 'absolute', insetInlineEnd: 0, top: 0}}>
            <TypingDots at={q.typing} out={q.b1} />
          </div>
          <div style={{position: 'absolute', insetInlineEnd: 0, top: 0}}>
            <BarryMessage at={q.b1} text={v.b1} maxWidth={740} size={FS} label="Barry" />
          </div>
          <div style={{position: 'absolute', insetInlineEnd: 0, top: 170}}>
            <VerificationChip at={q.collapse + 22} label={v.verified} size={15} />
          </div>
        </div>
      </div>

      {/* the invisible system */}
      {v.facts.map((f, i) => {
        const at = q.factStart + i * q.factGap;
        const h = HOMES[i];
        const home = {x: mx(h.x), y: h.y};
        const dx = (anchor.x - home.x) * collapse;
        const dy = (anchor.y - home.y) * collapse;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: home.x - 165,
              top: home.y - 60,
              translate: `${dx}px ${dy}px`,
              scale: 1 - collapse * 0.75,
              opacity: 1 - collapse * 1.15,
              filter: collapse > 0.05 ? `blur(${collapse * 8}px)` : undefined,
            }}
          >
            <Enter at={at} y={30} blur={16} dur={34} scale={0.9}>
              <SystemFact label={f.label} value={f.value} tickAt={q.verify + i * 6} strong={i === 3} />
            </Enter>
          </div>
        );
      })}

      {/* the line that reframes everything */}
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6}}>
          <div style={{opacity: 1 - 0.68 * prog(frame, q.h2, 16)}}>
            <Headline text={v.h1} at={q.h1} size={lang === 'he' ? 136 : 122} weight={300} emphWords={['Barry']} emphWeight={600} stagger={4} maxWidth={1700} />
          </div>
          <Headline text={v.h2} at={q.h2} size={lang === 'he' ? 136 : 122} weight={300} emphWords={['Barry', v.h2emph]} emphWeight={600} emphColor={C.text} stagger={4} maxWidth={1700} />
        </div>
      </div>
    </SceneRoot>
  );
};
