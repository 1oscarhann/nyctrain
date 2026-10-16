/**
 * The current city. applyCity() must run before any world data is built, on every thread
 * (main thread at game start, the sim worker at init, scripts and tests): it restores the
 * New York defaults in balance.ts, applies the city's CITY_BALANCE overrides, and sets the
 * map projection origin and the currency symbol.
 */
import { CITY_BALANCE, COMMUTERS, CREDIT, ECONOMY, GOALS, GROWTH, MAP, VALUE_CAPTURE, type CityBalance, type CityId, type ZoneRule } from '../balance';
import { setOrigin } from '../core/geo';
import { setCurrency } from '../core/units';
import { LONDON } from './london';
import { NYC } from './nyc';
import type { CityConfig } from './types';

export type { CityConfig, CityId };

export const CITIES: Record<CityId, CityConfig> = { nyc: NYC, london: LONDON };
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
  setOrigin(b.origin[0], b.origin[1]);
  current = CITIES[id];
  setCurrency(current.currency);
  return current;
}

export function city(): CityConfig {
  return current;
}

export function cityBalance(): CityBalance {
  return CITY_BALANCE[current.id];
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
