/**
 * Cinematic settings (docs/v2/cinematic.md §1): per viewer, in localStorage, never in a save and
 * never sent to the worker. Parsing is pure (tests); storage failures (private mode) just don't persist.
 */
import type { DayNightMode } from './daylight';

export interface CinematicPrefs {
  /** Day and night: the cycle (default) or Always day (the static basemap as before). */
  dayNight: DayNightMode;
  /** Lit windows on 3D buildings at night. */
  windows: boolean;
  /** Photo mode: letterbox bars and the caption. */
  letterbox: boolean;
  caption: boolean;
}

export const DEFAULT_PREFS: CinematicPrefs = { dayNight: 'cycle', windows: true, letterbox: true, caption: true };

const KEY = 'headway-cinematic';

/** Whatever was stored (anything malformed falls back to the defaults, field by field). */
export function parsePrefs(raw: unknown): CinematicPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    dayNight: o.dayNight === 'day' || o.dayNight === 'cycle' ? o.dayNight : DEFAULT_PREFS.dayNight,
    windows: bool(o.windows, DEFAULT_PREFS.windows),
    letterbox: bool(o.letterbox, DEFAULT_PREFS.letterbox),
    caption: bool(o.caption, DEFAULT_PREFS.caption),
  };
}

export function loadPrefs(): CinematicPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return parsePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function storePrefs(p: Partial<CinematicPrefs>): CinematicPrefs {
  const next = { ...loadPrefs(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not persisted */
  }
  return next;
}

/** Day and night labels and hints (title Settings and Menu). */
export const DAY_NIGHT_LABEL: Record<DayNightMode, string> = { cycle: 'Day and night', day: 'Always day' };
export const DAY_NIGHT_HINT: Record<DayNightMode, string> = {
  cycle: 'The light follows the game clock: sunrise and sunset for the city and the date, weather on top',
  day: 'The map as it always was: no night, no glow',
};
