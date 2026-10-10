/**
 * Find a route's path along connected track through its stations in order.
 *
 * Trains can't reverse mid-route, so the search state is (edge, travel direction). At a node a
 * train may only continue onto an edge whose departure heading lines up with its arrival heading:
 * straight through a junction or onto a branch, never a V-turn back down the other branch.
 */
import type { Network } from '../construction/network';
import { otherEnd } from '../construction/geometry';
import type { PathLeg, RoutePath } from './types';
import type { TrackClass } from '../balance';

const ALIGN = Math.cos((25 * Math.PI) / 180);

interface StopPos {
  edge: number;
  u: number;
}

/** Edges reachable from `edge` arriving at its end node in direction `dir`. */
function successors(net: Network, edgeId: number, dir: 0 | 1): { edge: number; dir: 0 | 1 }[] {
  const e = net.edges.get(edgeId)!;
  const node = dir === 0 ? e.b : e.a;
  const [ax, ay] = net.departHeading(edgeId, node); // heading leaving node along e (backwards)
  const arrX = -ax, arrY = -ay; // travel heading on arrival
  const out: { edge: number; dir: 0 | 1 }[] = [];
  for (const fid of net.incident(node)) {
    if (fid === edgeId) continue;
    const f = net.edges.get(fid)!;
    if (f.cls !== e.cls) continue;
    const [dx, dy] = net.departHeading(fid, node);
    if (arrX * dx + arrY * dy < ALIGN) continue;
    out.push({ edge: fid, dir: f.a === node ? 0 : 1 });
  }
  return out;
}

interface Leg {
  cost: number;
  legs: PathLeg[];
}

/** Shortest path from stop A (leaving in direction d) to stop B, by arrival direction. */
function legSearch(net: Network, A: StopPos, d: 0 | 1, B: StopPos): [Leg | null, Leg | null] {
  const result: [Leg | null, Leg | null] = [null, null];
  const LA = net.geom(A.edge).length;
  // Direct on the same edge.
  if (A.edge === B.edge) {
    if ((d === 0 && B.u > A.u) || (d === 1 && B.u < A.u)) {
      result[d] = { cost: Math.abs(B.u - A.u), legs: [{ edge: A.edge, dir: d, u0: A.u, u1: B.u }] };
      return result;
    }
  }
  const key = (edge: number, dir: number) => edge * 2 + dir;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>(); // key → previous key (−1 = start)
  const heap: [number, number][] = [];
  const startCost = d === 0 ? LA - A.u : A.u;
  const startKey = key(A.edge, d);
  dist.set(startKey, startCost);
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
    for (const s of successors(net, edge, dir)) {
      const sk = key(s.edge, s.dir);
      if (s.edge === B.edge) {
        // Arrive at the target stop on this edge.
        const arrive = c + (s.dir === 0 ? B.u : LB - B.u);
        const cur = result[s.dir];
        if (!cur || arrive < cur.cost) {
          result[s.dir] = { cost: arrive, legs: reconstruct(k, prev, A, d, B, s.dir, net) };
        }
      }
      const nc = c + net.geom(s.edge).length;
      if (nc < (dist.get(sk) ?? Infinity)) {
        dist.set(sk, nc);
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

export function findRoutePath(net: Network, cls: TrackClass, stops: number[]): RoutePath {
  const fail = (error: string): RoutePath => ({ ok: false, error, legs: [], stopS: [], length: 0 });
  if (stops.length < 2) return fail('A route needs at least two stations');
  if (new Set(stops).size !== stops.length) return fail('A route can visit each station only once');
  const pos: StopPos[] = [];
  for (const id of stops) {
    const s = net.stations.get(id);
    if (!s) return fail('A station on this route no longer exists');
    const e = net.edges.get(s.edge);
    if (!e) return fail('A station on this route has no track');
    if (e.cls !== cls) return fail(`${s.name} is on ${e.cls} metro track`);
    pos.push({ edge: s.edge, u: s.u });
  }
  // best[d] for the current stop, with the legs that got there.
  let best: [Leg | null, Leg | null] = [
    { cost: 0, legs: [] },
    { cost: 0, legs: [] },
  ];
  const stopS: number[] = [0];
  const stopSByDir: [number[], number[]] = [[0], [0]];
  for (let i = 0; i + 1 < pos.length; i++) {
    const next: [Leg | null, Leg | null] = [null, null];
    const nextStops: [number[], number[]] = [[], []];
    for (const d of [0, 1] as const) {
      const cur = best[d];
      if (!cur) continue;
      const res = legSearch(net, pos[i], d, pos[i + 1]);
      for (const d2 of [0, 1] as const) {
        const r = res[d2];
        if (!r) continue;
        const total = cur.cost + r.cost;
        if (!next[d2] || total < next[d2]!.cost) {
          next[d2] = { cost: total, legs: [...cur.legs, ...r.legs] };
          nextStops[d2] = [...stopSByDir[d], total];
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
  return { ok: true, legs: mergeLegs(win.legs), stopS, length: win.cost };
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
