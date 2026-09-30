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
  at: number; name: string; tag: string; price: string; lead: string; fit: string; select?: number; dim?: number; chosen?: boolean;
}> = ({at, name, tag, price, lead, fit, select = 0, dim = 0, chosen}) => {
  const frame = useCurrentFrame();
  const breathe = systemPulse(frame, 70);
  return (
    <Enter at={at} y={44} blur={14} dur={40} scale={0.96}>
      <div
        style={{
          ...panel,
          width: 500,
          padding: '34px 38px 34px',
          display: 'flex',
          flexDirection: 'column',
          gap: 26,
          opacity: 1 - dim * 0.62,
          filter: dim > 0.02 ? `blur(${dim * 2.5}px)` : undefined,
          scale: 1 - dim * 0.04 + select * 0.03,
          borderColor: chosen ? `rgba(244,217,174,${0.25 + 0.45 * select})` : C.line,
          boxShadow: chosen ? `0 40px 120px rgba(0,0,0,0.55), 0 0 ${70 * select}px rgba(244,217,174,${0.22 * select * (0.8 + 0.2 * breathe)})` : panel.boxShadow,
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <Label size={15} color={C.dim}>{name}</Label>
          <Label size={14} color={C.faint}>{tag}</Label>
        </div>
        <Ltr style={{fontSize: 84, fontWeight: 300, letterSpacing: '-0.035em', lineHeight: 1}}>{price}</Ltr>
        <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
          <Glyph name="truck" size={26} color={C.dim} />
          <span style={{fontSize: 28, color: C.text}}><Mixed text={lead} /></span>
        </div>
        <div style={{height: 1, background: C.line}} />
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          <StatusIndicator status={chosen && select > 0.5 ? 'ok' : 'idle'} size={11} />
          <Label size={15} color={chosen && select > 0.5 ? C.verify : C.faint}>{fit}</Label>
        </div>
      </div>
    </Enter>
  );
};

/* ---------- OwnerInsight: a numeral-led attention row ---------- */
export const OwnerInsight: React.FC<{at: number; n: string; text: string; sub?: string; tag: string; tone: 'potential' | 'hold' | 'alert'; out?: number; width?: number; s?: number}> = ({
  at, n, text, sub, tag, tone, out, width = 1440, s = 1,
}) => {
  const frame = useCurrentFrame();
  const line = prog(frame, at + 6, 34, EASE.inOut);
  return (
    <Enter at={at} out={out} outDur={18} y={34} blur={12} dur={38} style={{width}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 44 * s, paddingBlock: 26 * s, position: 'relative'}}>
        <div style={{position: 'absolute', insetInline: 0, bottom: 0, height: 1, background: C.line, scale: `${line} 1`, transformOrigin: 'left center'}} />
        <span style={{fontSize: 150 * s, fontWeight: 200, letterSpacing: '-0.05em', lineHeight: 0.9, minWidth: 110 * s, textAlign: 'center', color: tone === 'alert' ? C.alert : tone === 'hold' ? C.hold : C.text}}>
          <Ltr>{n}</Ltr>
        </span>
        <div style={{display: 'flex', flexDirection: 'column', gap: 8 * s, flex: 1}}>
          <span style={{fontSize: 42 * s, fontWeight: 400, letterSpacing: '-0.015em', lineHeight: 1.15}}><Mixed text={text} /></span>
          {sub && <span style={{fontSize: 30 * s, color: tone === 'potential' ? C.warm : C.dim, fontWeight: 400}}><Mixed text={sub} /></span>}
        </div>
        <VerificationChip at={at + 14} label={tag} tone={tone} size={15} />
      </div>
    </Enter>
  );
};

/* ---------- ApprovalCard ---------- */
export const ApprovalCard: React.FC<{
  at: number; gaugeAt: number; needAt: number; buttonsAt: number; tapAt: number; resolveAt: number;
}> = ({at, gaugeAt, needAt, buttonsAt, tapAt, resolveAt}) => {
  const frame = useCurrentFrame();
  const {t, sx} = useLang();
  const a = t.authority;
  const gauge = prog(frame, gaugeAt, 26, EASE.inOut);
  const need = prog(frame, needAt, 18);
  const tap = prog(frame, tapAt, 12, EASE.out);
  const press = interpolate(frame, [tapAt - 4, tapAt, tapAt + 6], [1, 0.95, 1], clamp);
  const resolved = prog(frame, resolveAt, 14);
  const pulse = systemPulse(frame, 40);
  const Row = ({i, f, big}: {i: number; f: {label: string; value: string}; big?: boolean}) => (
    <Enter at={at + 8 + i * 8} y={16} blur={6} dur={26}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBlock: 16, borderBottom: `1px solid ${C.line}`}}>
        <Label size={14} color={C.faint}>{f.label}</Label>
        <span style={{fontSize: big ? 44 : 34, fontWeight: big ? 500 : 400, letterSpacing: '-0.01em'}}><Mixed text={f.value} /></span>
      </div>
    </Enter>
  );
  // gauge scale 0..15%
  const pct = (v: number) => (v / 15) * 100;
  return (
    <Enter at={at} y={50} blur={16} dur={40} scale={0.96}>
      <div
        style={{
          ...panel,
          width: 780,
          padding: '40px 46px 44px',
          borderColor: resolved > 0.5 ? 'rgba(159,224,188,0.4)' : need > 0 ? `rgba(242,178,92,${0.28 + 0.2 * pulse})` : C.line,
          boxShadow: `0 50px 140px rgba(0,0,0,0.6), 0 0 ${need > 0 ? 80 * need * (resolved > 0.5 ? 0 : 1) : 0}px rgba(242,178,92,0.14)`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14}}>
          <StatusIndicator status={resolved > 0.5 ? 'ok' : 'hold'} size={12} />
          <Label size={15} color={C.dim}>{a.cardTitle}</Label>
        </div>
        <Row i={0} f={a.customer} />
        <Row i={1} f={a.request} />
        <Row i={2} f={a.order} big />
        {/* authority gauge */}
        <Enter at={at + 8 + 3 * 8} y={16} blur={6} dur={26}>
          <div style={{paddingBlock: 26}}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 26}}>
              <Label size={14} color={C.faint}>{a.authority.label}</Label>
              <span style={{fontSize: 34}}><Mixed text={a.authority.value} /></span>
            </div>
            <div style={{position: 'relative', height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)'}}>
              {/* Barry's authority zone 0–5% */}
              <div style={{position: 'absolute', insetInlineStart: 0, top: 0, height: 8, width: `${pct(5) * gauge}%`, borderRadius: 4, background: `linear-gradient(90deg, ${C.warm}55, ${C.warm})`, boxShadow: '0 0 20px rgba(244,217,174,0.4)'}} />
              {/* the request beyond it */}
              <div style={{position: 'absolute', insetInlineStart: `${pct(5)}%`, top: 3, height: 2, width: `${(pct(10) - pct(5)) * gauge}%`, background: `repeating-linear-gradient(90deg, ${C.hold} 0 5px, transparent 5px 10px)`}} />
              <div style={{position: 'absolute', insetInlineStart: `${pct(10)}%`, top: -9, translate: `${-50 * sx}% 0`, opacity: gauge > 0.95 ? 1 : 0}}>
                <div style={{width: 2, height: 26, background: C.hold, boxShadow: '0 0 16px rgba(242,178,92,0.8)', marginInline: 'auto'}} />
              </div>
              {[0, 5, 10, 15].map((v) => (
                <div key={v} style={{position: 'absolute', insetInlineStart: `${pct(v)}%`, top: 22, translate: `${-50 * sx}% 0`}}>
                  <Mono size={12} color={v === 10 ? C.hold : C.faint}><Ltr>{v}%</Ltr></Mono>
                </div>
              ))}
            </div>
          </div>
        </Enter>
        <div style={{marginTop: 34, height: 96, position: 'relative'}}>
          {/* decision required */}
          <div style={{opacity: need * (1 - resolved), display: 'flex', flexDirection: 'column', gap: 20, position: 'absolute', inset: 0}}>
            <div style={{display: 'flex', gap: 14, alignItems: 'center'}}>
              <StatusIndicator status="hold" size={11} />
              <Label size={15} color={C.hold}>{a.decision}</Label>
            </div>
            <div style={{display: 'flex', gap: 18, opacity: prog(frame, buttonsAt, 14)}}>
              <div style={{position: 'relative', flex: 1.3, height: 62, borderRadius: 31, background: C.text, color: '#0a0a0b', display: 'grid', placeItems: 'center', fontSize: 28, fontWeight: 600, scale: press, boxShadow: '0 0 40px rgba(243,238,230,0.18)'}}>
                {a.approve}
                {tap > 0 && tap < 1 && (
                  <span style={{position: 'absolute', left: '50%', top: '50%', width: 220 * tap, height: 220 * tap, translate: '-50% -50%', borderRadius: '50%', border: '2px solid rgba(10,10,11,0.5)', opacity: 1 - tap}} />
                )}
              </div>
              <div style={{flex: 1, height: 62, borderRadius: 31, border: `1px solid ${C.lineHi}`, color: C.dim, display: 'grid', placeItems: 'center', fontSize: 28, fontWeight: 400}}>{a.decline}</div>
            </div>
          </div>
          <div style={{opacity: resolved, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 18}}>
            <Glyph name="check" size={34} color={C.verify} draw={resolved} stroke={2} />
            <span style={{fontSize: 30, color: C.verify}}>{a.approved}</span>
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
        <span style={{fontSize: 44, fontWeight: 400, letterSpacing: '-0.015em'}}><Mixed text={supplier} /></span>
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
