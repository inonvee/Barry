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
  const A = starts;
  const endF = total;
  // Drone: D1 + filtered D2, breathing across the entire film until the vacuum at brand.
  {
    const cutT = (A.brand) / FPS; // hard stop at the vacuum
    const d = cutT;
    let ph1 = 0, ph2 = 0;
    const base = gen(d, (t) => {
      const swell = Math.min(1, t / 5) * (0.55 + 0.45 * Math.min(1, t / 40));
      ph1 += (TAU * 36.71) / SR; ph2 += (TAU * 73.42 * (1 + 0.0012 * Math.sin(t * 0.7))) / SR;
      return (Math.sin(ph1) * 0.8 + (2 * ((ph2 / TAU) % 1) - 1) * 0.18) * swell;
    });
    const y = filt(base, 'lp', (i) => 140 + 260 * Math.min(1, i / SR / 50), 0.8);
    // fade in first 3.5s, out over the final 0.05s (vacuum)
    for (let i = 0; i < y.length; i++) {
      const t = i / SR;
      y[i] *= Math.min(1, t / 3.5) * Math.min(1, (d - t) / 0.06);
    }
    M(y, 0, {gain: 0.2, verb: 0.15});
  }
  // Pad progression by scene
  const chords = {
    Dm9: [50, 57, 60, 64, 65], Bbmaj7: [46, 53, 57, 60, 62], Gm9: [43, 55, 58, 62, 65], DmS: [38, 50, 57, 65, 69], Fadd9: [41, 53, 57, 60, 67], Cadd: [36, 48, 55, 60, 64],
  };
  const padAt = (chord, tStart, d, gain, o) => M(pad(chords[chord], d, o), tStart, {gain, verb: 0.35});
  padAt('Dm9', F('open', 138), (A.operate - A.open) / FPS - 4.6 + 0.3, 0.26, {atk: 3, rel: 3.2, cut: 1100});
  padAt('Bbmaj7', F('operate', 0) - 0.5, (A.authority - A.operate) / FPS + 0.3, 0.28, {atk: 2.2, rel: 3, cut: 1500});
  padAt('Gm9', F('authority', 0) - 0.5, (A.supplier - A.authority) / FPS + 0.2, 0.26, {atk: 2, rel: 2.5, cut: 1300});
  padAt('DmS', F('supplier', 98) - 0.3, (A.owner - A.supplier - 98) / FPS + 0.6, 0.4, {atk: 1.2, rel: 2.2, cut: 2000, lfo: 0.3});
  padAt('Fadd9', F('owner', 0), (A.scale - A.owner) / FPS + 0.2, 0.3, {atk: 1.6, rel: 2, cut: 2200});
  // Brand: open D–A shimmer, only after the boom
  M(pad([38, 50, 57, 62, 69, 74], 6, {atk: 2.6, rel: 3.5, cut: 2600, lfo: 0.09}), F('brand', 52), {gain: 0.42, verb: 0.5});

  // Heartbeat pulse (very soft) under verify/operate/authority
  const beatT = (f) => f / FPS;
  const kSoft = kick(0.5, 120, 46);
  for (let f = A.verify + Q.verify.pull; f < A.operate + Q.operate.flashStart - 4; f += BEAT * 2) M(kSoft, beatT(f), {gain: 0.16});
  // Arp plucks: D minor pentatonic, sparse, follow the facts assembling
  const pent = [62, 65, 67, 69, 72, 74, 77, 81];
  for (let i = 0; i < 5; i++) M(pluck(mtof(pent[i + 1]), 1.6), F('verify', Q.verify.factStart + i * Q.verify.factGap), {gain: 0.2, pan: (i - 2) * 0.35, verb: 0.55});
  // Scene 3 flashes: kick+hat on each beat, pitched blips rising
  for (let i = 0; i < 5; i++) {
    const t = F('operate', Q.operate.flashStart + i * Q.operate.flashGap);
    M(kick(), t, {gain: 0.5});
    M(hat(), t + 0.25, {gain: 0.14});
    M(pluck(mtof(pent[i + 2]), 1.2, 2.5), t, {gain: 0.26, pan: (i - 2) * 0.3, verb: 0.45});
  }
  // Supplier: 16th arpeggio as nodes appear, world riser, implosion
  for (let i = 0; i < 7; i++) M(pluck(mtof(pent[i + 1]), 1.5, 2.6), F('supplier', Q.supplier.nodeStart + i * Q.supplier.nodeGap), {gain: 0.24, pan: Math.sin(i * 1.7) * 0.6, verb: 0.55});
  // Scale montage: groove
  const s7 = A.scale;
  const bass = [38, 34, 41, 36]; // D, Bb, F, C (one per bar)
  const beats = Math.floor((Q.scale.one2 + 45) / BEAT);
  for (let b = 0; b < beats; b++) {
    const t = beatT(s7 + b * BEAT);
    const bar = Math.floor(b / 4) % 4;
    M(kick(0.5, 170, 44), t, {gain: 0.62});
    if (b % 2 === 1) M(clap(), t, {gain: 0.22, pan: 0.1, verb: 0.25});
    M(hat(), t + 0.25, {gain: 0.12 + (b >= 7 ? 0.05 : 0)});
    if (b >= 7) M(hat(0.04), t + 0.125, {gain: 0.06}), M(hat(0.04), t + 0.375, {gain: 0.06});
    M(sine(mtof(bass[bar]), 0.46, 2.6, 0.006), t + 0.0, {gain: 0.5});
    // arp on 8ths from chord tones
    const tones = [[62, 65, 69, 74], [58, 62, 65, 70], [65, 69, 72, 77], [60, 64, 67, 72]][bar];
    for (let k = 0; k < 2; k++) M(pluck(mtof(tones[(b * 2 + k) % 4] + (b >= 7 ? 12 : 0)), 0.7, 2, 2, 5), t + k * 0.25 + 0.125, {gain: 0.16, pan: k ? 0.4 : -0.4, verb: 0.4});
  }

  // =========================== SFX ===========================
  const at = (scene, local) => F(scene, local);
  const msgIn = (t, who) => S(who === 'barry' ? Float32Array.from(pop(880, 1320, 0.2)) : pop(520, 700, 0.16), t, {gain: who === 'barry' ? 0.3 : 0.24, pan: who === 'barry' ? 0.25 : -0.25, verb: 0.3});
  const success = (t, g = 0.3) => S(chimeChord([74, 81, 86], 2.2, 2.4), t, {gain: g, verb: 0.55});
  const check = (t, m = 86, g = 0.16) => S(pluck(mtof(m), 0.6, 1.4, 3, 7), t, {gain: g, verb: 0.35, pan: 0.2});
  const hit = (t, g = 0.8, d = 3.2) => S(impact(d), t, {gain: g, verb: 0.35});
  const soft = (t, g = 0.4) => S(boom(52, 2.4, 1.6), t, {gain: g, verb: 0.3});
  const air = (t, g = 0.18) => S(chimeChord([86, 93], 1.6, 3.2), t, {gain: g, verb: 0.7});

  // open
  const o = Q.open;
  [o.l1, o.l2, o.l3].forEach((l, i) => { S(tick(2400 + i * 300, 0.5), at('open', l + 3), {gain: 0.16, verb: 0.6}); air(at('open', l), 0.07); });
  S(whoosh(1.4, 400, 3200, 1, 0.7), at('open', o.l4 - 6), {gain: 0.22, verb: 0.4});
  S(chimeChord([69, 76, 81], 3.4, 1.4), at('open', o.l4 + 22), {gain: 0.22, verb: 0.7});

  // verify
  const v = Q.verify;
  S(tick(3000, 0.6), at('verify', v.header), {gain: 0.1, verb: 0.4});
  msgIn(at('verify', v.c1), 'customer');
  for (let i = 0; i < 3; i++) S(tick(1700 + i * 120, 0.5), at('verify', v.typing + 4 + i * 8), {gain: 0.08, verb: 0.3});
  for (let i = 0; i < 6; i++) S(tick(1900, 0.4), at('verify', v.typing + 4 + i * 6), {gain: 0.06, verb: 0.25});
  msgIn(at('verify', v.b1), 'barry');
  S(chimeChord([69, 74, 81], 1.8, 3), at('verify', v.b1 + 2), {gain: 0.14, verb: 0.5});
  S(boom(60, 1.6, 2.4), at('verify', v.pull - 2), {gain: 0.5, verb: 0.3}); // the freeze
  S(whoosh(0.9, 200, 5000, 0.9, 0.6), at('verify', v.pull), {gain: 0.28, verb: 0.35});
  for (let i = 0; i < 5; i++) S(tick(2000 + i * 260, 1), at('verify', v.factStart + i * v.factGap), {gain: 0.2, pan: (i - 2) * 0.3, verb: 0.4});
  for (let i = 0; i < 5; i++) check(at('verify', v.verify + i * 6), 81 + i * 2, 0.15);
  S(whoosh(0.9, 6000, 250, 1.1, 0.8), at('verify', v.collapse), {gain: 0.34, verb: 0.3});
  S(kick(0.7, 110, 40), at('verify', v.collapse + 26), {gain: 0.6});
  S(sine(mtof(93), 1.4, 3), at('verify', v.collapse + 26), {gain: 0.12, verb: 0.7});
  hit(at('verify', v.h1), 0.35, 2.4);
  hit(at('verify', v.h2), 0.62, 3.2);
  success(at('verify', v.h2 + 8), 0.16);

  // operate
  const p = Q.operate;
  msgIn(at('operate', p.c2), 'customer');
  S(pluck(mtof(81), 1.6, 2.2), at('operate', p.c2 + 16), {gain: 0.18, verb: 0.6});
  for (let i = 0; i < 4; i++) S(tick(2200 + i * 200, 1), at('operate', p.rowStart + i * p.rowGap), {gain: 0.15, pan: 0.3, verb: 0.35});
  for (let i = 0; i < 4; i++) check(at('operate', p.rowStart + i * p.rowGap + 4), 84 + i, 0.09);
  for (let k = 0; k < 7; k++) S(tick(1200 + (k % 2) * 200, 0.6), at('operate', p.pay + k * 3.2), {gain: 0.07, verb: 0.2});
  success(at('operate', p.payDone), 0.34);
  msgIn(at('operate', p.b2), 'barry');
  S(chimeChord([76, 83, 88], 1.6, 3), at('operate', p.b2 + 4), {gain: 0.14, verb: 0.5});
  S(riser(0.9, 500, 8000, 200, 1000), at('operate', p.flashStart - 28), {gain: 0.26, verb: 0.2});
  S(whoosh(0.8, 3000, 120, 1.2, 0.85), at('operate', p.title1 - 4), {gain: 0.32, verb: 0.3});
  hit(at('operate', p.title1), 0.42, 2.4);
  hit(at('operate', p.title2), 0.95, 3.6);

  // authority
  const a = Q.authority;
  msgIn(at('authority', a.c3), 'customer');
  msgIn(at('authority', a.hold), 'barry');
  S(whoosh(0.7, 300, 3500, 1, 0.5), at('authority', a.card - 2), {gain: 0.22, verb: 0.35});
  for (let i = 0; i < 4; i++) S(tick(2100 + i * 180, 1), at('authority', a.card + 8 + i * 8), {gain: 0.13, pan: 0.3, verb: 0.35});
  {
    // gauge fills: rising sine
    const g = gen(0.9, (t) => Math.sin(TAU * expo(300, 900, t / 0.9) * t) * Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.6) * 12));
    S(g, at('authority', a.gauge), {gain: 0.13, verb: 0.4});
  }
  S(chimeChord([69, 72], 1.8, 2), at('authority', a.need), {gain: 0.17, verb: 0.6}); // amber: needs the owner
  S(tick(2600), at('authority', a.buttons), {gain: 0.1});
  S(click(), at('authority', a.tap), {gain: 0.55, verb: 0.15});
  S(kick(0.6, 110, 44), at('authority', a.tap), {gain: 0.32});
  success(at('authority', a.resolve + 2), 0.42);
  S(whoosh(0.6, 500, 4000, 1.1, 0.5), at('authority', a.travel), {gain: 0.22, verb: 0.35});
  msgIn(at('authority', a.reply), 'barry');
  S(whoosh(0.7, 400, 2600, 1, 0.6), at('authority', a.exit - 2), {gain: 0.18, verb: 0.3});
  hit(at('authority', a.h1), 0.4, 2.6);
  hit(at('authority', a.h2), 0.7, 3.4);
  // tension rise into procurement
  S(riser(2.2, 400, 6000, 90, 520), at('authority', a.h2 + 12), {gain: 0.26, verb: 0.25});

  // supplier (hero)
  const s = Q.supplier;
  S(whoosh(1.0, 300, 2400, 1, 0.5), at('supplier', s.phoneIn), {gain: 0.14, verb: 0.4});
  S(pop(700, 1050, 0.18), at('supplier', s.ownerMsg), {gain: 0.2, pan: 0.3, verb: 0.3}); // owner "sent"
  for (let i = 0; i < 6; i++) S(tick(1800, 0.4), at('supplier', s.typing + 4 + i * 4), {gain: 0.06, verb: 0.25});
  msgIn(at('supplier', s.barryReply), 'barry');
  S(chimeChord([69, 74, 78], 2.0, 2.4), at('supplier', s.barryReply + 3), {gain: 0.16, verb: 0.55});
  hit(at('supplier', s.open), 0.85, 3.4); // world opens
  S(riser(3.4, 250, 10000, 100, 1200), at('supplier', s.open + 2), {gain: 0.34, verb: 0.3});
  S(chimeChord([62, 69, 74], 3, 1.2), at('supplier', s.core), {gain: 0.18, verb: 0.7});
  for (let i = 0; i < 7; i++) S(tick(2200 + i * 210, 1), at('supplier', s.nodeStart + i * s.nodeGap + 2), {gain: 0.11, pan: Math.sin(i * 1.7) * 0.6, verb: 0.3});
  S(chimeChord([74, 81, 86, 89], 3.2, 1.3), at('supplier', s.understand), {gain: 0.24, verb: 0.7});
  S(whoosh(0.9, 6000, 150, 1.2, 0.9), at('supplier', s.converge - 4), {gain: 0.34, verb: 0.3});
  S(kick(0.9, 130, 38), at('supplier', s.converge + 22), {gain: 0.65});
  S(whoosh(0.6, 400, 3000, 1, 0.5), at('supplier', s.suppliers - 2), {gain: 0.16, verb: 0.3});
  S(click(), at('supplier', s.select), {gain: 0.4}); check(at('supplier', s.select + 2), 88, 0.16);
  S(whoosh(0.5, 300, 2500, 1, 0.5), at('supplier', s.po - 2), {gain: 0.16, verb: 0.3});
  check(at('supplier', s.authOK), 84, 0.2);
  hit(at('supplier', s.submitted), 0.8, 3.6); success(at('supplier', s.submitted + 3), 0.3);
  S(bell(mtof(93), 2, 2), at('supplier', s.eta), {gain: 0.1, verb: 0.6});
  S(whoosh(0.8, 300, 2600, 1, 0.5), at('supplier', s.phoneBack - 2), {gain: 0.18, verb: 0.4});
  msgIn(at('supplier', s.done), 'barry');
  S(chimeChord([65, 72, 77, 84], 3.4, 1.5), at('supplier', s.done + 2), {gain: 0.26, verb: 0.7});

  // owner
  const w = Q.owner;
  S(tick(2400), at('owner', w.q1), {gain: 0.1, verb: 0.4});
  hit(at('owner', w.title), 0.4, 2.6);
  for (let i = 0; i < 3; i++) { S(tick(2000 + i * 200), at('owner', w.itemStart + i * w.itemGap), {gain: 0.16, verb: 0.35}); S(pluck(mtof(pent[i + 3]), 1.4, 2.2), at('owner', w.itemStart + i * w.itemGap + 3), {gain: 0.16, verb: 0.55, pan: 0.3}); }
  S(whoosh(0.7, 3000, 200, 1, 0.7), at('owner', w.itemsOut - 2), {gain: 0.24, verb: 0.3});
  S(tick(2400), at('owner', w.q2 + 4), {gain: 0.1, verb: 0.4});
  for (let i = 0; i < 4; i++) {
    const t = at('owner', w.cardStart + i * w.cardGap);
    S(whoosh(0.5, 400, 3000, 1, 0.5), t - 0.05, {gain: 0.1, verb: 0.3});
    S(chimeChord([pent[(i + 3) % 8] + 12, pent[(i + 5) % 8] + 12], 2, 2.2), t + 0.15, {gain: 0.16, verb: 0.6});
  }
  S(riser(2.0, 500, 9000, 150, 1200), at('owner', 300 - 62) , {gain: 0.28, verb: 0.2}); // pre-drop rise into the montage

  // scale
  const c = Q.scale;
  for (let i = 0; i < 11; i++) {
    const f = i < 7 ? c.wordStart + i * c.wordGap : c.graph + (i - 7) * 11;
    S(pluck(mtof(pent[i % 8] + 12), 0.9, 2.4, 3, 4), at('scale', f + 1), {gain: 0.14, pan: Math.sin(i * 2.1) * 0.7, verb: 0.4});
  }
  S(riser(1.5, 300, 9500, 200, 1500), at('scale', c.graph), {gain: 0.28, verb: 0.15});
  hit(at('scale', c.one1), 0.7, 3.0);
  S(whoosh(0.5, 800, 9000, 1, 0.5), at('scale', c.one1 - 3), {gain: 0.18});
  hit(at('scale', c.one2), 1.0, 3.6);
  S(chimeChord([62, 69, 74, 81], 3.2, 1.1), at('scale', c.one2), {gain: 0.28, verb: 0.7});

  // brand: vacuum, then a single point of light
  const r = Q.brand;
  S(sine(3520, 2.6, 1.8, 0.02), at('brand', r.point), {gain: 0.14, verb: 0.9});
  S(riser(0.9, 800, 7000, 300, 1400), at('brand', r.line), {gain: 0.14, verb: 0.5});
  S(boom(38, 6, 0.62), at('brand', r.mark), {gain: 0.95, verb: 0.35});
  S(chimeChord([62, 69, 74, 81], 4.4, 0.9), at('brand', r.mark + 3), {gain: 0.3, verb: 0.8});
  S(tick(2400), at('brand', r.tag1), {gain: 0.1, verb: 0.5});
  S(tick(2600), at('brand', r.tag2), {gain: 0.1, verb: 0.5});
  S(chimeChord([86, 93], 3.4, 1.3), at('brand', r.soon), {gain: 0.14, verb: 0.8});

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
  const g = 0.95 / peak;
  for (let i = 0; i < N; i++) { L[i] = softclip(L[i] * g); R[i] = softclip(R[i] * g); }
  const n = endS;
  const wav = path.join(root, `public/audio/mix-${lang}.wav`);
  writeWav(wav, L, R, n);
  const ff = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg');
  const mp3 = path.join(root, `public/audio/mix-${lang}.mp3`);
  execFileSync(ff, ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '256k', mp3], {env: {...process.env, LD_LIBRARY_PATH: path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu')}});
  console.log(`audio ${lang}: ${(n / SR).toFixed(2)}s peak-normalised -> ${mp3}`);
}
