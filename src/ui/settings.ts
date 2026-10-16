/** Per-viewer settings (units, agent scale, last city and new-game chaos level) remembered in localStorage when available. */
import { CHAOS, COMMUTERS, type ChaosLevel, type CityId } from '../balance';
import { CITIES, city, isCityId } from '../cities';
import type { UnitSystem } from '../core/units';
import type { SaveSettings } from '../save/format';

const KEY = 'headway-ny-settings';

/** What localStorage holds under KEY. */
export interface StoredSettings {
  agentScale?: number;
  /** Units the player picked, per city (Settings on the title screen, or the in-game menu). */
  unitsByCity?: Partial<Record<CityId, UnitSystem>>;
  /** Before Living City: one unit for both cities, stored with any settings change (miles by default). */
  units?: UnitSystem;
}

const isUnits = (u: unknown): u is UnitSystem => u === 'imperial' || u === 'metric';

/**
 * The units for a city: the player's explicit choice for it, else the city's own (New York miles,
 * London kilometres). An older single setting counts only when it is "metric": miles was its
 * default, so only kilometres can have been picked.
 */
export function unitsFor(id: CityId, s: StoredSettings | null): UnitSystem {
  const chosen = s?.unitsByCity?.[id];
  if (isUnits(chosen)) return chosen;
  if (s?.units === 'metric') return 'metric';
  return CITIES[id].defaultUnits;
}

function readStored(): StoredSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as unknown) : null;
    return s && typeof s === 'object' ? (s as StoredSettings) : null;
  } catch {
    return null;
  }
}

function writeStored(s: StoredSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just won't persist */
  }
}

/** Settings for the current city (its units follow unitsFor). */
export function loadSettings(): SaveSettings {
  const s = readStored();
  return {
    units: unitsFor(city().id, s),
    agentScale: COMMUTERS.agentScaleChoices.includes(Number(s?.agentScale)) ? Number(s!.agentScale) : COMMUTERS.agentScale,
    seed: COMMUTERS.seed,
  };
}

/** Remember the agent scale (units are only stored when the player picks them: storeUnits). */
export function storeSettings(s: { agentScale: number }): void {
  writeStored({ ...readStored(), agentScale: s.agentScale });
}

/** The player picked units for the current city: kept for it from now on. */
export function storeUnits(u: UnitSystem): void {
  const s = readStored() ?? {};
  writeStored({ ...s, unitsByCity: { ...(s.unitsByCity ?? {}), [city().id]: u } });
}

const CITY_KEY = 'headway-city';

/** The city picked last on the title screen. */
export function loadLastCity(): CityId {
  try {
    const v = localStorage.getItem(CITY_KEY);
    return isCityId(v) ? v : 'nyc';
  } catch {
    return 'nyc';
  }
}

export function storeLastCity(id: CityId): void {
  try {
    localStorage.setItem(CITY_KEY, id);
  } catch {
    /* not persisted */
  }
}

const CHAOS_KEY = 'headway-chaos-level';

/** The city chaos level picked last for a new game (Normal by default). */
export function loadChaosLevel(): ChaosLevel {
  try {
    const v = localStorage.getItem(CHAOS_KEY) as ChaosLevel | null;
    return v && CHAOS.levels.includes(v) ? v : CHAOS.defaultLevel;
  } catch {
    return CHAOS.defaultLevel;
  }
}

export function storeChaosLevel(l: ChaosLevel): void {
  try {
    localStorage.setItem(CHAOS_KEY, l);
  } catch {
    /* not persisted */
  }
}
