import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT} from '../theme';
import {EASE, clamp, enterSoft, prog, systemPulse} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Mono, SceneRoot} from '../ui/base';

/** The earned reveal: vacuum → one point of light → BARRY → the sentence completes → COMING SOON. */
export const BrandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, lang} = useLang();
  const q = Q.brand;

  const dot = prog(frame, q.point, 20);
  const line = prog(frame, q.line, 30, EASE.inOut);
  const glow = prog(frame, q.mark, 60);
  const shift = prog(frame, q.shift, 26, EASE.inOut);
  const soon = prog(frame, q.soon, 44, EASE.out);
  const soonPulse = 0.78 + 0.22 * systemPulse(frame, 120);
  const size = 190;
  const CY = 470;
  const letters = t.brand.split('');
  const w = spring({frame: frame - q.works, fps, config: {damping: 30, stiffness: 180, mass: 0.9}, durationInFrames: 26});

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.5 * glow} bloomY={44} bloomSize={62} />}>
      {frame < q.mark + 18 && (
        <div style={{position: 'absolute', left: 955, top: CY - 5, width: 10, height: 10, borderRadius: '50%', background: C.warm, opacity: dot * (1 - prog(frame, q.mark + 4, 14)), boxShadow: '0 0 30px 6px rgba(244,217,174,0.75)', scale: 1 + 3 * (1 - dot)}} />
      )}
      <div style={{position: 'absolute', left: 960 - 500 * line, top: CY + 6, width: 1000 * line, height: 1, background: `linear-gradient(90deg, transparent, ${C.lineHi}, transparent)`, opacity: 1 - prog(frame, q.mark + 20, 30)}} />
      <div style={{position: 'absolute', left: 960 - 700, top: CY - 190, width: 1400, height: 380, background: 'radial-gradient(ellipse at center, rgba(244,217,174,0.14) 0%, rgba(244,217,174,0.04) 45%, transparent 70%)', opacity: glow * (0.8 + 0.2 * systemPulse(frame, 140))}} />

      {/* BARRY + the verb: the verb's column eases open (grid 0fr→1fr), so the pair stays optically centred in both directions */}
      <div style={{position: 'absolute', left: 0, right: 0, top: CY - size * 0.56, display: 'flex', justifyContent: 'center'}}>
        <div style={{display: 'grid', gridTemplateColumns: `auto ${90 * shift}px ${shift}fr`, alignItems: 'center', direction: lang === 'he' ? 'rtl' : 'ltr'}}>
          <div style={{display: 'flex', direction: 'ltr'}}>
            {letters.map((ch, i) => {
              const p = enterSoft(frame, fps, q.mark + i * 4, 48);
              return (
                <span key={i} style={{display: 'inline-block', overflow: 'hidden', paddingBlock: size * 0.12, marginBlock: -size * 0.12}}>
                  <span style={{display: 'block', fontFamily: FONT.sans, fontSize: size, fontWeight: 600, lineHeight: 1, color: C.text, letterSpacing: `${interpolate(p, [0, 1], [0.5, 0.05])}em`, translate: `0 ${(1 - p) * size * 0.8}px`, opacity: interpolate(p, [0, 0.35], [0, 1], clamp), filter: p < 0.98 ? `blur(${(1 - p) * 18}px)` : undefined}}>{ch}</span>
                </span>
              );
            })}
          </div>
          <div />
          <div style={{minWidth: 0, overflow: 'hidden', paddingBlock: size * 0.14, marginBlock: -size * 0.14}}>
            <span style={{display: 'block', fontFamily: FONT.sans, fontSize: size, fontWeight: 300, lineHeight: 1, color: C.warm, letterSpacing: lang === 'he' ? '0' : '0.02em', translate: `0 ${(1 - w) * size * 0.9}px`, opacity: interpolate(w, [0, 0.35], [0, 1], clamp), filter: w < 0.98 ? `blur(${(1 - w) * 16}px)` : undefined, whiteSpace: 'nowrap'}}>
              {t.brandEnd.works}
            </span>
          </div>
        </div>
      </div>

      <div style={{position: 'absolute', left: 0, right: 0, top: 760, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 40, opacity: soon * soonPulse, direction: 'ltr'}}>
        <div style={{width: 120 * soon, height: 1, background: C.lineHi}} />
        <Mono size={30} color={C.warm} track={0.5} style={{textShadow: '0 0 24px rgba(244,217,174,0.5)', paddingInlineStart: '0.5em'}}>{t.brandEnd.soon}</Mono>
        <div style={{width: 120 * soon, height: 1, background: C.lineHi}} />
      </div>
    </SceneRoot>
  );
};
