/**
 * Japan, the high-speed map: the survey data on 1,657 municipalities, the Lambert projection, the
 * relief grid that makes mountains dear, high-speed-only building, yen, the airports, a Tokaido
 * line that carries people, and earthquakes that stop the trains near them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAOS, ECONOMY, TRACK, type TrackLevel } from '../src/balance';
import { applyCity, availableStocks, city, cityResearch, regionCode, trackClasses } from '../src/cities';
import { AIRPORTS } from '../src/cities/destinations';
import { placeAirportStations, placeHubs } from '../src/core/hubs';
import { toLocal, toLonLat } from '../src/core/geo';
import { fmtFare, fmtMoney, setUnits } from '../src/core/units';
import { LandMask } from '../src/data/landMask';
import { edgeReport } from '../src/construction/validate';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, makeRoute, runDays, startEngine, stationLine, stepUntil } from '../src/sim/headless';
import { planQuake } from '../src/sim/chaos';
import type { World, LandCollection } from '../src/data/world';

type LL = [number, number];

let world: World;
let land: LandCollection;
let mask: LandMask;

beforeAll(() => {
  applyCity('japan');
  setUnits('metric');
  world = loadWorldFromDisk();
  land = loadLandFromDisk();
  mask = new LandMask(land, 500, true);
});
afterAll(() => applyCity('nyc'));

const haversine = (a: LL, b: LL) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};

describe('Japan: data', () => {
  it('has every municipality of the main islands, with the survey journeys spread over them', () => {
    expect(world.tracts.length).toBeGreaterThan(1600);
    expect(world.tracts.length).toBeLessThan(1700);
    const pop = world.tracts.reduce((a, t) => a + (t.pop ?? 0), 0);
    expect(pop).toBeGreaterThan(123e6);
    expect(pop).toBeLessThan(125e6);
    const journeys = world.tracts.reduce((a, t) => a + t.residents, 0);
    expect(journeys).toBeGreaterThan(1.8e6);
    expect(journeys).toBeLessThan(2.4e6);
    expect(world.tracts.reduce((a, t) => a + t.jobs, 0)).toBeCloseTo(journeys, -2);
    // Bands are trip purposes.
    expect(world.meta.bands[2]).toBe('Business');
    // Big places by name, in their prefecture.
    const by = (n: string) => world.tracts.find((t) => t.name === n);
    expect(by('Sapporo')?.borough).toBe('Hokkaido');
    expect(by('Chiyoda')?.borough).toBe('Tokyo');
    expect(by('Osaka')?.borough).toBe('Osaka');
    expect(by('Fukuoka')?.borough).toBe('Fukuoka');
    expect(by('Koriyama')?.borough).toBe('Fukushima');
    // A name in two prefectures: the bigger keeps it.
    expect(by('Fuchu')?.borough).toBe('Tokyo');
    expect(by('Fuchu (Hiroshima)')?.borough).toBe('Hiroshima');
    for (const t of world.tracts) {
      expect(regionCode(t.borough)).toBeGreaterThan(0);
      expect(t.radius).toBeGreaterThan(300);
    }
  });

  it('puts municipalities on land in their own prefecture, and closes the gaps between prefectures', () => {
    let wrong = 0, sea = 0;
    for (const t of world.tracts) {
      const c = mask.codeAt(t.x, t.y);
      if (c === 0) sea++;
      else if (c !== regionCode(t.borough)) wrong++;
    }
    // Population centroids of coastal and island towns can sit just off a 500 m mask.
    expect(sea / world.tracts.length).toBeLessThan(0.02);
    expect(wrong / world.tracts.length).toBeLessThan(0.02);
    let holes = 0;
    for (let r = 1; r < mask.h - 1; r++)
      for (let c = 1; c < mask.w - 1; c++) {
        const i = r * mask.w + c;
        if (!mask.data[i] && mask.data[i - 1] && mask.data[i + 1] && mask.data[i - mask.w] && mask.data[i + mask.w]) holes++;
      }
    expect(holes).toBe(0);
  });

  it('uses a Lambert projection: distances within 1% from Kyushu to Hokkaido', () => {
    const pts: LL[] = [[130.42, 33.59], [135.5, 34.73], [139.767, 35.681], [141.35, 43.068], [144.38, 42.99], [130.54, 31.58]];
    for (const a of pts)
      for (const b of pts) {
        if (a === b) continue;
        const [ax, ay] = toLocal(a[0], a[1]), [bx, by] = toLocal(b[0], b[1]);
        expect(Math.abs(Math.hypot(bx - ax, by - ay) / haversine(a, b) - 1)).toBeLessThan(0.01);
      }
    const [x, y] = toLocal(141.35, 43.068);
    const [lon, lat] = toLonLat(x, y);
    expect(lon).toBeCloseTo(141.35, 6);
    expect(lat).toBeCloseTo(43.068, 6);
  });

  it('knows where the mountains are', () => {
    const r = world.relief!;
    expect(r).toBeTruthy();
    // The Northern Alps are steep and high; the Kanto plain and the Nobi plain are flat.
    expect(r.slopeAt(137.65, 36.35)).toBeGreaterThan(20);
    expect(r.elevationAt(137.65, 36.35)).toBeGreaterThan(1500);
    expect(r.slopeAt(139.6, 35.9)).toBeLessThan(3);
    expect(r.slopeAt(136.75, 35.3)).toBeLessThan(3);
    expect(r.slopeAt(138.0, 33.0)).toBe(0); // the Pacific
  });
});

describe('Japan: rules', () => {
  it('builds high-speed line and runs Shinkansen only, in yen', () => {
    expect(trackClasses()).toEqual(['highspeed']);
    expect(availableStocks('heavy')).toEqual(['highspeed']);
    expect(city().defaultLevel).toBe('elevated');
    expect(fmtMoney(ECONOMY.startingCash)).toBe('¥5.00T');
    expect(fmtFare(147.5)).toBe('¥14,750');
    expect(fmtMoney(4.5e6)).toBe('¥450M');
    const ids = cityResearch().map((r) => r.id);
    expect(ids).toContain('eew');
    expect(ids).toContain('hs-3');
    expect(ids).not.toContain('metro-2');
    applyCity('london');
    expect(cityResearch().map((r) => r.id)).not.toContain('eew');
    applyCity('japan');
  });

  it('starts with a 16-car terminal at Tokyo and a high-speed station at every airport', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    placeHubs(game);
    placeAirportStations(game);
    const st = [...game.network.stations.values()];
    expect(st.length).toBe(1 + AIRPORTS.japan.length);
    for (const s of st) {
      const e = game.network.edges.get(s.edge)!;
      expect(e.cls).toBe('highspeed');
      expect(s.cars).toBe(16);
      const p = game.network.stationPos(s);
      expect(game.terrain.isWater(p.x, p.y), s.name).toBe(false);
    }
  });

  it('prices mountains: surface track through the Alps costs several times a tunnel premium', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    const cost = (level: TrackLevel, a: LL, b: LL) => {
      const [ax, ay] = toLocal(a[0], a[1]), [bx, by] = toLocal(b[0], b[1]);
      const ids = game.editBlueprint(() => game.network.addStroke([{ x: ax, y: ay, level }, { x: bx, y: by, level }], 'highspeed', { kind: 'none' }, { kind: 'none' }));
      const r = edgeReport(game.network, ids[0], game.terrain);
      return { perKm: r.cost / (r.length / 1000), mountains: r.mountainMult };
    };
    // Through the Hida mountains vs across the open Kanto plain.
    const alps = { a: [137.35, 36.2] as LL, b: [137.95, 36.25] as LL };
    const plain = { a: [139.35, 36.1] as LL, b: [139.95, 36.15] as LL };
    const surfaceAlps = cost('at-grade', alps.a, alps.b);
    const tunnelAlps = cost('deep', [alps.a[0], alps.a[1] - 0.05], [alps.b[0], alps.b[1] - 0.05]);
    const surfacePlain = cost('at-grade', plain.a, plain.b);
    expect(surfaceAlps.mountains).toBeGreaterThan(3);
    expect(surfacePlain.mountains).toBeLessThan(1.2);
    expect(surfaceAlps.perKm).toBeGreaterThan(tunnelAlps.perKm);
    expect(surfacePlain.perKm).toBeLessThan(surfaceAlps.perKm / 3);
    expect(TRACK.mountainK.deep).toBeLessThan(TRACK.mountainK['at-grade']);
  });
});

describe('Japan: a Tokaido line', () => {
  const S: [string, LL, TrackLevel][] = [
    ['Tokyo', [139.767, 35.681], 'elevated'],
    ['Shinagawa', [139.74, 35.628], 'elevated'],
    ['', [139.69, 35.565], 'deep'],
    ['Shin-Yokohama', [139.617, 35.507], 'elevated'],
    ['', [139.4, 35.37], 'elevated'],
    ['Odawara', [139.155, 35.256], 'elevated'],
    ['', [139.1, 35.17], 'deep'],
    ['Atami', [139.078, 35.104], 'deep'],
    ['', [139.0, 35.11], 'deep'],
    ['Mishima', [138.911, 35.127], 'elevated'],
    ['', [138.62, 35.13], 'elevated'],
    ['Shizuoka', [138.389, 34.972], 'elevated'],
    ['', [138.05, 34.83], 'deep'],
    ['Hamamatsu', [137.734, 34.704], 'elevated'],
    ['Toyohashi', [137.382, 34.763], 'elevated'],
    ['', [137.1, 34.98], 'elevated'],
    ['Nagoya', [136.882, 35.171], 'elevated'],
    ['Gifu-Hashima', [136.693, 35.316], 'elevated'],
    ['', [136.45, 35.36], 'deep'],
    ['Maibara', [136.29, 35.315], 'elevated'],
    ['', [136.0, 35.1], 'elevated'],
    ['Kyoto', [135.758, 34.986], 'elevated'],
    ['Shin-Osaka', [135.5, 34.733], 'elevated'],
  ];

  it('costs trillions of yen, opens, and carries long-distance travellers', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    const st = stationLine(game, S.map(([name, at, level]) => ({ name: name || undefined, at, level })), 'highspeed', 16);
    let cost = 0, len = 0;
    for (const id of game.network.edges.keys()) {
      const r = edgeReport(game.network, id, game.terrain);
      expect(r.ok, r.errors.join('; ')).toBe(true);
      cost += r.cost;
      len += r.length;
    }
    expect(len / 1000).toBeGreaterThan(450);
    expect(len / 1000).toBeLessThan(520);
    // ¥3–6 trillion for the track (money is in hundreds of yen).
    expect(cost).toBeGreaterThan(30e9);
    expect(cost).toBeLessThan(60e9);
    game.build(true);
    const names = S.filter((s) => s[0]).map((s) => s[0]);
    const fast = ['Tokyo', 'Shinagawa', 'Shin-Yokohama', 'Nagoya', 'Kyoto', 'Shin-Osaka'].map((n) => st[names.indexOf(n)]);
    makeRoute(game, 'All stations', 'K', '#2F7FE0', st, 16, { night: 0, am: 30, midday: 30, pm: 30, evening: 30 }, 'highspeed');
    makeRoute(game, 'Fast', 'N', '#E8452C', fast, 16, { night: 0, am: 10, midday: 15, pm: 10, evening: 20 }, 'highspeed');
    for (const r of game.routes.list()) expect(r.stock).toBe('highspeed');
    const run = runDays(game, 3, { agentScale: 20 });
    const last = run.reports[run.reports.length - 1];
    expect(last.riders).toBeGreaterThan(150_000);
    // Distance fares: the average journey pays thousands of yen.
    expect(last.fareRevenue / last.riders).toBeGreaterThan(50);
    expect(last.fareRevenue / last.riders).toBeLessThan(200);
    // Fares beat running costs on a busy trunk.
    const day = game.finance.history[game.finance.history.length - 1];
    expect(day.revenue).toBeGreaterThan(day.operating + day.staffing);
  }, 120_000);
});

describe('Japan: earthquakes', () => {
  it('plans about eight a year at Normal, none when chaos is off', () => {
    let n = 0;
    for (let d = 0; d < 261 * 4; d++) if (planQuake(77, d, 'normal', -Infinity)) n++;
    expect(n / 4).toBeGreaterThan(4);
    expect(n / 4).toBeLessThan(13);
    for (let d = 0; d < 300; d++) expect(planQuake(77, d, 'off', -Infinity)).toBeNull();
  });

  it('stops the trains near the epicentre, then clears', () => {
    const game = createHeadlessGame(world, land, { sandbox: true, chaos: 'normal' });
    const st = stationLine(
      game,
      [
        { name: 'Tokyo', at: [139.767, 35.681], level: 'elevated' },
        { name: 'Omiya', at: [139.624, 35.906], level: 'elevated' },
        { name: 'Utsunomiya', at: [139.896, 36.559], level: 'elevated' },
      ],
      'highspeed',
      16,
    );
    game.build(true);
    makeRoute(game, 'North', 'T', '#3FB68B', st, 16, { night: 0, am: 10, midday: 10, pm: 10, evening: 10 }, 'highspeed');
    const alerts: { kind: string; status: string }[] = [];
    const engine = startEngine(game, { agentScale: 50, alert: (a) => alerts.push(a) });
    stepUntil(engine, 9 * 3600);
    const fast = Math.max(...engine.trains.trains.map((t) => t.v));
    expect(fast).toBeGreaterThan(CHAOS.quake.crawl + 5);
    const id = engine.chaos.forceQuake(139.75, 36.0, 120_000, 30 * 60);
    expect(id).toBeGreaterThan(0);
    stepUntil(engine, engine.time + 10 * 60);
    // Every train is crawling or stopped.
    expect(Math.max(...engine.trains.trains.map((t) => t.v))).toBeLessThanOrEqual(CHAOS.quake.crawl + 0.5);
    stepUntil(engine, engine.time + 40 * 60);
    expect(alerts.some((a) => a.kind === 'quake' && a.status === 'active')).toBe(true);
    expect(alerts.some((a) => a.kind === 'quake' && a.status === 'cleared')).toBe(true);
    expect(engine.trains.restrictions().length).toBe(0);
    // Far from any line: nothing to stop.
    expect(engine.chaos.forceQuake(131.0, 32.0, 60_000, 600)).toBe(-1);
  }, 120_000);
});
