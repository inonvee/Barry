// Barry film — original procedural score + sound design. No samples, no third-party audio.
// Everything is scheduled from src/timing.ts (scene starts + cue table), so audio and picture share one clock.
//   node scripts/generate-audio.mjs [he|en|all]      -> public/audio/{music,sfx}-<lang>.mp3
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Q, sceneStarts, totalFrames, FPS, BEAT} from '../src/timing.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48000;
const TAU = Math.PI * 2;

// ---------- deterministic noise ----------
let seed = 1234567;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = (n) => Float32Array.from({length: n}, () => rnd() * 2 - 1);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------- filters ----------
function coeffs(type, f, q) {
  const w0 = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w0), s = Math.sin(w0), a = s / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; }
  const a0 = 1 + a;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - a) / a0];
}
/** Biquad with a time-varying cutoff (updated every 64 samples). fFn(i) -> Hz */
function filt(x, type, fFn, q = 0.707) {
  const y = new Float32Array(x.length);
  let z1 = 0, z2 = 0, k = [0, 0, 0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    if (i % 64 === 0) k = coeffs(type, typeof fFn === 'function' ? fFn(i) : fFn, q);
    const inp = x[i];
    const out = k[0] * inp + z1;
    z1 = k[1] * inp - k[3] * out + z2;
    z2 = k[2] * inp - k[4] * out;
    y[i] = out;
  }
  return y;
}
const expo = (a, b, u) => a * Math.pow(b / a, u);

// ---------- reverb (Freeverb-style) ----------
function reverb(inp, {room = 0.88, damp = 0.35, wet = 1} = {}) {
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((v) => Math.round((v * SR) / 44100));
  const apT = [556, 441, 341, 225].map((v) => Math.round((v * SR) / 44100));
  const out = [new Float32Array(inp.length), new Float32Array(inp.length)];
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch * 23;
    const combs = combT.map((t) => ({b: new Float32Array(t + spread), i: 0, s: 0}));
    const aps = apT.map((t) => ({b: new Float32Array(t + spread), i: 0}));
    for (let n = 0; n < inp.length; n++) {
      const x = inp[n] * 0.03;
      let acc = 0;
      for (const c of combs) {
        const v = c.b[c.i];
        c.s = v * (1 - damp) + c.s * damp;
        c.b[c.i] = x + c.s * room;
        if (++c.i >= c.b.length) c.i = 0;
        acc += v;
      }
      for (const a of aps) {
        const v = a.b[a.i];
        const o = -acc + v;
        a.b[a.i] = acc + v * 0.5;
        acc = o;
        if (++a.i >= a.b.length) a.i = 0;
      }
      out[ch][n] = acc * wet;
    }
  }
  return out;
}

// ---------- session ----------
function build(lang) {
  const starts = sceneStarts(lang);
  const total = totalFrames(lang);
  const dur = total / FPS;
  const N = Math.ceil((dur + 3) * SR);
  const bus = () => ({L: new Float32Array(N), R: new Float32Array(N)});
  const music = bus(), sfx = bus();
  const sendM = new Float32Array(N), sendS = new Float32Array(N);
  const F = (scene, local) => (starts[scene] + local) / FPS; // seconds
  const Ab = (frame) => frame / FPS;

  const put = (b, send, sig, t, {gain = 1, pan = 0, verb = 0} = {}) => {
    const s0 = Math.round(t * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < sig.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= N) continue;
      b.L[j] += sig[i] * gl; b.R[j] += sig[i] * gr; send[j] += sig[i] * gain * verb;
    }
  };
  const M = (sig, t, o) => put(music, sendM, sig, t, o);
  const S = (sig, t, o) => put(sfx, sendS, sig, t, o);

  // ----- instruments (return mono Float32Array) -----
  const gen = (d, fn) => Float32Array.from({length: Math.round(d * SR)}, (_, i) => fn(i / SR, i));
  const sine = (f, d, dec = 6, atk = 0.004) => gen(d, (t) => Math.sin(TAU * f * t) * Math.min(1, t / atk) * Math.exp(-t * dec));
  const pluck = (f, d = 1.2, idx = 2.2, ratio = 2, dec = 3.2) =>
    gen(d, (t) => Math.sin(TAU * f * t + idx * Math.exp(-t * 7) * Math.sin(TAU * f * ratio * t)) * Math.min(1, t / 0.003) * Math.exp(-t * dec));
  const bell = (f, d = 2.2, dec = 2.2) =>
    gen(d, (t) => (Math.sin(TAU * f * t) + 0.45 * Math.sin(TAU * f * 2.756 * t) * Math.exp(-t * 3) + 0.25 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 6)) * Math.min(1, t / 0.002) * Math.exp(-t * dec));
  const kick = (d = 0.55, f0 = 160, f1 = 44) => {
    let ph = 0;
    return gen(d, (t) => {
      const f = f1 + (f0 - f1) * Math.exp(-t * 32);
      ph += (TAU * f) / SR;
      return (Math.sin(ph) * Math.exp(-t * 7) + (t < 0.004 ? (rnd() * 2 - 1) * 0.5 : 0)) * Math.min(1, t / 0.0015);
    });
  };
  const boom = (f = 46, d = 4, dec = 1.1) => {
    let ph = 0;
    return gen(d, (t) => {
      ph += (TAU * (f + 22 * Math.exp(-t * 6))) / SR;
      return Math.sin(ph) * Math.min(1, t / 0.012) * Math.exp(-t * dec);
    });
  };
  const hat = (d = 0.05) => filt(gen(d, (t) => (rnd() * 2 - 1) * Math.exp(-t * 90)), 'hp', 7000, 0.7);
  const clap = () => {
    const x = gen(0.24, (t) => {
      const e = Math.exp(-((t % 0.012) * 0) ) * (Math.exp(-t * 26) + (t > 0.011 ? 0.6 * Math.exp(-(t - 0.011) * 60) : 0) + (t > 0.022 ? 0.5 * Math.exp(-(t - 0.022) * 60) : 0));
      return (rnd() * 2 - 1) * e;
    });
    return filt(filt(x, 'bp', 1600, 0.9), 'hp', 500, 0.7);
  };
  const click = () => {
    const a = filt(gen(0.03, (t) => (rnd() * 2 - 1) * Math.exp(-t * 300)), 'hp', 3000, 0.7);
    const b = sine(190, 0.12, 30, 0.001);
    return Float32Array.from({length: b.length}, (_, i) => (a[i] || 0) * 0.8 + b[i] * 0.7);
  };
  const tick = (f = 2600, g = 1) => gen(0.05, (t) => Math.sin(TAU * f * t) * Math.exp(-t * 90) * g);
  const pop = (f0, f1, d = 0.16) => {
    let ph = 0;
    return gen(d, (t) => {
      ph += (TAU * (f0 + (f1 - f0) * Math.min(1, t / 0.05))) / SR;
      return (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) * Math.min(1, t / 0.003) * Math.exp(-t * 26);
    });
  };
  const chimeChord = (notes, d = 2.2, dec = 2.4) => {
    const out = new Float32Array(Math.round(d * SR));
    notes.forEach((m, k) => {
      const b = bell(mtof(m), d, dec);
      const off = Math.round(k * 0.045 * SR);
      for (let i = 0; i < b.length - off; i++) out[i + off] += b[i] * 0.55;
    });
    return out;
  };
  const whoosh = (d, f0, f1, q = 1.2, peak = 0.5) => {
    const n = noise(Math.round(d * SR));
    const y = filt(n, 'bp', (i) => expo(f0, f1, i / n.length), q);
    for (let i = 0; i < y.length; i++) {
      const u = i / y.length;
      y[i] *= Math.pow(Math.sin(Math.PI * Math.pow(u, peak * 2)), 1.6) * 2.2;
    }
    return y;
  };
  const riser = (d, f0 = 300, f1 = 9000, tone0 = 110, tone1 = 880) => {
    const n = noise(Math.round(d * SR));
    const y = filt(n, 'bp', (i) => expo(f0, f1, Math.pow(i / n.length, 1.4)), 0.9);
    let ph = 0;
    for (let i = 0; i < y.length; i++) {
      const u = i / y.length;
      ph += (TAU * expo(tone0, tone1, u)) / SR;
      y[i] = (y[i] * 0.9 + Math.sin(ph) * 0.35 + 0.15 * Math.sin(ph * 2.01)) * Math.pow(u, 2.2);
    }
    return y;
  };
  const impact = (d = 3.5) => {
    const b = boom(48, d, 1.05);
    const n = filt(gen(d, (t) => (rnd() * 2 - 1) * Math.exp(-t * 3.2)), 'lp', (i) => expo(9000, 400, Math.min(1, i / SR / 1.6)), 0.7);
    const k = kick(0.5, 200, 42);
    return Float32Array.from({length: b.length}, (_, i) => b[i] * 0.95 + n[i] * 0.32 + (k[i] || 0) * 0.7);
  };
  const pad = (midis, d, {atk = 2, rel = 2.5, cut = 1400, lfo = 0.12, det = 0.006} = {}) => {
    const len = Math.round((d + rel) * SR);
    const raw = new Float32Array(len);
    for (const m of midis) {
      const f = mtof(m);
      for (const dd of [1 - det, 1 + det]) {
        let ph = rnd();
        const inc = f * dd / SR;
        for (let i = 0; i < len; i++) {
          ph += inc; if (ph > 1) ph -= 1;
          raw[i] += (2 * ph - 1) * 0.5;
        }
      }
    }
    const y = filt(raw, 'lp', (i) => cut * (0.75 + 0.25 * Math.sin(TAU * lfo * (i / SR))) , 0.9);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      y[i] *= Math.min(1, t / atk) * (t > d ? Math.max(0, 1 - (t - d) / rel) : 1) / (midis.length * 1.4);
    }
    return y;
  };

  // =========================== MUSIC ===========================
  // Arc: near-silence while "people" are the story → the pulse starts on "Barry works." → a working-day groove
  // that breathes around the story beats → full groove for the montage → a quiet night → the same morning pad
  // as the opening (bookend) → vacuum → BARRY.
  const A = starts;
  const T = (scene) => A[scene] / FPS;
  const at = (scene, local) => F(scene, local);
  const beatT = (f) => f / FPS;
  const chords = {
    morning: [62, 69, 72, 76, 81], Dm9: [50, 57, 60, 64, 65], Bbmaj7: [46, 53, 57, 60, 62], Gm9: [43, 55, 58, 62, 65],
    DmS: [38, 50, 57, 65, 69], Fadd9: [41, 53, 57, 60, 67], night: [62, 69, 74, 76],
  };
  const padAt = (chord, t0, d, gain, o) => M(pad(chords[chord], d, o), t0, {gain, verb: 0.4});
  const pent = [62, 65, 67, 69, 72, 74, 77, 81];

  // --- 07:03: a thin, high morning pad; cut dead on the black ---
  {
    const d = at('morning', Q.morning.cut) - 0.2;
    const y = pad(chords.morning, d, {atk: 2.5, rel: 0.12, cut: 2600, lfo: 0.08});
    M(y, 0.2, {gain: 0.13, verb: 0.5});
  }
  // --- the drone: born on "Barry works.", lives until the vacuum ---
  {
    const t0 = at('morning', Q.morning.systems - 6);
    const d = T('brand') - t0;
    let ph1 = 0, ph2 = 0;
    const base = gen(d, (t) => {
      ph1 += (TAU * 36.71) / SR; ph2 += (TAU * 73.42 * (1 + 0.0012 * Math.sin(t * 0.7))) / SR;
      return Math.sin(ph1) * 0.8 + (2 * ((ph2 / TAU) % 1) - 1) * 0.18;
    });
    const y = filt(base, 'lp', (i) => 140 + 220 * Math.min(1, i / SR / 60), 0.8);
    for (let k = 0; k < y.length; k++) { const t = k / SR; y[k] *= Math.min(1, t / 1.5) * Math.min(1, (d - t) / 0.05); }
    M(y, t0, {gain: 0.2, verb: 0.15});
  }
  // --- pads by chapter ---
  padAt('Dm9', at('morning', Q.morning.systems), (A.dress - A.morning - Q.morning.systems) / FPS + 0.5, 0.24, {atk: 1.2, rel: 2.5, cut: 1300});
  padAt('Bbmaj7', T('dress'), (A.escalate - A.dress) / FPS, 0.2, {atk: 1.5, rel: 2, cut: 1500});
  padAt('Gm9', T('escalate'), Q.escalate.cut / FPS, 0.22, {atk: 1, rel: 0.15, cut: 1300});
  padAt('Gm9', at('escalate', Q.escalate.t1), (A.owner - A.escalate - Q.escalate.t1) / FPS, 0.24, {atk: 0.6, rel: 1.5, cut: 1700});
  padAt('Fadd9', T('owner'), (A.supplier - A.owner) / FPS + 0.3, 0.24, {atk: 1.2, rel: 2, cut: 2000});
  padAt('DmS', at('supplier', Q.supplier.open), (A.montage - A.supplier - Q.supplier.open) / FPS, 0.34, {atk: 1, rel: 0.2, cut: 2200, lfo: 0.3});
  padAt('Dm9', T('adapt'), (A.night - A.adapt) / FPS + 0.5, 0.3, {atk: 0.4, rel: 1.5, cut: 1600});
  padAt('night', T('night'), (A.nextDay - A.night) / FPS + 0.4, 0.16, {atk: 1.2, rel: 1.2, cut: 3000, lfo: 0.05});
  M(pad(chords.morning, (A.brand - A.nextDay) / FPS - 0.06, {atk: 1.8, rel: 0.05, cut: 2600, lfo: 0.08}), T('nextDay'), {gain: 0.2, verb: 0.5});
  M(pad([38, 50, 57, 62, 69, 74], 6, {atk: 2.6, rel: 3.5, cut: 2600, lfo: 0.09}), at('brand', Q.brand.mark), {gain: 0.3, verb: 0.5});

  // --- the working-day pulse: soft kick every other beat, breathing out around story beats ---
  const kSoft = kick(0.5, 120, 46);
  const pulse = (f0, f1, gain = 0.16, every = 2) => { for (let f = f0; f < f1; f += BEAT * every) M(kSoft, beatT(f), {gain}); };
  pulse(A.morning + Q.morning.systems, A.dress, 0.14);
  pulse(A.dress, A.patience, 0.15);
  pulse(A.patience, A.patience + Q.patience.burst[0], 0.15);        // the burst plays dry…
  pulse(A.patience + Q.patience.reply, A.close5, 0.15);             // …the pulse returns with Barry's calm reply
  pulse(A.close5, A.escalate, 0.16);
  pulse(A.escalate, A.escalate + Q.escalate.cut, 0.15);
  pulse(A.owner, A.supplier, 0.13);
  pulse(A.supplier + Q.supplier.open, A.supplier + Q.supplier.submitted, 0.2, 1);

  // --- montage + systems: the groove ---
  {
    const g0 = A.montage, g1 = A.adapt;
    const bass = [38, 34, 41, 36];
    for (let f = g0, b = 0; f < g1; f += BEAT, b++) {
      const t = beatT(f), bar = Math.floor(b / 4) % 4, late = f >= A.systems;
      M(kick(0.5, 170, 44), t, {gain: 0.44});
      if (b % 2 === 1) M(clap(), t, {gain: 0.2, pan: 0.1, verb: 0.25});
      M(hat(), t + 0.25, {gain: 0.12});
      if (late) { M(hat(0.04), t + 0.125, {gain: 0.06}); M(hat(0.04), t + 0.375, {gain: 0.06}); }
      M(sine(mtof(bass[bar]), 0.46, 2.6, 0.006), t, {gain: 0.36});
      const tones = [[62, 65, 69, 74], [58, 62, 65, 70], [65, 69, 72, 77], [60, 64, 67, 72]][bar];
      for (let k = 0; k < 2; k++) M(pluck(mtof(tones[(b * 2 + k) % 4] + (late ? 12 : 0)), 0.7, 2, 2, 5), t + k * 0.25 + 0.125, {gain: 0.14, pan: k ? 0.4 : -0.4, verb: 0.4});
    }
  }

  // =========================== SFX ===========================
  const msgIn = (t, who, g = 1) => S(who === 'barry' ? pop(880, 1320, 0.2) : pop(520, 700, 0.16), t, {gain: (who === 'barry' ? 0.26 : 0.2) * g, pan: who === 'barry' ? 0.25 : -0.25, verb: 0.3});
  const notif = (t, g = 0.22) => { S(pluck(mtof(81), 0.8, 1.2, 2, 6), t, {gain: g, verb: 0.5}); S(pluck(mtof(88), 0.8, 1.2, 2, 6), t + 0.09, {gain: g * 0.8, verb: 0.5}); };
  const success = (t, g = 0.28) => S(chimeChord([74, 81, 86], 2.2, 2.4), t, {gain: g, verb: 0.55});
  const check = (t, m = 86, g = 0.14) => S(pluck(mtof(m), 0.6, 1.4, 3, 7), t, {gain: g, verb: 0.35, pan: 0.2});
  const hit = (t, g = 0.8, d = 3.2) => S(impact(d), t, {gain: g, verb: 0.35});
  const typing = (t0, t1, g = 0.05) => { for (let t = t0; t < t1; t += 0.11) S(tick(1800 + (Math.round(t * 100) % 3) * 90, 0.4), t, {gain: g, verb: 0.2}); };
  const air = (t, g = 0.08) => S(chimeChord([86, 93], 1.6, 3.2), t, {gain: g, verb: 0.7});

  // morning
  const mo = Q.morning;
  notif(at('morning', mo.notif), 0.24);
  notif(at('morning', mo.barry), 0.2);
  S(chimeChord([69, 74, 81], 1.8, 3), at('morning', mo.barry + 3), {gain: 0.1, verb: 0.6});
  check(at('morning', mo.b2), 81, 0.09); check(at('morning', mo.b3), 84, 0.1);
  for (let k = 0; k < 6; k++) S(tick(2400 + k * 140, 0.5), at('morning', mo.log + 14 + k * 18), {gain: 0.035, pan: 0.6, verb: 0.4});
  // the cut: nothing. then the business keeps moving…
  air(at('morning', mo.t1), 0.05);
  for (let k = 0; k < 4; k++) S(tick(2600 + k * 200, 0.6), at('morning', mo.systems + 4 + k * 5), {gain: 0.06, pan: (k - 1.5) * 0.4, verb: 0.5});
  hit(at('morning', mo.t2), 0.75, 3.4);
  S(chimeChord([62, 69, 74, 81], 3.4, 1.2), at('morning', mo.t2 + 2), {gain: 0.16, verb: 0.7});

  // dress / close
  const d = Q.dress;
  msgIn(at('dress', d.c1), 'customer');
  typing(at('dress', d.typing + 2), at('dress', d.b1 - 2));
  msgIn(at('dress', d.b1), 'barry');
  S(boom(60, 1.6, 2.4), at('dress', d.pull - 2), {gain: 0.45, verb: 0.3});
  S(whoosh(0.9, 200, 5000, 0.9, 0.6), at('dress', d.pull), {gain: 0.26, verb: 0.35});
  for (let k = 0; k < 6; k++) M(pluck(mtof(pent[k + 1]), 1.5), at('dress', d.factStart + k * d.factGap), {gain: 0.17, pan: (k - 2.5) * 0.3, verb: 0.55});
  for (let k = 0; k < 6; k++) check(at('dress', d.verify + k * 5), 81 + k * 2, 0.11);
  S(whoosh(0.8, 6000, 250, 1.1, 0.8), at('dress', d.collapse), {gain: 0.3, verb: 0.3});
  S(kick(0.7, 110, 40), at('dress', d.collapse + 24), {gain: 0.45});
  S(tick(3000, 0.7), at('dress', d.shift + 2), {gain: 0.09, verb: 0.4}); // clock roll
  msgIn(at('dress', d.c2), 'customer');
  for (let k = 0; k < 3; k++) S(tick(2200 + k * 200, 1), at('dress', d.rowStart + k * d.rowGap), {gain: 0.1, pan: 0.3, verb: 0.35});
  typing(at('dress', d.typing2 + 2), at('dress', d.b2 - 2));
  msgIn(at('dress', d.b2), 'barry');
  msgIn(at('dress', d.link), 'barry', 0.7);
  success(at('dress', d.payDone), 0.3);
  check(at('dress', d.order), 88, 0.14);

  // patience
  const pa = Q.patience;
  S(tick(3000, 0.7), at('patience', 2), {gain: 0.09, verb: 0.4});
  pa.burst.forEach((f, k) => S(pop(500 + (k % 2) * 60, 660 + (k % 3) * 40, 0.14), at('patience', f), {gain: 0.2 + k * 0.012, pan: -0.3, verb: 0.2}));
  typing(at('patience', pa.typing + 2), at('patience', pa.reply - 2));
  msgIn(at('patience', pa.reply), 'barry');
  S(chimeChord([69, 74, 78], 2.0, 2.4), at('patience', pa.reply + 2), {gain: 0.12, verb: 0.55});
  check(at('patience', pa.checked + 20), 84, 0.1);
  hit(at('patience', pa.t1), 0.3, 2.2);
  hit(at('patience', pa.t2), 0.5, 2.8);

  // close5
  const c5 = Q.close5;
  S(tick(3000, 0.7), at('close5', 2), {gain: 0.09, verb: 0.4});
  msgIn(at('close5', c5.c1), 'customer');
  typing(at('close5', c5.typing + 2), at('close5', c5.b1 - 2));
  msgIn(at('close5', c5.b1), 'barry');
  { const g = gen(0.7, (t) => Math.sin(TAU * expo(300, 700, t / 0.7) * t) * Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.5) * 12)); S(g, at('close5', c5.zone), {gain: 0.1, verb: 0.4}); }
  S(click(), at('close5', c5.lock), {gain: 0.32}); check(at('close5', c5.lock + 2), 86, 0.16);
  msgIn(at('close5', c5.c2), 'customer');
  for (let k = 0; k < 3; k++) check(at('close5', c5.after + k * c5.afterGap), 81 + k * 3, 0.14);
  success(at('close5', c5.after + 2 * c5.afterGap), 0.3);

  // escalate
  const e = Q.escalate;
  S(tick(3000, 0.7), at('escalate', 2), {gain: 0.09, verb: 0.4});
  msgIn(at('escalate', e.c1), 'customer');
  typing(at('escalate', e.typing + 2), at('escalate', e.b1 - 2));
  msgIn(at('escalate', e.b1), 'barry');
  S(whoosh(0.6, 500, 4000, 1.1, 0.5), at('escalate', e.send), {gain: 0.18, verb: 0.35});
  S(chimeChord([69, 72], 1.8, 2), at('escalate', e.card + 4), {gain: 0.16, verb: 0.6}); // amber: needs the owner
  for (let k = 0; k < 6; k++) S(tick(2100 + k * 150, 1), at('escalate', e.card + 8 + k * 5), {gain: 0.07, pan: 0.3, verb: 0.35});
  msgIn(at('escalate', e.c2), 'customer', 0.8);
  S(click(), at('escalate', e.tap), {gain: 0.5, verb: 0.15});
  S(kick(0.6, 110, 44), at('escalate', e.tap), {gain: 0.28});
  success(at('escalate', e.resolve + 2), 0.36);
  S(whoosh(0.6, 500, 4000, 1.1, 0.5), at('escalate', e.back), {gain: 0.18, verb: 0.35});
  typing(at('escalate', e.typing2 + 2), at('escalate', e.b2 - 2));
  msgIn(at('escalate', e.b2), 'barry');
  check(at('escalate', e.paid), 88, 0.16);
  hit(at('escalate', e.t1), 0.4, 2.6);
  hit(at('escalate', e.t2), 0.72, 3.4);

  // owner
  const o = Q.owner;
  S(tick(3000, 0.7), at('owner', 2), {gain: 0.09, verb: 0.4});
  S(pop(700, 1050, 0.18), at('owner', o.q1), {gain: 0.18, pan: 0.3, verb: 0.3});
  typing(at('owner', o.typing + 2), at('owner', o.b1 - 2));
  [o.b1, o.b2, o.b3].forEach((f) => msgIn(at('owner', f), 'barry', 0.85));
  for (let k = 0; k < 3; k++) S(tick(2000 + k * 200), at('owner', o.strip + k * o.stripGap), {gain: 0.1, verb: 0.35, pan: 0.4});
  S(pop(700, 1050, 0.18), at('owner', o.q2), {gain: 0.18, pan: 0.3, verb: 0.3});
  typing(at('owner', o.typing2 + 2), at('owner', o.b4 - 2));
  msgIn(at('owner', o.b4), 'barry');
  S(whoosh(0.7, 3000, 300, 1, 0.7), at('owner', o.cardStart - 12), {gain: 0.18, verb: 0.3});
  for (let k = 0; k < 3; k++) S(chimeChord([pent[(k + 3) % 8] + 12, pent[(k + 5) % 8] + 12], 2, 2.2), at('owner', o.cardStart + k * o.cardGap + 4), {gain: 0.14, verb: 0.6});

  // supplier (hero)
  const s = Q.supplier;
  S(tick(3000, 0.7), at('supplier', 2), {gain: 0.09, verb: 0.4});
  S(pop(700, 1050, 0.18), at('supplier', s.ownerMsg), {gain: 0.2, pan: 0.3, verb: 0.3});
  typing(at('supplier', s.typing + 2), at('supplier', s.barryReply - 2));
  msgIn(at('supplier', s.barryReply), 'barry');
  S(chimeChord([69, 74, 78], 2.0, 2.4), at('supplier', s.barryReply + 3), {gain: 0.14, verb: 0.55});
  hit(at('supplier', s.open), 0.85, 3.4);
  S(riser(3.4, 250, 10000, 100, 1200), at('supplier', s.open + 2), {gain: 0.3, verb: 0.3});
  for (let k = 0; k < 9; k++) { S(tick(2200 + k * 160, 1), at('supplier', s.nodeStart + k * s.nodeGap + 2), {gain: 0.09, pan: Math.sin(k * 1.7) * 0.6, verb: 0.3}); M(pluck(mtof(pent[k % 8]), 1.4, 2.6), at('supplier', s.nodeStart + k * s.nodeGap), {gain: 0.18, pan: Math.sin(k * 1.7) * 0.6, verb: 0.55}); }
  S(chimeChord([74, 81, 86, 89], 3.2, 1.3), at('supplier', s.understand), {gain: 0.22, verb: 0.7});
  S(whoosh(0.9, 6000, 150, 1.2, 0.9), at('supplier', s.converge - 4), {gain: 0.32, verb: 0.3});
  S(kick(0.9, 130, 38), at('supplier', s.converge + 20), {gain: 0.6});
  S(whoosh(0.6, 400, 3000, 1, 0.5), at('supplier', s.suppliers - 2), {gain: 0.15, verb: 0.3});
  S(click(), at('supplier', s.select), {gain: 0.36});
  for (let k = 0; k < 4; k++) check(at('supplier', s.reasonStart + k * s.reasonGap + 3), 84 + k * 2, 0.12);
  S(whoosh(0.5, 300, 2500, 1, 0.5), at('supplier', s.po - 2), {gain: 0.15, verb: 0.3});
  check(at('supplier', s.authOK), 84, 0.18);
  hit(at('supplier', s.submitted), 0.8, 3.6); success(at('supplier', s.submitted + 3), 0.28);
  S(whoosh(0.8, 300, 2600, 1, 0.5), at('supplier', s.phoneBack - 2), {gain: 0.16, verb: 0.4});
  msgIn(at('supplier', s.done), 'barry');
  S(chimeChord([65, 72, 77, 84], 3.4, 1.5), at('supplier', s.done + 2), {gain: 0.24, verb: 0.7});
  S(riser(1.6, 500, 9000, 150, 1200), T('montage') - 1.6, {gain: 0.26, verb: 0.2});

  // montage: an impact per cut, a pluck per resolved chip
  for (let k = 0; k < 6; k++) {
    const f0 = Q.montage.start + k * Q.montage.gap;
    S(kick(0.5, 200, 44), at('montage', f0), {gain: 0.35});
    S(whoosh(0.35, 3000, 600, 1, 0.4), at('montage', f0) - 0.06, {gain: 0.1});
    for (let c = 0; c < 3; c++) check(at('montage', f0 + 7 + c * 5), pent[(k + c) % 8] + 12, 0.08);
  }
  // systems: words on the beat
  const sy = Q.systems;
  hit(at('systems', sy.w1), 0.4, 2); hit(at('systems', sy.w2), 0.45, 2); hit(at('systems', sy.w3), 0.8, 3.2);
  S(chimeChord([62, 69, 74, 81], 3, 1.2), at('systems', sy.w3), {gain: 0.2, verb: 0.7});
  // adapt: groove stops dead; the line lands in the air
  S(boom(44, 3, 1.4), T('adapt'), {gain: 0.5, verb: 0.3});
  hit(at('adapt', Q.adapt.l2), 0.65, 3.4);
  // night
  const n = Q.night;
  S(tick(3000, 0.7), at('night', 2), {gain: 0.07, verb: 0.5});
  for (let k = 0; k < 3; k++) S(bell(mtof([81, 86, 93][k]), 2, 2.2), at('night', n.e1 + k * n.gap), {gain: 0.1, verb: 0.7});
  S(boom(50, 2.6, 1.4), at('night', n.t), {gain: 0.35, verb: 0.4});
  // next day
  const nd = Q.nextDay;
  S(tick(3000, 0.7), at('nextDay', 2), {gain: 0.08, verb: 0.4});
  notif(at('nextDay', nd.barry), 0.2);
  check(at('nextDay', nd.b2), 81, 0.08);
  notif(at('nextDay', nd.employee), 0.18);

  // brand: vacuum, a point of light, then the name
  const r = Q.brand;
  S(sine(3520, 2.6, 1.8, 0.02), at('brand', r.point), {gain: 0.13, verb: 0.9});
  S(riser(0.9, 800, 7000, 300, 1400), at('brand', r.line), {gain: 0.13, verb: 0.5});
  S(boom(38, 6, 0.62), at('brand', r.mark), {gain: 0.6, verb: 0.35});
  S(chimeChord([62, 69, 74, 81], 4.4, 0.9), at('brand', r.mark + 3), {gain: 0.28, verb: 0.8});
  hit(at('brand', r.works), 0.55, 3.4);
  S(chimeChord([86, 93], 3.4, 1.3), at('brand', r.soon), {gain: 0.13, verb: 0.8});

  // ----- master -----
  const revM = reverb(sendM, {room: 0.9, damp: 0.4});
  const revS = reverb(sendS, {room: 0.86, damp: 0.35});
  const L = new Float32Array(N), R = new Float32Array(N);
  const vac = A.brand / FPS; // audio vacuum: everything before it is cut at this instant, then only brand sound
  for (let i = 0; i < N; i++) {
    L[i] = music.L[i] * 0.9 + revM[0][i] * 0.55 + sfx.L[i] * 1.0 + revS[0][i] * 0.6;
    R[i] = music.R[i] * 0.9 + revM[1][i] * 0.55 + sfx.R[i] * 1.0 + revS[1][i] * 0.6;
  }
  // vacuum: fade everything to zero across the last 60ms before the brand scene, restore after (brand-scene material starts >= point cue)
  const vStart = Math.round((vac - 0.06) * SR), vEnd = Math.round(vac * SR);
  const vResume = Math.round((vac + (r.point - 2) / FPS) * SR);
  for (let i = vStart; i < vResume && i < N; i++) {
    const g = i < vEnd ? 1 - (i - vStart) / (vEnd - vStart) : 0;
    L[i] *= g; R[i] *= g;
  }
  // gentle end fade
  const endS = Math.round(dur * SR), fadeN = Math.round(2.4 * SR);
  for (let i = 0; i < N; i++) {
    let g = 1;
    if (i > endS - fadeN) g = Math.max(0, (endS - i) / fadeN);
    L[i] *= g; R[i] *= g;
  }
  return {L, R, N, dur, endS};
}

function softclip(x) { return Math.tanh(x * 1.15) / Math.tanh(1.15); }

function writeWav(file, L, R, n) {
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

const langs = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ['he', 'en'];
fs.mkdirSync(path.join(root, 'public/audio'), {recursive: true});
for (const lang of langs) {
  seed = 1234567;
  const {L, R, N, endS} = build(lang);
  // normalise: peak to -1.5 dBFS after a soft clip, with headroom
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.7 / peak; // after the soft clip: sample peak ≈ -1.8 dBFS, leaving ~1 dB true-peak headroom after AAC
  for (let i = 0; i < N; i++) { L[i] = softclip(L[i] * g); R[i] = softclip(R[i] * g); }
  const n = endS;
  const wav = path.join(root, `public/audio/mix-${lang}.wav`);
  writeWav(wav, L, R, n);
  const ff = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg');
  const mp3 = path.join(root, `public/audio/mix-${lang}.mp3`);
  execFileSync(ff, ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '256k', mp3], {env: {...process.env, LD_LIBRARY_PATH: path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu')}});
  console.log(`audio ${lang}: ${(n / SR).toFixed(2)}s peak-normalised -> ${mp3}`);
}
