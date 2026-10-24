/**
 * Headless game harness (no rendering, no worker): used by the headless test and the balance
 * tuning script. Builds networks in code, runs the engine at full speed and settles finances.
 */
import { ECONOMY, EVENTS, MAP, OPERATIONS, STATION, TIME, TRAINS, type ChaosLevel, type GrowthPace, type TrackClass, type TrackLevel } from '../balance';
import { cityBalance } from '../cities';
import { MAX_VENUES, type CityEvent } from '../core/cityCalendar';
import { Game } from '../core/game';
import { toLocal } from '../core/geo';
import { LandMask } from '../data/landMask';
import { TractIndex, type LandCollection, type World } from '../data/world';
import { WorldTerrain } from '../construction/terrain';
import { pickEdge, pickNode } from '../construction/pick';
import { sampleAt } from '../construction/geometry';
import { addQuadStroke, partnerPoint, type QuadResult } from '../construction/quad';
import { stationReport } from '../construction/validate';
import { expressPattern } from '../routes/express';
import { compileNetwork, trainsNeeded } from '../routes/compile';
import { offControl } from '../routes/control';
import { purchaseFleet } from '../routes/fleet';
import { defaultHeadways } from '../routes/routeSet';
import { ROUTE_COLORS, type PeriodId, type Route, type RouteControl } from '../routes/types';
import { defaultFares, flatFares, type FarePolicy } from '../economy/fares';
import { dayKpi } from '../economy/finance';
import { runProfile } from '../trains/kinematics';
import { Engine, type EngineCallbacks } from './engine';
import type { CompiledNetwork, CRoute, CRouteDir, DayReport, GrowthData, ModeState } from './protocol';
import type { QuadRole, Snap } from '../construction/types';
import { edgeReport } from '../construction/validate';

export interface HeadlessGameOptions {
  sandbox?: boolean;
  /** Legacy: one flat fare (default: the city's fare policy). */
  fare?: number;
  /** Fare policy (default: the city's, CITY_BALANCE[city].fares). */
  fares?: FarePolicy;
  chaos?: ChaosLevel;
  chaosSeed?: number;
  /** Bond market seed (default: derived from the chaos seed, as in a real game). */
  marketSeed?: number;
  /**
   * Operations control and the money market: 'default' plays like a new game (routes hold at the
   * first stop with 10% recovery, short turnarounds, the city's fare policy, the bond market);
   * 'off' turns every new mechanic off (standard turnarounds, no holding or recovery, one flat fare
   * ECONOMY.fareDefault for every period and band, and the fixed bond rate with no spread), which
   * reproduces the code before operations control bit for bit.
   */
  ops?: 'default' | 'off';
  /** Living City pace (default GROWTH.defaultPace, as a new game; 'off' is the code before Living City). */
  growthPace?: GrowthPace;
}

/**
 * A game for headless runs. City chaos defaults to Off here (unlike a new game in the browser),
 * so the tests and the README balance numbers are free of seed noise; the seed is CHAOS.defaultSeed.
 * Operations control and the money market default to a new game's settings (`ops: 'off'` for the
 * code before them).
 */
export function createHeadlessGame(world: World, land: LandCollection, opts: HeadlessGameOptions = {}): Game {
  const terrain = new WorldTerrain(new LandMask(land, MAP.landCell), new TractIndex(world.tracts));
  const off = opts.ops === 'off';
  const fares = off ? flatFares(opts.fare ?? ECONOMY.fareDefault) : (opts.fares ?? (opts.fare !== undefined ? flatFares(opts.fare) : defaultFares()));
  const game = new Game(world, terrain, { sandbox: opts.sandbox ?? false, fares, chaos: opts.chaos ?? 'off', chaosSeed: opts.chaosSeed, marketSeed: opts.marketSeed, fixedRate: off, growthPace: opts.growthPace });
  if (off) game.routes.newControl = offControl;
  return game;
}

type LonLat = [number, number];

/** Draw a line through lon/lat waypoints. Returns the new edge ids. */
export function drawLine(game: Game, pts: LonLat[], level: TrackLevel | TrackLevel[], cls: TrackClass = 'heavy', start: Snap = { kind: 'none' }, end: Snap = { kind: 'none' }): number[] {
  const stroke = pts.map((p, i) => {
    const [x, y] = toLocal(p[0], p[1]);
    return { x, y, level: Array.isArray(level) ? level[i] : level };
  });
  return game.editBlueprint(() => game.network.addStroke(stroke, cls, start, end));
}

/** Snap target on existing track nearest a lon/lat (for branching). */
export function edgeSnapNear(game: Game, p: LonLat, cls: TrackClass = 'heavy'): Snap {
  const [x, y] = toLocal(p[0], p[1]);
  const hit = pickEdge(game.network, x, y, 400);
  if (!hit) throw new Error('no track near ' + p);
  // Slide along the edge to the nearest point where branching is allowed.
  for (let k = 0; k < 120; k++) {
    for (const sgn of [1, -1]) {
      const u = hit.u + sgn * k * 10;
      if (game.network.canSplitAt(hit.edge, u, cls).ok) return { kind: 'edge', edge: hit.edge, u };
    }
  }
  throw new Error('no straight track to branch from near ' + p);
}

/**
 * Place a station on the nearest valid spot of the track near a lon/lat. `role` (four-track
 * sections, v2) only considers edges of that pair: 'local' places a local-only stop.
 */
export function stationNear(game: Game, p: LonLat, name: string, cars = STATION.cars.heavy.default, opts: { role?: QuadRole } = {}): number {
  const [x, y] = toLocal(p[0], p[1]);
  const net = game.network;
  const role = opts.role;
  const hit = pickEdge(net, x, y, 600, role ? (id) => net.edges.get(id)?.quad?.role === role : undefined);
  if (!hit) throw new Error(`no track near station ${name}`);
  // Search this edge and neighbouring ones for the closest valid platform position.
  let best: { edge: number; u: number; d: number } | null = null;
  let why = '';
  for (const e of net.edges.values()) {
    if (role && e.quad?.role !== role) continue;
    const g = net.geom(e.id);
    for (let u = 0; u <= g.length; u += 10) {
      const q = sampleAt(g.xs, g.ys, g.cum, u);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d > 700 || (best && d >= best.d)) continue;
      const rep = stationReport(net, e.id, u, cars, game.terrain);
      if (rep.ok) best = { edge: e.id, u, d };
      else if (!why) why = rep.errors[0];
    }
  }
  if (!best) throw new Error(`no valid platform position near ${name}: ${why}`);
  const b = best;
  return game.editBlueprint(() => net.addStation(b.edge, b.u, cars, name).id);
}

/**
 * Four-track sections (v2): a quad stroke through lon/lat waypoints (one blueprint edit). The drawn
 * line is the local pair; the express pair runs on `side` (+1 right of travel, −1 left). Ends snap
 * like drawLine's (a node or edge snap fans; a quad's free end pair continues; none is free).
 * Throws if the stroke is refused.
 */
export function quadLine(game: Game, pts: LonLat[], level: TrackLevel | TrackLevel[], start: Snap = { kind: 'none' }, end: Snap = { kind: 'none' }, side: 1 | -1 = 1, cls: TrackClass = 'heavy'): QuadResult {
  const stroke = pts.map((p, i) => {
    const [x, y] = toLocal(p[0], p[1]);
    return { x, y, level: Array.isArray(level) ? level[i] : level };
  });
  const r = game.editBlueprint(() => addQuadStroke(game.network, stroke, cls, start, end, { side }));
  if (!r.ok) throw new Error(`quad refused: ${r.fatal}`);
  return r;
}

/** Snap to the track node nearest a lon/lat (within `tol` m), e.g. the end of a drawn line. */
export function nodeSnapNear(game: Game, p: LonLat, tol = 30): Snap {
  const [x, y] = toLocal(p[0], p[1]);
  const id = pickNode(game.network, x, y, tol);
  if (id === null) throw new Error('no track node near ' + p);
  return { kind: 'node', node: id };
}

/**
 * A cross-platform station (v2) on the four-track section nearest a lon/lat: the closest spot of a
 * local-pair edge where both platforms (the partner opposite on the express pair) are valid, priced
 * as a pair. Returns [local platform, express platform].
 */
export function pairNear(game: Game, p: LonLat, name: string, cars = STATION.cars.heavy.default): [number, number] {
  const [x, y] = toLocal(p[0], p[1]);
  const net = game.network;
  let best: { edge: number; u: number; pe: number; pu: number; d: number } | null = null;
  let why = '';
  for (const e of net.edges.values()) {
    if (e.quad?.role !== 'local') continue;
    const g = net.geom(e.id);
    for (let u = 0; u <= g.length; u += 10) {
      const q = sampleAt(g.xs, g.ys, g.cum, u);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d > 700 || (best && d >= best.d)) continue;
      const pp = partnerPoint(net, e.id, u);
      if (!pp) continue;
      const a = stationReport(net, e.id, u, cars, game.terrain, null, { paired: true });
      const b = stationReport(net, pp.edge, pp.u, cars, game.terrain, null, { paired: true });
      if (a.ok && b.ok) best = { edge: e.id, u, pe: pp.edge, pu: pp.u, d };
      else if (!why) why = (a.ok ? b : a).errors[0];
    }
  }
  if (!best) throw new Error(`no valid cross-platform position near ${name}: ${why || 'no four-track section'}`);
  const b = best;
  const [l, xp] = game.editBlueprint(() => net.addStationPair(b.edge, b.u, b.pe, b.pu, cars, name));
  return [l.id, xp.id];
}

/** A route with its fleet bought. `control` is merged over the game's control for new routes. */
export function makeRoute(game: Game, name: string, bullet: string, color: string, stops: number[], cars: number, headways: Partial<Record<PeriodId, number>> = {}, cls: TrackClass = 'heavy', control?: Partial<RouteControl>, express = false): Route {
  const r = game.routes.create({ name, bullet, color, cls, stops, cars, headways: { ...defaultHeadways(), ...headways }, ...(control ? { control } : {}), ...(express ? { express } : {}) });
  const res = purchaseFleet(game, r);
  if (!res.ok) throw new Error(`can't buy trains for ${name}: ${res.reason}`);
  return r;
}

/**
 * The spec's test network: a heavy metro line from Lower Manhattan up the West Side to Upper
 * Manhattan, and a second line from Midtown that shares the West Side trunk and then runs under
 * the East River into Brooklyn.
 */
export function buildTestNetwork(game: Game, headways: { r1?: number; r2?: number } = {}): { r1: Route; r2: Route; errors: string[] } {
  const westSide: LonLat[] = [
    [-74.0135, 40.7030],
    [-74.0105, 40.7120],
    [-74.0072, 40.7255],
    [-74.0035, 40.7395],
    [-73.9935, 40.7530],
    [-73.9818, 40.7685],
    [-73.9762, 40.7860],
    [-73.9650, 40.8060],
    [-73.9505, 40.8255],
    [-73.9385, 40.8490],
    [-73.9205, 40.8690],
  ];
  drawLine(game, westSide, 'deep');
  // Branch off the trunk south of 14th St, east under the Lower East Side and the river.
  const branchStart = edgeSnapNear(game, [-74.0050, 40.7335]);
  const branch: LonLat[] = [
    [-74.0050, 40.7335], // junction (snapped)
    [-73.9960, 40.7205],
    [-73.9860, 40.7175],
    [-73.9700, 40.7140],
    [-73.9560, 40.7110],
    [-73.9420, 40.7055],
    [-73.9270, 40.6990],
    [-73.9120, 40.6930],
  ];
  drawLine(game, branch, 'deep', 'heavy', branchStart);
  const errors: string[] = [];
  for (const e of game.network.edges.values()) {
    const r = edgeReport(game.network, e.id, game.terrain);
    if (!r.ok) errors.push(`edge ${e.id}: ${r.errors.join('; ')}`);
  }
  const s = (p: LonLat, n: string) => stationNear(game, p, n);
  const southFerry = s([-74.0128, 40.7045], 'South Ferry');
  const chambers = s([-74.0098, 40.7150], 'Chambers St');
  const houston = s([-74.0068, 40.7270], 'Houston St');
  const fourteenth = s([-74.0025, 40.7410], '14 St');
  const penn = s([-73.9925, 40.7545], '34 St–Penn');
  const columbus = s([-73.9812, 40.7698], 'Columbus Circle');
  const eightySixth = s([-73.9755, 40.7880], '86 St');
  const oneTen = s([-73.9640, 40.8075], '110 St');
  const oneThirtySeven = s([-73.9497, 40.8270], '137 St');
  const oneEightyFirst = s([-73.9378, 40.8500], '181 St');
  const inwood = s([-73.9230, 40.8670], 'Inwood');
  const delancey = s([-73.9880, 40.7180], 'Delancey St');
  const marcy = s([-73.9580, 40.7114], 'Marcy Av');
  const flushing = s([-73.9440, 40.7062], 'Flushing Av');
  const myrtle = s([-73.9290, 40.6995], 'Myrtle Av');
  const bushwick = s([-73.9140, 40.6937], 'Bushwick');
  // Borrow like a player would if the plan costs more than the cash on hand.
  const cost = game.blueprintSummary().cost;
  while (!game.finance.canAfford(cost + 2e9) && game.finance.issueBond(game.day)) {
    /* issue another $1B */
  }
  const built = game.build(true);
  if (!built.ok) errors.push('build failed: ' + built.reason);
  while (!game.finance.canAfford(2.5e9) && game.finance.issueBond(game.day)) {
    /* trains */
  }
  const r1 = makeRoute(game, 'West Side', '1', '#E8443A', [southFerry, chambers, houston, fourteenth, penn, columbus, eightySixth, oneTen, oneThirtySeven, oneEightyFirst, inwood], 8, headways.r1 ? { am: headways.r1, pm: headways.r1 } : {});
  const r2 = makeRoute(game, 'Brooklyn Crosstown', 'B', '#2F7FE0', [columbus, penn, fourteenth, delancey, marcy, flushing, myrtle, bushwick], 8, headways.r2 ? { am: headways.r2, pm: headways.r2 } : {});
  return { r1, r2, errors };
}

/**
 * The test network's West Side line with a four-track trunk (v2, docs/v2/express-quad.md §13 test
 * 31): double track from South Ferry to Houston, a quad from there to 110 St (fanning at both ends,
 * vertices 2–7 of the West Side waypoints), double track on to Inwood. Cross-platform stations at
 * 14 St, 34 St–Penn, 72 St and 96 St; local-only stops between them (23, 28, 42, 50 St, Columbus
 * Circle, 66, 79, 86 and 103 St), so riders from a local stop gain by changing across the platform;
 * an all-stops local and an express (its Express pattern). Built and running (sandbox: at once).
 */
export function buildExpressTestNetwork(game: Game, headways: { local?: number; express?: number } = {}): { local: Route; express: Route; errors: string[]; quad: QuadResult } {
  const w: LonLat[] = [
    [-74.0135, 40.7030],
    [-74.0105, 40.7120],
    [-74.0072, 40.7255],
    [-74.0035, 40.7395],
    [-73.9935, 40.7530],
    [-73.9818, 40.7685],
    [-73.9762, 40.7860],
    [-73.9650, 40.8060],
    [-73.9505, 40.8255],
    [-73.9385, 40.8490],
    [-73.9205, 40.8690],
  ];
  drawLine(game, w.slice(0, 3), 'deep');
  drawLine(game, w.slice(7), 'deep');
  const quad = quadLine(game, w.slice(2, 8), 'deep', nodeSnapNear(game, w[2]), nodeSnapNear(game, w[7]), 1);
  const errors: string[] = [];
  for (const e of game.network.edges.values()) {
    const r = edgeReport(game.network, e.id, game.terrain);
    if (!r.ok) errors.push(`edge ${e.id}: ${r.errors.join('; ')}`);
  }
  // A point a fraction f along waypoint segment i → i + 1.
  const at = (i: number, f: number): LonLat => [w[i][0] + (w[i + 1][0] - w[i][0]) * f, w[i][1] + (w[i + 1][1] - w[i][1]) * f];
  const s = (p: LonLat, n: string, role?: QuadRole) => stationNear(game, p, n, STATION.cars.heavy.default, role ? { role } : {});
  const loc = (p: LonLat, n: string) => s(p, n, 'local');
  const pr = (p: LonLat, n: string) => pairNear(game, p, n);
  const southFerry = s([-74.0128, 40.7045], 'South Ferry');
  const chambers = s([-74.0098, 40.7150], 'Chambers St');
  const houston = s([-74.0080, 40.7225], 'Houston St');
  const fourteenth = pr(at(3, 0.11), '14 St');
  const twentyThird = loc(at(3, 0.45), '23 St');
  const twentyEighth = loc(at(3, 0.78), '28 St');
  const penn = pr(at(4, 0.08), '34 St–Penn');
  const fortySecond = loc(at(4, 0.4), '42 St');
  const fiftieth = loc(at(4, 0.72), '50 St');
  const columbus = loc(at(5, 0.04), 'Columbus Circle');
  const sixtySixth = loc(at(5, 0.36), '66 St');
  const seventySecond = pr(at(5, 0.68), '72 St');
  const seventyNinth = loc(at(6, 0.06), '79 St');
  const eightySixth = loc(at(6, 0.33), '86 St');
  const ninetySixth = pr(at(6, 0.6), '96 St');
  const oneOThird = loc(at(6, 0.85), '103 St');
  const oneTen = s([-73.9640, 40.8075], '110 St');
  const oneThirtySeven = s([-73.9497, 40.8270], '137 St');
  const oneEightyFirst = s([-73.9378, 40.8500], '181 St');
  const inwood = s([-73.9230, 40.8670], 'Inwood');
  const cost = game.blueprintSummary().cost;
  while (!game.finance.canAfford(cost + 2e9) && game.finance.issueBond(game.day)) {
    /* issue another $1B */
  }
  const built = game.build(true);
  if (!built.ok) errors.push('build failed: ' + built.reason);
  while (!game.finance.canAfford(2.5e9) && game.finance.issueBond(game.day)) {
    /* trains */
  }
  const allStops = [
    southFerry, chambers, houston, fourteenth[0], twentyThird, twentyEighth, penn[0], fortySecond, fiftieth, columbus, sixtySixth,
    seventySecond[0], seventyNinth, eightySixth, ninetySixth[0], oneOThird, oneTen, oneThirtySeven, oneEightyFirst, inwood,
  ];
  const hw = (m?: number) => (m ? { am: m, pm: m } : {});
  const local = makeRoute(game, 'West Side Local', '1', '#E8443A', allStops, 8, hw(headways.local));
  const express = makeRoute(game, 'West Side Express', '2', '#E8443A', expressPattern(game.network, allStops), 8, hw(headways.express), 'heavy', undefined, true);
  return { local, express, errors, quad };
}

/**
 * London's express test line (v2; call applyCity('london') first): Paddington → Mile End with a
 * deep four-track trunk from west of Marble Arch along Oxford Street and through the City to east of
 * Bank (fanning at both ends). Cross-platform stations at Marble Arch, Oxford Circus, Holborn and
 * Bank; local-only stops at Bond Street, Tottenham Court Road, Chancery Lane and St Paul's; an
 * all-stops local and its express. Built and running.
 */
export function buildLondonExpressTestNetwork(game: Game, headways: { local?: number; express?: number } = {}): { local: Route; express: Route; errors: string[]; quad: QuadResult } {
  const w: LonLat[] = [[-0.1780, 51.5168], [-0.1585, 51.5136], [-0.1300, 51.5166], [-0.0975, 51.5146], [-0.0886, 51.5133], [-0.0600, 51.5195], [-0.0333, 51.5252]];
  const at = (i: number, f: number): LonLat => [w[i][0] + (w[i + 1][0] - w[i][0]) * f, w[i][1] + (w[i + 1][1] - w[i][1]) * f];
  const west = at(0, 0.45), east = at(4, 0.35);
  drawLine(game, [w[0], west], 'deep');
  drawLine(game, [east, ...w.slice(5)], 'deep');
  const quad = quadLine(game, [west, ...w.slice(1, 5), east], 'deep', nodeSnapNear(game, west), nodeSnapNear(game, east), 1);
  const errors: string[] = [];
  for (const e of game.network.edges.values()) {
    const r = edgeReport(game.network, e.id, game.terrain);
    if (!r.ok) errors.push(`edge ${e.id}: ${r.errors.join('; ')}`);
  }
  const s = (p: LonLat, n: string) => stationNear(game, p, n);
  const loc = (p: LonLat, n: string) => stationNear(game, p, n, STATION.cars.heavy.default, { role: 'local' });
  const pr = (p: LonLat, n: string) => pairNear(game, p, n)[0];
  const stops = [
    s([-0.1755, 51.5162], 'Paddington'),
    pr([-0.1585, 51.5136], 'Marble Arch'),
    loc([-0.1494, 51.5142], 'Bond Street'),
    pr([-0.1415, 51.5152], 'Oxford Circus'),
    loc([-0.1308, 51.5165], 'Tottenham Court Road'),
    pr([-0.1200, 51.5163], 'Holborn'),
    loc([-0.1115, 51.5185], 'Chancery Lane'),
    loc([-0.0975, 51.5146], "St Paul's"),
    pr([-0.0886, 51.5133], 'Bank'),
    s([-0.0726, 51.5165], 'Aldgate East'),
    s([-0.0597, 51.5194], 'Whitechapel'),
    s([-0.0340, 51.5250], 'Mile End'),
  ];
  const cost = game.blueprintSummary().cost;
  while (!game.finance.canAfford(cost + 2e9) && game.finance.issueBond(game.day)) {
    /* issue another bond */
  }
  const built = game.build(true);
  if (!built.ok) errors.push('build failed: ' + built.reason);
  while (!game.finance.canAfford(2.5e9) && game.finance.issueBond(game.day)) {
    /* trains */
  }
  const hw = (m?: number) => (m ? { am: m, pm: m } : {});
  const local = makeRoute(game, 'Central Local', 'C', '#E8443A', stops, 8, hw(headways.local));
  const express = makeRoute(game, 'Central Express', 'X', '#E8443A', expressPattern(game.network, stops), 8, hw(headways.express), 'heavy', undefined, true);
  return { local, express, errors, quad };
}

export interface HeadlessRun {
  engine: Engine;
  reports: DayReport[];
  ms: number;
}

export interface EngineRunOptions {
  agentScale?: number;
  seed?: number;
  /** Each closed day (after the finances settle). */
  onDay?: (r: DayReport) => void;
  /** Busy labels (e.g. the growth month close), for timing in scripts. */
  busy?: EngineCallbacks['busy'];
  /** City chaos callbacks. */
  alert?: EngineCallbacks['alert'];
  dayChaos?: EngineCallbacks['dayChaos'];
  /** Mode shares from a save (as the browser passes them after a load). */
  modeState?: ModeState;
  /** Living City pace (default: the game's, game.growthPace). */
  growthPace?: GrowthPace;
  /** Living City state from a save (the groups the mode shares belong to). */
  growth?: GrowthData | null;
  /** Tuning only: close a growth month every N days instead of at calendar month ends. */
  monthEvery?: number;
  /** Commuter stories: the day's notable commuters (turns the commuter of the day on). */
  dayStories?: EngineCallbacks['dayStories'];
  /** After every sim step (scripts that pick stories as the day goes on). */
  onStep?: (engine: Engine) => void;
}

/**
 * An engine for the game at its current time, with the game's chaos settings and the compiled
 * network in place. Each midnight it settles the game's finances.
 */
export function startEngine(game: Game, opts: EngineRunOptions & { reports?: DayReport[] } = {}): Engine {
  const engine = new Engine(
    game.world,
    {
      agentScale: opts.agentScale ?? 10,
      seed: opts.seed ?? 1885,
      time: game.time,
      fares: game.fares,
      modeState: opts.modeState,
      chaos: game.chaosInit(),
      service: game.chaos.service,
      growth: opts.growth ?? null,
      growthPace: opts.growthPace ?? game.growthPace,
      monthEvery: opts.monthEvery,
    },
    {
      dayEnd: (r) => {
        opts.reports?.push(r);
        // Like the browser: a growth month's value capture is booked on its own ledger line.
        game.finance.settleDay({ day: r.day, riders: r.riders, revenue: r.fareRevenue, carKm: r.carKm, stationsOpen: r.stationsOpen, kpi: dayKpi(r), ...(r.growth ? { valueCapture: r.growth.valueCapture } : {}) });
        opts.onDay?.(r);
      },
      alert: opts.alert,
      busy: opts.busy,
      // Like the browser: the game keeps today's level and plan basis for saves.
      dayChaos: (info) => {
        game.setChaosToday(info);
        opts.dayChaos?.(info);
      },
      dayStories: opts.dayStories,
    },
  );
  engine.setNetwork(compileNetwork(game).net);
  if (opts.dayStories) engine.setStoriesDaily(true);
  return engine;
}

/** Test helper: tract indices within `radius` metres (centre to station) of a built station of the game. */
export function nearStations(game: Game, radius: number): number[] {
  const pts = [...game.network.stations.values()].filter((s) => s.status !== 'blueprint').map((s) => game.network.stationPos(s));
  const out: number[] = [];
  game.world.tracts.forEach((t, i) => {
    if (pts.some((p) => Math.hypot(p.x - t.x, p.y - t.y) <= radius)) out.push(i);
  });
  return out;
}

/** Step the engine at the fixed timestep until its clock reaches t. */
export function stepUntil(engine: Engine, t: number): void {
  while (engine.time + TIME.simStep <= t) engine.step(TIME.simStep);
}

/** Run whole days at full speed, settling finances each midnight. */
export function runDays(game: Game, days: number, opts: EngineRunOptions = {}): HeadlessRun {
  const reports: DayReport[] = [];
  const engine = startEngine(game, { ...opts, reports });
  const t0 = Date.now();
  const end = (Math.floor(game.time / 86400) + days) * 86400 + 60;
  const onStep = opts.onStep;
  while (engine.time < end) {
    engine.step(TIME.simStep);
    onStep?.(engine);
  }
  game.time = engine.time;
  return { engine, reports, ms: Date.now() - t0 };
}

/**
 * Test fixture: a city event at one of the current city's venues (by key), the first kind held
 * there unless a label is given, with the given attendance and start hour.
 */
export function venueEvent(venueKey: string, day: number, attendance: number, startHour: number, label?: string): CityEvent {
  const cc = cityBalance().chaos;
  const venue = cc.venues.findIndex((v) => v.key === venueKey);
  if (venue < 0) throw new Error(`no venue ${venueKey}`);
  const kind = cc.kinds.findIndex((k) => k.venue === venueKey && (label === undefined || k.label === label));
  if (kind < 0) throw new Error(`no event kind at ${venueKey}`);
  const start = Math.round(startHour * 3600);
  return { id: day * MAX_VENUES + venue, day, venue, kind, label: cc.kinds[kind].label, attendance, start, end: start + cc.kinds[kind].duration, announced: day - EVENTS.announceDays };
}

/** Test fixture: a Midtown arena concert (New York). */
export function midtownArenaEvent(day: number, attendance: number, startHour: number): CityEvent {
  return venueEvent('midtown-arena', day, attendance, startHour, 'Midtown arena concert');
}

/**
 * Large synthetic network for performance checks (the spec's 300 stations / 25 routes / ~400
 * trains): a grid of straight deep-tunnel lines, a station about every kilometre on land.
 */
/** The perf grid's extent: north–south lines from lon0 across lonSpan (latNs), crosstown lines from lat0 across latSpan (lonEw). */
export interface PerfArea {
  lon0: number;
  lonSpan: number;
  latNs: [number, number];
  lat0: number;
  latSpan: number;
  lonEw: [number, number];
}

/** New York's grid (Brooklyn, Manhattan and Queens), the default. */
export const PERF_AREA_NYC: PerfArea = { lon0: -74.02, lonSpan: 0.27, latNs: [40.6, 40.79], lat0: 40.63, latSpan: 0.14, lonEw: [-74.03, -73.74] };
/** London's grid of the same size around Charing Cross (≈ 23 × 21 km; 1° of longitude is shorter at 51.5° N). */
export const PERF_AREA_LONDON: PerfArea = { lon0: -0.29, lonSpan: 0.33, latNs: [51.42, 51.61], lat0: 51.44, latSpan: 0.14, lonEw: [-0.3, 0.06] };

/**
 * `quads` (v2) turns that many of the north–south lines (spread across the grid) into free/free
 * four-track lines: cross-platform stations at the terminals and every third stop, local-only stops
 * between, an all-stops local and an express (its Express pattern) at the same headways.
 */
export function buildPerfNetwork(game: Game, opts: { ns?: number; ew?: number; perLine?: number; control?: Partial<RouteControl>; area?: PerfArea; quads?: number } = {}): { routes: Route[]; fleet: number } {
  const ns = opts.ns ?? 17, ew = opts.ew ?? 8, perLine = opts.perLine ?? 12;
  const ar = opts.area ?? PERF_AREA_NYC;
  const net = game.network;
  const cars = STATION.cars.heavy.default;
  const nq = Math.max(0, Math.min(ns, Math.floor(opts.quads ?? 0)));
  const quadLines = new Set<number>();
  for (let j = 0; j < nq; j++) quadLines.add(Math.min(ns - 1, Math.floor(((j + 0.5) * ns) / nq)));
  // North–south lines, then crosstown lines across them.
  const strokes: LonLat[][] = [];
  for (let i = 0; i < ns; i++) {
    const lon = ar.lon0 + (i * ar.lonSpan) / Math.max(1, ns - 1);
    strokes.push([[lon, ar.latNs[0]], [lon + 0.01, ar.latNs[1]]]);
  }
  for (let i = 0; i < ew; i++) {
    const lat = ar.lat0 + (i * ar.latSpan) / Math.max(1, ew - 1);
    strokes.push([[ar.lonEw[0], lat], [ar.lonEw[1], lat + 0.005]]);
  }
  const lines: number[][] = [];
  const expressLines: { line: number; stops: number[] }[] = [];
  for (let i = 0; i < strokes.length; i++) {
    if (quadLines.has(i)) {
      const q = quadLine(game, strokes[i], 'deep');
      // The long local edge between the scissors near the two ends.
      const edge = q.local.reduce((m, id) => (net.geom(id).length > net.geom(m).length ? id : m));
      const L = net.geom(edge).length;
      const us: number[] = [];
      let last = -Infinity;
      for (let u = 300; u < L - 200 && us.length < perLine; u += 50) {
        if (u - last < 950 || !stationReport(net, edge, u, cars, game.terrain, null, { paired: true }).ok) continue;
        us.push(u);
        last = u;
      }
      const stops = us.map((u, k) => {
        const name = `L${i + 1} S${k + 1}`;
        const pp = k === 0 || k === us.length - 1 || k % 3 === 0 ? partnerPoint(net, edge, u) : null;
        if (pp && stationReport(net, pp.edge, pp.u, cars, game.terrain, null, { paired: true }).ok) return game.editBlueprint(() => net.addStationPair(edge, u, pp.edge, pp.u, cars, name)[0].id);
        return game.editBlueprint(() => net.addStation(edge, u, cars, name).id);
      });
      lines.push(stops);
      expressLines.push({ line: i, stops });
      continue;
    }
    const [edge] = drawLine(game, strokes[i], 'deep');
    const L = net.geom(edge).length;
    const stops: number[] = [];
    let last = -Infinity;
    for (let u = 300; u < L - 200 && stops.length < perLine; u += 50) {
      if (u - last < 950 || !stationReport(net, edge, u, cars, game.terrain).ok) continue;
      stops.push(game.editBlueprint(() => net.addStation(edge, u, cars, `L${i + 1} S${stops.length + 1}`).id));
      last = u;
    }
    lines.push(stops);
  }
  game.build(true);
  const routes = lines
    .filter((s) => s.length >= 2)
    .map((stops, i) => makeRoute(game, `Line ${i + 1}`, String(i + 1), ROUTE_COLORS[i % ROUTE_COLORS.length], stops, cars, { am: 2.5, pm: 2.5, midday: 5 }, 'heavy', opts.control));
  for (const x of expressLines) {
    if (x.stops.length < 2) continue;
    const stops = expressPattern(net, x.stops);
    if (stops.length >= 2) routes.push(makeRoute(game, `Line ${x.line + 1} Express`, `${x.line + 1}X`, ROUTE_COLORS[x.line % ROUTE_COLORS.length], stops, cars, { am: 2.5, pm: 2.5, midday: 5 }, 'heavy', opts.control, true));
  }
  return { routes, fleet: routes.reduce((s, r) => s + Math.floor(r.ownedCars / r.cars), 0) };
}

export interface SyntheticLineOptions {
  /** Number of stops (≥ 2). */
  stops: number;
  /** Metres between stops. */
  spacing: number;
  /** Headway in every period, s. */
  headway: number;
  cars?: number;
  /** Hold fraction (0 = holding off). */
  hold?: number;
  /** Stop indices (direction 0) that are timepoints; mirrored for direction 1. */
  timepoints?: number[];
  /** Recovery share used to size the fleet (when `fleet` isn't given). */
  recoveryPct?: number;
  /** Trains (default: trainsNeeded with the recovery). */
  fleet?: number;
  /** Short turnarounds (default true). */
  shortTurn?: boolean;
  /** Route id (default 1). */
  id?: number;
}

/**
 * Test fixture: a straight two-track line as a compiled network, with real elements (one per
 * direction on tracks 0 and 1, no locks), run-profile timetables and optional timepoints. Used by
 * tests/ops.test.ts and for trying holding rules without data files.
 */
export function syntheticLine(o: SyntheticLineOptions): { net: CompiledNetwork; route: CRoute; runTime: number } {
  const spec = TRAINS.heavy;
  const cars = o.cars ?? 8;
  const L = cars * spec.carLength;
  const ext = L / 2 + 5;
  const length = (o.stops - 1) * o.spacing + 2 * ext;
  const stopS = Array.from({ length: o.stops }, (_, k) => ext + k * o.spacing);
  const prof = runProfile(length, [], stopS, spec.accel, spec.brake, spec.topSpeed, OPERATIONS.scheduledDwell);
  const tps = new Set(o.timepoints ?? []);
  const dir = (d: 0 | 1): CRouteDir => {
    const st = Array.from({ length: o.stops }, (_, k) => (d === 0 ? k : o.stops - 1 - k));
    const xs = d === 0 ? [0, length] : [length, 0];
    return {
      xs: new Float64Array(xs.map((x) => x - ext)),
      ys: new Float64Array(2),
      zs: new Float64Array(2),
      cum: new Float64Array([0, length]),
      length,
      stopStation: Int32Array.from(st),
      stopS: Float64Array.from(stopS),
      limS0: new Float64Array(0),
      limS1: new Float64Array(0),
      limV: new Float64Array(0),
      elems: [{ track: d, edge: d, edgeDir: 0, u0: 0, s0: 0, s1: length, lock: -1 }],
      schedArrive: Float64Array.from(prof.arrive),
      schedDepart: Float64Array.from(prof.depart),
      runTime: prof.total,
      timepoint: Uint8Array.from(st, (_, k) => (k > 0 && k < o.stops - 1 && tps.has(d === 0 ? k : o.stops - 1 - k) ? 1 : 0)),
    };
  };
  const hwMin = o.headway / 60;
  const fleet =
    o.fleet ?? trainsNeeded({ headways: { night: hwMin, am: hwMin, midday: hwMin, pm: hwMin, evening: hwMin }, control: { recoveryPct: o.recoveryPct ?? 0 } }, [prof.total, prof.total]);
  const route: CRoute = {
    id: o.id ?? 1,
    name: 'Synthetic',
    bullet: 'S',
    color: '#E8443A',
    cls: 'heavy',
    cars,
    trainLength: L,
    capComfort: spec.capacityComfort * cars,
    capCrush: spec.capacityCrush * cars,
    accel: spec.accel,
    brake: spec.brake,
    vmax: spec.topSpeed,
    headways: [o.headway, o.headway, o.headway, o.headway, o.headway],
    fleet,
    dirs: [dir(0), dir(1)],
    hold: o.hold ?? 0,
    shortTurn: o.shortTurn ?? true,
  };
  const net: CompiledNetwork = {
    version: 1,
    stations: Array.from({ length: o.stops }, (_, k) => ({ id: 100 + k, x: k * o.spacing, y: 0, name: `S${k}`, group: k })),
    routes: [route],
    trackCount: 2,
    lockCount: 0,
  };
  return { net, route, runTime: prof.total };
}
