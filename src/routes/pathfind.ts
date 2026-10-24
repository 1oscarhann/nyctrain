/**
 * Find a route's path along connected track through its stations in order.
 *
 * Trains can't reverse mid-route, so the search state is (edge, travel direction). At a node a
 * train may only continue onto an edge whose departure heading lines up with its arrival heading:
 * straight through a junction or onto a branch, never a V-turn back down the other branch.
 */
import type { Network } from '../construction/network';
import { otherEnd } from '../construction/geometry';
import type { Station } from '../construction/types';
import type { PathLeg, RoutePath } from './types';
import { gaugeOf, QUAD, type TrackClass } from '../balance';

const ALIGN = Math.cos((25 * Math.PI) / 180);

export interface StopPos {
  edge: number;
  u: number;
}

/**
 * Four-track sections (v2, docs/v2/express-quad.md §4.6): metres added to a route's path cost for
 * running through a platform it does not serve, and for each turnout or crossover it uses, so
 * expresses keep to the platform-free pair and locals to theirs. Tests set them to 0.
 */
export interface PathCostOptions {
  passPenalty?: number;
  linkPenalty?: number;
  /**
   * Which unserved platforms a route pays to pass (default: all). RouteSet's search on built track
   * counts only built platforms: a planned or half-built stop no train can call at must not move a
   * running route onto the other pair.
   */
  platform?: (s: Station) => boolean;
}

/**
 * Penalties on top of track length (never negative, so Dijkstra stays exact). Gated to four-track
 * sections: only unserved platforms on a local- or express-pair edge, and only link edges, pay.
 * Ordinary track always costs exactly its length, so on a network without quads every path,
 * distance and stop position is bit-identical to the code before express service.
 */
interface CostModel {
  /** Penalty for travelling [a, b] (either order) on an edge. */
  part(edge: number, a: number, b: number): number;
  /**
   * Penalty for traversing the whole of edge `to` after `from`: its unserved platforms, plus the
   * link penalty when it starts a turnout or crossover (a connector is a run of link edges, lead
   * → diagonal → lead, and pays once).
   */
  full(from: number, to: number): number;
}

const NO_COST: CostModel = { part: () => 0, full: () => 0 };

function costModel(net: Network, stops: readonly number[], o: PathCostOptions): CostModel {
  const pass = o.passPenalty ?? QUAD.passPenalty;
  const link = o.linkPenalty ?? QUAD.linkPenalty;
  if (!(pass > 0) && !(link > 0)) return NO_COST;
  const served = new Set(stops);
  // Unserved platforms on four-track pairs, by edge (u along the edge).
  const plat = new Map<number, number[]>();
  if (pass > 0) {
    for (const s of net.stations.values()) {
      if (served.has(s.id) || (o.platform && !o.platform(s))) continue;
      const role = net.edges.get(s.edge)?.quad?.role;
      if (role !== 'local' && role !== 'express') continue;
      const l = plat.get(s.edge);
      if (l) l.push(s.u);
      else plat.set(s.edge, [s.u]);
    }
  }
  const part = (edge: number, a: number, b: number): number => {
    const l = plat.get(edge);
    if (!l) return 0;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let c = 0;
    for (const u of l) if (u > lo + 1 && u < hi - 1) c += pass;
    return c;
  };
  const memo = new Map<number, number>();
  const isLink = (edge: number) => link > 0 && net.edges.get(edge)?.quad?.role === 'link';
  const full = (from: number, to: number): number => {
    let c = memo.get(to);
    if (c === undefined) {
      c = part(to, -Infinity, Infinity);
      memo.set(to, c);
    }
    return isLink(to) && !isLink(from) ? c + link : c;
  };
  return { part, full };
}

/** Edges reachable from `edge` arriving at its end node in direction `dir`. */
type Usable = (edgeId: number) => boolean;
const ANY: Usable = () => true;

function successors(net: Network, edgeId: number, dir: 0 | 1, usable: Usable): { edge: number; dir: 0 | 1 }[] {
  const e = net.edges.get(edgeId)!;
  const node = dir === 0 ? e.b : e.a;
  const [ax, ay] = net.departHeading(edgeId, node); // heading leaving node along e (backwards)
  const arrX = -ax, arrY = -ay; // travel heading on arrival
  const out: { edge: number; dir: 0 | 1 }[] = [];
  for (const fid of net.incident(node)) {
    if (fid === edgeId) continue;
    const f = net.edges.get(fid)!;
    if (gaugeOf(f.cls) !== gaugeOf(e.cls) || !usable(fid)) continue;
    const [dx, dy] = net.departHeading(fid, node);
    if (arrX * dx + arrY * dy < ALIGN) continue;
    out.push({ edge: fid, dir: f.a === node ? 0 : 1 });
  }
  return out;
}

interface Leg {
  /** Path cost: distance plus the four-track penalties (equal to dist without them). */
  cost: number;
  /** Distance along the track, m. */
  dist: number;
  legs: PathLeg[];
}

/**
 * Shortest path from stop A (leaving in direction d) to stop B, by arrival direction. Each cost is
 * the distance term exactly as before plus a penalty (0 on ordinary track), and the distance of the
 * cheapest path is carried alongside in the same summation order.
 */
function legSearch(net: Network, A: StopPos, d: 0 | 1, B: StopPos, usable: Usable, cm: CostModel = NO_COST): [Leg | null, Leg | null] {
  const result: [Leg | null, Leg | null] = [null, null];
  const LA = net.geom(A.edge).length;
  // Direct on the same edge.
  if (A.edge === B.edge) {
    if ((d === 0 && B.u > A.u) || (d === 1 && B.u < A.u)) {
      const dd = Math.abs(B.u - A.u);
      result[d] = { cost: dd + cm.part(A.edge, A.u, B.u), dist: dd, legs: [{ edge: A.edge, dir: d, u0: A.u, u1: B.u }] };
      return result;
    }
  }
  const key = (edge: number, dir: number) => edge * 2 + dir;
  const dist = new Map<number, number>();
  /** Track distance of the cheapest label (the cost minus its penalties). */
  const along = new Map<number, number>();
  const prev = new Map<number, number>(); // key → previous key (−1 = start)
  const heap: [number, number][] = [];
  const startDist = d === 0 ? LA - A.u : A.u;
  const startCost = startDist + cm.part(A.edge, A.u, d === 0 ? LA : 0);
  const startKey = key(A.edge, d);
  dist.set(startKey, startCost);
  along.set(startKey, startDist);
  prev.set(startKey, -1);
  heap.push([startCost, startKey]);
  const done = new Set<number>();
  const LB = net.geom(B.edge).length;
  while (heap.length) {
    // Small graphs: linear-scan priority queue is fine.
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
    const [c, k] = heap[bi];
    heap[bi] = heap[heap.length - 1];
    heap.pop();
    if (done.has(k)) continue;
    done.add(k);
    const edge = k >> 1;
    const dir = (k & 1) as 0 | 1;
    const dk = along.get(k)!;
    for (const s of successors(net, edge, dir, usable)) {
      const sk = key(s.edge, s.dir);
      if (s.edge === B.edge) {
        // Arrive at the target stop on this edge.
        const ad = s.dir === 0 ? B.u : LB - B.u;
        const arrive = c + (ad + cm.part(B.edge, s.dir === 0 ? 0 : LB, B.u));
        const cur = result[s.dir];
        if (!cur || arrive < cur.cost) {
          result[s.dir] = { cost: arrive, dist: dk + ad, legs: reconstruct(k, prev, A, d, B, s.dir, net) };
        }
      }
      const len = net.geom(s.edge).length;
      const nc = c + (len + cm.full(edge, s.edge));
      if (nc < (dist.get(sk) ?? Infinity)) {
        dist.set(sk, nc);
        along.set(sk, dk + len);
        prev.set(sk, k);
        heap.push([nc, sk]);
      }
    }
  }
  return result;
}

function reconstruct(
  lastKey: number,
  prev: Map<number, number>,
  A: StopPos,
  d: 0 | 1,
  B: StopPos,
  bDir: 0 | 1,
  net: Network,
): PathLeg[] {
  const keys: number[] = [];
  let k = lastKey;
  while (k !== -1) {
    keys.push(k);
    k = prev.get(k)!;
  }
  keys.reverse();
  const legs: PathLeg[] = [];
  for (let i = 0; i < keys.length; i++) {
    const edge = keys[i] >> 1;
    const dir = (keys[i] & 1) as 0 | 1;
    const L = net.geom(edge).length;
    const u0 = i === 0 ? A.u : dir === 0 ? 0 : L;
    const u1 = dir === 0 ? L : 0;
    legs.push({ edge, dir, u0, u1 });
  }
  void d;
  const LB = net.geom(B.edge).length;
  legs.push({ edge: B.edge, dir: bDir, u0: bDir === 0 ? 0 : LB, u1: B.u });
  return legs;
}

/**
 * Track path from A to B (either departure direction, the cheaper one; four-track penalties as
 * for a route that serves no platform in between), or null if B can't be reached without
 * reversing. Legs in travel order, merged. For the express-pair retrofit (stretch, §15).
 */
export function trackPath(net: Network, A: StopPos, B: StopPos, usable: Usable = ANY, costs: PathCostOptions = {}): PathLeg[] | null {
  const cm = costModel(net, [], costs);
  let best: Leg | null = null;
  for (const d of [0, 1] as const) {
    for (const r of legSearch(net, A, d, B, usable, cm)) if (r && (!best || r.cost < best.cost)) best = r;
  }
  return best ? mergeLegs(best.legs) : null;
}

/**
 * `usable` restricts which edges the path may use (e.g. only built track, so a planned
 * shortcut doesn't take a running route out of service). `costs` overrides the four-track
 * penalties (tests). `stopS` and `length` are track distances, never penalised costs.
 */
export function findRoutePath(net: Network, cls: TrackClass, stops: number[], usable: Usable = ANY, costs: PathCostOptions = {}): RoutePath {
  const fail = (error: string): RoutePath => ({ ok: false, error, legs: [], stopS: [], length: 0 });
  if (stops.length < 2) return fail('A route needs at least two stations');
  if (new Set(stops).size !== stops.length) return fail('A route can visit each station only once');
  const pos: StopPos[] = [];
  for (const id of stops) {
    const s = net.stations.get(id);
    if (!s) return fail('A station on this route no longer exists');
    const e = net.edges.get(s.edge);
    if (!e) return fail('A station on this route has no track');
    if (gaugeOf(e.cls) !== gaugeOf(cls)) return fail(`${s.name} is on ${gaugeOf(e.cls)} track`);
    pos.push({ edge: s.edge, u: s.u });
  }
  const cm = costModel(net, stops, costs);
  // best[d] for the current stop, with the legs that got there.
  let best: [Leg | null, Leg | null] = [
    { cost: 0, dist: 0, legs: [] },
    { cost: 0, dist: 0, legs: [] },
  ];
  const stopS: number[] = [0];
  const stopSByDir: [number[], number[]] = [[0], [0]];
  for (let i = 0; i + 1 < pos.length; i++) {
    const next: [Leg | null, Leg | null] = [null, null];
    const nextStops: [number[], number[]] = [[], []];
    for (const d of [0, 1] as const) {
      const cur = best[d];
      if (!cur) continue;
      const res = legSearch(net, pos[i], d, pos[i + 1], usable, cm);
      for (const d2 of [0, 1] as const) {
        const r = res[d2];
        if (!r) continue;
        const total = cur.cost + r.cost;
        if (!next[d2] || total < next[d2]!.cost) {
          const dist = cur.dist + r.dist;
          next[d2] = { cost: total, dist, legs: [...cur.legs, ...r.legs] };
          nextStops[d2] = [...stopSByDir[d], dist];
        }
      }
    }
    if (!next[0] && !next[1]) {
      const a = net.stations.get(stops[i])!.name;
      const b = net.stations.get(stops[i + 1])!.name;
      return fail(`No connected track from ${a} to ${b} (trains can't reverse mid-route)`);
    }
    best = next;
    stopSByDir[0] = nextStops[0];
    stopSByDir[1] = nextStops[1];
  }
  const d = best[0] && (!best[1] || best[0].cost <= best[1].cost) ? 0 : 1;
  const win = best[d]!;
  stopS.length = 0;
  stopS.push(...stopSByDir[d]);
  return { ok: true, legs: mergeLegs(win.legs), stopS, length: win.dist };
}

/** Join consecutive legs on the same edge and drop zero-length pieces. */
function mergeLegs(legs: PathLeg[]): PathLeg[] {
  const out: PathLeg[] = [];
  for (const l of legs) {
    if (Math.abs(l.u1 - l.u0) < 1e-6) continue;
    const last = out[out.length - 1];
    if (last && last.edge === l.edge && last.dir === l.dir && Math.abs(last.u1 - l.u0) < 1e-6) last.u1 = l.u1;
    else out.push({ ...l });
  }
  return out;
}

/** Edges a route path touches. */
export function pathEdges(legs: PathLeg[]): Set<number> {
  return new Set(legs.map((l) => l.edge));
}

export { otherEnd };
