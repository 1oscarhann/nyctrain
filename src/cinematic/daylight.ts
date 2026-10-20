/**
 * The day/night cycle on the map (docs/v2/cinematic.md §3): ticked a few times a second (never
 * per frame) with the interpolated game time and today's weather, it pushes to MapLibre only the
 * palette colours that moved meaningfully, the light when the sun moved, the sky, and the lit
 * windows' pattern when they switch. The night factor goes to the glow layers through `onNight`.
 */
import type { Map as MLMap } from 'maplibre-gl';
import { CINEMATIC } from '../balance';
import { dayIndex, timeOfDay } from '../core/calendar';
import { BUILDING_LAYER, DAY_LIGHT, skyOf, styleBindings, type PaintBinding } from '../map/style';
import { angleDelta } from './chase';
import { DAY, lightPosition, nightFactor, paletteAt, paletteChanges, windowsOn, type ColourKey, type Palette, type SunState, type WeatherTint } from './palette';
import { gameSun, type SunPosition } from './solar';

export type DayNightMode = 'cycle' | 'day';

/** The lit-windows pattern image's id (fill-extrusion-pattern). */
export const WINDOWS_IMAGE = 'hw-windows';

/** Deterministic integer hash (no Math.random: the windows look the same in every session). */
function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A night facade: dark wall, a grid of windows, about a third of them lit in warm (a few cool) light. */
export function windowsImage(size = 64): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    const i = (y * size + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const wall: [number, number, number] = [24, 30, 39];
  const dark: [number, number, number] = [34, 41, 52];
  const warm: [number, number, number][] = [[255, 206, 120], [255, 224, 160], [244, 190, 104], [255, 236, 190]];
  const cool: [number, number, number] = [196, 218, 255];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, wall);
  const cw = 8, ch = 8;
  for (let gy = 0; gy < size / ch; gy++)
    for (let gx = 0; gx < size / cw; gx++) {
      const h = hash(gy * 97 + gx * 13 + 7);
      const col = h < 0.3 ? warm[Math.floor(hash(gx * 31 + gy) * warm.length)] : h < 0.36 ? cool : dark;
      for (let y = 1; y < ch - 2; y++) for (let x = 2; x < cw - 1; x++) put(gx * cw + x, gy * ch + y, col);
    }
  return { width: size, height: size, data };
}

export interface DaylightOptions {
  mode: DayNightMode;
  windows: boolean;
  /** The night factor (0 day … 1 night) moved by at least CINEMATIC.glowStep. */
  onNight?: (night: number) => void;
}

export class Daylight {
  /** Night factor last given to the glow layers. */
  night = 0;
  /** The sun at the last tick (null in Always day). */
  sun: SunPosition | null = null;
  /** What the map shows: the style starts on the Day palette, its light and its sky (style.ts). */
  private applied: Palette | null = DAY;
  private light: { position: [number, number, number]; color: string; intensity: number } | null = { position: DAY_LIGHT.position, color: DAY_LIGHT.color, intensity: DAY_LIGHT.intensity };
  private lit = false;
  private bindings: Map<ColourKey, PaintBinding[]>;
  private dayApplied = false;

  constructor(
    private map: MLMap,
    private opts: DaylightOptions,
  ) {
    this.bindings = new Map();
    const layers = map.getStyle().layers ?? [];
    for (const b of styleBindings(layers)) {
      let l = this.bindings.get(b.key);
      if (!l) this.bindings.set(b.key, (l = []));
      l.push(b);
    }
    if (!map.hasImage(WINDOWS_IMAGE)) map.addImage(WINDOWS_IMAGE, windowsImage());
  }

  get mode(): DayNightMode {
    return this.opts.mode;
  }

  setMode(mode: DayNightMode): void {
    this.opts.mode = mode;
    this.dayApplied = false;
  }

  setWindows(on: boolean): void {
    this.opts.windows = on;
  }

  /** Re-evaluate the palette for game time t (seconds) and today's weather. */
  tick(t: number, weather: WeatherTint | null): void {
    if (this.opts.mode === 'day') {
      if (this.dayApplied) return;
      this.dayApplied = true;
      this.sun = null;
      this.apply(DAY, { position: DAY_LIGHT.position, color: DAY.colours.light, intensity: DAY.lightIntensity }, false, 0);
      return;
    }
    const sun = gameSun(dayIndex(t), timeOfDay(t));
    this.sun = sun;
    this.applyAt(sun, weather);
  }

  /** Apply the palette of a given sun (the title screen's fixed evening, or a tick). */
  applyAt(sun: SunState & { azimuth: number }, weather: WeatherTint | null): void {
    const pal = paletteAt(sun, weather);
    const lit = this.opts.windows && windowsOn(sun.altitude, this.lit);
    this.apply(pal, { position: lightPosition(sun), color: pal.colours.light, intensity: pal.lightIntensity }, lit, nightFactor(sun.altitude));
  }

  private apply(pal: Palette, light: { position: [number, number, number]; color: string; intensity: number }, lit: boolean, night: number): void {
    const map = this.map;
    const changed = paletteChanges(this.applied, pal, CINEMATIC.minColourDelta);
    if (changed.length) {
      const next = this.applied ? { colours: { ...this.applied.colours }, lightIntensity: pal.lightIntensity } : { colours: { ...pal.colours }, lightIntensity: pal.lightIntensity };
      for (const k of changed) {
        next.colours[k] = pal.colours[k];
        for (const b of this.bindings.get(k) ?? []) {
          if (map.getLayer(b.layer)) map.setPaintProperty(b.layer, b.prop, pal.colours[k], { validate: false });
        }
      }
      if (changed.some((k) => k === 'sky' || k === 'horizon' || k === 'fog')) {
        map.setSky(skyOf(next.colours), { validate: false });
      }
      this.applied = next;
    }
    const L = this.light;
    if (
      !L ||
      Math.abs(angleDelta(L.position[1], light.position[1])) >= CINEMATIC.minLightDegrees ||
      Math.abs(L.position[2] - light.position[2]) >= CINEMATIC.minLightDegrees ||
      changed.includes('light') ||
      Math.abs(L.intensity - light.intensity) >= 0.01
    ) {
      const color = this.applied?.colours.light ?? light.color;
      this.light = { position: light.position, color, intensity: light.intensity };
      map.setLight({ anchor: 'map', position: light.position, color, intensity: light.intensity }, { validate: false });
    }
    if (lit !== this.lit) {
      this.lit = lit;
      // A cross-faded property: this relayouts the building source (only), twice a game day.
      if (map.getLayer(BUILDING_LAYER)) map.setPaintProperty(BUILDING_LAYER, 'fill-extrusion-pattern', lit ? WINDOWS_IMAGE : undefined, { validate: false });
    }
    if (Math.abs(night - this.night) >= CINEMATIC.glowStep || (night === 0) !== (this.night === 0) || (night === 1) !== (this.night === 1)) {
      this.night = night;
      this.opts.onNight?.(night);
    }
  }

  /** Whether the lit-windows pattern is on (tests and screenshots). */
  get windowsLit(): boolean {
    return this.lit;
  }
}
