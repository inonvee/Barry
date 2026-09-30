import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, connectionTravel, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, Mixed, SceneRoot} from '../ui/base';
import {DayClock, Notification} from '../ui/chat';
import {ActivityLog} from '../ui/cards';
import {SystemConnection} from '../ui/system';

/** A line that eases open inside a card (same grammar as the thread rows). */
const Grow: React.FC<{at: number; children: React.ReactNode}> = ({at, children}) => {
  const frame = useCurrentFrame();
  const g = prog(frame, at - 1, 12, EASE.out);
  const p = prog(frame, at, 16, EASE.out);
  if (g <= 0.001) return null;
  return (
    <div style={{display: 'grid', gridTemplateRows: `${g}fr`}}>
      <div style={{minHeight: 0, overflow: 'hidden'}}>
        <div style={{paddingTop: 16, opacity: p, translate: `0 ${(1 - p) * 16}px`, filter: p < 0.97 ? `blur(${(1 - p) * 6}px)` : undefined}}>{children}</div>
      </div>
    </div>
  );
};

/** 07:03 — People stop. Someone calls in sick; Barry has already done the night shift. */
export const MorningScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.morning;
  const m = t.morning;
  const cut = frame >= q.cut;
  const sys = prog(frame, q.systems, 40, EASE.inOut);
  const lineStyle: React.CSSProperties = {fontSize: 34, lineHeight: 1.34, color: 'rgba(243,238,230,0.9)'};

  return (
    <SceneRoot backdrop={<Backdrop bloom={cut ? 0.35 * sys : 0.35 * prog(frame, q.barry, 40)} bloomX={lang === 'he' ? 72 : 28} bloomY={45} bloomSize={55} />}>
      {!cut && (
        <>
          <DayClock clock={CLOCK.morning} />
          {/* the night Barry already worked — off to the side, bleeding out of frame */}
          <div style={{position: 'absolute', insetInlineStart: 1180, width: 900, top: 90, filter: 'blur(0.6px)'}}>
            <ActivityLog at={q.log} rows={m.log} speed={0.7} opacity={0.75} />
          </div>
          <div style={{position: 'absolute', insetInlineStart: 150, top: 200, display: 'flex', flexDirection: 'column', gap: 26}}>
            <Notification at={q.notif} name={m.employee} text={m.employeeMsg} time="07:03" dim={prog(frame, q.barry, 30) * 0.7} />
            <Notification at={q.barry} name={t.barry} text={m.b1} time={t.now} barry>
              <Grow at={q.b2}><span style={lineStyle}><Mixed text={m.b2} /></span></Grow>
              <Grow at={q.b3}><span style={{...lineStyle, color: C.warm, fontWeight: 500}}><Mixed text={m.b3} /></span></Grow>
            </Notification>
          </div>
        </>
      )}

      {cut && (
        <>
          {/* the business keeps moving behind the words */}
          <div style={{position: 'absolute', inset: 0, opacity: sys * 0.55, filter: 'blur(2.5px)'}}>
            <div style={{position: 'absolute', insetInlineStart: 120, width: 760, top: 90}}>
              <ActivityLog at={q.systems} rows={m.log} speed={1.1} opacity={0.6} />
            </div>
            <div style={{position: 'absolute', insetInlineStart: 1160, width: 760, top: 90}}>
              <ActivityLog at={q.systems} rows={[...m.log].reverse()} speed={0.9} opacity={0.5} />
            </div>
            {[0, 1, 2, 3].map((i) => (
              <SystemConnection key={i} a={{x: 120 + i * 90, y: 200 + i * 190}} b={{x: 1800 - i * 120, y: 880 - i * 170}} curve={i % 2 ? 160 : -160} draw={sys} travel={connectionTravel(frame, q.systems + 6 + i * 9, 34)} opacity={0.12} />
            ))}
          </div>
          <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4}}>
            <div style={{opacity: 1 - 0.55 * prog(frame, q.t2, 14)}}>
              <Headline text={m.t1} at={q.t1} size={lang === 'he' ? 150 : 140} weight={300} stagger={4} />
            </div>
            <Headline text={m.t2} at={q.t2} size={lang === 'he' ? 150 : 140} weight={600} stagger={4} />
          </div>
        </>
      )}
    </SceneRoot>
  );
};
