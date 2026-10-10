/**
 * Headless sim test (no rendering): the spec's test network — a heavy metro line from Lower
 * Manhattan up the West Side to Upper Manhattan, plus a line from Midtown that shares the West
 * Side trunk and runs under the East River into Brooklyn — run for 3 in-game days at full speed.
 */
import { describe, expect, it } from 'vitest';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { buildTestNetwork, createHeadlessGame, runDays } from '../src/sim/headless';
import { fmtMoney } from '../src/core/units';

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
  }, 180_000);

  it('produces delays when the shared trunk is overscheduled', () => {
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
    buildTestNetwork(game, { r1: 1.5, r2: 1.5 });
    const run = runDays(game, 1);
    const r = run.reports[0];
    expect(r.avgLateness).toBeGreaterThan(30);
    expect(r.deadlocks).toBe(0);
  }, 180_000);
});
