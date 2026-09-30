import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Mixed, SceneRoot} from '../ui/base';
import {DayClock, Notification} from '../ui/chat';

const Grow: React.FC<{at: number; children: React.ReactNode}> = ({at, children}) => {
  const frame = useCurrentFrame();
  const g = prog(frame, at - 1, 12, EASE.out);
  const p = prog(frame, at, 16, EASE.out);
  if (g <= 0.001) return null;
  return (
    <div style={{display: 'grid', gridTemplateRows: `${g}fr`}}>
      <div style={{minHeight: 0, overflow: 'hidden'}}>
        <div style={{paddingTop: 16, opacity: p, translate: `0 ${(1 - p) * 16}px`}}>{children}</div>
      </div>
    </div>
  );
};

/** 07:01 — the next morning mirrors the first. Barry was up first again. */
export const NextDayScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.nextDay;
  const n = t.nextDay;
  return (
    <SceneRoot backdrop={<Backdrop bloom={0.4 * prog(frame, q.barry, 40)} bloomX={lang === 'he' ? 72 : 28} bloomY={45} bloomSize={55} />}>
      <DayClock clock={CLOCK.nextDay} />
      <div style={{position: 'absolute', insetInlineStart: 150, top: 200, display: 'flex', flexDirection: 'column', gap: 26}}>
        <Notification at={q.barry} name={t.barry} text={n.b1} time="07:01" barry>
          <Grow at={q.b2}><span style={{fontSize: 34, lineHeight: 1.34, color: 'rgba(243,238,230,0.9)'}}><Mixed text={n.b2} /></span></Grow>
        </Notification>
        <Notification at={q.employee} name={t.morning.employee} text={n.employeeMsg} time="07:04" />
      </div>
    </SceneRoot>
  );
};
