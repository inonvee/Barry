import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C, FONT} from '../theme';
import {EASE, clamp, prog, systemPulse} from '../motion';
import {Enter, Label, Mixed, Mono} from './base';
import {Glyph} from './system';
import {useLang} from '../lang';

/* The human side of the film is deliberately ordinary: real messaging grammar — time inside the bubble,
   read ticks, typing, bursts, messages pushing each other up. Barry's bubble is always the warm-white one. */

export type Who = 'customer' | 'barry' | 'owner';

const Ticks: React.FC<{color: string}> = ({color}) => (
  <svg width="20" height="11" viewBox="0 0 22 12" fill="none">
    <path d="M1 6.5l3.2 3.2L10 2.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 8.4l1.3 1.3L15 2.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const bubbleStyle = (who: Who, side: 'start' | 'end', size: number, tail: boolean): React.CSSProperties => {
  const r = size * 0.78;
  const tr = tail ? 8 : r;
  const radius = side === 'end' ? `${r}px ${r}px ${tr}px ${r}px` : `${r}px ${r}px ${r}px ${tr}px`;
  const base: React.CSSProperties = {padding: `${size * 0.42}px ${size * 0.62}px ${size * 0.34}px`, borderRadius: radius, fontSize: size, lineHeight: 1.3, position: 'relative'};
  if (who === 'barry') return {...base, background: C.text, color: '#0b0b0c', fontWeight: 500, boxShadow: '0 18px 60px rgba(244,217,174,0.10)'};
  if (who === 'owner') return {...base, background: 'rgba(244,217,174,0.12)', border: '1px solid rgba(244,217,174,0.30)', color: C.text, fontWeight: 400};
  return {...base, background: 'rgba(255,255,255,0.075)', border: `1px solid ${C.line}`, color: C.text, fontWeight: 400};
};

/** A message bubble with WhatsApp-like metadata tucked into its bottom corner. */
export const Bubble: React.FC<{who: Who; side: 'start' | 'end'; text?: string; children?: React.ReactNode; time?: string; ticks?: boolean; size?: number; maxWidth?: number; tail?: boolean}> = ({
  who, side, text, children, time, ticks, size = 34, maxWidth = 720, tail = true,
}) => {
  const metaColor = who === 'barry' ? 'rgba(11,11,12,0.45)' : C.faint;
  return (
    <div style={{...bubbleStyle(who, side, size, tail), maxWidth}}>
      {text !== undefined ? <Mixed text={text} /> : children}
      {(time || ticks) && (
        <span style={{display: 'inline-flex', alignItems: 'center', gap: 6, marginInlineStart: size * 0.5, float: 'inline-end' as never, marginTop: size * 0.42, marginBottom: -size * 0.12, verticalAlign: 'bottom'}}>
          {time && <Mono size={size * 0.4} color={metaColor} track={0.02}>{time}</Mono>}
          {ticks && <Ticks color={who === 'barry' ? '#3f8f69' : C.verify} />}
        </span>
      )}
    </div>
  );
};

export const TypingBubble: React.FC<{who?: Who; side: 'start' | 'end'; size?: number}> = ({who = 'barry', side, size = 34}) => {
  const frame = useCurrentFrame();
  const col = who === 'barry' ? C.warm : C.dim;
  return (
    <div style={{...bubbleStyle('customer', side, size, true), display: 'flex', gap: size * 0.26, padding: `${size * 0.62}px ${size * 0.66}px`}}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{width: size * 0.3, height: size * 0.3, borderRadius: '50%', background: col, opacity: 0.3 + 0.7 * systemPulse(frame, 22, -i * 5)}} />
      ))}
    </div>
  );
};

export type ThreadItem = {
  at: number;
  out?: number;
  kind: 'msg' | 'typing' | 'note' | 'label';
  who?: Who;
  side?: 'start' | 'end';
  text?: string;
  node?: React.ReactNode;
  time?: string;
  ticks?: boolean;
  tone?: 'ok' | 'hold' | 'faint';
  gap?: number; // space above; small for same-sender bursts
  dim?: number; // 0..1 — for history that has scrolled past
};

/** Grow-in row: the row's height eases open (grid 0fr→1fr), so earlier messages are pushed up smoothly. */
const Row: React.FC<{item: ThreadItem; size: number; maxWidth: number}> = ({item, size, maxWidth}) => {
  const frame = useCurrentFrame();
  const open = item.at <= -900 ? 1 : prog(frame, item.at - 1, 10, EASE.out);
  const close = item.out === undefined ? 0 : prog(frame, item.out, 7, EASE.inOut);
  const g = open * (1 - close);
  if (g <= 0.001) return null;
  const p = item.at <= -900 ? 1 : prog(frame, item.at, 14, EASE.out);
  const side = item.side ?? 'start';
  const gap = item.gap ?? size * 0.5;
  let content: React.ReactNode = null;
  if (item.kind === 'msg') content = item.node ? <Bubble who={item.who ?? 'customer'} side={side} size={size} maxWidth={maxWidth} time={item.time} ticks={item.ticks}>{item.node}</Bubble> : <Bubble who={item.who ?? 'customer'} side={side} text={item.text} size={size} maxWidth={maxWidth} time={item.time} ticks={item.ticks} />;
  if (item.kind === 'typing') content = <TypingBubble who={item.who} side={side} size={size} />;
  if (item.kind === 'label')
    content = (
      <div style={{display: 'flex', alignItems: 'center', gap: 10, paddingInline: 8}}>
        <span style={{width: 8, height: 8, borderRadius: '50%', background: C.warm, boxShadow: '0 0 12px rgba(244,217,174,0.9)'}} />
        <Label size={13} color={C.dim}>{item.text}</Label>
      </div>
    );
  if (item.kind === 'note') {
    const col = item.tone === 'hold' ? C.hold : item.tone === 'faint' ? C.faint : C.verify;
    content = (
      <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: `${size * 0.28}px ${size * 0.6}px`, borderRadius: 999, background: `${col}14`, border: `1px solid ${col}40`, color: col, fontSize: size * 0.66}}>
        {item.tone !== 'faint' && <Glyph name="check" size={size * 0.7} color={col} stroke={2} draw={prog(frame, item.at + 4, 12)} />}
        <Mixed text={item.text ?? ''} />
      </div>
    );
  }
  return (
    <div style={{display: 'grid', gridTemplateRows: `${g}fr`, flex: 'none'}}>
      <div style={{minHeight: 0, overflow: g < 0.999 ? 'hidden' : 'visible', display: 'flex', justifyContent: item.kind === 'note' ? 'center' : side === 'end' ? 'flex-end' : 'flex-start'}}>
        <div
          style={{
            paddingTop: gap,
            opacity: interpolate(p, [0, 0.5], [0, 1], clamp) * (1 - close) * (1 - (item.dim ?? 0) * 0.55),
            translate: `0 ${(1 - p) * 26}px`,
            scale: 0.965 + 0.035 * p,
            transformOrigin: side === 'end' ? 'right bottom' : 'left bottom',
            filter: p < 0.97 ? `blur(${(1 - p) * 6}px)` : undefined,
          }}
        >
          {content}
        </div>
      </div>
    </div>
  );
};

/** A bottom-anchored conversation. New rows push older ones up and out of the (masked) top edge. */
export const Thread: React.FC<{items: ThreadItem[]; height: number; width: number; size?: number; maxWidth?: number; fade?: number; style?: React.CSSProperties}> = ({
  items, height, width, size = 34, maxWidth = 720, fade = 140, style,
}) => (
  <div
    style={{
      width,
      height,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      overflow: 'hidden',
      WebkitMaskImage: `linear-gradient(to bottom, transparent 0px, black ${fade}px)`,
      maskImage: `linear-gradient(to bottom, transparent 0px, black ${fade}px)`,
      paddingBottom: 6,
      ...style,
    }}
  >
    {items.map((it, i) => (
      <Row key={i} item={it} size={size} maxWidth={maxWidth} />
    ))}
  </div>
);

/** Chat header: avatar initial, name, quiet sub-line, optional right-side meta. */
export const ChatHeader: React.FC<{at: number; name: string; sub: string; live?: boolean; meta?: React.ReactNode; barry?: boolean; width?: number}> = ({at, name, sub, live, meta, barry, width}) => (
  <Enter at={at} y={-10} blur={6} dur={24}>
    <div style={{display: 'flex', alignItems: 'center', gap: 18, paddingBottom: 22, borderBottom: `1px solid ${C.line}`, width}}>
      <div style={{width: 58, height: 58, borderRadius: '50%', border: `1px solid ${barry ? 'rgba(244,217,174,0.5)' : C.lineHi}`, display: 'grid', placeItems: 'center', background: barry ? 'rgba(244,217,174,0.1)' : C.surface, flex: 'none'}}>
        {barry ? <span style={{width: 12, height: 12, borderRadius: '50%', background: C.warm, boxShadow: '0 0 16px rgba(244,217,174,0.9)'}} /> : <span style={{fontWeight: 600, fontSize: 24}}>{name.slice(0, 1)}</span>}
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6, flex: 1}}>
        <span style={{fontSize: 28, fontWeight: 500, letterSpacing: '-0.01em'}}>{name}</span>
        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
          {live && <span style={{width: 8, height: 8, borderRadius: '50%', background: C.verify, boxShadow: '0 0 10px rgba(159,224,188,0.7)'}} />}
          <Label size={13} color={C.faint}>{sub}</Label>
        </div>
      </div>
      {meta}
    </div>
  </Enter>
);

/** A phone-style notification banner (no device, no hands — just the message arriving). */
export const Notification: React.FC<{at: number; name: string; text: string; time: string; barry?: boolean; out?: number; width?: number; dim?: number; children?: React.ReactNode}> = ({
  at, name, text, time, barry, out, width = 900, dim = 0, children,
}) => (
  <Enter at={at} out={out} y={-40} blur={10} dur={30} scale={0.97}>
    <div
      style={{
        width,
        padding: '26px 30px 28px',
        borderRadius: 34,
        background: 'linear-gradient(180deg, rgba(38,38,42,0.92), rgba(24,24,27,0.92))',
        border: `1px solid ${barry ? 'rgba(244,217,174,0.28)' : 'rgba(255,255,255,0.09)'}`,
        boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
        opacity: 1 - dim * 0.6,
        filter: dim > 0.02 ? `blur(${dim * 1.5}px)` : undefined,
        display: 'flex',
        gap: 22,
      }}
    >
      <div style={{width: 60, height: 60, borderRadius: 18, flex: 'none', display: 'grid', placeItems: 'center', background: barry ? 'rgba(244,217,174,0.12)' : 'rgba(255,255,255,0.08)', border: `1px solid ${barry ? 'rgba(244,217,174,0.4)' : C.line}`}}>
        {barry ? <span style={{width: 12, height: 12, borderRadius: '50%', background: C.warm, boxShadow: '0 0 16px rgba(244,217,174,0.9)'}} /> : <span style={{fontWeight: 600, fontSize: 26}}>{name.slice(0, 1)}</span>}
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'}}>
          <span style={{fontSize: 30, fontWeight: 600}}>{name}</span>
          <Mono size={15} color={C.faint} track={0.04}>{time}</Mono>
        </div>
        <span style={{fontSize: 36, lineHeight: 1.3, color: 'rgba(243,238,230,0.92)'}}><Mixed text={text} /></span>
        {children}
      </div>
    </div>
  </Enter>
);

/** Device silhouette for the owner's phone. Thin bezel, no branding, no hands. */
export const PhoneFrame: React.FC<{children: React.ReactNode; width?: number; height?: number; rotateY?: number; rotateX?: number}> = ({
  children, width = 470, height = 900, rotateY = 0, rotateX = 0,
}) => (
  <div style={{perspective: 2200}}>
    <div
      style={{
        width,
        height,
        borderRadius: 70,
        border: `2px solid rgba(243,238,230,0.20)`,
        background: 'linear-gradient(180deg, #0c0c0e 0%, #070708 100%)',
        boxShadow: '0 60px 160px rgba(0,0,0,0.7), 0 0 0 10px rgba(255,255,255,0.025), inset 0 0 60px rgba(244,217,174,0.03)',
        position: 'relative',
        transform: `rotateY(${rotateY}deg) rotateX(${rotateX}deg)`,
        transformStyle: 'preserve-3d',
        overflow: 'hidden',
      }}
    >
      <div style={{position: 'absolute', top: 22, left: '50%', translate: '-50% 0', width: 120, height: 34, borderRadius: 20, background: '#000', border: `1px solid ${C.line}`}} />
      <div style={{position: 'absolute', inset: 0, padding: '96px 30px 40px', display: 'flex', flexDirection: 'column'}}>{children}</div>
    </div>
  </div>
);

/** The day clock: a quiet corner chyron that rolls between scenes, with a 24h line filling as the day passes. */
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (((h * 60 + m - 7 * 60) % 1440) + 1440) % 1440;
};
const dayFrac = (t: string, prev?: string) => {
  let m = toMin(t);
  if (prev !== undefined && m < toMin(prev)) m += 1440; // next morning completes the line
  return Math.min(1, m / 1440);
};

const RollDigit: React.FC<{from: string; to: string; p: number; size: number}> = ({from, to, p, size}) => {
  if (from === to) return <span style={{display: 'inline-block', width: '0.62em', textAlign: 'center'}}>{to}</span>;
  return (
    <span style={{display: 'inline-block', width: '0.62em', height: size * 1.25, overflow: 'hidden', position: 'relative', verticalAlign: 'bottom'}}>
      <span style={{position: 'absolute', left: 0, right: 0, textAlign: 'center', translate: `0 ${-p * size * 1.25}px`, opacity: 1 - p}}>{from}</span>
      <span style={{position: 'absolute', left: 0, right: 0, textAlign: 'center', translate: `0 ${(1 - p) * size * 1.25}px`, opacity: p}}>{to}</span>
    </span>
  );
};

export const DayClock: React.FC<{clock?: {from?: string; time: string; roll?: {at: number; time: string}}; hideAt?: number}> = ({clock, hideAt}) => {
  const frame = useCurrentFrame();
  const {sx} = useLang();
  if (!clock) return null;
  const segs = [{at: 0, from: clock.from ?? clock.time, to: clock.time}];
  if (clock.roll) segs.push({at: clock.roll.at, from: clock.time, to: clock.roll.time});
  const seg = [...segs].reverse().find((s) => frame >= s.at) ?? segs[0];
  const size = 26;
  const chars = seg.to.split('');
  const fromChars = seg.from.split('');
  const fade = prog(frame, 0, 10) * (hideAt === undefined ? 1 : 1 - prog(frame, hideAt, 6));
  const rollP = (i: number) => prog(frame, seg.at + 2 + (chars.length - 1 - i) * 2, 12, EASE.inOut);
  const fracFrom = dayFrac(seg.from), fracTo = dayFrac(seg.to, seg.from === seg.to ? undefined : seg.from);
  const f = interpolate(prog(frame, seg.at + 2, 18, EASE.inOut), [0, 1], [fracFrom, fracTo < fracFrom ? 1 : fracTo]);
  const W = 170;
  return (
    <div style={{position: 'absolute', insetInlineStart: 84, top: 64, display: 'flex', flexDirection: 'column', gap: 12, opacity: fade, direction: 'ltr', alignItems: sx === 1 ? 'flex-start' : 'flex-end'}}>
      <span style={{fontFamily: FONT.mono, fontSize: size, color: C.text, letterSpacing: '0.04em', display: 'flex', lineHeight: 1.25}}>
        {chars.map((ch, i) => (
          <RollDigit key={i} from={fromChars[i] ?? ch} to={ch} p={rollP(i)} size={size} />
        ))}
      </span>
      <div style={{position: 'relative', width: W, height: 9}}>
        <div style={{position: 'absolute', left: 0, right: 0, top: 4, height: 1, background: C.ghost}} />
        <div style={{position: 'absolute', [sx === 1 ? 'left' : 'right']: 0, top: 4, height: 1, width: W * f, background: `linear-gradient(${sx === 1 ? 90 : 270}deg, rgba(244,217,174,0.1), ${C.warm})`}} />
        {[0, 0.25, 0.5, 0.75, 1].map((k) => (
          <div key={k} style={{position: 'absolute', [sx === 1 ? 'left' : 'right']: W * k, top: 2, width: 1, height: 5, background: C.ghost}} />
        ))}
        <div style={{position: 'absolute', [sx === 1 ? 'left' : 'right']: W * f - 4, top: 0, width: 9, height: 9, borderRadius: '50%', background: C.warm, boxShadow: '0 0 12px rgba(244,217,174,0.9)'}} />
      </div>
    </div>
  );
};
