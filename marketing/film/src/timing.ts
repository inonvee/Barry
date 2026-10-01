// Centralised timing. Pure data (no imports) so scenes AND the audio generator read the same clock.
// 30 fps, 120 BPM => one beat = 15 frames. The montage and systems scenes sit on the beat grid.
export const FPS = 30;
export const BEAT = 15;

export type Lang = 'he' | 'en';
export type SceneId =
  | 'morning' | 'dress' | 'patience' | 'close5' | 'escalate' | 'owner' | 'supplier' | 'margins'
  | 'montage' | 'systems' | 'adapt' | 'night' | 'nextDay' | 'brand';

export const SCENE_ORDER: SceneId[] = [
  'morning', 'dress', 'patience', 'close5', 'escalate', 'owner', 'supplier', 'margins',
  'montage', 'systems', 'adapt', 'night', 'nextDay', 'brand',
];

const BASE_DUR: Record<SceneId, number> = {
  morning: 286,
  dress: 316,
  patience: 222,
  close5: 150,
  escalate: 276,
  owner: 244,
  supplier: 346,
  margins: 276, // BARRY Margins: one beat — the cost structure, reviewed
  montage: 150, // five businesses (wholesale flash cut — it repeated the supplier beat)
  systems: 160, // longer hold on "Same operator."
  adapt: 180, // a beat of black before the positioning line
  night: 125,
  nextDay: 150,
  brand: 270, // BARRY holds alone; the final frame holds
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
  margins: {from: '21:16', time: '22:05'},
  night: {from: '22:05', time: '00:37'},
  nextDay: {from: '00:37', time: '07:01'},
};

// ---- Cues: scene-local frames. Scenes animate from these; scripts/generate-audio.mjs schedules sound from them. ----
export const Q = {
  morning: {notif: 22, barry: 76, expand: 92, b2: 118, b3: 148, log: 88, cut: 198, t1: 206, systems: 230, t2: 242},
  dress: {
    header: 2, c1: 10, typing: 42, b1: 66,
    pull: 94, factStart: 100, factGap: 7, verify: 146, collapse: 172,
    shift: 196, c2: 208, typing2: 232, b2: 244, link: 258,
    rowStart: 222, rowGap: 11, payDone: 292, paid: 298, order: 304,
  },
  patience: {history: 0, burst: [18, 29, 36, 50, 64, 76], typing: 96, reply: 120, track: 126, checked: 128, courier: 140, eta: 152, t1: 166, t2: 184},
  close5: {c1: 8, typing: 28, b1: 44, rail: 52, zone: 54, marker: 68, lock: 86, c2: 98, after: 104, afterGap: 10},
  escalate: {c1: 8, typing: 26, b1: 42, send: 62, card: 68, c2: 90, buttons: 116, tap: 140, resolve: 148, back: 150, typing2: 154, b2: 166, paid: 184, cut: 204, t1: 210, t2: 238},
  owner: {q1: 8, typing: 24, b1: 38, b2: 56, b3: 80, strip: 60, stripGap: 22, q2: 116, typing2: 128, b4: 140, cardStart: 172, cardGap: 12},
  supplier: {
    phoneIn: 0, ownerMsg: 14, typing: 42, barryReply: 58, open: 86, core: 90,
    nodeStart: 96, nodeGap: 6, understand: 152, converge: 194, suppliers: 204, select: 228, reasonStart: 232, reasonGap: 6,
    po: 256, authOK: 270, submitted: 284, eta: 292, phoneBack: 300, done: 310,
  },
  margins: {notif: 10, sweep: 30, sweepGap: 5, card: 54, current: 62, why: 76, saving: 94, actions: 110, more: 124, moreGap: 8, total: 152, cut: 210, t1: 216, t2: 234},
  montage: {start: 0, gap: 30, count: 5},
  systems: {modules: 0, moduleGap: 3, w1: 30, w2: 60, w3: 90},
  adapt: {l1: 26, l2: 92},
  night: {e1: 16, gap: 20, t: 82},
  nextDay: {barry: 10, expand: 24, b2: 46, employee: 86},
  brand: {point: 20, line: 34, mark: 50, shift: 128, works: 132, soon: 186},
} as const;
