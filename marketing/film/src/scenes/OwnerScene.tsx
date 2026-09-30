import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Enter, Headline, Label, SceneRoot} from '../ui/base';
import {OwnerQuery} from '../ui/chat';
import {DemoTag, OutcomeCard, OwnerInsight} from '../ui/cards';

/** 0:44 — Owner Barry: from one action to the whole business. */
export const OwnerScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.owner;
  const o = t.owner;
  const phase2 = frame >= q.itemsOut;
  const outP = prog(frame, q.itemsOut, 18, EASE.inOut);

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.5} bloomX={lang === 'he' ? 30 : 70} bloomY={50} grid={0.25} />}>
      {/* the question — always top, always small: the owner is talking casually */}
      <div style={{position: 'absolute', insetInlineStart: 140, top: 96, width: 1200}}>
        <OwnerQuery at={q.q1} out={q.itemsOut} label={t.supplier.ownerLabel} text={o.q1} />
        <div style={{position: 'absolute', insetInlineStart: 0, top: 0}}>
          <OwnerQuery at={q.itemsOut + 6} label={t.supplier.ownerLabel} text={o.q2} />
        </div>
      </div>

      {!phase2 && (
        <div style={{opacity: 1 - outP, filter: outP > 0.02 ? `blur(${outP * 14}px)` : undefined, position: 'absolute', inset: 0}}>
          {/* Barry's answer, headline first */}
          <div style={{position: 'absolute', insetInlineStart: 140, top: 340, width: 620}}>
            <Enter at={q.title - 10} y={10} blur={4} dur={20}>
              <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14}}>
                <span style={{width: 8, height: 8, borderRadius: '50%', background: C.warm, boxShadow: '0 0 14px rgba(244,217,174,0.9)'}} />
                <Label size={14} color={C.dim}>Barry</Label>
              </div>
            </Enter>
            <Headline text={o.title} at={q.title} size={lang === 'he' ? 190 : 170} weight={600} justify="flex-start" maxWidth={640} stagger={5} />
          </div>
          {/* three things that need the owner */}
          <div style={{position: 'absolute', insetInlineEnd: 120, top: 250, width: 1060, display: 'flex', flexDirection: 'column'}}>
            {o.items.map((it, i) => (
              <OwnerInsight key={i} at={q.itemStart + i * q.itemGap} n={it.n} text={it.text} sub={it.sub} tag={it.tag} tone={it.tone} width={1060} s={0.82} />
            ))}
          </div>
        </div>
      )}

      {phase2 && (
        <div style={{position: 'absolute', left: 0, right: 0, top: 330, display: 'flex', justifyContent: 'center', gap: 28}}>
          {o.outcomes.map((oc, i) => (
            <OutcomeCard key={i} at={q.cardStart + i * q.cardGap} label={oc.label} value={oc.value} unit={oc.unit} tag={oc.tag} hero={i === 0} />
          ))}
        </div>
      )}
      <DemoTag at={10} />
    </SceneRoot>
  );
};
