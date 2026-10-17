/**
 * Validation, cost and construction-time calculation for track and stations.
 */
import { QUAD, STATION, TRACK, TRAINS, type TrackClass, type TrackLevel } from '../balance';
import { fmtDistance } from '../core/units';
import { curveSpeed, minRadiusOver, otherEnd } from './geometry';
import { platformLength, type Network } from './network';
import type { TrackEdge } from './types';

/** Everything construction needs to know about the ground. */
export interface Terrain {
  /** True over water (or outside the city's land). */
  isWater(x: number, y: number): boolean;
  /** Residents + jobs per km² of the tract underneath. */
  density(x: number, y: number): number;
}

export const LEVEL_NAMES: Record<TrackLevel, string> = {
  elevated: 'elevated',
  'at-grade': 'at-grade',
  'cut-and-cover': 'cut-and-cover',
  deep: 'deep tunnel',
};

/** Water rule by actual height: a bridge deck or a tunnel deep enough to pass under the river. */
const BRIDGE_MIN_HEIGHT = 4;
const TUNNEL_MAX_HEIGHT = -16;

export interface EdgeReport {
  ok: boolean;
  errors: string[];
  cost: number;
  days: number;
  length: number;
  waterLength: number;
  /** Lowest curve speed limit on the edge (m/s). */
  speedLimit: number;
  minRadius: number;
  /** Average density multiplier applied (for tooltips). */
  densityMult: number;
}

export function classMult(cls: TrackClass): number {
  return cls === 'light' ? TRACK.lightCostMultiplier : 1;
}

/**
 * Four-track sections (v2): the second pair shares excavation, structure and right of way, and
 * turnouts and crossovers sit inside the four-track box. Exactly 1 for ordinary track.
 */
export function quadCostFactor(e: TrackEdge): number {
  const r = e.quad?.role;
  return r === 'express' ? QUAD.secondPairCostFactor : r === 'link' ? QUAD.linkCostFactor : 1;
}

export function edgeReport(net: Network, edgeId: number, terrain: Terrain): EdgeReport {
  const e = net.edges.get(edgeId)!;
  const g = net.geom(edgeId);
  const na = net.nodes.get(e.a)!;
  const nb = net.nodes.get(e.b)!;
  const L = g.length;
  const errors: string[] = [];
  const minR = TRACK.minRadius[e.cls];

  // Curves
  if (g.overlap) errors.push('Curves overlap — spread the points further apart');
  let minRadius = Infinity;
  for (const p of g.pieces) minRadius = Math.min(minRadius, p.r);
  if (isFinite(minRadius) && minRadius < minR - 0.5) {
    errors.push(
      `Curve too tight: ${fmtDistance(minRadius, true)} radius (${e.cls} metro needs ${fmtDistance(minR, true)})`,
    );
  }
  if (L < 10) errors.push('Segment too short');

  // Ramps
  const ha = TRACK.height[na.level];
  const hb = TRACK.height[nb.level];
  const dh = Math.abs(hb - ha);
  if (dh > 0) {
    const need = dh / TRACK.maxGrade[e.cls];
    if (L < need - 0.5) {
      errors.push(
        `Needs ${fmtDistance(need - L, true)} more ramp to go from ${LEVEL_NAMES[na.level]} to ${LEVEL_NAMES[nb.level]}`,
      );
    }
  }

  // Junction alignment: edges leave anchors straight along the through heading, and a junction
  // needs track on both sides (otherwise nothing can run through it).
  for (const nid of [e.a, e.b]) {
    const n = net.nodes.get(nid)!;
    if (!n.anchor || net.degree(nid) < 2) continue;
    const [hx, hy] = net.departHeading(edgeId, nid);
    const dot = Math.abs(hx * n.hx + hy * n.hy);
    if (dot < Math.cos((2 * Math.PI) / 180)) {
      errors.push('Track must leave the junction straight, along the existing line');
      break;
    }
    const sides = net.incident(nid).map((eid) => {
      const [x, y] = net.departHeading(eid, nid);
      return Math.sign(x * n.hx + y * n.hy);
    });
    if (sides.every((sd) => sd === sides[0])) {
      errors.push("Track can't double back at a track end — continue away from it");
      break;
    }
  }

  // Sample along the edge for water, cost and time.
  let cost = 0;
  let days = 0;
  let waterLength = 0;
  let multSum = 0;
  let badWaterLevel: TrackLevel | null = null;
  const steps = Math.max(1, Math.ceil(L / TRACK.sampleStep));
  const ds = L / steps;
  let idx = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    while (idx + 1 < g.cum.length - 1 && g.cum[idx + 1] < s) idx++;
    const seg = g.cum[idx + 1] - g.cum[idx] || 1;
    const f = (s - g.cum[idx]) / seg;
    const x = g.xs[idx] + (g.xs[idx + 1] - g.xs[idx]) * f;
    const y = g.ys[idx] + (g.ys[idx + 1] - g.ys[idx]) * f;
    const level = s < L / 2 ? na.level : nb.level;
    const h = ha + (hb - ha) * (s / (L || 1));
    const water = terrain.isWater(x, y);
    let mult = 1;
    if (water) {
      waterLength += ds;
      if (h > TUNNEL_MAX_HEIGHT && h < BRIDGE_MIN_HEIGHT) badWaterLevel ??= level;
      if (level === 'elevated') mult = TRACK.bridgeMultiplier;
      else if (level === 'deep') mult = TRACK.underwaterTunnelMultiplier;
    } else if (TRACK.densityAffects[level]) {
      mult = 1 + TRACK.densityK * terrain.density(x, y);
    }
    multSum += mult;
    cost += TRACK.costPerM[level] * mult * ds;
    days += (TRACK.daysPerKm[level] / 1000) * ds;
  }
  if (badWaterLevel) {
    const what = badWaterLevel === 'elevated' || badWaterLevel === 'deep' ? 'This ramp' : `${cap(LEVEL_NAMES[badWaterLevel])} track`;
    errors.push(`${what} can't cross water — use elevated (bridge) or deep tunnel over the water`);
  }
  cost *= classMult(e.cls) * quadCostFactor(e);
  return {
    ok: errors.length === 0,
    errors,
    cost,
    days,
    length: L,
    waterLength,
    speedLimit: Math.min(curveSpeed(minRadius), TRAINS[e.cls].topSpeed),
    minRadius,
    densityMult: multSum / steps,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Stations

export interface StationReport {
  ok: boolean;
  errors: string[];
  cost: number;
  days: number;
  level: TrackLevel | null;
}

export function stationCost(level: TrackLevel, cars: number, cls: TrackClass): number {
  return (STATION.costByLevel[level] + STATION.costPerCar * cars) * classMult(cls);
}

export interface StationReportOptions {
  /** Price it as one platform of a cross-platform pair (default: when it has a partner). */
  paired?: boolean;
  /** Its cross-platform partner, ignored by the spacing rule (default: ignoreStation's `pair`). */
  partner?: number | null;
}

export function stationReport(
  net: Network,
  edgeId: number,
  u: number,
  cars: number,
  terrain: Terrain,
  ignoreStation: number | null = null,
  opts: StationReportOptions = {},
): StationReport {
  const e = net.edges.get(edgeId);
  if (!e) return { ok: false, errors: ['No track here'], cost: 0, days: 0, level: null };
  const g = net.geom(edgeId);
  const errors: string[] = [];
  const lim = STATION.cars[e.cls];
  if (cars < lim.min || cars > lim.max)
    errors.push(`${cap(e.cls)} metro platforms are ${lim.min}–${lim.max} cars long`);
  const P = platformLength(cars, e.cls);
  const level = net.levelAt(edgeId, u);
  if (net.isRamp(edgeId)) errors.push('Stations need level track — this section is a ramp');
  if (u - P / 2 < 0 || u + P / 2 > g.length) {
    errors.push(`Platform doesn't fit here — needs ${fmtDistance(P, true)} of track between points`);
  } else {
    const r = minRadiusOver(g, u - P / 2, u + P / 2);
    if (r < STATION.minRadius)
      errors.push(
        `Stations need nearly straight track (curve radius ${fmtDistance(r, true)} here, needs ${fmtDistance(STATION.minRadius, true)})`,
      );
  }
  const pos = net.stationPos({ edge: edgeId, u } as never);
  if (terrain.isWater(pos.x, pos.y)) errors.push('Stations must be on land');
  // A cross-platform partner is reachable along track through any crossover; it never counts.
  const partner = opts.partner ?? (ignoreStation !== null ? net.stations.get(ignoreStation)?.pair : undefined) ?? null;
  const paired = opts.paired ?? partner !== null;
  const near = nearestStationAlongTrack(net, edgeId, u, STATION.minSpacing, ignoreStation, partner);
  if (near) {
    errors.push(
      `Too close to ${near.name} (${fmtDistance(near.dist, true)} along the track; needs ${fmtDistance(STATION.minSpacing, true)})`,
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    cost: stationCost(level, cars, e.cls) * (paired ? QUAD.pairPlatformCostShare : 1),
    days: STATION.buildDays[level],
    level,
  };
}

/** Bounded search along connected track for the closest other station within `limit` metres. */
export function nearestStationAlongTrack(
  net: Network,
  edgeId: number,
  u: number,
  limit: number,
  ignore: number | null,
  ignore2: number | null = null,
): { id: number; name: string; dist: number } | null {
  const byEdge = new Map<number, { id: number; u: number; name: string }[]>();
  for (const s of net.stations.values()) {
    if (s.id === ignore || s.id === ignore2) continue;
    let l = byEdge.get(s.edge);
    if (!l) byEdge.set(s.edge, (l = []));
    l.push({ id: s.id, u: s.u, name: s.name });
  }
  let best: { id: number; name: string; dist: number } | null = null;
  const consider = (id: number, name: string, d: number) => {
    if (d < limit && (!best || d < best.dist)) best = { id, name, dist: d };
  };
  const e0 = net.edges.get(edgeId)!;
  const L0 = net.geom(edgeId).length;
  for (const s of byEdge.get(edgeId) ?? []) consider(s.id, s.name, Math.abs(s.u - u));
  // Dijkstra over nodes (small, bounded).
  const dist = new Map<number, number>([
    [e0.a, u],
    [e0.b, L0 - u],
  ]);
  const queue: [number, number][] = [
    [u, e0.a],
    [L0 - u, e0.b],
  ];
  const done = new Set<number>();
  while (queue.length) {
    queue.sort((p, q) => p[0] - q[0]);
    const [d, nid] = queue.shift()!;
    if (done.has(nid) || d >= limit) continue;
    done.add(nid);
    for (const eid of net.incident(nid)) {
      if (eid === edgeId) continue;
      const e = net.edges.get(eid)!;
      const L = net.geom(eid).length;
      const fromA = e.a === nid;
      for (const s of byEdge.get(eid) ?? []) consider(s.id, s.name, d + (fromA ? s.u : L - s.u));
      const o = otherEnd(e, nid);
      const nd = d + L;
      if (nd < (dist.get(o) ?? Infinity)) {
        dist.set(o, nd);
        queue.push([nd, o]);
      }
    }
  }
  return best;
}
