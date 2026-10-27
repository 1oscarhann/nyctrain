import { describe, expect, it } from 'vitest';
import { TransitGraph } from '../src/sim/transitGraph';
import type { CompiledNetwork, CRoute, CRouteDir } from '../src/sim/protocol';
import { generalisedCosts, logitShares, moneyToMinutes, smoothShares, walkTime, driveTripTime, type PairGeometry } from '../src/sim/modeChoice';
import { brakingDistance, maxApproachSpeed, runProfile } from '../src/trains/kinematics';
import { COMMUTERS } from '../src/balance';

// ---------------------------------------------------------------------------
// A tiny compiled network: route A runs stations 0-1-2-3 (west→east), route B runs 4-2-5
// (south→north) and meets A at station 2. Ride times are 120 s per hop.

function dir(stations: number[], hop = 120): CRouteDir {
  const n = stations.length;
  const arrive = new Float64Array(n);
  for (let k = 0; k < n; k++) arrive[k] = k * hop;
  return {
    xs: new Float64Array(2),
    ys: new Float64Array(2),
    zs: new Float64Array(2),
    cum: new Float64Array([0, 1000 * (n - 1)]),
    length: 1000 * (n - 1),
    stopStation: Int32Array.from(stations),
    stopS: Float64Array.from(stations.map((_, k) => k * 1000)),
    limS0: new Float64Array(0),
    limS1: new Float64Array(0),
    limV: new Float64Array(0),
    elems: [],
    schedArrive: arrive,
    schedDepart: arrive,
    runTime: arrive[n - 1],
  };
}

function route(id: number, stations: number[], headwaySec: number): CRoute {
  return {
    id,
    name: 'R' + id,
    bullet: String(id),
    color: '#ffffff',
    cls: 'heavy',
    cars: 8,
    trainLength: 144,
    capComfort: 880,
    capCrush: 1600,
    accel: 1.1,
    brake: 1.2,
    vmax: 25,
    headways: [headwaySec, headwaySec, headwaySec, headwaySec, headwaySec],
    fleet: 4,
    dirs: [dir(stations), dir([...stations].reverse())],
  };
}

function network(): CompiledNetwork {
  const pos = [
    [0, 0],
    [1000, 0],
    [2000, 0],
    [3000, 0],
    [2000, -1000],
    [2000, 1000],
  ];
  return {
    version: 1,
    stations: pos.map(([x, y], i) => ({ id: 100 + i, x, y, name: 'S' + i, group: i })),
    routes: [route(1, [0, 1, 2, 3], 240), route(2, [4, 2, 5], 600)],
    trackCount: 0,
    lockCount: 0,
  };
}

describe('transit pathfinding (Dijkstra on the platform graph)', () => {
  it('finds a direct ride with access wait and ride time', () => {
    const g = new TransitGraph(network());
    g.setPeriod(1);
    g.run([{ station: 0, walk: 60 }]);
    const a = g.bestArrival(3);
    // 60 s walk + 120 s wait (half of 240) + 3 hops × 120 s
    expect(a.cost).toBeCloseTo(60 + 120 + 360, 6);
    const legs = g.legsTo(a.plat);
    expect(legs).toEqual([{ route: 0, dir: 0, board: 0, alight: 3 }]);
  });

  it('transfers with walk + wait + penalty and reconstructs both legs', () => {
    const g = new TransitGraph(network());
    g.setPeriod(1);
    g.run([{ station: 0, walk: 0 }]);
    const a = g.bestArrival(5);
    const legs = g.legsTo(a.plat);
    expect(legs).toEqual([
      { route: 0, dir: 0, board: 0, alight: 2 },
      { route: 1, dir: 0, board: 1, alight: 2 },
    ]);
    // wait 120 + ride 240 + transfer (60 s base walk + 300 s wait cap at half of 600 + 300 s penalty) + ride 120
    expect(a.cost).toBeCloseTo(120 + 240 + 60 + 300 + COMMUTERS.transferPenalty + 120, 6);
  });

  it('never returns a path that walks to a platform and walks away without riding', () => {
    const g = new TransitGraph(network());
    g.setPeriod(1);
    g.run([{ station: 2, walk: 0 }]);
    // Station 2 itself is only reachable by riding back to it (impossible without reversing).
    const a = g.bestArrival(2);
    if (a.plat >= 0) for (const l of g.legsTo(a.plat)) expect(l.alight).toBeGreaterThan(l.board);
  });

  it('treats a period with no service as unavailable', () => {
    const net = network();
    net.routes[1].headways[0] = 0;
    const g = new TransitGraph(net);
    g.setPeriod(0);
    g.run([{ station: 4, walk: 0 }]);
    expect(g.bestArrival(5).plat).toBe(-1);
    // Route A still runs at night: 0 → 3 works.
    g.run([{ station: 0, walk: 0 }]);
    expect(g.bestArrival(3).plat).toBeGreaterThanOrEqual(0);
  });
});

describe('logit mode split', () => {
  const geom = (d: number, workCbd = false): PairGeometry => ({ distance: d, homeCore: workCbd, workCore: workCbd, workCbd, homeCbd: false });

  it('splits equal costs evenly and favours the cheaper mode', () => {
    expect(logitShares([10, 10, 10])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const s = logitShares([10, 20, Infinity]);
    expect(s[2]).toBe(0);
    expect(s[0]).toBeCloseTo(1 / (1 + Math.exp(-COMMUTERS.logitScale * 10)), 9);
    expect(s[0] + s[1]).toBeCloseTo(1, 12);
  });

  it('only offers walking up to 2.5 km', () => {
    expect(walkTime(2500)).toBeCloseTo((2500 * 1.3) / 1.3, 6);
    expect(walkTime(2600)).toBe(Infinity);
  });

  it('charges Manhattan parking below 60th St and drives slower in Manhattan', () => {
    const cbd = driveTripTime(geom(5000, true));
    const outer = driveTripTime(geom(5000, false));
    expect(cbd).toBeCloseTo((5000 * 1.35) / (14 / 3.6) + 20 * 60, 3);
    expect(outer).toBeCloseTo((5000 * 1.35) / (24 / 3.6) + 5 * 60, 3);
  });

  it('makes lower earners more fare-sensitive', () => {
    expect(moneyToMinutes(3, 0)).toBeCloseTo(18, 9); // $10/h
    expect(moneyToMinutes(3, 2)).toBeCloseTo(4.5, 9); // $40/h
    // An outer-borough trip (no CBD parking) where transit and driving are close for everyone.
    const g = geom(6000, false);
    const t = { time: 30 * 60, transfers: 0, crowdMinutes: 0, fare: 3 };
    const share = (band: number, fare: number) => logitShares(generalisedCosts(g, band, { ...t, fare }))[2];
    const lowDrop = share(0, 0) - share(0, 3);
    const highDrop = share(2, 0) - share(2, 3);
    expect(lowDrop).toBeGreaterThan(0);
    expect(highDrop).toBeGreaterThan(0);
    expect(lowDrop).toBeGreaterThan(highDrop);
  });

  it('moves shares 45% of the way each day', () => {
    const s = smoothShares([0.5, 0.5, 0], [0, 0, 1]);
    expect(s[2]).toBeCloseTo(0.45, 12);
    expect(s[0]).toBeCloseTo(0.275, 12);
  });
});

describe('train kinematics', () => {
  it('braking distance is v²/2b', () => {
    expect(brakingDistance(25, 1.2)).toBeCloseTo(625 / 2.4, 9);
    expect(maxApproachSpeed(brakingDistance(20, 1.2), 1.2)).toBeCloseTo(20, 9);
    expect(maxApproachSpeed(-5, 1.2)).toBe(0);
  });

  it('timetables accelerate, cruise and brake between stops', () => {
    // 2 km between two stops, no curves: accelerate to 25 m/s at 1.1, brake at 1.2.
    const p = runProfile(2000, [], [0, 2000], 1.1, 1.2, 25, 30);
    const tAcc = 25 / 1.1, dAcc = 25 ** 2 / 2.2;
    const tBrk = 25 / 1.2, dBrk = 25 ** 2 / 2.4;
    const expected = tAcc + tBrk + (2000 - dAcc - dBrk) / 25;
    expect(Math.abs(p.total - expected)).toBeLessThan(3);
    // A curve speed limit slows the run.
    const slow = runProfile(2000, [{ s0: 800, s1: 1200, v: 10 }], [0, 2000], 1.1, 1.2, 25, 30);
    expect(slow.total).toBeGreaterThan(p.total + 20);
  });
});
