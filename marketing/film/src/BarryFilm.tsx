import React from 'react';
import {AbsoluteFill} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {LangProvider, type Lang} from './lang';
import {COPY} from './i18n';
import {SCENE_ORDER, sceneDur, transitionAfter, type SceneId} from './timing';
import {SCENES} from './scenes';
import {focusPull} from './transitions';
import {FilmAudio} from './audio/FilmAudio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const presentationFor = (id: SceneId): any => (id === 'open' ? fade() : focusPull({push: 0.05}));

/** One motion system, two languages: scene architecture, timing and audio are shared; copy is data. */
export const BarryFilm: React.FC<{lang: Lang}> = ({lang}) => {
  const items: React.ReactNode[] = [];
  SCENE_ORDER.forEach((id, i) => {
    const Scene = SCENES[id];
    items.push(
      <TransitionSeries.Sequence key={`s-${id}`} name={id} durationInFrames={sceneDur(lang, id)}>
        <Scene />
      </TransitionSeries.Sequence>,
    );
    const overlap = transitionAfter(id);
    if (overlap > 0 && i < SCENE_ORDER.length - 1) {
      items.push(
        <TransitionSeries.Transition key={`t-${id}`} presentation={presentationFor(id)} timing={linearTiming({durationInFrames: overlap})} />,
      );
    }
  });
  return (
    <LangProvider lang={lang} copy={COPY[lang]}>
      <AbsoluteFill style={{backgroundColor: '#050506'}}>
        <TransitionSeries>{items}</TransitionSeries>
        <FilmAudio lang={lang} />
      </AbsoluteFill>
    </LangProvider>
  );
};

/** A single scene, standalone — for Studio review and still capture. */
export const SceneOnly: React.FC<{lang: Lang; id: SceneId}> = ({lang, id}) => {
  const Scene = SCENES[id];
  return (
    <LangProvider lang={lang} copy={COPY[lang]}>
      <Scene />
    </LangProvider>
  );
};
