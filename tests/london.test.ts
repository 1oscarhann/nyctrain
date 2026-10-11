/**
 * London as a second city: city switching (balance overrides, projection origin, currency),
 * the London data, its zones and goals, and a short headless run on a small London line.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CITY_BALANCE, COMMUTERS, ECONOMY, MAP } from '../src/balance';
import { applyCity, city, cityBalance, inZone, regionCode } from '../src/cities';
import { LONDON } from '../src/cities/london';
import { toLocal, toLonLat } from '../src/core/geo';
import { checkGoals, emptyGoals } from '../src/core/goals';
import { fmtMoney } from '../src/core/units';
import { migrate } from '../src/save/migrate';
import type { WorldTerrain } from '../src/construction/terrain';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, runDays, stationNear } from '../src/sim/headless';

afterAll(() => {
  applyCity('nyc');
});

describe('city switching', () => {
  it('applies London values and restores New York exactly', () => {
    applyCity('nyc');
    const nycFare = 3;
    const nycVot = [10, 20, 40];
    const nycCenter = [...CITY_BALANCE.nyc.map.startCenter];
    expect(ECONOMY.fareDefault).toBe(nycFare);
    applyCity('london');
    expect(city().id).toBe('london');
    expect(ECONOMY.fareDefault).toBe(2.8);
    expect(COMMUTERS.valueOfTime).toEqual([8, 14, 26]);
    expect(fmtMoney(5e9)).toBe('£5.00B');
    // The projection is centred on Charing Cross and round-trips.
    const [x, y] = toLocal(...CITY_BALANCE.london.origin);
    expect(Math.hypot(x, y)).toBeLessThan(1e-6);
    const [lon, lat] = toLonLat(...toLocal(-0.0886, 51.5133));
    expect(lon).toBeCloseTo(-0.0886, 9);
    expect(lat).toBeCloseTo(51.5133, 9);
    // Bank to Charing Cross is about 2.6 km.
    const [bx, by] = toLocal(-0.0886, 51.5133);
    expect(Math.hypot(bx, by)).toBeGreaterThan(2400);
    expect(Math.hypot(bx, by)).toBeLessThan(2900);
    applyCity('nyc');
    expect(ECONOMY.fareDefault).toBe(nycFare);
    expect(COMMUTERS.valueOfTime).toEqual(nycVot);
    expect([...MAP.startCenter]).toEqual(nycCenter);
    expect(fmtMoney(6e9)).toBe('$6.00B');
    expect(Math.hypot(...toLocal(-74.006, 40.7128))).toBeLessThan(1e-6);
  });

  it('migrates saves from before London to New York', () => {
    const save = { format: 'headway-ny', version: 2, meta: { day: 0 }, game: { network: {}, routes: {}, finance: {} }, settings: {}, modeState: null };
    expect(migrate(save).city).toBe('nyc');
    expect(() => migrate({ ...save, city: 'paris' })).toThrow(/Unknown city/);
  });
});

describe('London data', () => {
  applyCity('london');
  const world = loadWorldFromDisk();
  const land = loadLandFromDisk();
  beforeEach(() => {
    applyCity('london');
  });

  it('has every MSOA in a known borough, with chart areas', () => {
    expect(world.tracts.length).toBe(983);
    const names = new Set(LONDON.regions.map((r) => r.name));
    for (const t of world.tracts) {
      expect(names.has(t.borough)).toBe(true);
      expect(t.areaIndex).toBeGreaterThanOrEqual(0);
    }
    expect(LONDON.regions.every((r) => r.area >= 0)).toBe(true);
  });

  it('region codes match the land polygons', () => {
    for (const f of land.features) expect(regionCode(f.properties.borough)).toBe(f.properties.code);
    const raw = JSON.parse(readFileSync('public/data/london/tracts.json', 'utf8')) as { boroughs: { code: number; name: string }[] };
    for (const b of raw.boroughs) expect(regionCode(b.name)).toBe(b.code);
  });

  it('treats the Thames as water and finds the central zone', () => {
    const game = createHeadlessGame(world, land);
    expect(game.terrain.isWater(...toLocal(-0.1196, 51.5055))).toBe(true); // between Westminster and Hungerford bridges
    expect((game.terrain as WorldTerrain).borough(...toLocal(-0.128, 51.508))).toBe(regionCode('Westminster')); // Trafalgar Square
    const cbd = cityBalance().cbd;
    expect(inZone(cbd, -0.0886, 51.5133, 'City of London')).toBe(true); // Bank
    expect(inZone(cbd, -0.128, 51.508, 'Westminster')).toBe(true); // Trafalgar Square
    expect(inZone(cbd, -0.0195, 51.5035, 'Tower Hamlets')).toBe(false); // Canary Wharf
  });

  it('cuts docks and the river above Teddington out of the land, and puts the City at Bank', () => {
    const game = createHeadlessGame(world, land);
    expect(game.terrain.isWater(...toLocal(0.0283, 51.5066))).toBe(true); // Royal Victoria Dock
    expect(game.terrain.isWater(...toLocal(-0.019, 51.4941))).toBe(true); // Millwall Dock
    expect(game.terrain.isWater(...toLocal(-0.3091, 51.4118))).toBe(true); // Thames at Kingston Bridge
    expect(game.terrain.isWater(...toLocal(-0.0195, 51.5049))).toBe(false); // One Canada Square
    // The City's 244k jobs are centred on the City, not on the Barbican's residents.
    const cityTract = world.tracts.find((t) => t.id === 'E02000001')!;
    const [bx, by] = toLocal(-0.0886, 51.5133);
    expect(Math.hypot(cityTract.x - bx, cityTract.y - by)).toBeLessThan(450);
  });

  it('measures Bank to Heathrow door to door from the goal points', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    drawLine(game, [[-0.0886, 51.5133], [-0.1755, 51.5162], [-0.2800, 51.5050], [-0.3800, 51.4880], [-0.4543, 51.4700]], 'deep');
    const stops = [
      stationNear(game, [-0.0886, 51.5133], 'Bank'),
      stationNear(game, [-0.1755, 51.5162], 'Paddington'),
      stationNear(game, [-0.4543, 51.4700], 'Heathrow Central'),
    ];
    expect(game.build(true).ok).toBe(true);
    makeRoute(game, 'Airport Express', 'H', '#9B5DE5', stops, 8, { am: 3, pm: 3 });
    const run = runDays(game, 1);
    const t = run.reports[0].goalTrip;
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(45);
  });

  it('runs a London line across the Thames: riders, no deadlocks, the river goal', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    drawLine(game, [[-0.1131, 51.5031], [-0.1000, 51.5100], [-0.0886, 51.5133], [-0.0823, 51.5180]], 'deep');
    const stops = [
      stationNear(game, [-0.1131, 51.5031], 'Waterloo'),
      stationNear(game, [-0.0975, 51.5120], 'Blackfriars'),
      stationNear(game, [-0.0886, 51.5133], 'Bank'),
      stationNear(game, [-0.0823, 51.5180], 'Liverpool Street'),
    ];
    expect(game.build(true).ok).toBe(true);
    makeRoute(game, 'Waterloo & City', 'W', '#2F7FE0', stops, 8, { am: 3, pm: 3 });
    const goals = emptyGoals();
    expect('cross-thames' in goals && 'heathrow-45' in goals).toBe(true);
    const run = runDays(game, 2);
    const last = run.reports[1];
    expect(last.riders).toBeGreaterThan(1000);
    expect(last.deadlocks).toBe(0);
    expect(Number.isFinite(game.finance.cash)).toBe(true);
    const done = checkGoals(game, goals, last, (x, y) => (game.terrain as WorldTerrain).borough(x, y));
    expect(done).toContain('first-line');
    expect(done).toContain('cross-thames');
    expect(done).not.toContain('all-boroughs');
  });
});
