import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, clamp, prog, systemPulse} from '../motion';
import {Enter, Label, Ltr, Mixed, Mono} from './base';
import {Glyph, StatusIndicator, VerificationChip} from './system';
import {useLang} from '../lang';

const panel: React.CSSProperties = {
  background: 'linear-gradient(180deg, #151517 0%, #0d0d0f 100%)',
  border: `1px solid ${C.line}`,
  borderRadius: 28,
  boxShadow: '0 40px 120px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset',
};

/* ---------- SystemFact: one authoritative fact Barry read from the business ---------- */
export const SystemFact: React.FC<{label: string; value: string; tickAt?: number; strong?: boolean; width?: number}> = ({
  label, value, tickAt, strong, width = 330,
}) => {
  const frame = useCurrentFrame();
  return (
  <div style={{...panel, width, padding: '22px 28px 24px', borderRadius: 22, display: 'flex', flexDirection: 'column', gap: 12}}>
    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12}}>
      <Label size={13} color={C.faint}>{label}</Label>
      {tickAt !== undefined && <Glyph name="check" size={20} color={C.verify} stroke={2} draw={prog(frame, tickAt, 14)} />}
    </div>
    <span style={{fontSize: strong ? 44 : 34, fontWeight: strong ? 500 : 400, letterSpacing: '-0.01em', lineHeight: 1.1}}>
      <Mixed text={value} />
    </span>
  </div>
  );
};

/* ---------- Counting number (deterministic) ---------- */
export const RevenueMetric: React.FC<{at: number; value: string; size?: number; dur?: number; color?: string}> = ({at, value, size = 120, dur = 46, color = C.text}) => {
  const frame = useCurrentFrame();
  const m = value.match(/^(\D*)([\d,]+)(.*)$/);
  const p = prog(frame, at, dur, EASE.out);
  if (!m) return <span style={{fontSize: size}}>{value}</span>;
  const [, pre, num, post] = m;
  const target = parseInt(num.replace(/,/g, ''), 10);
  const now = Math.round(target * p);
  const text = num.includes(',') ? now.toLocaleString('en-US') : String(now);
  return (
    <Ltr style={{fontSize: size, fontWeight: 300, letterSpacing: '-0.035em', lineHeight: 1, color, fontVariantNumeric: 'tabular-nums'}}>
      {pre}
      {text}
      {post}
    </Ltr>
  );
};

/* ---------- OutcomeCard ---------- */
export const OutcomeCard: React.FC<{at: number; label: string; value: string; unit: string; tag: string; height?: number; hero?: boolean}> = ({
  at, label, value, unit, tag, height = 470, hero,
}) => {
  const frame = useCurrentFrame();
  const line = prog(frame, at + 10, 40, EASE.inOut);
  return (
    <Enter at={at} y={50} blur={14} dur={40} scale={0.96}>
      <div style={{...panel, width: 410, height, padding: '38px 38px 34px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', position: 'relative', overflow: 'hidden', borderColor: hero ? 'rgba(159,224,188,0.32)' : C.line}}>
        <div style={{position: 'absolute', insetInline: 0, top: 0, height: 2, background: `linear-gradient(90deg, transparent, ${hero ? C.verify : C.warm}, transparent)`, opacity: 0.5 * line, scale: `${line} 1`}} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <Label size={16} color={C.dim}>{label}</Label>
          <Glyph name={hero ? 'shield' : 'check'} size={22} color={hero ? C.verify : C.faint} draw={prog(frame, at + 8, 24)} />
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
          <RevenueMetric at={at + 6} value={value} size={value.length > 3 ? 92 : 168} color={hero ? C.text : C.text} />
          <span style={{fontSize: 27, color: C.dim, fontWeight: 400, lineHeight: 1.25}}>{unit}</span>
        </div>
        <div><VerificationChip at={at + 30} label={tag} size={14} /></div>
      </div>
    </Enter>
  );
};

/* ---------- SupplierCard ---------- */
export const SupplierCard: React.FC<{
  at: number; name: string; tag: string; units: string; price: string; eta: string; select?: number; dim?: number; chosen?: boolean;
}> = ({at, name, tag, units, price, eta, select = 0, dim = 0, chosen}) => {
  const frame = useCurrentFrame();
  const breathe = systemPulse(frame, 70);
  return (
    <Enter at={at} y={44} blur={14} dur={36} scale={0.96}>
      <div
        style={{
          ...panel,
          width: 470,
          padding: '32px 36px 34px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          opacity: 1 - dim * 0.6,
          filter: dim > 0.02 ? `blur(${dim * 2.5}px)` : undefined,
          scale: 1 - dim * 0.05 + select * 0.03,
          borderColor: chosen ? `rgba(244,217,174,${0.2 + 0.5 * select})` : C.line,
          boxShadow: chosen ? `0 40px 120px rgba(0,0,0,0.55), 0 0 ${70 * select}px rgba(244,217,174,${0.2 * select * (0.8 + 0.2 * breathe)})` : panel.boxShadow,
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <Label size={15} color={C.dim}>{name}</Label>
          <Label size={14} color={chosen ? C.warm : C.faint}>{tag}</Label>
        </div>
        <Ltr style={{fontSize: 80, fontWeight: 300, letterSpacing: '-0.035em', lineHeight: 1}}>{price}</Ltr>
        <div style={{display: 'flex', gap: 26, alignItems: 'center'}}>
          <span style={{fontSize: 27, color: C.dim}}><Mixed text={units} /></span>
          <span style={{width: 4, height: 4, borderRadius: 2, background: C.faint}} />
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <Glyph name="truck" size={26} color={chosen ? C.warm : C.dim} />
            <span style={{fontSize: 27, color: C.text}}><Mixed text={eta} /></span>
          </div>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- ApprovalCard: Barry brings the owner one decision, with the numbers that matter ---------- */
export const ApprovalCard: React.FC<{at: number; buttonsAt: number; tapAt: number; resolveAt: number}> = ({at, buttonsAt, tapAt, resolveAt}) => {
  const frame = useCurrentFrame();
  const {t} = useLang();
  const a = t.escalate.card;
  const tap = prog(frame, tapAt, 12, EASE.out);
  const press = interpolate(frame, [tapAt - 4, tapAt, tapAt + 6], [1, 0.95, 1], clamp);
  const resolved = prog(frame, resolveAt, 14);
  const pulse = systemPulse(frame, 40);
  return (
    <Enter at={at} y={46} blur={16} dur={34} scale={0.96}>
      <div
        style={{
          ...panel,
          width: 700,
          padding: '34px 40px 38px',
          borderRadius: 34,
          borderColor: resolved > 0.5 ? 'rgba(159,224,188,0.4)' : `rgba(242,178,92,${0.26 + 0.18 * pulse})`,
          boxShadow: `0 50px 140px rgba(0,0,0,0.6), 0 0 ${80 * (1 - resolved)}px rgba(242,178,92,0.12)`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
            <StatusIndicator status={resolved > 0.5 ? 'ok' : 'hold'} size={12} />
            <span style={{fontSize: 30, fontWeight: 600}}>{a.title}</span>
          </div>
          <Mono size={13} color={C.faint} track={0.06}><Mixed text={a.from} /></Mono>
        </div>
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 34}}>
          {a.rows.map((r, i) => {
            const hi = i === 3 || i === 4;
            return (
              <Enter key={i} at={at + 8 + i * 5} y={12} blur={5} dur={22}>
                <div style={{display: 'flex', flexDirection: 'column', gap: 6, paddingBlock: 16, borderBottom: `1px solid ${C.line}`}}>
                  <Label size={13} color={C.faint}>{r.label}</Label>
                  <span style={{fontSize: hi ? 40 : 32, fontWeight: hi ? 500 : 400, color: i === 3 ? C.hold : C.text, letterSpacing: '-0.01em'}}><Mixed text={r.value} /></span>
                </div>
              </Enter>
            );
          })}
        </div>
        <div style={{marginTop: 28, height: 66, position: 'relative'}}>
          <div style={{display: 'flex', gap: 16, opacity: prog(frame, buttonsAt, 12) * (1 - resolved), position: 'absolute', inset: 0}}>
            <div style={{position: 'relative', flex: 1.2, borderRadius: 33, background: C.text, color: '#0a0a0b', display: 'grid', placeItems: 'center', fontSize: 28, fontWeight: 600, scale: press, boxShadow: '0 0 40px rgba(243,238,230,0.16)', overflow: 'hidden'}}>
              <Mixed text={a.approve} />
              {tap > 0 && tap < 1 && <span style={{position: 'absolute', left: '50%', top: '50%', width: 300 * tap, height: 300 * tap, translate: '-50% -50%', borderRadius: '50%', background: 'rgba(10,10,11,0.12)', opacity: 1 - tap}} />}
            </div>
            <div style={{flex: 1, borderRadius: 33, border: `1px solid ${C.lineHi}`, color: C.dim, display: 'grid', placeItems: 'center', fontSize: 28}}><Mixed text={a.keep} /></div>
          </div>
          <div style={{opacity: resolved, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 16}}>
            <Glyph name="check" size={34} color={C.verify} draw={resolved} stroke={2} />
            <span style={{fontSize: 30, color: C.verify}}><Mixed text={a.approved} /></span>
          </div>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- PurchaseOrder ---------- */
export const PurchaseOrder: React.FC<{at: number; supplier: string; authAt: number; submitAt: number; etaAt: number}> = ({at, supplier, authAt, submitAt, etaAt}) => {
  const frame = useCurrentFrame();
  const {t} = useLang();
  const s = t.supplier;
  const prep = prog(frame, at + 12, authAt - at - 10, EASE.inOut);
  const Step = ({label, on, spin}: {label: string; on: number; spin?: boolean}) => (
    <div style={{display: 'flex', alignItems: 'center', gap: 18, opacity: interpolate(on, [0, 1], [0.3, 1])}}>
      {on >= 1 ? <Glyph name="check" size={28} color={C.verify} stroke={2} draw={1} /> : <StatusIndicator status={spin ? 'working' : 'idle'} size={12} />}
      <span style={{fontSize: 30, color: on >= 1 ? C.text : C.dim}}>{label}</span>
    </div>
  );
  return (
    <Enter at={at} y={50} blur={14} dur={40} scale={0.96}>
      <div style={{...panel, width: 620, padding: '36px 42px 40px', display: 'flex', flexDirection: 'column', gap: 26}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <Label size={16} color={C.dim}>{s.poTitle}</Label>
          <Mono size={13} color={C.faint}><Ltr>PO-2207</Ltr></Mono>
        </div>
        <span style={{fontSize: 40, fontWeight: 400, letterSpacing: '-0.015em'}}><Mixed text={supplier} /></span>
        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          {[0.86, 0.62, 0.74].map((w, i) => (
            <div key={i} style={{height: 8, borderRadius: 4, width: `${w * 100 * Math.min(1, prep * 1.4)}%`, background: 'rgba(243,238,230,0.09)'}} />
          ))}
        </div>
        <div style={{height: 1, background: C.line}} />
        <Step label={frame < authAt ? s.poPreparing : s.poAuth} on={frame >= authAt ? 1 : prep * 0.6} spin={frame < authAt} />
        <Step label={s.poSubmitted} on={frame >= submitAt ? 1 : frame >= authAt ? 0.6 : 0.3} spin={frame >= authAt && frame < submitAt} />
        <div style={{opacity: prog(frame, etaAt, 18), display: 'flex', alignItems: 'center', gap: 16, paddingTop: 6}}>
          <Glyph name="truck" size={30} color={C.warm} draw={prog(frame, etaAt, 26)} />
          <span style={{fontSize: 36, fontWeight: 500, color: C.warm}}><Mixed text={s.poEta} /></span>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- LedgerRow: one line of Barry's operation, resolving from pending → working → done ---------- */
export const LedgerRow: React.FC<{
  at: number; label: string; value: string; doneAt?: number; workingLabel?: string; tone?: 'ok' | 'warm'; big?: boolean;
}> = ({at, label, value, doneAt, workingLabel, tone = 'ok', big}) => {
  const frame = useCurrentFrame();
  const working = workingLabel !== undefined && doneAt !== undefined && frame < doneAt;
  const col = tone === 'warm' ? C.warm : C.verify;
  const check = prog(frame, (doneAt ?? at) + 2, 14);
  return (
    <Enter at={at} y={20} x={30} blur={8} dur={28}>
      <div style={{display: 'flex', alignItems: 'center', gap: 26, height: 104, borderBottom: `1px solid ${C.line}`}}>
        <div style={{width: 36, display: 'grid', placeItems: 'center'}}>
          {working ? <StatusIndicator status="working" size={13} /> : <Glyph name="check" size={32} color={col} stroke={2} draw={check} />}
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 8, flex: 1}}>
          <Label size={14} color={C.faint}>{label}</Label>
          <span style={{fontSize: big ? 44 : 38, fontWeight: big ? 500 : 400, letterSpacing: '-0.01em', color: working ? C.dim : C.text}}>
            <Mixed text={working ? workingLabel! : value} />
          </span>
        </div>
      </div>
    </Enter>
  );
};

/** Quiet provenance note. Everything in the film is product-vision material, and says so. */
export const DemoTag: React.FC<{at?: number}> = ({at = 0}) => {
  const {t} = useLang();
  return (
    <Enter at={at} y={0} blur={0} dur={30} style={{position: 'absolute', insetInlineStart: 80, bottom: 52}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
        <span style={{width: 5, height: 5, borderRadius: '50%', background: C.faint}} />
        <Label size={12} color={C.faint}>{t.demo}</Label>
      </div>
    </Enter>
  );
};

/* ---------- DealRail: the discount decided inside Barry's authority ---------- */
export const DealRail: React.FC<{at: number; zoneAt: number; markerAt: number; lockAt: number; width?: number}> = ({at, zoneAt, markerAt, lockAt, width = 1300}) => {
  const frame = useCurrentFrame();
  const {t, sx} = useLang();
  const k = t.close5;
  const zone = prog(frame, zoneAt, 22, EASE.inOut);
  const m = prog(frame, markerAt, 20, EASE.inOut);
  const lock = prog(frame, lockAt, 14);
  const ask = prog(frame, at + 6, 16);
  const pct = (v: number) => (v / 15) * width;
  const markerX = interpolate(m, [0, 1], [pct(10), pct(5)]);
  return (
    <Enter at={at} y={24} blur={8} dur={30}>
      <div style={{width, position: 'relative', height: 150}}>
        <div style={{position: 'absolute', insetInlineStart: 0, top: 0}}>
          <Label size={15} color={C.dim}>{k.authority}</Label>
        </div>
        <div style={{position: 'absolute', insetInline: 0, top: 57, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.08)'}} />
        <div style={{position: 'absolute', insetInlineStart: 0, top: 57, height: 8, width: pct(5) * zone, borderRadius: 4, background: `linear-gradient(${sx === 1 ? 90 : 270}deg, rgba(244,217,174,0.25), ${C.warm})`, boxShadow: '0 0 24px rgba(244,217,174,0.35)'}} />
        {/* the customer's ask */}
        <div style={{position: 'absolute', insetInlineStart: pct(10) - 1, top: 40, width: 2, height: 42, background: C.faint, opacity: ask * (1 - lock * 0.5)}} />
        <div style={{position: 'absolute', insetInlineStart: pct(10) - 60, top: 96, width: 120, textAlign: 'center', opacity: ask * (1 - lock * 0.6)}}>
          <span style={{fontSize: 30, color: C.dim}}><Ltr>10%</Ltr></span>
        </div>
        {/* Barry's marker */}
        <div style={{position: 'absolute', insetInlineStart: markerX - 17, top: 44, width: 34, height: 34, borderRadius: '50%', background: lock > 0.5 ? C.verify : C.warm, boxShadow: `0 0 ${24 + 20 * lock}px ${lock > 0.5 ? 'rgba(159,224,188,0.7)' : 'rgba(244,217,174,0.7)'}`, opacity: m > 0 ? 1 : 0, display: 'grid', placeItems: 'center'}}>
          {lock > 0 && <Glyph name="check" size={20} color="#0a0a0b" stroke={2.6} draw={lock} />}
        </div>
        <div style={{position: 'absolute', insetInlineStart: pct(5) - 80, top: 94, width: 160, textAlign: 'center', opacity: m}}>
          <span style={{fontSize: 34, fontWeight: 600, color: lock > 0.5 ? C.verify : C.warm}}><Ltr>5%</Ltr></span>
        </div>
        {[0, 15].map((v) => (
          <div key={v} style={{position: 'absolute', insetInlineStart: pct(v) - 30, top: 96, width: 60, textAlign: 'center'}}>
            <Mono size={13} color={C.ghost}><Ltr>{v}%</Ltr></Mono>
          </div>
        ))}
      </div>
    </Enter>
  );
};

/* ---------- Fact chip: small label/value pill that resolves with a check ---------- */
export const FactChip: React.FC<{at: number; label: string; value: string; tone?: 'ok' | 'warm' | 'plain'; size?: number}> = ({at, label, value, tone = 'ok', size = 34}) => {
  const frame = useCurrentFrame();
  const col = tone === 'ok' ? C.verify : tone === 'warm' ? C.warm : C.text;
  return (
    <Enter at={at} y={18} blur={8} dur={24}>
      <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
        <Label size={13} color={C.faint}>{label}</Label>
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          {tone !== 'plain' && <Glyph name="check" size={size * 0.72} color={col} stroke={2} draw={prog(frame, at + 6, 12)} />}
          <span style={{fontSize: size, fontWeight: 500, color: tone === 'plain' ? C.text : C.text, letterSpacing: '-0.01em'}}><Mixed text={value} /></span>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- RouteTrack: where the parcel actually is ---------- */
export const RouteTrack: React.FC<{at: number; checkedAt: number; courierAt: number; etaAt: number; width?: number}> = ({at, checkedAt, courierAt, etaAt, width = 760}) => {
  const frame = useCurrentFrame();
  const {t, sx} = useLang();
  const k = t.patience.track;
  const draw = prog(frame, at + 4, 30, EASE.inOut);
  const scan = prog(frame, checkedAt, 22, EASE.inOut);
  const courier = prog(frame, courierAt, 16);
  const eta = prog(frame, etaAt, 16);
  const pulse = systemPulse(frame, 30);
  const stops = [
    {x: 0, label: k.warehouse, state: 'done'},
    {x: 0.56, label: k.courier, state: 'live'},
    {x: 1, label: k.you, state: 'next'},
  ];
  return (
    <Enter at={at} y={20} blur={8} dur={28}>
      <div style={{width, position: 'relative', height: 330}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
          <Glyph name="truck" size={30} color={C.warm} draw={draw} />
          <Label size={14} color={C.dim}>{k.checked}</Label>
        </div>
        <div style={{position: 'absolute', insetInline: 20, top: 128, height: 2, background: C.ghost}} />
        <div style={{position: 'absolute', insetInlineStart: 20, top: 128, height: 2, width: (width - 40) * 0.56 * draw, background: C.warm}} />
        {/* the re-check sweep */}
        {scan > 0 && scan < 1 && <div style={{position: 'absolute', insetInlineStart: 20 + (width - 40) * scan - 40, top: 110, width: 80, height: 38, background: `radial-gradient(ellipse, rgba(244,217,174,0.45), transparent 70%)`}} />}
        {stops.map((s, i) => {
          const x = 20 + (width - 40) * s.x;
          const live = s.state === 'live';
          return (
            <div key={i} style={{position: 'absolute', insetInlineStart: x - 60, top: 108, width: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20}}>
              <div style={{width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: s.state === 'done' ? 'rgba(159,224,188,0.15)' : live ? 'rgba(244,217,174,0.14)' : 'rgba(255,255,255,0.04)', border: `1px solid ${s.state === 'done' ? C.verify : live ? C.warm : C.lineHi}`, boxShadow: live ? `0 0 ${20 + 16 * pulse * courier}px rgba(244,217,174,${0.4 * courier})` : 'none'}}>
                {s.state === 'done' && <Glyph name="check" size={22} color={C.verify} stroke={2.2} draw={draw} />}
                {live && <span style={{width: 12, height: 12, borderRadius: '50%', background: C.warm, opacity: 0.5 + 0.5 * courier}} />}
              </div>
              <Label size={13} color={live ? C.warm : C.faint}>{s.label}</Label>
            </div>
          );
        })}
        <div style={{position: 'absolute', insetInlineStart: 20 + (width - 40) * 0.56 - 90, top: 206, width: 180, textAlign: 'center', opacity: courier}}>
          <span style={{fontSize: 24, color: C.dim}}>{k.transit}</span>
        </div>
        <div style={{position: 'absolute', insetInlineStart: 0, top: 268, display: 'flex', alignItems: 'baseline', gap: 20, opacity: eta}}>
          <Label size={14} color={C.faint}>{k.eta}</Label>
          <span style={{fontSize: 44, fontWeight: 500, color: C.warm}}><Mixed text={k.etaValue} /></span>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- ActivityLog: the business moving while nobody is watching ---------- */
export const ActivityLog: React.FC<{at: number; rows: {t: string; text: string}[]; speed?: number; opacity?: number; rowH?: number; size?: number}> = ({at, rows, speed = 0.55, opacity = 1, rowH = 64, size = 24}) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - at);
  const shift = local * speed;
  return (
    <div style={{opacity: prog(frame, at, 30) * opacity, WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 22%, black 70%, transparent)', maskImage: 'linear-gradient(to bottom, transparent, black 22%, black 70%, transparent)', height: 900, overflow: 'hidden', position: 'relative'}}>
      <div style={{position: 'absolute', insetInline: 0, top: 560 - shift, display: 'flex', flexDirection: 'column'}}>
        {rows.map((r, i) => {
          const y = 560 - shift + i * rowH;
          const lit = interpolate(y, [180, 420, 620], [0.25, 1, 0.35], clamp);
          return (
            <div key={i} style={{height: rowH, display: 'flex', alignItems: 'center', gap: 26, opacity: lit, borderBottom: `1px solid ${C.line}`}}>
              <Mono size={size * 0.72} color={C.faint} track={0.04}>{r.t}</Mono>
              <span style={{width: 7, height: 7, borderRadius: '50%', background: i % 3 === 1 ? C.verify : C.warm, opacity: 0.8}} />
              <span style={{fontSize: size, color: C.dim}}><Mixed text={r.text} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ---------- StatusLine: one line of a COO-style briefing ---------- */
export const StatusLine: React.FC<{at: number; label: string; value: string; tone: 'working' | 'hold' | 'ok'}> = ({at, label, value, tone}) => {
  const frame = useCurrentFrame();
  const line = prog(frame, at + 4, 30, EASE.inOut);
  return (
    <Enter at={at} y={16} x={24} blur={8} dur={26}>
      <div style={{display: 'flex', alignItems: 'center', gap: 24, height: 116, position: 'relative', width: 640}}>
        <div style={{position: 'absolute', insetInline: 0, bottom: 0, height: 1, background: C.line, scale: `${line} 1`, transformOrigin: 'left'}} />
        <StatusIndicator status={tone === 'working' ? 'working' : tone === 'hold' ? 'hold' : 'ok'} size={13} />
        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
          <Label size={13} color={C.faint}>{label}</Label>
          <span style={{fontSize: 36, color: tone === 'hold' ? C.hold : C.text}}><Mixed text={value} /></span>
        </div>
      </div>
    </Enter>
  );
};
