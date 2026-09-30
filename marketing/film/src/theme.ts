// Barry film — design tokens. One warm-neutral world, one accent light, two signal colours.
export const W = 1920;
export const H = 1080;

export const C = {
  bg: '#050506',
  bg2: '#0a0a0c',
  surface: 'rgba(255,255,255,0.045)',
  surfaceHi: 'rgba(255,255,255,0.085)',
  line: 'rgba(243,238,230,0.10)',
  lineHi: 'rgba(243,238,230,0.24)',
  text: '#F3EEE6',
  dim: 'rgba(243,238,230,0.60)',
  faint: 'rgba(243,238,230,0.34)',
  ghost: 'rgba(243,238,230,0.16)',
  warm: '#F4D9AE', // Barry light
  verify: '#9FE0BC', // verified against a real system
  hold: '#F2B25C', // needs the owner / not yet authoritative
  alert: '#F09A8A', // failed / blocked
} as const;

export const FONT = {
  sans: '"Inter", "HeeboHe", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

export const glow = (color: string, a = 0.35, r = 60) =>
  `0 0 ${r}px ${color.replace(')', `, ${a})`).replace('rgb(', 'rgba(')}`;
