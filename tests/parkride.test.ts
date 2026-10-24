/**
 * Park & ride and the school run, headless: car parks bring drivers to the trains (and fill up),
 * pupils ride to real schools on school days only, at child fares.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PARK_RIDE, SCHOOLS } from '../src/balance';
import { applyCity } from '../src/cities';
import { placeHubs } from '../src/core/hubs';
import { isSchoolDay } from '../src/core/schoolTerm';
import { dateOfDay } from '../src/core/calendar';
import { loadLandFromDisk, loadSchoolsFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, nodeSnapNear, runDays, stationNear } from '../src/sim/headless';
import type { Game } from '../src/core/game';

afterAll(() => {
  applyCity('nyc');
});

type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];
const HUB_END = L(51.4905, -0.1466);
const LINE: LL[] = [HUB_END, L(51.4868, -0.1484), L(51.48, -0.15), L(51.4643, -0.1704), L(51.3755, -0.0925), L(51.1565, -0.161), L(51.0053, -0.1053), L(50.829, -0.141)];
const LEVELS = ['elevated', 'elevated', 'elevated', 'at-grade', 'at-grade', 'at-grade', 'at-grade', 'at-grade'] as const;

function brighton(): { game: Game; stops: number[] } {
  applyCity('southeast');
  const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
  placeHubs(game);
  drawLine(game, LINE, [...LEVELS], 'heavy', nodeSnapNear(game, HUB_END));
  const vic = [...game.network.stations.values()].find((s) => s.name === 'Victoria')!.id;
  const stops = [vic, ...[L(51.4643, -0.1704), L(51.3755, -0.0925), L(51.1565, -0.161), L(51.0053, -0.1053), L(50.829, -0.141)].map((p, i) => stationNear(game, p, `S${i}`, 14))];
  expect(game.build(true).ok).toBe(true);
  const r = makeRoute(game, 'Brighton', 'BM', '#DC241F', stops, 8, { am: 5, pm: 5, midday: 15, evening: 20, night: 0 });
  game.routes.update(r.id, { stock: 'commuter' });
  return { game, stops };
}

describe('park & ride', () => {
  it('car parks at outer stations bring in drivers, and a small one fills up', () => {
    const base = brighton();
    const before = runDays(base.game, 4, { agentScale: 50 }).reports.at(-1)!;
    expect(before.parking).toBeUndefined();

    const pr = brighton();
    // A big car park at Gatwick and Haywards Heath, a tiny one at Croydon.
    const [, , croydon, gatwick, haywards] = pr.stops;
    expect(pr.game.addParking(gatwick, 2000).ok).toBe(true);
    expect(pr.game.addParking(haywards, 2000).ok).toBe(true);
    expect(pr.game.addParking(croydon, 250).ok).toBe(true);
    expect(pr.game.network.stations.get(gatwick)!.parking).toBe(2000);
    expect(pr.game.addParking(gatwick, PARK_RIDE.maxSpaces).ok).toBe(true); // tops up to the maximum
    expect(pr.game.network.stations.get(gatwick)!.parking).toBe(PARK_RIDE.maxSpaces);
    expect(pr.game.addParking(gatwick, 250).ok).toBe(false);
    const after = runDays(pr.game, 4, { agentScale: 50 }).reports.at(-1)!;
    expect(after.parking).toBeDefined();
    const g = after.parking![gatwick], h = after.parking![haywards], c = after.parking![croydon];
    if (process.env.PRINT) console.log('P&R', JSON.stringify({ before: before.riders, after: after.riders, g, h, c, shareBefore: before.transitShare, shareAfter: after.transitShare }));
    expect(g.used + h.used).toBeGreaterThan(500);
    // Croydon's 250 spaces fill and turn drivers away.
    expect(c.used).toBeLessThanOrEqual(250 + 50);
    expect(c.full).toBeGreaterThan(0);
    // More people on the train than without car parks.
    expect(after.riders).toBeGreaterThan(before.riders);
  }, 180_000);
});

describe('the school run', () => {
  it('has school days in term time only', () => {
    applyCity('london');
    const dayOf = (y: number, m: number, d: number) => {
      for (let day = 0; day < 4000; day++) {
        const t = dateOfDay(day);
        if (t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() >= d) return day;
      }
      return -1;
    };
    expect(isSchoolDay(dayOf(2030, 0, 14))).toBe(true); // mid-January
    expect(isSchoolDay(dayOf(2030, 7, 12))).toBe(false); // August
    expect(isSchoolDay(dayOf(2030, 11, 23))).toBe(false); // Christmas
    applyCity('nyc');
    expect(isSchoolDay(dayOf(2030, 6, 15))).toBe(false); // July
    expect(isSchoolDay(dayOf(2030, 9, 15))).toBe(true); // October
    expect(SCHOOLS.childFare).toBe(0); // free student cards
    applyCity('london');
    expect(SCHOOLS.childFare).toBe(0.5);
  });

  it('pupils ride a London line to their schools on a school day, at child fares', () => {
    applyCity('london');
    const world = loadWorldFromDisk();
    const make = () => {
      const game = createHeadlessGame(world, loadLandFromDisk(), { sandbox: true });
      // East–west through dense north London (Hammersmith to Stratford), stations every ~1.5 km.
      drawLine(game, [L(51.4927, -0.224), L(51.515, -0.142), L(51.524, -0.07), L(51.5416, -0.0034)], 'deep');
      const pts = [L(51.4927, -0.224), L(51.502, -0.19), L(51.51, -0.165), L(51.515, -0.142), L(51.518, -0.112), L(51.522, -0.085), L(51.524, -0.07), L(51.53, -0.045), L(51.5416, -0.0034)];
      const stops = pts.map((p, i) => stationNear(game, p, `P${i}`, 8));
      expect(game.build(true).ok).toBe(true);
      makeRoute(game, 'East–West', 'EW', '#DC241F', stops, 8, { am: 3, pm: 3, midday: 6, evening: 8, night: 0 });
      return game;
    };
    const schools = loadSchoolsFromDisk();
    const withSchools = runDays(make(), 3, { agentScale: 20, schools }).reports;
    const without = runDays(make(), 3, { agentScale: 20 }).reports;
    const last = withSchools.at(-1)!;
    expect(last.schools).toBeDefined();
    const s = last.schools!;
    if (process.env.PRINT) console.log('SCHOOL', JSON.stringify({ ...s, perSchool: Object.keys(s.perSchool).length, riders: last.riders, ridersNo: without.at(-1)!.riders, fare: last.fareRevenue, fareNo: without.at(-1)!.fareRevenue, trips: last.fareTrips, tripsNo: without.at(-1)!.fareTrips }));
    expect(s.pupils).toBeGreaterThan(300_000);
    expect(s.byTransit).toBeGreaterThan(1000);
    expect(s.byWalk + s.byLift + s.byTransit).toBeCloseTo(s.pupils, -2);
    const rode = Object.values(s.perSchool).reduce((a, b) => a + b, 0);
    expect(rode).toBeGreaterThan(500);
    // Pupils add riders, and their fares are half the adult fare.
    expect(last.riders).toBeGreaterThan(without.at(-1)!.riders);
    expect(without.at(-1)!.schools).toBeUndefined();
  }, 180_000);
});
