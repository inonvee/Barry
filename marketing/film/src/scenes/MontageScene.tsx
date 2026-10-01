import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../theme';
import {EASE, connectionTravel, enterImpact, prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Label, Ltr, Mono, SceneRoot} from '../ui/base';
import {Bubble} from '../ui/chat';
import {BarryCore, Glyph, SystemConnection} from '../ui/system';

const GLYPH = ['stack', 'calendar', 'grid', 'truck', 'calendar'];
// Deliberately varied framing so the cuts feel like different places, not one template.
const LAYOUT = [
  {bx: 180, by: 300, cx: 900, cy: 660},
  {bx: 260, by: 540, cx: 900, cy: 320},
  {bx: 150, by: 280, cx: 860, cy: 720},
  {bx: 300, by: 600, cx: 960, cy: 340},
  {bx: 240, by: 520, cx: 920, cy: 300},
];

const Flash: React.FC<{i: number}> = ({i}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, mx, lang} = useLang();
  const m = t.montage[i];
  const L = LAYOUT[i];
  const s = Q.montage.start + i * Q.montage.gap;
  const pop = enterImpact(frame, fps, s, 10);
  const bubbleAnchor = {x: mx(L.bx + 60), y: L.by + 150};
  const chipsAnchor = {x: mx(L.cx - 20), y: L.cy + 40};
  return (
    <div style={{position: 'absolute', inset: 0}}>
      <Backdrop grid={0.45} bloom={0.7} bloomX={lang === 'he' ? 100 - (L.cx / 19.2) : L.cx / 19.2} bloomY={L.cy / 10.8} bloomSize={46} />
      {/* business tag */}
      <div style={{position: 'absolute', insetInlineStart: 84, top: 70, display: 'flex', alignItems: 'center', gap: 18, opacity: prog(frame, s, 5)}}>
        <Glyph name={GLYPH[i]} size={34} color={C.warm} />
        <Label size={20} color={C.text}>{m.kind}</Label>
        <span style={{width: 5, height: 5, borderRadius: 3, background: C.faint}} />
        <span style={{fontSize: 26, color: C.dim}}>{m.name}</span>
      </div>
      <div style={{position: 'absolute', insetInlineEnd: 84, top: 72, opacity: prog(frame, s, 5)}}>
        <Mono size={15} color={C.faint}><Ltr>{`0${i + 1} / 0${Q.montage.count}`}</Ltr></Mono>
      </div>
      <SystemConnection a={bubbleAnchor} b={chipsAnchor} curve={i % 2 ? 80 : -80} draw={prog(frame, s + 4, 8, EASE.out)} travel={connectionTravel(frame, s + 5, 10)} opacity={0.3} />
      <div style={{position: 'absolute', insetInlineStart: L.bx, top: L.by, scale: 1.04 - 0.04 * pop, opacity: prog(frame, s, 3)}}>
        <Bubble who="customer" side="start" text={m.msg} size={52} maxWidth={900} />
      </div>
      <div style={{position: 'absolute', insetInlineStart: L.cx, top: L.cy, display: 'flex', alignItems: 'center', gap: 18}}>
        {m.chips.map((c, k) => {
          const at = s + 7 + k * 5;
          const p = prog(frame, at, 6);
          const last = k === m.chips.length - 1;
          return (
            <React.Fragment key={k}>
              {k > 0 && <span style={{width: 26, height: 1, background: C.lineHi, opacity: p}} />}
              <div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '18px 28px', borderRadius: 999, border: `1px solid ${last ? 'rgba(159,224,188,0.5)' : C.lineHi}`, background: last ? 'rgba(159,224,188,0.10)' : 'rgba(255,255,255,0.04)', opacity: p, translate: `0 ${(1 - p) * 10}px`}}>
                <Glyph name="check" size={28} color={last ? C.verify : C.warm} stroke={2.2} draw={prog(frame, at + 1, 6)} />
                <span style={{fontSize: 34, color: last ? C.verify : C.text, whiteSpace: 'nowrap'}}>{c}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{position: 'absolute', left: mx(L.cx - 190) - 30, top: L.cy - 16, opacity: prog(frame, s + 4, 6) * 0.9}}>
        <BarryCore size={60} energy={0.9} pulsePeriod={30} />
      </div>
    </div>
  );
};

/** Different businesses, hard cut on the beat. Same Barry. */
export const MontageScene: React.FC = () => {
  const frame = useCurrentFrame();
  const q = Q.montage;
  const i = Math.min(q.count - 1, Math.floor((frame - q.start) / q.gap));
  return <SceneRoot>{i >= 0 && <Flash key={i} i={i} />}</SceneRoot>;
};
