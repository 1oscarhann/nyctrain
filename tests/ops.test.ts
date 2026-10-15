/**
 * Operations control (v2): regularity maths, terminal and timepoint holding, the yield rule, short
 * turnarounds, recovery sizing, compiled timepoints and car sales. The train-sim tests run on a
 * synthetic straight line (no data files) with gap-driven dwells: the longer since the last train,
 * the more people board, so late trains get later and bunch, as on a real busy line.
 */
import { describe, expect, it } from 'vitest';
import { OPERATIONS, OPS_CONTROL, TIME, TRAINS } from '../src/balance';
import { Rng } from '../src/core/rng';
import { compileNetwork, trainsNeeded } from '../src/routes/compile';
import { defaultControl, legacyControl, offControl, suggestTimepoints } from '../src/routes/control';
import { carSaleValue, fleetPlan, idleCars, purchaseFleet, sellIdleCars, sellSpareCars } from '../src/routes/fleet';
import { createHeadlessGame, drawLine, makeRoute, stationNear, syntheticLine } from '../src/sim/headless';
import { cvByStop, emptyStats, grade, newRouteReg, poolStats, recordHeadway, rollDay, suggestRecovery, summarize } from '../src/sim/regularity';
import { queuedBehind, TrainSim, TState, type OccEntry, type PassengerHooks } from '../src/sim/trainSim';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';

const H = 180;
const STOPS = 16;

interface Dep {
  dir: number;
  stop: number;
  t: number;
  id: number;
}

interface LineRun {
  sim: TrainSim;
  deps: Dep[];
  /** Time each train arrived at its current stop, and the dwell the hooks implied. */
  dwellLog: { stop: number; dir: number; arr: number; dep: number; natural: number }[];
  turnarounds: number[];
  stats: ReturnType<TrainSim['closeDayRegularity']>['routes'][number];
  fleet: number;
}

/** The synthetic line from 05:30 to 10:00 with gap-driven boarding (noise from Rng(42)). */
function runLine(o: { hold: number; timepoints?: number[]; recoveryPct?: number; fleet?: number; noise?: boolean; shortTurn?: boolean }): LineRun {
  const { net, route } = syntheticLine({ stops: STOPS, spacing: 1000, headway: H, cars: 8, hold: o.hold, timepoints: o.timepoints, recoveryPct: o.recoveryPct ?? 0, fleet: o.fleet, shortTurn: o.shortTurn });
  const rng = new Rng(42);
  const lastArr = [new Float64Array(STOPS).fill(NaN), new Float64Array(STOPS).fill(NaN)];
  const arrAt = new Map<number, { arr: number; natural: number }>();
  const deps: Dep[] = [];
  const dwellLog: LineRun['dwellLog'] = [];
  const hooks: PassengerHooks = {
    arrive(tr, _r, k, t) {
      const last = lastArr[tr.dir][k];
      const gap = Number.isNaN(last) ? H : t - last;
      lastArr[tr.dir][k] = t;
      const noise = o.noise === false ? 0 : Math.max(0, rng.normal() * 40);
      const out = { alight: 0.4 * gap, board: 0.5 * gap + noise };
      const natural = Math.max(OPERATIONS.dwellBase, Math.min(OPERATIONS.dwellMax, OPERATIONS.dwellBase + (out.alight + out.board) / route.cars));
      arrAt.set(tr.id, { arr: t, natural });
      return out;
    },
    depart(tr, _r, k, t) {
      deps.push({ dir: tr.dir, stop: k, t, id: tr.id });
      const a = arrAt.get(tr.id);
      if (a) dwellLog.push({ stop: k, dir: tr.dir, arr: a.arr, dep: t, natural: a.natural });
    },
    evacuate() {},
    pass() {},
  };
  const sim = new TrainSim(hooks, 1);
  const t0 = 5.5 * 3600;
  sim.setNetwork(net, t0);
  const prev = new Map<number, TState>();
  const turnarounds: number[] = [];
  for (let t = t0 + TIME.simStep; t <= 10 * 3600; t += TIME.simStep) {
    sim.step(t, TIME.simStep);
    for (const tr of sim.trains) {
      if (tr.state === TState.Turnaround && prev.get(tr.id) !== TState.Turnaround) turnarounds.push(tr.until - t);
      prev.set(tr.id, tr.state);
    }
  }
  const stats = sim.closeDayRegularity().routes[route.id];
  return { sim, deps, dwellLog, turnarounds, stats, fleet: route.fleet };
}

describe('regularity statistics', () => {
  it('measures CV, bunching, gaps and excess wait (§4.4 worked check)', () => {
    const even = newRouteReg(1, 3, 3, 600);
    for (let i = 0; i < 20; i++) recordHeadway(even, 0, 1, 1000 + i * H, H, true);
    const s = summarize(even);
    expect(s.samples).toBe(19);
    expect(s.cv).toBeCloseTo(0, 12);
    expect(s.bunched).toBe(0);
    expect(s.ewt).toBeCloseTo(0, 9);

    const alt = newRouteReg(1, 3, 3, 600);
    let t = 1000;
    recordHeadway(alt, 0, 1, t, H, true);
    for (let i = 0; i < 40; i++) recordHeadway(alt, 0, 1, (t += i % 2 ? 1.6 * H : 0.4 * H), H, true);
    const a = summarize(alt);
    expect(a.samples).toBe(40);
    expect(a.cv).toBeCloseTo(0.6, 9);
    expect(a.bunched).toBeCloseTo(0.5, 12);
    expect(a.gaps).toBeCloseTo(0.5, 12);
    expect(a.ewt).toBeCloseTo(0.18 * H, 9);
    expect(grade(a.cv)).toBe('bunched');
    expect(grade(0.2)).toBe('even');
    expect(grade(0.3)).toBe('uneven');

    // A period change skips the headway; a gap over 4H is clamped.
    const g = newRouteReg(1, 2, 2, 600);
    recordHeadway(g, 1, 0, 0, H, true);
    recordHeadway(g, 1, 0, 300, H, false);
    expect(summarize(g).samples).toBe(0);
    recordHeadway(g, 1, 0, 300 + 10 * H, H, true);
    expect(g.sumH).toBe(4 * H);
    expect(summarize(g).gaps).toBe(1);

    // Per-stop CV in direction-0 order; rolling keeps lastDep and zeroes the sums.
    const by = cvByStop(alt);
    expect(by[0][1]).toBeCloseTo(0.6, 9);
    expect(by[0][0]).toBe(-1);
    expect(by[1]).toEqual([-1, -1, -1]);
    const pooled = poolStats([alt, even]);
    expect(pooled.samples).toBe(59);
    const rolled = rollDay(alt);
    expect(rolled.stats.cv).toBeCloseTo(0.6, 9);
    expect(summarize(alt)).toEqual(emptyStats());
    expect(Number.isFinite(alt.lastDep[0][1])).toBe(true);
    // Recovery advisor: 1.5 × 60 s late on a 1200 s run = 7.5% → 10%.
    expect(suggestRecovery(60, 1200)).toBe(0.1);
    expect(suggestRecovery(0, 1200)).toBe(0);
    expect(suggestRecovery(2000, 1200)).toBe(0.2);
  });
});

describe('holding on a busy synthetic line', () => {
  const off = runLine({ hold: 0, recoveryPct: 0 });
  const on = runLine({ hold: 0.7, timepoints: [5, 11], recoveryPct: 0.1 });
  const through = (r: LineRun) => r.deps.filter((d) => d.stop === STOPS - 2).length;

  it('holding plus recovery removes bunching and carries more trains', () => {
    console.log(
      `off: ${off.fleet} trains · CV ${off.stats.cv.toFixed(2)} · bunched ${(off.stats.bunched * 100).toFixed(1)}% · through ${through(off)} · short turns ${off.sim.day.shortTurns}\n` +
        `on:  ${on.fleet} trains · CV ${on.stats.cv.toFixed(2)} · bunched ${(on.stats.bunched * 100).toFixed(1)}% · through ${through(on)} · holds ${on.stats.holds} (${(on.stats.holdSec / Math.max(1, on.stats.holds)).toFixed(0)} s)`,
    );
    expect(on.fleet).toBe(off.fleet + 1);
    expect(off.stats.cv).toBeGreaterThan(0.6);
    expect(off.stats.bunched).toBeGreaterThan(0.2);
    expect(on.stats.cv).toBeLessThan(0.4);
    expect(on.stats.bunched).toBeLessThan(0.08);
    expect(through(on)).toBeGreaterThanOrEqual(1.1 * through(off));
    expect(off.sim.day.deadlocks).toBe(0);
    expect(on.sim.day.deadlocks).toBe(0);
  });

  it('timepoint holds respect the cap, and never cut the dwell short', () => {
    // Timepoints are stations 5 and 11: stops 5 and 11 going out, 10 and 4 coming back.
    const tp = on.dwellLog.filter((d) => (d.dir === 0 && (d.stop === 5 || d.stop === 11)) || (d.dir === 1 && (d.stop === STOPS - 1 - 5 || d.stop === STOPS - 1 - 11)));
    expect(tp.length).toBeGreaterThan(100);
    let maxHold = 0;
    for (const d of tp) {
      expect(d.dep - d.arr).toBeGreaterThanOrEqual(OPERATIONS.dwellBase);
      maxHold = Math.max(maxHold, d.dep - d.arr - d.natural);
    }
    expect(maxHold).toBeGreaterThan(10);
    expect(maxHold).toBeLessThanOrEqual(OPS_CONTROL.maxHoldPerStop + TIME.simStep);
    // Elsewhere nobody is held beyond the step granularity.
    for (const d of on.dwellLog) if (!tp.includes(d) && d.stop > 0) expect(d.dep - d.arr - d.natural).toBeLessThanOrEqual(TIME.simStep);
  });

  it('turns trains short only when a departure is due, and is deterministic', () => {
    expect(off.sim.day.shortTurns).toBeGreaterThan(0);
    // A fleet twice the plan always has a train waiting: no short turns, every turnaround 3 min.
    const big = runLine({ hold: 0, fleet: 2 * off.fleet, noise: false });
    expect(big.sim.day.shortTurns).toBe(0);
    expect(big.turnarounds.length).toBeGreaterThan(20);
    for (const x of big.turnarounds) expect(x).toBe(OPERATIONS.turnaround);
    // Standard turnarounds only when the route has them off.
    const std = runLine({ hold: 0, recoveryPct: 0, shortTurn: false });
    expect(std.sim.day.shortTurns).toBe(0);
    for (const x of std.turnarounds) expect(x).toBe(OPERATIONS.turnaround);
    const again = runLine({ hold: 0.7, timepoints: [5, 11], recoveryPct: 0.1 });
    expect(again.stats).toEqual(on.stats);
    expect(again.deps).toEqual(on.deps);
  });
});

describe('holding and city chaos in the train sim', () => {
  /** The busy line with holding, event service, a crawl, a closed timepoint and a 40-minute stall. */
  const chaosRun = (grace: boolean) => {
    const { net } = syntheticLine({ stops: STOPS, spacing: 1000, headway: H, cars: 8, hold: 0.7, timepoints: [5, 11], recoveryPct: 0.1 });
    const sim = new TrainSim({ arrive: () => ({ alight: 10, board: 30 }), depart() {}, evacuate() {}, pass() {} }, 1);
    const t0 = 5.5 * 3600;
    sim.setNetwork(net, t0);
    // Event service: 2-minute headways 07:00–08:00.
    sim.setOverrides([{ id: 1, routeId: 1, from: 7 * 3600, to: 8 * 3600, headwayMin: 2, eventId: 0 }]);
    let stalled = -1;
    let heldMax = 0;
    for (let t = t0 + TIME.simStep; t <= 10 * 3600; t += TIME.simStep) {
      if (t === 6.5 * 3600) sim.setRestrictions([{ id: 1, edge: 0, edgeDir: 0, u0: 3000, u1: 3800, v: 15 / 3.6, until: 7.5 * 3600, track: -1 }]);
      if (t === 7.5 * 3600) sim.setRestrictions([]);
      if (t === 7 * 3600) {
        // Station 5 (a timepoint) closes for 20 minutes.
        sim.closedUntil = new Float64Array(STOPS);
        sim.closedUntil[5] = t + 20 * 60;
      }
      if (t === 8 * 3600) {
        const tr = sim.trains.find((x) => x.state === TState.Running && x.dir === 0 && x.s > 3000)!;
        stalled = tr.id;
        tr.holdUntil = t + 40 * 60;
        if (grace) sim.extendGrace([1], t + 40 * 60);
      }
      sim.step(t, TIME.simStep);
      heldMax = Math.max(heldMax, sim.heldCount());
      // Never held at the closed timepoint.
      for (const x of sim.trains) if (sim.isHeld(x) && sim.closedUntil[net.routes[0].dirs[x.dir].stopStation[x.stop]] > t) throw new Error('held at a closed station');
    }
    return { sim, stalled, heldMax, stats: sim.closeDayRegularity().routes[1] };
  };

  it('holds through event service, a crawl and a closure, and leaves the watchdog to the incident grace', () => {
    const withGrace = chaosRun(true);
    expect(withGrace.stalled).toBeGreaterThan(0);
    expect(withGrace.heldMax).toBeGreaterThan(0);
    expect(withGrace.stats.holds).toBeGreaterThan(0);
    expect(withGrace.sim.day.deadlocks).toBe(0);
    // Without the grace the 40-minute stall is still caught after 30 minutes (holding doesn't mask it).
    expect(chaosRun(false).sim.day.deadlocks).toBeGreaterThan(0);
  });
});

describe('headway changes (periods, event service)', () => {
  it('judges gaps by the headway trains were dispatched under: an on-time line is even and never held', () => {
    // Noise-free 20-stop line with the default headways (night 20, am 4, midday 8, pm 4, evening
    // 10 min) and 2-minute event service 17:00–18:00. Trains dispatched just before 10:00 or 20:00
    // reach the downstream stops under the longer headway; before the fix they read as bunched
    // (110 of 266 headways in the hour after 20:00) and were held at every timepoint.
    const run = (hold: number) => {
      const { net, route } = syntheticLine({ stops: 20, spacing: 1200, headway: 240, cars: 8, hold, timepoints: hold ? [5, 10, 15] : [] });
      const hw = { night: 20, am: 4, midday: 8, pm: 4, evening: 10 };
      route.headways = [hw.night, hw.am, hw.midday, hw.pm, hw.evening].map((m) => m * 60);
      route.fleet = trainsNeeded({ headways: { ...hw, pm: 2 } }, [route.dirs[0].runTime, route.dirs[1].runTime]) + 2;
      const sim = new TrainSim({ arrive: () => ({ alight: 0, board: 0 }), depart() {}, evacuate() {}, pass() {} }, 1);
      const t0 = 5 * 3600;
      sim.setNetwork(net, t0);
      sim.setOverrides([{ id: 1, routeId: route.id, from: 17 * 3600, to: 18 * 3600, headwayMin: 2, eventId: 0 }]);
      let heldMax = 0;
      for (let t = t0 + TIME.simStep; t <= 21.5 * 3600; t += TIME.simStep) {
        sim.step(t, TIME.simStep);
        heldMax = Math.max(heldMax, sim.heldCount());
      }
      return { stats: sim.closeDayRegularity().routes[route.id], heldMax, deadlocks: sim.day.deadlocks };
    };
    for (const hold of [0, 0.7]) {
      const r = run(hold);
      expect(r.stats.samples).toBeGreaterThan(3000);
      expect(r.stats.cv).toBeLessThan(0.01);
      expect(r.stats.bunched).toBe(0);
      expect(r.stats.gaps).toBe(0);
      expect(Math.abs(r.stats.ewt)).toBeLessThan(0.5);
      expect(r.stats.termLate).toBeLessThan(1);
      expect(r.stats.holds).toBe(0);
      expect(r.heldMax).toBe(0);
      expect(r.deadlocks).toBe(0);
    }
  });
});

describe('terminal holding', () => {
  it('spaces departures that a late start has backlogged', () => {
    const first2 = (hold: number) => {
      const { net } = syntheticLine({ stops: 6, spacing: 1000, headway: H, cars: 8, hold, fleet: 6 });
      const deps: number[] = [];
      const sim = new TrainSim({ arrive: () => ({ alight: 0, board: 0 }), depart: (tr, _r, k, t) => (tr.dir === 0 && k === 0 ? deps.push(t) : 0), evacuate() {}, pass() {} }, 1);
      const t0 = 6 * 3600;
      sim.setNetwork(net, t0);
      // First step 2.5 headways later: both pending slots are overdue.
      for (let t = t0 + 2.5 * H; t < t0 + 6 * H; t += TIME.simStep) sim.step(t, TIME.simStep);
      return { gap: deps[1] - deps[0], sim };
    };
    const a = first2(0);
    const b = first2(0.7);
    expect(a.gap).toBeLessThan(60);
    expect(b.gap).toBeGreaterThanOrEqual(0.7 * H - 2);
    expect(b.sim.closeDayRegularity().network.holds).toBeGreaterThan(0);
  });
});

describe('yield rule', () => {
  it('releases a hold only for another route queued close behind the tail', () => {
    const occ: OccEntry[][] = [[], [{ train: 0, tail: 900, head: 1000 }]];
    const routeOf = (i: number) => [7, 3][i];
    const uTail = 1300;
    // Train 0 is route 7, its head 300 m behind the held train's tail.
    expect(queuedBehind(occ, 1, uTail, 400, 3, routeOf)).toBe(true);
    // Same route: no yield.
    expect(queuedBehind(occ, 1, uTail, 400, 7, routeOf)).toBe(false);
    // 500 m behind: too far.
    expect(queuedBehind(occ, 1, 1500, 400, 3, routeOf)).toBe(false);
    // Ahead of the held train: not queued behind it.
    expect(queuedBehind(occ, 1, 800, 400, 3, routeOf)).toBe(false);
    expect(queuedBehind(occ, 0, uTail, 400, 3, routeOf)).toBe(false);
  });
});

describe('recovery and fleet sizing', () => {
  it('adds recovery to the round trip', () => {
    const headways = { night: 20, am: 4, midday: 8, pm: 4, evening: 10 };
    expect(trainsNeeded({ headways, control: { recoveryPct: 0.1 } }, [1200, 1200])).toBe(14);
    expect(trainsNeeded({ headways, control: { recoveryPct: 0 } }, [1200, 1200])).toBe(13);
    expect(trainsNeeded({ headways }, [1200, 1200])).toBe(13);
  });

  it('suggests timepoints near a third and two thirds, avoiding shared stops', () => {
    const r = { id: 1, stops: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    expect(suggestTimepoints(r, [r])).toEqual([4, 7]);
    // Stop 4 is shared: the nearest unshared one instead.
    expect(suggestTimepoints(r, [r, { id: 2, stops: [4, 20] }])).toEqual([3, 7]);
    // An 8-stop line sharing stops 3–6 with another route (London's Central and a route from
    // Holborn to Liverpool Street): one near each target, not two adjacent western stops.
    const central = { id: 1, stops: [10, 11, 12, 13, 14, 15, 16, 17] };
    expect(suggestTimepoints(central, [central, { id: 2, stops: [13, 14, 15, 16, 30] }])).toEqual([12, 15]);
    // Every stop near the second target taken or shared: never next to the first pick.
    const tps = suggestTimepoints(central, [central, { id: 2, stops: [11, 13, 14, 15, 16] }]);
    expect(tps.length).toBe(2);
    const at = tps.map((s) => central.stops.indexOf(s));
    expect(Math.abs(at[1] - at[0])).toBeGreaterThan(1);
    expect(suggestTimepoints({ id: 1, stops: [1, 2, 3, 4, 5] }, [])).toEqual([3]);
    expect(suggestTimepoints({ id: 1, stops: [1, 2] }, [])).toEqual([]);
    expect(defaultControl()).toMatchObject({ hold: true, holdFraction: 0.7, recoveryPct: 0.1, shortTurn: true, timepoints: [] });
    expect(legacyControl()).toMatchObject({ hold: false, recoveryPct: 0, shortTurn: true });
    expect(offControl()).toMatchObject({ hold: false, recoveryPct: 0, shortTurn: false });
  });
});

describe('compiled controls and car sales (real data)', () => {
  const world = loadWorldFromDisk();
  const land = loadLandFromDisk();
  /** A 6-stop deep line up the West Side. */
  function westSide(sandbox = false) {
    const game = createHeadlessGame(world, land, { sandbox });
    drawLine(game, [[-74.0135, 40.703], [-74.0105, 40.712], [-74.0072, 40.7255], [-74.0035, 40.7395], [-73.9935, 40.753]], 'deep');
    const stops = [
      stationNear(game, [-74.0128, 40.7045], 'South Ferry'),
      stationNear(game, [-74.0098, 40.715], 'Chambers St'),
      stationNear(game, [-74.0068, 40.727], 'Houston St'),
      stationNear(game, [-74.0045, 40.736], '12 St'),
      stationNear(game, [-74.0, 40.746], '23 St'),
      stationNear(game, [-73.9925, 40.7545], '34 St'),
    ];
    while (!game.finance.canAfford(game.blueprintSummary().cost + 1e9) && game.finance.issueBond(game.day)) {
      /* borrow */
    }
    expect(game.build(true).ok).toBe(true);
    return { game, stops };
  }

  it('flags timepoints (never the ends), compiles hold, and changes opsKey', () => {
    const { game, stops } = westSide(true);
    const r = makeRoute(game, 'West', '1', '#E8443A', stops, 8, {}, 'heavy', { hold: true, timepoints: [stops[0], stops[2], stops[5]] });
    const c = compileNetwork(game).net.routes[0];
    expect(Array.from(c.dirs[0].timepoint!)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(Array.from(c.dirs[1].timepoint!)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(c.hold).toBe(0.7);
    const key = c.opsKey;
    game.routes.update(r.id, { control: { ...r.control, timepoints: [stops[2], stops[3]] } });
    const c2 = compileNetwork(game).net.routes[0];
    expect(c2.opsKey).not.toBe(key);
    expect(Array.from(c2.dirs[0].timepoint!)).toEqual([0, 0, 1, 1, 0, 0]);
    game.routes.update(r.id, { control: { ...r.control, hold: false } });
    expect(compileNetwork(game).net.routes[0].hold).toBe(0);
    // Removing a stop drops its timepoint.
    game.routes.update(r.id, { stops: stops.filter((s) => s !== stops[3]) });
    expect(game.routes.get(r.id)!.control.timepoints).toEqual([stops[2]]);
  });

  it('sells idle and spare cars at 40% and takes them off the maintenance base', () => {
    const { game, stops } = westSide();
    const r = makeRoute(game, 'West', '1', '#E8443A', stops, 8);
    const plan = fleetPlan(game, r);
    expect(idleCars(game, r)).toBe(0);
    r.ownedCars += 2 * r.cars; // two trains too many (e.g. after lowering the frequency)
    game.finance.spend(2 * r.cars * TRAINS.heavy.costPerCar, 'trains');
    expect(idleCars(game, r)).toBe(2 * r.cars);
    const cash = game.finance.cash, assets = game.finance.assetValue;
    const sale = sellIdleCars(game, r);
    expect(sale.ok).toBe(true);
    expect(sale.cars).toBe(16);
    expect(sale.proceeds).toBeCloseTo(2 * 8 * 2.5e6 * 0.4, 3);
    expect(sale.proceeds).toBeCloseTo(carSaleValue('heavy', 16), 3);
    expect(game.finance.cash - cash).toBeCloseTo(sale.proceeds, 3);
    expect(assets - game.finance.assetValue).toBeCloseTo(2 * 8 * 2.5e6, 3);
    expect(r.ownedCars).toBe(plan.carsNeeded);
    expect(sellIdleCars(game, r).ok).toBe(false);
    // The spare pool (from a deleted route).
    game.routes.remove(r.id);
    const spare = game.routes.spareCars.heavy;
    expect(spare).toBe(plan.carsNeeded);
    const s2 = sellSpareCars(game, 'heavy');
    expect(s2).toMatchObject({ ok: true, cars: spare });
    expect(s2.proceeds).toBeCloseTo(carSaleValue('heavy', spare), 3);
    expect(game.routes.spareCars.heavy).toBe(0);
    expect(sellSpareCars(game, 'heavy').ok).toBe(false);
    // A route without a path has no idle cars.
    const lone = game.routes.create({ name: 'X', bullet: 'X', color: '#fff', cls: 'heavy', stops: [stops[0]], cars: 8, headways: { night: 0, am: 4, midday: 8, pm: 4, evening: 10 }, ownedCars: 40 });
    expect(idleCars(game, lone)).toBe(0);
    expect(purchaseFleet(game, lone).ok).toBe(true);
  });
});
