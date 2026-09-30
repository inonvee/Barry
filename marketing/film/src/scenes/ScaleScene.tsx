import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../theme';
import {EASE, clamp, connectionTravel, enterImpact, prog} from '../motion';
import {BEAT, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, SceneRoot} from '../ui/base';
import {BarryCore, Glyph, SystemConnection} from '../ui/system';

const GLYPHS = ['message', 'calendar', 'box', 'card', 'support', 'stack', 'truck', 'shield', 'receipt', 'chart', 'person'];
const CX = 960, CY = 540, RX = 720, RY = 395;

/** 0:55 — One operator. Every capability arrives on the beat and connects into Barry. */
export const ScaleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, lang} = useLang();
  const q = Q.scale;
  const words = t.scale.words;
  const beatIndex = Math.floor(frame / BEAT);
  const beatPos = frame % BEAT;
  const kick = frame < q.one2 + 60 ? Math.exp(-beatPos / 4.5) : 0;

  const contract = prog(frame, q.one1, 50, EASE.inOut) * 0.45 + prog(frame, q.one2 - 6, 40, EASE.inOut) * 0.5;
  const nodeAt = (i: number) => (i < words.length ? q.wordStart + i * q.wordGap : q.graph + (i - words.length) * 11);
  const pos = (i: number) => {
    const a = ((-90 + (i * 360) / GLYPHS.length) * Math.PI) / 180;
    const k = 1 - contract;
    return {x: CX + Math.cos(a) * RX * k, y: CY + Math.sin(a) * RY * k};
  };
  const edge = (p: {x: number; y: number}, r: number) => {
    const dx = CX - p.x, dy = CY - p.y, d = Math.hypot(dx, dy) || 1;
    return {x: CX - (dx / d) * r, y: CY - (dy / d) * r};
  };
  const web = prog(frame, q.graph, 40, EASE.inOut);
  const fade = (1 - 0.72 * prog(frame, q.one1, 24, EASE.inOut)) * (1 - prog(frame, q.one2 + 26, 30, EASE.inOut));
  const coreGrow = 1 + 0.5 * prog(frame, q.one2, 50, EASE.out);

  const wordIdx = frame < q.graph ? Math.min(words.length - 1, Math.floor((frame - q.wordStart) / q.wordGap)) : -1;
  const big = lang === 'he' ? 260 : 210;
  const showOne1 = frame >= q.one1 && frame < q.one2;
  const showOne2 = frame >= q.one2;
  const wordText = frame < q.graph ? (frame >= 0 ? words[Math.max(0, wordIdx)] : '') : showOne1 ? t.scale.one1 : showOne2 ? t.scale.one2 : '';
  const wordStart = frame < q.graph ? q.wordStart + Math.max(0, wordIdx) * q.wordGap : showOne1 ? q.one1 : q.one2;
  const pop = enterImpact(frame, fps, wordStart, 8);
  const strong = showOne2;

  return (
    <SceneRoot backdrop={<Backdrop grid={0.7} bloom={0.6 + 0.4 * (frame >= q.one2 ? prog(frame, q.one2, 40) : 0)} bloomSize={80} />}>
      {/* connections into the core */}
      {GLYPHS.map((g, i) => {
        const at = nodeAt(i);
        const p = pos(i);
        return (
          <SystemConnection key={`c${i}`} a={p} b={edge(p, 140 * coreGrow)} curve={i % 2 ? 40 : -40} draw={prog(frame, at + 2, 12, EASE.out)} travel={connectionTravel(frame, at + 3, 14)} opacity={0.3 * fade} />
        );
      })}
      {/* the web between capabilities: the nervous system */}
      {GLYPHS.map((g, i) => {
        const a = pos(i), b = pos((i + 1) % GLYPHS.length);
        const c = pos((i + 3) % GLYPHS.length);
        return (
          <React.Fragment key={`w${i}`}>
            <SystemConnection a={a} b={b} curve={-30} draw={web} travel={connectionTravel(frame, q.graph + 10 + i * 3, 26)} opacity={0.2 * fade} />
            {i % 2 === 0 && <SystemConnection a={a} b={c} curve={60} draw={prog(frame, q.graph + 16 + i * 2, 30, EASE.inOut)} opacity={0.11 * fade} />}
          </React.Fragment>
        );
      })}

      {/* nodes */}
      {GLYPHS.map((g, i) => {
        const at = nodeAt(i);
        const p = pos(i);
        if (frame < at) return null;
        const pp = enterImpact(frame, fps, at, 10);
        const flash = Math.exp(-(frame - at) / 8);
        return (
          <div key={`n${i}`} style={{position: 'absolute', left: p.x - 46, top: p.y - 46, width: 92, height: 92, opacity: fade * interpolate(pp, [0, 0.4], [0, 1], clamp), scale: 0.6 + 0.4 * pp}}>
            <div style={{width: 92, height: 92, borderRadius: '50%', border: `1px solid ${C.warm}${flash > 0.3 ? 'ee' : '66'}`, background: `rgba(244,217,174,${0.06 + 0.2 * flash})`, boxShadow: `0 0 ${20 + 50 * flash}px rgba(244,217,174,${0.15 + 0.4 * flash})`, display: 'grid', placeItems: 'center'}}>
              <Glyph name={g} size={40} color={flash > 0.3 ? C.text : C.warm} draw={prog(frame, at, 8)} />
            </div>
          </div>
        );
      })}

      {/* the core, kicked by the beat */}
      <div style={{position: 'absolute', left: CX - 130, top: CY - 130, scale: (1 + 0.07 * kick) * coreGrow, opacity: 0.9}}>
        <BarryCore size={260} energy={0.6 + 0.4 * kick + 0.4 * (showOne2 ? 1 : 0)} pulsePeriod={60} />
      </div>

      {/* hard-cut words on the beat */}
      {wordText && (
        <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', opacity: 1 - prog(frame, q.one2 + 50, 8)}}>
          <div style={{fontSize: big * (frame >= q.one1 ? 0.62 : 1), fontWeight: strong ? 700 : frame >= q.one1 ? 300 : 600, letterSpacing: lang === 'he' ? '-0.02em' : '-0.035em', lineHeight: 1, scale: 1.07 - 0.07 * pop, textShadow: '0 0 60px rgba(5,5,6,0.9), 0 0 24px rgba(5,5,6,0.9)', whiteSpace: 'nowrap'}}>
            {wordText}
          </div>
        </div>
      )}
    </SceneRoot>
  );
};
