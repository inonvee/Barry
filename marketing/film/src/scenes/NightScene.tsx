import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Headline, Label, Mixed, Mono, SceneRoot} from '../ui/base';
import {DayClock} from '../ui/chat';
import {Glyph} from '../ui/system';

/** 00:37 — Nobody is watching. The customer from 18:42 comes back and pays. */
export const NightScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.night;
  const n = t.night;
  const times = ['00:37:02', '00:37:41', '00:37:42'];
  const line = prog(frame, q.e1, q.gap * 2 + 20, EASE.inOut);
  return (
    <SceneRoot backdrop={<Backdrop bloom={0.22} bloomX={50} bloomY={46} bloomSize={46} />}>
      <DayClock clock={CLOCK.night} />
      <div style={{position: 'absolute', insetInlineStart: 640, top: 300, width: 700}}>
        <div style={{position: 'absolute', insetInlineStart: 15, top: 30, width: 1, height: 250 * line, background: `linear-gradient(180deg, ${C.warm}88, ${C.warm}11)`}} />
        {n.events.map((e, i) => {
          const at = q.e1 + i * q.gap;
          return (
            <Enter key={i} at={at} y={14} blur={8} dur={24}>
              <div style={{display: 'flex', alignItems: 'center', gap: 34, height: 110}}>
                <div style={{width: 31, height: 31, borderRadius: '50%', display: 'grid', placeItems: 'center', background: i === 2 ? 'rgba(159,224,188,0.16)' : '#0d0d0f', border: `1px solid ${i === 2 ? C.verify : C.lineHi}`, flex: 'none'}}>
                  <Glyph name="check" size={18} color={i === 2 ? C.verify : C.warm} stroke={2.2} draw={prog(frame, at + 4, 12)} />
                </div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 8, flex: 1}}>
                  <Label size={13} color={C.faint}>{e.label}</Label>
                  <span style={{fontSize: i === 2 ? 44 : 38, fontWeight: i === 2 ? 500 : 400, color: i === 2 ? C.text : C.dim}}><Mixed text={e.value} /></span>
                </div>
                <Mono size={14} color={C.ghost}>{times[i]}</Mono>
              </div>
            </Enter>
          );
        })}
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 760, display: 'flex', justifyContent: 'center'}}>
        <Headline text={n.t} at={q.t} size={lang === 'he' ? 78 : 72} weight={300} color={C.dim} emphWords={[lang === 'he' ? 'עובד.' : 'works.']} emphWeight={600} emphColor={C.text} stagger={4} />
      </div>
    </SceneRoot>
  );
};
