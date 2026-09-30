import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, cameraPush, connectionTravel, prog} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Ltr, Mixed, SceneRoot} from '../ui/base';
import {ChatHeader, DayClock, Thread, type ThreadItem} from '../ui/chat';
import {DemoTag, LedgerRow, SystemFact} from '../ui/cards';
import {BarryCore, Glyph, SystemConnection} from '../ui/system';

const COL = {w: 900, top: 150, threadH: 660};
const HOMES = [
  {x: 330, y: 300},
  {x: 1590, y: 290},
  {x: 250, y: 560},
  {x: 1670, y: 560},
  {x: 420, y: 830},
  {x: 1500, y: 830},
];

/** 10:26 → 10:28 — An ordinary message. An extraordinary amount of checking behind it. Then Barry closes. */
export const DressScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang} = useLang();
  const q = Q.dress;
  const d = t.dress;

  const pull = prog(frame, q.pull, 30, EASE.inOut);
  const collapse = prog(frame, q.collapse, 26, EASE.inOut);
  const cam = pull * (1 - collapse);
  const shift = prog(frame, q.shift, 30, EASE.inOut);
  const push = cameraPush(frame, 0, 190, 1, 1.03);
  const chatScale = (1 - 0.45 * cam) * (shift > 0 ? 1 : push);

  // chat column: centred, then slides to the reading-start side to make room for the operation
  const colLeftLTR = interpolate(shift, [0, 1], [(1920 - COL.w) / 2, 140]);
  const colX = mx(colLeftLTR + COL.w / 2) - COL.w / 2;
  // Barry's answer sits at the bottom, end side of the thread — the anchor for the reveal
  const bubbleLTR = {x: (1920 - COL.w) / 2 + COL.w - 230, y: COL.top + 96 + COL.threadH - 60};
  const anchor = {x: 960 + (mx(bubbleLTR.x) - 960) * chatScale, y: 540 + (bubbleLTR.y - 540) * chatScale};

  const items: ThreadItem[] = [
    {kind: 'msg', who: 'customer', side: 'start', at: q.c1, text: d.c1, time: '10:26'},
    {kind: 'typing', side: 'end', at: q.typing, out: q.b1 - 1},
    {kind: 'label', side: 'end', at: q.b1, text: t.barry, gap: 26},
    {kind: 'msg', who: 'barry', side: 'end', at: q.b1, text: d.b1, time: '10:26', ticks: true, gap: 10},
    {kind: 'msg', who: 'customer', side: 'start', at: q.c2, text: d.c2, time: '10:28'},
    {kind: 'typing', side: 'end', at: q.typing2, out: q.b2 - 1},
    {kind: 'msg', who: 'barry', side: 'end', at: q.b2, text: d.b2, time: '10:28', ticks: true},
    {
      kind: 'msg', who: 'barry', side: 'end', at: q.link, gap: 8, time: '10:28', ticks: true,
      node: (
        <div style={{display: 'flex', flexDirection: 'column', gap: 10, minWidth: 460}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px', borderRadius: 16, background: 'rgba(10,10,11,0.07)', border: '1px solid rgba(10,10,11,0.12)'}}>
            <div style={{width: 58, height: 58, borderRadius: 12, background: '#0b0b0c', display: 'grid', placeItems: 'center', flex: 'none'}}>
              <Glyph name="card" size={30} color={C.warm} />
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 4, flex: 1}}>
              <span style={{fontSize: 26, fontWeight: 600}}><Mixed text={d.link.title} /></span>
              <span style={{fontSize: 22, opacity: 0.6}}><Mixed text={d.link.sub} /></span>
            </div>
            <Ltr style={{fontSize: 30, fontWeight: 600}}>{d.link.price}</Ltr>
          </div>
        </div>
      ),
    },
    {kind: 'note', at: q.paid, text: d.paid, tone: 'ok', gap: 22},
  ];

  return (
    <SceneRoot backdrop={<Backdrop grid={0.5 * cam + 0.25 * shift} bloom={0.5 + 0.4 * cam} bloomX={shift > 0 ? (lang === 'he' ? 30 : 70) : 50} bloomY={55} bloomSize={62} />}>
      <DayClock clock={CLOCK.dress} />

      {/* the system mark wakes behind the answer as the camera pulls back */}
      <div style={{position: 'absolute', left: anchor.x - 210, top: anchor.y - 210, opacity: cam * 0.9}}>
        <BarryCore size={420} energy={0.8} />
      </div>
      {HOMES.map((h, i) => {
        const at = q.factStart + i * q.factGap;
        return (
          <SystemConnection key={i} a={anchor} b={{x: mx(h.x), y: h.y}} curve={i % 2 ? 60 : -60} draw={prog(frame, at + 4, 24, EASE.inOut) * (1 - collapse)} travel={connectionTravel(frame, q.verify + i * 5, 24)} opacity={0.3 * (1 - collapse)} />
        );
      })}

      {/* the conversation */}
      <div
        style={{
          position: 'absolute',
          left: colX,
          top: COL.top,
          width: COL.w,
          scale: chatScale,
          transformOrigin: `${960 - colX}px ${540 - COL.top}px`,
          opacity: 1 - 0.12 * cam,
          filter: cam > 0.05 ? `blur(${cam * 1.2}px)` : undefined,
        }}
      >
        <ChatHeader at={q.header} name={d.customer} sub={t.customerOf} live />
        <Thread items={items} height={COL.threadH} width={COL.w} size={36} maxWidth={740} />
      </div>

      {/* what Barry checked before answering */}
      {d.facts.map((f, i) => {
        const at = q.factStart + i * q.factGap;
        const home = {x: mx(HOMES[i].x), y: HOMES[i].y};
        const dx = (anchor.x - home.x) * collapse, dy = (anchor.y - home.y) * collapse;
        return (
          <div key={i} style={{position: 'absolute', left: home.x - 165, top: home.y - 60, translate: `${dx}px ${dy}px`, scale: 1 - collapse * 0.75, opacity: 1 - collapse * 1.15, filter: collapse > 0.05 ? `blur(${collapse * 8}px)` : undefined}}>
            <Enter at={at} y={30} blur={16} dur={32} scale={0.9}>
              <SystemFact label={f.label} value={f.value} tickAt={q.verify + i * 5} strong={i === 5} />
            </Enter>
          </div>
        );
      })}

      {/* the close, underneath the conversation */}
      {frame >= q.rowStart - 2 && (
        <div style={{position: 'absolute', insetInlineStart: 1140, top: 250, width: 640}}>
          <div style={{position: 'absolute', insetInlineStart: -34, top: 20, width: 1, height: 520 * prog(frame, q.rowStart, 90, EASE.inOut), background: `linear-gradient(180deg, ${C.warm}, ${C.warm}00)`, opacity: 0.55}} />
          <LedgerRow at={q.rowStart} label={d.ledger[0].label} value={d.ledger[0].value} />
          <LedgerRow at={q.rowStart + q.rowGap} label={d.ledger[1].label} value={d.ledger[1].value} big />
          <LedgerRow at={q.rowStart + 2 * q.rowGap} label={d.ledger[2].label} value={d.ledger[2].value} />
          <LedgerRow at={q.link} label={d.ledger[3].label} value={d.ledger[3].value} workingLabel={d.paymentCreated} doneAt={q.payDone} tone="warm" />
          <LedgerRow at={q.order} label={d.ledger[4].label} value={d.ledger[4].value} big />
        </div>
      )}
      {frame >= q.rowStart && <DemoTag at={q.rowStart} />}
    </SceneRoot>
  );
};
