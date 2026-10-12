/** Per-viewer settings (units, agent scale, last city and new-game chaos level) remembered in localStorage when available. */
import { CHAOS, COMMUTERS, type ChaosLevel, type CityId } from '../balance';
import { isCityId } from '../cities';
import type { UnitSystem } from '../core/units';
import type { SaveSettings } from '../save/format';

const KEY = 'headway-ny-settings';

export function loadSettings(): SaveSettings {
  const def: SaveSettings = { units: 'imperial', agentScale: COMMUTERS.agentScale, seed: COMMUTERS.seed };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return def;
    const s = JSON.parse(raw) as Partial<SaveSettings>;
    return {
      units: s.units === 'metric' ? 'metric' : 'imperial',
      agentScale: COMMUTERS.agentScaleChoices.includes(Number(s.agentScale)) ? Number(s.agentScale) : def.agentScale,
      seed: def.seed,
    };
  } catch {
    return def;
  }
}

export function storeSettings(s: { units: UnitSystem; agentScale: number }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ units: s.units, agentScale: s.agentScale }));
  } catch {
    /* private mode: settings just won't persist */
  }
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
