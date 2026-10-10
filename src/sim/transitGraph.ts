/**
 * Transit graph for pathfinding. Nodes are platforms (route, direction, stop), each in two
 * layers so a path can only end, or transfer, after actually riding:
 *   waiting  p        reached by an access walk or a transfer
 *   on board P + p    reached only by riding
 * Edges:
 *   board     waiting p → on board (next stop), scheduled time
 *   ride      on board k → on board k+1 on the same route and direction
 *   transfer  on board (alight) → waiting at the same station or an interchange
 *             (walk + half the outgoing route's headway, capped, + transfer penalty)
 * Access and egress walks connect tracts to stations.
 */
import { COMMUTERS } from '../balance';
import type { CompiledNetwork } from './protocol';
import { transferTime } from '../routes/interchange';

export interface Leg {
  route: number;
  dir: number;
  board: number;
  alight: number;
}

export class TransitGraph {
  readonly P: number;
  platRoute: Int32Array;
  platDir: Uint8Array;
  platStop: Int32Array;
  platStation: Int32Array;
  canBoard: Uint8Array;
  canAlight: Uint8Array;
  rideNext: Int32Array;
  rideCost: Float64Array;
  trOff: Int32Array;
  trTo: Int32Array;
  trWalk: Float64Array;
  /** First platform index of each route-direction. */
  base: number[][];
  /** Board platforms per station. */
  stationBoard: number[][];
  stationAlight: number[][];
  private wait = new Float64Array(0);

  // Dijkstra scratch
  dist: Float64Array;
  prev: Int32Array;
  private heapK: Float64Array;
  private heapV: Int32Array;
  private heapN = 0;
  private stamp: Int32Array;
  private epoch = 1;

  constructor(readonly net: CompiledNetwork) {
    const base: number[][] = [];
    let P = 0;
    for (const r of net.routes) {
      base.push([P, P + r.dirs[0].stopS.length]);
      P += r.dirs[0].stopS.length + r.dirs[1].stopS.length;
    }
    this.P = P;
    this.base = base;
    this.platRoute = new Int32Array(P);
    this.platDir = new Uint8Array(P);
    this.platStop = new Int32Array(P);
    this.platStation = new Int32Array(P);
    this.canBoard = new Uint8Array(P);
    this.canAlight = new Uint8Array(P);
    this.rideNext = new Int32Array(P).fill(-1);
    this.rideCost = new Float64Array(P);
    const S = net.stations.length;
    this.stationBoard = Array.from({ length: S }, () => []);
    this.stationAlight = Array.from({ length: S }, () => []);
    net.routes.forEach((r, ri) => {
      for (const d of [0, 1]) {
        const dir = r.dirs[d];
        const n = dir.stopS.length;
        for (let k = 0; k < n; k++) {
          const p = base[ri][d] + k;
          this.platRoute[p] = ri;
          this.platDir[p] = d;
          this.platStop[p] = k;
          this.platStation[p] = dir.stopStation[k];
          if (k < n - 1) {
            this.canBoard[p] = 1;
            this.rideNext[p] = p + 1;
            this.rideCost[p] = dir.schedArrive[k + 1] - dir.schedArrive[k];
            this.stationBoard[dir.stopStation[k]].push(p);
          }
          if (k > 0) {
            this.canAlight[p] = 1;
            this.stationAlight[dir.stopStation[k]].push(p);
          }
        }
      }
    });
    // Transfers: alight platform → board platforms in the same interchange group.
    const groups = new Map<number, number[]>();
    net.stations.forEach((s, i) => {
      let g = groups.get(s.group);
      if (!g) groups.set(s.group, (g = []));
      g.push(i);
    });
    const off = new Int32Array(P + 1);
    const to: number[] = [];
    const walk: number[] = [];
    for (let p = 0; p < P; p++) {
      off[p] = to.length;
      if (!this.canAlight[p]) continue;
      const st = this.platStation[p];
      const sp = net.stations[st];
      for (const st2 of groups.get(sp.group) ?? [st]) {
        const s2 = net.stations[st2];
        const w = transferTime(Math.hypot(s2.x - sp.x, s2.y - sp.y));
        for (const q of this.stationBoard[st2]) {
          if (this.platRoute[q] === this.platRoute[p] && this.platDir[q] === this.platDir[p]) continue;
          to.push(q);
          walk.push(w);
        }
      }
    }
    off[P] = to.length;
    this.trOff = off;
    this.trTo = new Int32Array(to);
    this.trWalk = new Float64Array(walk);
    this.dist = new Float64Array(2 * P);
    this.prev = new Int32Array(2 * P);
    this.stamp = new Int32Array(2 * P);
    const cap = Math.max(16, 2 * P + to.length + 16);
    this.heapK = new Float64Array(cap);
    this.heapV = new Int32Array(cap);
  }

  /** Set the period: expected wait per platform = min(cap, headway / 2); Infinity if no service. */
  setPeriod(period: number): void {
    this.wait = new Float64Array(this.P);
    for (let p = 0; p < this.P; p++) {
      const hw = this.net.routes[this.platRoute[p]].headways[period];
      this.wait[p] = hw > 0 ? Math.min(COMMUTERS.waitCap, hw / 2) : Infinity;
    }
  }

  waitAt(p: number): number {
    return this.wait[p];
  }

  /**
   * Multi-source Dijkstra from access stations [(station, walk seconds)].
   * After the call, dist/prev are valid for nodes whose stamp equals the current epoch.
   */
  run(access: { station: number; walk: number }[]): void {
    const e = ++this.epoch;
    const { dist, prev, stamp } = this;
    const P = this.P;
    this.heapN = 0;
    const relax = (node: number, c: number, from: number) => {
      if (stamp[node] !== e || c < dist[node]) {
        stamp[node] = e;
        dist[node] = c;
        prev[node] = from;
        this.push(c, node);
      }
    };
    for (const a of access) {
      for (const p of this.stationBoard[a.station]) {
        const c = a.walk + this.wait[p];
        if (isFinite(c)) relax(p, c, -1);
      }
    }
    const penalty = COMMUTERS.transferPenalty;
    while (this.heapN > 0) {
      const c = this.heapK[0];
      const node = this.pop();
      if (c > dist[node]) continue;
      if (node < P) {
        // Waiting at p: board and ride to the next stop.
        const q = this.rideNext[node];
        if (q >= 0) relax(P + q, c + this.rideCost[node], node);
        continue;
      }
      const p = node - P;
      // On board arriving at p: stay on…
      const q = this.rideNext[p];
      if (q >= 0) relax(P + q, c + this.rideCost[p], node);
      // …or get off and transfer.
      for (let k = this.trOff[p]; k < this.trOff[p + 1]; k++) {
        const t = this.trTo[k];
        const nc = c + this.trWalk[k] + this.wait[t] + penalty;
        if (isFinite(nc)) relax(t, nc, node);
      }
    }
  }

  /** Best arrival on board (generalised seconds incl. transfer penalties) at a station. */
  bestArrival(station: number): { cost: number; plat: number } {
    let best = Infinity;
    let plat = -1;
    const P = this.P;
    for (const p of this.stationAlight[station]) {
      const node = P + p;
      if (this.stamp[node] !== this.epoch) continue;
      if (this.dist[node] < best) {
        best = this.dist[node];
        plat = p;
      }
    }
    return { cost: best, plat };
  }

  /** Legs ending on board at platform p (after run()). */
  legsTo(p: number): Leg[] {
    const P = this.P;
    const legs: Leg[] = [];
    let alight = p;
    let node = P + p;
    let guard = 0;
    while (node >= 0 && guard++ < 10000) {
      const pr = this.prev[node];
      if (node < P) {
        // Waiting node: this is where the current leg boarded.
        legs.push({ route: this.platRoute[node], dir: this.platDir[node], board: this.platStop[node], alight: this.platStop[alight] });
        if (pr >= 0) alight = pr - P; // transferred off this on-board platform
      }
      node = pr;
    }
    return legs.reverse();
  }

  private push(k: number, v: number): void {
    if (this.heapN >= this.heapK.length) {
      const nk = new Float64Array(this.heapK.length * 2);
      nk.set(this.heapK);
      const nv = new Int32Array(this.heapV.length * 2);
      nv.set(this.heapV);
      this.heapK = nk;
      this.heapV = nv;
    }
    let i = this.heapN++;
    const K = this.heapK, V = this.heapV;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (K[par] <= k) break;
      K[i] = K[par];
      V[i] = V[par];
      i = par;
    }
    K[i] = k;
    V[i] = v;
  }

  private pop(): number {
    const K = this.heapK, V = this.heapV;
    const top = V[0];
    const n = --this.heapN;
    if (n > 0) {
      const k = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c];
        V[i] = V[c];
        i = c;
      }
      K[i] = k;
      V[i] = v;
    }
    return top;
  }
}
