/**
 * Compile the player's design into the flat network the simulation runs on:
 * operational routes with paths, speed limits, directed track elements, junction merge locks
 * and timetables.
 */
import { OPERATIONS, QUAD, TRACK, TRAINS, type TrackLevel } from '../balance';
import type { Game } from '../core/game';
import { curveSpeed, otherEnd } from '../construction/geometry';
import type { Network } from '../construction/network';
import { slicePolyline } from '../map/polyline';
import type { CElement, CompiledNetwork, CRoute, CRouteDir, CStation } from '../sim/protocol';
import { runProfile, type SpeedLimit } from '../trains/kinematics';
import { computeInterchanges } from './interchange';
import { trainLength } from './routeSet';
import { PERIOD_IDS, type PathLeg, type Route, type RouteControl } from './types';
import { platformLength } from '../construction/network';

const ALIGN = Math.cos((25 * Math.PI) / 180);

/** Track open to the weather (city chaos: snow and heat cap speeds there). */
const exposed = (l: TrackLevel) => l === 'elevated' || l === 'at-grade';

export interface CompileResult {
  net: CompiledNetwork;
  /** route id → compiled route index */
  routeIndex: Map<number, number>;
  stationIndex: Map<number, number>;
}

/** Merge locks: (node, outgoing directed track) fed by two or more incoming tracks. */
function mergeLocks(net: Network, trackIdx: (edge: number, dir: 0 | 1) => number): Map<string, number> {
  const locks = new Map<string, number>();
  for (const n of net.nodes.values()) {
    const inc = net.incident(n.id);
    if (inc.length < 3) continue;
    for (const f of inc) {
      const fe = net.edges.get(f)!;
      const [ox, oy] = net.departHeading(f, n.id);
      let feeders = 0;
      for (const g of inc) {
        if (g === f) continue;
        const [gx, gy] = net.departHeading(g, n.id);
        // Arriving along g means travelling −(g's departure heading).
        if (-(gx * ox + gy * oy) >= ALIGN) feeders++;
      }
      if (feeders >= 2) {
        const dir: 0 | 1 = fe.a === n.id ? 0 : 1;
        locks.set(`${n.id}:${trackIdx(f, dir)}`, locks.size);
      }
    }
  }
  return locks;
}

function reverseLegs(legs: PathLeg[]): PathLeg[] {
  return [...legs].reverse().map((l) => ({ edge: l.edge, dir: (1 - l.dir) as 0 | 1, u0: l.u1, u1: l.u0 }));
}

function buildDir(
  net: Network,
  legsIn: PathLeg[],
  stopIds: number[],
  stopEdgeU: { edge: number; u: number }[],
  ext: [number, number],
  r: Route,
  trackIdx: (edge: number, dir: 0 | 1) => number,
  locks: Map<string, number>,
  stationIndex: Map<number, number>,
  timepoints: ReadonlySet<number> = new Set(),
): CRouteDir {
  // Extend the first and last legs so the train fits at the terminal platforms.
  const legs = legsIn.map((l) => ({ ...l }));
  const first = legs[0];
  const L0 = net.geom(first.edge).length;
  first.u0 = first.dir === 0 ? Math.max(0, first.u0 - ext[0]) : Math.min(L0, first.u0 + ext[0]);
  const last = legs[legs.length - 1];
  const Ln = net.geom(last.edge).length;
  last.u1 = last.dir === 0 ? Math.min(Ln, last.u1 + ext[1]) : Math.max(0, last.u1 - ext[1]);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const limits: SpeedLimit[] = [];
  const elems: CElement[] = [];
  const outdoor: [number, number][] = [];
  let s = 0;
  for (const leg of legs) {
    const e = net.edges.get(leg.edge)!;
    const g = net.geom(leg.edge);
    const L = g.length;
    const lo = Math.min(leg.u0, leg.u1), hi = Math.max(leg.u0, leg.u1);
    let pts = slicePolyline(g.xs, g.ys, g.cum, lo, hi);
    if (leg.dir === 1) pts = pts.reverse();
    const len = hi - lo;
    pts.forEach(([x, y], i) => {
      if (xs.length && i === 0) {
        const px = xs[xs.length - 1], py = ys[ys.length - 1];
        if (Math.hypot(px - x, py - y) < 0.01) return;
      }
      xs.push(x);
      ys.push(y);
      // Height along the leg (for 3D trains).
      const f = pts.length > 1 ? i / (pts.length - 1) : 0;
      const u = leg.dir === 0 ? lo + f * len : hi - f * len;
      zs.push(net.heightAt(leg.edge, u));
    });
    // Curve speed limits from the edge's arc pieces.
    for (const p of g.pieces) {
      if (!isFinite(p.r)) continue;
      const a = Math.max(lo, p.s0), b = Math.min(hi, p.s1);
      if (b <= a) continue;
      const sa = leg.dir === 0 ? s + (a - lo) : s + (hi - b);
      limits.push({ s0: sa, s1: sa + (b - a), v: curveSpeed(p.r, e.cls) });
    }
    // Line speed (train types): the most any train may run on this class of track. Metro trains
    // are slower than heavy and light track allow, so their profiles are as before.
    const line = TRACK.lineSpeed[e.cls];
    if (isFinite(line) && line < TRAINS[r.stock].topSpeed && len > 0) limits.push({ s0: s, s1: s + len, v: line });
    // Outdoor stretches in edge coordinates: the whole edge, or the exposed half of a ramp (the
    // same half-way rule as Network.levelAt).
    const la = net.nodes.get(e.a)!.level, lb = net.nodes.get(e.b)!.level;
    const open: [number, number][] = la === lb ? (exposed(la) ? [[0, L]] : []) : [...(exposed(la) ? [[0, L / 2] as [number, number]] : []), ...(exposed(lb) ? [[L / 2, L] as [number, number]] : [])];
    for (const [x0, x1] of open) {
      const a = Math.max(lo, x0), b = Math.min(hi, x1);
      if (b <= a) continue;
      const sa = leg.dir === 0 ? s + (a - lo) : s + (hi - b);
      outdoor.push([sa, sa + (b - a)]);
    }
    // Directed track element.
    const startNode = leg.dir === 0 ? e.a : e.b;
    const atNode = leg.dir === 0 ? lo < 0.5 : hi > L - 0.5;
    const track = trackIdx(leg.edge, leg.dir);
    const u0 = leg.dir === 0 ? leg.u0 : L - leg.u0;
    elems.push({
      track,
      edge: leg.edge,
      edgeDir: leg.dir,
      u0,
      s0: s,
      s1: s + len,
      lock: atNode ? (locks.get(`${startNode}:${track}`) ?? -1) : -1,
    });
    s += len;
  }
  const X = new Float64Array(xs), Y = new Float64Array(ys);
  const cum = new Float64Array(X.length);
  for (let i = 1; i < X.length; i++) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  const length = cum[cum.length - 1];
  // Rescale element and limit coordinates to the sampled length (sub-metre differences).
  const k = s > 0 ? length / s : 1;
  for (const el of elems) {
    el.s0 *= k;
    el.s1 *= k;
  }
  for (const l of limits) {
    l.s0 *= k;
    l.s1 *= k;
  }
  // Outdoor stretches in path s, sorted, with gaps under 1 m merged.
  outdoor.sort((a, b) => a[0] - b[0]);
  const outS0: number[] = [], outS1: number[] = [];
  for (const [a, b] of outdoor) {
    const n = outS0.length;
    if (n && a * k - outS1[n - 1] < 1) outS1[n - 1] = Math.max(outS1[n - 1], b * k);
    else {
      outS0.push(a * k);
      outS1.push(b * k);
    }
  }
  // Stop positions along this path.
  const stopS = new Float64Array(stopIds.length);
  stopEdgeU.forEach((st, i) => {
    let acc = 0;
    let found = -1;
    for (const leg of legs) {
      const lo = Math.min(leg.u0, leg.u1), hi = Math.max(leg.u0, leg.u1);
      if (leg.edge === st.edge && st.u >= lo - 0.5 && st.u <= hi + 0.5) {
        found = acc + (leg.dir === 0 ? st.u - lo : hi - st.u);
        // Stops are visited in order; take the first match after the previous stop.
        if (i === 0 || found > stopS[i - 1]) break;
      }
      acc += hi - lo;
    }
    stopS[i] = Math.max(0, found) * k;
  });
  const spec = TRAINS[r.stock];
  limits.sort((a, b) => a.s0 - b.s0);
  const prof = runProfile(length, limits, [...stopS], spec.accel, spec.brake, spec.topSpeed, OPERATIONS.scheduledDwell);
  return {
    xs: X,
    ys: Y,
    zs: new Float64Array(zs),
    cum,
    length,
    stopStation: new Int32Array(stopIds.map((id) => stationIndex.get(id)!)),
    stopS,
    limS0: new Float64Array(limits.map((l) => l.s0)),
    limS1: new Float64Array(limits.map((l) => l.s1)),
    limV: new Float64Array(limits.map((l) => l.v)),
    elems,
    schedArrive: new Float64Array(prof.arrive),
    schedDepart: new Float64Array(prof.depart),
    runTime: prof.total,
    outS0: new Float64Array(outS0),
    outS1: new Float64Array(outS1),
    // Timepoints: never the first or last stop (the first stop has terminal holding).
    timepoint: Uint8Array.from(stopIds, (id, k) => (k > 0 && k < stopIds.length - 1 && timepoints.has(id) ? 1 : 0)),
  };
}

type FleetRoute = Pick<Route, 'headways'> & { control?: Partial<Pick<RouteControl, 'recoveryPct'>> };

/**
 * Scheduled round trip, s: both one-way runs plus recovery (a share of the run time, split over
 * the two terminal layovers) plus two standard turnarounds.
 */
export function roundTripTime(r: Pick<FleetRoute, 'control'>, runTimes: [number, number]): number {
  const run = runTimes[0] + runTimes[1];
  const rec = r.control?.recoveryPct ?? 0;
  return (rec ? run * (1 + rec) : run) + 2 * OPERATIONS.turnaround;
}

/** Recovery time at each terminal, s (the mean of the two ends). */
export function recoveryPerTerminal(r: FleetRoute, runTimes: [number, number]): number {
  return ((runTimes[0] + runTimes[1]) * (r.control?.recoveryPct ?? 0)) / 2;
}

/** Trains for the shortest headway: round trip (with recovery) ÷ headway, rounded up, plus spares. */
export function trainsNeeded(r: FleetRoute, runTimes: [number, number]): number {
  let minHw = Infinity;
  for (const p of PERIOD_IDS) if (r.headways[p] > 0) minHw = Math.min(minHw, r.headways[p] * 60);
  if (!isFinite(minHw)) return 0;
  return Math.ceil(roundTripTime(r, runTimes) / minHw) + OPERATIONS.spareTrains;
}

/** Fingerprint of the settings that reach the sim but not the fleet (App.recompile's signature). */
export function opsKey(c: RouteControl): string {
  return `${c.hold ? c.holdFraction : 0}|${[...c.timepoints].sort((a, b) => a - b).join(',')}|${c.shortTurn ? 1 : 0}`;
}

/** Scheduled one-way run times for a route (for the UI and fleet sizing), or null if no path. */
export function routeTimetable(game: Game, r: Route): { runTimes: [number, number]; legTimes: number[] } | null {
  const c = compileRoute(game, r, new Map(), new Map([...game.network.stations.keys()].map((id, i) => [id, i])));
  if (!c) return null;
  return {
    runTimes: [c.dirs[0].runTime, c.dirs[1].runTime],
    legTimes: Array.from(c.dirs[0].schedArrive).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1),
  };
}

function compileRoute(
  game: Game,
  r: Route,
  trackMap: Map<number, number>,
  stationIndex: Map<number, number>,
  locks: Map<string, number> = new Map(),
): CRoute | null {
  const net = game.network;
  const path = game.routes.path(net, r);
  if (!path.ok) return null;
  const trackIdx = (edge: number, dir: 0 | 1) => {
    const key = edge * 2 + dir;
    let t = trackMap.get(key);
    if (t === undefined) trackMap.set(key, (t = trackMap.size));
    return t;
  };
  const stopEdgeU = r.stops.map((id) => {
    const st = net.stations.get(id)!;
    return { edge: st.edge, u: st.u };
  });
  const tl = trainLength(r);
  const firstSt = net.stations.get(r.stops[0])!;
  const lastSt = net.stations.get(r.stops[r.stops.length - 1])!;
  const ext: [number, number] = [
    Math.min(platformLength(firstSt.cars, r.cls) / 2, tl / 2 + 5),
    Math.min(platformLength(lastSt.cars, r.cls) / 2, tl / 2 + 5),
  ];
  const tps = new Set(r.control.timepoints);
  const d0 = buildDir(net, path.legs, r.stops, stopEdgeU, ext, r, trackIdx, locks, stationIndex, tps);
  const d1 = buildDir(net, reverseLegs(path.legs), [...r.stops].reverse(), [...stopEdgeU].reverse(), [ext[1], ext[0]], r, trackIdx, locks, stationIndex, tps);
  const spec = TRAINS[r.stock];
  return {
    id: r.id,
    name: r.name,
    bullet: r.bullet,
    color: r.color,
    ...(r.shape ? { shape: r.shape } : {}),
    cls: r.cls,
    stock: r.stock,
    cars: r.cars,
    trainLength: tl,
    capComfort: spec.capacityComfort * r.cars,
    capCrush: spec.capacityCrush * r.cars,
    accel: spec.accel,
    brake: spec.brake,
    vmax: spec.topSpeed,
    headways: PERIOD_IDS.map((p) => r.headways[p] * 60),
    fleet: Math.floor(r.ownedCars / Math.max(1, r.cars)),
    dirs: [d0, d1],
    hold: r.control.hold ? r.control.holdFraction : 0,
    shortTurn: r.control.shortTurn,
    opsKey: opsKey(r.control),
    // Express service (v2): only set on expresses, so a local's compiled route is as before.
    ...(r.express ? { express: true } : {}),
  };
}

export function compileNetwork(game: Game): CompileResult {
  const net = game.network;
  const builtStations = [...net.stations.values()].filter((s) => s.status === 'built');
  const ic = computeInterchanges(net, (id) => net.stations.get(id)!.status === 'built');
  const stationIndex = new Map<number, number>();
  const stations: CStation[] = builtStations.map((s, i) => {
    stationIndex.set(s.id, i);
    const p = net.stationPos(s);
    return { id: s.id, x: p.x, y: p.y, name: s.name, group: ic.groupOf.get(s.id) ?? i, ...(s.parking ? { parking: s.parking } : {}) };
  });
  // Four-track sections (v2): cross-platform pairs whose platforms are both built. A pair is one
  // station complex for staffing (QUAD.pairStaffing stations). Nothing is added without pairs.
  let pairs = 0;
  builtStations.forEach((s, i) => {
    const j = s.pair !== undefined ? stationIndex.get(s.pair) : undefined;
    if (j === undefined || j === i) return;
    const a = net.stationPos(s), b = net.stationPos(builtStations[j]);
    stations[i].pair = j;
    stations[i].pairSameDir = a.hx * b.hx + a.hy * b.hy >= 0;
    if (i < j) pairs++;
  });
  const trackMap = new Map<number, number>();
  const trackIdx = (edge: number, dir: 0 | 1) => {
    const key = edge * 2 + dir;
    let t = trackMap.get(key);
    if (t === undefined) trackMap.set(key, (t = trackMap.size));
    return t;
  };
  const locks = mergeLocks(net, trackIdx);
  const routes: CRoute[] = [];
  const routeIndex = new Map<number, number>();
  for (const r of game.routes.list()) {
    if (!game.routes.operational(net, r).ok) continue;
    const c = compileRoute(game, r, trackMap, stationIndex, locks);
    if (!c || c.fleet === 0) continue;
    routeIndex.set(r.id, routes.length);
    routes.push(c);
  }
  return {
    net: {
      version: net.version * 1000 + game.routes.version,
      stations,
      routes,
      trackCount: trackMap.size,
      lockCount: locks.size,
      ...(pairs ? { staffedStations: stations.length - pairs * (2 - QUAD.pairStaffing) } : {}),
    },
    routeIndex,
    stationIndex,
  };
}

export { otherEnd };
