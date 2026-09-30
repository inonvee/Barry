import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, FONT} from '../theme';
import {systemPulse} from '../motion';
import {Enter, Label, Mixed, Mono} from './base';
import {useLang} from '../lang';

const BUBBLE_FONT = 36;

const Ticks: React.FC<{color: string}> = ({color}) => (
  <svg width="22" height="12" viewBox="0 0 22 12" fill="none" style={{opacity: 0.9}}>
    <path d="M1 6.5l3.2 3.2L10 2.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 8.4l1.3 1.3L15 2.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type MsgProps = {at: number; text?: string; out?: number; time?: string; maxWidth?: number; children?: React.ReactNode; showTicks?: boolean; size?: number};

/** The person on the other side of the conversation. Sits at the reading-start edge. */
export const CustomerMessage: React.FC<MsgProps> = ({at, text, out, time, maxWidth = 720, children, size = BUBBLE_FONT}) => (
  <Enter at={at} out={out} y={28} x={-16} blur={10} scale={0.97} style={{alignSelf: 'flex-start'}}>
    <div style={{display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start'}}>
      <div
        style={{
          maxWidth,
          padding: '26px 36px 28px',
          borderRadius: '34px 34px 34px 10px',
          background: 'rgba(255,255,255,0.07)',
          border: `1px solid ${C.line}`,
          fontSize: size,
          lineHeight: 1.32,
          fontWeight: 400,
          color: C.text,
          backdropFilter: 'blur(8px)',
        }}
      >
        {text ? <Mixed text={text} /> : children}
      </div>
      {time && <Mono size={12} color={C.faint} style={{marginInlineStart: 14}}>{time}</Mono>}
    </div>
  </Enter>
);

/** Barry's voice: solid warm-white — the only high-key object in a dark frame. */
export const BarryMessage: React.FC<MsgProps & {label?: string; dark?: boolean}> = ({at, text, out, time, maxWidth = 720, children, showTicks, size = BUBBLE_FONT, label}) => (
  <Enter at={at} out={out} y={28} x={16} blur={10} scale={0.97} style={{alignSelf: 'flex-end'}}>
    <div style={{display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end'}}>
      {label && (
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginInlineEnd: 6}}>
          <span style={{width: 8, height: 8, borderRadius: '50%', background: C.warm, boxShadow: '0 0 14px rgba(244,217,174,0.9)'}} />
          <Label size={13} color={C.dim}>{label}</Label>
        </div>
      )}
      <div
        style={{
          maxWidth,
          padding: '26px 36px 28px',
          borderRadius: '34px 34px 10px 34px',
          background: C.text,
          color: '#0a0a0b',
          fontSize: size,
          lineHeight: 1.32,
          fontWeight: 500,
          boxShadow: '0 20px 80px rgba(244,217,174,0.12), 0 0 0 1px rgba(255,255,255,0.4) inset',
        }}
      >
        {text ? <Mixed text={text} /> : children}
      </div>
      {(time || showTicks) && (
        <div style={{display: 'flex', gap: 8, alignItems: 'center', marginInlineEnd: 14}}>
          {time && <Mono size={12} color={C.faint}>{time}</Mono>}
          {showTicks && <Ticks color={C.warm} />}
        </div>
      )}
    </div>
  </Enter>
);

export const TypingDots: React.FC<{at: number; out: number}> = ({at, out}) => {
  const frame = useCurrentFrame();
  return (
    <Enter at={at} out={out} outDur={6} y={14} blur={4} dur={18} style={{alignSelf: 'flex-end'}}>
      <div style={{display: 'flex', gap: 10, padding: '24px 30px', borderRadius: '34px 34px 10px 34px', background: 'rgba(243,238,230,0.10)', border: `1px solid ${C.lineHi}`}}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{width: 11, height: 11, borderRadius: '50%', background: C.warm, opacity: 0.35 + 0.65 * systemPulse(frame, 24, -i * 5)}} />
        ))}
      </div>
    </Enter>
  );
};

export const ChatHeader: React.FC<{at: number; out?: number}> = ({at, out}) => {
  const {t} = useLang();
  return (
    <Enter at={at} out={out} y={-14} blur={6}>
      <div style={{display: 'flex', alignItems: 'center', gap: 18, paddingBottom: 26, borderBottom: `1px solid ${C.line}`}}>
        <div style={{width: 64, height: 64, borderRadius: '50%', border: `1px solid ${C.lineHi}`, display: 'grid', placeItems: 'center', background: C.surface}}>
          <span style={{fontFamily: FONT.sans, fontWeight: 600, fontSize: 26, letterSpacing: '0.02em'}}>O</span>
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          <span style={{fontSize: 32, fontWeight: 500, letterSpacing: '-0.01em'}}>{t.chat.store}</span>
          <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <span style={{width: 8, height: 8, borderRadius: '50%', background: C.verify, boxShadow: '0 0 10px rgba(159,224,188,0.7)'}} />
            <Label size={15} color={C.dim}>{t.chat.status}</Label>
          </div>
        </div>
      </div>
    </Enter>
  );
};

/** Owner speaking to Barry: a quiet editorial line, no bubble. */
export const OwnerQuery: React.FC<{at: number; text: string; out?: number; label: string; size?: number}> = ({at, text, out, label, size = 46}) => (
  <Enter at={at} out={out} y={18} blur={10}>
    <div style={{display: 'flex', flexDirection: 'column', gap: 14, paddingInlineStart: 26, borderInlineStart: `2px solid ${C.lineHi}`}}>
      <Label size={13} color={C.faint}>{label}</Label>
      <span style={{fontSize: size, fontWeight: 300, letterSpacing: '-0.015em', lineHeight: 1.2}}>
        <Mixed text={text} />
      </span>
    </div>
  </Enter>
);

/** Device silhouette for the owner's phone. Thin bezel, no branding. */
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
      <div style={{position: 'absolute', inset: 0, padding: '96px 34px 40px', display: 'flex', flexDirection: 'column', gap: 22}}>{children}</div>
    </div>
  </div>
);

/** Compact bubble for use inside the owner's phone. Owner = warm outline, Barry = solid warm-white. */
export const PhoneBubble: React.FC<{who: 'owner' | 'barry'; at: number; children: React.ReactNode; out?: number}> = ({who, at, children, out}) => (
  <Enter at={at} out={out} y={24} blur={8} scale={0.97} style={{alignSelf: who === 'owner' ? 'flex-end' : 'flex-start'}}>
    <div
      style={{
        padding: '18px 24px 20px',
        borderRadius: who === 'owner' ? '28px 28px 8px 28px' : '28px 28px 28px 8px',
        background: who === 'owner' ? 'rgba(244,217,174,0.13)' : C.text,
        border: who === 'owner' ? '1px solid rgba(244,217,174,0.34)' : 'none',
        color: who === 'owner' ? C.text : '#0a0a0b',
        fontSize: 30,
        lineHeight: 1.3,
        fontWeight: who === 'owner' ? 400 : 500,
        maxWidth: 330,
        boxShadow: who === 'barry' ? '0 12px 50px rgba(244,217,174,0.12)' : 'none',
      }}
    >
      {children}
    </div>
  </Enter>
);
