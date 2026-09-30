import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {EASE, connectionTravel, prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, SceneRoot} from '../ui/base';
import {BarryMessage, CustomerMessage} from '../ui/chat';
import {ApprovalCard, DemoTag} from '../ui/cards';
import {BarryCore, SystemConnection} from '../ui/system';

/** 0:24 — Barry can think freely. Authority stays with the business. */
export const AuthorityScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, mx, lang} = useLang();
  const q = Q.authority;
  const a = t.authority;
  const exit = prog(frame, q.exit, 18, EASE.inOut);
  const F = 38;
  const core = {x: mx(892), y: 560};
  const tapLight = connectionTravel(frame, q.travel, 24);
  const replyLight = connectionTravel(frame, q.travel + 20, 24);

  return (
    <SceneRoot backdrop={<Backdrop bloom={0.35 + 0.45 * prog(frame, q.h2, 30)} bloomX={50} bloomY={frame >= q.h1 - 4 ? 56 : 62} grid={0.3 * (1 - exit)} />}>
      <div style={{opacity: 1 - exit, filter: exit > 0.02 ? `blur(${exit * 16}px)` : undefined, scale: 1 + exit * 0.03, position: 'absolute', inset: 0}}>
        {/* connections */}
        <SystemConnection a={{x: mx(700), y: 380}} b={core} curve={-40} draw={prog(frame, q.c3 + 14, 24, EASE.inOut)} travel={connectionTravel(frame, q.c3 + 24, 26)} opacity={0.25} />
        <SystemConnection a={core} b={{x: mx(1000), y: 470}} curve={-30} draw={prog(frame, q.card, 26, EASE.inOut)} travel={connectionTravel(frame, q.card + 6, 26)} opacity={0.25} />
        {/* approval travels back through Barry */}
        <SystemConnection a={{x: mx(1000), y: 690}} b={core} curve={30} draw={prog(frame, q.travel - 4, 8)} travel={tapLight} opacity={0.0} />
        <SystemConnection a={core} b={{x: mx(700), y: 680}} curve={40} draw={prog(frame, q.travel + 10, 22, EASE.inOut)} travel={replyLight} opacity={0.3} />
        <div style={{position: 'absolute', left: core.x - 50, top: core.y - 50, opacity: prog(frame, q.c3 + 8, 20), scale: 1 + 0.3 * (tapLight > 0 && tapLight < 1 ? Math.sin(tapLight * Math.PI) : 0)}}>
          <BarryCore size={100} energy={0.95} pulsePeriod={64} />
        </div>

        <div style={{position: 'absolute', left: 140, right: 140, top: 190, height: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          {/* conversation */}
          <div style={{width: 640, height: 640, display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
            <div style={{height: 230}}>
              <CustomerMessage at={q.c3} text={a.c3} maxWidth={660} size={F} />
            </div>
            <div style={{position: 'relative', height: 300}}>
              <div style={{position: 'absolute', insetInlineEnd: 0, top: 0}}>
                <BarryMessage at={q.hold} out={q.reply - 2} text={a.hold} label="Barry" maxWidth={600} size={34} />
              </div>
              <div style={{position: 'absolute', insetInlineEnd: 0, top: 0}}>
                <BarryMessage at={q.reply} text={a.b3} label="Barry" maxWidth={720} size={F} showTicks />
              </div>
            </div>
          </div>
          {/* the owner's decision */}
          <ApprovalCard at={q.card} gaugeAt={q.gauge} needAt={q.need} buttonsAt={q.buttons} tapAt={q.tap} resolveAt={q.resolve} />
        </div>
        <DemoTag at={20} />
      </div>

      <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10}}>
        <div style={{opacity: 1 - 0.7 * prog(frame, q.h2, 14)}}>
          <Headline text={a.t1} at={q.h1} size={lang === 'he' ? 112 : 108} weight={300} emphWords={['Barry']} emphWeight={600} maxWidth={1760} stagger={3} />
        </div>
        <Headline text={a.t2} at={q.h2} size={lang === 'he' ? 150 : 128} weight={600} maxWidth={1760} stagger={4} emphColor={C.text} />
      </div>
    </SceneRoot>
  );
};
