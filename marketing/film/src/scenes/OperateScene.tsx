import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, connectionTravel, enterImpact, prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Headline, Label, Mono, SceneRoot} from '../ui/base';
import {BarryMessage, CustomerMessage, TypingDots} from '../ui/chat';
import {DemoTag, LedgerRow} from '../ui/cards';
import {BarryCore, Glyph, SystemConnection} from '../ui/system';
import {useVideoConfig} from 'remotion';

const GLYPHS = ['box', 'calendar', 'card', 'support', 'receipt'];

/** One hard-cut moment: an authoritative outcome, full frame, on the beat. */
const Flash: React.FC<{i: number; title: string; detail: string}> = ({i, title, detail}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {lang, t} = useLang();
  const q = Q.operate;
  const start = q.flashStart + i * q.flashGap;
  const local = frame - start;
  const p = enterImpact(frame, fps, start, 10);
  const lit = prog(frame, start + 2, 10);
  const size = lang === 'he' ? 128 : 92;
  const bloomX = [30, 70, 40, 62, 50][i];
  return (
    <div style={{position: 'absolute', inset: 0}}>
      <Backdrop bloom={0.9} bloomX={bloomX} bloomY={52} bloomSize={48} grid={0.6} />
      <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 34}}>
        <div style={{opacity: lit, scale: 1.12 - 0.12 * p}}>
          <Glyph name={GLYPHS[i]} size={84} color={C.warm} draw={lit} stroke={1.2} />
        </div>
        <div
          style={{
            fontSize: size,
            fontWeight: lang === 'he' ? 600 : 500,
            letterSpacing: lang === 'he' ? '-0.01em' : '0.02em',
            lineHeight: 1,
            scale: 1.06 - 0.06 * p,
            opacity: local < 0 ? 0 : 1,
            textAlign: 'center',
          }}
        >
          {title}
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 18, opacity: prog(frame, start + 3, 8)}}>
          <Glyph name="check" size={28} color={C.verify} stroke={2} draw={prog(frame, start + 4, 8)} />
          <Mono size={22} color={C.dim} track={0.16}>{detail}</Mono>
        </div>
      </div>
      {/* progress: which outcome of five */}
      <div style={{position: 'absolute', left: 0, right: 0, bottom: 90, display: 'flex', justifyContent: 'center', gap: 16, direction: 'ltr'}}>
        {t.operate.flashes.map((_, k) => (
          <span key={k} style={{width: k === i ? 36 : 8, height: 4, borderRadius: 2, background: k <= i ? C.warm : C.ghost, opacity: k <= i ? 1 : 0.7}} />
        ))}
      </div>
    </div>
  );
};

/** 0:15 — Barry operates. The conversation is the surface; real work happens beneath it. */
export const OperateScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang} = useLang();
  const q = Q.operate;
  const o = t.operate;
  const inFlashes = frame >= q.flashStart && frame < q.flashStart + 5 * q.flashGap + 2;
  const inA = frame < q.flashStart;
  const rows = o.rows;
  const F = lang === 'he' ? 42 : 42;
  const rowAt = (i: number) => q.rowStart + i * q.rowGap;
  const railTop = 316;
  const rail = prog(frame, q.rowStart, q.pay + 30 - q.rowStart, EASE.inOut);

  return (
    <SceneRoot backdrop={inA ? <Backdrop bloom={0.6} bloomX={mx(66)} bloomY={50} grid={0.35} /> : <Backdrop />}>
      {inA && (
        <>
          <SystemConnection a={{x: mx(800), y: 372}} b={{x: mx(945), y: 430}} curve={20} draw={prog(frame, q.c2 + 14, 22, EASE.inOut)} travel={connectionTravel(frame, q.c2 + 22, 20)} opacity={0.28} />
          <SystemConnection a={{x: mx(945), y: 430}} b={{x: mx(1094), y: 352}} curve={-20} draw={prog(frame, q.c2 + 30, 22, EASE.inOut)} travel={connectionTravel(frame, q.c2 + 36, 22)} opacity={0.28} />
          <div style={{position: 'absolute', left: mx(945) - 50, top: 430 - 50, opacity: prog(frame, q.c2 + 10, 20)}}>
            <BarryCore size={100} energy={0.9} pulsePeriod={60} />
          </div>

          <div style={{position: 'absolute', left: 140, right: 140, top: 280, height: 560, display: 'flex', justifyContent: 'space-between'}}>
            {/* conversation */}
            <div style={{width: 700, height: 560, display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
              <CustomerMessage at={q.c2} text={o.c2} maxWidth={700} size={F} />
              <div style={{position: 'relative', height: 250}}>
                <div style={{position: 'absolute', insetInlineEnd: 0, bottom: 0}}>
                  <TypingDots at={q.payDone + 4} out={q.b2} />
                </div>
                <div style={{position: 'absolute', insetInlineEnd: 0, bottom: 0}}>
                  <BarryMessage at={q.b2} label="Barry" maxWidth={660} size={F}>
                    <div style={{display: 'flex', flexDirection: 'column', gap: 22}}>
                      <span>{o.b2}</span>
                      <div style={{display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderRadius: 16, background: 'rgba(10,10,11,0.08)', border: '1px solid rgba(10,10,11,0.14)', fontSize: 26, fontWeight: 500}}>
                        <Glyph name="card" size={28} color="#0a0a0b" />
                        {o.linkChip}
                      </div>
                    </div>
                  </BarryMessage>
                </div>
              </div>
            </div>

            {/* the operation beneath */}
            <div style={{width: 720, position: 'relative', paddingInlineStart: 34}}>
              <div style={{position: 'absolute', insetInlineStart: 0, top: 30, width: 1, height: 430 * rail, background: `linear-gradient(180deg, ${C.warm}, ${C.warm}00)`, opacity: 0.6}} />
              {rows.map((r, i) => (
                <LedgerRow key={i} at={rowAt(i)} label={r.label} value={r.value} tone={i === 3 ? 'warm' : 'ok'} big={i === 1} />
              ))}
              <LedgerRow at={q.pay - 10} label={o.payLabel} value={o.payDone} workingLabel={o.payPreparing} doneAt={q.payDone} big />
            </div>
          </div>
          <DemoTag at={20} />
        </>
      )}

      {inFlashes && o.flashes.map((f, i) => {
        const s = q.flashStart + i * q.flashGap;
        return frame >= s && frame < s + q.flashGap ? <Flash key={i} i={i} title={f.title} detail={f.detail} /> : null;
      })}

      {frame >= q.title1 - 2 && (
        <>
          <Backdrop bloom={prog(frame, q.title2, 30) * 0.8} bloomY={56} bloomSize={58} />
          <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4}}>
            <div style={{opacity: 1 - 0.7 * prog(frame, q.title2, 14)}}>
              <Headline text={o.t1} at={q.title1} size={lang === 'he' ? 128 : 112} weight={300} maxWidth={1700} stagger={4} />
            </div>
            <Headline text={o.t2} at={q.title2} size={lang === 'he' ? 250 : 220} weight={600} maxWidth={1700} stagger={4} dur={30} />
          </div>
        </>
      )}
    </SceneRoot>
  );
};
