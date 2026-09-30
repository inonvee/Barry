// Centralised timing. Pure data (no imports) so scenes AND the audio generator read the same clock.
// 30 fps, 120 BPM => one beat = 15 frames. The montage and systems scenes sit on the beat grid.
export const FPS = 30;
export const BEAT = 15;

export type Lang = 'he' | 'en';
export type SceneId =
  | 'morning' | 'dress' | 'patience' | 'close5' | 'escalate' | 'owner' | 'supplier'
  | 'montage' | 'systems' | 'adapt' | 'night' | 'nextDay' | 'brand';

export const SCENE_ORDER: SceneId[] = [
  'morning', 'dress', 'patience', 'close5', 'escalate', 'owner', 'supplier',
  'montage', 'systems', 'adapt', 'night', 'nextDay', 'brand',
];

const BASE_DUR: Record<SceneId, number> = {
  morning: 300,
  dress: 330,
  patience: 235,
  close5: 170,
  escalate: 300,
  owner: 285,
  supplier: 360,
  montage: 180,
  systems: 135,
  adapt: 140,
  night: 125,
  nextDay: 160,
  brand: 225,
};

// Language-native pacing hooks: nudge a scene if one language's copy needs more or less air.
const LANG_ADJUST: Record<Lang, Partial<Record<SceneId, number>>> = {he: {}, en: {}};

export const sceneDur = (lang: Lang, id: SceneId) => BASE_DUR[id] + (LANG_ADJUST[lang][id] ?? 0);

export const sceneStarts = (lang: Lang): Record<SceneId, number> => {
  const out = {} as Record<SceneId, number>;
  let t = 0;
  for (const id of SCENE_ORDER) {
    out[id] = t;
    t += sceneDur(lang, id);
  }
  return out;
};

export const totalFrames = (lang: Lang) => {
  const s = sceneStarts(lang);
  return s.brand + sceneDur(lang, 'brand');
};

/** The day. The corner clock rolls from the previous scene's time into this one. */
export const CLOCK: Partial<Record<SceneId, {from?: string; time: string; roll?: {at: number; time: string}}>> = {
  morning: {time: '07:03'},
  dress: {from: '07:03', time: '10:26', roll: {at: 196, time: '10:28'}},
  patience: {from: '10:28', time: '13:18'},
  close5: {from: '13:18', time: '15:44'},
  escalate: {from: '15:44', time: '16:02'},
  owner: {from: '16:02', time: '18:42'},
  supplier: {from: '18:42', time: '21:16'},
  night: {from: '21:16', time: '00:37'},
  nextDay: {from: '00:37', time: '07:01'},
};

// ---- Cues: scene-local frames. Scenes animate from these; scripts/generate-audio.mjs schedules sound from them. ----
export const Q = {
  morning: {notif: 22, barry: 84, expand: 100, b2: 128, b3: 160, log: 96, cut: 212, t1: 220, systems: 244, t2: 256},
  dress: {
    header: 2, c1: 10, typing: 42, b1: 66,
    pull: 94, factStart: 100, factGap: 7, verify: 146, collapse: 172,
    shift: 196, c2: 208, typing2: 232, b2: 244, link: 258,
    rowStart: 222, rowGap: 11, payDone: 292, paid: 298, order: 304,
  },
  patience: {history: 0, burst: [18, 29, 36, 50, 64, 76], typing: 96, reply: 120, track: 126, checked: 128, courier: 140, eta: 152, t1: 176, t2: 196},
  close5: {c1: 8, typing: 28, b1: 44, rail: 52, zone: 54, marker: 70, lock: 90, c2: 108, after: 116, afterGap: 11},
  escalate: {c1: 8, typing: 26, b1: 42, send: 62, card: 68, c2: 90, buttons: 116, tap: 140, resolve: 148, back: 150, typing2: 158, b2: 172, paid: 192, cut: 214, t1: 220, t2: 250},
  owner: {q1: 8, typing: 24, b1: 38, b2: 56, b3: 80, strip: 60, stripGap: 22, q2: 138, typing2: 152, b4: 166, cardStart: 198, cardGap: 12},
  supplier: {
    phoneIn: 0, ownerMsg: 14, typing: 42, barryReply: 58, open: 86, core: 90,
    nodeStart: 96, nodeGap: 6, understand: 152, converge: 194, suppliers: 204, select: 236, reasonStart: 240, reasonGap: 6,
    po: 268, authOK: 284, submitted: 298, eta: 306, phoneBack: 314, done: 324,
  },
  montage: {start: 0, gap: 30},
  systems: {modules: 0, moduleGap: 3, w1: 30, w2: 60, w3: 90},
  adapt: {l1: 10, l2: 64},
  night: {e1: 16, gap: 20, t: 82},
  nextDay: {barry: 10, expand: 24, b2: 46, employee: 92},
  brand: {point: 20, line: 34, mark: 50, shift: 108, works: 114, soon: 160},
} as const;
