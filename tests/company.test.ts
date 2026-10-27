/**
 * Founding a company (logo, grant, save), prebuilt airport stations, the inner-London tunnel-only
 * zone, and the Routes manager's one-click route changes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ECONOMY, TRAINS } from '../src/balance';
import { applyCity } from '../src/cities';
import { AIRPORTS } from '../src/cities/destinations';
import { GRANTS, grantAmount, sanitizeCompany, type Company } from '../src/core/company';
import { Game } from '../src/core/game';
import { toLocal } from '../src/core/geo';
import { placeAirportStations } from '../src/core/hubs';
import { inTunnelZone } from '../src/core/zones';
import { edgeReport, stationReport, type Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { applySave, buildSave } from '../src/save/serialize';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, stationNear } from '../src/sim/headless';
import { FONTS, initialsOf, logoSvg, randomLogo, sanitizeLogo, SHAPES, STYLES, SYMBOLS, DEFAULT_LOGO } from '../src/ui/logo';
import { patched, previewRouteChange, quickPlan, stepHeadway } from '../src/ui/routeOps';

afterAll(() => applyCity('nyc'));

type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];

describe('logos', () => {
  it('every shape, symbol and style renders a self-contained SVG', () => {
    for (const sh of SHAPES)
      for (const sy of SYMBOLS)
        for (const st of STYLES) {
          const svg = logoSvg({ ...DEFAULT_LOGO, shape: sh.id, symbol: sy.id, style: st.id }, 48, 'Thames & Severn Rail');
          expect(svg.startsWith('<svg')).toBe(true);
          expect(svg.endsWith('</svg>')).toBe(true);
          expect(svg).not.toContain('undefined');
          expect(svg).not.toContain('NaN');
        }
    expect(SHAPES.length).toBeGreaterThanOrEqual(10);
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(20);
    expect(FONTS.length).toBeGreaterThanOrEqual(8);
  });

  it('initials, random logos and sanitising', () => {
    expect(initialsOf('Thames Valley Rail')).toBe('TVR');
    expect(initialsOf('The London & North Western Railway Co.')).toBe('LNW');
    expect(initialsOf('')).toBe('H');
    for (let i = 0; i < 50; i++) expect(sanitizeLogo(randomLogo())).toEqual(expect.objectContaining({ shape: expect.any(String) }));
    expect(sanitizeLogo({ shape: 'nope', base: 'red', accent: '#123456' })).toEqual({ ...DEFAULT_LOGO, accent: '#123456' });
    // A name with markup is escaped in the monogram and the label.
    const svg = logoSvg({ ...DEFAULT_LOGO, symbol: 'monogram' }, 48, '<b>Evil</b> "Co"');
    expect(svg).not.toContain('<b>');
  });
});

describe('company', () => {
  it('grants scale the starting cash; a company survives a save round trip', () => {
    expect(grantAmount('standard')).toBe(ECONOMY.startingCash);
    expect(grantAmount('generous')).toBeGreaterThan(grantAmount('standard'));
    expect(grantAmount('lean')).toBeLessThan(grantAmount('standard'));
    expect(GRANTS.length).toBe(3);
    const game = new Game({} as World, {} as Terrain, { sandbox: false });
    const co: Company = { name: 'Capital Rapid Transit', logo: randomLogo(), grantKind: 'lean', grant: grantAmount('lean'), founded: 0 };
    game.company = co;
    const file = JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1 }, modeState: null })));
    expect(file.meta.company).toBe('Capital Rapid Transit');
    const g2 = new Game({} as World, {} as Terrain, { sandbox: false });
    applySave(g2, file);
    expect(g2.company).toEqual(co);
    // Older saves have none; junk is dropped.
    expect(sanitizeCompany(undefined)).toBeNull();
    expect(sanitizeCompany({ name: '   ' })).toBeNull();
    expect(sanitizeCompany({ name: 'X', grantKind: 'huge', logo: 5 })?.grantKind).toBe('standard');
  });
});

describe('airport stations', () => {
  for (const id of ['london', 'southeast', 'nyc'] as const) {
    it(`${id}: every airport starts with a built, free station on land near it`, () => {
      applyCity(id);
      const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: false });
      placeAirportStations(game);
      const sts = [...game.network.stations.values()];
      const airports = AIRPORTS[id].filter((a) => a.stub);
      expect(sts.length).toBe(airports.length);
      for (const a of airports) {
        const s = sts.find((x) => x.name === a.stub!.station)!;
        expect(s, a.name).toBeDefined();
        expect(s.status).toBe('built');
        expect(s.cost).toBe(0);
        const p = game.network.stationPos(s);
        const [ax, ay] = toLocal(a.lon, a.lat);
        expect(Math.hypot(p.x - ax, p.y - ay), a.name).toBeLessThan(1500);
      }
      // No cost on day one.
      expect(game.finance.cash).toBe(ECONOMY.startingCash);
    });
  }
});

describe('inner London is tunnel-only', () => {
  it('refuses surface track and stations inside, allows tunnels inside and surface outside', () => {
    applyCity('london');
    expect(inTunnelZone(...(toLocal(-0.1276, 51.5073) as [number, number]))).toBe(true); // Charing Cross
    expect(inTunnelZone(...(toLocal(-0.3, 51.56) as [number, number]))).toBe(false); // Wembley-ish
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
    const net = game.network;
    const surface = drawLine(game, [L(51.515, -0.16), L(51.517, -0.12)], 'at-grade');
    const err = surface.flatMap((e) => edgeReport(net, e, game.terrain).errors);
    expect(err.some((m) => /tunnel-only/.test(m))).toBe(true);
    const deep = drawLine(game, [L(51.525, -0.16), L(51.527, -0.12)], 'deep');
    expect(deep.flatMap((e) => edgeReport(net, e, game.terrain).errors).filter((m) => /tunnel-only/.test(m))).toEqual([]);
    const sr = stationReport(net, surface[0], net.geom(surface[0]).length / 2, 8, game.terrain);
    expect(sr.errors.some((m) => /tunnel-only/.test(m))).toBe(true);
    const outside = drawLine(game, [L(51.58, -0.33), L(51.585, -0.29)], 'at-grade');
    expect(outside.flatMap((e) => edgeReport(net, e, game.terrain).errors).filter((m) => /tunnel-only/.test(m))).toEqual([]);
    // New York has no such zone.
    applyCity('nyc');
    expect(inTunnelZone(0, 0)).toBe(false);
  });
});

describe('one-click route changes', () => {
  it('previews trains and cost; length, type and frequency steps', () => {
    applyCity('london');
    const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: false });
    game.finance.cash = 1e11;
    drawLine(game, [L(51.4927, -0.224), L(51.515, -0.142), L(51.524, -0.07)], 'deep');
    const stops = [L(51.4927, -0.224), L(51.51, -0.165), L(51.518, -0.112), L(51.524, -0.07)].map((p, i) => stationNear(game, p, `P${i}`, 8));
    expect(game.build(true).ok).toBe(true);
    const r = makeRoute(game, 'EW', 'EW', '#DC241F', stops, 6, { am: 4, pm: 4, midday: 8, evening: 10, night: 0 });
    const now = quickPlan(game, r).trainsNeeded;
    expect(now).toBeGreaterThan(0);
    // More often at peak: more trains, money to pay.
    const more = previewRouteChange(game, r, { headways: { am: 3, pm: 3 } });
    expect(more.ok).toBe(true);
    expect(more.trainsAfter).toBeGreaterThan(now);
    // Longer trains: same number, more cars.
    const longer = previewRouteChange(game, r, { cars: 8 });
    expect(longer.ok).toBe(true);
    expect(longer.trainsAfter).toBe(now);
    // Too long for the platforms.
    expect(previewRouteChange(game, r, { cars: 12 }).ok).toBe(false);
    // A new train type: cars clamp to its range.
    expect(patched(r, { stock: 'commuter' }).cars).toBeGreaterThanOrEqual(TRAINS.commuter.minCars);
    // Steps through the headway choices; night can switch off.
    expect(stepHeadway(4, -1, false)).toBe(3);
    expect(stepHeadway(4, 1, false)).toBe(5);
    expect(stepHeadway(30, 1, true)).toBe(0);
    expect(stepHeadway(30, 1, false)).toBeNull();
    expect(stepHeadway(0, -1, true)).toBe(30);
    expect(stepHeadway(2, -1, false)).toBeNull();
    // No service at all is refused.
    expect(previewRouteChange(game, r, { headways: { am: 0, pm: 0, midday: 0, evening: 0, night: 0 } }).ok).toBe(false);
    // Operations settings go through the same preview (the route panel applies them at once):
    // lots of recovery time at the terminals needs more trains, and the real route is untouched.
    const slack = previewRouteChange(game, r, { control: { ...r.control, recoveryPct: 0.3 } });
    expect(slack.ok).toBe(true);
    expect(slack.trainsAfter).toBeGreaterThanOrEqual(now);
    expect(patched(r, { control: { ...r.control, hold: !r.control.hold } }).control.hold).toBe(!r.control.hold);
    expect(r.control.recoveryPct).not.toBe(0.3);
  });
});
