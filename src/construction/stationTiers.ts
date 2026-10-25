/**
 * Station upgrades (balance.ts STATION_TIERS): a station's comfortable capacity, what the next
 * level costs, and how long its works take. Shared by the game, the compiler and the UI.
 */
import { STATION, STATION_CROWD, STATION_TIERS, type StationTier } from '../balance';
import { platformLength, type Network } from './network';
import type { Station } from './types';

export const MAX_TIER = STATION_TIERS.length - 1;

export function tierOf(s: { tier?: number }): number {
  return Math.max(0, Math.min(MAX_TIER, s.tier ?? 0));
}

export function tierInfo(t: number): StationTier {
  return STATION_TIERS[Math.max(0, Math.min(MAX_TIER, t))];
}

/** Comfortable waiting capacity of the basic station: its platform length × people per metre. */
export function baseCapacity(net: Network, s: Station): number {
  const cls = net.edges.get(s.edge)?.cls ?? 'heavy';
  return platformLength(s.cars, cls) * STATION_CROWD.peoplePerMetre;
}

/** Comfortable waiting capacity now (works under way take some platform space). */
export function stationCapacity(net: Network, s: Station): number {
  const c = baseCapacity(net, s) * tierInfo(tierOf(s)).capacity;
  return Math.round(s.tierTo !== undefined ? c * STATION_CROWD.worksCapacity : c);
}

/** Cost of rebuilding to tier t (from the station's build cost by level). */
export function tierCost(net: Network, s: Station, t: number): number {
  return Math.round(STATION.costByLevel[net.stationLevel(s)] * tierInfo(t).costMult);
}

/** The next tier, or null at the top or while works are on. */
export function nextTier(s: Station): number | null {
  if (s.tierTo !== undefined) return null;
  const t = tierOf(s);
  return t < MAX_TIER ? t + 1 : null;
}
