/**
 * Premade junctions (the Junction tool, J): whole junctions laid in one go with curves wide enough
 * for the track class, built from ordinary strokes so leads, anchors, validation and routing work
 * as for drawn track.
 *
 *   Branch  one line leaves the main line at an angle (trains from one direction take it)
 *   Wye     a triangle: the branch can be reached from both directions of the main line
 *   Fork    a track end splits into two lines, symmetric about its axis
 *
 * Each leaves a short stub with a free end to carry on from with the Track or Line tool.
 */
import { TRACK, type TrackClass, type TrackLevel } from '../balance';
import type { Network } from './network';
import { pickEdge } from './pick';
import { pointAt } from './quad';
import type { StrokePoint } from './types';

export type JunctionKind = 'branch' | 'wye' | 'fork';
export const JUNCTION_KINDS: { id: JunctionKind; name: string; blurb: string }[] = [
  { id: 'branch', name: 'Branch', blurb: 'A line leaving the main line; trains from one direction take it' },
  { id: 'wye', name: 'Wye', blurb: 'A triangle junction at right angles: the branch is reachable from both directions' },
  { id: 'fork', name: 'Fork', blurb: 'A track end splitting into two lines' },
];
export const JUNCTION_ANGLES = [30, 45, 60, 90];

export interface JunctionSpec {
  kind: JunctionKind;
  /** Angle between the main line (or the end's axis) and the new line(s), degrees. */
  angle: number;
  /** +1: the branch goes off to the left of the main line's a→b direction; −1 the right. */
  side: 1 | -1;
  /** +1: the branch heads towards the main line's b end; −1 towards a. */
  facing: 1 | -1;
}

/** Where a junction attaches: a point on track (branch, wye) or a track end (fork). */
export type JunctionAt = { kind: 'edge'; edge: number; u: number } | { kind: 'end'; node: number };

export interface JunctionPlan {
  ok: boolean;
  reason?: string;
  /** Edges created (empty when refused; the network is then unchanged). */
  edges: number[];
  /** The stubs' free ends (to carry on from). */
  ends: number[];
}

/** Curve radius a junction aims for on each track class (wider than the minimum). */
export const JUNCTION_RADIUS: Record<TrackClass, number> = { heavy: 350, light: 220, highspeed: 2000 };
/** Stub length beyond the curve, m. */
export const JUNCTION_STUB: Record<TrackClass, number> = { heavy: 300, light: 200, highspeed: 1200 };

const LEAD = TRACK.leadMinLength;
const SLACK = 5;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Tangent length of a curve turning `deg` at the class's junction radius (capped by the fillet limit). */
function tangent(cls: TrackClass, deg: number): number {
  return Math.min(JUNCTION_RADIUS[cls] * Math.tan(rad(deg) / 2), TRACK.filletMaxTangent[cls]);
}

/** The curve radius a turn of `deg` actually gets (the tangent cap can make it tighter). */
export function junctionRadius(cls: TrackClass, deg: number): number {
  return tangent(cls, deg) / Math.tan(rad(deg) / 2);
}

const refuse = (reason: string): JunctionPlan => ({ ok: false, reason, edges: [], ends: [] });

/** The track position nearest (x, y) on a straight piece heading along (hx, hy) (after splits). */
function relocate(net: Network, x: number, y: number, hx: number, hy: number): { edge: number; u: number } | null {
  const hit = pickEdge(net, x, y, 1.5, (id) => {
    const g = net.geom(id);
    return g.length > 1;
  });
  if (!hit) return null;
  const p = pointAt(net, hit.edge, hit.u);
  if (Math.abs(p.hx * hx + p.hy * hy) < Math.cos(rad(1))) return null;
  return { edge: hit.edge, u: hit.u };
}

/**
 * Lay a premade junction (blueprint) on `net`. Refused, with the network unchanged, when the main
 * line isn't straight and splittable where the junction needs it. Validation of the new track
 * (radius, grades, water, zones) is the caller's: the same edgeReport as any drawn track.
 */
export function placeJunction(net: Network, at: JunctionAt, cls: TrackClass, spec: JunctionSpec): JunctionPlan {
  const snapshot = net.toData();
  const res = build(net, at, cls, spec);
  if (!res.ok) net.load(snapshot);
  return res;
}

function build(net: Network, at: JunctionAt, cls: TrackClass, spec: JunctionSpec): JunctionPlan {
  const th = Math.max(10, Math.min(90, spec.angle));
  const stub = JUNCTION_STUB[cls];
  const P = (x: number, y: number, level: TrackLevel): StrokePoint => ({ x, y, level });

  if (at.kind === 'end') {
    // ---- Fork: a track end splits symmetrically, each line turning th/2.
    const E = net.nodes.get(at.node);
    if (!E || net.degree(at.node) !== 1) return refuse('A fork goes on a track end');
    const inc = net.incident(at.node)[0];
    const [dx, dy] = net.departHeading(inc, at.node);
    const hx = -dx, hy = -dy; // outward along the end
    const half = th / 2;
    const T = tangent(cls, half);
    const kd = LEAD + T + SLACK;
    const Kx = E.x + hx * kd, Ky = E.y + hy * kd;
    const edges: number[] = [];
    const ends: number[] = [];
    for (const s of [1, -1]) {
      const a = rad(half) * s;
      const nx = hx * Math.cos(a) - hy * Math.sin(a), ny = hx * Math.sin(a) + hy * Math.cos(a);
      const Px = Kx + nx * (T + stub), Py = Ky + ny * (T + stub);
      const made = net.addStroke([P(E.x, E.y, E.level), P(Kx, Ky, E.level), P(Px, Py, E.level)], cls, { kind: 'node', node: at.node }, { kind: 'none' });
      if (!made.length) return refuse('No room for a fork here');
      edges.push(...made);
      ends.push(net.edges.get(made[made.length - 1])!.b);
    }
    return { ok: true, edges, ends };
  }

  // ---- Branch and wye: off a point on the main line.
  const e = net.edges.get(at.edge);
  if (!e) return refuse('No track here');
  const g = net.geom(at.edge);
  const C = pointAt(net, at.edge, at.u);
  const level = net.levelAt(at.edge, at.u);
  const fx = C.hx * spec.facing, fy = C.hy * spec.facing; // along the main line, the way the branch heads
  const px = -C.hy * spec.side, py = C.hx * spec.side; // across, to the branch's side
  const nx = fx * Math.cos(rad(th)) + px * Math.sin(rad(th)), ny = fy * Math.cos(rad(th)) + py * Math.sin(rad(th));
  const T1 = tangent(cls, th);
  const along = (d: number) => at.u + d * spec.facing; // edge coordinate d metres the branch's way
  // The main line must be straight wherever the junction touches it.
  const straightAt = (u: number) => {
    if (u < 0 || u > g.length) return false;
    const q = pointAt(net, at.edge, u);
    return Math.abs(q.hx * C.hx + q.hy * C.hy) > Math.cos(rad(1)) && Math.abs((q.x - C.x) * -C.hy + (q.y - C.y) * C.hx) < 0.5;
  };

  if (spec.kind === 'branch') {
    const kd = LEAD + T1 + SLACK;
    if (!straightAt(at.u) || !straightAt(along(kd))) return refuse(`Needs ${Math.round(kd)} m of straight track from here`);
    if (!net.canSplitAt(at.edge, at.u, cls).ok) return refuse(net.canSplitAt(at.edge, at.u, cls).reason ?? "Can't branch off here");
    const Kx = C.x + fx * kd, Ky = C.y + fy * kd;
    const Px = Kx + nx * (T1 + stub), Py = Ky + ny * (T1 + stub);
    const made = net.addStroke([P(C.x, C.y, level), P(Kx, Ky, level), P(Px, Py, level)], cls, { kind: 'edge', edge: at.edge, u: at.u }, { kind: 'none' });
    if (!made.length) return refuse("Can't branch off here");
    return { ok: true, edges: made, ends: [net.edges.get(made[made.length - 1])!.b] };
  }

  // Wye (right-angled): curve 1 from behind and curve 2 from ahead each turn 90° and meet at B on
  // the branch axis through C; both have their corner at C. (Other angles would make the far
  // curve turn more than 90°, too sharp within the fillet limit.)
  if (th !== 90) return refuse('A wye is laid at 90°');
  const T2 = tangent(cls, 180 - th);
  const d1 = LEAD + T1 + SLACK, d2 = LEAD + T2 + SLACK;
  const u1 = along(-d1), u2 = along(d2);
  if (!straightAt(u1) || !straightAt(u2) || !straightAt(at.u)) return refuse(`Needs ${Math.round(d1 + d2)} m of straight track around here`);
  for (const u of [u1, u2]) if (!net.canSplitAt(at.edge, u, cls).ok) return refuse(net.canSplitAt(at.edge, u, cls).reason ?? "Can't make a wye here");
  const bd = LEAD + Math.max(T1, T2) + SLACK;
  const Bx = C.x + nx * bd, By = C.y + ny * bd;
  const Px = Bx + nx * stub, Py = By + ny * stub;
  const J1 = pointAt(net, at.edge, u1), J2 = pointAt(net, at.edge, u2);
  const edges: number[] = [];
  // The stub first, so the two curves end on its anchored end.
  const s3 = net.addStroke([P(Bx, By, level), P(Px, Py, level)], cls, { kind: 'none' }, { kind: 'none' });
  if (!s3.length) return refuse("Can't make a wye here");
  const B = net.edges.get(s3[0])!.a;
  const end = net.edges.get(s3[s3.length - 1])!.b;
  edges.push(...s3);
  const s1 = net.addStroke([P(J1.x, J1.y, level), P(C.x, C.y, level), P(Bx, By, level)], cls, { kind: 'edge', edge: at.edge, u: u1 }, { kind: 'node', node: B });
  if (!s1.length) return refuse("Can't make a wye here");
  edges.push(...s1);
  const at2 = relocate(net, J2.x, J2.y, C.hx, C.hy);
  if (!at2) return refuse("Can't make a wye here");
  const s2 = net.addStroke([P(J2.x, J2.y, level), P(C.x, C.y, level), P(Bx, By, level)], cls, { kind: 'edge', edge: at2.edge, u: at2.u }, { kind: 'node', node: B });
  if (!s2.length) return refuse("Can't make a wye here");
  edges.push(...s2);
  return { ok: true, edges, ends: [end] };
}
