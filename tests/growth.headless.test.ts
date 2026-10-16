/**
 * Living City on live sims (slow): Commuters.commuteBenefit on the New York test network and a
 * small London line, and one growth month from those benefits (docs/v2/living-city.md §3.2–3.5).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { VALUE_CAPTURE } from '../src/balance';
import { applyCity } from '../src/cities';
import type { Game } from '../src/core/game';
import { Growth, servedStations } from '../src/sim/growth';
import { buildTestNetwork, createHeadlessGame, drawLine, makeRoute, midtownArenaEvent, nearStations, runDays, startEngine, stationNear, stepUntil } from '../src/sim/headless';
import { generalisedCosts, logsum } from '../src/sim/modeChoice';
import { buildGroups, type Commuters } from '../src/sim/commuters';
import { Engine } from '../src/sim/engine';
import { compileNetwork } from '../src/routes/compile';
import { CLEAR } from '../src/core/cityCalendar';
import { fmtMoney } from '../src/core/units';
import type { Alert, DayReport } from '../src/sim/protocol';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';

afterAll(() => {
  applyCity('nyc');
});

const sha = (...arrs: Float32Array[]) => {
  const h = createHash('sha256');
  for (const a of arrs) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  return h.digest('hex');
};

/** The benefit of one group, from public state, as §3.2 defines it (clear-weather walk and drive). */
function groupBenefit(c: Commuters, g: number): number {
  const am = c.pathAM[g], pm = c.pathPM[g];
  if (!am || !pm) return 0;
  const time = c.obsTime[g] > 0 ? c.obsTime[g] : (am.time + pm.time) / 2;
  const cost = generalisedCosts(c.gGeom[g], c.gBand[g], { time, transfers: (am.transfers + pm.transfers) / 2, crowdMinutes: c.obsCrowd[g], fare: c.groupFare(g) });
  return logsum([cost[0], cost[1]]) - logsum(cost);
}

/** Checks shared by both cities; returns the growth after one month. */
function checkBenefitAndMonth(game: Game, engine: Engine) {
  const c = engine.commuters!;
  const world = game.world;
  const T = world.tracts.length;
  const before = sha(c.shares, c.obsTime, c.obsCrowd);
  const b = c.commuteBenefit();
  // Read-only.
  expect(sha(c.shares, c.obsTime, c.obsCrowd)).toBe(before);
  expect(b.home.length).toBe(T);
  for (let i = 0; i < T; i++) {
    expect(Number.isFinite(b.home[i]) && b.home[i] >= 0).toBe(true);
    expect(Number.isFinite(b.work[i]) && b.work[i] >= 0).toBe(true);
  }
  expect(b.mean).toBeGreaterThan(0);
  // The home tract with the most riders: its mean equals the per-group definition.
  const riders = new Float64Array(T);
  for (let g = 0; g < c.G; g++) riders[c.gHome[g]] += c.gCount[g] * c.shares[g * 3 + 2];
  let top = 0;
  for (let i = 1; i < T; i++) if (riders[i] > riders[top]) top = i;
  let s = 0, n = 0;
  for (let g = 0; g < c.G; g++) {
    if (c.gHome[g] !== top) continue;
    s += c.gCount[g] * groupBenefit(c, g);
    n += c.gCount[g];
  }
  expect(b.home[top]).toBeGreaterThan(5);
  expect(Math.abs(b.home[top] - s / n)).toBeLessThan(1e-3);
  // Tracts near a served station benefit more than the rest.
  const served = servedStations(engine.net);
  expect(served.length).toBeGreaterThan(0);
  let nearS = 0, nearN = 0, farS = 0, farN = 0;
  const near = new Uint8Array(T);
  world.tracts.forEach((t, i) => {
    near[i] = served.some((st) => Math.hypot(st.x - t.x, st.y - t.y) <= 800) ? 1 : 0;
    if (near[i]) {
      nearS += b.home[i];
      nearN++;
    } else {
      farS += b.home[i];
      farN++;
    }
  });
  expect(nearS / nearN).toBeGreaterThan(3 * (farS / farN));
  // A higher fare lowers the benefit (the fare enters exactly as in mode choice), then restores.
  const fares = c.farePolicy();
  c.setFares({ peak: 5, offPeak: 5, lowIncome: 1 });
  expect(c.commuteBenefit().mean).toBeLessThan(b.mean);
  c.setFares(fares);
  expect(c.commuteBenefit().mean).toBe(b.mean);
  // One growth month on these benefits.
  const growth = new Growth(world, 'steady');
  const rep = growth.step(17, b, served)!;
  expect(rep.valueCapture).toBeGreaterThan(0);
  expect(Number.isFinite(rep.valueCapture)).toBe(true);
  expect(rep.districtTracts).toBeGreaterThan(0);
  expect(rep.dResidents).toBeGreaterThan(0);
  expect(Math.abs(rep.residents - rep.jobs) / rep.residents).toBeLessThan(1e-6);
  expect(rep.label).toBe('Jan 2030');
  expect(Object.values(rep.stationLevy).reduce((a, v) => a + v, 0)).toBeCloseTo(rep.valueCapture, 3);
  let gn = 0, gnN = 0, gf = 0, gfN = 0;
  for (let i = 0; i < T; i++) {
    if (near[i]) {
      gn += growth.mRes[i];
      gnN++;
    } else {
      gf += growth.mRes[i];
      gfN++;
    }
  }
  expect(gn / gnN).toBeGreaterThan(gf / gfN);
  return { growth, rep, b };
}

describe('Living City commute benefit (headless)', () => {
  it('New York: the test network’s benefit is the logsum difference, read-only, highest near stations; one month grows the served city', () => {
    applyCity('nyc');
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk());
    buildTestNetwork(game);
    const run = runDays(game, 2);
    const { rep, b } = checkBenefitAndMonth(game, run.engine);
    console.log(`NYC test network: mean benefit ${b.mean.toFixed(1)} min · value capture $${(rep.valueCapture / 1e6).toFixed(2)}M in month 1 · ${rep.districtTracts} district tracts`);
  });

  it('London: a short central line; MSOAs join the district only for their share within 800 m', () => {
    applyCity('london');
    const world = loadWorldFromDisk();
    const game = createHeadlessGame(world, loadLandFromDisk(), { sandbox: true });
    drawLine(game, [[-0.1131, 51.5031], [-0.1000, 51.5100], [-0.0886, 51.5133], [-0.0823, 51.5180]], 'deep');
    const stops = [
      stationNear(game, [-0.1131, 51.5031], 'Waterloo'),
      stationNear(game, [-0.0975, 51.5120], 'Blackfriars'),
      stationNear(game, [-0.0886, 51.5133], 'Bank'),
      stationNear(game, [-0.0823, 51.5180], 'Liverpool Street'),
    ];
    expect(game.build(true).ok).toBe(true);
    makeRoute(game, 'Waterloo & City', 'W', '#2F7FE0', stops, 8, { am: 3, pm: 3 });
    const run = runDays(game, 2);
    const { growth, rep, b } = checkBenefitAndMonth(game, run.engine);
    const vc = growth.valueCapture(servedStations(run.engine.net));
    // Large zones count partially; most of London's levy comes from workplaces (business rates).
    let partial = 0, homes = 0, jobs = 0;
    for (let i = 0; i < growth.T; i++) {
      if (!vc.district[i]) continue;
      if (vc.share[i] < 1) partial++;
      const p = 1 + growth.premium[i];
      homes += vc.share[i] * VALUE_CAPTURE.taxRateHomes * VALUE_CAPTURE.valuePerResident * growth.R0[i] * (growth.mRes[i] * p - 1);
      jobs += vc.share[i] * VALUE_CAPTURE.taxRateJobs * VALUE_CAPTURE.valuePerJob * growth.J0[i] * (growth.mJobs[i] * p - 1);
    }
    expect(partial).toBeGreaterThan(0);
    expect(jobs).toBeGreaterThan(homes);
    console.log(`London line: mean benefit ${b.mean.toFixed(1)} min · value capture £${(rep.valueCapture / 1e6).toFixed(2)}M in month 1 · ${rep.districtTracts} district MSOAs (${partial} partly)`);
  });
});

// ---------------------------------------------------------------------------
// Month close, saves and finances on live sims (docs/v2/living-city.md §12, tests 13–15), London,
// pace Off, and city chaos around a month close.

const D = 86400;
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const AGENTS = ['aHx', 'aHy', 'aWx', 'aWy', 'aDepart', 'aReturn', 'aGroup', 'aBand', 'aPeak'] as const;

/** Commuter agents index their own group's slice, and event fans sit after them (never in a group). */
function expectAgentsConsistent(c: Commuters) {
  let bad = 0;
  for (let g = 0; g < c.G; g++) for (let a = c.gStart[g]; a < c.gStart[g + 1]; a++) if (c.aGroup[a] !== g || c.aBand[a] !== c.gBand[g]) bad++;
  expect(bad).toBe(0);
  expect(c.gStart[c.G]).toBe(c.A);
  for (const f of ['aHx', 'aGroup', 'aBand', 'aPeak'] as const) expect(c[f].length, f).toBe(c.A + c.poolCap);
  for (const f of ['aState', 'aPlat', 'aMode', 'aBoarded', 'aTripStart'] as const) expect(c[f].length, f).toBeGreaterThanOrEqual(c.A + c.poolCap);
  const evGroups = (c as unknown as { evGroups: unknown[] }).evGroups.length;
  for (let a = c.A; a < c.A + c.eventAgentCount(); a++) expect(c.aGroup[a]).toBeLessThan(evGroups);
}

describe('Living City month close (headless)', () => {
  it('13–14. New York: a month close grows the served city and carries riders over; a save mid-growth reloads to the same agents and plays out identically', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const T = world.tracts.length;
    const game = createHeadlessGame(world, loadLandFromDisk());
    buildTestNetwork(game);
    const run = runDays(game, 2);
    const e = run.engine;
    const c = e.commuters!;
    const before = { A: c.A, key: c.key, riders: run.reports[1].riders };
    const rep = e.monthClose(1)!;
    expect(rep).not.toBeNull();
    expect(Number.isFinite(rep.valueCapture) && rep.valueCapture > 0).toBe(true);
    expect(rep.dResidents).toBeGreaterThan(0);
    expect(Math.abs(rep.residents - rep.jobs) / rep.residents).toBeLessThan(1e-6);
    expect(rep.agents).toBe(c.A);
    expect(rep.commuters).toBe(c.A * 10);
    // A month is applied once.
    expect(e.monthClose(1)).toBeNull();
    // The served city grows faster than the rest.
    const g = e.growth!;
    const near = new Set(nearStations(game, 800));
    let sn = 0, nn = 0, so = 0, no = 0;
    for (let i = 0; i < T; i++) {
      if (near.has(i)) {
        sn += g.mRes[i];
        nn++;
      } else {
        so += g.mRes[i];
        no++;
      }
    }
    expect(sn / nn).toBeGreaterThan(so / no);
    // The agents are the rounding of the grown OD; the first growth re-placed every agent.
    expect(c.A).toBe(buildGroups(world.od, T, 10, 1885, g.factors()).A);
    expect(c.A).not.toBe(before.A);
    expect(c.key).toBe(`${before.key.split('|').slice(0, 5).join('|')}|${c.A}|${c.G}|${g.fingerprint()}`);
    expect(e.lastRegen!.replaced).toBe(true);
    expectAgentsConsistent(c);
    // Event-goers now come from the grown city's residents (amendment 2).
    const weights = (c as unknown as { originWeights: Float64Array | null }).originWeights!;
    expect(Array.from(weights)).toEqual(Array.from(g.currentResidents()));
    // 14. Save now (00:01, after the close) and reload twice.
    const st = e.simState();
    expect(st.growth).not.toBeNull();
    expect(st.mode.key).toBe(c.key);
    const reload = () => {
      const reports: DayReport[] = [];
      const x = new Engine(world, { agentScale: 10, seed: 1885, time: e.time, fares: game.fares, modeState: st.mode, growth: st.growth, chaos: game.chaosInit() }, { dayEnd: (r) => reports.push(r) });
      x.setNetwork(compileNetwork(game).net);
      return { x, reports };
    };
    const B = reload(), C = reload();
    for (const { x } of [B, C]) {
      const xc = x.commuters!;
      expect(xc.A).toBe(c.A);
      expect(xc.G).toBe(c.G);
      expect(xc.key).toBe(c.key);
      expect(bytes(xc.shares).equals(bytes(c.shares))).toBe(true);
      expect(bytes(xc.obsTime).equals(bytes(c.obsTime))).toBe(true);
      // Amendment 3: a reload of a grown city places every agent from its own seed, exactly as
      // the incremental regeneration did.
      for (const f of AGENTS) expect(bytes(xc[f]).equals(bytes(c[f])), f).toBe(true);
      expect(x.growth!.fingerprint()).toBe(g.fingerprint());
    }
    // One more day for all three.
    const end = 3 * D + 60;
    stepUntil(e, end);
    stepUntil(B.x, end);
    stepUntil(C.x, end);
    const r2 = run.reports[run.reports.length - 1];
    expect(r2.day).toBe(2);
    expect(r2.deadlocks).toBe(0);
    expect(c.stuckCount()).toBe(0);
    expect(c.inFlight()).toBe(0);
    // Continuity: the shares carried over, so riders do not collapse after the close.
    expect(r2.riders).toBeGreaterThanOrEqual(0.9 * before.riders);
    expect(r2.transitShare).toBeGreaterThan(0);
    expect(r2.transitShare).toBeLessThan(0.5);
    expect(r2.growth).toBeUndefined();
    // Reload determinism: two reloads play the day out identically; close to the uninterrupted run.
    const rb = B.reports[B.reports.length - 1], rc = C.reports[C.reports.length - 1];
    expect(rb.day).toBe(2);
    expect(rb).toEqual(rc);
    expect(Math.abs(rb.riders - r2.riders) / r2.riders).toBeLessThan(0.03);
    console.log(`month close: value capture $${(rep.valueCapture / 1e6).toFixed(2)}M · agents ${before.A} → ${c.A} · riders day 1 ${before.riders} → day 2 ${r2.riders} (reload ${rb.riders})`);
  });

  it('15. finances through runDays: value capture is booked on the month-close days and reaches the cash', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const game = createHeadlessGame(world, loadLandFromDisk());
    buildTestNetwork(game);
    const run = runDays(game, 4, { monthEvery: 2 });
    const closes = run.reports.filter((r) => r.growth);
    expect(closes.map((r) => r.day)).toEqual([1, 3]);
    const f = game.finance;
    const byDay = new Map(f.history.map((h) => [h.day, h]));
    for (const r of closes) {
      const h = byDay.get(r.day)!;
      expect(h.valueCapture).toBe(r.growth!.valueCapture);
      expect(h.valueCapture!).toBeGreaterThan(0);
      const prev = byDay.get(r.day - 1)!;
      const expected = prev.cash + h.revenue + h.valueCapture! - h.operating - h.staffing - h.maintenance - h.bondInterest - h.bondPrincipal;
      expect(h.cash).toBeCloseTo(expected, 2);
    }
    // Other days have no value-capture line at all (as before Living City).
    expect(byDay.get(0)!.valueCapture).toBeUndefined();
    expect(byDay.get(2)!.valueCapture).toBeUndefined();
    // The second month earns more than the first (the premium capitalises).
    expect(closes[1].growth!.valueCapture).toBeGreaterThan(closes[0].growth!.valueCapture);
  });

  it('pace Off: a month close does nothing and the city stays as it was', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const game = createHeadlessGame(world, loadLandFromDisk(), { growthPace: 'off' });
    buildTestNetwork(game);
    const run = runDays(game, 2);
    const c = run.engine.commuters!;
    const key = c.key, A = c.A, shares = bytes(c.shares.slice());
    expect(run.engine.monthClose(1)).toBeNull();
    expect(run.engine.growth!.months).toBe(0);
    expect(c.key).toBe(key);
    expect(c.A).toBe(A);
    expect(bytes(c.shares).equals(shares)).toBe(true);
    expect(run.engine.simState().growth).toBeNull();
    // Switching to Steady takes effect at the next close.
    run.engine.setGrowthPace('steady');
    expect(run.engine.monthClose(1)).not.toBeNull();
    expect(run.engine.growth!.months).toBe(1);
  });

  it('London: a month close balances the OD in MSOAs, pays value capture in pounds and runs on without deadlocks', () => {
    applyCity('london');
    const world = loadWorldFromDisk();
    const game = createHeadlessGame(world, loadLandFromDisk(), { sandbox: true });
    drawLine(game, [[-0.1131, 51.5031], [-0.1000, 51.5100], [-0.0886, 51.5133], [-0.0823, 51.5180]], 'deep');
    const stops = [
      stationNear(game, [-0.1131, 51.5031], 'Waterloo'),
      stationNear(game, [-0.0975, 51.5120], 'Blackfriars'),
      stationNear(game, [-0.0886, 51.5133], 'Bank'),
      stationNear(game, [-0.0823, 51.5180], 'Liverpool Street'),
    ];
    expect(game.build(true).ok).toBe(true);
    makeRoute(game, 'Waterloo & City', 'W', '#2F7FE0', stops, 8, { am: 3, pm: 3 });
    const run = runDays(game, 2);
    const e = run.engine;
    const riders1 = run.reports[1].riders;
    const rep = e.monthClose(1)!;
    expect(rep.valueCapture).toBeGreaterThan(0);
    expect(fmtMoney(rep.valueCapture).startsWith('£')).toBe(true);
    // The month's levy is plausible for one short line: thousands to a few million pounds.
    expect(rep.valueCapture).toBeGreaterThan(1e3);
    expect(rep.valueCapture).toBeLessThan(5e6);
    const g = e.growth!;
    const sums = g.odSums();
    let worst = 0;
    for (let i = 0; i < g.T; i++) {
      if (g.R0[i] >= 100) worst = Math.max(worst, Math.abs(sums.home[i] / g.residents(i) - 1));
      if (g.J0[i] >= 100) worst = Math.max(worst, Math.abs(sums.work[i] / g.jobs(i) - 1));
    }
    expect(worst).toBeLessThan(0.005);
    const c = e.commuters!;
    expect(c.A).toBe(buildGroups(world.od, g.T, 10, 1885, g.factors()).A);
    expectAgentsConsistent(c);
    stepUntil(e, 3 * D + 60);
    const r2 = run.reports[run.reports.length - 1];
    expect(r2.deadlocks).toBe(0);
    expect(c.stuckCount()).toBe(0);
    expect(c.inFlight()).toBe(0);
    expect(r2.riders).toBeGreaterThanOrEqual(0.9 * riders1);
  });

  it('city chaos: fans in flight at the month-end midnight are dropped cleanly, and the next day’s event runs on the regenerated city', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const game = createHeadlessGame(world, loadLandFromDisk(), { chaos: 'normal' });
    buildTestNetwork(game);
    const alerts: Alert[] = [];
    const reports: DayReport[] = [];
    // A growth month closes at every midnight here; a late concert on day 0 (fans heading home at
    // midnight) and one on day 1, right after the close.
    const engine = startEngine(game, { reports, monthEvery: 1, alert: (a) => alerts.push(a) });
    const ev0 = midtownArenaEvent(0, 18_000, 20.5), ev1 = midtownArenaEvent(1, 18_000, 19.5);
    engine.chaos.forceEvents(0, [ev0]);
    engine.chaos.forceEvents(1, [ev1]);
    engine.chaos.forceEvents(2, []);
    engine.chaos.forceWeather(0, CLEAR);
    engine.chaos.forceWeather(1, CLEAR);
    const c = engine.commuters!;
    stepUntil(engine, D - 600);
    const fans0 = c.eventAgentCount();
    expect(fans0).toBeGreaterThan(0);
    expect(c.eventInFlight()).toBeGreaterThan(0);
    stepUntil(engine, D + 60);
    // The close ran at midnight: the pool's agents went with the old indices, today's tallies stayed.
    expect(reports[0].growth).toBeDefined();
    expect(engine.lastRegen!.stuck).toBeGreaterThan(0);
    expect(c.eventAgentCount()).toBe(0);
    expect(c.eventInFlight()).toBe(0);
    expect(c.inFlight()).toBe(0);
    expectAgentsConsistent(c);
    expect(c.eventOutcomes().find((o) => o.id === ev0.id)!.arrived).toBeGreaterThan(0);
    // Day 1's event: fans injected at 3 am into the new pool, riding the regenerated network.
    stepUntil(engine, D + 21 * 3600);
    expect(c.eventAgentCount()).toBeGreaterThan(0);
    expectAgentsConsistent(c);
    stepUntil(engine, 2 * D + 60);
    expect(reports[1].growth).toBeDefined();
    expect(reports[1].deadlocks).toBe(0);
    expect(reports[1].chaos!.eventRiders).toBeGreaterThan(0);
    expect(reports[1].chaos!.events.find((o) => o.id === ev1.id)!.arrived).toBeGreaterThan(0);
    // Day 0's wrap-up (due after midnight) still reports its fans.
    const wrap0 = alerts.find((a) => a.kind === 'event' && a.eventId === ev0.id);
    expect(wrap0?.outcome?.arrived ?? 0).toBeGreaterThan(0);
    // The regenerated pool's arrays stayed consistent through day 1.
    expectAgentsConsistent(c);
  });
});
