/**
 * Research and train upgrades: projects cost money and weekdays, unlock in order, run one (or two)
 * at a time; their effects (marks, line speed, signalling, costs) apply on the thread and reset
 * exactly; faster marks run faster; refits; saves.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CHAOS, ECONOMY, OPERATIONS, RESEARCH, RESEARCH_TUNING, STATION, STATION_CROWD, STOCK_IDS, TRACK, TRAIN_MARKS, TRAINS } from '../src/balance';
import { applyCity } from '../src/cities';
import { Game } from '../src/core/game';
import { researchCost, researchDef, researchStatus, sanitizeResearch } from '../src/core/research';
import { applyTech, bestMark, curveFactor, stockName, stockSpec } from '../src/core/tech';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { compileNetwork, routeTimetable } from '../src/routes/compile';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave } from '../src/save/serialize';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, stationNear } from '../src/sim/headless';
import { refitQuote } from '../src/ui/routeOps';

afterAll(() => applyCity('nyc'));

const L = (lat: number, lon: number): [number, number] => [lon, lat];
const stub = (sandbox = false) => new Game({} as World, {} as Terrain, { sandbox });

/** A finished project (weekdays of work at day end). */
function finish(game: Game, id: Parameters<Game['startResearch']>[0]): void {
  expect(game.startResearch(id)).toBeNull();
  for (let d = 0; d < researchDef(id).days; d++) game.advanceResearch();
  expect(researchStatus(game.research, id)).toBe('done');
}

describe('research', () => {
  it('Mk I of every train type is the train as written', () => {
    for (const s of STOCK_IDS) {
      const m = TRAIN_MARKS[s][0];
      expect([m.topSpeed, m.accel, m.brake, m.capacity, m.costMult]).toEqual([TRAINS[s].topSpeed, TRAINS[s].accel, TRAINS[s].brake, 1, 1]);
      for (const k of TRAIN_MARKS[s].slice(1)) expect(RESEARCH.some((r) => r.id === k.research)).toBe(true);
    }
    expect(new Set(RESEARCH.map((r) => r.id)).size).toBe(RESEARCH.length);
    for (const r of RESEARCH) for (const q of r.requires ?? []) expect(RESEARCH.some((x) => x.id === q)).toBe(true);
  });

  it('costs money and weekdays, unlocks in order, one project at a time until a second team', () => {
    applyCity('london');
    const game = stub();
    const cash0 = game.finance.cash;
    expect(researchCost('metro-2')).toBe(Math.round((0.03 * ECONOMY.startingCash) / 1e7) * 1e7);
    expect(game.startResearch('metro-3')).toMatch(/Needs Metro Mk II/);
    expect(game.startResearch('metro-2')).toBeNull();
    expect(game.finance.cash).toBe(cash0 - researchCost('metro-2'));
    expect(game.finance.today.research).toBe(researchCost('metro-2'));
    expect(game.startResearch('gates')).toMatch(/busy/);
    for (let d = 1; d < researchDef('metro-2').days; d++) expect(game.advanceResearch()).toEqual([]);
    expect(game.advanceResearch()).toEqual(['metro-2']);
    expect(bestMark('heavy')).toBe(2);
    finish(game, 'labs-2');
    expect(game.startResearch('gates')).toBeNull();
    expect(game.startResearch('regen')).toBeNull();
    expect(game.startResearch('tbm')).toMatch(/Both design teams are busy/);
    // Stopping one refunds half.
    const before = game.finance.cash;
    expect(game.cancelResearch('regen', RESEARCH_TUNING.cancelRefund)).toBe(researchCost('regen') / 2);
    expect(game.finance.cash).toBe(before + researchCost('regen') / 2);
    expect(researchStatus(game.research, 'regen')).toBe('ready');
  });

  it('Sandbox research is free and instant', () => {
    const game = stub(true);
    expect(game.startResearch('hs-2')).toBeNull();
    expect(researchStatus(game.research, 'hs-2')).toBe('done');
    expect(bestMark('highspeed')).toBe(2);
  });

  it('effects apply to the shared numbers and come off exactly', () => {
    applyCity('london');
    const snap = () => JSON.stringify([TRACK.lineSpeed, TRACK.costPerM, TRACK.daysPerKm, STATION.costByLevel, STATION.buildDays, ECONOMY.operatingPerCarKm, OPERATIONS.safetyMargin, OPERATIONS.headwayChoices, OPERATIONS.dwellBase, OPERATIONS.scheduledDwell, OPERATIONS.dwellPerPassenger, STATION_CROWD.peoplePerMetre, CHAOS.signal.perTrackKmDay, CHAOS.police.perStationDay]);
    const base = snap();
    const deep = TRACK.costPerM.deep, elev = TRACK.costPerM.elevated, op = ECONOMY.operatingPerCarKm;
    applyTech(RESEARCH.map((r) => r.id));
    expect(TRACK.lineSpeed.highspeed * 3.6).toBeCloseTo(360, 6);
    expect(TRACK.lineSpeed.heavy * 3.6).toBeCloseTo(230, 6);
    expect(TRACK.costPerM.deep).toBe(Math.round(deep * 0.8));
    expect(TRACK.costPerM.elevated).toBe(Math.round(elev * 0.8));
    expect(ECONOMY.operatingPerCarKm).toBeCloseTo(op * 0.8 * 0.9 * 0.85, 9);
    expect(OPERATIONS.headwayChoices[0]).toBe(1.5);
    expect(OPERATIONS.safetyMargin).toBeLessThan(100);
    expect(stockSpec('heavy', 3).accel).toBeCloseTo(1.35 * 1.08, 9);
    expect(curveFactor('intercity')).toBeGreaterThan(1);
    expect(curveFactor('heavy')).toBe(1);
    expect(snap()).not.toBe(base);
    applyTech([]);
    expect(snap()).toBe(base);
    // A new city starts clean, and a new game too.
    applyTech(['cbtc', 'regen']);
    applyCity('london');
    expect(snap()).toBe(base);
    applyTech(['cbtc']);
    stub();
    expect(snap()).toBe(base);
  });

  it('new routes get the newest trains; older ones refit; faster marks run faster', () => {
    applyCity('london');
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
    drawLine(game, [L(51.5155, -0.175), L(51.5135, -0.08)], 'deep');
    const ids = [L(51.5152, -0.169), L(51.5145, -0.135), L(51.5138, -0.09)].map((p, i) => stationNear(game, p, `S${i}`, 8));
    expect(game.build(true).ok).toBe(true);
    const old = makeRoute(game, 'Old', 'A', '#DC241F', ids, 8);
    expect(old.mark).toBeUndefined();
    const t1 = routeTimetable(game, old)!.runTimes[0];
    expect(game.startResearch('metro-2')).toBeNull();
    expect(game.startResearch('metro-3')).toBeNull();
    const fresh = makeRoute(game, 'New', 'B', '#0098D4', ids, 8);
    expect(fresh.mark).toBe(3);
    expect(stockName(fresh.stock, fresh.mark)).toBe('Metro Mk III');
    const t3 = routeTimetable(game, fresh)!.runTimes[0];
    expect(t3).toBeLessThan(t1 - 15);
    // The old route refits for a share of the new cars' price.
    const q = refitQuote(old)!;
    expect(q.mark).toBe(3);
    expect(q.cost).toBe(Math.round(old.ownedCars * stockSpec('heavy', 3).costPerCar * RESEARCH_TUNING.refitShare));
    // The compiled network carries the research list (the worker applies it) and the marks.
    const c = compileNetwork(game).net;
    expect(c.research).toEqual(['metro-2', 'metro-3']);
    expect(c.routes.find((r) => r.id === fresh.id)!.vmax * 3.6).toBeCloseTo(130, 6);
    expect(c.routes.find((r) => r.id === old.id)!.vmax * 3.6).toBeCloseTo(90, 6);
  });

  it('saves and loads research in progress, finished research and route marks', () => {
    applyCity('london');
    const game = stub();
    finish(game, 'metro-2');
    expect(game.startResearch('cbtc')).toBeNull();
    game.advanceResearch();
    const save = JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1 }, modeState: null })));
    applyTech([]);
    const back = stub();
    applySave(back, migrate(save));
    expect(back.research.done).toEqual(['metro-2']);
    expect(back.research.active).toEqual([{ id: 'cbtc', daysLeft: researchDef('cbtc').days - 1, paid: researchCost('cbtc') }]);
    expect(bestMark('heavy')).toBe(2);
    // Older saves have none; nonsense is dropped.
    expect(sanitizeResearch(undefined)).toEqual({ done: [], active: [] });
    expect(sanitizeResearch({ done: ['metro-2', 'warp-drive', 'metro-2'], active: [{ id: 'metro-2', daysLeft: 3 }, { id: 'ato', daysLeft: -4, paid: 'x' }] })).toEqual({ done: ['metro-2'], active: [{ id: 'ato', daysLeft: 1, paid: 0 }] });
  });
});
