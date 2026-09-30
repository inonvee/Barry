import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C, FONT} from '../theme';
import {EASE, clamp, prog, systemPulse} from '../motion';
import {Enter, Label, Mixed, Mono} from './base';

/* ---------- Glyphs: one consistent 1.5px line-icon family ---------- */
const PATHS: Record<string, string[]> = {
  message: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4V16h0A1.5 1.5 0 0 1 4 14.5z'],
  calendar: ['M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  box: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  card: ['M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6z', 'M3 10h18', 'M7 15h4'],
  support: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M6.3 6.3l3.6 3.6', 'M14.1 14.1l3.6 3.6', 'M17.7 6.3l-3.6 3.6', 'M9.9 14.1l-3.6 3.6'],
  truck: ['M3 7h11v9H3z', 'M14 10h4l3 3v3h-7z', 'M7 16.5a1.6 1.6 0 1 0 0 .01', 'M17 16.5a1.6 1.6 0 1 0 0 .01'],
  shield: ['M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z', 'M9 12l2.2 2.2L15.5 10'],
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
  chart: ['M4 19h16', 'M7 16v-5', 'M12 16V7', 'M17 16v-8'],
  person: ['M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M5 20c0-4 3-6 7-6s7 2 7 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  stack: ['M12 4l9 4.5-9 4.5L3 8.5z', 'M3 12.5l9 4.5 9-4.5', 'M3 16.5l9 4.5 9-4.5'],
  mail: ['M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6z', 'M3.5 7l8.5 6 8.5-6'],
  doc: ['M7 3h7l4 4v14H7z', 'M14 3v4h4', 'M10 12h5', 'M10 16h5'],
  store: ['M4 9l1.5-5h13L20 9', 'M4 9h16v1.5a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0 2.7 2.7 0 0 1-5.3 0z', 'M5.5 12v8h13v-8', 'M10 20v-5h4v5'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  factory: ['M3 20V10l5 3v-3l5 3V6h8v14z', 'M3 20h18'],
};

export const Glyph: React.FC<{name: keyof typeof PATHS | string; size?: number; color?: string; draw?: number; stroke?: number}> = ({
  name, size = 28, color = C.text, draw = 1, stroke = 1.5,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{overflow: 'visible'}}>
    {(PATHS[name] ?? []).map((d, i) => (
      <path
        key={i}
        d={d}
        pathLength={1}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={1}
        strokeDashoffset={1 - draw}
      />
    ))}
  </svg>
);

/* ---------- BarryCore: the system mark. Not a mascot — a quiet instrument. ---------- */
export const BarryCore: React.FC<{size?: number; energy?: number; pulsePeriod?: number; intensity?: number}> = ({
  size = 240, energy = 1, pulsePeriod = 96, intensity = 1,
}) => {
  const frame = useCurrentFrame();
  const breathe = systemPulse(frame, pulsePeriod);
  const ringT = (frame % pulsePeriod) / pulsePeriod;
  const ticks = (n: number, r: number, len: number, o: number) =>
    Array.from({length: n}, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return (
        <line
          key={i}
          x1={Math.cos(a) * (r - len)}
          y1={Math.sin(a) * (r - len)}
          x2={Math.cos(a) * r}
          y2={Math.sin(a) * r}
          stroke={C.text}
          strokeOpacity={o * (i % 5 === 0 ? 1 : 0.45)}
          strokeWidth={i % 5 === 0 ? 1.4 : 0.8}
        />
      );
    });
  return (
    <div style={{width: size, height: size, position: 'relative', opacity: intensity}}>
      <div
        style={{
          position: 'absolute',
          inset: -size * 0.9,
          background: `radial-gradient(circle, rgba(244,217,174,${0.2 * energy * (0.7 + 0.3 * breathe)}) 0%, rgba(244,217,174,${0.05 * energy}) 34%, transparent 62%)`,
        }}
      />
      <svg width={size} height={size} viewBox="-110 -110 220 220" style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
        <g style={{transform: `rotate(${frame * 0.12}deg)`}}>{ticks(60, 100, 6, 0.5 * energy)}</g>
        <g style={{transform: `rotate(${-frame * 0.2}deg)`}}>
          <circle r={72} fill="none" stroke={C.text} strokeOpacity={0.22 * energy} strokeWidth={0.8} strokeDasharray="2 7" />
        </g>
        <circle r={48} fill="none" stroke={C.warm} strokeOpacity={0.55 * energy} strokeWidth={1} />
        <circle r={28 + 4 * breathe} fill="none" stroke={C.warm} strokeOpacity={0.28 * energy} strokeWidth={0.8} />
        <circle r={10 + ringT * 96} fill="none" stroke={C.warm} strokeOpacity={(1 - ringT) * 0.35 * energy} strokeWidth={0.8} />
        <circle r={7 + breathe * 1.2} fill={C.warm} fillOpacity={energy} style={{filter: `drop-shadow(0 0 ${10 + 10 * breathe}px rgba(244,217,174,0.9))`}} />
      </svg>
    </div>
  );
};

/* ---------- Status ---------- */
export type Status = 'idle' | 'working' | 'ok' | 'hold' | 'alert';
const statusColor = (s: Status) => (s === 'ok' ? C.verify : s === 'hold' ? C.hold : s === 'alert' ? C.alert : s === 'working' ? C.warm : C.faint);

export const StatusIndicator: React.FC<{status: Status; size?: number}> = ({status, size = 12}) => {
  const frame = useCurrentFrame();
  const col = statusColor(status);
  const pulse = status === 'working' ? systemPulse(frame, 28) : 0;
  return (
    <span style={{position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none'}}>
      {status === 'working' && (
        <span style={{position: 'absolute', inset: -size * 0.5, borderRadius: '50%', border: `1px solid ${col}`, opacity: 0.6 * (1 - pulse), scale: 0.6 + pulse * 0.6}} />
      )}
      <span style={{position: 'absolute', inset: 0, borderRadius: '50%', background: col, boxShadow: status === 'idle' ? 'none' : `0 0 ${size}px ${col}66`, opacity: status === 'working' ? 0.6 + 0.4 * pulse : 1}} />
    </span>
  );
};

export const VerificationChip: React.FC<{at: number; label: string; tone?: 'ok' | 'hold' | 'alert' | 'potential'; size?: number}> = ({
  at, label, tone = 'ok', size = 15,
}) => {
  const frame = useCurrentFrame();
  const col = tone === 'ok' ? C.verify : tone === 'hold' ? C.hold : tone === 'alert' ? C.alert : C.warm;
  const p = prog(frame, at, 16);
  const d = prog(frame, at + 4, 14);
  if (frame < at) return <span style={{display: 'inline-block', height: size * 1.9}} />;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size * 0.5,
        padding: `${size * 0.35}px ${size * 0.8}px`,
        borderRadius: 999,
        border: `1px ${tone === 'potential' ? 'dashed' : 'solid'} ${col}55`,
        background: `${col}12`,
        color: col,
        opacity: p,
        scale: 0.94 + 0.06 * p,
      }}
    >
      {tone === 'ok' ? <Glyph name="check" size={size * 1.1} color={col} draw={d} stroke={2} /> : <StatusIndicator status={tone === 'potential' ? 'idle' : tone} size={size * 0.55} />}
      <Label size={size} color={col}>{label}</Label>
    </span>
  );
};

/* ---------- Connections ---------- */
export type Pt = {x: number; y: number};
const mid = (a: Pt, b: Pt, curve: number): Pt => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {x: (a.x + b.x) / 2 - (dy / len) * curve, y: (a.y + b.y) / 2 + (dx / len) * curve};
};
export const bezierAt = (a: Pt, b: Pt, curve: number, t: number): Pt => {
  const c = mid(a, b, curve);
  const u = 1 - t;
  return {x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y};
};

/** A thin operational line that draws itself, then optionally carries a travelling light. Absolute, stage coords. */
export const SystemConnection: React.FC<{
  a: Pt; b: Pt; curve?: number; draw?: number; travel?: number; color?: string; opacity?: number; dashed?: boolean; width?: number;
}> = ({a, b, curve = 0, draw = 1, travel, color = C.text, opacity = 0.22, dashed, width = 1}) => {
  const c = mid(a, b, curve);
  const d = `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  const head = travel !== undefined && travel > 0 && travel < 1 ? bezierAt(a, b, curve, travel) : null;
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none'}}>
      <path d={d} fill="none" stroke={color} strokeOpacity={opacity} strokeWidth={width} pathLength={1} strokeDasharray={dashed ? '0.008 0.012' : 1} strokeDashoffset={dashed ? 0 : 1 - draw} style={dashed ? {clipPath: undefined} : undefined} />
      {travel !== undefined && travel > 0 && travel < 1 && (
        <>
          <path d={d} fill="none" stroke={C.warm} strokeOpacity={0.9} strokeWidth={width + 1} pathLength={1} strokeLinecap="round" strokeDasharray="0.07 2" strokeDashoffset={-(travel - 0.07)} style={{filter: 'drop-shadow(0 0 6px rgba(244,217,174,0.9))'}} />
          {head && <circle cx={head.x} cy={head.y} r={3.5} fill={C.warm} style={{filter: 'drop-shadow(0 0 8px rgba(244,217,174,1))'}} />}
        </>
      )}
    </svg>
  );
};

/* ---------- Capability node (montage / operating world) ---------- */
export const CapabilityNode: React.FC<{
  x: number; y: number; glyph: string; label?: string; value?: string; at: number; size?: number; active?: number; align?: 'start' | 'center';
}> = ({x, y, glyph, label, value, at, size = 64, active = 0, align = 'center'}) => {
  const frame = useCurrentFrame();
  const d = prog(frame, at + 6, 24);
  return (
    <div style={{position: 'absolute', left: x, top: y, translate: '-50% -50%'}}>
      <Enter at={at} dur={30} y={10} blur={8}>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: align === 'center' ? 'center' : 'flex-start', gap: 12}}>
          <div
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              border: `1px solid ${active > 0 ? C.warm + 'aa' : C.lineHi}`,
              background: active > 0 ? 'rgba(244,217,174,0.10)' : C.surface,
              display: 'grid',
              placeItems: 'center',
              boxShadow: active > 0 ? `0 0 ${34 * active}px rgba(244,217,174,${0.35 * active})` : 'none',
            }}
          >
            <Glyph name={glyph} size={size * 0.42} color={active > 0 ? C.warm : C.dim} draw={d} />
          </div>
          {label && (
            <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, whiteSpace: 'nowrap'}}>
              <Label size={13} color={C.dim}>{label}</Label>
              {value && (
                <span style={{fontSize: 19, color: C.text, fontWeight: 500}}>
                  <Mixed text={value} />
                </span>
              )}
            </div>
          )}
        </div>
      </Enter>
    </div>
  );
};

/** Tiny ambient system readout, e.g. "AUTHORITY · ALLOWED". */
export const SystemTag: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = C.faint}) => (
  <Mono size={13} color={color} style={{fontFamily: FONT.mono}}>{children}</Mono>
);
