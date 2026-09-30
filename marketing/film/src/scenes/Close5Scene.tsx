import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Label, Ltr, SceneRoot} from '../ui/base';
import {ChatHeader, DayClock, Thread, type ThreadItem} from '../ui/chat';
import {DealRail, DemoTag, FactChip, RevenueMetric} from '../ui/cards';

/** 15:44 — Barry sells. A counter-offer inside the authority the business gave him, and the deal closes. */
export const Close5Scene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.close5;
  const k = t.close5;
  const closed = prog(frame, q.after + 2 * q.afterGap, 18);

  const items: ThreadItem[] = [
    {kind: 'msg', who: 'customer', side: 'start', at: q.c1, text: k.c1, time: '15:44'},
    {kind: 'typing', side: 'end', at: q.typing, out: q.b1 - 1},
    {kind: 'msg', who: 'barry', side: 'end', at: q.b1, text: k.b1, time: '15:44', ticks: true},
    {kind: 'msg', who: 'customer', side: 'start', at: q.c2, text: k.c2, time: '15:45'},
  ];

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.35 + 0.35 * closed} bloomX={lang === 'he' ? 30 : 70} bloomY={62} grid={0.3} />}>
      <DayClock clock={CLOCK.close5} />
      <div style={{position: 'absolute', insetInlineStart: 140, top: 150, width: 860}}>
        <ChatHeader at={0} name={k.customer} sub={lang === 'he' ? 'לקוח · Onyx Studio' : 'Customer · Onyx Studio'} live />
        <Thread items={items} height={380} width={860} size={34} maxWidth={720} fade={40} />
      </div>

      {/* the deal, as Barry sees it */}
      <div style={{position: 'absolute', insetInlineStart: 1160, top: 160, display: 'flex', flexDirection: 'column', gap: 34}}>
        <Enter at={q.rail} y={16} blur={8} dur={24}>
          <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
            <Label size={13} color={C.faint}>{k.orderValue.label}</Label>
            <RevenueMetric at={q.rail + 2} value={k.orderValue.value} size={104} dur={30} />
          </div>
        </Enter>
        <div style={{display: 'flex', gap: 60}}>
          <FactChip at={q.lock} label={k.discount.label} value={k.discount.value} tone="warm" />
          <FactChip at={q.lock + 8} label={k.margin.label} value={k.margin.value} />
        </div>
      </div>

      <div style={{position: 'absolute', insetInlineStart: 300, top: 650}}>
        <DealRail at={q.rail} zoneAt={q.zone} markerAt={q.marker} lockAt={q.lock} width={1320} />
      </div>

      {/* what the yes turned into */}
      <div style={{position: 'absolute', insetInlineStart: 300, top: 870, display: 'flex', gap: 110}}>
        {k.after.map((a, i) => (
          <FactChip key={i} at={q.after + i * q.afterGap} label={a.label} value={a.value} size={i === 2 ? 48 : 40} />
        ))}
      </div>
      <div style={{position: 'absolute', insetInlineEnd: 150, top: 880, opacity: closed}}>
        <Ltr style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 16, letterSpacing: '0.14em', color: C.faint}}>#ORD-8852</Ltr>
      </div>
      <DemoTag at={20} />
    </SceneRoot>
  );
};
