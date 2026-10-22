/**
 * Day/night palettes for the recoloured basemap (docs/v2/cinematic.md §3). Keyframes at sun
 * altitudes, interpolated in OKLab (no muddy midpoints between night blue and dusk orange), then a
 * weather tint scaled by severity. Pure; the runtime (daylight.ts) pushes only keys that moved.
 */
import type { WeatherKind } from '../balance';

export type ColourKey =
  | 'land'
  | 'park'
  | 'water'
  | 'street'
  | 'avenue'
  | 'block'
  | 'blockLine'
  | 'roof'
  | 'label'
  | 'labelHalo'
  | 'waterLabel'
  | 'waterLabelHalo'
  | 'light'
  | 'sky'
  | 'horizon'
  | 'fog';

export const COLOUR_KEYS: readonly ColourKey[] = ['land', 'park', 'water', 'street', 'avenue', 'block', 'blockLine', 'roof', 'label', 'labelHalo', 'waterLabel', 'waterLabelHalo', 'light', 'sky', 'horizon', 'fog'];

export interface Palette {
  colours: Record<ColourKey, string>;
  /** fill-extrusion light intensity (0–1). */
  lightIntensity: number;
}

/**
 * Day: the basemap exactly as before Cinematic (style.ts BASEMAP and its light), so "Always day"
 * is the old map. `roof` is the 3D buildings' one colour (it used to ramp block → roof by height).
 */
export const DAY: Palette = {
  colours: {
    land: '#2b3138',
    park: '#2f3d33',
    water: '#1e3a4c',
    street: '#3a424b',
    avenue: '#4a535d',
    block: '#343b44',
    blockLine: '#2f353d',
    roof: '#3b424c',
    label: '#9aa5b1',
    labelHalo: '#2b3138',
    waterLabel: '#5f7f92',
    waterLabelHalo: '#1e3a4c',
    light: '#fff6ea',
    sky: '#56708c',
    horizon: '#8d9caf',
    fog: '#2b3138',
  },
  lightIntensity: 0.62,
};

/**
 * Low sun (a few degrees up): the day's colours, warmed, with a long golden light. (Every light
 * colour stays near white: MapLibre's fill-extrusion shading floors each channel at
 * 0.3 · (1 − light), so a saturated light would tint the dark walls with its complement; the roof
 * colour carries the mood.)
 */
export const GOLDEN: Palette = {
  colours: {
    land: '#2d3137',
    park: '#303c33',
    water: '#203a4b',
    street: '#3c4249',
    avenue: '#4e5359',
    block: '#363b43',
    blockLine: '#30353c',
    roof: '#424650',
    label: '#a3a8af',
    labelHalo: '#2d3137',
    waterLabel: '#647f8f',
    waterLabelHalo: '#203a4b',
    light: '#ffe4c0',
    sky: '#6a7ea0',
    horizon: '#f0c59c',
    fog: '#33363c',
  },
  lightIntensity: 0.66,
};

/** Morning civil twilight (blue hour): cool violet buildings and streets, a pink horizon. */
export const DAWN: Palette = {
  colours: {
    land: '#272a36',
    park: '#28302f',
    water: '#1d2a44',
    street: '#35374a',
    avenue: '#4b4756',
    block: '#2e2f3f',
    blockLine: '#282937',
    roof: '#3a3a4e',
    label: '#aaa4b8',
    labelHalo: '#272a36',
    waterLabel: '#5e6c8c',
    waterLabelHalo: '#1d2a44',
    light: '#f2e6ee',
    sky: '#4a5a8e',
    horizon: '#f0a48c',
    fog: '#3b3649',
  },
  lightIntensity: 0.42,
};

/** Evening civil twilight (blue hour): blue-violet buildings, the avenues' lights coming on, an orange afterglow on the horizon. */
export const DUSK: Palette = {
  colours: {
    land: '#262a35',
    park: '#26302f',
    water: '#1b2840',
    street: '#33374a',
    avenue: '#4a4450',
    block: '#2c3040',
    blockLine: '#262a37',
    roof: '#363a4c',
    label: '#a8a6b8',
    labelHalo: '#262a35',
    waterLabel: '#5f6d8c',
    waterLabelHalo: '#1b2840',
    light: '#e8e4f4',
    sky: '#3b4677',
    horizon: '#e8936e',
    fog: '#3a3346',
  },
  lightIntensity: 0.45,
};

/** Night: blue-black land, the avenues warm under street lights, moonlight on the buildings. */
export const NIGHT: Palette = {
  colours: {
    land: '#121821',
    park: '#131d1a',
    water: '#0a1621',
    street: '#252a31',
    avenue: '#3b3830',
    block: '#171d25',
    blockLine: '#141920',
    roof: '#1b212a',
    label: '#7e8b99',
    labelHalo: '#121821',
    waterLabel: '#3e5566',
    waterLabelHalo: '#0a1621',
    light: '#d0daf4',
    sky: '#070b16',
    horizon: '#1a2236',
    fog: '#121821',
  },
  lightIntensity: 0.3,
};

/** Keyframe altitudes (degrees): night below −9°, twilight at −2°, golden at 6°, day from 14°. */
export const ALT = { night: -9, twilight: -2, golden: 6, day: 14 } as const;

// ------------------------------------------------------------------ colour maths (sRGB ⇄ OKLab)
type Lab = [number, number, number];

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB hex → OKLab. */
export function hexToOklab(h: string): Lab {
  const [R, G, B] = hexToRgb(h).map(toLin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → sRGB hex (clamped to the gamut). */
export function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (v: number) => {
    const x = Math.max(0, Math.min(1, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  };
  return rgbToHex(enc(R), enc(G), enc(B));
}

/** Mix two hex colours in OKLab (t = 0: a, 1: b). */
export function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a.toLowerCase();
  if (t >= 1) return b.toLowerCase();
  const A = hexToOklab(a), B = hexToOklab(b);
  return oklabToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const colours = {} as Record<ColourKey, string>;
  for (const k of COLOUR_KEYS) colours[k] = mixHex(a.colours[k], b.colours[k], t);
  return { colours, lightIntensity: a.lightIntensity + (b.lightIntensity - a.lightIntensity) * t };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ the cycle
export interface SunState {
  altitude: number;
  /** Before solar noon (dawn keyframe), else dusk. */
  morning: boolean;
}

/** Night factor for the glow layers: 1 below −7°, 0 above +1° (smooth). */
export function nightFactor(altitude: number): number {
  return 1 - smoothstep(-7, 1, altitude);
}

/** How much daylight there is: 0 at night, 1 from 6° up (weather tints and street-light warmth). */
export function dayness(altitude: number): number {
  return smoothstep(-6, 6, altitude);
}

/** Lit windows: on below −4° (off again above −3.25°, so a camera at the threshold doesn't flicker). */
export function windowsOn(altitude: number, wasOn: boolean): boolean {
  return wasOn ? altitude < -3.25 : altitude < -4.75;
}

/** The palette for a sun position, before weather. */
export function cyclePalette(sun: SunState): Palette {
  const a = sun.altitude;
  const twi = sun.morning ? DAWN : DUSK;
  if (a <= ALT.night) return NIGHT;
  if (a < ALT.twilight) return mixPalette(NIGHT, twi, smoothstep(ALT.night, ALT.twilight, a));
  if (a < ALT.golden) return mixPalette(twi, GOLDEN, smoothstep(ALT.twilight, ALT.golden, a));
  if (a < ALT.day) return mixPalette(GOLDEN, DAY, smoothstep(ALT.golden, ALT.day, a));
  return DAY;
}

export interface WeatherTint {
  kind: WeatherKind;
  /** 0 when clear, else 0.5–1. */
  severity: number;
}

const GROUND: ColourKey[] = ['land', 'park', 'block', 'blockLine', 'roof'];
const ROADS: ColourKey[] = ['street', 'avenue'];
const SKY: ColourKey[] = ['sky', 'horizon', 'fog'];

/**
 * Weather over the cycle (scaled by severity; visible at night too): rain greys, darkens and wets
 * the streets (a sheen under street lights); snow whitens the ground and roofs (and at night
 * reflects the city's glow); heat hazes everything warm.
 */
export function weatherPalette(p: Palette, w: WeatherTint | null | undefined, altitude: number): Palette {
  if (!w || w.kind === 'clear' || !(w.severity > 0)) return p;
  const s = Math.min(1, w.severity);
  const d = dayness(altitude);
  const c = { ...p.colours };
  let li = p.lightIntensity;
  const toward = (keys: readonly ColourKey[], target: string, t: number) => {
    for (const k of keys) c[k] = mixHex(c[k], target, t);
  };
  const lab = (k: ColourKey, f: (x: Lab) => Lab) => {
    c[k] = oklabToHex(f(hexToOklab(c[k])));
  };
  if (w.kind === 'rain') {
    for (const k of COLOUR_KEYS) {
      if (k === 'light') continue;
      lab(k, ([L, A, B]) => [L * (1 - 0.06 * s), A * (1 - 0.3 * s), B * (1 - 0.3 * s)]);
    }
    // Wet streets catch the lights at night.
    for (const k of ROADS) lab(k, ([L, A, B]) => [L + 0.035 * s * (1 - d), A, B]);
    toward(SKY, mixHex('#1a1f27', '#59636e', d), 0.6 * s);
    c.light = mixHex(c.light, '#c8d2dc', 0.5 * s);
    li *= 1 - 0.3 * s;
  } else if (w.kind === 'snow') {
    const snow = mixHex('#2a3340', '#5f6a76', d);
    toward(GROUND, snow, 0.5 * s);
    toward(ROADS, snow, 0.25 * s);
    toward(SKY, mixHex('#1e2530', '#8c96a2', d), 0.5 * s);
    c.light = mixHex(c.light, '#e8eef5', 0.5 * s);
    li = Math.min(1, li + 0.05 * s);
  } else if (w.kind === 'heat') {
    const haze = mixHex('#2a2420', '#5a4c3c', d);
    for (const k of COLOUR_KEYS) if (k !== 'light' && !SKY.includes(k)) c[k] = mixHex(c[k], haze, 0.12 * s);
    toward(SKY, '#c9a27a', 0.35 * s * d);
    c.light = mixHex(c.light, '#ffe2b0', 0.4 * s);
  }
  return { colours: c, lightIntensity: Math.round(li * 1000) / 1000 };
}

/** The basemap palette for a sun position and today's weather. */
export function paletteAt(sun: SunState, weather?: WeatherTint | null): Palette {
  return weatherPalette(cyclePalette(sun), weather, sun.altitude);
}

/**
 * Keys whose colour moved by at least `minDelta` (of 255) in any channel since `prev`: the only
 * ones worth a setPaintProperty. Everything when there is no previous palette.
 */
export function paletteChanges(prev: Palette | null, next: Palette, minDelta = 2): ColourKey[] {
  if (!prev) return [...COLOUR_KEYS];
  const out: ColourKey[] = [];
  for (const k of COLOUR_KEYS) {
    const a = prev.colours[k], b = next.colours[k];
    if (a === b) continue;
    const A = hexToRgb(a), B = hexToRgb(b);
    if (Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2])) >= minDelta) out.push(k);
  }
  return out;
}

/**
 * The fill-extrusion light's position [radial, azimuth, polar] (map-anchored, degrees): from the
 * sun's azimuth, its polar angle 90° − altitude kept within 25–78° (walls never go black and
 * roofs never wash out); below the horizon it stays where the sun set or will rise, at 70°.
 */
export function lightPosition(sun: { altitude: number; azimuth: number }): [number, number, number] {
  const polar = sun.altitude > 0 ? Math.max(25, Math.min(78, 90 - sun.altitude)) : 70;
  return [1.5, Math.round(sun.azimuth), Math.round(polar)];
}

/** RGBA of a hex colour (deck.gl). */
export function hexRgba(h: string, alpha = 255): [number, number, number, number] {
  const [r, g, b] = hexToRgb(h);
  return [r, g, b, alpha];
}
