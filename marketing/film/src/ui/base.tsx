import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT, H, W} from '../theme';
import {useLang} from '../lang';
import {EASE, clamp, enterImpact, enterSoft, exitSoft, prog} from '../motion';

const NOISE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

/** Atmosphere: vignette, optional warm bloom, hairline grid, film grain. Always present, rarely loud. */
export const Backdrop: React.FC<{
  grid?: number;
  bloom?: number;
  bloomX?: number;
  bloomY?: number;
  bloomSize?: number;
}> = ({grid = 0, bloom = 0, bloomX = 50, bloomY = 50, bloomSize = 70}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      {bloom > 0 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(${bloomSize}% ${bloomSize * 1.1}% at ${bloomX}% ${bloomY}%, rgba(244,217,174,${0.16 * bloom}) 0%, rgba(244,217,174,${0.05 * bloom}) 38%, transparent 70%)`,
          }}
        />
      )}
      {grid > 0 && (
        <AbsoluteFill
          style={{
            opacity: grid,
            backgroundImage: `linear-gradient(to right, rgba(243,238,230,0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(243,238,230,0.055) 1px, transparent 1px)`,
            backgroundSize: '120px 120px',
            backgroundPosition: 'center center',
            WebkitMaskImage: 'radial-gradient(ellipse 60% 60% at 50% 50%, black 0%, transparent 100%)',
            maskImage: 'radial-gradient(ellipse 60% 60% at 50% 50%, black 0%, transparent 100%)',
          }}
        />
      )}
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 85% 85% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)'}} />
      <AbsoluteFill
        style={{
          backgroundImage: NOISE,
          backgroundSize: '320px 320px',
          backgroundPosition: `${(frame % 5) * 61}px ${(frame % 7) * 43}px`,
          opacity: 0.045,
          mixBlendMode: 'screen',
        }}
      />
    </AbsoluteFill>
  );
};

/** Every scene renders into a fixed 1920×1080 design stage, scaled to the composition (9:16-ready seam). */
export const SceneRoot: React.FC<{children: React.ReactNode; backdrop?: React.ReactNode}> = ({children, backdrop}) => {
  const {width, height} = useVideoConfig();
  const {dir} = useLang();
  const s = Math.min(width / W, height / H);
  return (
    <AbsoluteFill style={{backgroundColor: C.bg, overflow: 'hidden', fontFamily: FONT.sans, color: C.text}}>
      {backdrop}
      <div
        style={{
          position: 'absolute',
          width: W,
          height: H,
          left: (width - W * s) / 2,
          top: (height - H * s) / 2,
          transform: `scale(${s})`,
          transformOrigin: '0 0',
          direction: dir,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

type EnterProps = {
  at: number;
  dur?: number;
  x?: number; // logical px (mirrored in RTL)
  y?: number;
  blur?: number;
  scale?: number;
  out?: number;
  outDur?: number;
  outY?: number;
  outBlur?: number;
  impact?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

/** The standard arrival: soft spring, upward drift, blur-in. Optional soft exit. */
export const Enter: React.FC<EnterProps> = ({
  at, dur = 34, x = 0, y = 22, blur = 10, scale = 1, out, outDur = 16, outY = -14, outBlur = 10, impact, style, children,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {sx} = useLang();
  const p = impact ? enterImpact(frame, fps, at, dur) : enterSoft(frame, fps, at, dur);
  const e = out === undefined ? 0 : exitSoft(frame, out, outDur);
  const vis = interpolate(p, [0, 0.55], [0, 1], clamp) * (1 - e);
  if (frame < at - 1 || vis <= 0.001) return null;
  const b = (1 - p) * blur + e * outBlur;
  const sc = scale + (1 - scale) * p;
  return (
    <div
      style={{
        opacity: vis,
        translate: `${(1 - p) * x * sx}px ${(1 - p) * y + e * outY}px`,
        scale: sc,
        filter: b > 0.3 ? `blur(${b}px)` : undefined,
        willChange: 'transform, opacity',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Force left-to-right isolation for numbers, currency, IDs, times and product names inside RTL text. */
export const Ltr: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => (
  <bdi dir="ltr" style={{unicodeBidi: 'isolate', direction: 'ltr', ...style}}>
    {children}
  </bdi>
);

const TOKEN = '[A-Za-z0-9₪#](?:[A-Za-z0-9₪#.,:/×+%\\-]*[A-Za-z0-9₪#%])?';
const ISLAND = new RegExp(`(${TOKEN}(?:\\s+(?:[×/+\\-]\\s+)?${TOKEN})*)`, 'g');

/** Renders a string, isolating Latin/number runs so mixed Hebrew/English/₪ lines never scramble. */
export const Mixed: React.FC<{text: string; style?: React.CSSProperties}> = ({text, style}) => {
  const {lang} = useLang();
  if (lang !== 'he') return <span style={style}>{text}</span>;
  // Latin/number runs (₪, comma, slash, ×, #, :) become LTR islands; islands never swallow trailing punctuation.
  const parts = text.split(ISLAND);
  return (
    <span style={style}>
      {parts.map((p, i) => (i % 2 === 1 ? <Ltr key={i}>{p}</Ltr> : <React.Fragment key={i}>{p}</React.Fragment>))}
    </span>
  );
};

export const Mono: React.FC<{children: React.ReactNode; size?: number; color?: string; track?: number; style?: React.CSSProperties}> = ({
  children, size = 15, color = C.faint, track = 0.14, style,
}) => (
  <span
    style={{
      fontFamily: FONT.mono,
      fontSize: size,
      letterSpacing: `${track}em`,
      textTransform: 'uppercase',
      color,
      fontWeight: 400,
      ...style,
    }}
  >
    {children}
  </span>
);

/** Label in the language's native small-caps voice: mono-uppercase in EN, quiet sans in HE (mono has no Hebrew). */
export const Label: React.FC<{children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties}> = ({
  children, size = 15, color = C.faint, style,
}) => {
  const {lang} = useLang();
  if (lang === 'en') return <Mono size={size} color={color} style={style}>{children}</Mono>;
  return (
    <span style={{fontFamily: FONT.sans, fontSize: size * 1.25, fontWeight: 500, color, letterSpacing: '0.02em', ...style}}>
      {children}
    </span>
  );
};

type HeadlineProps = {
  text: string;
  at: number;
  size?: number;
  weight?: number;
  color?: string;
  dimWords?: string[]; // words (exact match, punctuation-insensitive) rendered dim
  emphWords?: string[]; // words rendered heavy
  emphColor?: string;
  emphWeight?: number;
  out?: number;
  wordGap?: number;
  stagger?: number;
  justify?: 'center' | 'flex-start';
  maxWidth?: number;
  dur?: number;
  lineHeight?: number;
};

const norm = (w: string) => w.replace(/[.,!?:״"]/g, '');

/** Editorial line reveal: each word rises out of a mask with blur and (Latin only) tracking settle. */
export const Headline: React.FC<HeadlineProps> = ({
  text, at, size = 120, weight = 300, color = C.text, dimWords = [], emphWords = [], emphColor, emphWeight = 700,
  out, wordGap = 0.26, stagger = 4, justify = 'center', maxWidth = 1600, dur = 34, lineHeight = 1.12,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {lang, dir} = useLang();
  const words = text.split(' ');
  const e = out === undefined ? 0 : exitSoft(frame, out, 14);
  if (frame < at - 1 || e >= 1) return null;
  return (
    <div
      dir={dir}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: justify,
        columnGap: size * wordGap,
        maxWidth,
        opacity: 1 - e,
        filter: e > 0.02 ? `blur(${e * 14}px)` : undefined,
        translate: `0 ${-e * 18}px`,
      }}
    >
      {words.map((w, i) => {
        const p = enterSoft(frame, fps, at + i * stagger, dur);
        const isDim = dimWords.map(norm).includes(norm(w));
        const isEmph = emphWords.map(norm).includes(norm(w));
        const tracking = lang === 'en' ? interpolate(p, [0, 1], [0.06, -0.025]) : interpolate(p, [0, 1], [0.02, -0.01]);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              overflow: 'hidden',
              paddingTop: size * 0.14,
              paddingBottom: size * 0.18,
              marginTop: -size * 0.14,
              marginBottom: -size * 0.18,
            }}
          >
            <span
              style={{
                display: 'block',
                fontSize: size,
                lineHeight,
                fontWeight: isEmph ? emphWeight : weight,
                color: isDim ? C.faint : isEmph && emphColor ? emphColor : color,
                letterSpacing: `${tracking}em`,
                translate: `0 ${(1 - p) * size * 0.9}px`,
                opacity: interpolate(p, [0, 0.4], [0, 1], clamp),
                filter: p < 0.98 ? `blur(${(1 - p) * 14}px)` : undefined,
                whiteSpace: 'nowrap',
              }}
            >
              <Mixed text={w} />
            </span>
          </span>
        );
      })}
    </div>
  );
};

/** A hairline that draws itself. */
export const Hairline: React.FC<{at: number; dur?: number; width: number; color?: string; style?: React.CSSProperties}> = ({
  at, dur = 40, width, color = C.lineHi, style,
}) => {
  const frame = useCurrentFrame();
  const p = prog(frame, at, dur, EASE.inOut);
  return <div style={{height: 1, width: width * p, background: color, ...style}} />;
};
