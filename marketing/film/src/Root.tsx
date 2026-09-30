import React from 'react';
import {Composition, Folder} from 'remotion';
import './fonts';
import {BarryFilm, SceneOnly} from './BarryFilm';
import {FPS, SCENE_ORDER, sceneDur, totalFrames, type Lang} from './timing';
import {W, H} from './theme';

// Both masters share BarryFilm; only `lang` (and therefore copy + language-specific timing) differs.
export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="BarryComingSoon-HE" component={BarryFilm} durationInFrames={totalFrames('he')} fps={FPS} width={W} height={H} defaultProps={{lang: 'he' as Lang}} />
    <Composition id="BarryComingSoon-EN" component={BarryFilm} durationInFrames={totalFrames('en')} fps={FPS} width={W} height={H} defaultProps={{lang: 'en' as Lang}} />
    <Folder name="Scenes-HE">
      {SCENE_ORDER.map((id) => (
        <Composition key={id} id={`HE-${id}`} component={SceneOnly} durationInFrames={sceneDur('he', id)} fps={FPS} width={W} height={H} defaultProps={{lang: 'he' as Lang, id}} />
      ))}
    </Folder>
    <Folder name="Scenes-EN">
      {SCENE_ORDER.map((id) => (
        <Composition key={id} id={`EN-${id}`} component={SceneOnly} durationInFrames={sceneDur('en', id)} fps={FPS} width={W} height={H} defaultProps={{lang: 'en' as Lang, id}} />
      ))}
    </Folder>
  </>
);
