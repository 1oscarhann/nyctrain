/**
 * City chaos incidents, the pure half: the network's exposure (train-km, directed-track km,
 * stations) and the day's incident plan, a pure function of (seed, day, exposure, level, weather).
 * Targets are picked later, at fire time, by the ChaosController (src/sim/chaos.ts) from the
 * pre-drawn r1/r2 values.
 */
import { CHAOS, OPERATIONS, type IncidentKind } from '../balance';
import { SALT_INCIDENTS, type RateMods } from '../core/cityCalendar';
import { hashSeed, poisson, Rng } from '../core/rng';
import type { CompiledNetwork } from './protocol';

export type { IncidentKind };

/** Fixed order: the plan draws kinds in this order, so it is deterministic. */
export const INCIDENT_KINDS: IncidentKind[] = ['signal', 'breakdown', 'sick', 'police'];

export interface PlannedIncident {
  kind: IncidentKind;
  /** Absolute game time it fires. */
  t: number;
  /** Seconds. */
  dur: number;
  /** Uniform draws used to pick the target at fire time. */
  r1: number;
  r2: number;
}

export interface Exposure {
  /** Planned train-km per period (night, AM, midday, PM, evening). */
  trainKmByPeriod: number[];
  trainKm: number;
  /** Distinct directed track used by routes, km. */
  trackKm: number;
  /** Stations served by at least one route. */
  stations: number;
}

/** The stretch of one directed track that routes use, in track coordinates. */
export interface TrackSpan {
  track: number;
  edge: number;
  edgeDir: 0 | 1;
  u0: number;
  u1: number;
}

/** Distinct directed tracks used by routes, in network order (routes, directions, elements). */
export function trackSpans(net: CompiledNetwork): TrackSpan[] {
  const byTrack = new Map<number, TrackSpan>();
  for (const r of net.routes) {
    for (const dir of r.dirs) {
      for (const el of dir.elems) {
        const a = el.u0, b = el.u0 + (el.s1 - el.s0);
        const sp = byTrack.get(el.track);
        if (!sp) byTrack.set(el.track, { track: el.track, edge: el.edge, edgeDir: el.edgeDir, u0: a, u1: b });
        else {
          sp.u0 = Math.min(sp.u0, a);
          sp.u1 = Math.max(sp.u1, b);
        }
      }
    }
  }
  return [...byTrack.values()];
}

export function measureExposure(net: CompiledNetwork): Exposure {
  const hours = OPERATIONS.periods.map((p) => p.end - p.start);
  const trainKmByPeriod = hours.map(() => 0);
  const served = new Set<number>();
  for (const r of net.routes) {
    const len = (r.dirs[0].length + r.dirs[1].length) / 1000;
    hours.forEach((h, i) => {
      const hw = r.headways[i];
      if (hw > 0) trainKmByPeriod[i] += ((h * 3600) / hw) * len;
    });
    // A cross-platform pair (v2) is one station (under its lower index).
    for (const dir of r.dirs) for (const si of dir.stopStation) {
      const p = net.stations[si]?.pair;
      served.add(p !== undefined && p >= 0 && p < si ? p : si);
    }
  }
  let trackKm = 0;
  for (const sp of trackSpans(net)) trackKm += (sp.u1 - sp.u0) / 1000;
  return { trainKmByPeriod, trainKm: trainKmByPeriod.reduce((a, b) => a + b, 0), trackKm, stations: served.size };
}

/** A time of day (s) within service hours, in a period chosen in proportion to its train-km. */
export function timeByService(rng: Rng, trainKmByPeriod: number[]): number {
  const s0 = CHAOS.serviceStart, s1 = CHAOS.serviceEnd;
  const spans: [number, number, number][] = [];
  let total = 0;
  OPERATIONS.periods.forEach((p, i) => {
    const a = Math.max(p.start * 3600, s0), b = Math.min(p.end * 3600, s1);
    if (b <= a) return;
    const w = (trainKmByPeriod[i] ?? 0) * ((b - a) / ((p.end - p.start) * 3600));
    if (w > 0) {
      spans.push([a, b, w]);
      total += w;
    }
  });
  if (!(total > 0)) return s0 + rng.next() * (s1 - s0);
  let u = rng.next() * total;
  for (const [a, b, w] of spans) {
    if (u < w) return a + rng.next() * (b - a);
    u -= w;
  }
  const [a, b] = spans[spans.length - 1];
  return a + rng.next() * (b - a);
}

/**
 * The day's incidents: Poisson counts per kind from the exposure, the level's rate multiplier
 * and the weather's rate factors. Everything is drawn before the `after` filter, so a mid-day
 * load sees the same remaining plan as an uninterrupted run.
 */
export function planIncidents(seed: number, day: number, ex: Exposure, mult: number, rates: RateMods, after: number): PlannedIncident[] {
  if (!(mult > 0)) return [];
  const rng = new Rng(hashSeed(seed, day, 0, SALT_INCIDENTS));
  const lambda: Record<IncidentKind, number> = {
    signal: ex.trackKm * CHAOS.signal.perTrackKmDay,
    breakdown: ex.trainKm * CHAOS.breakdown.perTrainKm,
    sick: ex.trainKm * CHAOS.sick.perTrainKm,
    police: ex.stations * CHAOS.police.perStationDay,
  };
  const out: PlannedIncident[] = [];
  for (const kind of INCIDENT_KINDS) {
    const n = Math.min(CHAOS.maxPerKindPerDay, poisson(rng, lambda[kind] * mult * rates[kind]));
    for (let i = 0; i < n; i++) {
      const tod = kind === 'police' ? CHAOS.serviceStart + rng.next() * (CHAOS.serviceEnd - CHAOS.serviceStart) : timeByService(rng, ex.trainKmByPeriod);
      const [d0, d1] = CHAOS[kind].duration;
      out.push({ kind, t: day * 86400 + tod, dur: d0 + (d1 - d0) * rng.next(), r1: rng.next(), r2: rng.next() });
    }
  }
  const order = (k: IncidentKind) => INCIDENT_KINDS.indexOf(k);
  return out.filter((p) => p.t >= after).sort((a, b) => a.t - b.t || order(a.kind) - order(b.kind));
}

/** Index i of a cumulative weight array with cdf[i−1] ≤ u·total < cdf[i]. */
export function cdfIndex(cdf: ArrayLike<number>, u: number): number {
  const n = cdf.length;
  if (!n) return -1;
  const target = u * cdf[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
