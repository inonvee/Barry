import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, clamp, prog, systemPulse} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, SceneRoot} from '../ui/base';

/** 0:00 — Cold open. Pure black, one thought at a time. Barry is deliberately absent. */
export const OpenScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.open;
  const size = lang === 'he' ? 126 : 96;
  const lines = [
    {text: t.open.l1, at: q.l1, out: q.l1out},
    {text: t.open.l2, at: q.l2, out: q.l2out},
    {text: t.open.l3, at: q.l3, out: q.l3out},
  ];
  // Three quiet marks — customers, systems, work — that later merge into the single point of light.
  const merge = prog(frame, q.l4 + 4, 26, EASE.inOut);
  const marks = [q.l1, q.l2, q.l3];
  const finalGlow = prog(frame, q.l4 + 22, 30);
  return (
    <SceneRoot backdrop={<Backdrop bloom={0.35 * finalGlow} bloomY={62} bloomSize={55} />}>
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center'}}>
        <div style={{position: 'relative', width: 1720, height: 320, display: 'grid', placeItems: 'center'}}>
          {lines.map((l, i) => (
            <div key={i} style={{position: 'absolute', display: 'grid', placeItems: 'center'}}>
              <Headline text={l.text} at={l.at} out={l.out} size={size} weight={300} maxWidth={1720} stagger={3} />
            </div>
          ))}
          <div style={{position: 'absolute', display: 'grid', placeItems: 'center'}}>
            <Headline text={t.open.l4} at={q.l4} size={size} weight={300} emphWords={[t.open.emph]} emphWeight={600} emphColor={C.text} dimWords={t.open.l4.split(' ').filter((w) => w !== t.open.emph)} maxWidth={1720} stagger={5} dur={40} />
          </div>
        </div>
      </div>
      {/* the three marks */}
      <div style={{position: 'absolute', left: 0, right: 0, top: 800, height: 40}}>
        {marks.map((m, i) => {
          const lit = prog(frame, m, 14);
          const off = (i - 1) * 46 * (1 - merge);
          const done = frame > q.l4;
          return (
            <span
              key={i}
              style={{
                position: 'absolute',
                left: 960 + off - 4,
                top: 12,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: done ? C.warm : C.text,
                opacity: interpolate(lit, [0, 1], [0, done ? 1 : 0.55]),
                boxShadow: done ? `0 0 ${18 + 14 * systemPulse(frame, 70)}px rgba(244,217,174,${0.9 * merge})` : 'none',
                scale: 1 + merge * (i === 1 ? 0.8 : 0),
                display: i !== 1 && merge > 0.98 ? 'none' : 'block',
              }}
            />
          );
        })}
      </div>
    </SceneRoot>
  );
};
