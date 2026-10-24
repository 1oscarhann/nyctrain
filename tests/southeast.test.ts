/**
 * The South East intertown map and train types: the regional data, the Victoria hub, distance
 * fares, long-distance driving, train types on one line and high-speed line joining ordinary track.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { COMMUTERS, ECONOMY, MAP, TRACK, TRAINS } from '../src/balance';
import { applyCity, city, regionCode } from '../src/cities';
import { placeHubs } from '../src/core/hubs';
import { distanceFareMult } from '../src/economy/fares';
import { driveTripTime } from '../src/sim/modeChoice';
import { routeTimetable } from '../src/routes/compile';
import { carsFitting, maxCarsFor, validStock } from '../src/routes/routeSet';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, nodeSnapNear, runDays, stationNear } from '../src/sim/headless';
import type { Game } from '../src/core/game';

afterAll(() => {
  applyCity('nyc');
});

type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];
const HUB_END = L(51.4905, -0.1466);
const BRIGHTON_LINE: LL[] = [HUB_END, L(51.4868, -0.1484), L(51.48, -0.15), L(51.4643, -0.1704), L(51.3755, -0.0925), L(51.1565, -0.161), L(51.0053, -0.1053), L(50.829, -0.141)];
const LEVELS = ['elevated', 'elevated', 'elevated', 'at-grade', 'at-grade', 'at-grade', 'at-grade', 'at-grade'] as const;
const STOPS: [string, LL][] = [
  ['Clapham Junction', L(51.4643, -0.1704)],
  ['East Croydon', L(51.3755, -0.0925)],
  ['Gatwick', L(51.1565, -0.161)],
  ['Haywards Heath', L(51.0053, -0.1053)],
  ['Brighton', L(50.829, -0.141)],
];

function seGame(): Game {
  applyCity('southeast');
  const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
  placeHubs(game);
  return game;
}

function brightonLine(game: Game): number[] {
  drawLine(game, BRIGHTON_LINE, [...LEVELS], 'heavy', nodeSnapNear(game, HUB_END));
  const vic = [...game.network.stations.values()].find((s) => s.name === 'Victoria')!;
  const ids = [vic.id, ...STOPS.map(([n, p]) => stationNear(game, p, n, 14))];
  expect(game.build(true).ok).toBe(true);
  return ids;
}

describe('South East data and city', () => {
  it('loads London and the South East: 100 districts, 2,091 zones, ~6.35M commuters', () => {
    applyCity('southeast');
    expect(city().intertown).toBe(true);
    const w = loadWorldFromDisk();
    expect(w.tracts.length).toBe(2091);
    const commuters = w.tracts.reduce((s, t) => s + t.residents, 0);
    expect(commuters).toBeGreaterThan(6.2e6);
    expect(commuters).toBeLessThan(6.5e6);
    expect(city().regions.length).toBe(100);
    expect(regionCode('Westminster')).toBe(33);
    expect(regionCode('Arun')).toBeGreaterThan(33);
    expect(MAP.landCell).toBe(60);
    expect(MAP.minZoom).toBeLessThan(8);
  });

  it('starts every game with a built, free Victoria terminal on a stub of main line', () => {
    const game = seGame();
    const st = [...game.network.stations.values()];
    expect(st.length).toBe(1);
    expect(st[0].name).toBe('Victoria');
    expect(st[0].status).toBe('built');
    expect(st[0].cost).toBe(0);
    for (const e of game.network.edges.values()) {
      expect(e.status).toBe('built');
      expect(e.cls).toBe('heavy');
    }
  });

  it('prices by distance in the South East and not in the metro cities', () => {
    applyCity('nyc');
    expect(distanceFareMult(80_000)).toBe(1);
    applyCity('london');
    expect(distanceFareMult(30_000)).toBe(1);
    applyCity('southeast');
    expect(distanceFareMult(2_000)).toBe(1);
    // Victoria to Brighton, ~75 km: (75 − 3) / 20 + 1 = 4.6 fares.
    expect(distanceFareMult(75_000)).toBeCloseTo(4.6, 5);
    expect(ECONOMY.fareDistanceKm).toBe(20);
  });

  it('drives long trips on fast roads (South East only)', () => {
    const g = { distance: 75_000, homeCore: true, workCore: true, workCbd: true, homeCbd: false };
    applyCity('london');
    expect(COMMUTERS.driveLongAfter).toBe(Infinity);
    const london = driveTripTime(g);
    applyCity('southeast');
    const se = driveTripTime(g);
    // Brighton to Westminster: about two hours door to door, not the six at city street speed.
    expect(se / 3600).toBeGreaterThan(1.6);
    expect(se / 3600).toBeLessThan(2.6);
    expect(london / 3600).toBeGreaterThan(5);
  });
});

describe('train types', () => {
  it('keeps old routes on metro trains and only allows a family its own trains', () => {
    expect(validStock(undefined, 'heavy')).toBe('heavy');
    expect(validStock(undefined, 'light')).toBe('light');
    expect(validStock('commuter', 'heavy')).toBe('commuter');
    expect(validStock('commuter', 'light')).toBe('light');
    expect(validStock('nonsense', 'heavy')).toBe('heavy');
    // Metro trains are slower than heavy track's line speed, so metro play is unchanged.
    expect(TRAINS.heavy.topSpeed).toBeLessThan(TRACK.lineSpeed.heavy);
    expect(TRAINS.light.topSpeed).toBeLessThanOrEqual(TRACK.lineSpeed.light);
  });

  it('runs commuter trains faster than metro trains on the Brighton main line, with riders', () => {
    const game = seGame();
    const stops = brightonLine(game);
    const r = makeRoute(game, 'Brighton', 'BM', '#DC241F', stops, 8, { am: 6, pm: 6, midday: 15, evening: 20, night: 0 });
    expect(r.stock).toBe('heavy');
    const metro = routeTimetable(game, r)!.runTimes[0];
    game.routes.update(r.id, { stock: 'commuter' });
    expect(game.routes.get(r.id)!.stock).toBe('commuter');
    const commuter = routeTimetable(game, game.routes.get(r.id)!)!.runTimes[0];
    game.routes.update(r.id, { stock: 'intercity' });
    const intercity = routeTimetable(game, game.routes.get(r.id)!)!.runTimes[0];
    expect(metro / 60).toBeGreaterThan(45);
    expect(commuter).toBeLessThan(metro * 0.75);
    expect(intercity).toBeLessThan(commuter);
    // 14-car heavy platforms (262 m) take 12 commuter cars (20 m) or 10 intercity cars (24 m).
    const vic = game.network.stations.get(stops[0])!;
    expect(carsFitting(game.network, vic, 'commuter')).toBe(12);
    expect(carsFitting(game.network, vic, 'intercity')).toBe(10);
    expect(carsFitting(game.network, vic, 'heavy')).toBe(14);
    expect(maxCarsFor(game.network, game.routes.get(r.id)!)).toBe(10);
    game.routes.update(r.id, { stock: 'commuter' });
    const run = runDays(game, 3, { agentScale: 50 });
    expect(run.reports[run.reports.length - 1].riders).toBeGreaterThan(20_000);
  }, 120_000);

  it('builds high-speed line off ordinary track and runs high-speed trains much faster on it', () => {
    const game = seGame();
    // Heavy track out of Victoria to Croydon, then high-speed line from there to Brighton.
    drawLine(game, BRIGHTON_LINE.slice(0, 5), [...LEVELS.slice(0, 5)], 'heavy', nodeSnapNear(game, HUB_END));
    const croydonEnd = BRIGHTON_LINE[4];
    expect(game.network.canAttachAtNode(nodeSnapNear(game, croydonEnd).kind === 'node' ? (nodeSnapNear(game, croydonEnd) as { node: number }).node : -1, 'highspeed').ok).toBe(true);
    const hs = drawLine(game, [croydonEnd, L(51.15, -0.13), L(50.84, -0.135)], 'at-grade', 'highspeed', nodeSnapNear(game, croydonEnd));
    expect(hs.length).toBeGreaterThan(0);
    for (const id of hs) expect(game.network.edges.get(id)!.cls).toBe('highspeed');
    const vic = [...game.network.stations.values()].find((s) => s.name === 'Victoria')!.id;
    const brighton = stationNear(game, L(50.84, -0.135), 'Brighton', 12);
    const built = game.build(true);
    expect(built.ok).toBe(true);
    const r = makeRoute(game, 'Brighton HS', 'HS', '#9B0056', [vic, brighton], 8, { am: 10, pm: 10, midday: 20, evening: 30, night: 0 });
    game.routes.update(r.id, { stock: 'commuter' });
    const commuter = routeTimetable(game, game.routes.get(r.id)!)!.runTimes[0];
    game.routes.update(r.id, { stock: 'highspeed' });
    expect(game.routes.operational(game.network, game.routes.get(r.id)!).ok).toBe(true);
    const fast = routeTimetable(game, game.routes.get(r.id)!)!.runTimes[0];
    expect(fast).toBeLessThan(commuter * 0.8);
    // Victoria's heavy platform takes 9 high-speed cars (26 m); the high-speed platform 12.
    expect(maxCarsFor(game.network, game.routes.get(r.id)!)).toBe(9);
  }, 120_000);
});
