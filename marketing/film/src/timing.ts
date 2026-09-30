// Centralised timing. Pure data (no imports) so scenes AND the audio generator read the same clock.
// Master clock: 30 fps, 120 BPM => one beat = 15 frames. Scene 7 sits exactly on the beat grid.
export const FPS = 30;
export const BEAT = 15;

export type Lang = 'he' | 'en';
export type SceneId = 'open' | 'verify' | 'operate' | 'authority' | 'supplier' | 'owner' | 'scale' | 'brand';

export const SCENE_ORDER: SceneId[] = ['open', 'verify', 'operate', 'authority', 'supplier', 'owner', 'scale', 'brand'];

const BASE_DUR: Record<SceneId, number> = {
  open: 195,
  verify: 280,
  operate: 285,
  authority: 270,
  supplier: 380,
  owner: 300,
  scale: 255,
  brand: 270,
};

// Language-native pacing hooks: nudge a scene's length if a language's copy needs more/less air.
// (Cue offsets inside scenes are shared; the hold at the end of a scene absorbs the difference.)
const LANG_ADJUST: Record<Lang, Partial<Record<SceneId, number>>> = {
  he: {},
  en: {},
};

// Overlap (frames) shared between a scene and the next one when a real transition is used.
const TRANSITION_AFTER: Partial<Record<SceneId, number>> = {
  open: 12, // black -> chat emerges from darkness
  supplier: 18, // the supplier world pulls focus into the owner briefing
};

export const sceneDur = (lang: Lang, id: SceneId) => BASE_DUR[id] + (LANG_ADJUST[lang][id] ?? 0);
export const transitionAfter = (id: SceneId) => TRANSITION_AFTER[id] ?? 0;

export const sceneStarts = (lang: Lang): Record<SceneId, number> => {
  const out = {} as Record<SceneId, number>;
  let t = 0;
  for (const id of SCENE_ORDER) {
    out[id] = t;
    t += sceneDur(lang, id) - transitionAfter(id);
  }
  return out;
};

export const totalFrames = (lang: Lang) => {
  const starts = sceneStarts(lang);
  return starts.brand + sceneDur(lang, 'brand');
};

// ---- Cues: scene-local frames. Scenes animate from these; the audio generator schedules sound from them. ----
export const Q = {
  open: {l1: 6, l1out: 46, l2: 52, l2out: 86, l3: 92, l3out: 121, l4: 140},
  verify: {
    header: 4, c1: 10, typing: 46, b1: 78,
    pull: 100, factStart: 106, factGap: 9, verify: 140, collapse: 178, h1: 210, h2: 236,
  },
  operate: {
    c2: 6, rowStart: 34, rowGap: 12, pay: 82, payDone: 104, b2: 122,
    flashStart: 152, flashGap: 15, title1: 232, title2: 250,
  },
  authority: {
    c3: 6, hold: 34, card: 52, gauge: 84, need: 112, buttons: 118, tap: 142, resolve: 150,
    travel: 152, reply: 176, exit: 202, h1: 206, h2: 232,
  },
  supplier: {
    phoneIn: 0, ownerMsg: 14, typing: 52, barryReply: 72, open: 98, core: 102,
    nodeStart: 110, nodeGap: 7, understand: 150, converge: 200, suppliers: 210, select: 246,
    po: 262, authOK: 282, submitted: 298, eta: 310, phoneBack: 318, done: 328,
  },
  owner: {
    q1: 6, title: 30, itemStart: 52, itemGap: 32, itemsOut: 184, q2: 190, cardStart: 208, cardGap: 12,
  },
  scale: {wordStart: 0, wordGap: 15, graph: 105, one1: 150, one2: 195},
  brand: {point: 20, line: 36, mark: 52, tag1: 118, tag2: 142, soon: 186, micro: 226},
} as const;

export const WORD_COUNT = 7;
