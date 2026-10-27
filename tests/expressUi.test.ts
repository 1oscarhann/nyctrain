/**
 * Express service and four-track sections on the main thread (v2, docs/v2/express-quad.md
 * §2 and §4.10), no DOM: the pair push on the map and its sign through orientEdges, the track
 * tool's four-track and crossover texts (connectors by kind, units and currency in both cities),
 * the station tool's pair / link / single texts and link candidate, the bulldoze text, and the
 * route panel's Line list, Service helpers, Overtakes card and the route tool's insert-in-order.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MAP, QUAD, type TrackLevel } from '../src/balance';
import { applyCity } from '../src/cities';
import { Game } from '../src/core/game';
import { setUnits } from '../src/core/units';
import { sampleAt } from '../src/construction/geometry';
import type { Network } from '../src/construction/network';
import { pickEdge } from '../src/construction/pick';
import { addQuadStroke, addScissors, partnerPoint, scissorsCandidate, type QuadResult } from '../src/construction/quad';
import type { QuadRole, StrokePoint } from '../src/construction/types';
import { edgeReport, type EdgeReport, type Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { orientEdges, pairOffsetAB, quadOffsets } from '../src/map/networkLayers';
import { choosePlatform, insertStop, pathErrorHint, stationsAlongPath, switchPlatform } from '../src/routes/express';
import { stationsNear } from '../src/routes/eventService';
import { compileNetwork } from '../src/routes/compile';
import { findRoutePath } from '../src/routes/pathfind';
import { defaultHeadways } from '../src/routes/routeSet';
import type { Route } from '../src/routes/types';
import {
  bulldozePairEdgeHint,
  bulldozePairTip,
  connectorKinds,
  constructionLabelEdges,
  connectorText,
  crossoverTip,
  linkCandidate,
  lineRows,
  mergeDetails,
  overtakesValue,
  PREVIEW_PAIR_PX,
  quadHoverTip,
  quadStrokeTip,
  routeOnQuad,
  serviceEditNoop,
  skipsText,
  stationQuadTip,
  strokeRoles,
  type StationDetail,
} from '../src/ui/express';

const dry: Terrain = { isWater: () => false, density: () => 0 };
const P = (x: number, y: number, level: TrackLevel = 'deep'): StrokePoint => ({ x, y, level });
const none = { kind: 'none' } as const;
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function stubGame(): Game {
  return new Game({} as World, dry, { sandbox: true, fare: 3 });
}

function nodeAt(net: Network, x: number, y: number): number {
  let best = -1, bd = Infinity;
  for (const n of net.nodes.values()) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) [best, bd] = [n.id, d];
  }
  if (bd > 0.5) throw new Error(`no node at ${x},${y}`);
  return best;
}

function platformAt(net: Network, x: number, y: number, role: QuadRole | null, name: string): number {
  const hit = pickEdge(net, x, y, 20, (id) => (net.edges.get(id)?.quad?.role ?? null) === role)!;
  return net.addStation(hit.edge, hit.u, 8, name).id;
}

function pairAt(net: Network, x: number, name: string): [number, number] {
  const hit = pickEdge(net, x, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
  const pp = partnerPoint(net, hit.edge, hit.u)!;
  const [a, b] = net.addStationPair(hit.edge, hit.u, pp.edge, pp.u, 8, name);
  return [a.id, b.id];
}

function reports(net: Network, res: QuadResult): Map<number, EdgeReport> {
  return new Map(res.edges.map((id) => [id, edgeReport(net, id, dry)]));
}

/** A free/free quad (0,0) → (6000,0), express at y = −9; pairs A, C, E; local-only B, D (as tests 15–22). */
function patternQuad(extraScissors: number[] = []) {
  const game = stubGame();
  const net = game.network;
  const q = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
  if (!q.ok) throw new Error(q.fatal);
  for (const x of extraScissors) {
      const hit = pickEdge(net, x, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
      const c = scissorsCandidate(net, hit.edge, hit.u, 'heavy');
      if (!c.ok) throw new Error(c.reason);
      expect(addScissors(net, c.g, c.edge, c.uA, c.uB, 'heavy').ok).toBe(true);
  }
  const A = pairAt(net, 1000, 'A');
  const B = platformAt(net, 2000, 0, 'local', 'B');
  const C = pairAt(net, 3000, 'C');
  const D = platformAt(net, 4000, 0, 'local', 'D');
  const E = pairAt(net, 5000, 'E');
  return { game, net, q, A, B, C, D, E, local: [A[0], B, C[0], D, E[0]], express: [A[1], C[1], E[1]] };
}

function mkRoute(game: Game, name: string, stops: number[], express = false): Route {
  return game.routes.create({ name, bullet: name.slice(0, 1), color: '#E8443A', cls: 'heavy', stops, cars: 8, headways: defaultHeadways(), express });
}

afterAll(() => applyCity('nyc'));
afterEach(() => setUnits('imperial'));

describe('express UI: the pair push on the map (§4.10)', () => {
  /**
   * For every pair edge: the push the map draws (line-offset to the right of the drawn direction,
   * negated when orientEdges draws the edge b→a) points away from the partner pair.
   */
  function checkPush(net: Network): { flipped: number; straight: number } {
    const flips = orientEdges(net);
    const Q = quadOffsets(net, new Map());
    let flipped = 0, straight = 0;
    for (const e of net.edges.values()) {
      const t = e.quad;
      if (!t || t.role === 'link') {
        expect(pairOffsetAB(e, Q)).toBe(0);
        continue;
      }
      const g = net.geom(e.id);
      const u = g.length / 2;
      const p = sampleAt(g.xs, g.ys, g.cum, u);
      const flip = flips.get(e.id) ?? false;
      if (flip) flipped++;
      else straight++;
      const pab = pairOffsetAB(e, Q);
      expect(Math.abs(pab)).toBeCloseTo(MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2, 9);
      const drawn = flip ? -pab : pab;
      const dx = flip ? -p.hx : p.hx, dy = flip ? -p.hy : p.hy;
      // MapLibre's and deck.gl's positive offset is to the right of the drawn direction: (dy, −dx).
      const push = { x: Math.sign(drawn) * dy, y: -Math.sign(drawn) * dx };
      const q = partnerPoint(net, e.id, u)!;
      expect(q).not.toBeNull();
      expect(push.x * (q.x - p.x) + push.y * (q.y - p.y)).toBeLessThan(0);
    }
    return { flipped, straight };
  }

  it('pairOffsetAB pushes each pair away from the other, drawn either way (orientEdges on a reversed chain), both sides', () => {
    for (const side of [1, -1] as const) {
      // Drawn west → east and nothing else: the chain is drawn as stored.
      const a = stubGame().network;
      expect(addQuadStroke(a, [P(0, 0), P(3000, 0), P(6000, 800)], 'heavy', none, none, { side }).ok).toBe(true);
      expect(checkPush(a).straight).toBeGreaterThan(0);
      // An approach drawn east → west first (lowest ids), then a quad fanning east from its start:
      // orientEdges orients the chain by the approach, so the quad's edges are drawn b→a.
      const b = stubGame().network;
      b.addStroke([P(2000, 0), P(0, 0)], 'heavy', none, none);
      const start = nodeAt(b, 2000, 0);
      expect(addQuadStroke(b, [P(2000, 0), P(5000, 0), P(8000, -900)], 'heavy', { kind: 'node', node: start }, none, { side }).ok).toBe(true);
      expect(checkPush(b).flipped).toBeGreaterThan(0);
    }
  });

  it('quadOffsets: one route (or none) pushes 3.5 px; a wider bundle on either pair widens the whole group', () => {
    const { net, q } = patternQuad();
    const g = q.group;
    expect(quadOffsets(net, new Map()).get(g)).toBeCloseTo(MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2, 9);
    expect(PREVIEW_PAIR_PX).toBeCloseTo(3.5, 9);
    const two = new Map<number, unknown[]>([[q.express[0], [1, 2]], [q.links[0], [1, 2, 3, 4]]]);
    // Two routes on one express edge: half a spacing more for both pairs; links never count.
    expect(quadOffsets(net, two).get(g)).toBeCloseTo(MAP.interlineSpacingPx / 2 + MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2, 9);
    const loc = net.edges.get(q.local[0])!, exp = net.edges.get(q.express[0])!;
    expect(Math.sign(pairOffsetAB(loc, quadOffsets(net, two)))).toBe(-Math.sign(pairOffsetAB(exp, quadOffsets(net, two))));
  });
});

describe('express UI: track tool texts (§2.1)', () => {
  it('connectorKinds: free/free = 2 scissors; fan/free = 1 turnout + 1 scissors; fan/fan = 2 turnouts', () => {
    const a = stubGame().network;
    const ra = addQuadStroke(a, [P(0, 0), P(4000, 0)], 'heavy', none, none, { side: 1 });
    expect(connectorKinds(a, ra.links)).toEqual({ turnouts: 0, scissors: 2 });
    const b = stubGame().network;
    b.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    const rb = addQuadStroke(b, [P(0, 0), P(4000, 0)], 'heavy', { kind: 'node', node: nodeAt(b, 0, 0) }, none, { side: 1 });
    expect(connectorKinds(b, rb.links)).toEqual({ turnouts: 1, scissors: 1 });
    const c = stubGame().network;
    c.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    c.addStroke([P(4000, 0), P(6000, 0)], 'heavy', none, none);
    const rc = addQuadStroke(c, [P(0, 0), P(4000, 0)], 'heavy', { kind: 'node', node: nodeAt(c, 0, 0) }, { kind: 'node', node: nodeAt(c, 4000, 0) }, { side: 1 });
    expect(connectorKinds(c, rc.links)).toEqual({ turnouts: 2, scissors: 0 });
    expect(connectorText({ turnouts: 1, scissors: 2 })).toBe('1 turnout, 2 scissors');
    expect(connectorText({ turnouts: 2, scissors: 0 })).toBe('2 turnouts');
  });

  it('the stroke tooltip: both pairs, connectors, tightest curve and total, in the units and currency of each city', () => {
    applyCity('nyc');
    setUnits('imperial');
    const net = stubGame().network;
    const res = addQuadStroke(net, [P(0, 0), P(3000, 0), P(5500, 1500)], 'heavy', none, none, { side: 1 });
    expect(res.ok).toBe(true);
    const rep = reports(net, res);
    const ny = strip(quadStrokeTip(net, res, rep, 'deep', 'heavy'));
    expect(ny).toMatch(/^Four-track · Deep tunnel · Heavy metro/);
    expect(ny).toMatch(/Local pair [\d.]+ mi · \$[\d.]+B/);
    expect(ny).toContain(`Express pair ×${QUAD.secondPairCostFactor} `);
    expect(ny).toMatch(/Express pair ×[\d.]+ [\d.]+ mi · \$/);
    expect(ny).toContain('Turnouts/crossovers 2 scissors');
    expect(ny).toMatch(/Tightest curve [\d,]+ ft · \d+ mph \(inner|\((local|express) pair\)/);
    expect(ny).toMatch(/Line so far \$[\d.]+B/);
    expect(ny).toContain('F flips the express side');
    // The total is the sum of every new edge.
    const total = [...rep.values()].reduce((t, r) => t + r.cost, 0);
    expect(total).toBeGreaterThan(0);
    applyCity('london');
    setUnits('metric');
    const ldn = strip(quadStrokeTip(net, res, rep, 'deep', 'heavy'));
    expect(ldn).toMatch(/Local pair [\d.]+ km · £/);
    expect(ldn).toMatch(/Tightest curve [\d,]+ m · \d+ km\/h/);
    expect(ldn).not.toContain('$');
    // Roles colour the preview: the drawn pair, the express pair and the connectors.
    const roles = strokeRoles(res);
    expect(new Set(roles.values())).toEqual(new Set(['local', 'express', 'link']));
    applyCity('nyc');
  });

  it('a refused stroke shows its reason in red, problems in amber; hover and crossover texts', () => {
    setUnits('metric');
    const net = stubGame().network;
    const bad: QuadResult = { ok: false, fatal: 'Too short for four tracks', group: -1, local: [], express: [], links: [], double: [], edges: [], problems: [] };
    const t = quadStrokeTip(net, bad, new Map(), 'deep', 'heavy');
    expect(t).toContain('hw-red');
    expect(strip(t)).toContain('Too short for four tracks');
    const res = addQuadStroke(net, [P(0, 0), P(4000, 0)], 'heavy', none, none, { side: -1 });
    const withProblem = { ...res, problems: ['No straight 190 m near the end for a crossover — add one with X'] };
    expect(quadStrokeTip(net, withProblem, reports(net, res), 'deep', 'heavy')).toContain('hw-amber');
    // Hover: open map (side named), a free four-track end (continue), other track (fan).
    expect(strip(quadHoverTip(net, none, 'elevated', -1))).toBe('Click to start four-track elevated · express pair on the left ( F flips)');
    const end = nodeAt(net, 0, 0);
    expect(strip(quadHoverTip(net, { kind: 'node', node: end }, 'deep', 1))).toBe('Click to extend the four-track section');
    expect(strip(quadHoverTip(net, { kind: 'edge', edge: res.local[0], u: 50 }, 'deep', 1))).toContain('Click to branch four tracks off here');
    // Crossover mode.
    expect(strip(crossoverTip(null))).toContain('Hover over a four-track section');
    expect(strip(crossoverTip({ ok: false, reason: 'Crossovers need straight, level track clear of platforms' }))).toContain('clear of platforms');
    const ok = strip(crossoverTip({ ok: true, cost: 42.1e6, length: 150 }));
    expect(ok).toMatch(/^Scissors crossover · 150 m · \$42\.1M Trains can switch pairs in both directions Click to place/);
  });
});

describe('express UI: station and bulldoze tools (§2.2)', () => {
  it('linkCandidate pairs a new platform with a lone platform on the other pair, within 40 m only', () => {
    const net = stubGame().network;
    const res = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    expect(res.ok).toBe(true);
    const lone = platformAt(net, 3000, -9, 'express', 'Lone');
    const hit = pickEdge(net, 3020, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
    const c = linkCandidate(net, hit.edge, 3020, 0)!;
    expect(c.existing.id).toBe(lone);
    // Aligned opposite the existing platform.
    const q = net.stationPos({ edge: c.edge, u: c.u } as never);
    expect(Math.abs(q.x - 3000)).toBeLessThan(0.5);
    expect(net.edges.get(c.edge)!.quad!.role).toBe('local');
    const far = pickEdge(net, 3100, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
    expect(linkCandidate(net, far.edge, 3100, 0)).toBeNull();
    // Hovering the same pair as the lone platform is not a link; a paired platform never is.
    const same = pickEdge(net, 3010, -9, 5, (id) => net.edges.get(id)?.quad?.role === 'express')!;
    expect(linkCandidate(net, same.edge, 3010, -9)).toBeNull();
    const s = net.addStation(c.edge, c.u, 8, 'Lone');
    net.linkPair(lone, s.id);
    expect(linkCandidate(net, hit.edge, 3020, 0)).toBeNull();
  });

  it('station and bulldoze texts for a pair, a link and a local-only stop, in both cities', () => {
    applyCity('nyc');
    const pair = strip(stationQuadTip({ mode: { kind: 'pair', partnerEdge: 1, partnerU: 2 }, role: 'local', level: 'deep', cars: 8, cost: 333e6, days: 30 }));
    expect(pair).toBe(`Cross-platform station · Deep tunnel · 8 cars Platforms local + express Cost $333M (2 platforms at ${Math.round(QUAD.pairPlatformCostShare * 100)}%) Build time 30 days Click to place · Shift-click: only this pair`);
    const net = stubGame().network;
    addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    const id = platformAt(net, 3000, 0, 'local', '72 St');
    const link = strip(stationQuadTip({ mode: { kind: 'link', existing: net.stations.get(id)! }, role: 'express', level: 'deep', cars: 8, cost: 166e6, days: 30 }));
    expect(link).toContain('72 St · express platform · 8 cars');
    expect(link).toContain('Click to add the express platform to 72 St (cross-platform)');
    const single = strip(stationQuadTip({ mode: { kind: 'single' }, role: 'local', level: 'deep', cars: 8, cost: 208e6, days: 30 }));
    expect(single).toContain('Local-only stop: expresses run past on the other pair');
    const err = stationQuadTip({ mode: { kind: 'single' }, role: 'local', level: 'deep', cars: 8, cost: 208e6, days: 30, error: 'Too close to 72 St (300 m along the track)' });
    expect(err).toContain('hw-red');
    expect(err).not.toContain('Click to place');
    applyCity('london');
    expect(strip(stationQuadTip({ mode: { kind: 'pair', partnerEdge: 1, partnerU: 2 }, role: 'local', level: 'deep', cars: 8, cost: 333e6, days: 30 }))).toContain('£333M');
    expect(strip(bulldozePairTip({ name: 'Oxford Circus', blueprint: false, refund: 66.6e6, shift: false, blocked: null }))).toBe('Oxford Circus · cross-platform Demolish both platforms of Oxford Circus · refund £66.6M Shift-click: just this platform');
    expect(strip(bulldozePairTip({ name: 'Oxford Circus', blueprint: false, refund: 33.3e6, shift: true, blocked: null }))).toContain('Click to demolish just this platform · refund £33.3M');
    expect(strip(bulldozePairTip({ name: 'Bank', blueprint: true, refund: 0, shift: false, blocked: null }))).toContain('Click to remove both platforms (free)');
    expect(strip(bulldozePairTip({ name: 'Bank', blueprint: false, refund: 1, shift: false, blocked: 'Served by Central' }))).toBe('Bank · cross-platform Served by Central — remove it from the route first');
    applyCity('nyc');
  });
});

describe('express UI: route panel and route tool (§2.3)', () => {
  it('the Line list: served and skipped stations in order, tags by pair, other routes, terminals; the Service helpers', () => {
    const { game, net, A, B, D, E, local, express } = patternQuad();
    const lr = mkRoute(game, 'Local', local);
    const xr = mkRoute(game, 'Express', express, true);
    const path = findRoutePath(net, 'heavy', express);
    const along = stationsAlongPath(net, express, path);
    const rows = lineRows(net, xr, game.routes.list(), along);
    expect(rows.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(rows.map((r) => r.served)).toEqual([true, false, true, false, true]);
    expect(rows.map((r) => r.stopNo)).toEqual([1, 0, 2, 0, 3]);
    expect(rows.map((r) => r.terminal)).toEqual([true, false, false, false, true]);
    expect(rows[1].tag).toBe('on the local pair');
    expect(rows[0].station).toBe(A[1]);
    expect(rows[0].partner).toBe(A[0]);
    // The local calls at every station complex here, at its own platforms.
    for (const r of rows) expect(r.others.map((o) => o.id)).toEqual([lr.id]);
    expect(skipsText(along)).toBe('Skips 2 stations');
    expect(skipsText(stationsAlongPath(net, local, findRoutePath(net, 'heavy', local)))).toBeNull();
    expect(routeOnQuad(net, express)).toBe(true);
    expect(routeOnQuad(net, [B, D])).toBe(true);
    // An express skipping a pair on its own pair: "passes".
    const skipC = lineRows(net, xr, game.routes.list(), stationsAlongPath(net, [A[1], E[1]], findRoutePath(net, 'heavy', [A[1], E[1]])));
    expect(skipC.find((r) => r.name === 'C')!.tag).toBe('passes');
  });

  it('routeOnQuad is false on ordinary track; the Overtakes card reads yesterday, else today, else a dash', () => {
    const game = stubGame();
    const net = game.network;
    net.addStroke([P(0, 0), P(4000, 0)], 'heavy', none, none);
    const e = [...net.edges.keys()][0];
    const a = net.addStation(e, 500, 8, 'a').id, b = net.addStation(e, 3500, 8, 'b').id;
    expect(routeOnQuad(net, [a, b])).toBe(false);
    expect(overtakesValue(undefined, undefined)).toBe('—');
    expect(overtakesValue(undefined, 0)).toBe('—');
    expect(overtakesValue(undefined, 4)).toBe('4 today');
    expect(overtakesValue(0, 9)).toBe('0');
    expect(overtakesValue(1229, 3)).toBe('1,229');
  });

  it('insertStop: a station the draft runs past goes in path order, at the platform clicked when the track allows', () => {
    // Crossovers at 1500, 2500 and 3500: the express can reach B, and C's local platform and back.
    const x = patternQuad([1500, 2500, 3500]);
    const p = findRoutePath(x.net, 'heavy', [x.A[1], x.E[1]]);
    expect(insertStop(x.net, 'heavy', [x.A[1], x.E[1]], p, x.C[1])).toEqual({ stops: [x.A[1], x.C[1], x.E[1]] });
    // Alt-click (the local platform) is kept when reachable.
    expect(insertStop(x.net, 'heavy', [x.A[1], x.E[1]], p, x.C[0])).toEqual({ stops: [x.A[1], x.C[0], x.E[1]] });
    expect(insertStop(x.net, 'heavy', [x.A[1], x.E[1]], p, x.B)).toEqual({ stops: [x.A[1], x.B, x.E[1]] });
    // Without those crossovers C's local platform isn't reachable: the express platform it passes is used;
    // B (local-only, beside the express) can't be reached at all, with the design's message.
    const y = patternQuad();
    const q = findRoutePath(y.net, 'heavy', [y.A[1], y.E[1]]);
    expect(insertStop(y.net, 'heavy', [y.A[1], y.E[1]], q, y.C[0])).toEqual({ stops: [y.A[1], y.C[1], y.E[1]] });
    const err = insertStop(y.net, 'heavy', [y.A[1], y.E[1]], q, y.B);
    expect('error' in err && err.error).toBe('B is on the local pair and no crossover reaches it — add crossovers before and after it (Track tool, 4 tracks, X)');
  });

  it('the station panel shows a pair as one: hourly boardings, left behind and waiting summed, flows merged', () => {
    const a: StationDetail = { hourlyToday: [1, 2, 3], hourlyYesterday: [4, 5, 6], leftToday: 1, leftYesterday: 2, waiting: 3, from: [{ tract: 7, count: 10 }, { tract: 8, count: 5 }], to: [{ tract: 9, count: 4 }] };
    const b: StationDetail = { hourlyToday: [10, 20, 30], hourlyYesterday: [0, 0, 1], leftToday: 0, leftYesterday: 5, waiting: 1, from: [{ tract: 8, count: 6 }], to: [{ tract: 3, count: 4 }] };
    expect(mergeDetails([a, b])).toEqual({
      hourlyToday: [11, 22, 33],
      hourlyYesterday: [4, 5, 7],
      leftToday: 1,
      leftYesterday: 7,
      waiting: 4,
      from: [{ tract: 8, count: 11 }, { tract: 7, count: 10 }],
      to: [{ tract: 3, count: 4 }, { tract: 9, count: 4 }],
    });
  });
});

describe('express UI: review fixes', () => {
  it('Alt-click on a served pair switches its platform each time; a plain click still removes it', () => {
    const x = patternQuad([1500, 2500]);
    const net = x.net;
    // The express draft stops at C's express platform; Alt-click picks the local one, then back.
    let stops = [x.A[1], x.C[1], x.E[1]];
    expect(choosePlatform(net, x.C[1], true, true)).toBe(x.C[0]);
    stops = switchPlatform(net, stops, x.C[0])!;
    expect(stops).toEqual([x.A[1], x.C[0], x.E[1]]);
    // A second Alt-click (choosePlatform still picks the local platform, the one it now uses).
    stops = switchPlatform(net, stops, choosePlatform(net, x.C[1], true, true))!;
    expect(stops).toEqual([x.A[1], x.C[1], x.E[1]]);
    // Either platform of the complex finds the stop; a lone platform or a station off the route has nothing to switch.
    expect(switchPlatform(net, stops, x.C[0])).toEqual([x.A[1], x.C[0], x.E[1]]);
    expect(switchPlatform(net, [x.A[0], x.B, x.E[0]], x.B)).toBeNull();
    expect(switchPlatform(net, stops, x.D)).toBeNull();
  });

  it('a path error on four tracks adds the crossover hint; on ordinary track it reads as before', () => {
    const x = patternQuad();
    expect(pathErrorHint(x.net, [x.A[1], x.C[0]], 'No connected track from A to C')).toMatch(/^No connected track from A to C\. On four tracks trains change pairs only at a crossover: use the other platform \(Alt-click\) or add crossovers \(Track tool, 4 tracks, X\)$/);
    const game = stubGame();
    game.network.addStroke([P(0, 0), P(2000, 0)], 'heavy', none, none);
    const e = [...game.network.edges.keys()][0];
    const s1 = game.network.addStation(e, 300, 8, 'S1').id, s2 = game.network.addStation(e, 1700, 8, 'S2').id;
    expect(pathErrorHint(game.network, [s1, s2], 'No path')).toBe('No path');
  });

  it('a blueprint local-only stop never moves a running local onto the express pair (built track, built platforms)', () => {
    // The quad of tests 15–22 with scissors at 1500 and 2500, pairs A, C, E and no local-only stops.
    const game = stubGame();
    const net = game.network;
    expect(addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 }).ok).toBe(true);
    for (const at of [1500, 2500]) {
      const h = pickEdge(net, at, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
      const c = scissorsCandidate(net, h.edge, h.u, 'heavy');
      if (!c.ok) throw new Error(c.reason);
      expect(addScissors(net, c.g, c.edge, c.uA, c.uB, 'heavy').ok).toBe(true);
    }
    const x = { A: pairAt(net, 1000, 'A'), C: pairAt(net, 3000, 'C'), E: pairAt(net, 5000, 'E') };
    game.build(true);
    const local = mkRoute(game, 'Local', [x.A[0], x.C[0], x.E[0]]);
    const roles = () => new Set(game.routes.path(net, local).legs.map((l) => net.edges.get(l.edge)?.quad?.role ?? 'plain'));
    expect([...roles()]).toEqual(['local']);
    // Plan a local-only stop at 2000 between A and C (a blueprint on built track).
    const hit = pickEdge(net, 2000, 0, 5, (id) => net.edges.get(id)?.quad?.role === 'local')!;
    const bp = net.addStation(hit.edge, hit.u, 8, 'Planned');
    expect(bp.status).toBe('blueprint');
    expect([...roles()]).toEqual(['local']);
    // Once it is built and the local still skips it, the skip is real: the local takes the express pair past it.
    game.build(true);
    expect(net.stations.get(bp.id)!.status).toBe('built');
    expect(roles().has('express')).toBe(true);
  });

  it('event cards list a cross-platform pair once (its nearer platform)', () => {
    const x = patternQuad();
    x.game.build(true);
    mkRoute(x.game, 'Local', x.local);
    mkRoute(x.game, 'Express', x.express, true);
    const net = compileNetwork(x.game).net;
    const near = stationsNear(net, 3000, 50, 1500);
    expect(near.map((s) => s.name)).toEqual(['C', 'B', 'D']);
    // On the express side, the express platform is the nearer one.
    expect(stationsNear(net, 3000, -60, 300)).toEqual([{ id: x.C[1], name: 'C', dist: expect.closeTo(51, 0) }]);
  });

  it('construction labels: one per four-track section pair of edges, connectors only where no pair is labelled', () => {
    const game = stubGame();
    const net = game.network;
    const q = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    game.build(false);
    for (const e of net.edges.values()) e.status = 'construction';
    const labelled = constructionLabelEdges(net);
    expect(labelled.length).toBe(q.local.length);
    expect(new Set(labelled)).toEqual(new Set(q.local));
    // An ordinary edge under construction is labelled as before; so is an express edge whose local partner is built.
    net.addStroke([P(0, 3000), P(2000, 3000)], 'heavy', none, none);
    const plain = [...net.edges.values()].find((e) => !e.quad)!;
    plain.status = 'construction';
    const x = q.express.reduce((a, b) => (net.geom(a).length >= net.geom(b).length ? a : b));
    const partner = partnerPoint(net, x, net.geom(x).length / 2)!;
    net.edges.get(partner.edge)!.status = 'built';
    const l2 = new Set(constructionLabelEdges(net));
    expect(l2.has(plain.id)).toBe(true);
    expect(l2.has(x)).toBe(true);
  });

  it('a Service edit that changes nothing is a no-op; a kind change with the same stops is not', () => {
    const r = { stops: [1, 2, 3], express: true };
    expect(serviceEditNoop(r, [1, 2, 3])).toBe(true);
    expect(serviceEditNoop(r, [1, 2, 3], true)).toBe(true);
    expect(serviceEditNoop(r, [1, 2, 3], false)).toBe(false);
    expect(serviceEditNoop(r, [1, 3])).toBe(false);
    expect(serviceEditNoop({ stops: [1, 2], express: undefined }, [1, 2], false)).toBe(true);
  });

  it('bulldozing one pair says how to put it back; ordinary track says nothing more', () => {
    expect(strip(bulldozePairEdgeHint('express'))).toBe('The express pair of a four-track section: to put it back, draw four tracks ( Q ) from one end of the gap to the other');
    expect(bulldozePairEdgeHint('link')).toBe('');
    expect(bulldozePairEdgeHint(undefined)).toBe('');
  });
});
