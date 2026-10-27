/**
 * Track geometry: straight sections joined by circular-arc fillets at each vertex.
 *
 * A fillet at vertex V between incoming direction d1 (P→V) and outgoing d2 (V→N), with radius r:
 *   deflection θ = angle(d1, d2), tangent length t = r·tan(θ/2)
 *   tangent points T1 = V − d1·t, T2 = V + d2·t, arc length r·θ.
 * Each edge owns the second half of the fillet at its start vertex and the first half of the
 * fillet at its end vertex, so edges meet at arc midpoints with matching headings.
 */
import { TRACK, type TrackClass } from '../balance';
import type { TrackEdge, TrackNode } from './types';

export interface Fillet {
  /** Deflection angle, radians (0 = straight). */
  theta: number;
  /** +1 turning left (counter-clockwise), −1 turning right. */
  sign: number;
  r: number;
  t: number;
  cx: number;
  cy: number;
  /** Angle of T1 around the centre. */
  phi0: number;
  t1x: number;
  t1y: number;
  t2x: number;
  t2y: number;
}

/** Fillet at V for the path P → V → N with radius r. Null when the path is straight or r = 0. */
export function computeFillet(
  px: number,
  py: number,
  vx: number,
  vy: number,
  nx: number,
  ny: number,
  r: number,
): Fillet | null {
  const l1 = Math.hypot(vx - px, vy - py);
  const l2 = Math.hypot(nx - vx, ny - vy);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const d1x = (vx - px) / l1, d1y = (vy - py) / l1;
  const d2x = (nx - vx) / l2, d2y = (ny - vy) / l2;
  const theta = deflection(d1x, d1y, d2x, d2y);
  if (theta < TRACK.straightEpsilon || r <= 0) return null;
  const cross = d1x * d2y - d1y * d2x;
  const sign = cross >= 0 ? 1 : -1;
  const t = r * Math.tan(theta / 2);
  const t1x = vx - d1x * t, t1y = vy - d1y * t;
  const t2x = vx + d2x * t, t2y = vy + d2y * t;
  // Centre is to the left of d1 when turning left.
  const cx = t1x - d1y * r * sign;
  const cy = t1y + d1x * r * sign;
  const phi0 = Math.atan2(t1y - cy, t1x - cx);
  return { theta, sign, r, t, cx, cy, phi0, t1x, t1y, t2x, t2y };
}

/** Point on the fillet arc at fraction f ∈ [0, 1] from T1 to T2. */
export function filletPoint(f: Fillet, frac: number): [number, number] {
  const a = f.phi0 + f.sign * f.theta * frac;
  return [f.cx + Math.cos(a) * f.r, f.cy + Math.sin(a) * f.r];
}

/** Unsigned angle between two unit vectors. */
export function deflection(ax: number, ay: number, bx: number, by: number): number {
  const d = Math.max(-1, Math.min(1, ax * bx + ay * by));
  return Math.acos(d);
}

/** Largest radius whose tangent length fits in `t`, for deflection θ. */
export function radiusForTangent(t: number, theta: number): number {
  if (theta < TRACK.straightEpsilon) return 0;
  return t / Math.tan(theta / 2);
}

/** Maximum speed on a curve of radius r: v = √(a_lat·r). */
export function curveSpeed(r: number, cls?: TrackClass): number {
  if (!isFinite(r) || r <= 0) return Infinity;
  return Math.sqrt((cls === 'highspeed' ? TRACK.lateralAccelHighSpeed : TRACK.lateralAccel) * r);
}

// ---------------------------------------------------------------------------

export interface Piece {
  s0: number;
  s1: number;
  /** Infinity for straight track. */
  r: number;
}

export interface EdgeGeom {
  id: number;
  length: number;
  /** Sampled centreline (local metres) with cumulative distance. */
  xs: Float64Array;
  ys: Float64Array;
  cum: Float64Array;
  pieces: Piece[];
  /** Tangent lengths consumed by the fillets at each end, and the control-polygon chord. */
  ta: number;
  tb: number;
  chord: number;
  /** Fillets at the two ends overlap (points too close for the curves). */
  overlap: boolean;
  /** Fillet radius at each end (0 = none). */
  ra: number;
  rb: number;
  /** Bounding box of the sampled centreline. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Read-only view of the track graph needed for geometry. */
export interface GraphView {
  node(id: number): TrackNode | undefined;
  edge(id: number): TrackEdge | undefined;
  /** Edge ids incident to a node. */
  incident(nodeId: number): readonly number[];
}

export function otherEnd(e: TrackEdge, nodeId: number): number {
  return e.a === nodeId ? e.b : e.a;
}

/** Does vertex `n` carry a fillet? Returns the neighbouring node across its other edge. */
export function filletNeighbour(g: GraphView, n: TrackNode, viaEdge: number): TrackNode | null {
  if (n.anchor || n.r <= 0) return null;
  const inc = g.incident(n.id);
  if (inc.length !== 2) return null;
  const other = inc[0] === viaEdge ? inc[1] : inc[0];
  const oe = g.edge(other);
  if (!oe) return null;
  return g.node(otherEnd(oe, n.id)) ?? null;
}

/** Fillet at node n for the path prev → n → next, if n is a fillet vertex. */
export function nodeFillet(n: TrackNode, prev: TrackNode, next: TrackNode): Fillet | null {
  return computeFillet(prev.x, prev.y, n.x, n.y, next.x, next.y, n.r);
}

const ARC_STEP_ANGLE = (4 * Math.PI) / 180;
const ARC_STEP_LEN = 8;
/**
 * Long straights get a point every this many metres. The map draws straight lines between points
 * in its own (Mercator) projection, so on the national map a 300 km straight drawn from its two
 * ends alone would bow away from where the trains run by over a kilometre.
 */
const STRAIGHT_STEP = 2000;

export function computeEdgeGeom(g: GraphView, e: TrackEdge): EdgeGeom {
  const a = g.node(e.a)!;
  const b = g.node(e.b)!;
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const pa = filletNeighbour(g, a, e.id);
  const nb = filletNeighbour(g, b, e.id);
  const fa = pa ? nodeFillet(a, pa, b) : null;
  const fb = nb ? nodeFillet(b, a, nb) : null;
  const ta = fa ? fa.t : 0;
  const tb = fb ? fb.t : 0;
  const overlap = ta + tb > chord + 1e-6;

  const xs: number[] = [];
  const ys: number[] = [];
  const pieces: Piece[] = [];
  let s = 0;
  const push = (x: number, y: number) => {
    const n = xs.length;
    if (n > 0) {
      const d = Math.hypot(x - xs[n - 1], y - ys[n - 1]);
      if (d < 1e-6) return;
    }
    xs.push(x);
    ys.push(y);
  };
  const arcHalf = (f: Fillet, from: number, to: number) => {
    const sweep = f.theta * Math.abs(to - from);
    const len = f.r * sweep;
    const steps = Math.max(2, Math.ceil(Math.max(sweep / ARC_STEP_ANGLE, len / ARC_STEP_LEN)));
    for (let i = 0; i <= steps; i++) {
      const [x, y] = filletPoint(f, from + ((to - from) * i) / steps);
      push(x, y);
    }
    pieces.push({ s0: s, s1: s + len, r: f.r });
    s += len;
  };

  if (fa) arcHalf(fa, 0.5, 1);
  else push(a.x, a.y);
  const sx = fa ? fa.t2x : a.x, sy = fa ? fa.t2y : a.y;
  const ex = fb ? fb.t1x : b.x, ey = fb ? fb.t1y : b.y;
  push(sx, sy);
  const straight = overlap ? 0 : Math.max(0, chord - ta - tb);
  if (straight > 0) pieces.push({ s0: s, s1: s + straight, r: Infinity });
  s += straight;
  if (straight > STRAIGHT_STEP) {
    const k = Math.ceil(straight / STRAIGHT_STEP);
    for (let i = 1; i < k; i++) push(sx + ((ex - sx) * i) / k, sy + ((ey - sy) * i) / k);
  }
  push(ex, ey);
  if (fb) arcHalf(fb, 0, 0.5);
  else push(b.x, b.y);

  // Cumulative distance along the sampled polyline (arcs are sampled finely, so this matches
  // the analytic length to well under a metre; we rescale pieces to the sampled length).
  const n = xs.length;
  const X = new Float64Array(xs);
  const Y = new Float64Array(ys);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  const length = n > 1 ? cum[n - 1] : 0;
  if (s > 0 && length > 0) {
    const k = length / s;
    for (const p of pieces) {
      p.s0 *= k;
      p.s1 *= k;
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (X[i] < minX) minX = X[i];
    if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i];
    if (Y[i] > maxY) maxY = Y[i];
  }
  return { id: e.id, length, xs: X, ys: Y, cum, pieces, ta, tb, chord, overlap, ra: fa ? fa.r : 0, rb: fb ? fb.r : 0, minX, minY, maxX, maxY };
}

/** Position and unit heading at distance s along a sampled polyline. */
export function sampleAt(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  cum: ArrayLike<number>,
  s: number,
): { x: number; y: number; hx: number; hy: number; i: number } {
  const n = cum.length;
  if (n < 2) return { x: xs[0] ?? 0, y: ys[0] ?? 0, hx: 1, hy: 0, i: 0 };
  if (s <= 0) return seg(0, 0);
  if (s >= cum[n - 1]) return seg(n - 2, 1);
  // Binary search for the segment containing s.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const L = cum[lo + 1] - cum[lo];
  return seg(lo, L > 0 ? (s - cum[lo]) / L : 0);

  function seg(i: number, f: number) {
    const dx = xs[i + 1] - xs[i];
    const dy = ys[i + 1] - ys[i];
    const L = Math.hypot(dx, dy) || 1;
    return { x: xs[i] + dx * f, y: ys[i] + dy * f, hx: dx / L, hy: dy / L, i };
  }
}

/** Closest point on a sampled polyline. */
export function projectOnPolyline(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  cum: ArrayLike<number>,
  px: number,
  py: number,
): { d: number; s: number; x: number; y: number } {
  let best = { d: Infinity, s: 0, x: 0, y: 0 };
  for (let i = 0; i + 1 < xs.length; i++) {
    const ax = xs[i], ay = ys[i], bx = xs[i + 1], by = ys[i + 1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + dx * t, y = ay + dy * t;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, s: cum[i] + Math.sqrt(L2) * t, x, y };
  }
  return best;
}

/** Minimum radius over the interval [s0, s1] of an edge (Infinity if all straight). */
export function minRadiusOver(geom: EdgeGeom, s0: number, s1: number): number {
  let r = Infinity;
  for (const p of geom.pieces) {
    if (p.s1 <= s0 + 1e-6 || p.s0 >= s1 - 1e-6) continue;
    if (p.r < r) r = p.r;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Four-track sections (v2, docs/v2/express-quad.md §4.1). Re-exported from quad.ts; they live here
// so network.ts can keep a twin pair parallel without importing the quad construction code.

export interface XY {
  x: number;
  y: number;
}

/**
 * Twin of vertex v at signed offset d (positive = right of the travel direction p → v → q): the
 * mitre point v + d·(n(d1) + n(d2)) / (1 + d1·d2), with n(d) = (d.y, −d.x), so |v' − v| = |d| / cos(θ/2)
 * and both offset segments are exactly |d| from the originals. With one neighbour (a chain end,
 * p or q null) it is the perpendicular offset. Null when the turn is sharper than about 162°.
 */
export function mitre(p: XY | null, v: XY, q: XY | null, d: number): XY | null {
  const u1 = p ? unit(v.x - p.x, v.y - p.y) : null;
  const u2 = q ? unit(q.x - v.x, q.y - v.y) : null;
  const a = u1 ?? u2;
  const b = u2 ?? u1;
  if (!a || !b) return null;
  const den = 1 + a[0] * b[0] + a[1] * b[1];
  if (den < 0.05) return null;
  const nx = a[1] + b[1];
  const ny = -a[0] - b[0];
  return { x: v.x + (d * nx) / den, y: v.y + (d * ny) / den };
}

/**
 * Fillet radius of the twin vertex: concentric with the original, larger on the outside of the
 * turn. turn = +1 for a left turn (turnSign), d = the twin's signed offset (positive = right).
 * 0 stays 0 (no curve); an inner radius that would vanish is kept at 1 m so validation reports it.
 */
export function concentric(r: number, turn: number, d: number): number {
  if (!(r > 0)) return 0;
  return Math.max(1, r + turn * d);
}

/** +1 if p → v → q turns left (counter-clockwise), −1 right, 0 straight. */
export function turnSign(p: XY, v: XY, q: XY): -1 | 0 | 1 {
  const c = (v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x);
  return c > 0 ? 1 : c < 0 ? -1 : 0;
}

function unit(dx: number, dy: number): [number, number] | null {
  const L = Math.hypot(dx, dy);
  return L > 1e-9 ? [dx / L, dy / L] : null;
}
