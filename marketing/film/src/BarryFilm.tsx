import React from 'react';
import {AbsoluteFill, Series} from 'remotion';
import {LangProvider, type Lang} from './lang';
import {COPY} from './i18n';
import {SCENE_ORDER, sceneDur, type SceneId} from './timing';
import {SCENES} from './scenes';
import {FilmAudio} from './audio/FilmAudio';

/** One day inside a business. Hard cuts only — the corner clock is the connective tissue between scenes. */
export const BarryFilm: React.FC<{lang: Lang}> = ({lang}) => (
  <LangProvider lang={lang} copy={COPY[lang]}>
    <AbsoluteFill style={{backgroundColor: '#050506'}}>
      <Series>
        {SCENE_ORDER.map((id) => {
          const Scene = SCENES[id];
          return (
            <Series.Sequence key={id} name={id} durationInFrames={sceneDur(lang, id)}>
              <Scene />
            </Series.Sequence>
          );
        })}
      </Series>
      <FilmAudio lang={lang} />
    </AbsoluteFill>
  </LangProvider>
);

/** A single scene, standalone — for Studio review and still capture. */
export const SceneOnly: React.FC<{lang: Lang; id: SceneId}> = ({lang, id}) => {
  const Scene = SCENES[id];
  return (
    <LangProvider lang={lang} copy={COPY[lang]}>
      <Scene />
    </LangProvider>
  );
};
