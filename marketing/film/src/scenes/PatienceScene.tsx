import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, Ltr, Mono, SceneRoot} from '../ui/base';
import {ChatHeader, DayClock, Thread, type ThreadItem} from '../ui/chat';
import {RouteTrack} from '../ui/cards';

/** 13:18 — The customer every business knows. Barry answers message 37 like it was message 1. */
export const PatienceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.patience;
  const p = t.patience;
  const dimAll = prog(frame, q.t1 - 6, 20, EASE.inOut);

  const shown = q.burst.filter((b) => frame >= b).length + (frame >= q.reply ? 1 : 0);
  const count = 30 + shown;

  const items: ThreadItem[] = [
    ...p.history.map((h, i): ThreadItem => ({kind: 'msg', who: h.who === 'c' ? 'customer' : 'barry', side: h.who === 'c' ? 'start' : 'end', at: -999, text: h.text, time: h.time, ticks: h.who === 'b', dim: 1, gap: i === 0 ? 0 : 16})),
    ...p.burst.map((b, i): ThreadItem => ({kind: 'msg', who: 'customer', side: 'start', at: q.burst[i], text: b, time: i < 3 ? '13:17' : '13:18', gap: i === 0 ? 26 : 8})),
    {kind: 'typing', side: 'end', at: q.typing, out: q.reply - 1},
    {kind: 'msg', who: 'barry', side: 'end', at: q.reply, text: p.reply, time: '13:18', ticks: true, gap: 22},
  ];

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.3 + 0.3 * prog(frame, q.reply, 30)} bloomX={lang === 'he' ? 28 : 72} bloomY={50} grid={0.2} />}>
      <DayClock clock={CLOCK.patience} />
      <div style={{position: 'absolute', insetInlineStart: 140, top: 150, width: 860, opacity: 1 - 0.55 * dimAll, filter: dimAll > 0.02 ? `blur(${dimAll * 3}px)` : undefined}}>
        <ChatHeader
          at={0}
          name={p.customer}
          sub={t.customerOf.replace(/^[^·]+·/, (lang === 'he' ? 'לקוח ·' : 'Customer ·'))}
          live
          meta={
            <div style={{display: 'flex', alignItems: 'baseline', gap: 10}}>
              <Ltr style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 30, color: frame >= q.reply ? C.warm : C.text, fontVariantNumeric: 'tabular-nums'}}>{count}</Ltr>
              <Mono size={13} color={C.faint}>{p.messages}</Mono>
            </div>
          }
        />
        <Thread items={items} height={800} width={860} size={38} maxWidth={740} fade={220} />
      </div>

      <div style={{position: 'absolute', insetInlineStart: 1110, top: 230, opacity: 1 - 0.92 * dimAll, filter: dimAll > 0.02 ? `blur(${dimAll * 4}px)` : undefined}}>
        <RouteTrack at={q.track} checkedAt={q.checked} courierAt={q.courier} etaAt={q.eta} width={680} />
      </div>

      <div style={{position: 'absolute', insetInlineStart: 1090, top: 620, width: 760, display: 'flex', flexDirection: 'column', gap: 0}}>
        <Headline text={p.t1} at={q.t1} size={lang === 'he' ? 104 : 96} weight={300} color={C.dim} justify="flex-start" maxWidth={760} stagger={4} />
        <Headline text={p.t2} at={q.t2} size={lang === 'he' ? 104 : 96} weight={600} justify="flex-start" maxWidth={760} stagger={4} />
      </div>
    </SceneRoot>
  );
};
