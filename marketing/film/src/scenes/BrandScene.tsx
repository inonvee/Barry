import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT} from '../theme';
import {EASE, clamp, enterSoft, prog, systemPulse} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, Mono, SceneRoot} from '../ui/base';

/** The earned reveal: vacuum → one point of light → BARRY → the promise → COMING SOON. */
export const BrandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, lang} = useLang();
  const q = Q.brand;
  const b = t.brandEnd;

  const dot = prog(frame, q.point, 20);
  const line = prog(frame, q.line, 34, EASE.inOut);
  const letters = t.brand.split('');
  const markSize = lang === 'he' ? 250 : 250;
  const glow = prog(frame, q.mark, 60);
  const soon = prog(frame, q.soon, 30);
  const soonPulse = 0.75 + 0.25 * systemPulse(frame, 120);
  const CY = 430;

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.55 * glow} bloomY={40} bloomSize={62} />}>
      {/* the point of light */}
      {frame < q.mark + 18 && (
        <div style={{position: 'absolute', left: 960 - 5, top: CY - 5, width: 10, height: 10, borderRadius: '50%', background: C.warm, opacity: dot * (1 - prog(frame, q.mark + 4, 14)), boxShadow: '0 0 30px 6px rgba(244,217,174,0.75)', scale: 1 + 3 * (1 - dot)}} />
      )}
      {/* horizon line that carries the wordmark */}
      <div style={{position: 'absolute', left: 960 - 520 * line, top: CY + 8, width: 1040 * line, height: 1, background: `linear-gradient(90deg, transparent, ${C.lineHi}, transparent)`, opacity: 1 - prog(frame, q.mark + 20, 30)}} />

      {/* soft halo behind the wordmark (a separate layer so per-letter masks never clip the glow) */}
      <div style={{position: 'absolute', left: 960 - 700, top: CY - 190, width: 1400, height: 380, background: 'radial-gradient(ellipse at center, rgba(244,217,174,0.16) 0%, rgba(244,217,174,0.05) 45%, transparent 70%)', opacity: glow * (0.8 + 0.2 * systemPulse(frame, 140))}} />
      {/* wordmark */}
      <div style={{position: 'absolute', left: 0, right: 0, top: CY - markSize * 0.56, display: 'flex', justifyContent: 'center', direction: 'ltr'}}>
        <div style={{display: 'flex', overflow: 'visible', translate: `${markSize * 0.03}px 0`}}>
          {letters.map((ch, i) => {
            const p = enterSoft(frame, fps, q.mark + i * 4, 48);
            const track = interpolate(p, [0, 1], [0.5, 0.06]);
            return (
              <span key={i} style={{display: 'inline-block', overflow: 'hidden', paddingBlock: markSize * 0.12, marginBlock: -markSize * 0.12}}>
                <span
                  style={{
                    display: 'block',
                    fontFamily: FONT.sans,
                    fontSize: markSize,
                    fontWeight: 600,
                    lineHeight: 1,
                    color: C.text,
                    letterSpacing: `${track}em`,
                    translate: `0 ${(1 - p) * markSize * 0.8}px`,
                    opacity: interpolate(p, [0, 0.35], [0, 1], clamp),
                    filter: p < 0.98 ? `blur(${(1 - p) * 18}px)` : undefined,
                  }}
                >
                  {ch}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* the promise */}
      <div style={{position: 'absolute', left: 0, right: 0, top: 640, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4}}>
        <Headline text={b.t1} at={q.tag1} size={lang === 'he' ? 70 : 62} weight={300} dimWords={b.t1.split(' ')} maxWidth={1500} stagger={3} />
        <Headline text={b.t2} at={q.tag2} size={lang === 'he' ? 70 : 62} weight={300} emphWords={[b.t2emph]} emphWeight={600} maxWidth={1500} stagger={3} />
      </div>

      {/* COMING SOON */}
      <div style={{position: 'absolute', left: 0, right: 0, top: 925, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 34, opacity: soon * soonPulse, direction: 'ltr'}}>
        <div style={{width: 90 * soon, height: 1, background: C.lineHi}} />
        <Mono size={22} color={C.warm} track={0.6} style={{textShadow: '0 0 24px rgba(244,217,174,0.5)', paddingInlineStart: '0.6em'}}>{b.soon}</Mono>
        <div style={{width: 90 * soon, height: 1, background: C.lineHi}} />
      </div>
    </SceneRoot>
  );
};
