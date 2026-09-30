import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, connectionTravel, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, SceneRoot} from '../ui/base';
import {ChatHeader, DayClock, Thread, type ThreadItem} from '../ui/chat';
import {ApprovalCard, DemoTag} from '../ui/cards';
import {SystemConnection} from '../ui/system';

/** 16:02 — The stubborn one. Barry holds the line, then brings the owner one decision that matters. */
export const EscalateScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang} = useLang();
  const q = Q.escalate;
  const e = t.escalate;
  const cut = frame >= q.cut;

  const items: ThreadItem[] = [
    {kind: 'msg', who: 'customer', side: 'start', at: q.c1, text: e.c1, time: '16:02'},
    {kind: 'typing', side: 'end', at: q.typing, out: q.b1 - 1},
    {kind: 'msg', who: 'barry', side: 'end', at: q.b1, text: e.b1, time: '16:02', ticks: true},
    {kind: 'msg', who: 'customer', side: 'start', at: q.c2, text: e.c2, time: '16:02'},
    {kind: 'typing', side: 'end', at: q.typing2, out: q.b2 - 1},
    {kind: 'msg', who: 'barry', side: 'end', at: q.b2, text: e.b2, time: '16:03', ticks: true},
    {kind: 'note', at: q.paid, text: e.paid, tone: 'ok', gap: 22},
  ];

  if (cut) {
    return (
      <SceneRoot backdrop={<Backdrop bloom={0.6 * prog(frame, q.t2, 30)} bloomY={56} bloomSize={58} />}>
        <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8}}>
          <div style={{opacity: 1 - 0.5 * prog(frame, q.t2, 14)}}>
            <Headline text={e.t1} at={q.t1} size={lang === 'he' ? 120 : 110} weight={300} maxWidth={1760} stagger={3} />
          </div>
          <Headline text={e.t2} at={q.t2} size={lang === 'he' ? 150 : 132} weight={600} maxWidth={1760} stagger={4} />
        </div>
      </SceneRoot>
    );
  }

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.4} bloomX={lang === 'he' ? 25 : 75} bloomY={45} grid={0.25} />}>
      <DayClock clock={CLOCK.escalate} />
      {/* Barry's request travels to the owner; the decision travels back */}
      <SystemConnection a={{x: mx(930), y: 560}} b={{x: mx(1080), y: 360}} curve={-40} draw={prog(frame, q.send, 14, EASE.inOut)} travel={connectionTravel(frame, q.send, 18)} opacity={0.3} />
      <SystemConnection a={{x: mx(1080), y: 820}} b={{x: mx(930), y: 800}} curve={-30} draw={prog(frame, q.back, 14, EASE.inOut)} travel={connectionTravel(frame, q.back, 22)} opacity={0.3} />

      <div style={{position: 'absolute', insetInlineStart: 140, top: 150, width: 820}}>
        <ChatHeader at={0} name={e.customer} sub={lang === 'he' ? 'לקוח · Onyx Studio' : 'Customer · Onyx Studio'} live />
        <Thread items={items} height={790} width={820} size={38} maxWidth={730} fade={120} />
      </div>
      <div style={{position: 'absolute', insetInlineStart: 1080, top: 230}}>
        <ApprovalCard at={q.card} buttonsAt={q.buttons} tapAt={q.tap} resolveAt={q.resolve} />
      </div>
      <DemoTag at={20} />
    </SceneRoot>
  );
};
