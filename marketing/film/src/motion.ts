// Barry motion grammar. Every animation in the film is built from these primitives so the
// whole piece shares one physics: soft arrivals, decisive impacts, quiet exits.
import {Easing, interpolate, spring} from 'remotion';

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export const EASE = {
  out: Easing.bezier(0.16, 1, 0.3, 1), // expo-ish settle — the default "arrival"
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.7, 0, 0.84, 0),
  snap: Easing.bezier(0.22, 1, 0.36, 1),
  glide: Easing.bezier(0.33, 0, 0.1, 1),
} as const;

export const SPRING = {
  soft: {damping: 200}, // no overshoot
  firm: {damping: 34, stiffness: 140, mass: 1},
  impact: {damping: 24, stiffness: 240, mass: 0.9},
} as const;

/** 0→1 over `dur` frames starting at `start`, eased. The workhorse. */
export const prog = (frame: number, start: number, dur: number, easing: (t: number) => number = EASE.out) =>
  interpolate(frame, [start, start + dur], [0, 1], {...clamp, easing});

/** Spring-based arrival with zero overshoot, stretched to a fixed duration. */
export const enterSoft = (frame: number, fps: number, delay = 0, dur = 36) =>
  spring({frame: frame - delay, fps, config: SPRING.soft, durationInFrames: dur});

/** Slightly firmer arrival with a whisper of overshoot — for hard landings (cards, numbers). */
export const enterImpact = (frame: number, fps: number, delay = 0, dur = 28) =>
  spring({frame: frame - delay, fps, config: SPRING.impact, durationInFrames: dur});

/** 0→1 exit progress. */
export const exitSoft = (frame: number, at: number, dur = 16) => prog(frame, at, dur, EASE.inOut);

export const stagger = (i: number, gap = 6) => i * gap;

/** Slow breathing 0..1. Deterministic — driven by frame only. */
export const systemPulse = (frame: number, period = 90, phase = 0) =>
  0.5 + 0.5 * Math.sin(((frame + phase) / period) * Math.PI * 2);

/** Progress of a light travelling along a connection. */
export const connectionTravel = (frame: number, start: number, dur = 24) => prog(frame, start, dur, EASE.inOut);

/** Camera push: eased scale + drift over a window. Returns style props for a wrapper. */
export const cameraPush = (frame: number, start: number, dur: number, from: number, to: number) =>
  interpolate(frame, [start, start + dur], [from, to], {...clamp, easing: EASE.glide});

/** Deterministic pseudo-random 0..1 from an integer seed (no Math.random in renders). */
export const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
