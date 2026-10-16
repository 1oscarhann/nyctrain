/** Colour ramps for data overlays (deliberately avoiding the green/amber/red signal hues). */
export type RGBA = [number, number, number, number];

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function makeRamp(stops: string[], alphas: number[]): (t: number) => RGBA {
  const cols = stops.map(hex);
  return (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(x));
    const f = x - i;
    const a = cols[i];
    const b = cols[i + 1];
    const alpha = alphas[i] + (alphas[i + 1] - alphas[i]) * f;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, alpha * 255];
  };
}

/** Residents: deep teal to ice. */
export const RAMP_COOL = makeRamp(['#123447', '#1C5F7A', '#2F98B0', '#7FD3DF', '#E4FBFF'], [0.25, 0.45, 0.6, 0.72, 0.85]);
/** Jobs: ember to pale gold. */
export const RAMP_WARM = makeRamp(['#3A1A4A', '#7A2466', '#C2435A', '#F08A4B', '#FFE7A6'], [0.25, 0.45, 0.62, 0.75, 0.88]);
/** Unserved demand: violet to hot pink. */
export const RAMP_VIOLET = makeRamp(['#2A2350', '#4B3A8F', '#8A4FCF', '#D46BE0', '#FFD1FA'], [0.25, 0.45, 0.6, 0.75, 0.88]);

export function rampCss(ramp: (t: number) => RGBA, n = 6): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = ramp(i / (n - 1));
    parts.push(`rgba(${r | 0},${g | 0},${b | 0},${(a / 255).toFixed(2)}) ${((i / (n - 1)) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Log-scale position of v between lo and hi. */
export function logT(v: number, lo: number, hi: number): number {
  if (v <= lo) return 0;
  return Math.min(1, Math.log(v / lo) / Math.log(hi / lo));
}

export function hexToRgb(h: string): [number, number, number] {
  return hex(h);
}

/**
 * Living City growth (diverging): decline runs magenta → dusk violet, a transparent neutral sits
 * in the middle, and growth runs deep teal → ice. Clear of the green/amber/red signal hues.
 */
export const RAMP_DIVERGE = makeRamp(['#C04FB8', '#5E3B7E', '#20262D', '#1C7A8C', '#BFF4FA'], [0.85, 0.55, 0.0, 0.6, 0.9]);
