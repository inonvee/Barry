import React from 'react';
import {useCurrentFrame} from 'remotion';
import {prog} from '../motion';
import {Q} from '../timing';
import {useLang} from '../lang';
import {Backdrop, Headline, SceneRoot} from '../ui/base';

/** The positioning line, on its own. */
export const AdaptScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {t, lang} = useLang();
  const q = Q.adapt;
  return (
    <SceneRoot backdrop={<Backdrop bloom={0.55 * prog(frame, q.l2, 40)} bloomY={58} bloomSize={60} />}>
      <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18}}>
        <div style={{opacity: 1 - 0.5 * prog(frame, q.l2, 16)}}>
          <Headline text={t.adapt.l1} at={q.l1} size={lang === 'he' ? 100 : 92} weight={300} maxWidth={1760} stagger={3} />
        </div>
        <Headline text={t.adapt.l2} at={q.l2} size={lang === 'he' ? 112 : 104} weight={600} maxWidth={1760} stagger={4} />
      </div>
    </SceneRoot>
  );
};
