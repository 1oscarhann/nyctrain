/** Per-viewer settings (units, agent scale) remembered in localStorage when available. */
import { COMMUTERS } from '../balance';
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
