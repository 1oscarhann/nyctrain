/**
 * The English city-region maps: Manchester, Birmingham, Leeds and Bristol. Each loads its real
 * census data, starts with its airport station, and a first line in the centre carries riders.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/balance';
import { applyCity, city, CITIES, regionCode } from '../src/cities';
import { UK_METROS, UK_METRO_IDS, type UkMetroId } from '../src/cities/ukMetroRegions';
import { AIRPORTS } from '../src/cities/destinations';
import { placeAirportStations } from '../src/core/hubs';
import { toLocal } from '../src/core/geo';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, runDays, stationNear } from '../src/sim/headless';

afterAll(() => applyCity('nyc'));

type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];

/** MSOAs per map (the income file's local authority codes) and the commuters the pipeline found. */
const EXPECT: Record<UkMetroId, { msoas: number; commuters: [number, number] }> = {
  manchester: { msoas: 346, commuters: [0.85e6, 0.95e6] },
  birmingham: { msoas: 356, commuters: [0.8e6, 0.88e6] },
  leeds: { msoas: 299, commuters: [0.75e6, 0.82e6] },
  bristol: { msoas: 140, commuters: [0.37e6, 0.41e6] },
};

/** A short deep line through each centre: [name, lat, lon]. */
const CENTRE_LINES: Record<UkMetroId, [string, number, number][]> = {
  manchester: [['Salford Central', 53.4831, -2.2552], ['Deansgate', 53.4745, -2.251], ['St Peter’s Square', 53.4782, -2.2433], ['Piccadilly', 53.4774, -2.2309], ['Ancoats', 53.4835, -2.222]],
  birmingham: [['Five Ways', 52.4713, -1.9128], ['Brindleyplace', 52.4785, -1.9125], ['Victoria Square', 52.4797, -1.9035], ['Moor Street', 52.4792, -1.8925], ['Digbeth', 52.4762, -1.8812]],
  leeds: [['Kirkstall Road', 53.8005, -1.5745], ['Park Lane', 53.7995, -1.5602], ['City Square', 53.7958, -1.547], ['Kirkgate', 53.7962, -1.5372], ['Richmond Hill', 53.7952, -1.5242]],
  bristol: [['Hotwells', 51.4498, -2.6185], ['Harbourside', 51.4507, -2.6045], ['The Centre', 51.4545, -2.597], ['Broadmead', 51.458, -2.5885], ['Temple Meads', 51.4491, -2.5813]],
};

describe('English city-region maps', () => {
  for (const id of UK_METRO_IDS) {
    it(`${id}: real census data for ${UK_METROS[id].region}`, () => {
      applyCity(id);
      expect(city().name).toBe(UK_METROS[id].name);
      expect(city().currency).toBe('£');
      const w = loadWorldFromDisk();
      expect(w.tracts.length).toBe(EXPECT[id].msoas);
      const commuters = w.tracts.reduce((s, t) => s + t.residents, 0);
      expect(commuters).toBeGreaterThan(EXPECT[id].commuters[0]);
      expect(commuters).toBeLessThan(EXPECT[id].commuters[1]);
      expect(city().regions.length).toBe(UK_METROS[id].regions.length);
      for (const r of UK_METROS[id].regions) expect(regionCode(r.name), r.name).toBeGreaterThan(0);
      // Every tract sits in one of the map's regions.
      const names = new Set(UK_METROS[id].regions.map((r) => r.name));
      expect(w.tracts.every((t) => names.has(t.borough))).toBe(true);
      // The city's goals name real regions.
      for (const g of CITIES[id].goals) {
        const rs = g.kind === 'crossing' ? [...g.a, ...g.b] : g.kind === 'connect' ? g.regions : [];
        for (const r of rs) expect(names.has(r), `${g.id}: ${r}`).toBe(true);
      }
    });

    it(`${id}: the airport starts with a built, free station`, () => {
      applyCity(id);
      const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: false });
      placeAirportStations(game);
      const sts = [...game.network.stations.values()];
      const airports = AIRPORTS[id].filter((a) => a.stub);
      expect(airports.length).toBeGreaterThan(0);
      expect(sts.length).toBe(airports.length);
      for (const a of airports) {
        const s = sts.find((x) => x.name === a.stub!.station)!;
        expect(s, a.name).toBeDefined();
        expect(s.status).toBe('built');
        const p = game.network.stationPos(s);
        const [ax, ay] = toLocal(a.lon, a.lat);
        expect(Math.hypot(p.x - ax, p.y - ay), a.name).toBeLessThan(1500);
      }
      expect(game.finance.cash).toBe(ECONOMY.startingCash);
    });

    it(`${id}: a first line through the centre carries riders`, () => {
      applyCity(id);
      const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
      const pts = CENTRE_LINES[id].map(([, la, lo]) => L(la, lo));
      drawLine(game, pts, 'deep');
      const ids = CENTRE_LINES[id].map(([n, la, lo]) => stationNear(game, L(la, lo), n, 8));
      expect(game.build(true).ok).toBe(true);
      makeRoute(game, 'Centre', 'A', '#DC241F', ids, 8);
      const run = runDays(game, 2, { agentScale: 20 });
      const r = run.reports[run.reports.length - 1];
      expect(r.riders, `${id} riders`).toBeGreaterThan(2_000);
    }, 120_000);
  }
});
