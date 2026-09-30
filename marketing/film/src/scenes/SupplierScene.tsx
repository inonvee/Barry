import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, cameraPush, clamp, connectionTravel, prog, systemPulse} from '../motion';
import {CLOCK, Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Label, Mixed, Mono, SceneRoot} from '../ui/base';
import {DayClock, PhoneFrame, Thread, type ThreadItem} from '../ui/chat';
import {DemoTag, PurchaseOrder, SupplierCard} from '../ui/cards';
import {BarryCore, CapabilityNode, Glyph, SystemConnection} from '../ui/system';
import {Mixed as MixedText} from '../ui/base';

const CORE = {x: 960, y: 540};
const NODE_POS = [
  {x: 560, y: 250, g: 'box'},
  {x: 960, y: 150, g: 'chart'},
  {x: 1360, y: 190, g: 'receipt'},
  {x: 1690, y: 380, g: 'doc'},
  {x: 1720, y: 700, g: 'card'},
  {x: 1400, y: 900, g: 'calendar'},
  {x: 960, y: 940, g: 'shield'},
  {x: 540, y: 860, g: 'stack'},
  {x: 470, y: 560, g: 'factory'},
];
const edge = (from: {x: number; y: number}, r: number) => {
  const dx = CORE.x - from.x, dy = CORE.y - from.y, d = Math.hypot(dx, dy);
  return {x: CORE.x - (dx / d) * r, y: CORE.y - (dy / d) * r};
};

/** 0:32 — "No problem, boss." The hero: a casual message, and the whole business operating behind it. */
export const SupplierScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang, sx} = useLang();
  const q = Q.supplier;
  const s = t.supplier;

  const away = prog(frame, q.open, 30, EASE.inOut) * (1 - prog(frame, q.phoneBack, 28, EASE.inOut));
  const worldOut = prog(frame, q.phoneBack - 8, 22, EASE.inOut);
  const phoneX = interpolate(away, [0, 1], [960, mx(185)]);
  const push = cameraPush(frame, 0, 380, 1, 1.05);

  // core: ignites, holds big while thinking, contracts to a small hub between supplier cards
  const coreIn = prog(frame, q.core, 30);
  const coreShrink = prog(frame, q.converge, 26, EASE.inOut);
  const coreGone = prog(frame, q.po - 4, 14);
  const coreScale = (0.35 + 0.65 * coreIn) * (1 - 0.6 * coreShrink);
  const phrase = prog(frame, q.understand, 22);
  const phraseOut = prog(frame, q.converge - 8, 14);

  const nodesConverge = prog(frame, q.converge, 22, EASE.inOut);
  const selectP = prog(frame, q.select, 22);
  const aside = prog(frame, q.po, 24, EASE.inOut);
  const poP = prog(frame, q.po, 10);
  const inWorld = frame >= q.open && frame < q.phoneBack + 4;
  const cardA = {x: mx(610), y: 500};
  const cardB = {x: mx(1310), y: 500};
  const hub = CORE;
  const submitPulse = prog(frame, q.submitted, 26);
  const phoneItems: ThreadItem[] = [
    {kind: 'msg', who: 'owner', side: 'end', at: q.ownerMsg, text: s.ownerMsg, time: '21:16', ticks: true},
    {kind: 'typing', side: 'start', at: q.typing, out: q.barryReply - 1},
    {kind: 'msg', who: 'barry', side: 'start', at: q.barryReply, text: s.reply, time: '21:16'},
    {
      kind: 'msg', who: 'barry', side: 'start', at: q.done, time: '21:19',
      node: (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          <div style={{display: 'flex', alignItems: 'flex-start', gap: 10}}>
            <span style={{flex: 'none', paddingTop: 6}}><Glyph name="check" size={26} color="#0a0a0b" stroke={2.4} draw={prog(frame, q.done + 8, 14)} /></span>
            <span><MixedText text={s.done.l1} /></span>
          </div>
          <span style={{fontWeight: 700}}><MixedText text={s.done.l2} /></span>
        </div>
      ),
    },
  ];

  return (
    <SceneRoot backdrop={<Backdrop grid={0.55 * coreIn * (1 - worldOut)} bloom={0.5 + 0.5 * coreIn} bloomY={50} bloomSize={70} />}>
      <div style={{position: 'absolute', inset: 0, scale: push}}>
        {inWorld && (
          <div style={{position: 'absolute', inset: 0, opacity: 1 - worldOut, filter: worldOut > 0.02 ? `blur(${worldOut * 18}px)` : undefined}}>
            {/* faint orbital structure */}
            <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, opacity: coreIn * (1 - coreShrink) * 0.9}}>
              <ellipse cx={960} cy={540} rx={620} ry={370} fill="none" stroke={C.text} strokeOpacity={0.07} strokeDasharray="2 10" />
              <ellipse cx={960} cy={540} rx={420} ry={250} fill="none" stroke={C.text} strokeOpacity={0.05} />
            </svg>

            {/* nodes → core */}
            {NODE_POS.map((n, i) => {
              const at = q.nodeStart + i * q.nodeGap;
              const p = {x: mx(n.x), y: n.y};
              const target = edge(p, 150);
              return (
                <SystemConnection key={i} a={p} b={target} curve={i % 2 ? 36 : -36} draw={prog(frame, at + 6, 26, EASE.inOut) * (1 - nodesConverge)} travel={connectionTravel(frame, at + 18, 30)} opacity={0.26 * (1 - nodesConverge)} />
              );
            })}
            {NODE_POS.map((n, i) => {
              const at = q.nodeStart + i * q.nodeGap;
              const home = {x: mx(n.x), y: n.y};
              const dx = (CORE.x - home.x) * nodesConverge, dy = (CORE.y - home.y) * nodesConverge;
              const lit = prog(frame, at + 22, 16);
              return (
                <div key={i} style={{position: 'absolute', left: 0, top: 0, translate: `${dx}px ${dy}px`, scale: 1 - nodesConverge * 0.8, opacity: 1 - nodesConverge}}>
                  <CapabilityNode x={home.x} y={home.y} glyph={n.g} label={s.nodes[i].label} value={s.nodes[i].value} at={at} size={76} active={lit} />
                </div>
              );
            })}

            {/* the core */}
            <div style={{position: 'absolute', left: CORE.x - 150, top: CORE.y - 150, scale: coreScale, opacity: coreIn * (1 - coreGone)}}>
              <BarryCore size={300} energy={1} pulsePeriod={80} />
            </div>

            {/* "the usual" — understood from business context */}
            <div style={{position: 'absolute', left: 0, right: 0, top: CORE.y - 100, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, opacity: phrase * (1 - phraseOut), filter: phraseOut > 0.02 ? `blur(${phraseOut * 10}px)` : undefined}}>
              <span style={{fontSize: lang === 'he' ? 92 : 76, fontWeight: 300, letterSpacing: '-0.02em', lineHeight: 1.1, textShadow: '0 0 60px rgba(0,0,0,0.9), 0 0 30px rgba(0,0,0,0.9)'}}>
                <span style={{color: C.warm}}>“</span>{s.usual}<span style={{color: C.warm}}>”</span>
              </span>
              <div style={{opacity: prog(frame, q.understand + 12, 18), textShadow: '0 0 20px #000'}}>
                <Label size={15} color={C.dim}>{s.understood}</Label>
              </div>
            </div>

            {/* suppliers */}
            <div style={{position: 'absolute', inset: 0}}>
              <SystemConnection a={{x: mx(860), y: 520}} b={{x: hub.x + 36 * sx * -1, y: hub.y}} curve={-24} draw={prog(frame, q.suppliers + 14, 24, EASE.inOut) * (1 - aside)} travel={connectionTravel(frame, q.select, 24)} opacity={0.14 + 0.36 * selectP} />
              <SystemConnection a={{x: mx(1060), y: 520}} b={{x: hub.x + 36 * sx, y: hub.y}} curve={24} draw={prog(frame, q.suppliers + 14, 24, EASE.inOut) * (1 - aside)} opacity={0.25 * (1 - selectP * 0.7)} />
              <div style={{position: 'absolute', left: cardA.x - 250, top: cardA.y - 220, translate: `${aside * 250 * sx}px 0`, scale: 1 - aside * 0.3, opacity: 1 - aside, filter: aside > 0.02 ? `blur(${aside * 3}px)` : undefined}}>
                <SupplierCard at={q.suppliers} name={s.supA.name} tag={s.supA.tag} units={s.supA.units} price={s.supA.price} eta={s.supA.eta} chosen select={selectP} />
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 18px', marginTop: 26, width: 470}}>
                  {s.reasons.map((r, i) => (
                    <Enter key={i} at={q.reasonStart + i * q.reasonGap} y={10} blur={6} dur={18}>
                      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                        <Glyph name="check" size={22} color={C.verify} stroke={2.2} draw={prog(frame, q.reasonStart + i * q.reasonGap + 4, 10)} />
                        <span style={{fontSize: 22, color: C.dim}}><MixedText text={r} /></span>
                      </div>
                    </Enter>
                  ))}
                </div>
              </div>
              <div style={{position: 'absolute', left: cardB.x - 250, top: cardB.y - 220, opacity: 1 - Math.min(1, aside * 1.6), translate: `${aside * -120 * sx}px 0`}}>
                <SupplierCard at={q.suppliers + 8} name={s.supB.name} tag={s.supB.tag} units={s.supB.units} price={s.supB.price} eta={s.supB.eta} dim={selectP} />
              </div>
            </div>

            {/* purchase order */}
            {frame >= q.po - 1 && (
              <div style={{position: 'absolute', left: 960 - 310, top: 300}}>
                <PurchaseOrder at={q.po} supplier={`${s.supA.name} · ${s.supA.price}`} authAt={q.authOK} submitAt={q.submitted} etaAt={q.eta} />
                {submitPulse > 0 && submitPulse < 1 && (
                  <div style={{position: 'absolute', left: 310, top: 240, width: 620 + submitPulse * 300, height: 480 + submitPulse * 240, translate: '-50% -50%', borderRadius: 28 + submitPulse * 40, border: `1px solid ${C.warm}`, opacity: (1 - submitPulse) * 0.7}} />
                )}
              </div>
            )}
          </div>
        )}

        {/* the owner's phone */}
        <div style={{position: 'absolute', left: phoneX - 235, top: 90, scale: 1 - 0.46 * away, opacity: 1 - 0.5 * away, filter: away > 0.02 ? `blur(${away * 2.5}px)` : undefined, transformOrigin: 'center center'}}>
          <Enter at={q.phoneIn} y={40} blur={16} dur={40} scale={0.94}>
            <PhoneFrame rotateY={-9 * sx * (1 - away * 0.6)} rotateX={3}>
              <div style={{display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 18, borderBottom: `1px solid ${C.line}`}}>
                <span style={{width: 40, height: 40, borderRadius: '50%', border: '1px solid rgba(244,217,174,0.5)', background: 'rgba(244,217,174,0.1)', display: 'grid', placeItems: 'center'}}>
                  <span style={{width: 9, height: 9, borderRadius: '50%', background: C.warm, boxShadow: '0 0 12px rgba(244,217,174,0.9)'}} />
                </span>
                <span style={{fontSize: 24, fontWeight: 500}}>{t.barry}</span>
              </div>
              <Thread items={phoneItems} height={700} width={410} size={27} maxWidth={330} fade={30} />
            </PhoneFrame>
          </Enter>
        </div>
      </div>
      <DemoTag at={30} />
      <DayClock clock={CLOCK.supplier} />
    </SceneRoot>
  );
};
