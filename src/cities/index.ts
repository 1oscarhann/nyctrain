/**
 * The current city. applyCity() must run before any world data is built, on every thread
 * (main thread at game start, the sim worker at init, scripts and tests): it restores the
 * New York defaults in balance.ts, applies the city's CITY_BALANCE overrides, and sets the
 * map projection origin and the currency symbol.
 */
import { CHAOS, CITY_BALANCE, COMMUTERS, CREDIT, ECONOMY, EVENTS, GOALS, GROWTH, MAP, OPERATIONS, RESEARCH, SCHOOLS, SPECIAL, STATION, STOCK_IDS, TRACK, TRACK_CLASSES, TRAINS, VALUE_CAPTURE, stocksFor, type CityBalance, type CityId, type Gauge, type ResearchDef, type StockId, type TrackClass, type ZoneRule } from '../balance';
import { setOrigin } from '../core/geo';
import { resetTech } from '../core/tech';
import { setCurrency } from '../core/units';
import { LONDON } from './london';
import { NYC } from './nyc';
import { SOUTHEAST } from './southeast';
import { BIRMINGHAM, BRISTOL, LEEDS, MANCHESTER } from './ukMetros';
import { JAPAN } from './japan';
import type { CityConfig } from './types';

export type { CityConfig, CityId };

export const CITIES: Record<CityId, CityConfig> = { nyc: NYC, london: LONDON, southeast: SOUTHEAST, manchester: MANCHESTER, birmingham: BIRMINGHAM, leeds: LEEDS, bristol: BRISTOL, japan: JAPAN };
export const CITY_IDS = Object.keys(CITIES) as CityId[];

// New York's values as written in balance.ts, captured before any city is applied.
const DEFAULTS = {
  MAP: structuredClone(MAP),
  COMMUTERS: structuredClone(COMMUTERS),
  ECONOMY: structuredClone(ECONOMY),
  GOALS: structuredClone(GOALS),
  CREDIT: structuredClone(CREDIT),
  GROWTH: structuredClone(GROWTH),
  VALUE_CAPTURE: structuredClone(VALUE_CAPTURE),
  TRACK: structuredClone(TRACK),
  STATION: structuredClone(STATION),
  SCHOOLS: structuredClone(SCHOOLS),
  SPECIAL: structuredClone(SPECIAL),
  EVENTS: structuredClone(EVENTS),
  INCIDENTS: { signal: CHAOS.signal.perTrackKmDay, breakdown: CHAOS.breakdown.perTrainKm, sick: CHAOS.sick.perTrainKm, police: CHAOS.police.perStationDay },
  TRAIN_NAMES: Object.fromEntries(STOCK_IDS.map((s) => [s, TRAINS[s].name])) as Record<string, string>,
  DEFAULT_HEADWAYS: { ...OPERATIONS.defaultHeadways },
  HEADWAY_CHOICES: [...OPERATIONS.headwayChoices],
};

let current: CityConfig = NYC;

export function isCityId(x: unknown): x is CityId {
  return typeof x === 'string' && x in CITIES;
}

export function applyCity(id: CityId): CityConfig {
  const b = CITY_BALANCE[id];
  Object.assign(MAP, structuredClone(DEFAULTS.MAP), structuredClone(b.map));
  Object.assign(COMMUTERS, structuredClone(DEFAULTS.COMMUTERS), structuredClone(b.commuters));
  Object.assign(ECONOMY, structuredClone(DEFAULTS.ECONOMY), structuredClone(b.economy));
  Object.assign(GOALS, structuredClone(DEFAULTS.GOALS), structuredClone(b.goals));
  Object.assign(CREDIT, structuredClone(DEFAULTS.CREDIT), structuredClone(b.credit));
  Object.assign(GROWTH, structuredClone(DEFAULTS.GROWTH), structuredClone(b.growth));
  Object.assign(VALUE_CAPTURE, structuredClone(DEFAULTS.VALUE_CAPTURE), structuredClone(b.valueCapture));
  Object.assign(TRACK, structuredClone(DEFAULTS.TRACK), structuredClone(b.track ?? {}));
  Object.assign(STATION, structuredClone(DEFAULTS.STATION), structuredClone(b.station ?? {}));
  const { terms: _terms, ...schools } = b.schools ?? {};
  Object.assign(SCHOOLS, structuredClone(DEFAULTS.SCHOOLS), structuredClone(schools));
  Object.assign(SPECIAL, structuredClone(DEFAULTS.SPECIAL), structuredClone(b.special ?? {}));
  Object.assign(EVENTS, structuredClone(DEFAULTS.EVENTS), structuredClone(b.events ?? {}));
  const inc = { ...DEFAULTS.INCIDENTS, ...(b.incidents ?? {}) };
  CHAOS.signal.perTrackKmDay = inc.signal;
  CHAOS.breakdown.perTrainKm = inc.breakdown;
  CHAOS.sick.perTrainKm = inc.sick;
  CHAOS.police.perStationDay = inc.police;
  OPERATIONS.defaultHeadways = { ...DEFAULTS.DEFAULT_HEADWAYS, ...(b.operations?.defaultHeadways ?? {}) };
  OPERATIONS.headwayChoices = [...(b.operations?.headwayChoices ?? DEFAULTS.HEADWAY_CHOICES)];
  setOrigin(b.origin[0], b.origin[1], b.projection);
  current = CITIES[id];
  for (const s of STOCK_IDS) TRAINS[s].name = current.stockNames?.[s] ?? DEFAULTS.TRAIN_NAMES[s];
  setCurrency(current.currency, current.currencyScale ?? 1);
  // The look follows the city (CSS custom properties under [data-theme]); no DOM in the worker.
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = current.theme;
  // Research effects are on top of the city's numbers: none until a game applies its own.
  resetTech();
  return current;
}

export function city(): CityConfig {
  return current;
}

export function cityBalance(): CityBalance {
  return CITY_BALANCE[current.id];
}

/** Track classes the player can build in the current city. */
export function trackClasses(): TrackClass[] {
  return current.trackClasses ?? TRACK_CLASSES;
}

/** Train types a route on this track family can run in the current city. */
export function availableStocks(g: Gauge): StockId[] {
  const all = stocksFor(g);
  const only = current.stocks;
  const out = only ? all.filter((s) => only.includes(s)) : all;
  return out.length ? out : all;
}

/** Research projects on offer in the current city. */
export function cityResearch(): ResearchDef[] {
  const only = current.research;
  return RESEARCH.filter((r) => (only ? only.includes(r.id) : true) && (!r.only || r.only.includes(current.id)));
}

const codeByName = new Map<CityId, Map<string, number>>();
/** Land-mask code of a region of the current city (0 if unknown). */
export function regionCode(name: string): number {
  let m = codeByName.get(current.id);
  if (!m) codeByName.set(current.id, (m = new Map(current.regions.map((r) => [r.name, r.code]))));
  return m.get(name) ?? 0;
}

/** Chart area index of a region of the current city (-1 if unknown). */
export function regionArea(name: string): number {
  return current.regions.find((r) => r.name === name)?.area ?? -1;
}

/** Is a point (with the region it lies in) inside a zone rule? */
export function inZone(rule: ZoneRule, lon: number, lat: number, region: string): boolean {
  if (rule.kind === 'region-south-of') return region === rule.region && lat < rule.lat;
  return pointInRing(lon, lat, rule.ring);
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
