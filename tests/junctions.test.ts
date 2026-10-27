/**
 * Premade junctions: branch, wye and fork on every track class lay valid track with curves at the
 * junction radius, and trains can use them as intended (a wye from both directions of the main line).
 */
import { describe, expect, it } from 'vitest';
import { TRACK, type TrackClass } from '../src/balance';
import { Network } from '../src/construction/network';
import { JUNCTION_RADIUS, placeJunction, type JunctionSpec } from '../src/construction/junctions';
import { edgeReport, type Terrain } from '../src/construction/validate';
import { pickEdge } from '../src/construction/pick';
import { findRoutePath } from '../src/routes/pathfind';
import { setUnits } from '../src/core/units';

setUnits('metric');
const dry: Terrain = { isWater: () => false, density: () => 0 };
const none = { kind: 'none' } as const;

function mainLine(cls: TrackClass, len = 12000): { net: Network; edge: number } {
  const net = new Network();
  const ids = net.addStroke([{ x: 0, y: 0, level: 'at-grade' }, { x: len, y: 0, level: 'at-grade' }], cls, none, none);
  return { net, edge: ids[0] };
}

function allOk(net: Network, ids: number[]): string[] {
  return ids.flatMap((id) => {
    const r = edgeReport(net, id, dry);
    return r.ok ? [] : [`${id}: ${r.errors.join('; ')}`];
  });
}

function minRadius(net: Network, ids: number[]): number {
  return Math.min(...ids.map((id) => edgeReport(net, id, dry).minRadius));
}

/** A station on the track nearest (x, y). */
function station(net: Network, x: number, y: number, name: string): number {
  const hit = pickEdge(net, x, y, 50)!;
  const L = net.geom(hit.edge).length;
  return net.addStation(hit.edge, Math.max(60, Math.min(L - 60, hit.u)), 4, name).id;
}

describe('premade junctions', () => {
  for (const cls of ['heavy', 'light', 'highspeed'] as const) {
    it(`${cls}: branch, wye and fork lay valid track at the junction radius`, () => {
      for (const kind of ['branch', 'wye'] as const) {
        for (const angle of kind === 'wye' ? [90] : [30, 45, 60, 90]) {
          const { net, edge } = mainLine(cls);
          const spec: JunctionSpec = { kind, angle, side: 1, facing: 1 };
          const r = placeJunction(net, { kind: 'edge', edge, u: 6000 }, cls, spec);
          expect(r.ok, `${kind} ${angle}: ${r.reason}`).toBe(true);
          expect(allOk(net, [...net.edges.keys()]), `${kind} ${angle}`).toEqual([]);
          expect(minRadius(net, r.edges)).toBeGreaterThanOrEqual(TRACK.minRadius[cls]);
          expect(r.ends.length).toBe(1);
          expect(net.degree(r.ends[0])).toBe(1);
          for (const n of net.nodes.values()) expect(net.degree(n.id)).toBeLessThanOrEqual(3);
          // The branch goes off to the left (+y) of the a→b main line.
          expect(net.nodes.get(r.ends[0])!.y).toBeGreaterThan(100);
        }
      }
      const { net } = mainLine(cls);
      const end = [...net.nodes.values()].find((n) => n.x > 11000)!.id;
      const f = placeJunction(net, { kind: 'end', node: end }, cls, { kind: 'fork', angle: 30, side: 1, facing: 1 });
      expect(f.ok, f.reason).toBe(true);
      expect(f.ends.length).toBe(2);
      expect(allOk(net, [...net.edges.keys()])).toEqual([]);
      const ys = f.ends.map((n) => net.nodes.get(n)!.y).sort((a, b) => a - b);
      expect(ys[0]).toBeLessThan(-20);
      expect(ys[1]).toBeGreaterThan(20);
    });
  }

  it('the radius is the class junction radius at 90° (capped only by the fillet limit)', () => {
    const { net, edge } = mainLine('highspeed');
    const r = placeJunction(net, { kind: 'edge', edge, u: 6000 }, 'highspeed', { kind: 'branch', angle: 90, side: 1, facing: 1 });
    expect(minRadius(net, r.edges)).toBeGreaterThanOrEqual(JUNCTION_RADIUS.highspeed - 1);
  });

  it('a wye is reachable from both directions of the main line; a branch from one', () => {
    for (const kind of ['branch', 'wye'] as const) {
      const { net, edge } = mainLine('heavy');
      const r = placeJunction(net, { kind: 'edge', edge, u: 6000 }, 'heavy', { kind, angle: 90, side: 1, facing: 1 });
      expect(r.ok).toBe(true);
      const west = station(net, 1500, 0, 'West');
      const east = station(net, 10500, 0, 'East');
      const end = net.nodes.get(r.ends[0])!;
      const north = station(net, end.x, end.y, 'North');
      expect(findRoutePath(net, 'heavy', [west, north]).ok).toBe(true);
      expect(findRoutePath(net, 'heavy', [north, west]).ok).toBe(true);
      expect(findRoutePath(net, 'heavy', [east, north]).ok).toBe(kind === 'wye');
      expect(findRoutePath(net, 'heavy', [west, east]).ok).toBe(true);
    }
  });

  it('refuses without changing anything when the main line is too short or curved there', () => {
    const { net, edge } = mainLine('heavy', 300);
    const before = JSON.stringify(net.toData());
    const r = placeJunction(net, { kind: 'edge', edge, u: 150 }, 'heavy', { kind: 'wye', angle: 90, side: 1, facing: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/straight/);
    expect(JSON.stringify(net.toData())).toBe(before);
  });
});
