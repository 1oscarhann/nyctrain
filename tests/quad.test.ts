/**
 * Four-track sections (v2, docs/v2/express-quad.md §13 tests 1–14 and 23): the parallel-offset
 * geometry, quad strokes (free, fan, continue), crossovers, network invariants (tags through
 * splits, deep copies, twins, cross-platform pairs) and costs; plus a quad through central London
 * and under the Thames on London's real land mask.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { QUAD, STATION, type TrackLevel } from '../src/balance';
import { applyCity } from '../src/cities';
import { Game } from '../src/core/game';
import { toLocal } from '../src/core/geo';
import { setUnits } from '../src/core/units';
import { curveSpeed, projectOnPolyline, sampleAt } from '../src/construction/geometry';
import { Network } from '../src/construction/network';
import {
  addQuadStroke,
  addScissors,
  concentric,
  findStraight,
  gapTag,
  isGapEnd,
  locateTagged,
  mitre,
  partnerPoint,
  quadEndPartner,
  rejoinPair,
  repairPair,
  scissorsCandidate,
  turnSign,
  type QuadResult,
} from '../src/construction/quad';
import { quadLabel } from '../src/construction/describe';
import type { NetworkData, StrokePoint } from '../src/construction/types';
import { edgeReport, partnerCoverage, stationCost, stationReport, type Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { compileNetwork } from '../src/routes/compile';
import { findRoutePath } from '../src/routes/pathfind';
import { createHeadlessGame } from '../src/sim/headless';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';

setUnits('metric');

const dry: Terrain = { isWater: () => false, density: () => 0 };
const W = QUAD.spacing;
const P = (x: number, y: number, level: TrackLevel = 'deep'): StrokePoint => ({ x, y, level });
const none = { kind: 'none' } as const;

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

function distToEdges(net: Network, ids: number[], x: number, y: number): number {
  let d = Infinity;
  for (const id of ids) {
    const g = net.geom(id);
    d = Math.min(d, projectOnPolyline(g.xs, g.ys, g.cum, x, y).d);
  }
  return d;
}

/** Sample points every `step` m along some edges (each edge's own sampling). */
function samples(net: Network, ids: number[], n: number): { x: number; y: number; hx: number; hy: number }[] {
  const total = ids.reduce((s, id) => s + net.geom(id).length, 0);
  const out: { x: number; y: number; hx: number; hy: number }[] = [];
  for (let k = 0; k < n; k++) {
    let s = (total * (k + 0.5)) / n;
    for (const id of ids) {
      const g = net.geom(id);
      if (s <= g.length) {
        out.push(sampleAt(g.xs, g.ys, g.cum, s));
        break;
      }
      s -= g.length;
    }
  }
  return out;
}

function allOk(net: Network, ids: number[], terrain: Terrain = dry): string[] {
  const errs: string[] = [];
  for (const id of ids) {
    const r = edgeReport(net, id, terrain);
    if (!r.ok) errs.push(`${id}: ${r.errors.join('; ')}`);
  }
  return errs;
}

function freeFree(pts: StrokePoint[], side: 1 | -1 = 1, autoCrossovers?: boolean): { net: Network; r: QuadResult } {
  const net = new Network();
  const r = addQuadStroke(net, pts, 'heavy', none, none, { side, autoCrossovers });
  return { net, r };
}

// ------------------------------------------------------------------------------------------
describe('quad geometry', () => {
  it('1. mitres an L-shaped polyline: the twin is at (w, −w), both offset segments w away', () => {
    const p = { x: -1000, y: 0 }, v = { x: 0, y: 0 }, q = { x: 0, y: 1000 };
    const t = mitre(p, v, q, W)!;
    expect(t.x).toBeCloseTo(W, 9);
    expect(t.y).toBeCloseTo(-W, 9);
    // The offset segments are the lines y = −w (from p→v) and x = w (from v→q).
    expect(Math.abs(t.y - 0)).toBeCloseTo(W, 9);
    expect(Math.abs(t.x - 0)).toBeCloseTo(W, 9);
    expect(Math.hypot(t.x - v.x, t.y - v.y)).toBeCloseTo(W / Math.cos(Math.PI / 4), 9);
    // A chain end has one neighbour: a square offset.
    const e = mitre(null, { x: 0, y: 0 }, { x: 100, y: 0 }, W)!;
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(-W, 9);
    // Turns sharper than about 162° are refused.
    expect(mitre({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1 }, W)).toBeNull();
  });

  it('2. concentric radii: outside of the turn + w, inside − w, no curve stays none', () => {
    const p = { x: -1000, y: 0 }, v = { x: 0, y: 0 }, q = { x: 0, y: 1000 };
    expect(turnSign(p, v, q)).toBe(1); // left
    expect(concentric(400, turnSign(p, v, q), +W)).toBe(400 + W); // express on the right: outside
    expect(concentric(400, turnSign(p, v, q), -W)).toBe(400 - W); // on the left: inside
    expect(concentric(0, 1, W)).toBe(0);
    expect(turnSign(p, v, { x: 1000, y: 0 })).toBe(0);
  });

  it('3. a free/free quad with a 60° turn is parallel at w ± 0.1 m everywhere, arcs included', () => {
    const turn = (60 * Math.PI) / 180;
    const { net, r } = freeFree([P(0, 0), P(1500, 0), P(1500 + 1500 * Math.cos(turn), 1500 * Math.sin(turn))]);
    expect(r.ok).toBe(true);
    expect(allOk(net, r.edges)).toEqual([]);
    const pts = samples(net, r.local, 200);
    expect(pts.length).toBe(200);
    for (const s of pts) {
      const d = distToEdges(net, r.express, s.x, s.y);
      expect(Math.abs(d - W)).toBeLessThan(0.1);
    }
    // The express pair is on the outside of the left turn: 9 m more radius.
    const v = net.nodes.get(nodeAt(net, 1500, 0))!;
    const t = net.nodes.get(v.twin!)!;
    expect(t.r - v.r).toBeCloseTo(W, 6);
  });

  it('4. side: the express pair is on the right for side 1 and on the left for side −1', () => {
    for (const side of [1, -1] as const) {
      const { net, r } = freeFree([P(0, 0), P(800, 600)], side);
      expect(r.ok).toBe(true);
      const g = net.geom(r.local[1]);
      const s = sampleAt(g.xs, g.ys, g.cum, g.length / 2);
      const x = partnerPoint(net, r.local[1], g.length / 2)!;
      const cross = s.hx * (x.y - s.y) - s.hy * (x.x - s.x); // > 0: left of travel
      expect(Math.sign(cross)).toBe(-side);
      expect(Math.hypot(x.x - s.x, x.y - s.y)).toBeCloseTo(W, 3);
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('quad strokes', () => {
  it('5. free/free straight: two chains, two scissors, one group, sides, twins, degree ≤ 3, 8 locks', () => {
    const game = stubGame();
    const net = game.network;
    const r = addQuadStroke(net, [P(0, 0), P(2000, 0)], 'heavy', none, none, { side: 1 });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(allOk(net, r.edges)).toEqual([]);
    expect(r.links.length).toBe(12);
    expect(r.double).toEqual([]);
    expect(new Set(r.edges).size).toBe(net.edges.size);
    for (const e of net.edges.values()) expect(e.quad?.g).toBe(r.group);
    for (const id of r.local) expect(net.edges.get(id)!.quad).toEqual({ g: r.group, role: 'local', away: -1 });
    for (const id of r.express) expect(net.edges.get(id)!.quad).toEqual({ g: r.group, role: 'express', away: 1 });
    for (const id of r.links) expect(net.edges.get(id)!.quad).toEqual({ g: r.group, role: 'link', away: 0 });
    // The local pair runs along y = 0, the express pair at y = −w (right of +x).
    for (const id of r.express) for (const y of net.geom(id).ys) expect(y).toBeCloseTo(-W, 6);
    for (const n of net.nodes.values()) {
      if (n.twin !== undefined) expect(net.nodes.get(n.twin)!.twin).toBe(n.id);
      expect(net.degree(n.id)).toBeLessThanOrEqual(3);
    }
    // Each connector is 40 + 70.5 + 40 m with r ≈ 551 m.
    const lens = r.links.map((id) => net.geom(id).length).sort((a, b) => a - b);
    expect(lens.filter((l) => Math.abs(l - 40) < 0.1).length).toBe(8);
    expect(lens.filter((l) => Math.abs(l - 70.5) < 0.2).length).toBe(4);
    expect(compileNetwork(game).net.lockCount).toBe(8);
  });

  it('6. fan start from a double-track end: a degree-3 junction, a fast turnout, both platforms reachable, 1 lock', () => {
    const game = stubGame();
    const net = game.network;
    net.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    const end = nodeAt(net, 0, 0);
    const r = addQuadStroke(net, [P(0, 0), P(3000, 0)], 'heavy', { kind: 'node', node: end }, none, { side: 1, autoCrossovers: false });
    expect(r.ok).toBe(true);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    expect(r.links.length).toBe(3);
    expect(r.double.length).toBeGreaterThan(0);
    for (const id of r.double) expect(net.edges.get(id)!.quad).toBeUndefined();
    const J = net.edges.get(r.links[0])!.a;
    expect(net.degree(J)).toBe(3);
    expect(net.nodes.get(J)!.anchor).toBe(true);
    let minR = Infinity, minV = Infinity;
    for (const id of r.links) {
      const rep = edgeReport(net, id, dry);
      minR = Math.min(minR, rep.minRadius);
      minV = Math.min(minV, rep.speedLimit);
    }
    expect(minR).toBeGreaterThanOrEqual(500);
    expect(minV).toBeGreaterThanOrEqual(22);
    expect(curveSpeed(minR)).toBeCloseTo(minV, 6);
    const s0 = net.addStation(net.edges.get([...net.edges.values()].find((e) => !e.quad && net.geom(e.id).length > 1000)!.id)!.id, 1000, 8, 'Approach').id;
    const loc = r.local.find((id) => net.geom(id).length > 1500)!;
    const exp = r.express.find((id) => net.geom(id).length > 1500)!;
    const sl = net.addStation(loc, 1200, 8, 'Local').id;
    const sx = net.addStation(exp, 1200, 8, 'Express').id;
    for (const stops of [[s0, sl], [s0, sx], [sx, s0]]) expect(findRoutePath(net, 'heavy', stops).ok).toBe(true);
    const px = findRoutePath(net, 'heavy', [s0, sx]);
    expect(px.legs.some((l) => r.links.includes(l.edge))).toBe(true);
    expect(compileNetwork(game).net.lockCount).toBe(1);
  });

  it('7. fan at both ends: 2 locks; an express-platform route uses no local edge between the turnouts', () => {
    const game = stubGame();
    const net = game.network;
    net.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    net.addStroke([P(5000, 0), P(7000, 0)], 'heavy', none, none);
    const a = nodeAt(net, 0, 0), b = nodeAt(net, 5000, 0);
    const r = addQuadStroke(net, [P(0, 0), P(2500, 300), P(5000, 0)], 'heavy', { kind: 'node', node: a }, { kind: 'node', node: b }, { side: -1 });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    expect(r.links.length).toBe(6);
    expect(compileNetwork(game).net.lockCount).toBe(2);
    const approach = [...net.edges.values()].find((e) => !e.quad && net.nodes.get(e.a)!.x < -100)!;
    const exit = [...net.edges.values()].find((e) => !e.quad && net.nodes.get(e.b)!.x > 6000)!;
    const sA = net.addStation(approach.id, 1000, 8, 'A').id;
    const sE = net.addStation(exit.id, 1000, 8, 'E').id;
    const longX = r.express.reduce((m, id) => (net.geom(id).length > net.geom(m).length ? id : m));
    const sX = net.addStation(longX, net.geom(longX).length / 2, 8, 'X').id;
    const path = findRoutePath(net, 'heavy', [sA, sX, sE]);
    expect(path.ok).toBe(true);
    for (const l of path.legs) expect(net.edges.get(l.edge)!.quad?.role).not.toBe('local');
    expect(path.legs.some((l) => net.edges.get(l.edge)!.quad?.role === 'express')).toBe(true);
  });

  it('8. continue: no new connectors at the joint, the group and side are kept even with F flipped', () => {
    const net = new Network();
    const r1 = addQuadStroke(net, [P(0, 0), P(2000, 0)], 'heavy', none, none, { side: 1 });
    expect(r1.ok).toBe(true);
    const N = nodeAt(net, 2000, 0);
    expect(quadEndPartner(net, N)?.partner).toBe(nodeAt(net, 2000, -W));
    const r2 = addQuadStroke(net, [P(2000, 0), P(3000, 0), P(4000, 500)], 'heavy', { kind: 'node', node: N }, none, { side: -1 });
    expect(r2.ok).toBe(true);
    expect(r2.group).toBe(r1.group);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    // The only new connectors are the free far end's scissors.
    expect(r2.links.length).toBe(6);
    for (const id of r2.links) expect(net.nodes.get(net.edges.get(id)!.a)!.x).toBeGreaterThan(3000);
    const Pn = nodeAt(net, 2000, -W);
    expect(net.degree(Pn)).toBe(2);
    expect(net.degree(N)).toBe(2);
    // The new express pair carries on at y = −w (the old side), not on the flipped side.
    const firstX = net.geom(r2.express[0]);
    for (const y of firstX.ys) expect(y).toBeCloseTo(-W, 3);
    for (const id of r2.local) expect(net.edges.get(id)!.quad!.role).toBe('local');
    for (const id of r2.express) expect(net.edges.get(id)!.quad!.role).toBe('express');
    const pts = samples(net, r2.local, 100);
    for (const s of pts) expect(Math.abs(distToEdges(net, r2.express, s.x, s.y) - W)).toBeLessThan(0.1);
    // Drawing from the express end continues the express pair (its twin is the local pair).
    const far = nodeAt(net, ...([4000, 500] as [number, number]));
    const farX = quadEndPartner(net, far)!.partner;
    const r3 = addQuadStroke(net, [P(net.nodes.get(farX)!.x, net.nodes.get(farX)!.y), P(5500, 1400)], 'heavy', { kind: 'node', node: farX }, none, { side: 1 });
    expect(r3.ok).toBe(true);
    expect(r3.group).toBe(r1.group);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    for (const id of r3.express) expect(net.edges.get(id)!.quad!.role).toBe('express');
  });

  it('8b. a stroke continuing two quads joins their groups', () => {
    const net = new Network();
    const r1 = addQuadStroke(net, [P(0, 0), P(1500, 0)], 'heavy', none, none, { side: 1 });
    const r2 = addQuadStroke(net, [P(3000, 0), P(4500, 0)], 'heavy', none, none, { side: 1 });
    expect(r1.group).not.toBe(r2.group);
    const a = nodeAt(net, 1500, 0), b = nodeAt(net, 3000, 0);
    const r = addQuadStroke(net, [P(1500, 0), P(3000, 0)], 'heavy', { kind: 'node', node: a }, { kind: 'node', node: b }, { side: 1 });
    expect(r.ok).toBe(true);
    expect(r.links).toEqual([]);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    expect(new Set([...net.edges.values()].map((e) => e.quad?.g))).toEqual(new Set([r1.group]));
    // Joining an end to the other pair's end, or ends on opposite sides, is refused.
    const net2 = new Network();
    addQuadStroke(net2, [P(0, 0), P(1500, 0)], 'heavy', none, none, { side: 1 });
    addQuadStroke(net2, [P(3000, 0), P(4500, 0)], 'heavy', none, none, { side: -1 });
    const before = JSON.stringify(net2.toData());
    const bad = addQuadStroke(net2, [P(1500, 0), P(3000, 0)], 'heavy', { kind: 'node', node: nodeAt(net2, 1500, 0) }, { kind: 'node', node: nodeAt(net2, 3000, 0) }, { side: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.fatal).toMatch(/opposite sides/);
    expect(JSON.stringify(net2.toData())).toBe(before);
  });

  it('9. refuses a fan into a zig-zag ("straight") and a 120 m quad ("Too short"), leaving the network as it was', () => {
    const net = new Network();
    net.addStroke([P(-2000, 0), P(0, 0)], 'heavy', none, none);
    const before = JSON.stringify(net.toData());
    const zig: StrokePoint[] = [P(0, 0)];
    for (let i = 1; i <= 16; i++) zig.push(P(i * 150, i % 2 ? 60 : 0));
    const r = addQuadStroke(net, zig, 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, none, { side: 1 });
    expect(r.ok).toBe(false);
    expect(r.fatal).toMatch(/straight/);
    expect(r.fatal).toContain('190 m');
    expect(JSON.stringify(net.toData())).toBe(before);
    const short = addQuadStroke(net, [P(0, 500), P(120, 500)], 'heavy', none, none, { side: 1 });
    expect(short.ok).toBe(false);
    expect(short.fatal).toMatch(/Too short/);
    expect(JSON.stringify(net.toData())).toBe(before);
    // Messages follow the units setting.
    setUnits('imperial');
    const r2 = addQuadStroke(net, zig, 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, none, { side: 1 });
    expect(r2.fatal).toContain('623 ft');
    setUnits('metric');
  });

  it('10. a deep → elevated quad ramps both pairs; express ×0.75 and connectors ×0.5 of ordinary track', () => {
    const { net, r } = freeFree([P(0, 0, 'deep'), P(1500, 0, 'deep'), P(2600, 0, 'elevated'), P(4000, 0, 'elevated')]);
    expect(r.ok).toBe(true);
    expect(allOk(net, r.edges)).toEqual([]);
    const ramps = (ids: number[]) => ids.filter((id) => net.isRamp(id));
    expect(ramps(r.local).length).toBe(1);
    expect(ramps(r.express).length).toBe(1);
    const [lr] = ramps(r.local), [xr] = ramps(r.express);
    const lv = (id: number) => [net.nodes.get(net.edges.get(id)!.a)!.level, net.nodes.get(net.edges.get(id)!.b)!.level];
    expect(lv(xr)).toEqual(lv(lr));
    expect(lv(lr)).toEqual(['deep', 'elevated']);
    const cl = edgeReport(net, lr, dry), cx = edgeReport(net, xr, dry);
    expect(cx.length).toBeCloseTo(cl.length, 3);
    expect(cx.cost / cl.cost).toBeGreaterThan(0.75 * 0.98);
    expect(cx.cost / cl.cost).toBeLessThan(0.75 * 1.02);
    // A connector costs half of the same track untagged.
    const link = r.links[1];
    const plain = net.clone();
    delete plain.edges.get(link)!.quad;
    expect(edgeReport(net, link, dry).cost / edgeReport(plain, link, dry).cost).toBeCloseTo(QUAD.linkCostFactor, 9);
    // The local pair costs exactly what ordinary track does.
    const local = r.local[2];
    const plainL = net.clone();
    delete plainL.edges.get(local)!.quad;
    expect(edgeReport(net, local, dry).cost).toBe(edgeReport(plainL, local, dry).cost);
    expect(quadLabel(net.edges.get(xr)!)).toMatch(/Express pair/);
    expect(quadLabel(net.edges.get(lr)!)).toBe('Local pair');
    expect(quadLabel(plainL.edges.get(local)!)).toBeNull();
  });

  it('11. dragging a vertex drags its twin (mitre distance and concentric radius kept); refused when the twin is built', () => {
    const { net, r } = freeFree([P(0, 0), P(1500, 0), P(2500, 900)]);
    expect(r.ok).toBe(true);
    const V = nodeAt(net, 1500, 0);
    expect(net.moveNode(V, 1530, 60)).toBe(true);
    const v = net.nodes.get(V)!, t = net.nodes.get(v.twin!)!;
    const [e0, e1] = net.incident(V).map((id) => net.edges.get(id)!);
    const p = net.nodes.get(e0.a === V ? e0.b : e0.a)!, q = net.nodes.get(e1.a === V ? e1.b : e1.a)!;
    const [pp, qq] = p.x < q.x ? [p, q] : [q, p];
    const m = mitre(pp, v, qq, W)!; // express on the right of travel (+x)
    expect(Math.hypot(t.x - m.x, t.y - m.y)).toBeLessThan(0.1);
    expect(Math.abs(t.r - concentric(v.r, turnSign(pp, v, qq), W))).toBeLessThan(0.1);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    for (const s of samples(net, r.local, 120)) {
      const d = distToEdges(net, [...net.edges.values()].filter((e) => e.quad?.role === 'express').map((e) => e.id), s.x, s.y);
      expect(Math.abs(d - W)).toBeLessThan(0.1);
    }
    // A free end drags its partner end along too.
    const end = nodeAt(net, 0, 0);
    expect(net.moveNode(end, -100, 0)).toBe(true);
    const te = net.nodes.get(net.nodes.get(end)!.twin!)!;
    expect(te.y).toBeCloseTo(-W, 6);
    expect(te.x).toBeCloseTo(net.nodes.get(end)!.x, 6);
    // Once the express pair is built, the local vertex can't move.
    for (const e of net.edges.values()) if (e.quad?.role === 'express') e.status = 'built';
    expect(net.moveNode(V, 1500, 0)).toBe(false);
  });

  it('12. a stroke on a clone leaves the original untouched; toData → load round-trips tags, twins and pairs', () => {
    const net = new Network();
    const r1 = addQuadStroke(net, [P(0, 0), P(2000, 0)], 'heavy', none, none, { side: 1 });
    const loc = r1.local.find((id) => net.geom(id).length > 1000)!;
    const [a] = net.addStationPair(loc, 800, partnerPoint(net, loc, 800)!.edge, partnerPoint(net, loc, 800)!.u, 8, 'Pair');
    const before = JSON.stringify(net.toData());
    const tags = new Map([...net.edges.values()].map((e) => [e.id, e.quad]));
    const c = net.clone();
    const r2 = addQuadStroke(c, [P(2000, 0), P(3500, 0)], 'heavy', { kind: 'node', node: nodeAt(c, 2000, 0) }, none, { side: 1 });
    expect(r2.ok).toBe(true);
    relabelEverything(c, 999);
    expect(JSON.stringify(net.toData())).toBe(before);
    for (const e of net.edges.values()) {
      expect(e.quad).toBe(tags.get(e.id));
      expect(c.edges.get(e.id)?.quad).not.toBe(e.quad);
    }
    // Round trip.
    const d: NetworkData = JSON.parse(JSON.stringify(net.toData()));
    const back = Network.fromData(d);
    expect(JSON.stringify(back.toData())).toBe(before);
    expect(back.stations.get(a.id)!.pair).toBe(net.stations.get(a.id)!.pair);
    expect([...back.nodes.values()].filter((n) => n.twin !== undefined).length).toBe(4);
    // A plain network's data is exactly as before (no new keys).
    const plain = new Network();
    plain.addStroke([P(0, 0), P(1000, 0)], 'heavy', none, none);
    plain.addStation([...plain.edges.keys()][0], 500, 8, 'S');
    const pd = plain.toData();
    expect(pd.edges.every((e) => !('quad' in e))).toBe(true);
    expect(pd.nodes.every((n) => !('twin' in n))).toBe(true);
    expect(pd.stations.every((s) => !('pair' in s))).toBe(true);
  });

  it('12b. load drops dangling and one-way twins and pairs and malformed tags', () => {
    const net = new Network();
    addQuadStroke(net, [P(0, 0), P(2000, 0)], 'heavy', none, none, { side: 1 });
    const d = net.toData();
    const tw = d.nodes.filter((n) => n.twin !== undefined);
    const partnerOf0 = tw[0].twin!;
    tw[0].twin = 99999; // dangling, which leaves its old partner pointing one way
    const e0 = d.edges[0];
    (e0 as { quad?: unknown }).quad = { g: 1, role: 'banana', away: 1 };
    const e1 = d.edges[1];
    e1.quad = { ...e1.quad!, away: 0 };
    d.stations.push({ id: 5000, edge: d.edges[2].id, u: 10, cars: 8, name: 'X', nameAuto: false, status: 'blueprint', buildStart: 0, buildEnd: 0, cost: 0, pair: 5001 });
    const back = Network.fromData(d);
    expect(back.nodes.get(tw[0].id)!.twin).toBeUndefined();
    expect(back.nodes.get(partnerOf0)!.twin).toBeUndefined();
    const intact = tw.find((n) => n.id !== tw[0].id && n.id !== partnerOf0)!;
    expect(back.nodes.get(intact.id)!.twin).toBe(intact.twin);
    expect(back.edges.get(e0.id)!.quad).toBeUndefined();
    expect(back.edges.get(e1.id)!.quad).toBeDefined();
    expect(back.stations.get(5000)!.pair).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------
// Review fixes: the shared-works price needs the other pair, drags beside a fan, load sanitising
// of tags, twins and pairs, and putting a bulldozed stretch of one pair back.
describe('four-track repairs and guards', () => {
  it('the express pair pays ×0.75 only where the local pair runs alongside; connectors only while both pairs exist', () => {
    const net = new Network();
    const r = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    expect(r.ok).toBe(true);
    const plainCost = (id: number) => {
      const c = net.clone();
      for (const e of c.edges.values()) delete e.quad;
      return edgeReport(c, id, dry).cost;
    };
    const ratio = (id: number) => edgeReport(net, id, dry).cost / plainCost(id);
    for (const id of r.express) {
      expect(partnerCoverage(net, id)).toBe(1);
      expect(ratio(id)).toBeCloseTo(QUAD.secondPairCostFactor, 9);
    }
    // Bulldoze the long local edge in the middle (blueprints go for free): the express edge beside
    // it is plain double track now and is priced like it.
    const mid = r.local.reduce((a, b) => (net.geom(a).length >= net.geom(b).length ? a : b));
    const across = r.express.reduce((a, b) => (net.geom(a).length >= net.geom(b).length ? a : b));
    net.removeEdge(mid);
    expect(partnerCoverage(net, across)).toBe(0);
    expect(ratio(across)).toBeCloseTo(1, 9);
    // The rest of the local pair still runs beside the short express edges near the ends.
    const short = r.express.find((id) => id !== across && net.edges.has(id) && partnerCoverage(net, id) === 1);
    expect(short).toBeDefined();
    expect(ratio(short!)).toBeCloseTo(QUAD.secondPairCostFactor, 9);
    // Every local edge gone: connectors pay full price too.
    for (const id of r.local) net.removeEdge(id);
    const link = r.links.find((id) => net.edges.has(id));
    if (link !== undefined) expect(ratio(link)).toBeCloseTo(1, 9);
    for (const id of r.express) if (net.edges.has(id)) expect(ratio(id)).toBeCloseTo(1, 9);
  });

  it('half the local pair gone: the express edge pays for the share with no partner (prorated)', () => {
    const net = new Network();
    net.addStroke([P(-1000, 0), P(0, 0)], 'heavy', none, none);
    net.addStroke([P(5000, 0), P(6000, 0)], 'heavy', none, none);
    const r = addQuadStroke(net, [P(0, 0), P(5000, 0)], 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, { kind: 'node', node: nodeAt(net, 5000, 0) }, { side: 1 });
    expect(r.ok).toBe(true);
    const x = r.express.reduce((a, b) => (net.geom(a).length >= net.geom(b).length ? a : b));
    const before = edgeReport(net, x, dry).cost;
    // Split the local pair at its middle and drop one half.
    const hit = locateTagged(net, r.group, 'local', { x: 2500, y: 0 })!;
    net.splitEdge(hit.edge, hit.u);
    const half = locateTagged(net, r.group, 'local', { x: 2000, y: 0 })!;
    net.removeEdge(half.edge);
    const share = partnerCoverage(net, x);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.8);
    expect(edgeReport(net, x, dry).cost / before).toBeCloseTo((1 - (1 - QUAD.secondPairCostFactor) * share) / QUAD.secondPairCostFactor, 9);
  });

  it('dragging a vertex next to a fan turnout keeps the express pair straight and parallel there', () => {
    const net = new Network();
    net.addStroke([P(-1000, 0), P(0, 0)], 'heavy', none, none);
    const r = addQuadStroke(net, [P(0, 0), P(900, 0), P(1900, 500)], 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, none, { side: 1 });
    expect(r.ok).toBe(true);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    const corner = nodeAt(net, 900, 0);
    // Between the fan's junction and the free end's scissors: it slides along the fan junction's
    // axis (both pairs leave the fan straight), and its twin follows.
    expect(net.quadDragBlock(corner)).toBeNull();
    expect(net.moveNode(corner, 930, 80)).toBe(true);
    expect(net.nodes.get(corner)!.y).toBeCloseTo(0, 6);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    // Parallel along the whole express pair (its first edge from the turnout's end included).
    for (const s of samples(net, r.express, 200)) {
      const o = { x: s.x - W * s.hy, y: s.y + W * s.hx };
      expect(distToEdges(net, r.local, o.x, o.y)).toBeLessThan(0.5);
    }
    for (const id of r.express) expect(partnerCoverage(net, id)).toBe(1);
  });

  it('a vertex pinned between two fans cannot move (with a reason); other drags beside a fan stay valid', () => {
    const net = new Network();
    net.addStroke([P(-1000, 0), P(0, 0)], 'heavy', none, none);
    net.addStroke([P(1900, 500), P(2900, 1000)], 'heavy', none, none);
    const r = addQuadStroke(net, [P(0, 0), P(900, 0), P(1900, 500)], 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, { kind: 'node', node: nodeAt(net, 1900, 500) }, { side: 1 });
    expect(r.ok).toBe(true);
    const corner = nodeAt(net, 900, 0);
    expect(net.quadDragBlock(corner)).toBe('pinned');
    const before = net.toData();
    expect(net.moveNode(corner, 930, 80)).toBe(false);
    expect(net.toData()).toEqual(before);
    // Its twin on the express pair is pinned the same way.
    expect(net.quadDragBlock(net.nodes.get(corner)!.twin!)).toBe('pinned');
  });

  it('a fillet dragged close to a fan shrinks to fit the other pair, so the pairs stay parallel', () => {
    const net = new Network();
    net.addStroke([P(-1000, 0), P(0, 0)], 'heavy', none, none);
    const r = addQuadStroke(net, [P(0, 0), P(900, 0), P(1900, 500), P(3500, 500)], 'heavy', { kind: 'node', node: nodeAt(net, 0, 0) }, none, { side: 1 });
    expect(r.ok).toBe(true);
    const corner = nodeAt(net, 900, 0);
    // About 190 m past the turnout's far end: the drawn fillet would overrun the express chord.
    expect(net.moveNode(corner, 400, 0)).toBe(true);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    for (const s of samples(net, r.express, 200)) {
      const o = { x: s.x - W * s.hy, y: s.y + W * s.hx };
      expect(distToEdges(net, r.local, o.x, o.y)).toBeLessThan(0.5);
    }
  });

  it('load drops pair tags without a side, and twins and cross-platform pairs that make no geometric sense', () => {
    const net = new Network();
    addQuadStroke(net, [P(0, 0), P(2000, 0)], 'heavy', none, none, { side: 1 });
    net.addStroke([P(0, 3000), P(7000, 3000)], 'heavy', none, none);
    const d = net.toData();
    const plainEdge = d.edges.find((e) => !e.quad)!;
    // A pair tag with away 0 on plain track, and two platforms 7 km apart linked as a pair.
    plainEdge.quad = { g: 999, role: 'express', away: 0 };
    d.stations.push(
      { id: 6000, edge: plainEdge.id, u: 500, cars: 8, name: 'W', nameAuto: false, status: 'built', buildStart: 0, buildEnd: 0, cost: 0, pair: 6001 },
      { id: 6001, edge: plainEdge.id, u: 6500, cars: 8, name: 'E', nameAuto: false, status: 'built', buildStart: 0, buildEnd: 0, cost: 0, pair: 6000 },
    );
    // Two real platforms opposite each other stay a pair.
    const loc = d.edges.find((e) => e.quad?.role === 'local' && e.b !== undefined)!;
    const tmp = Network.fromData(d);
    const at = tmp.geom(loc.id).length / 2;
    const pp = partnerPoint(tmp, loc.id, at)!;
    d.stations.push(
      { id: 6002, edge: loc.id, u: at, cars: 8, name: 'L', nameAuto: false, status: 'built', buildStart: 0, buildEnd: 0, cost: 0, pair: 6003 },
      { id: 6003, edge: pp.edge, u: pp.u, cars: 8, name: 'L', nameAuto: false, status: 'built', buildStart: 0, buildEnd: 0, cost: 0, pair: 6002 },
    );
    // A twin link between nodes kilometres apart.
    const tw = d.nodes.filter((n) => n.twin !== undefined);
    const far = d.nodes.find((n) => n.twin === undefined && Math.hypot(n.x - tw[0].x, n.y - tw[0].y) > 1000)!;
    const oldPartner = tw[0].twin!;
    tw[0].twin = far.id;
    far.twin = tw[0].id;
    d.nodes.find((n) => n.id === oldPartner)!.twin = undefined;
    const back = Network.fromData(d);
    expect(back.edges.get(plainEdge.id)!.quad).toBeUndefined();
    expect(back.stations.get(6000)!.pair).toBeUndefined();
    expect(back.stations.get(6001)!.pair).toBeUndefined();
    expect(back.stations.get(6002)!.pair).toBe(6003);
    expect(back.stations.get(6003)!.pair).toBe(6002);
    expect(back.nodes.get(tw[0].id)!.twin).toBeUndefined();
    expect(back.nodes.get(far.id)!.twin).toBeUndefined();
  });

  it('four tracks from one end of a bulldozed gap to the other rebuild that stretch exactly', () => {
    for (const role of ['express', 'local'] as const) {
      const game = stubGame();
      const net = game.network;
      const r = addQuadStroke(net, [P(0, 0), P(1500, 0), P(2400, 900), P(3500, 900)], 'heavy', none, none, { side: 1 });
      expect(r.ok).toBe(true);
      game.build(true);
      // The edge through the 45° bend's far side: both ends are curve vertices with fillets.
      const list = role === 'express' ? r.express : r.local;
      const victim = list.find((id) => {
        const e = net.edges.get(id)!;
        return net.nodes.get(e.a)!.twin !== undefined && net.nodes.get(e.b)!.twin !== undefined && net.nodes.get(e.a)!.r > 0;
      })!;
      const e = net.edges.get(victim)!;
      const len = net.geom(victim).length;
      const radii = [net.nodes.get(e.a)!.r, net.nodes.get(e.b)!.r];
      const [a, b] = [e.a, e.b];
      expect(game.bulldozeEdge(victim).ok).toBe(true);
      expect(isGapEnd(net, a) && isGapEnd(net, b)).toBe(true);
      expect(gapTag(net, a)).toEqual({ g: r.group, role });
      const res = game.editBlueprint(() => addQuadStroke(net, [P(net.nodes.get(a)!.x, net.nodes.get(a)!.y), P(net.nodes.get(b)!.x, net.nodes.get(b)!.y)], 'heavy', { kind: 'node', node: a }, { kind: 'node', node: b }, { side: 1 }));
      expect(res.ok).toBe(true);
      expect(res.edges.length).toBe(1);
      const n = res.edges[0];
      expect(net.edges.get(n)!.quad).toEqual({ g: r.group, role, away: role === 'express' ? 1 : -1 });
      expect(net.geom(n).length).toBeCloseTo(len, 6);
      expect([net.nodes.get(a)!.r, net.nodes.get(b)!.r]).toEqual(radii);
      expect(partnerCoverage(net, n)).toBe(1);
      expect(allOk(net, [...net.edges.keys()])).toEqual([]);
      // Now there is no gap: another repair is refused.
      expect(repairPair(net, a, b, 'heavy').ok).toBe(false);
    }
  });

  it('two tracks drawn along a gap take the pair\'s tag where they run beside the other pair', () => {
    const game = stubGame();
    const net = game.network;
    const r = addQuadStroke(net, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    game.build(true);
    const victim = r.express.reduce((x, y) => (net.geom(x).length >= net.geom(y).length ? x : y));
    const e = net.edges.get(victim)!;
    const [a, b] = [e.a, e.b];
    expect(game.bulldozeEdge(victim).ok).toBe(true);
    const tag = gapTag(net, a)!;
    expect(tag).toEqual(gapTag(net, b));
    const ids = net.addStroke([P(net.nodes.get(a)!.x, net.nodes.get(a)!.y), P(net.nodes.get(b)!.x, net.nodes.get(b)!.y)], 'heavy', { kind: 'node', node: a }, { kind: 'node', node: b });
    expect(rejoinPair(net, tag, ids)).toBe(ids.length);
    for (const id of ids) {
      expect(net.edges.get(id)!.quad).toEqual({ g: r.group, role: 'express', away: 1 });
      expect(partnerCoverage(net, id)).toBe(1);
    }
    // A stroke that wanders off the other pair stays ordinary track.
    const game2 = stubGame();
    const net2 = game2.network;
    const r2 = addQuadStroke(net2, [P(0, 0), P(6000, 0)], 'heavy', none, none, { side: 1 });
    game2.build(true);
    const v2 = r2.express.reduce((x, y) => (net2.geom(x).length >= net2.geom(y).length ? x : y));
    const e2 = net2.edges.get(v2)!;
    const [a2, b2] = [net2.nodes.get(e2.a)!, net2.nodes.get(e2.b)!];
    expect(game2.bulldozeEdge(v2).ok).toBe(true);
    const tag2 = gapTag(net2, a2.id)!;
    const ids2 = net2.addStroke([P(a2.x, a2.y), P((a2.x + b2.x) / 2, -600), P(b2.x, b2.y)], 'heavy', { kind: 'node', node: a2.id }, { kind: 'node', node: b2.id });
    rejoinPair(net2, tag2, ids2);
    expect(ids2.some((id) => !net2.edges.get(id)!.quad)).toBe(true);
  });
});

function relabelEverything(net: Network, g: number): void {
  for (const e of net.edges.values()) if (e.quad) e.quad = { ...e.quad, g };
}

// ------------------------------------------------------------------------------------------
describe('crossovers', () => {
  it('13. a scissors mid-span: four 40 + 70.5 + 40 m connectors; trains can switch pairs both ways', () => {
    const game = stubGame();
    const net = game.network;
    const r = addQuadStroke(net, [P(0, 0), P(3000, 0)], 'heavy', none, none, { side: 1, autoCrossovers: false });
    expect(r.ok).toBe(true);
    expect(r.links).toEqual([]);
    const [L] = r.local, [X] = r.express;
    const sLw = net.addStation(L, 400, 8, 'Lw').id;
    const sXw = net.addStation(X, 400, 8, 'Xw').id;
    const sLe = net.addStation(L, 2600, 8, 'Le').id;
    const sXe = net.addStation(X, 2600, 8, 'Xe').id;
    expect(findRoutePath(net, 'heavy', [sLw, sXe]).ok).toBe(false);
    const res = addScissors(net, r.group, L, 1425, 1575, 'heavy');
    expect(res.ok).toBe(true);
    expect(res.links.length).toBe(6);
    const lens = res.links.map((id) => net.geom(id).length);
    [40, 70.5, 40, 40, 70.5, 40].forEach((want, i) => expect(Math.abs(lens[i] - want)).toBeLessThan(0.2));
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    for (const stops of [[sLw, sXe], [sXw, sLe], [sXe, sLw], [sLe, sXw]]) {
      const p = findRoutePath(net, 'heavy', stops);
      expect(p.ok).toBe(true);
      expect(p.legs.some((l) => res.links.includes(l.edge))).toBe(true);
    }
    // A local route stays on its pair (shorter than through the crossovers).
    const pl = findRoutePath(net, 'heavy', [sLw, sLe]);
    expect(pl.legs.every((l) => net.edges.get(l.edge)!.quad!.role === 'local')).toBe(true);
    expect(compileNetwork(game).net.lockCount).toBe(4);
  });

  it('14. a scissors over a platform is refused; scissorsCandidate slides clear of it', () => {
    const { net, r } = freeFree([P(0, 0), P(3000, 0)], 1, false);
    const [L] = r.local;
    net.addStation(L, 1500, 8, 'Mid');
    const before = JSON.stringify(net.toData());
    const res = addScissors(net, r.group, L, 1425, 1575, 'heavy');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('Crossovers need straight, level track clear of platforms');
    expect(JSON.stringify(net.toData())).toBe(before);
    const c = scissorsCandidate(net, L, 1500, 'heavy');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const P2 = (8 * 18 + STATION.platformMargin) / 2 + 10;
    expect(c.uA > 1500 + P2 || c.uB < 1500 - P2).toBe(true);
    expect(Math.abs((c.uA + c.uB) / 2 - 1500)).toBeLessThanOrEqual(300);
    expect(addScissors(net, c.g, c.edge, c.uA, c.uB, 'heavy').ok).toBe(true);
    expect(allOk(net, [...net.edges.keys()])).toEqual([]);
    // Ordinary track has no crossover candidates.
    const plain = new Network();
    const [e] = plain.addStroke([P(0, 0), P(1000, 0)], 'heavy', none, none);
    expect(scissorsCandidate(plain, e, 500, 'heavy').ok).toBe(false);
  });

  it('findStraight searches from either end, skips curves and stays within the search distance', () => {
    const net = new Network();
    const ids = net.addStroke([P(0, 0), P(1000, 0), P(1000, 1000)], 'heavy', none, none);
    const legs = ids.map((edge) => ({ edge, dir: 0 as const }));
    const s = findStraight(net, legs, 'start', 150, 'heavy')!;
    expect(s.leg).toBe(0);
    expect(s.uJ).toBeCloseTo(20, 6);
    expect(s.uX).toBeCloseTo(170, 6);
    const e = findStraight(net, legs, 'end', 150, 'heavy')!;
    expect(e.leg).toBe(1);
    expect(net.geom(e.edge).length - e.uJ).toBeCloseTo(20, 6);
    expect(e.uJ - e.uX).toBeCloseTo(150, 6);
    // Backwards legs (b→a in travel order) search from the right end.
    const back = [...legs].reverse().map((l) => ({ edge: l.edge, dir: 1 as const }));
    const b = findStraight(net, back, 'start', 150, 'heavy')!;
    expect(b.edge).toBe(ids[1]);
    expect(net.geom(b.edge).length - b.uJ).toBeCloseTo(20, 6);
    // Nothing straight enough within the search distance.
    expect(findStraight(net, legs, 'start', 2000, 'heavy')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
describe('cross-platform stations', () => {
  it('23. addStationPair links two platforms; both valid despite the crossover; each 0.8× a lone platform', () => {
    const { net, r } = freeFree([P(0, 0), P(3000, 0)]);
    expect(r.links.length).toBe(12);
    const L = r.local.find((id) => net.geom(id).length > 1000)!;
    const u = 600;
    const x = partnerPoint(net, L, u)!;
    const [a, b] = net.addStationPair(L, u, x.edge, x.u, 8, '72 St');
    expect(a.pair).toBe(b.id);
    expect(b.pair).toBe(a.id);
    expect(a.name).toBe(b.name);
    const single = stationCost('deep', 8, 'heavy');
    for (const s of [a, b]) {
      const rep = stationReport(net, s.edge, s.u, s.cars, dry, s.id);
      expect(rep.errors).toEqual([]);
      expect(rep.cost).toBeCloseTo(single * QUAD.pairPlatformCostShare, 3);
    }
    // Without the pairing the partner (≈ 160 m away through the scissors) would be too close.
    const lone = stationReport(net, a.edge, a.u, 8, dry, null, { partner: null });
    expect(lone.ok).toBe(false);
    expect(lone.errors[0]).toMatch(/Too close to 72 St/);
    // A previewed pair (nothing placed yet) is priced as a pair; a lone platform is priced as before.
    expect(stationReport(net, L, 1500, 8, dry, null, { paired: true }).cost).toBeCloseTo(single * QUAD.pairPlatformCostShare, 3);
    expect(stationReport(net, L, 1500, 8, dry).cost).toBe(single);
  });

  it('24 (network part). removing a platform, or its track, leaves the partner a lone platform; linkPair re-links', () => {
    const { net, r } = freeFree([P(0, 0), P(3000, 0)]);
    const L = r.local.find((id) => net.geom(id).length > 1000)!;
    const x = partnerPoint(net, L, 600)!;
    const [a, b] = net.addStationPair(L, 600, x.edge, x.u, 8, 'P');
    net.removeStation(a.id);
    expect(net.stations.get(b.id)!.pair).toBeUndefined();
    const c = net.addStation(L, 600, 8, 'P');
    net.linkPair(c.id, b.id);
    expect(net.stations.get(b.id)!.pair).toBe(c.id);
    const d = net.addStation(L, 1300, 8, 'Q');
    net.linkPair(d.id, b.id); // steals b: c becomes a lone platform
    expect(net.stations.get(c.id)!.pair).toBeUndefined();
    expect(net.stations.get(d.id)!.pair).toBe(b.id);
    net.removeEdge(net.stations.get(b.id)!.edge);
    expect(net.stations.has(b.id)).toBe(false);
    expect(net.stations.get(d.id)!.pair).toBeUndefined();
    for (const n of net.nodes.values()) if (n.twin !== undefined) expect(net.nodes.get(n.twin)?.twin).toBe(n.id);
  });

  it('splitEdge copies the tag to both halves as new objects; edgeBetween finds the edge either way round', () => {
    const { net, r } = freeFree([P(0, 0), P(3000, 0)], 1, false);
    const [L] = r.local;
    const tag = net.edges.get(L)!.quad!;
    const J = net.splitEdge(L, 1000);
    const halves = net.incident(J).map((id) => net.edges.get(id)!);
    expect(halves.length).toBe(2);
    for (const h of halves) {
      expect(h.quad).toEqual(tag);
      expect(h.quad).not.toBe(tag);
    }
    expect(halves[0].quad).not.toBe(halves[1].quad);
    const h = halves[0];
    expect(net.edgeBetween(h.a, h.b)).toBe(h.id);
    expect(net.edgeBetween(h.b, h.a)).toBe(h.id);
    expect(net.edgeBetween(h.a, h.a)).toBeNull();
    expect(locateTagged(net, r.group, 'local', { x: 2000, y: 0 })?.edge).toBe(halves.find((e) => net.nodes.get(e.b)!.x > 2500)!.id);
    expect(locateTagged(net, r.group, 'express', { x: 2000, y: 0 })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
describe('London: a four-track trunk in central London', () => {
  applyCity('london');
  const world = loadWorldFromDisk();
  const land = loadLandFromDisk();
  afterAll(() => {
    applyCity('nyc');
    setUnits('metric');
  });
  const pts = (ll: [number, number][], level: TrackLevel) =>
    ll.map(([lon, lat]) => {
      const [x, y] = toLocal(lon, lat);
      return { x, y, level };
    });

  it('runs a deep quad along the Oxford Street corridor over land, and under the Thames at deep level only', () => {
    applyCity('london');
    const game = createHeadlessGame(world, land, { sandbox: true });
    const net = game.network;
    // Marble Arch → Oxford Circus → Tottenham Court Road → Holborn → St Paul's → Bank.
    const corridor: [number, number][] = [[-0.1586, 51.5136], [-0.1415, 51.5152], [-0.1308, 51.5165], [-0.1200, 51.5174], [-0.0976, 51.5146], [-0.0886, 51.5133]];
    const r = addQuadStroke(net, pts(corridor, 'deep'), 'heavy', none, none, { side: 1 });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(allOk(net, r.edges, game.terrain)).toEqual([]);
    for (const id of r.edges) expect(edgeReport(net, id, game.terrain).waterLength).toBe(0);
    for (const s of samples(net, r.local, 200)) expect(Math.abs(distToEdges(net, r.express, s.x, s.y) - W)).toBeLessThan(0.1);
    const lc = r.local.reduce((s, id) => s + edgeReport(net, id, game.terrain).cost, 0);
    const xc = r.express.reduce((s, id) => s + edgeReport(net, id, game.terrain).cost, 0);
    const ll = r.local.reduce((s, id) => s + net.geom(id).length, 0);
    const xl = r.express.reduce((s, id) => s + net.geom(id).length, 0);
    expect(xc / xl / (lc / ll)).toBeCloseTo(QUAD.secondPairCostFactor, 2);
    // Cross-platform pair at Oxford Circus: both platforms valid on London's land, priced as a pair.
    const [ox, oy] = toLocal(-0.1415, 51.5152);
    const hit = locateTagged(net, r.group, 'local', { x: ox, y: oy }, 300)!;
    let placed = false;
    for (let k = 0; k < 40 && !placed; k++) {
      for (const sg of [1, -1]) {
        const u = hit.u + sg * k * 10;
        const x = partnerPoint(net, hit.edge, u);
        if (!x || !stationReport(net, hit.edge, u, 8, game.terrain, null, { paired: true }).ok || !stationReport(net, x.edge, x.u, 8, game.terrain, null, { paired: true }).ok) continue;
        const [a, b] = net.addStationPair(hit.edge, u, x.edge, x.u, 8, 'Oxford Circus');
        for (const s of [a, b]) expect(stationReport(net, s.edge, s.u, 8, game.terrain, s.id).ok).toBe(true);
        placed = true;
        break;
      }
    }
    expect(placed).toBe(true);

    // Bank → under the Thames → London Bridge → Borough: deep tunnel crosses, cut-and-cover can't.
    const south: [number, number][] = [[-0.0886, 51.5133], [-0.0877, 51.5050], [-0.0937, 51.5011]];
    const c2 = net.clone();
    const deep2 = addQuadStroke(c2, pts(south, 'deep'), 'heavy', none, none, { side: -1 });
    expect(deep2.ok).toBe(true);
    expect(allOk(c2, deep2.edges, game.terrain)).toEqual([]);
    const wl = (ids: number[]) => ids.reduce((s, id) => s + edgeReport(c2, id, game.terrain).waterLength, 0);
    expect(wl(deep2.local)).toBeGreaterThan(150);
    expect(wl(deep2.express)).toBeGreaterThan(150);
    const c3 = net.clone();
    const cc = addQuadStroke(c3, pts(south, 'cut-and-cover'), 'heavy', none, none, { side: -1 });
    expect(cc.ok).toBe(true); // construction is allowed; validation flags the water
    const bad = (ids: number[]) => ids.filter((id) => edgeReport(c3, id, game.terrain).errors.some((e) => /can't cross water/.test(e)));
    expect(bad(cc.local).length).toBeGreaterThan(0);
    expect(bad(cc.express).length).toBeGreaterThan(0);
  });

  it('fans a quad off an existing London double-track line', () => {
    applyCity('london');
    const game = createHeadlessGame(world, land, { sandbox: true });
    const net = game.network;
    const [ax, ay] = toLocal(-0.1586, 51.5136);
    const [bx, by] = toLocal(-0.1900, 51.5120); // west, towards Bayswater
    net.addStroke([{ x: bx, y: by, level: 'deep' }, { x: ax, y: ay, level: 'deep' }], 'heavy', none, none);
    const end = nodeAt(net, ax, ay);
    const corridor: [number, number][] = [[-0.1586, 51.5136], [-0.1415, 51.5152], [-0.1200, 51.5174]];
    const r = addQuadStroke(net, pts(corridor, 'deep'), 'heavy', { kind: 'node', node: end }, none, { side: 1 });
    expect(r.ok).toBe(true);
    expect(allOk(net, [...net.edges.keys()], game.terrain)).toEqual([]);
    expect(net.degree(net.edges.get(r.links[0])!.a)).toBe(3);
    expect(compileNetwork(game).net.lockCount).toBe(1 + 4);
  });
});
