/**
 * Tokyo, the subway map: 925 towns of the 23 wards with the 2020 Census commute between them, the
 * suburban commuters arriving at eight railway terminals, yen, packed Tokyo trains, the
 * through-running research, the Line tool's straight platforms, and the Kanto earthquakes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMUTERS, ECONOMY, TERMINALS, TRAINS, type ResearchId } from '../src/balance';
import { applyCity, city, cityResearch, regionCode } from '../src/cities';
import { AIRPORTS, CAMPUSES } from '../src/cities/destinations';
import { TK_TERMINALS, TK_WARDS } from '../src/cities/tokyoRegions';
import { toLocal } from '../src/core/geo';
import { applyTech } from '../src/core/tech';
import { fmtFare, fmtMoney, setUnits } from '../src/core/units';
import { LandMask } from '../src/data/landMask';
import { PLATFORM_CLEAR, stationStroke } from '../src/construction/lineStroke';
import { platformLength } from '../src/construction/network';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, makeRoute, runDays, stationLine } from '../src/sim/headless';
import { planQuake } from '../src/sim/chaos';
import { distanceFareMult } from '../src/economy/fares';
import type { LandCollection, World } from '../src/data/world';

let world: World;
let land: LandCollection;

beforeAll(() => {
  applyCity('tokyo');
  setUnits('metric');
  world = loadWorldFromDisk();
  land = loadLandFromDisk();
});
afterAll(() => {
  applyTech([]);
  applyCity('nyc');
});

describe('Tokyo: data', () => {
  it('has the towns of the 23 wards and eight railway terminals, with the census commute', () => {
    const towns = world.tracts.filter((t) => !t.terminal);
    const terms = world.tracts.filter((t) => t.terminal);
    expect(towns.length).toBeGreaterThan(880);
    expect(towns.length).toBeLessThan(980);
    expect(terms.map((t) => t.id).sort()).toEqual(TK_TERMINALS.map((t) => t.id).sort());
    const commuters = world.tracts.reduce((a, t) => a + t.residents, 0);
    expect(commuters).toBeGreaterThan(6.0e6);
    expect(commuters).toBeLessThan(6.5e6);
    expect(world.tracts.reduce((a, t) => a + t.jobs, 0)).toBeCloseTo(commuters, -2);
    // 2.8 million arrive at the terminals; Shinjuku and Ueno are the busiest.
    const arrivals = terms.reduce((a, t) => a + t.residents, 0);
    expect(arrivals).toBeGreaterThan(2.6e6);
    expect(arrivals).toBeLessThan(3.0e6);
    const shinjuku = terms.find((t) => t.id === 'T-shinjuku')!;
    expect(shinjuku.residents).toBeGreaterThan(400_000);
    expect(shinjuku.terminal).toMatch(/Odakyu/);
    // Every ward is a region, every town in one; the big job centres are where they should be.
    expect(new Set(world.tracts.map((t) => t.borough)).size).toBe(23);
    for (const t of world.tracts) expect(regionCode(t.borough)).toBeGreaterThan(0);
    const by = (n: string) => world.tracts.find((t) => t.name === n);
    expect(by('Marunouchi')?.borough).toBe('Chiyoda');
    expect(by('Nishi-Shinjuku')?.borough).toBe('Shinjuku');
    expect(by('Ginza')?.borough).toBe('Chuo');
    expect(by('Naka-Meguro')?.borough).toBe('Meguro');
    expect(by('Ikebukuro-Honcho')?.borough).toBe('Toshima');
    const top = [...towns].sort((a, b) => b.jobs - a.jobs).slice(0, 5).map((t) => t.name);
    expect(top).toContain('Nishi-Shinjuku');
    expect(top).toContain('Marunouchi');
    // Bands are modelled income, 30/40/30.
    expect(world.meta.bands).toHaveLength(3);
  });

  it('puts towns on land in their own ward, with the rivers cut out', () => {
    const mask = new LandMask(land, 20, false);
    let wrong = 0, sea = 0;
    for (const t of world.tracts.filter((x) => !x.terminal)) {
      const c = mask.codeAt(t.x, t.y);
      if (c === 0) sea++;
      else if (c !== regionCode(t.borough)) wrong++;
    }
    expect(sea / world.tracts.length).toBeLessThan(0.03);
    expect(wrong / world.tracts.length).toBeLessThan(0.03);
    expect(land.features.map((f) => f.properties.code).sort((a, b) => a - b)).toEqual(TK_WARDS.map((w) => w.code));
    // The Sumida at Ryogoku bridge and the Arakawa at Horikiri are water; Ginza is not.
    const at = (lon: number, lat: number) => mask.codeAt(...toLocal(lon, lat));
    expect(at(139.789, 35.6935)).toBe(0);
    expect(at(139.8205, 35.744)).toBe(0);
    expect(at(139.7656, 35.6717)).toBe(regionCode('Chuo'));
  });
});

describe('Tokyo: rules', () => {
  it('is a metro in yen with ¥180 fares, packed trains and its own research', () => {
    expect(city().theme).toBe('tokyo');
    expect(city().intertown).toBeFalsy();
    expect(fmtMoney(ECONOMY.startingCash)).toBe('¥700.0B');
    expect(fmtFare(ECONOMY.fareDefault)).toBe('¥180');
    // ¥210 at 6 km, ¥300 at 20 km (straight line).
    expect(ECONOMY.fareDefault * distanceFareMult(6000)).toBeCloseTo(2.02, 1);
    expect(ECONOMY.fareDefault * distanceFareMult(20000)).toBeCloseTo(3.02, 1);
    expect(TRAINS.heavy.capacityCrush).toBe(290);
    expect(COMMUTERS.crowdingWeight).toBe(0.4);
    expect(cityResearch().map((r) => r.id)).toContain('through-running');
    expect(AIRPORTS.tokyo.map((a) => a.name)).toEqual(['Haneda Airport']);
    expect(CAMPUSES.tokyo.length).toBeGreaterThan(10);
    // Back in New York: New York's trains and research.
    applyCity('nyc');
    expect(TRAINS.heavy.capacityCrush).toBe(200);
    expect(COMMUTERS.crowdingWeight).toBe(0.6);
    expect(cityResearch().map((r) => r.id)).not.toContain('through-running');
    applyCity('japan');
    expect(cityResearch().map((r) => r.id)).not.toContain('through-running');
    applyCity('tokyo');
  });

  it('lays a straight platform at a sharp turn, the curves beyond it', () => {
    // A right-angle turn at the middle station, 900 m from its neighbours.
    const pts = stationStroke(
      [
        { x: 0, y: 0, isNew: true },
        { x: 900, y: 0, isNew: true },
        { x: 900, y: 900, isNew: true },
      ],
      'heavy',
      10,
      'deep',
    );
    // First station: its far end, then both platform ends... the middle station's four points
    // (outer, platform end, platform end, outer) all lie on its axis, the 45° bisector through it.
    const half = platformLength(10, 'heavy') / 2 + PLATFORM_CLEAR;
    const mid = pts.slice(3, 7);
    for (const p of mid) expect(Math.abs(p.x - 900 - p.y)).toBeLessThan(1e-6);
    const d = mid.map((p) => Math.hypot(p.x - 900, p.y));
    expect(d[1]).toBeCloseTo(half, 6);
    expect(d[2]).toBeCloseTo(half, 6);
    // Room beyond each platform end for a 350 m curve onto the next straight.
    expect(d[0] - half).toBeGreaterThan(350 * Math.tan(Math.PI / 8) - 1);
    expect(d[3] - half).toBeGreaterThan(350 * Math.tan(Math.PI / 8) - 1);
  });
});

describe('Tokyo: a line from Shinjuku terminal to Otemachi', () => {
  it('fills up from the terminal, and through-running takes away the change of trains there', () => {
    const game = createHeadlessGame(world, land, { sandbox: true });
    const st = stationLine(
      game,
      [
        { name: 'Shinjuku', at: [139.6995, 35.6905], level: 'deep' },
        { name: 'Shinjuku-sanchome', at: [139.7065, 35.6905], level: 'deep' },
        { name: 'Yotsuya', at: [139.7305, 35.6846], level: 'deep' },
        { name: 'Kudanshita', at: [139.7514, 35.6955], level: 'deep' },
        { name: 'Otemachi', at: [139.7633, 35.6866], level: 'deep' },
      ],
      'heavy',
      10,
    );
    game.build(true);
    makeRoute(game, 'Shinjuku line', 'S', '#6CBB5A', st, 10, { night: 0, am: 2.5, midday: 5, pm: 2.5, evening: 6 });
    const run = runDays(game, 2, { agentScale: 50 });
    const day = run.reports[run.reports.length - 1];
    expect(day.riders).toBeGreaterThan(200_000);
    // Shinjuku terminal's commuters ride; a terminal far from the line (Shin-Kiba) does not.
    const c = run.engine.commuters!;
    const share = (id: string) => {
      const ti = world.tracts.findIndex((t) => t.id === id);
      let n = 0, tr = 0;
      for (let g = 0; g < c.G; g++)
        if (c.gHome[g] === ti) {
          n += c.gCount[g];
          tr += c.gCount[g] * c.shares[g * 3 + 2];
        }
      return tr / n;
    };
    expect(share('T-shinjuku')).toBeGreaterThan(0.1);
    expect(share('T-shinkiba')).toBeLessThan(0.01);
    // The change of trains: one transfer and its minutes on every terminal group's subway trip.
    const eng = c as unknown as { transitInput(g: number): { transfers: number; crowdMinutes: number } | null; gTerm: Uint8Array };
    const g = [...Array(c.G).keys()].find((k) => eng.gTerm[k] === 1 && eng.transitInput(k) !== null)!;
    expect(g).toBeDefined();
    const before = eng.transitInput(g)!;
    applyTech(['through-running' as ResearchId]);
    const after = eng.transitInput(g)!;
    applyTech([]);
    expect(before.transfers - after.transfers).toBeCloseTo(TERMINALS.changeTransfers, 6);
    expect(before.crowdMinutes - after.crowdMinutes).toBeCloseTo(TERMINALS.changeMinutes, 6);
  }, 180_000);
});

describe('Tokyo: earthquakes', () => {
  it('plans a few a year, centred near the city and reaching all of it', () => {
    let n = 0;
    for (let d = 0; d < 261 * 4; d++) {
      const q = planQuake(77, d, 'normal', -Infinity);
      if (!q) continue;
      n++;
      const [x, y] = toLocal(q.lon, q.lat);
      expect(Math.hypot(x, y)).toBeLessThan(80_000);
      expect(q.r).toBeGreaterThanOrEqual(35_000);
    }
    expect(n / 4).toBeGreaterThan(1);
    expect(n / 4).toBeLessThan(7);
  });
});
