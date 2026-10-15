/**
 * Event service: temporary headway overrides around a city event. Which routes serve a venue, the
 * default windows before and after it, and what extra service costs (pure, main thread).
 */
import { ECONOMY, EVENTS, OPERATIONS } from '../balance';
import type { CityEvent } from '../core/cityCalendar';
import type { CompiledNetwork, CRoute } from '../sim/protocol';
import { periodIndex } from '../sim/trainSim';
import { roundTripTime } from './compile';

export interface RouteNearVenue {
  routeId: number;
  /** Distance from the venue to the route's nearest stop, metres. */
  dist: number;
  /** That stop's station name. */
  station: string;
}

/** Routes with a stop within r metres of (x, y), nearest first. */
export function routesNearVenue(net: CompiledNetwork, x: number, y: number, r: number): RouteNearVenue[] {
  const out: RouteNearVenue[] = [];
  for (const route of net.routes) {
    let best = Infinity;
    let name = '';
    for (const si of route.dirs[0].stopStation) {
      const s = net.stations[si];
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < best) {
        best = d;
        name = s.name;
      }
    }
    if (best <= r) out.push({ routeId: route.id, dist: best, station: name });
  }
  return out.sort((a, b) => a.dist - b.dist || a.routeId - b.routeId);
}

/** Stations within r metres of (x, y), nearest first. */
export function stationsNear(net: CompiledNetwork, x: number, y: number, r: number): { id: number; name: string; dist: number }[] {
  return net.stations
    .map((s) => ({ id: s.id, name: s.name, dist: Math.hypot(s.x - x, s.y - y) }))
    .filter((s) => s.dist <= r)
    .sort((a, b) => a.dist - b.dist);
}

const STEP = 15 * 60;
const snap = (t: number) => Math.round(t / STEP) * STEP;

/**
 * Default event service windows in seconds of the event's day (the second may run past
 * midnight): start − 2 h … start + 15 min, and end − 15 min … end + 90 min, on 15-minute steps.
 */
export function defaultWindows(ev: Pick<CityEvent, 'start' | 'end'>): [[number, number], [number, number]] {
  const [b0, b1] = EVENTS.serviceBefore;
  const [a0, a1] = EVENTS.serviceAfter;
  return [
    [snap(ev.start + b0), snap(ev.start + b1)],
    [snap(ev.end + a0), snap(ev.end + a1)],
  ];
}

export interface ServiceEstimate {
  /** Extra car-km over the route's own timetable in the window (both directions). */
  extraCarKm: number;
  /** At ECONOMY.operatingPerCarKm. */
  cost: number;
  /**
   * Trains to run the requested headway (incl. spares), sized like trainsNeeded() in compile.ts:
   * the round trip includes the route's recovery, so it agrees with the route panel.
   */
  trainsNeeded: number;
  trainsOwned: number;
  /** The headway the owned fleet can actually run, seconds (≥ the requested one). */
  effectiveHeadway: number;
}

/**
 * What running `cr` every `headwayMin` minutes in [from, to) (absolute game seconds) adds. The
 * route's own headway applies where it is shorter, and the fleet caps the frequency at
 * roundTrip / fleet. Extra trips are counted per 10-minute slice against the route's own service.
 * `recoveryPct` is the route's recovery (Route.control): it sizes the fleet the timetable needs,
 * while the frequency cap uses the physical round trip (the sim adds no layover; recovery is the
 * extra trains waiting at the terminals).
 */
export function serviceEstimate(cr: CRoute, from: number, to: number, headwayMin: number, recoveryPct = 0): ServiceEstimate {
  const h = headwayMin * 60;
  const runTimes: [number, number] = [cr.dirs[0].runTime, cr.dirs[1].runTime];
  const roundTrip = roundTripTime({}, runTimes);
  const fleet = cr.fleet;
  const effectiveHeadway = fleet > 0 ? Math.max(h, roundTrip / fleet) : Infinity;
  let trips = 0;
  const SLICE = 600;
  for (let t = from; t < to; t += SLICE) {
    const slice = Math.min(SLICE, to - t);
    const base = cr.headways[periodIndex(t + slice / 2)];
    const have = base > 0 ? slice / base : 0;
    const want = Number.isFinite(effectiveHeadway) ? slice / effectiveHeadway : 0;
    trips += Math.max(0, want - have);
  }
  const extraCarKm = (trips * (cr.dirs[0].length + cr.dirs[1].length) / 1000) * cr.cars;
  return {
    extraCarKm,
    cost: extraCarKm * ECONOMY.operatingPerCarKm,
    trainsNeeded: Math.ceil(roundTripTime({ control: { recoveryPct } }, runTimes) / h) + OPERATIONS.spareTrains,
    trainsOwned: fleet,
    effectiveHeadway,
  };
}
