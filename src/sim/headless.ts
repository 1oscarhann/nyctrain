/**
 * Headless game harness (no rendering, no worker): used by the headless test and the balance
 * tuning script. Builds networks in code, runs the engine at full speed and settles finances.
 */
import { ECONOMY, STATION, TIME, type TrackClass, type TrackLevel } from '../balance';
import { Game } from '../core/game';
import { toLocal } from '../core/geo';
import { LandMask } from '../data/landMask';
import { TractIndex, type LandCollection, type World } from '../data/world';
import { WorldTerrain } from '../construction/terrain';
import { pickEdge } from '../construction/pick';
import { stationReport } from '../construction/validate';
import { compileNetwork } from '../routes/compile';
import { purchaseFleet } from '../routes/fleet';
import { defaultHeadways } from '../routes/routeSet';
import type { PeriodId, Route } from '../routes/types';
import { Engine } from './engine';
import type { DayReport } from './protocol';
import type { Snap } from '../construction/types';
import { edgeReport } from '../construction/validate';

export function createHeadlessGame(world: World, land: LandCollection, opts: { sandbox?: boolean; fare?: number } = {}): Game {
  const terrain = new WorldTerrain(new LandMask(land), new TractIndex(world.tracts));
  return new Game(world, terrain, { sandbox: opts.sandbox ?? false, fare: opts.fare ?? ECONOMY.fareDefault });
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

/** Place a station on the nearest valid spot of the track near a lon/lat. */
export function stationNear(game: Game, p: LonLat, name: string, cars = STATION.cars.heavy.default): number {
  const [x, y] = toLocal(p[0], p[1]);
  const net = game.network;
  const hit = pickEdge(net, x, y, 600);
  if (!hit) throw new Error(`no track near station ${name}`);
  // Search this edge and neighbouring ones for the closest valid platform position.
  let best: { edge: number; u: number; d: number } | null = null;
  for (const e of net.edges.values()) {
    const g = net.geom(e.id);
    for (let u = 0; u <= g.length; u += 10) {
      const i = Math.min(g.xs.length - 1, Math.max(0, g.cum.findIndex((c) => c >= u)));
      const d = Math.hypot(g.xs[i] - x, g.ys[i] - y);
      if (d > 700 || (best && d >= best.d)) continue;
      if (stationReport(net, e.id, u, cars, game.terrain).ok) best = { edge: e.id, u, d };
    }
  }
  if (!best) throw new Error(`no valid platform position near ${name}`);
  const b = best;
  return game.editBlueprint(() => net.addStation(b.edge, b.u, cars, name).id);
}

export function makeRoute(game: Game, name: string, bullet: string, color: string, stops: number[], cars: number, headways: Partial<Record<PeriodId, number>> = {}, cls: TrackClass = 'heavy'): Route {
  const r = game.routes.create({ name, bullet, color, cls, stops, cars, headways: { ...defaultHeadways(), ...headways } });
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

export interface HeadlessRun {
  engine: Engine;
  reports: DayReport[];
  ms: number;
}

/** Run whole days at full speed, settling finances each midnight. */
export function runDays(game: Game, days: number, opts: { agentScale?: number; seed?: number; onDay?: (r: DayReport) => void } = {}): HeadlessRun {
  const reports: DayReport[] = [];
  const engine = new Engine(
    game.world,
    { agentScale: opts.agentScale ?? 10, seed: opts.seed ?? 1885, time: game.time, fare: game.fare },
    {
      dayEnd: (r) => {
        reports.push(r);
        game.finance.settleDay({ day: r.day, riders: r.riders, fare: game.fare, carKm: r.carKm, stationsOpen: r.stationsOpen });
        opts.onDay?.(r);
      },
    },
  );
  const compiled = compileNetwork(game);
  engine.setNetwork(compiled.net);
  const t0 = Date.now();
  const end = (Math.floor(game.time / 86400) + days) * 86400 + 60;
  while (engine.time < end) engine.step(TIME.simStep);
  game.time = engine.time;
  return { engine, reports, ms: Date.now() - t0 };
}
