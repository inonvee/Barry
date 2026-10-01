import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {prog, systemPulse} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Headline, Label, Ltr, Mixed, SceneRoot} from '../ui/base';
import {DayClock, Notification} from '../ui/chat';
import {DemoTag} from '../ui/cards';
import {Glyph, StatusIndicator} from '../ui/system';

/**
 * 22:05 — BARRY Margins. Barry keeps asking one question: "where can this business spend less without hurting it?"
 * Left: the whole cost structure, reviewed. Right: the lead finding (what it costs, why, how much, what to do) + the rest.
 */
export const MarginsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang, sx} = useLang();
  const q = Q.margins;
  const m = t.margins;
  const pulse = systemPulse(frame, 50);

  if (frame >= q.cut) {
    return (
      <SceneRoot backdrop={<Backdrop bloom={0.55 * prog(frame, q.t2, 30)} bloomY={56} bloomSize={58} />}>
        <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6}}>
          <div style={{opacity: 1 - 0.5 * prog(frame, q.t2, 14)}}>
            <Headline text={m.t1} at={q.t1} size={lang === 'he' ? 150 : 140} weight={300} stagger={4} maxWidth={1760} />
          </div>
          <Headline text={m.t2} at={q.t2} size={lang === 'he' ? 150 : 140} weight={600} stagger={4} maxWidth={1760} />
        </div>
      </SceneRoot>
    );
  }

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.45} bloomX={lang === 'he' ? 30 : 70} bloomY={52} grid={0.2} />}>
      <DayClock clock={CLOCK.margins} />

      {/* the human moment, then the sweep */}
      <div style={{position: 'absolute', insetInlineStart: 130, top: 150, width: 800, display: 'flex', flexDirection: 'column', gap: 34}}>
        <Notification at={q.notif} name={t.barry} text={m.notif} time="22:05" barry width={800} />
        <div style={{display: 'flex', flexDirection: 'column', gap: 4, paddingInline: 10}}>
          <div style={{opacity: prog(frame, q.sweep - 6, 12), marginBottom: 8}}><Label size={14} color={C.faint}>{m.sweepLabel}</Label></div>
          {m.sweep.map((s, i) => {
            const at = q.sweep + i * q.sweepGap;
            const done = prog(frame, at + 6, 8);
            return (
              <Enter key={i} at={at} y={8} x={16} blur={4} dur={14}>
                <div style={{display: 'flex', alignItems: 'center', gap: 18, height: 52, borderBottom: `1px solid ${C.line}`}}>
                  <div style={{width: 26, display: 'grid', placeItems: 'center'}}>
                    {s.flag ? <StatusIndicator status={done > 0.5 ? 'hold' : 'working'} size={12} /> : <Glyph name="check" size={24} color={C.verify} stroke={2.2} draw={done} />}
                  </div>
                  <span style={{fontSize: 28, color: s.flag ? C.text : C.dim, flex: 1}}>{s.area}</span>
                  <span style={{fontSize: 26, color: s.flag ? C.hold : C.faint, opacity: done, fontWeight: s.flag ? 500 : 400}}><Mixed text={s.flag ?? m.ok} /></span>
                </div>
              </Enter>
            );
          })}
        </div>
      </div>

      {/* the lead finding */}
      <div style={{position: 'absolute', insetInlineStart: 1000, top: 110}}>
        <Enter at={q.card} y={46} blur={16} dur={32} scale={0.96}>
          <div style={{width: 800, padding: '34px 42px 36px', borderRadius: 34, background: 'linear-gradient(180deg, #151517 0%, #0d0d0f 100%)', border: `1px solid rgba(244,217,174,${0.22 + 0.1 * pulse})`, boxShadow: '0 50px 140px rgba(0,0,0,0.6), 0 0 80px rgba(244,217,174,0.06)', display: 'flex', flexDirection: 'column', gap: 20}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
              <span style={{width: 10, height: 10, borderRadius: '50%', background: C.warm, boxShadow: '0 0 14px rgba(244,217,174,0.9)'}} />
              <Label size={16} color={C.warm}>{m.feature}</Label>
            </div>

            <Enter at={q.current} y={12} blur={6} dur={22}>
              <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                <Label size={14} color={C.faint}>{m.leadLabel}</Label>
                <div style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
                  <span style={{fontSize: 76, fontWeight: 300, letterSpacing: '-0.03em', lineHeight: 1}}><Mixed text={m.current} /></span>
                  <span style={{fontSize: 28, color: C.dim}}>{m.currentUnit}</span>
                  <span style={{fontSize: 30, color: C.hold, fontWeight: 600, opacity: prog(frame, q.why, 12)}}><Ltr>+11%</Ltr></span>
                </div>
              </div>
            </Enter>
            <Enter at={q.why} y={10} blur={6} dur={20}>
              <span style={{fontSize: 29, lineHeight: 1.32, color: C.text}}><Mixed text={m.why} /></span>
            </Enter>
            <Enter at={q.saving} y={14} blur={8} dur={24}>
              <div style={{display: 'flex', alignItems: 'baseline', gap: 16}}>
                <span style={{fontSize: 80, fontWeight: 500, color: C.verify, letterSpacing: '-0.03em', lineHeight: 1}}><Mixed text={m.saving} /></span>
                <span style={{fontSize: 28, color: C.verify, opacity: 0.85}}>{m.savingUnit}</span>
              </div>
            </Enter>
            <Enter at={q.actions} y={10} blur={4} dur={18}>
              <div style={{display: 'flex', gap: 14}}>
                <div style={{display: 'inline-flex', alignItems: 'center', gap: 12, padding: '16px 28px', borderRadius: 34, background: C.text, color: '#0a0a0b', fontSize: 26, fontWeight: 600, boxShadow: `0 0 ${24 + 16 * pulse}px rgba(243,238,230,0.16)`}}>
                  <Mixed text={m.actions[0]} />
                  <span style={{display: 'inline-block', scale: sx === 1 ? '1 1' : '-1 1'}}>→</span>
                </div>
                <div style={{display: 'inline-flex', alignItems: 'center', padding: '16px 26px', borderRadius: 34, border: `1px solid ${C.lineHi}`, color: C.dim, fontSize: 26}}><Mixed text={m.actions[1]} /></div>
              </div>
            </Enter>

            <div style={{height: 1, background: C.line, marginTop: 4}} />
            <div style={{opacity: prog(frame, q.more - 4, 12)}}><Label size={13} color={C.faint}>{m.moreLabel}</Label></div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
              {m.more.map((x, i) => (
                <Enter key={i} at={q.more + i * q.moreGap} y={8} blur={4} dur={16}>
                  <div style={{display: 'flex', alignItems: 'baseline', gap: 18}}>
                    <span style={{fontSize: 25, color: C.dim, flex: 1}}><Mixed text={x.what} /></span>
                    <span style={{fontSize: 26, color: C.verify, whiteSpace: 'nowrap'}}><Mixed text={x.saving} /></span>
                  </div>
                </Enter>
              ))}
            </div>
            <Enter at={q.total} y={10} blur={6} dur={20}>
              <div style={{display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingTop: 14, borderTop: `1px solid ${C.lineHi}`}}>
                <Label size={15} color={C.text}>{m.totalLabel}</Label>
                <span style={{fontSize: 42, fontWeight: 600, color: C.verify}}><Mixed text={m.total} /></span>
              </div>
            </Enter>
          </div>
        </Enter>
      </div>
      <DemoTag at={20} />
    </SceneRoot>
  );
};
