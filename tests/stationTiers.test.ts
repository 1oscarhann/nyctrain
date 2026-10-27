/**
 * Station upgrades: a busy line's stations overcrowd, upgrading them raises their capacity, cuts
 * the crush and brings more riders; works cost money and take days outside Sandbox.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { STATION_TIERS } from '../src/balance';
import { applyCity } from '../src/cities';
import { compileNetwork } from '../src/routes/compile';
import { baseCapacity, MAX_TIER, stationCapacity, tierCost } from '../src/construction/stationTiers';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, runDays, stationNear } from '../src/sim/headless';

afterAll(() => applyCity('nyc'));

type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];

function line(sandbox: boolean) {
  applyCity('london');
  const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox });
  if (!sandbox) game.finance.cash = 1e11;
  drawLine(game, [L(51.4927, -0.224), L(51.515, -0.142), L(51.524, -0.07), L(51.5416, -0.0034)], 'deep');
  const pts = [L(51.4927, -0.224), L(51.502, -0.19), L(51.51, -0.165), L(51.515, -0.142), L(51.518, -0.112), L(51.522, -0.085), L(51.524, -0.07), L(51.53, -0.045), L(51.5416, -0.0034)];
  // Short 4-car platforms: they fill up.
  const stops = pts.map((p, i) => stationNear(game, p, `P${i}`, 4));
  expect(game.build(true).ok).toBe(true);
  makeRoute(game, 'East–West', 'EW', '#DC241F', stops, 4, { am: 2, pm: 2, midday: 4, evening: 6, night: 0 });
  return { game, stops };
}

describe('station upgrades', () => {
  it('capacity grows by tier and reaches the compiled network', () => {
    const { game, stops } = line(true);
    const s = game.network.stations.get(stops[3])!;
    const base = baseCapacity(game.network, s);
    expect(stationCapacity(game.network, s)).toBe(Math.round(base));
    for (let t = 1; t <= MAX_TIER; t++) expect(game.upgradeStation(s.id).ok).toBe(true);
    expect(game.upgradeStation(s.id).ok).toBe(false); // top level
    expect(s.tier).toBe(MAX_TIER);
    const c = compileNetwork(game).net.stations.find((x) => x.id === s.id)!;
    expect(c.tier).toBe(MAX_TIER);
    expect(c.capacity).toBe(Math.round(base * STATION_TIERS[MAX_TIER].capacity));
  });

  it('works cost money and take days outside Sandbox, holding less meanwhile', () => {
    const { game, stops } = line(false);
    const s = game.network.stations.get(stops[4])!;
    game.finance.cash = 5e9;
    const cash = game.finance.cash;
    const cost = tierCost(game.network, s, 1);
    expect(cost).toBeGreaterThan(0);
    const up = game.upgradeStation(s.id);
    expect(up.reason ?? 'ok').toBe('ok');
    expect(game.finance.cash).toBeCloseTo(cash - cost, 0);
    expect(s.tier ?? 0).toBe(0);
    expect(s.tierTo).toBe(1);
    expect(game.upgradeStation(s.id).ok).toBe(false); // already under way
    expect(stationCapacity(game.network, s)).toBeLessThan(baseCapacity(game.network, s));
    game.setTime(s.tierEnd! + 1);
    expect(s.tier).toBe(1);
    expect(s.tierTo).toBeUndefined();
    expect(stationCapacity(game.network, s)).toBe(Math.round(baseCapacity(game.network, s) * STATION_TIERS[1].capacity));
  });

  it('overcrowded stations turn people away; upgrading them brings riders back', () => {
    const before = line(true);
    const r0 = runDays(before.game, 4, { agentScale: 20 }).reports.at(-1)!;
    const after = line(true);
    for (const id of after.stops) for (let t = 0; t < MAX_TIER; t++) after.game.upgradeStation(id);
    const r1 = runDays(after.game, 4, { agentScale: 20 }).reports.at(-1)!;
    const peak = (r: typeof r0) => Math.max(0, ...Object.values(r.stationPeak ?? {}));
    const turned = (r: typeof r0) => Object.values(r.stationTurnedAway ?? {}).reduce((a, b) => a + b, 0);
    if (process.env.PRINT) console.log('TIERS', JSON.stringify({ peak0: peak(r0), peak1: peak(r1), riders0: r0.riders, riders1: r1.riders, turned0: turned(r0), turned1: turned(r1), share0: r0.transitShare, share1: r1.transitShare }));
    // Basic 4-car stations overcrowd until they shut their gates and turn people away.
    expect(peak(r0)).toBeGreaterThan(1.5);
    expect(turned(r0)).toBeGreaterThan(5000);
    // Upgraded, nobody is turned away and the line carries clearly more.
    expect(turned(r1)).toBe(0);
    expect(r1.riders).toBeGreaterThan(r0.riders * 1.08);
  }, 240_000);
});
