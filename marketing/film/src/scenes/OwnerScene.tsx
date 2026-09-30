import React from 'react';
import {useCurrentFrame} from 'remotion';
import {EASE, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, SceneRoot} from '../ui/base';
import {ChatHeader, DayClock, Thread, type ThreadItem} from '../ui/chat';
import {DemoTag, OutcomeCard, StatusLine} from '../ui/cards';

/** 18:42 — The owner heads out. Barry briefs like a COO: human words first, system precision second. */
export const OwnerScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.owner;
  const o = t.owner;
  const back = prog(frame, q.cardStart - 12, 22, EASE.inOut);

  const items: ThreadItem[] = [
    {kind: 'msg', who: 'owner', side: 'end', at: q.q1, text: o.q1, time: '18:42', ticks: true},
    {kind: 'typing', side: 'start', at: q.typing, out: q.b1 - 1},
    {kind: 'msg', who: 'barry', side: 'start', at: q.b1, text: o.b1, time: '18:42'},
    {kind: 'msg', who: 'barry', side: 'start', at: q.b2, text: o.b2, time: '18:42', gap: 10},
    {kind: 'msg', who: 'barry', side: 'start', at: q.b3, text: o.b3, time: '18:42', gap: 10},
    {kind: 'msg', who: 'owner', side: 'end', at: q.q2, text: o.q2, time: '18:43', ticks: true},
    {kind: 'typing', side: 'start', at: q.typing2, out: q.b4 - 1},
    {kind: 'msg', who: 'barry', side: 'start', at: q.b4, text: o.b4, time: '18:43'},
  ];

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.45} bloomX={lang === 'he' ? 70 : 30} bloomY={50} grid={0.2} />}>
      <DayClock clock={CLOCK.owner} hideAt={q.cardStart - 12} />
      <div style={{position: 'absolute', inset: 0, opacity: 1 - 0.78 * back, filter: back > 0.02 ? `blur(${back * 10}px)` : undefined, scale: 1 - 0.04 * back}}>
        <div style={{position: 'absolute', insetInlineStart: 140, top: 150, width: 880}}>
          <ChatHeader at={0} name={t.barry} sub={t.activeNow} live barry />
          <Thread items={items} height={800} width={880} size={38} maxWidth={780} fade={150} />
        </div>
        <div style={{position: 'absolute', insetInlineStart: 1160, top: 300}}>
          <StatusLine at={q.strip} label={o.strip[0].label} value={o.strip[0].value} tone="working" />
          <StatusLine at={q.strip + q.stripGap} label={o.strip[1].label} value={o.strip[1].value} tone="hold" />
          <StatusLine at={q.strip + 2 * q.stripGap} label={o.strip[2].label} value={o.strip[2].value} tone="ok" />
        </div>
      </div>
      {frame >= q.cardStart - 2 && (
        <div style={{position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', justifyContent: 'center', gap: 30}}>
          {o.outcomes.map((oc, i) => (
            <OutcomeCard key={i} at={q.cardStart + i * q.cardGap} label={oc.label} value={oc.value} unit={oc.unit} tag={o.verified} hero={i === 0} />
          ))}
        </div>
      )}
      <DemoTag at={20} />
    </SceneRoot>
  );
};
