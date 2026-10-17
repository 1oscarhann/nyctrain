/**
 * Headless sim test (no rendering): the spec's test network — a heavy metro line from Lower
 * Manhattan up the West Side to Upper Manhattan, plus a line from Midtown that shares the West
 * Side trunk and runs under the East River into Brooklyn — run for 3 in-game days at full speed.
 */
import { describe, expect, it } from 'vitest';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { buildExpressTestNetwork, buildLondonExpressTestNetwork, buildTestNetwork, createHeadlessGame, runDays, startEngine, stepUntil, type HeadlessRun } from '../src/sim/headless';
import type { Game } from '../src/core/game';
import type { Route } from '../src/routes/types';
import { applyCity } from '../src/cities';
import { pairKeyId } from '../src/routes/express';
import { TState } from '../src/sim/trainSim';
import type { Alert, DayReport } from '../src/sim/protocol';
import { fmtMoney } from '../src/core/units';
import { fareAt, type FarePolicy } from '../src/economy/fares';
import { defaultControl, legacyControl, suggestTimepoints } from '../src/routes/control';

describe('headless simulation', () => {
  it('runs 3 days on the test network with plausible, finite results', () => {
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
    const { r1, r2, errors } = buildTestNetwork(game);
    expect(errors).toEqual([]);
    // The two routes really share a trunk (Columbus Circle → 14 St).
    const shared = r2.stops.filter((s) => r1.stops.includes(s));
    expect(shared.length).toBeGreaterThanOrEqual(3);

    const run = runDays(game, 3);
    const c = run.engine.commuters!;
    expect(run.reports.length).toBe(3);
    // Summary for balance tuning.
    for (const r of run.reports) {
      const f = game.finance.history.find((h) => h.day === r.day)!;
      console.log(
        `day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · transit ${(r.transitShare * 100).toFixed(1)}% · commute ${r.avgCommute.toFixed(1)} min (baseline ${r.baselineCommute.toFixed(1)}) · late ${r.avgLateness.toFixed(0)} s · deadlocks ${r.deadlocks} · revenue ${fmtMoney(f.revenue)} · costs ${fmtMoney(f.operating + f.staffing + f.maintenance)} · cash ${fmtMoney(f.cash)}`,
      );
    }
    console.log(`${c.A.toLocaleString()} agents · ${run.ms} ms for 3 days`);

    const last = run.reports[2];
    // Ridership above zero and plausible for two lines and 16 stations.
    expect(last.riders).toBeGreaterThan(10_000);
    expect(last.riders).toBeLessThan(1_000_000);
    expect(last.transitShare).toBeGreaterThan(0);
    expect(last.transitShare).toBeLessThan(0.5);
    // Daily adaptation: shares grow day over day toward equilibrium.
    expect(run.reports[2].riders).toBeGreaterThan(run.reports[1].riders);
    // Mode shares sum to 1.
    for (const r of run.reports) expect(r.transitShare + r.walkShare + r.driveShare).toBeCloseTo(1, 6);
    // Both routes carry people.
    expect(last.routeRiders[r1.id]).toBeGreaterThan(0);
    expect(last.routeRiders[r2.id]).toBeGreaterThan(0);
    // No trains deadlock, no agents stuck forever.
    for (const r of run.reports) expect(r.deadlocks).toBe(0);
    expect(c.stuckCount()).toBe(0);
    expect(c.inFlight()).toBe(0);
    // Finances are finite.
    for (const h of game.finance.history) {
      for (const v of [h.revenue, h.operating, h.staffing, h.maintenance, h.cash, h.bondInterest, h.bondPrincipal]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(Number.isFinite(game.finance.cash)).toBe(true);
    expect(Number.isFinite(last.avgCommute)).toBe(true);
    // Operations control: regularity is measured, and fares by band and period add up to the
    // fare-paying trips (within 2%: trips in flight at midnight are billed but not yet complete).
    expect(last.regularity.samples).toBeGreaterThan(0);
    expect(Object.keys(last.routeRegularity).map(Number).sort()).toEqual([r1.id, r2.id].sort());
    const trips = last.fares.trips.reduce((a, b) => a + b, 0);
    expect(Math.abs(trips - last.fareTrips) / last.fareTrips).toBeLessThan(0.02);
  }, 180_000);

  it('bills each journey at its first boarding, by band and period', () => {
    const fares: FarePolicy = { peak: 3.5, offPeak: 2, lowIncome: 0.5 };
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { fares });
    buildTestNetwork(game);
    const run = runDays(game, 2);
    const r = run.reports[1];
    const { trips, revenue } = r.fares;
    for (let band = 0; band < 3; band++) {
      for (const peak of [false, true]) {
        const i = band * 2 + (peak ? 1 : 0);
        expect(trips[i]).toBeGreaterThan(0);
        expect(Math.abs(revenue[i] - trips[i] * fareAt(fares, band, peak))).toBeLessThan(1e-6 * revenue[i] + 1e-6);
      }
    }
    const total = revenue.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(r.fareRevenue, 3);
    const peakTrips = trips[1] + trips[3] + trips[5];
    expect(peakTrips / trips.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.8);
    // Band 0 pays half of band 2's fare in each period.
    for (const p of [0, 1]) expect(revenue[p] / trips[p]).toBeCloseTo((revenue[4 + p] / trips[4 + p]) / 2, 9);
    // The ledger books what was billed.
    expect(game.finance.history.find((h) => h.day === r.day)!.revenue).toBe(r.fareRevenue);
    expect(r.bandShare.every((x) => x > 0 && x < 1)).toBe(true);
  }, 180_000);

  it('holding evens out gaps with commuters on board, without deadlocks', () => {
    const play = (on: boolean) => {
      const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
      game.routes.newControl = on ? defaultControl : legacyControl;
      const { r1, r2 } = buildTestNetwork(game);
      if (on) for (const r of [r1, r2]) game.routes.update(r.id, { control: { ...r.control, timepoints: suggestTimepoints(r, [r1, r2]) } });
      const run = runDays(game, 2);
      return { run, ids: [r1.id, r2.id], fleet: r1.ownedCars + r2.ownedCars };
    };
    const off = play(false);
    const on = play(true);
    const a = off.run.reports[1].regularity, b = on.run.reports[1].regularity;
    console.log(`test network day 1: bunched ${(a.bunched * 100).toFixed(1)}% → ${(b.bunched * 100).toFixed(1)}% · CV ${a.cv.toFixed(2)} → ${b.cv.toFixed(2)} · holds ${b.holds} · cars ${off.fleet} → ${on.fleet}`);
    expect(on.fleet).toBeGreaterThan(off.fleet);
    expect(b.bunched).toBeLessThan(0.6 * a.bunched);
    expect(b.cv).toBeLessThan(a.cv);
    expect(b.holds).toBeGreaterThan(0);
    for (const x of [off, on]) {
      for (const r of x.run.reports) expect(r.deadlocks).toBe(0);
      expect(x.run.engine.commuters!.stuckCount()).toBe(0);
      expect(x.run.engine.commuters!.inFlight()).toBe(0);
      expect(Object.keys(x.run.reports[1].routeRegularity).map(Number).sort()).toEqual([...x.ids].sort());
    }
  }, 240_000);

  it('holding coexists with city chaos: incidents, a long stall under the watchdog grace, closures and event service', () => {
    const D = 86400, H = 3600;
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { chaos: 'wild', chaosSeed: 42 });
    const { r1, r2 } = buildTestNetwork(game);
    for (const r of [r1, r2]) game.routes.update(r.id, { control: { ...r.control, timepoints: suggestTimepoints(r, [r1, r2]) } });
    expect(r1.control.hold && r1.control.timepoints.length > 0).toBe(true);
    // Event service on the shared trunk in the evening (shorter headways than the route's own).
    game.addService({ routeId: r2.id, from: D + 17 * H, to: D + 19.5 * H, headwayMin: 2, eventId: 0 });
    const alerts: Alert[] = [];
    const reports: DayReport[] = [];
    const engine = startEngine(game, { alert: (a) => alerts.push(a), reports });
    stepUntil(engine, D + 8 * H);
    // A 40-minute breakdown on the shared trunk: longer than the 30-minute watchdog, so only the
    // per-route grace keeps the queue behind it (holding trains included) from counting as deadlocked.
    const tr = engine.trains.trains.find((x) => x.routeId === r1.id && x.state === TState.Running && x.s > 1500)!;
    expect(engine.chaos.force({ kind: 'breakdown', train: tr.id, duration: 40 * 60 })).toBeGreaterThan(0);
    // A police closure at one of r1's timepoints, and a signal problem.
    expect(engine.chaos.force({ kind: 'police', station: r1.control.timepoints[0], duration: 20 * 60 }, engine.time + 1200)).toBeGreaterThan(0);
    expect(engine.chaos.force({ kind: 'signal', duration: 45 * 60, r1: 0.3, r2: 0.5 }, engine.time + 1800)).toBeGreaterThan(0);
    let heldSeen = 0;
    while (engine.time < 3 * D + 60) {
      engine.step();
      if (engine.time % 600 === 0) heldSeen += engine.trains.heldCount();
    }
    for (const r of reports) expect(r.deadlocks).toBe(0);
    expect(engine.commuters!.stuckCount()).toBe(0);
    expect(engine.commuters!.inFlight()).toBe(0);
    const day1 = reports.find((r) => r.day === 1)!;
    expect(day1.chaos!.incidents.breakdown).toBeGreaterThanOrEqual(1);
    expect(day1.chaos!.incidents.police).toBeGreaterThanOrEqual(1);
    expect(day1.regularity.holds).toBeGreaterThan(0);
    expect(heldSeen).toBeGreaterThan(0);
    expect(alerts.filter((a) => a.status === 'active').length).toBeGreaterThan(3);
    // The stall itself delayed the line, but trains ran again afterwards.
    expect(reports.find((r) => r.day === 2)!.riders).toBeGreaterThan(100_000);
  }, 240_000);

  it('produces delays when the shared trunk is overscheduled', () => {
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
    buildTestNetwork(game, { r1: 1.5, r2: 1.5 });
    const run = runDays(game, 1);
    const r = run.reports[0];
    expect(r.avgLateness).toBeGreaterThan(30);
    expect(r.deadlocks).toBe(0);
  }, 180_000);
});

/**
 * Express service on a four-track trunk (v2, docs/v2/express-quad.md §13 test 31): checks shared by
 * the New York and London runs.
 */
function expressChecks(game: Game, run: HeadlessRun, local: Route, express: Route): { overtakes: number; cross: number } {
  const c = run.engine.commuters!;
  for (const r of run.reports) expect(r.deadlocks).toBe(0);
  expect(c.stuckCount()).toBe(0);
  expect(c.inFlight()).toBe(0);
  const last = run.reports[run.reports.length - 1];
  expect(last.riders).toBeGreaterThan(10_000);
  expect(last.riders).toBeLessThan(1_000_000);
  expect(last.routeRiders[local.id]).toBeGreaterThan(0);
  expect(last.routeRiders[express.id]).toBeGreaterThan(0);
  const overtakes = run.reports.reduce((s, r) => s + (r.routeOvertakes?.[express.id] ?? 0), 0);
  const cross = run.reports.reduce((s, r) => s + Object.values(r.crossTransfers ?? {}).reduce((a, b) => a + b, 0), 0);
  expect(overtakes).toBeGreaterThan(0);
  for (const r of run.reports) expect(r.crossTransfers).toBeDefined();
  // A cross-platform pair is staffed as 1.4 stations.
  const pairs = [...game.network.stations.values()].filter((s) => s.pair !== undefined && s.id < s.pair).length;
  expect(last.stationsOpen).toBeCloseTo(game.network.stations.size - pairs * 0.6, 9);
  for (const h of game.finance.history) for (const v of [h.revenue, h.operating, h.staffing, h.maintenance, h.cash]) expect(Number.isFinite(v)).toBe(true);
  // Living City: each pair is one served station (one value-capture district point, under its key).
  const v = run.engine.growthView()!;
  for (const s of game.network.stations.values()) {
    if (s.pair === undefined) continue;
    const key = pairKeyId(game.network, s.id);
    expect(key).toBe(Math.min(s.id, s.pair));
    if (s.id !== key) expect(v.stationTracts[s.id]).toBeUndefined();
  }
  // Express trips are shorter than the local's: the express skips the local-only stops.
  return { overtakes, cross };
}

describe('express service on a four-track trunk', () => {
  it('31. runs an express on a four-track West Side trunk', () => {
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
    const { local, express, errors, quad } = buildExpressTestNetwork(game);
    expect(errors).toEqual([]);
    expect(quad.problems).toEqual([]);
    expect(express.express).toBe(true);
    expect(express.stops.length).toBeLessThan(local.stops.length);
    const run = runDays(game, 2);
    const { overtakes, cross } = expressChecks(game, run, local, express);
    console.log(`West Side: riders ${Math.round(run.reports[1].riders).toLocaleString()} (local ${run.reports[1].routeRiders[local.id]}, express ${run.reports[1].routeRiders[express.id]}) · ${overtakes} overtakes · ${cross} cross-platform transfers in 2 days`);
    expect(cross).toBeGreaterThan(0);
  }, 180_000);

  it('London: an express on a deep four-track trunk along Oxford Street and through the City', () => {
    applyCity('london');
    try {
      const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
      const { local, express, errors, quad } = buildLondonExpressTestNetwork(game);
      expect(errors).toEqual([]);
      expect(quad.problems).toEqual([]);
      const run = runDays(game, 2);
      const { overtakes, cross } = expressChecks(game, run, local, express);
      console.log(`London Central: riders ${Math.round(run.reports[1].riders).toLocaleString()} (local ${run.reports[1].routeRiders[local.id]}, express ${run.reports[1].routeRiders[express.id]}) · ${overtakes} overtakes · ${cross} cross-platform transfers in 2 days`);
    } finally {
      applyCity('nyc');
    }
  }, 180_000);
});
