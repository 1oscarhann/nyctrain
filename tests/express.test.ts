/**
 * Express services on four-track trunks (v2, docs/v2/express-quad.md §13 tests 15–22 and 25–30):
 * route pathfinding on quads and its gate (ordinary networks keep their paths exactly), stations
 * along a path, skip/serve and the patterns, compile, cross-platform transfers in the transit
 * graph, the train-sim overtaking test against a shared-pair control, save v6; and the interplay
 * with city chaos (stalls and crawls on one pair, a closed pair, event service, the watchdog),
 * operations control (holding beside the other pair, timepoints, recovery and fleet on the express
 * run time, regularity per route) and Living City (a pair is one served station). No world data.
 */
import { describe, expect, it } from 'vitest';
import { COMMUTERS, QUAD, STATION, type TrackLevel } from '../src/balance';
import { Game } from '../src/core/game';
import { Network } from '../src/construction/network';
import { pickEdge } from '../src/construction/pick';
import { addQuadStroke, addScissors, partnerPoint, scissorsCandidate, type QuadResult } from '../src/construction/quad';
import type { QuadRole, StrokePoint } from '../src/construction/types';
import { stationReport, type Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { compileNetwork, recoveryPerTerminal, routeTimetable, trainsNeeded } from '../src/routes/compile';
import { suggestTimepoints } from '../src/routes/control';
import { allStopsPattern, choosePlatform, expressPattern, pairKeyId, quadRole, serveStops, skipStops, stationsAlongPath } from '../src/routes/express';
import { platformTransfer, transferPenaltyFor } from '../src/routes/interchange';
import { findRoutePath, trackPath } from '../src/routes/pathfind';
import { defaultHeadways } from '../src/routes/routeSet';
import type { PeriodId, Route, RouteControl } from '../src/routes/types';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave } from '../src/save/serialize';
import { SAVE_VERSION } from '../src/save/format';
import { ChaosController } from '../src/sim/chaos';
import { servedStations } from '../src/sim/growth';
import { measureExposure, trackSpans } from '../src/sim/incidents';
import { hasExpressService, type CompiledNetwork, type CRoute, type CRouteDir } from '../src/sim/protocol';
import { TrainSim, TState, type PassengerHooks, type Train } from '../src/sim/trainSim';
import { effectiveTransfers, TransitGraph } from '../src/sim/transitGraph';

const dry: Terrain = { isWater: () => false, density: () => 0 };
const P = (x: number, y: number, level: TrackLevel = 'deep'): StrokePoint => ({ x, y, level });
const none = { kind: 'none' } as const;
const CARS = 8;

function stubGame(): Game {
  return new Game({} as World, dry, { sandbox: true, fare: 3 });
}

function nodeAt(net: Network, x: number, y: number): number {
  let best = -1, bd = Infinity;
  for (const n of net.nodes.values()) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) [best, bd] = [n.id, d];
  }
  if (bd > 0.5) throw new Error(`no node at ${x},${y}`);
  return best;
}

/** A platform at x on the track of `role` (null: ordinary track) nearest y. */
function platformAt(net: Network, x: number, y: number, role: QuadRole | null, name: string): number {
  const hit = pickEdge(net, x, y, 20, (id) => (net.edges.get(id)?.quad?.role ?? null) === role);
  if (!hit) throw new Error(`no ${role ?? 'plain'} track at ${x}`);
  return net.addStation(hit.edge, hit.u, CARS, name).id;
}

/** A cross-platform pair at x on the local pair (y = 0): [local, express]. */
function pairAt(net: Network, x: number, name: string): [number, number] {
  const hit = pickEdge(net, x, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
  const pp = partnerPoint(net, hit.edge, hit.u)!;
  const [a, b] = net.addStationPair(hit.edge, hit.u, pp.edge, pp.u, CARS, name);
  return [a.id, b.id];
}

function roles(net: Network, legs: { edge: number }[]): Set<string> {
  return new Set(legs.map((l) => net.edges.get(l.edge)?.quad?.role ?? 'plain'));
}

function route(game: Game, name: string, stops: number[], express = false, headways: Partial<Record<PeriodId, number>> = {}, control?: Partial<RouteControl>): Route {
  const r = game.routes.create({ name, bullet: name.slice(0, 1), color: '#E8443A', cls: 'heavy', stops, cars: CARS, headways: { ...defaultHeadways(), ...headways }, express, ...(control ? { control } : {}) });
  const tt = routeTimetable(game, r)!;
  game.routes.update(r.id, { ownedCars: trainsNeeded(r, tt.runTimes) * CARS });
  return r;
}

// ------------------------------------------------------------------------------------------
// The pathfinding quad (tests 15–22): a free/free quad (0,0) → (6000,0) with scissors near both
// ends, the express pair at y = −9; cross-platform pairs A, C, E at 1000, 3000, 5000 and local-only
// stops B and D at 2000 and 4000.
function patternQuad(extraScissors = false) {
  const game = stubGame();
  const net = game.network;
  const q = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
  if (!q.ok) throw new Error(q.fatal);
  if (extraScissors) {
    for (const x of [1500, 2500]) {
      const hit = pickEdge(net, x, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
      const c = scissorsCandidate(net, hit.edge, hit.u, 'heavy');
      if (!c.ok) throw new Error(c.reason);
      expect(addScissors(net, c.g, c.edge, c.uA, c.uB, 'heavy').ok).toBe(true);
    }
  }
  const A = pairAt(net, 1000, 'A');
  const B = platformAt(net, 2000, 0, 'local', 'B');
  const C = pairAt(net, 3000, 'C');
  const D = platformAt(net, 4000, 0, 'local', 'D');
  const E = pairAt(net, 5000, 'E');
  return { game, net, q, A, B, C, D, E, local: [A[0], B, C[0], D, E[0]], express: [A[1], C[1], E[1]] };
}

describe('route pathfinding on four tracks', () => {
  it('15. the express keeps to the express pair, the local to the local pair', () => {
    const { net, local, express } = patternQuad();
    const px = findRoutePath(net, 'heavy', express);
    expect(px.ok).toBe(true);
    expect([...roles(net, px.legs)]).toEqual(['express']);
    const pl = findRoutePath(net, 'heavy', local);
    expect(pl.ok).toBe(true);
    expect([...roles(net, pl.legs)]).toEqual(['local']);
    // A route from A's local platform to E's local platform skipping B, C and D has no crossover
    // between them: it stays on the local pair (paying for the platforms it passes) and still works.
    const pt = findRoutePath(net, 'heavy', [local[0], local[4]]);
    expect(pt.ok).toBe(true);
    expect([...roles(net, pt.legs)]).toEqual(['local']);
  });

  it('16. pass penalty: a skipping route takes the platform-free pair; ordinary track is never re-routed (the gate)', () => {
    // Fan at both ends: W on the approach, E on the exit; local-only platforms on the local pair.
    const game = stubGame();
    const net = game.network;
    net.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    net.addStroke([P(6000, 0), P(8000, 0)], 'heavy', none, none);
    const q = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, { kind: 'node', node: nodeAt(net, 6000, 0) }, { side: 1 });
    expect(q.ok).toBe(true);
    const W = platformAt(net, -1000, 0, null, 'W');
    const X = platformAt(net, 7000, 0, null, 'X');
    for (const x of [1500, 3000, 4500]) platformAt(net, x, 0, 'local', `L${x}`);
    const dflt = findRoutePath(net, 'heavy', [W, X]);
    const zero = findRoutePath(net, 'heavy', [W, X], undefined, { passPenalty: 0, linkPenalty: 0 });
    expect(roles(net, dflt.legs).has('express')).toBe(true);
    expect(roles(net, dflt.legs).has('local')).toBe(false);
    // Without penalties the drawn (local) pair is shorter: the turnouts add length.
    expect(roles(net, zero.legs).has('local')).toBe(true);
    expect(zero.length).toBeLessThan(dflt.length);
    // The same skip on ordinary track: a platform-free bypass about 5% longer is NOT taken (no quad
    // tags, no penalty), exactly as before express service.
    const plain = new Network();
    plain.addStroke([P(0, 0), P(800, 0)], 'heavy', none, none);
    plain.addStroke([P(800, 0), P(5200, 0)], 'heavy', { kind: 'node', node: nodeAt(plain, 800, 0) }, none);
    plain.addStroke([P(5200, 0), P(6000, 0)], 'heavy', { kind: 'node', node: nodeAt(plain, 5200, 0) }, none);
    plain.addStroke([P(800, 0), P(1500, 380), P(4500, 380), P(5200, 0)], 'heavy', { kind: 'node', node: nodeAt(plain, 800, 0) }, { kind: 'node', node: nodeAt(plain, 5200, 0) });
    const S1 = platformAt(plain, 300, 0, null, 'S1');
    platformAt(plain, 2500, 0, null, 'S2');
    platformAt(plain, 3500, 0, null, 'S3');
    const S4 = platformAt(plain, 5700, 0, null, 'S4');
    const a = findRoutePath(plain, 'heavy', [S1, S4]);
    const b = findRoutePath(plain, 'heavy', [S1, S4], undefined, { passPenalty: 0, linkPenalty: 0 });
    expect(a.ok).toBe(true);
    expect(a).toEqual(b);
    expect(a.legs.every((l) => plain.geom(l.edge).ys.every((y) => Math.abs(y) < 1))).toBe(true);
    // The bypass is usable (and about 5% longer): a route that stops on it takes it.
    const S5 = platformAt(plain, 3000, 380, null, 'S5');
    const c = findRoutePath(plain, 'heavy', [S1, S5, S4]);
    expect(c.ok).toBe(true);
    expect(c.length / a.length).toBeGreaterThan(1.02);
    expect(c.length / a.length).toBeLessThan(1.1);
  });

  it('17. v1 invariance: trunk-and-branch networks give deep-equal paths with and without penalties', () => {
    const net = new Network();
    // A trunk with gentle bends and a branch off it (16 stations), in local metres.
    const trunk = net.addStroke([P(0, 0), P(300, 1500), P(900, 3000), P(1700, 4600), P(2300, 6400), P(3100, 8200), P(3700, 10000)], 'heavy', none, none);
    const hit = pickEdge(net, 520, 2050, 60)!;
    let u = hit.u;
    while (!net.canSplitAt(hit.edge, u, 'heavy').ok) u -= 10;
    const jp = net.stationPos({ edge: hit.edge, u } as never);
    const branch = net.addStroke([P(jp.x, jp.y), P(jp.x - 200, jp.y + 900), P(-1200, 4200), P(-3200, 5600), P(-5200, 6400)], 'heavy', { kind: 'edge', edge: hit.edge, u }, none);
    expect(branch.length).toBeGreaterThan(0);
    // Stations every ~1 km along each line's edges (the trunk's ids changed at the junction: re-read them).
    const st: number[] = [];
    const place = (edges: number[], n: number, tag: string) => {
      let placed = 0;
      for (const e of edges) {
        const L = net.geom(e).length;
        for (let uu = 100; uu < L && placed < n; uu += 20) {
          if (!stationReport(net, e, uu, CARS, dry).ok) continue;
          st.push(net.addStation(e, uu, CARS, `${tag}${placed}`).id);
          placed++;
          uu += 900;
        }
      }
      return placed;
    };
    void trunk;
    const trunkEdges = [...net.edges.values()].filter((e) => !branch.includes(e.id)).map((e) => e.id);
    // In travel order along the trunk (by the y of the edge's first node).
    trunkEdges.sort((a, b) => net.nodes.get(net.edges.get(a)!.a)!.y - net.nodes.get(net.edges.get(b)!.a)!.y);
    expect(place(trunkEdges, 9, 'T')).toBe(9);
    expect(place(branch, 7, 'B')).toBe(7);
    expect(st.length).toBe(16);
    const trunkStops = st.slice(0, 9);
    const junctionAfter = trunkStops.filter((id) => net.stationPos(net.stations.get(id)!).y < jp.y);
    const viaBranch = [...junctionAfter, ...st.slice(9)];
    for (const stops of [trunkStops, [...trunkStops].reverse(), viaBranch, [...viaBranch].reverse(), [st[0], st[4], st[8]]]) {
      const a = findRoutePath(net, 'heavy', stops);
      const b = findRoutePath(net, 'heavy', stops, undefined, { passPenalty: 0, linkPenalty: 0 });
      expect(a.ok).toBe(true);
      expect(a.legs).toEqual(b.legs);
      expect(a.stopS).toEqual(b.stopS);
      expect(a.length).toBe(b.length);
      // Distances: exactly the legs' lengths, summed in path order.
      expect(a.length).toBeCloseTo(a.legs.reduce((s2, l) => s2 + Math.abs(l.u1 - l.u0), 0), 6);
    }
  });

  it('18. RoutePath.length and stopS are distances, not penalised costs', () => {
    const { net, local, express } = patternQuad();
    // A route that has to pass unserved platforms (A to E on the local pair, skipping B, C, D).
    for (const stops of [express, [local[0], local[4]]]) {
      const p = findRoutePath(net, 'heavy', stops);
      const sum = p.legs.reduce((s, l) => s + Math.abs(l.u1 - l.u0), 0);
      expect(p.length).toBeCloseTo(sum, 6);
      expect(p.stopS[p.stopS.length - 1]).toBeCloseTo(p.length, 6);
      expect(p.length).toBeLessThan(5000);
    }
    // trackPath: the cheaper direction's legs from A_x to E_x.
    const a = net.stations.get(express[0])!, e = net.stations.get(express[2])!;
    const legs = trackPath(net, { edge: a.edge, u: a.u }, { edge: e.edge, u: e.u })!;
    expect([...roles(net, legs)]).toEqual(['express']);
    expect(legs.reduce((s, l) => s + Math.abs(l.u1 - l.u0), 0)).toBeCloseTo(4000, 0);
  });
});

describe('express patterns', () => {
  it('19. stationsAlongPath lists A, C, E served and B, D beside, in path order', () => {
    const { net, express, B, D } = patternQuad();
    const p = findRoutePath(net, 'heavy', express);
    const along = stationsAlongPath(net, express, p);
    expect(along.map((a) => net.stations.get(a.station)!.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(along.map((a) => a.served)).toEqual([true, false, true, false, true]);
    expect(along.map((a) => a.where)).toEqual(['on-track', 'beside', 'on-track', 'beside', 'on-track']);
    expect(along.map((a) => a.terminal)).toEqual([true, false, false, false, true]);
    expect(along.find((a) => a.station === B)!.partner).toBeUndefined();
    expect(along[0].partner).toBe(net.stations.get(express[0])!.pair);
    for (let i = 1; i < along.length; i++) expect(along[i].s).toBeGreaterThan(along[i - 1].s);
    expect(along[0].s).toBe(0);
    expect(along.find((a) => a.station === D)!.s).toBeCloseTo(3000, -1);
  });

  it('20. serveStops inserts in order (or says no crossover reaches it); skipStops keeps the terminals', () => {
    const { net, express, B } = patternQuad();
    const p = findRoutePath(net, 'heavy', express);
    const res = serveStops(net, 'heavy', express, p, B);
    expect('error' in res && res.error).toMatch(/no crossover/);
    // With scissors before and after B the express can stop there.
    const q = patternQuad(true);
    const p2 = findRoutePath(q.net, 'heavy', q.express);
    const ok = serveStops(q.net, 'heavy', q.express, p2, q.B);
    expect('stops' in ok && ok.stops).toEqual([q.express[0], q.B, q.express[1], q.express[2]]);
    const pb = findRoutePath(q.net, 'heavy', (ok as { stops: number[] }).stops);
    expect(pb.ok).toBe(true);
    expect(roles(q.net, pb.legs).has('link')).toBe(true);
    // Serving a served stop changes nothing; skipping.
    expect(serveStops(net, 'heavy', express, p, express[1])).toEqual({ stops: express });
    expect(skipStops(net, express, express[0])).toEqual({ error: "Terminals can't be skipped — shorten the route instead" });
    expect(skipStops(net, express, express[1])).toEqual({ stops: [express[0], express[2]] });
    // Either platform of a pair names the stop.
    expect(skipStops(net, express, net.stations.get(express[1])!.pair!)).toEqual({ stops: [express[0], express[2]] });
  });

  it('21. expressPattern turns the all-stops local into the express; allStopsPattern turns it back', () => {
    const { net, local, express } = patternQuad();
    expect(expressPattern(net, local)).toEqual(express);
    const p = findRoutePath(net, 'heavy', express);
    expect(allStopsPattern(net, 'heavy', express, p)).toEqual(local);
    // Ordinary stops are left alone.
    expect(expressPattern(net, express)).toEqual(express);
  });

  it('22. choosePlatform: an express draft picks the express platform, Alt the local one; a lone platform is itself', () => {
    const { net, A, B } = patternQuad();
    for (const id of A) {
      expect(choosePlatform(net, id, true, false)).toBe(A[1]);
      expect(choosePlatform(net, id, true, true)).toBe(A[0]);
      expect(choosePlatform(net, id, false, false)).toBe(A[0]);
      expect(choosePlatform(net, id, false, true)).toBe(A[1]);
    }
    expect(choosePlatform(net, B, true, false)).toBe(B);
    expect(quadRole(net, A[1])).toBe('express');
    expect(quadRole(net, B)).toBe('local');
  });
});

// ------------------------------------------------------------------------------------------
describe('compile and the transit graph', () => {
  it('25. compile pairs platforms symmetrically (same direction), staffs a pair as 1.4 stations, flags expresses', () => {
    const { game, net, local, express } = patternQuad();
    game.build(true);
    const lr = route(game, 'Local', local);
    const xr = route(game, 'Express', express, true);
    const c = compileNetwork(game);
    const st = c.net.stations;
    let pairs = 0;
    st.forEach((s, i) => {
      if (s.pair === undefined) return;
      expect(st[s.pair].pair).toBe(i);
      expect(s.pairSameDir).toBe(true);
      expect(net.stations.get(s.id)!.pair).toBe(st[s.pair].id);
      if (i < s.pair) pairs++;
    });
    expect(pairs).toBe(3);
    expect(c.net.staffedStations).toBeCloseTo(st.length - pairs * (2 - QUAD.pairStaffing), 9);
    expect(c.net.routes[c.routeIndex.get(xr.id)!].express).toBe(true);
    expect('express' in c.net.routes[c.routeIndex.get(lr.id)!]).toBe(false);
    expect(hasExpressService(c.net)).toBe(true);
    // A pair key covers both platforms once built; before that, each is its own.
    expect(pairKeyId(net, express[0])).toBe(Math.min(express[0], local[0]));
    expect(pairKeyId(net, local[0])).toBe(Math.min(express[0], local[0]));
    // An ordinary network compiles exactly as before: no pair fields, no staffing override.
    const g2 = stubGame();
    g2.network.addStroke([P(0, 0), P(3000, 0)], 'heavy', none, none);
    const e = [...g2.network.edges.keys()][0];
    const s1 = g2.network.addStation(e, 500, CARS, 'S1').id, s2 = g2.network.addStation(e, 2500, CARS, 'S2').id;
    g2.build(true);
    route(g2, 'R', [s1, s2]);
    const c2 = compileNetwork(g2).net;
    expect(c2.stations.every((s) => !('pair' in s) && !('pairSameDir' in s))).toBe(true);
    expect('staffedStations' in c2).toBe(false);
    expect(hasExpressService(c2)).toBe(false);
  });

  it('26. a cross-platform transfer costs 15 s + wait + 0.4 × the penalty; effectiveTransfers counts it as 0.4', () => {
    // Route 1 runs 0-1-2-3 (west → east, 120 s hops); route 2 runs 4-2-5; route 3 runs 6-7 from
    // station 6, the cross-platform partner of station 2 (9 m away).
    const dir = (stations: number[]): CRouteDir => {
      const n = stations.length;
      const arrive = Float64Array.from(stations, (_, k) => k * 120);
      return {
        xs: new Float64Array(2), ys: new Float64Array(2), zs: new Float64Array(2), cum: new Float64Array([0, 1000 * (n - 1)]), length: 1000 * (n - 1),
        stopStation: Int32Array.from(stations), stopS: Float64Array.from(stations, (_, k) => k * 1000),
        limS0: new Float64Array(0), limS1: new Float64Array(0), limV: new Float64Array(0), elems: [], schedArrive: arrive, schedDepart: arrive, runTime: arrive[n - 1],
      };
    };
    const mk = (id: number, stations: number[], hw: number): CRoute => ({
      id, name: `R${id}`, bullet: String(id), color: '#fff', cls: 'heavy', cars: 8, trainLength: 144, capComfort: 880, capCrush: 1600, accel: 1.1, brake: 1.2, vmax: 25,
      headways: [hw, hw, hw, hw, hw], fleet: 4, dirs: [dir(stations), dir([...stations].reverse())],
    });
    const pos = [[0, 0], [1000, 0], [2000, 0], [3000, 0], [2000, -1000], [2000, 1000], [2000, 9], [3000, 9]];
    const net: CompiledNetwork = {
      version: 1,
      stations: pos.map(([x, y], i) => ({ id: 100 + i, x, y, name: `S${i}`, group: i === 6 ? 2 : i, ...(i === 2 ? { pair: 6, pairSameDir: true } : i === 6 ? { pair: 2, pairSameDir: true } : {}) })),
      routes: [mk(1, [0, 1, 2, 3], 240), mk(2, [4, 2, 5], 600), mk(3, [6, 7], 240)],
      trackCount: 0,
      lockCount: 0,
    };
    expect(platformTransfer(net.stations[2], net.stations[6], 6)).toBe(QUAD.crossPlatformTransfer);
    expect(transferPenaltyFor(net.stations[2], 6)).toBeCloseTo(COMMUTERS.transferPenalty * QUAD.crossPlatformPenaltyFactor, 9);
    expect(transferPenaltyFor(net.stations[2], 4)).toBe(COMMUTERS.transferPenalty);
    const g = new TransitGraph(net);
    g.setPeriod(1);
    g.run([{ station: 0, walk: 0 }]);
    // 0 → 7: wait 120, ride 240 to station 2, step across (15 s) + wait 120 + 0.4 × 300, ride 120.
    const a = g.bestArrival(7);
    const legs = g.legsTo(a.plat);
    expect(legs.map((l) => l.route)).toEqual([0, 2]);
    expect(a.cost).toBeCloseTo(120 + 240 + 15 + 120 + 0.4 * COMMUTERS.transferPenalty + 120, 6);
    expect(effectiveTransfers(net, legs)).toBeCloseTo(0.4, 12);
    // What bestPath reports (cost minus the penalty it was charged) is the plain trip time.
    expect(a.cost - effectiveTransfers(net, legs) * COMMUTERS.transferPenalty).toBeCloseTo(120 + 240 + 15 + 120 + 120, 6);
    // 0 → 5 changes at an ordinary interchange: one full transfer.
    const b = g.bestArrival(5);
    const lb = g.legsTo(b.plat);
    expect(effectiveTransfers(net, lb)).toBe(1);
    expect(b.cost).toBeCloseTo(120 + 240 + 60 + 300 + COMMUTERS.transferPenalty + 120, 6);
    // Without pairs every transfer pays the full penalty through the scalar path.
    expect(g.trPen).not.toBeNull();
    const plain = new TransitGraph({ ...net, stations: net.stations.map((s) => ({ id: s.id, x: s.x, y: s.y, name: s.name, group: s.group })) });
    expect(plain.trPen).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
// The overtaking layout (tests 27–28): approach (0,0) → (2000,0), then a quad fanning from its end
// to a free end at (9000,0) (or, as the control, plain double track); S0 at 300, S1 at 1300,
// cross-platform pairs A, C, E at 3000, 6000, 8600 and local-only stops at 3800, 4600, 5300, 6800
// and 7600. The local calls everywhere; the express at S0, S1, A, C, E.
interface Layout {
  game: Game;
  net: CompiledNetwork;
  local: Route;
  express: Route;
  stations: Record<string, number>;
  quad: QuadResult | null;
}

function overtakeLayout(quad: boolean, hwMin = 6, control?: Partial<RouteControl>, expressHw = hwMin): Layout {
  const game = stubGame();
  const n = game.network;
  n.addStroke([P(0, 0), P(2000, 0)], 'heavy', none, none);
  const end = { kind: 'node' as const, node: nodeAt(n, 2000, 0) };
  let q: QuadResult | null = null;
  if (quad) {
    q = addQuadStroke(n, [P(2000, 0), P(9000, 0)], 'heavy', end, none, { side: 1 });
    if (!q.ok) throw new Error(q.fatal);
  } else n.addStroke([P(2000, 0), P(9000, 0)], 'heavy', end, none);
  const st: Record<string, number> = {};
  st.S0 = platformAt(n, 300, 0, null, 'S0');
  st.S1 = platformAt(n, 1300, 0, null, 'S1');
  const localOnly = [3800, 4600, 5300, 6800, 7600];
  for (const [name, x] of [['A', 3000], ['C', 6000], ['E', 8600]] as [string, number][]) {
    if (quad) [st[name], st[name + 'x']] = pairAt(n, x, name);
    else st[name] = st[name + 'x'] = platformAt(n, x, 0, null, name);
  }
  localOnly.forEach((x, i) => (st[`L${i}`] = platformAt(n, x, 0, quad ? 'local' : null, `L${i}`)));
  game.build(true);
  const all = [st.S0, st.S1, st.A, st.L0, st.L1, st.L2, st.C, st.L3, st.L4, st.E];
  const hw = (m: number) => ({ night: m, am: m, midday: m, pm: m, evening: m });
  const local = route(game, 'Local', all, false, hw(hwMin), control);
  const express = route(game, 'Express', [st.S0, st.S1, st.Ax, st.Cx, st.Ex], true, hw(expressHw), control);
  return { game, net: compileNetwork(game).net, local, express, stations: st, quad: q };
}

interface TripLog {
  /** Express pair-to-pair times (A→E or E→A) and their schedule. */
  trips: { dir: number; time: number; sched: number; start: number }[];
  dispatched: Map<number, number>;
  completed: Map<number, number>;
  late: { sum: number; n: number }[];
  dwellAt: Map<string, number>;
}

/**
 * Train sim only (no commuters), from 06:00 for `hours`, recording the express's A→E runs. `setup`
 * runs once the network is in place; `each` before every step.
 */
function runLayout(L: Layout, hours = 4, each?: (sim: TrainSim, t: number) => void, setup?: (sim: TrainSim, t0: number) => void): { sim: TrainSim; log: TripLog } {
  const xi = L.net.routes.findIndex((r) => r.id === L.express.id);
  const xr = L.net.routes[xi];
  const kStart = [2, 0], kEnd = [4, 2];
  const log: TripLog = { trips: [], dispatched: new Map(), completed: new Map(), late: [{ sum: 0, n: 0 }, { sum: 0, n: 0 }], dwellAt: new Map() };
  const dep = new Map<number, number>();
  const hooks: PassengerHooks = {
    arrive: (tr: Train, r, k, t) => {
      const n = r.dirs[tr.dir].stopStation.length;
      if (k === 0) log.dispatched.set(r.id, (log.dispatched.get(r.id) ?? 0) + 1);
      if (k === n - 1) log.completed.set(r.id, (log.completed.get(r.id) ?? 0) + 1);
      const key = `${r.id}:${L.net.stations[r.dirs[tr.dir].stopStation[k]].id}`;
      log.dwellAt.set(key, (log.dwellAt.get(key) ?? 0) + 1);
      if (r.id === xr.id && k === kEnd[tr.dir] && dep.has(tr.id)) {
        const d = r.dirs[tr.dir];
        log.trips.push({ dir: tr.dir, time: t - dep.get(tr.id)!, sched: d.schedArrive[kEnd[tr.dir]] - d.schedDepart[kStart[tr.dir]], start: dep.get(tr.id)! });
        dep.delete(tr.id);
      }
      if (k > 0) {
        const lt = log.late[r.id === xr.id ? 1 : 0];
        lt.sum += Math.max(0, tr.late);
        lt.n++;
      }
      return { alight: 0, board: 0 };
    },
    depart: (tr, r, k, t) => {
      if (r.id === xr.id && k === kStart[tr.dir]) dep.set(tr.id, t);
    },
    evacuate: () => {},
    pass: () => {},
  };
  const sim = new TrainSim(hooks);
  const t0 = 6 * 3600;
  sim.setNetwork(L.net, t0);
  setup?.(sim, t0);
  for (let t = t0; t < t0 + hours * 3600; t += 2) {
    each?.(sim, t);
    sim.step(t, 2);
  }
  return { sim, log };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('overtaking on a quad (train sim only)', () => {
  it('27. lets expresses overtake locals on a quad and cuts their run time against a shared pair', () => {
    const quad = runLayout(overtakeLayout(true));
    const ctrl = runLayout(overtakeLayout(false));
    const L = overtakeLayout(true);
    for (const d of [0, 1]) {
      const tq = quad.log.trips.filter((x) => x.dir === d);
      const tc = ctrl.log.trips.filter((x) => x.dir === d);
      expect(tq.length).toBeGreaterThan(20);
      expect(tc.length).toBeGreaterThan(20);
      const mq = mean(tq.map((x) => x.time)), mc = mean(tc.map((x) => x.time));
      console.log(`dir ${d}: express A→E on the quad ${mq.toFixed(0)} s, shared pair ${mc.toFixed(0)} s (scheduled ${tq[0].sched.toFixed(0)} s)`);
      expect(mq).toBeLessThan(0.85 * mc);
      // On the quad the express keeps (about) its schedule.
      expect(mq).toBeLessThan(tq[0].sched + 30);
    }
    expect(quad.sim.day.overtakes.get(L.express.id) ?? 0).toBeGreaterThan(0);
    expect(ctrl.sim.day.overtakes.size).toBe(0);
    expect(quad.sim.day.deadlocks).toBe(0);
    expect(ctrl.sim.day.deadlocks).toBe(0);
    // Every express dispatched more than a round trip before the end completed its trip.
    const xd = quad.log.dispatched.get(L.express.id)!, xc = quad.log.completed.get(L.express.id)!;
    expect(xc).toBeGreaterThanOrEqual(xd - 4);
    // Regularity is measured per route, so overtakes don't read as bunching.
    const reg = quad.sim.closeDayRegularity();
    for (const id of [L.local.id, L.express.id]) {
      expect(reg.routes[id].samples).toBeGreaterThan(50);
      expect(reg.routes[id].cv).toBeLessThan(0.25);
      expect(reg.routes[id].bunched).toBeLessThan(0.05);
    }
  });

  it('28. fan merge stress: both routes at 3 minutes for 4 h, no deadlocks, lateness no worse than the control', () => {
    const quad = runLayout(overtakeLayout(true, 3));
    const ctrl = runLayout(overtakeLayout(false, 3));
    expect(quad.sim.day.deadlocks).toBe(0);
    expect(ctrl.sim.day.deadlocks).toBe(0);
    const lq = quad.log.late.reduce((s, x) => s + x.sum, 0) / quad.log.late.reduce((s, x) => s + x.n, 0);
    const lc = ctrl.log.late.reduce((s, x) => s + x.sum, 0) / ctrl.log.late.reduce((s, x) => s + x.n, 0);
    console.log(`3-minute headways: mean lateness on the quad ${lq.toFixed(1)} s, shared pair ${lc.toFixed(1)} s`);
    expect(lq).toBeLessThanOrEqual(lc);
  });
});

// ------------------------------------------------------------------------------------------
describe('city chaos on four tracks', () => {
  it('a breakdown on the local pair queues locals, while expresses keep running and overtaking; nobody deadlocks', () => {
    const L = overtakeLayout(true);
    const li = L.net.routes.findIndex((r) => r.id === L.local.id);
    let stalled: Train | null = null;
    let at = 0;
    const { sim, log } = runLayout(L, 4, (s, t) => {
      if (stalled || t < 7 * 3600) return;
      // A dir-0 local between C and L3, on the local pair.
      const tr = s.trains.find((x) => x.route === li && x.dir === 0 && x.state === TState.Running && x.s > 6300 && x.s < 6500);
      if (!tr) return;
      stalled = tr;
      at = t;
      tr.holdUntil = t + 1200;
      s.extendGrace([L.local.id], t + 1200);
    });
    expect(stalled).not.toBeNull();
    // Expresses that ran A→E in dir 0 during the stall kept their time.
    const during = log.trips.filter((x) => x.dir === 0 && x.start > at && x.start < at + 1100);
    expect(during.length).toBeGreaterThan(1);
    for (const x of during) expect(x.time).toBeLessThan(x.sched + 60);
    expect(sim.day.deadlocks).toBe(0);
    expect(sim.day.overtakes.get(L.express.id) ?? 0).toBeGreaterThan(0);
  });

  it('a crawl (signal problem) on the express pair slows expresses only; locals keep their time', () => {
    const base = overtakeLayout(true);
    const xEdge = [...base.game.network.edges.values()].find((e) => e.quad?.role === 'express' && base.game.network.geom(e.id).length > 2000)!;
    const go = (crawl: boolean) =>
      runLayout(overtakeLayout(true), 3, undefined, (s) => {
        if (crawl) s.setRestrictions([{ id: 1, edge: xEdge.id, edgeDir: 0, u0: 600, u1: 1400, v: 4, until: Infinity, track: -1 }]);
      });
    const plain = go(false), slow = go(true);
    const x0 = (r: typeof plain) => mean(r.log.trips.filter((x) => x.dir === 0).map((x) => x.time));
    const x1 = (r: typeof plain) => mean(r.log.trips.filter((x) => x.dir === 1).map((x) => x.time));
    expect(x0(slow)).toBeGreaterThan(x0(plain) + 100);
    expect(Math.abs(x1(slow) - x1(plain))).toBeLessThan(5);
    // Locals on the other pair never see it.
    expect(slow.log.late[0].sum / slow.log.late[0].n).toBeLessThan(plain.log.late[0].sum / plain.log.late[0].n + 5);
    expect(slow.sim.day.deadlocks).toBe(0);
    // An incident picks quad tracks like any other (weighted by length).
    expect(trackSpans(base.net).some((sp) => sp.edge === xEdge.id)).toBe(true);
  });

  it('police at one platform of a cross-platform pair close both; trains of both routes run through', () => {
    const L = overtakeLayout(true);
    const alerts: { stationId?: number; partnerStationId?: number; routes: number[] }[] = [];
    const idx = (id: number) => L.net.stations.findIndex((s) => s.id === id);
    let forced = -1;
    const { sim, log } = runLayout(L, 0.9, undefined, (s, t0) => {
      const chaos = new ChaosController({ level: 'normal', seed: 1 }, s, null, { alert: (a) => alerts.push(a) });
      chaos.setNetwork(L.net, t0);
      forced = chaos.force({ kind: 'police', station: L.stations.Cx, duration: 3600 }, t0);
      expect(s.closedUntil[idx(L.stations.C)]).toBe(t0 + 3600);
      expect(s.closedUntil[idx(L.stations.Cx)]).toBe(t0 + 3600);
    });
    expect(forced).toBeGreaterThanOrEqual(0);
    expect(alerts[0].stationId).toBe(L.stations.Cx);
    expect(alerts[0].partnerStationId).toBe(L.stations.C);
    expect(new Set(alerts[0].routes)).toEqual(new Set([L.local.id, L.express.id]));
    expect(log.dwellAt.get(`${L.local.id}:${L.stations.C}`) ?? 0).toBe(0);
    expect(log.dwellAt.get(`${L.express.id}:${L.stations.Cx}`) ?? 0).toBe(0);
    expect(log.dwellAt.get(`${L.local.id}:${L.stations.L3}`) ?? 0).toBeGreaterThan(0);
    expect(sim.day.deadlocks).toBe(0);
    // Exposure counts a pair once (police rates scale with stations served).
    expect(measureExposure(L.net).stations).toBe(L.net.stations.length - 3);
  });

  it('event service on the express adds express departures; overtaking and the watchdog still hold', () => {
    const count = (ov: boolean) => {
      const L = overtakeLayout(true, 6);
      // The fleet for 3-minute service.
      const ri = L.net.routes.findIndex((r) => r.id === L.express.id);
      L.net.routes[ri].fleet = trainsNeeded({ headways: { ...defaultHeadways(), am: 3 }, control: L.express.control }, [L.net.routes[ri].dirs[0].runTime, L.net.routes[ri].dirs[1].runTime]);
      const out = runLayout(L, 4, undefined, (s) => {
        if (ov) s.setOverrides([{ id: 1, routeId: L.express.id, from: 7 * 3600, to: 9 * 3600, headwayMin: 3, eventId: 0 }]);
      });
      return { n: out.log.trips.filter((x) => x.start >= 7 * 3600 && x.start < 9 * 3600).length, sim: out.sim, L };
    };
    const a = count(false), b = count(true);
    expect(b.n).toBeGreaterThanOrEqual(a.n * 1.6);
    expect(b.sim.day.deadlocks).toBe(0);
    expect(b.sim.day.overtakes.get(b.L.express.id) ?? 0).toBeGreaterThan(a.sim.day.overtakes.get(a.L.express.id) ?? 0);
  });

  it("a long stall on the local pair is covered by the watchdog's grace; without the incident the stall is caught", () => {
    const go = (grace: boolean) => {
      const L = overtakeLayout(true);
      const li = L.net.routes.findIndex((r) => r.id === L.local.id);
      let held = false;
      const { sim, log } = runLayout(L, 3, (s, t) => {
        if (held || t < 7 * 3600) return;
        const tr = s.trains.find((x) => x.route === li && x.dir === 0 && x.state === TState.Running && x.s > 4000 && x.s < 4400);
        if (!tr) return;
        held = true;
        tr.holdUntil = t + 2400;
        if (grace) s.extendGrace([L.local.id], t + 2400);
      });
      return { sim, log, L };
    };
    const g = go(true);
    expect(g.sim.day.deadlocks).toBe(0);
    // Expresses ran on throughout.
    expect(g.log.trips.filter((x) => x.dir === 0 && x.start > 7 * 3600 + 300 && x.start < 7 * 3600 + 2000).length).toBeGreaterThan(2);
    // The same 40-minute stall with no incident behind it is a deadlock (the watchdog's 30 min).
    expect(go(false).sim.day.deadlocks).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------
describe('operations control on four tracks', () => {
  it('a local held at a timepoint never holds up the express on the other pair', () => {
    const ctl = { hold: true, holdFraction: 0.9 };
    const L = overtakeLayout(true, 4, undefined);
    L.game.routes.update(L.local.id, { control: { ...L.local.control, ...ctl, timepoints: [L.stations.C] } });
    L.game.routes.update(L.express.id, { control: { ...L.express.control, ...ctl, timepoints: [L.stations.Cx] } });
    L.net = compileNetwork(L.game).net;
    const li = L.net.routes.findIndex((r) => r.id === L.local.id);
    let kicked = 0;
    let heldMax = 0;
    let nextKick = 6.5 * 3600;
    const { sim, log } = runLayout(L, 4, (s, t) => {
      heldMax = Math.max(heldMax, s.heldCount());
      // Bunch the locals: every 20 minutes, delay a dir-0 local 2 minutes just past the fan.
      if (t >= nextKick) {
        const tr = s.trains.find((x) => x.route === li && x.dir === 0 && x.state === TState.Running && x.s > 2400 && x.s < 2800 && x.holdUntil < t);
        if (tr) {
          tr.holdUntil = t + 120;
          kicked++;
          nextKick = t + 1200;
        }
      }
    });
    expect(kicked).toBeGreaterThan(3);
    const reg = sim.closeDayRegularity();
    expect(reg.routes[L.local.id].holds).toBeGreaterThan(0);
    expect(heldMax).toBeGreaterThan(0);
    // Express runs A→E stay near their schedule (a held local at C_l doesn't block C_x).
    const late = log.trips.filter((x) => x.time > x.sched + 60);
    expect(late.length).toBeLessThanOrEqual(1);
    expect(sim.day.deadlocks).toBe(0);
  });

  it('timepoints are served stations only; Suggest ignores skipped stations; recovery and the fleet use the express run time', () => {
    const L = overtakeLayout(true, 4);
    const g = L.game;
    // A timepoint at a stop the express then skips is dropped with it.
    g.routes.update(L.express.id, { control: { ...L.express.control, timepoints: [L.stations.Cx] } });
    expect(g.routes.get(L.express.id)!.control.timepoints).toEqual([L.stations.Cx]);
    const skipped = skipStops(g.network, L.express.stops, L.stations.Cx);
    expect('stops' in skipped).toBe(true);
    g.routes.update(L.express.id, { stops: (skipped as { stops: number[] }).stops });
    expect(g.routes.get(L.express.id)!.control.timepoints).toEqual([]);
    // Restore, then Suggest: never a station the express runs past.
    g.routes.update(L.express.id, { stops: [L.stations.S0, L.stations.S1, L.stations.Ax, L.stations.Cx, L.stations.Ex] });
    const xr = g.routes.get(L.express.id)!;
    const sug = suggestTimepoints(xr, g.routes.list());
    expect(sug.length).toBeGreaterThan(0);
    for (const s of sug) expect(xr.stops.slice(1, -1)).toContain(s);
    const lonely = [L.stations.L0, L.stations.L1, L.stations.L2, L.stations.L3, L.stations.L4];
    for (const s of sug) expect(lonely).not.toContain(s);
    // Recovery and fleet sizing from each route's own (express: shorter) run time.
    const tl = routeTimetable(g, g.routes.get(L.local.id)!)!, tx = routeTimetable(g, xr)!;
    expect(tx.runTimes[0]).toBeLessThan(tl.runTimes[0] - 100);
    const rec = { ...xr, control: { ...xr.control, recoveryPct: 0.1 } };
    expect(recoveryPerTerminal(rec, tx.runTimes)).toBeCloseTo(((tx.runTimes[0] + tx.runTimes[1]) * 0.1) / 2, 6);
    expect(trainsNeeded(rec, tx.runTimes)).toBeLessThan(trainsNeeded(rec, tl.runTimes));
  });
});

// ------------------------------------------------------------------------------------------
describe('Living City on four tracks', () => {
  it('a cross-platform pair is one served station; a skipped platform is served only if another route calls there', () => {
    const L = overtakeLayout(true);
    const ids = (net: CompiledNetwork) => servedStations(net).map((p) => p.id);
    const both = ids(L.net);
    const pairKey = (a: number, b: number) => Math.min(a, b);
    for (const [a, b] of [['A', 'Ax'], ['C', 'Cx'], ['E', 'Ex']]) {
      expect(both.filter((id) => id === L.stations[a] || id === L.stations[b])).toEqual([pairKey(L.stations[a], L.stations[b])]);
    }
    // 2 approach stations + 3 pairs + 5 local-only stops.
    expect(both.length).toBe(10);
    // Only the express runs: the local-only stops (skipped) are not served; the pairs still are, once.
    const g = L.game;
    g.routes.remove(L.local.id);
    const onlyX = ids(compileNetwork(g).net);
    expect(onlyX.length).toBe(5);
    for (const k of ['L0', 'L1', 'L2', 'L3', 'L4']) expect(onlyX).not.toContain(L.stations[k]);
    expect(onlyX).toContain(pairKey(L.stations.C, L.stations.Cx));
    // The pair's point is between its platforms.
    const c = servedStations(compileNetwork(g).net).find((p) => p.id === pairKey(L.stations.C, L.stations.Cx))!;
    expect(Math.abs(c.y + QUAD.spacing / 2)).toBeLessThan(0.5);
    expect(pairKeyId(g.network, L.stations.Cx)).toBe(c.id);
    // An ordinary network lists exactly what it did before (each served station once, in order).
    const plain = overtakeLayout(false);
    expect(ids(plain.net)).toEqual(plain.net.stations.map((s) => s.id));
  });
});

// ------------------------------------------------------------------------------------------
describe('demolishing a cross-platform station', () => {
  it('24 (game part). bulldozeStation removes both platforms by default, one with withPartner false; refused while either is served', () => {
    const L = overtakeLayout(true);
    const g = L.game;
    // C's express platform is served by the express: neither platform can go.
    const r = g.bulldozeStation(L.stations.C);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Express/);
    g.routes.remove(L.express.id);
    g.routes.update(L.local.id, { stops: L.local.stops.filter((s) => s !== L.stations.C) });
    const cash0 = g.finance.cash;
    const both = g.bulldozeStation(L.stations.C);
    expect(both.ok).toBe(true);
    expect(g.network.stations.has(L.stations.C)).toBe(false);
    expect(g.network.stations.has(L.stations.Cx)).toBe(false);
    expect(both.refund).toBeGreaterThan(0);
    expect(g.finance.cash).toBeGreaterThanOrEqual(cash0);
    // Just one platform: the other becomes a lone platform.
    g.routes.update(L.local.id, { stops: L.local.stops.filter((s) => s !== L.stations.A) });
    expect(g.bulldozeStation(L.stations.Ax, { withPartner: false }).ok).toBe(true);
    expect(g.network.stations.get(L.stations.A)!.pair).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------
describe('save v6', () => {
  const settings = { units: 'metric' as const, agentScale: 10, seed: 1885 };
  it('29. migrates a v5 save: routes are locals, the saved report gets empty overtakes and transfers; idempotent', () => {
    const L = overtakeLayout(false);
    const save = JSON.parse(JSON.stringify(buildSave(L.game, { name: 't', goals: {} as never, lastReport: { day: 3, riders: 7 } as never, tutorialDone: true, settings, modeState: null })));
    save.version = 5;
    for (const r of save.game.routes.routes) delete r.express;
    const m = migrate(save);
    expect(SAVE_VERSION).toBe(6);
    expect(m.version).toBe(6);
    expect(m.migratedFrom).toBe(5);
    expect(m.game.routes.routes.map((r) => r.express)).toEqual([false, false]);
    expect(m.game.lastReport).toMatchObject({ day: 3, riders: 7, routeOvertakes: {}, crossTransfers: {} });
    const again = migrate(JSON.parse(JSON.stringify({ ...m, version: 5, migratedFrom: undefined })));
    expect(again.game.routes.routes).toEqual(m.game.routes.routes);
    expect(again.game.lastReport).toEqual(m.game.lastReport);
  });

  it('30. a save round-trips quad tags, twins, pairs and the express flag; load drops a dangling pair', () => {
    const L = overtakeLayout(true);
    const save = migrate(JSON.parse(JSON.stringify(buildSave(L.game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: null }))));
    const back = stubGame();
    applySave(back, save);
    expect(JSON.stringify(back.network.toData())).toBe(JSON.stringify(L.game.network.toData()));
    expect(back.routes.get(L.express.id)!.express).toBe(true);
    expect(back.routes.get(L.local.id)!.express).toBe(false);
    expect([...back.network.edges.values()].filter((e) => e.quad).length).toBe([...L.game.network.edges.values()].filter((e) => e.quad).length);
    expect([...back.network.nodes.values()].some((n) => n.twin !== undefined)).toBe(true);
    expect(back.network.stations.get(L.stations.A)!.pair).toBe(L.stations.Ax);
    // A dangling pair (its partner missing) is dropped on load.
    const bad = JSON.parse(JSON.stringify(save));
    bad.game.network.stations = bad.game.network.stations.filter((s: { id: number }) => s.id !== L.stations.Ax);
    bad.game.routes.routes = bad.game.routes.routes.filter((r: { id: number }) => r.id !== L.express.id);
    const b2 = stubGame();
    applySave(b2, migrate(bad));
    expect(b2.network.stations.get(L.stations.A)!.pair).toBeUndefined();
    // Express routes compile as expresses after the load.
    expect(compileNetwork(back).net.routes.some((r) => r.express)).toBe(true);
  });
});

// Keep STATION referenced for platform-length reasoning in failure messages.
void STATION;
