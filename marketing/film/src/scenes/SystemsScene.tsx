import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../theme';
import {EASE, clamp, connectionTravel, enterImpact, prog} from '../motion';
import {BEAT, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Label, SceneRoot} from '../ui/base';
import {BarryCore, Glyph, SystemConnection, bezierAt} from '../ui/system';

const GLYPHS = ['calendar', 'card', 'box', 'person', 'store', 'support', 'truck', 'mail', 'grid', 'factory', 'doc', 'chart'];
const CX = 960, CY = 540, RX = 740, RY = 390;
// Barry acting across systems: each hop is system → Barry → system (a real operation, not a spoke).
const HOPS = [[1, 2], [5, 6], [9, 2], [0, 3], [4, 1], [6, 7], [8, 10], [11, 3]];

/** The systems are tools. Barry is the one who knows what to do with them. */
export const SystemsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, lang} = useLang();
  const q = Q.systems;
  const s = t.systems;
  const pos = (i: number) => {
    const a = ((-90 + (i * 360) / 12) * Math.PI) / 180;
    return {x: CX + Math.cos(a) * RX, y: CY + Math.sin(a) * RY};
  };
  const edge = (p: {x: number; y: number}, r: number) => {
    const dx = CX - p.x, dy = CY - p.y, dd = Math.hypot(dx, dy) || 1;
    return {x: CX - (dx / dd) * r, y: CY - (dy / dd) * r};
  };
  const kick = Math.exp(-(frame % BEAT) / 4.5);
  const words = [
    {text: s.w1, at: q.w1},
    {text: s.w2, at: q.w2},
    {text: s.w3, at: q.w3},
  ];
  const w = [...words].reverse().find((x) => frame >= x.at);
  const pop = w ? enterImpact(frame, fps, w.at, 8) : 0;
  const final = w?.at === q.w3;

  return (
    <SceneRoot backdrop={<Backdrop grid={0.6} bloom={0.6 + 0.3 * (final ? 1 : 0)} bloomSize={78} />}>
      {GLYPHS.map((_, i) => {
        const p = pos(i);
        const at = q.modules + i * q.moduleGap;
        return <SystemConnection key={`c${i}`} a={p} b={edge(p, 150)} curve={i % 2 ? 30 : -30} draw={prog(frame, at + 2, 14, EASE.out)} opacity={0.16} />;
      })}
      {HOPS.map(([a, b], k) => {
        const start = 20 + k * 13;
        const pa = pos(a), pb = pos(b);
        const t1 = connectionTravel(frame, start, 12), t2 = connectionTravel(frame, start + 12, 12);
        return (
          <React.Fragment key={`h${k}`}>
            <SystemConnection a={pa} b={edge(pa, 150)} curve={a % 2 ? 30 : -30} draw={0} travel={t1} opacity={0} />
            <SystemConnection a={edge(pb, 150)} b={pb} curve={b % 2 ? -30 : 30} draw={0} travel={t2} opacity={0} />
          </React.Fragment>
        );
      })}
      {GLYPHS.map((g, i) => {
        const p = pos(i);
        const at = q.modules + i * q.moduleGap;
        const pp = enterImpact(frame, fps, at, 12);
        // light a module when an operation arrives at it
        const hit = HOPS.reduce((acc, [a, b], k) => {
          const s0 = 20 + k * 13;
          const ta = frame - s0, tb = frame - (s0 + 24);
          return Math.max(acc, a === i && ta >= 0 ? Math.exp(-ta / 8) : 0, b === i && tb >= 0 ? Math.exp(-tb / 8) : 0);
        }, 0);
        return (
          <div key={`n${i}`} style={{position: 'absolute', left: p.x - 120, top: p.y - 52, width: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, opacity: interpolate(pp, [0, 0.4], [0, 1], clamp), scale: 0.7 + 0.3 * pp}}>
            <div style={{width: 88, height: 88, borderRadius: 24, border: `1px solid ${hit > 0.3 ? C.warm : C.lineHi}`, background: `rgba(244,217,174,${0.04 + 0.16 * hit})`, boxShadow: `0 0 ${10 + 40 * hit}px rgba(244,217,174,${0.1 + 0.35 * hit})`, display: 'grid', placeItems: 'center'}}>
              <Glyph name={g} size={40} color={hit > 0.3 ? C.text : C.warm} />
            </div>
            <Label size={16} color={hit > 0.3 ? C.text : C.dim}>{s.modules[i]}</Label>
          </div>
        );
      })}
      <div style={{position: 'absolute', left: CX - 150, top: CY - 150, scale: 1 + 0.06 * kick, opacity: 0.9}}>
        <BarryCore size={300} energy={0.7 + 0.3 * kick} pulsePeriod={60} />
      </div>
      {w && (
        <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center'}}>
          <div style={{fontSize: lang === 'he' ? 120 : 108, fontWeight: final ? 700 : 300, letterSpacing: lang === 'he' ? '-0.01em' : '-0.03em', scale: 1.06 - 0.06 * pop, textShadow: '0 0 50px rgba(5,5,6,0.95), 0 0 20px rgba(5,5,6,0.95)', whiteSpace: 'nowrap'}}>
            {w.text}
          </div>
        </div>
      )}
    </SceneRoot>
  );
};
