/**
 * Special-event trips (city chaos): who goes, from where, and how they get there. The agents
 * themselves are injected by Commuters.injectEvents; these are the pure pieces it uses.
 */
import { CHAOS, EVENTS, type CityChaos, type VenueDef } from '../balance';
import { MAX_VENUES } from '../core/cityCalendar';
import type { Tract } from '../data/world';
import type { GroupPath } from './commuters';
import { generalisedCosts, moneyToMinutes, type PairGeometry, type WeatherMods } from './modeChoice';

/** Cumulative origin weights: residents · exp(−distance / originDecay) per tract. */
export function originCdf(tracts: readonly Tract[], vx: number, vy: number, decay = EVENTS.originDecay): Float64Array {
  const cdf = new Float64Array(tracts.length);
  let acc = 0;
  tracts.forEach((t, i) => {
    const d = Math.hypot(t.x - vx, t.y - vy);
    acc += t.residents * (isFinite(decay) ? Math.exp(-d / decay) : 1);
    cdf[i] = acc;
  });
  return cdf;
}

/** Index drawn from a cumulative weight array with u ∈ [0, 1) (zero-weight entries are never drawn). */
export function sampleCdf(cdf: Float64Array, u: number): number {
  const n = cdf.length;
  const target = u * cdf[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Earnings band drawn from a tract's resident band mix (homeBand is tracts × 3 shares). */
export function sampleBand(homeBand: ArrayLike<number>, tract: number, u: number): number {
  const o = tract * 3;
  if (u < homeBand[o]) return 0;
  if (u < homeBand[o] + homeBand[o + 1]) return 1;
  return 2;
}

/** Pair geometry from a home tract to a venue: no CBD parking rule (the venue's own parking applies). */
export function venueGeometry(home: Tract, vx: number, vy: number, homeCore: boolean, venueCore: boolean): PairGeometry {
  return {
    distance: Math.max(200, Math.hypot(home.x - vx, home.y - vy)),
    homeCore,
    workCore: venueCore,
    workCbd: false,
    homeCbd: false,
  };
}

/** Generalised costs [walk, drive, transit] for a fan: crowded trains expected, venue parking on top of driving. */
export function eventCosts(geom: PairGeometry, band: number, path: GroupPath | null, venue: VenueDef, wx: WeatherMods, fare: number): [number, number, number] {
  const c = generalisedCosts(geom, band, path ? { time: path.time, transfers: path.transfers, crowdMinutes: EVENTS.crowdMinutes, fare } : null, wx);
  c[1] += venue.parkingTime / 60 + moneyToMinutes(venue.parkingCost, band);
  return c;
}

/** The same journey in the other direction: legs in reverse order, board and alight swapped. */
export function reverseLegs(p: GroupPath): GroupPath {
  const n = p.legs.length / 3;
  const legs = new Int32Array(p.legs.length);
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 3;
    legs[i * 3] = p.legs[src];
    legs[i * 3 + 1] = p.legs[src + 2];
    legs[i * 3 + 2] = p.legs[src + 1];
  }
  return { legs, time: p.time, transfers: p.transfers };
}

/**
 * Sanity problems in a city's event table (empty when fine): every kind's venue exists, ends by
 * 23:30 with fans gone within 40 minutes (so nobody is still travelling at the next 3 am), the
 * offsets are ordered, and a venue with several kinds keeps Σ chance × Wild ≤ 1 so no kind is
 * starved. (A venue with one fixed-window kind may have chance 1.)
 */
export function checkKinds(cc: CityChaos): string[] {
  const problems: string[] = [];
  if (cc.venues.length > MAX_VENUES) problems.push(`more than ${MAX_VENUES} venues`);
  const keys = new Set(cc.venues.map((v) => v.key));
  if (keys.size !== cc.venues.length) problems.push('duplicate venue keys');
  for (const k of cc.kinds) {
    if (!keys.has(k.venue)) problems.push(`${k.label}: unknown venue ${k.venue}`);
    if (k.arrive[0] > k.arrive[1] || k.leave[0] > k.leave[1]) problems.push(`${k.label}: offsets out of order`);
    if (k.attendance[0] > k.attendance[1] || k.attendance[0] <= 0) problems.push(`${k.label}: bad attendance`);
    if (!(k.chance > 0 && k.chance <= 1)) problems.push(`${k.label}: chance out of range`);
    if (k.leave[1] > 40 * 60) problems.push(`${k.label}: fans leave more than 40 min after the end`);
    for (const [h] of k.starts) {
      const end = h * 3600 + k.duration;
      if (end > 23.5 * 3600) problems.push(`${k.label}: a ${h}h start ends after 23:30`);
      if (end + k.leave[1] > 24 * 3600 + 10 * 60) problems.push(`${k.label}: a ${h}h start leaves after 00:10`);
    }
  }
  for (const v of cc.venues) {
    const kinds = cc.kinds.filter((k) => k.venue === v.key);
    const sum = kinds.reduce((s, k) => s + k.chance, 0);
    if (kinds.length > 1 && sum * CHAOS.eventChance.wild > 1) problems.push(`${v.key}: Σ chance × wild = ${(sum * CHAOS.eventChance.wild).toFixed(2)} > 1`);
  }
  return problems;
}
