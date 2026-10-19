/**
 * Timelapse (docs/v2/cinematic.md §3): a compact snapshot of the built network at every month
 * close, kept in the save, and what the player needs to replay it. Pure (no DOM, no randomness):
 *
 * - geometry is stored once per edge id (edge ids are never reused; built geometry never moves),
 *   Douglas–Peucker at 1 m, whole metres; stations once per id;
 * - a frame lists the edges (built or under construction, and whether the map draws it b→a, so
 *   route offsets keep their side along a chain), the stations and the routes (deduplicated shapes:
 *   colour, bullet, express, legs) with whether each runs;
 * - frames are bounded (TIMELAPSE.maxFrames; the frame whose removal leaves the smallest gap goes
 *   first, the first and last stay) and then thinned under an encoded-size cap;
 * - the encoding is zig-zag LEB128 varints (sorted id deltas, coordinate deltas) in base64.
 */
import { CINEMATIC } from '../balance';
import type { Network } from '../construction/network';
import { orientEdges } from '../map/networkLayers';
import type { RouteSet } from '../routes/routeSet';

export interface TLEdge {
  /** x0, y0, x1, y1, … local metres along the edge from node a to node b. */
  pts: Int32Array;
  /** Four-track pair push side relative to a→b (+1 right, −1 left); 0 on ordinary track and connectors. */
  away: -1 | 0 | 1;
}

export interface TLRoute {
  id: number;
  color: string;
  bullet: string;
  express: boolean;
  /** Path legs in order: edge id and the part used (whole metres from node a). */
  legs: [edge: number, u0: number, u1: number][];
}

export interface TLFrameEdge {
  id: number;
  built: boolean;
  /** The map draws it b→a (orientEdges). */
  flip: boolean;
}

export interface TLFrame {
  /** Game day of the month close (the first frame of a game may be day 0). */
  day: number;
  /** Sorted by id. */
  edges: TLFrameEdge[];
  /** Sorted by id. */
  stations: { id: number; built: boolean }[];
  routes: { shape: number; running: boolean }[];
}

export interface Timelapse {
  edges: Map<number, TLEdge>;
  stations: Map<number, { x: number; y: number }>;
  /** Route shapes; frames refer to them by index. */
  shapes: TLRoute[];
  frames: TLFrame[];
}

/** What a save holds (v7): one base64 varint stream and the route shapes' strings. */
export interface SavedTimelapse {
  v: 1;
  /** Edge geometry, stations, route legs and frames as varints, base64. */
  data: string;
  /** Route shapes in order: [id, colour, bullet, express 0/1]; their legs are in `data`. */
  shapes: [number, string, string, number][];
}

export function emptyTimelapse(): Timelapse {
  return { edges: new Map(), stations: new Map(), shapes: [], frames: [] };
}

// ------------------------------------------------------------------ geometry
/** Douglas–Peucker simplification of a polyline (keeps the ends); tolerance in metres. */
export function simplify(xs: ArrayLike<number>, ys: ArrayLike<number>, tol: number): number[] {
  const n = xs.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay;
    const L2 = dx * dx + dy * dy;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      let t = L2 > 0 ? ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xs[i] - (ax + t * dx), ys[i] - (ay + t * dy));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Cumulative lengths of an Int32 point list. */
export function cumLengths(pts: ArrayLike<number>): Float64Array {
  const n = pts.length / 2;
  const c = new Float64Array(n);
  for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  return c;
}

/** The part of a point list between path distances s0 ≤ s1 (interpolated ends). */
export function slicePts(pts: ArrayLike<number>, s0: number, s1: number): [number, number][] {
  const n = pts.length / 2;
  if (n === 0) return [];
  const cum = cumLengths(pts);
  const L = cum[n - 1];
  const a = Math.max(0, Math.min(L, s0)), b = Math.max(a, Math.min(L, s1));
  const at = (s: number): [number, number] => {
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
    return [pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * f, pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * f];
  };
  const out: [number, number][] = [at(a)];
  for (let i = 0; i < n; i++) if (cum[i] > a && cum[i] < b) out.push([pts[2 * i], pts[2 * i + 1]]);
  out.push(at(b));
  return out;
}

// ------------------------------------------------------------------ recording
/**
 * A frame of the network as it is now (built and construction edges and stations, every route
 * with a path on them). New edges' and stations' geometry goes into the tables.
 */
export function snapshotFrame(tl: Timelapse, day: number, net: Network, routes: RouteSet): TLFrame {
  const flips = orientEdges(net);
  const edges: TLFrameEdge[] = [];
  for (const e of [...net.edges.values()].sort((a, b) => a.id - b.id)) {
    if (e.status === 'blueprint') continue;
    if (!tl.edges.has(e.id)) {
      const g = net.geom(e.id);
      const keep = simplify(g.xs, g.ys, CINEMATIC.timelapseToleranceM);
      const pts = new Int32Array(keep.length * 2);
      keep.forEach((k, i) => {
        pts[2 * i] = Math.round(g.xs[k]);
        pts[2 * i + 1] = Math.round(g.ys[k]);
      });
      const away = e.quad && e.quad.role !== 'link' ? e.quad.away : 0;
      tl.edges.set(e.id, { pts, away });
    }
    edges.push({ id: e.id, built: e.status === 'built', flip: flips.get(e.id) ?? false });
  }
  const recorded = new Set(edges.map((e) => e.id));
  const stations: TLFrame['stations'] = [];
  for (const s of [...net.stations.values()].sort((a, b) => a.id - b.id)) {
    if (s.status === 'blueprint') continue;
    if (!tl.stations.has(s.id)) {
      const p = net.stationPos(s);
      tl.stations.set(s.id, { x: Math.round(p.x), y: Math.round(p.y) });
    }
    stations.push({ id: s.id, built: s.status === 'built' });
  }
  const index = new Map(tl.shapes.map((r, i) => [shapeKey(r), i]));
  const frameRoutes: TLFrame['routes'] = [];
  for (const r of [...routes.list()].sort((a, b) => a.id - b.id)) {
    const p = routes.path(net, r);
    if (!p.ok) continue;
    const legs: TLRoute['legs'] = [];
    for (const l of p.legs) {
      if (!recorded.has(l.edge)) continue;
      legs.push([l.edge, Math.max(0, Math.round(Math.min(l.u0, l.u1))), Math.max(0, Math.round(Math.max(l.u0, l.u1)))]);
    }
    if (!legs.length) continue;
    const shape: TLRoute = { id: r.id, color: r.color.toLowerCase(), bullet: r.bullet, express: !!r.express, legs };
    const k = shapeKey(shape);
    let i = index.get(k);
    if (i === undefined) {
      i = tl.shapes.length;
      tl.shapes.push(shape);
      index.set(k, i);
    }
    frameRoutes.push({ shape: i, running: routes.operational(net, r).ok });
  }
  return { day, edges, stations, routes: frameRoutes };
}

function shapeKey(r: TLRoute): string {
  return JSON.stringify([r.id, r.color, r.bullet, r.express, r.legs]);
}

/**
 * Record a month-close frame (one per day: a second call on the same day replaces it), then keep
 * the timelapse within its bounds.
 */
export function recordFrame(tl: Timelapse, day: number, net: Network, routes: RouteSet): TLFrame {
  const f = snapshotFrame(tl, day, net, routes);
  const last = tl.frames[tl.frames.length - 1];
  if (last && last.day === day) tl.frames[tl.frames.length - 1] = f;
  else tl.frames.push(f);
  boundTimelapse(tl);
  return f;
}

/** Remove frames until at most `max` remain: each time the one whose removal leaves the smallest gap (oldest first); the first and last stay. */
export function thinFrames(frames: TLFrame[], max: number): void {
  while (frames.length > max && frames.length > 2) {
    let best = 1, gap = Infinity;
    for (let i = 1; i < frames.length - 1; i++) {
      const g = frames[i + 1].day - frames[i - 1].day;
      if (g < gap) {
        gap = g;
        best = i;
      }
    }
    frames.splice(best, 1);
  }
}

/** The frame bound, then the size cap (thinning a tenth at a time), then unreferenced geometry dropped. */
export function boundTimelapse(tl: Timelapse, maxFrames = CINEMATIC.timelapseMaxFrames, maxBytes = CINEMATIC.timelapseMaxBytes): void {
  thinFrames(tl.frames, maxFrames);
  prune(tl);
  while (tl.frames.length > 2 && encodedSize(tl) > maxBytes) {
    thinFrames(tl.frames, Math.max(2, Math.floor(tl.frames.length * 0.9)));
    prune(tl);
  }
}

/** Drop geometry, stations and shapes no frame refers to (shape indices are renumbered). */
export function prune(tl: Timelapse): void {
  const e = new Set<number>(), s = new Set<number>(), r = new Set<number>();
  for (const f of tl.frames) {
    for (const x of f.edges) e.add(x.id);
    for (const x of f.stations) s.add(x.id);
    for (const x of f.routes) r.add(x.shape);
  }
  for (const id of [...tl.edges.keys()]) if (!e.has(id)) tl.edges.delete(id);
  for (const id of [...tl.stations.keys()]) if (!s.has(id)) tl.stations.delete(id);
  if (r.size === tl.shapes.length) return;
  const remap = new Map<number, number>();
  const shapes: TLRoute[] = [];
  tl.shapes.forEach((sh, i) => {
    if (!r.has(i)) return;
    remap.set(i, shapes.length);
    shapes.push(sh);
  });
  tl.shapes = shapes;
  for (const f of tl.frames) for (const x of f.routes) x.shape = remap.get(x.shape)!;
}

// ------------------------------------------------------------------ encoding
class Writer {
  private buf = new Uint8Array(1024);
  n = 0;
  u(v: number): void {
    let x = Math.max(0, Math.floor(v));
    while (true) {
      if (this.n + 1 > this.buf.length) {
        const b = new Uint8Array(this.buf.length * 2);
        b.set(this.buf);
        this.buf = b;
      }
      const byte = x % 128;
      x = Math.floor(x / 128);
      if (x === 0) {
        this.buf[this.n++] = byte;
        return;
      }
      this.buf[this.n++] = byte | 128;
    }
  }
  /** Zig-zag signed. */
  s(v: number): void {
    const x = Math.round(v);
    this.u(x >= 0 ? 2 * x : -2 * x - 1);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  u(): number {
    let x = 0, mul = 1;
    while (true) {
      if (this.i >= this.b.length) throw new Error('timelapse: truncated');
      const byte = this.b[this.i++];
      x += (byte & 127) * mul;
      if (byte < 128) return x;
      mul *= 128;
      if (mul > 2 ** 49) throw new Error('timelapse: bad varint');
    }
  }
  s(): number {
    const x = this.u();
    return x % 2 === 0 ? x / 2 : -(x + 1) / 2;
  }
}

/** Unsigned and zig-zag LEB128 round trip helpers (exported for tests). */
export function encodeVarints(values: number[], signed = false): Uint8Array {
  const w = new Writer();
  for (const v of values) (signed ? w.s(v) : w.u(v));
  return w.bytes();
}
export function decodeVarints(bytes: Uint8Array, count: number, signed = false): number[] {
  const r = new Reader(bytes);
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(signed ? r.s() : r.u());
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const FORMAT = 1;

/** Encode for a save. Only what the frames refer to is written. */
export function encodeTimelapse(tl: Timelapse): SavedTimelapse {
  prune(tl);
  const w = new Writer();
  w.u(FORMAT);
  // Edges by id.
  const eids = [...tl.edges.keys()].sort((a, b) => a - b);
  w.u(eids.length);
  let prev = 0;
  for (const id of eids) {
    const e = tl.edges.get(id)!;
    w.u(id - prev);
    prev = id;
    w.u(e.away + 1);
    const n = e.pts.length / 2;
    w.u(n);
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      w.s(e.pts[2 * i] - px);
      w.s(e.pts[2 * i + 1] - py);
      px = e.pts[2 * i];
      py = e.pts[2 * i + 1];
    }
  }
  // Stations by id.
  const sids = [...tl.stations.keys()].sort((a, b) => a - b);
  w.u(sids.length);
  prev = 0;
  for (const id of sids) {
    const s = tl.stations.get(id)!;
    w.u(id - prev);
    prev = id;
    w.s(s.x);
    w.s(s.y);
  }
  // Route legs (the shapes' other fields are strings, beside the stream).
  w.u(tl.shapes.length);
  for (const r of tl.shapes) {
    w.u(r.legs.length);
    let pe = 0;
    for (const [edge, u0, u1] of r.legs) {
      w.s(edge - pe);
      pe = edge;
      w.u(u0);
      w.u(u1 - u0);
    }
  }
  // Frames.
  w.u(tl.frames.length);
  let pd = 0;
  for (const f of tl.frames) {
    w.s(f.day - pd);
    pd = f.day;
    w.u(f.edges.length);
    let pid = 0;
    for (const e of f.edges) {
      w.u((e.id - pid) * 4 + (e.built ? 2 : 0) + (e.flip ? 1 : 0));
      pid = e.id;
    }
    w.u(f.stations.length);
    pid = 0;
    for (const s of f.stations) {
      w.u((s.id - pid) * 2 + (s.built ? 1 : 0));
      pid = s.id;
    }
    w.u(f.routes.length);
    for (const r of f.routes) w.u(r.shape * 2 + (r.running ? 1 : 0));
  }
  return { v: 1, data: toB64(w.bytes()), shapes: tl.shapes.map((r) => [r.id, r.color, r.bullet, r.express ? 1 : 0]) };
}

/** Size of the encoded timelapse in characters (what the save stores). */
export function encodedSize(tl: Timelapse): number {
  const e = encodeTimelapse(tl);
  return e.data.length + JSON.stringify(e.shapes).length;
}

/**
 * Decode a saved timelapse. Never throws: anything malformed gives an empty timelapse (the
 * replay then starts from the load).
 */
export function decodeTimelapse(raw: unknown): Timelapse {
  try {
    const s = raw as SavedTimelapse;
    if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.data !== 'string' || !Array.isArray(s.shapes)) return emptyTimelapse();
    const r = new Reader(fromB64(s.data));
    if (r.u() !== FORMAT) return emptyTimelapse();
    const tl = emptyTimelapse();
    const ne = r.u();
    let prev = 0;
    for (let k = 0; k < ne; k++) {
      const id = prev + r.u();
      prev = id;
      const away = (r.u() - 1) as -1 | 0 | 1;
      const n = r.u();
      if (n > 1e6) throw new Error('timelapse: too many points');
      const pts = new Int32Array(n * 2);
      let px = 0, py = 0;
      for (let i = 0; i < n; i++) {
        px += r.s();
        py += r.s();
        pts[2 * i] = px;
        pts[2 * i + 1] = py;
      }
      tl.edges.set(id, { pts, away: away < -1 || away > 1 ? 0 : away });
    }
    const ns = r.u();
    prev = 0;
    for (let k = 0; k < ns; k++) {
      const id = prev + r.u();
      prev = id;
      tl.stations.set(id, { x: r.s(), y: r.s() });
    }
    const nr = r.u();
    if (nr !== s.shapes.length) return emptyTimelapse();
    for (let k = 0; k < nr; k++) {
      const meta = s.shapes[k];
      const nl = r.u();
      const legs: TLRoute['legs'] = [];
      let pe = 0;
      for (let i = 0; i < nl; i++) {
        const edge = pe + r.s();
        pe = edge;
        const u0 = r.u();
        legs.push([edge, u0, u0 + r.u()]);
      }
      if (!Array.isArray(meta)) return emptyTimelapse();
      tl.shapes.push({ id: Number(meta[0]) || 0, color: typeof meta[1] === 'string' ? meta[1] : '#8e99a5', bullet: typeof meta[2] === 'string' ? meta[2] : '?', express: meta[3] === 1, legs });
    }
    const nf = r.u();
    let pd = 0;
    for (let k = 0; k < nf; k++) {
      const day = pd + r.s();
      pd = day;
      const f: TLFrame = { day, edges: [], stations: [], routes: [] };
      let pid = 0;
      for (let i = 0, n = r.u(); i < n; i++) {
        const v = r.u();
        const id = pid + Math.floor(v / 4);
        pid = id;
        if (tl.edges.has(id)) f.edges.push({ id, built: (v & 2) !== 0, flip: (v & 1) !== 0 });
      }
      pid = 0;
      for (let i = 0, n = r.u(); i < n; i++) {
        const v = r.u();
        const id = pid + Math.floor(v / 2);
        pid = id;
        if (tl.stations.has(id)) f.stations.push({ id, built: (v & 1) !== 0 });
      }
      for (let i = 0, n = r.u(); i < n; i++) {
        const v = r.u();
        const shape = Math.floor(v / 2);
        if (shape < tl.shapes.length) f.routes.push({ shape, running: (v & 1) !== 0 });
      }
      tl.frames.push(f);
    }
    return tl;
  } catch {
    return emptyTimelapse();
  }
}

// ------------------------------------------------------------------ the player's schedule
/** Points every `step` metres along a point list (and its last point). */
export function samplePts(pts: ArrayLike<number>, step: number): [number, number][] {
  const n = pts.length / 2;
  const out: [number, number][] = [];
  if (n === 0) return out;
  out.push([pts[0], pts[1]]);
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = pts[2 * i - 2], ay = pts[2 * i - 1], bx = pts[2 * i], by = pts[2 * i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    let s = step - carry;
    while (s < L) {
      out.push([ax + ((bx - ax) * s) / L, ay + ((by - ay) * s) / L]);
      s += step;
    }
    carry = L - (s - step);
  }
  out.push([pts[2 * n - 2], pts[2 * n - 1]]);
  return out;
}

/**
 * Edges of `next` that are new since `prev`. An edge split off old track (a junction added on
 * built track gives the pieces new ids) is not new: its middle lies within a few metres of old track.
 */
export function newEdgeIds(tl: Timelapse, prev: TLFrame | null, next: TLFrame): number[] {
  const old = new Set(prev?.edges.map((e) => e.id) ?? []);
  const fresh = next.edges.filter((e) => !old.has(e.id)).map((e) => e.id);
  if (!prev || !fresh.length) return fresh;
  // Old track sampled every 4 m on a 2 m grid.
  const grid = new Set<string>();
  const cell = (x: number, y: number) => `${Math.round(x / 2)}|${Math.round(y / 2)}`;
  for (const e of prev.edges) {
    const pts = tl.edges.get(e.id)?.pts;
    if (pts) for (const [x, y] of samplePts(pts, 4)) grid.add(cell(x, y));
  }
  return fresh.filter((id) => {
    const pts = tl.edges.get(id)?.pts;
    if (!pts) return true;
    const L = cumLengths(pts);
    const [[x, y]] = slicePts(pts, L[L.length - 1] / 2, L[L.length - 1] / 2);
    const cx = Math.round(x / 2), cy = Math.round(y / 2);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (grid.has(`${cx + dx}|${cy + dy}`)) return false;
    return true;
  });
}

export interface DrawSlot {
  /** Share of the draw-in phase when this edge starts and finishes drawing (0–1). */
  t0: number;
  t1: number;
  /** Draws from node a's end (else from b's). */
  fromA: boolean;
}

/**
 * When each new edge draws itself in: outward from where it meets the existing network (or, for a
 * line on its own, from its lowest-id edge's first end), along its chains, all finishing together.
 */
export function drawSchedule(tl: Timelapse, prev: TLFrame | null, ids: number[]): Map<number, DrawSlot> {
  const out = new Map<number, DrawSlot>();
  if (!ids.length) return out;
  const key = (x: number, y: number) => `${Math.round(x / 3)}|${Math.round(y / 3)}`;
  const ends = new Map<number, { a: string; b: string; len: number }>();
  const adj = new Map<string, { id: number; to: string; len: number }[]>();
  for (const id of ids) {
    const pts = tl.edges.get(id)?.pts;
    if (!pts || pts.length < 4) continue;
    const n = pts.length / 2;
    const a = key(pts[0], pts[1]), b = key(pts[2 * n - 2], pts[2 * n - 1]);
    const cum = cumLengths(pts);
    const len = cum[n - 1];
    ends.set(id, { a, b, len });
    for (const [p, q] of [[a, b], [b, a]] as const) {
      let l = adj.get(p);
      if (!l) adj.set(p, (l = []));
      l.push({ id, to: q, len });
    }
  }
  // Sources: endpoints shared with old edges.
  const oldEnds = new Set<string>();
  for (const e of prev?.edges ?? []) {
    const pts = tl.edges.get(e.id)?.pts;
    if (!pts || pts.length < 4) continue;
    const n = pts.length / 2;
    oldEnds.add(key(pts[0], pts[1]));
    oldEnds.add(key(pts[2 * n - 2], pts[2 * n - 1]));
  }
  const dist = new Map<string, number>();
  const run = (sources: string[]) => {
    // Small graphs: a simple label-correcting search is enough.
    const queue = [...sources];
    for (const s of sources) dist.set(s, 0);
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (dist.get(queue[i])! < dist.get(queue[bi])!) bi = i;
      const p = queue.splice(bi, 1)[0];
      const d = dist.get(p)!;
      for (const nb of adj.get(p) ?? []) {
        const nd = d + nb.len;
        if (nd < (dist.get(nb.to) ?? Infinity)) {
          dist.set(nb.to, nd);
          queue.push(nb.to);
        }
      }
    }
  };
  run([...adj.keys()].filter((k) => oldEnds.has(k)));
  // Lines on their own: from the lowest-id unreached edge's a-end, until everything is reached.
  for (const id of [...ends.keys()].sort((a, b) => a - b)) {
    const e = ends.get(id)!;
    if (dist.has(e.a) || dist.has(e.b)) continue;
    run([e.a]);
  }
  let max = 0;
  const raw = new Map<number, { d0: number; d1: number; fromA: boolean }>();
  for (const [id, e] of ends) {
    const da = dist.get(e.a) ?? 0, db = dist.get(e.b) ?? 0;
    const fromA = da <= db;
    const d0 = Math.min(da, db);
    const d1 = d0 + e.len;
    raw.set(id, { d0, d1, fromA });
    max = Math.max(max, d1);
  }
  for (const [id, r] of raw) out.set(id, { t0: max > 0 ? r.d0 / max : 0, t1: max > 0 ? r.d1 / max : 1, fromA: r.fromA });
  return out;
}

/** Track length (km of double track) and counts in a frame, for the player's caption. */
export function frameStats(tl: Timelapse, f: TLFrame): { trackM: number; stations: number; routes: number } {
  let trackM = 0;
  for (const e of f.edges) {
    const pts = tl.edges.get(e.id)?.pts;
    if (pts) {
      const c = cumLengths(pts);
      // A four-track section's two pairs count once.
      trackM += (c[c.length - 1] ?? 0) * ((tl.edges.get(e.id)?.away ?? 0) !== 0 ? 0.5 : 1);
    }
  }
  return { trackM, stations: f.stations.length, routes: f.routes.filter((r) => r.running).length };
}
