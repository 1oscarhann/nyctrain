/**
 * Train operations: dispatch from terminals on schedule, kinematics, dwell, moving-block
 * signalling over shared track, first-come-first-served junction merges, turnarounds.
 *
 * Positions are path distances `s` (metres) along a route direction's compiled path; the
 * train's head is at s and its tail at s − trainLength.
 */
import { OPERATIONS, TIME } from '../balance';
import type { CompiledNetwork, CRoute, CRouteDir } from './protocol';

export const enum TState {
  Ready = 0, // waiting off-track at a terminal for its next departure slot
  Running = 1,
  Dwelling = 2,
  Turnaround = 3,
}

export interface Train {
  id: number;
  route: number;
  routeId: number;
  dir: 0 | 1;
  s: number;
  v: number;
  state: TState;
  /** Index of the next stop (the one it is heading to or dwelling at). */
  stop: number;
  until: number;
  /** Timetable: when this trip was scheduled to leave its first stop. */
  schedStart: number;
  late: number;
  /** Agents on board, bucketed by the stop index where they get off. */
  buckets: number[][];
  load: number;
  elem: number;
  lim: number;
  locks: { lock: number; release: number; s0: number; since: number }[];
  stoppedSince: number;
  lastS: number;
}

/** Callbacks into the passenger model. */
export interface PassengerHooks {
  /** Train arrived at a stop: alight + board. Returns counts for the dwell time. */
  arrive(train: Train, route: CRoute, stopIdx: number, t: number): { alight: number; board: number };
  /** Train about to leave: last-moment boarding. */
  depart(train: Train, route: CRoute, stopIdx: number, t: number): void;
  /** Train removed with people on board (route changed or deadlock): deliver them. */
  evacuate(train: Train, t: number): void;
}

interface DispatchState {
  next: [number, number];
  pending: [number[], number[]];
  ready: [number[], number[]];
}

interface OccEntry {
  train: number;
  tail: number;
  head: number;
}

export interface TrainDayStats {
  carKm: number;
  lateSum: number;
  lateCount: number;
  deadlocks: number;
  routeLate: Map<number, { sum: number; n: number }>;
}

export class TrainSim {
  net: CompiledNetwork | null = null;
  trains: Train[] = [];
  private dispatch: DispatchState[] = [];
  /** Dispatch state survives network updates for routes whose path didn't change. */
  private dispatchById = new Map<number, DispatchState>();
  private occ: OccEntry[][] = [];
  private lockHolder = new Int32Array(0);
  private nextTrainId = 1;
  day: TrainDayStats = newDayStats();

  constructor(private hooks: PassengerHooks) {}

  // ------------------------------------------------------------------ network updates
  setNetwork(net: CompiledNetwork, t: number): void {
    const old = this.net;
    const oldTrains = this.trains;
    this.net = net;
    this.trains = [];
    this.dispatch = [];
    this.occ = Array.from({ length: net.trackCount }, () => []);
    this.lockHolder = new Int32Array(net.lockCount).fill(-1);
    const newById = new Map<number, DispatchState>();
    const oldByRoute = new Map<number, Train[]>();
    for (const tr of oldTrains) {
      let l = oldByRoute.get(tr.routeId);
      if (!l) oldByRoute.set(tr.routeId, (l = []));
      l.push(tr);
    }
    net.routes.forEach((r, ri) => {
      const prev = old?.routes.find((o) => o.id === r.id) ?? null;
      const samePath = prev !== null && samePaths(prev, r);
      const ds: DispatchState = { next: [0, 0], pending: [[], []], ready: [[], []] };
      this.dispatch.push(ds);
      const keep = oldByRoute.get(r.id) ?? [];
      oldByRoute.delete(r.id);
      for (const tr of keep) {
        tr.route = ri;
        tr.locks = [];
        if (!samePath) {
          // Path changed: deliver passengers, send the train back to a terminal.
          if (tr.load > 0) this.hooks.evacuate(tr, t);
          this.toReady(tr, (tr.dir as number) === 1 ? 1 : 0);
        } else if (tr.state === TState.Ready) {
          ds.ready[tr.dir].push(tr.id);
        }
        if (tr.buckets.length !== r.dirs[tr.dir].stopS.length) tr.buckets = r.dirs[tr.dir].stopS.length ? Array.from(r.dirs[tr.dir].stopS, () => []) : [];
        this.trains.push(tr);
      }
      // Rebuild ready queues for re-pathed trains.
      for (const tr of keep) if (!samePath && tr.state === TState.Ready && !ds.ready[tr.dir].includes(tr.id)) ds.ready[tr.dir].push(tr.id);
      // Grow the fleet: new trains wait at alternating terminals.
      let count = keep.length;
      let k = 0;
      while (count < r.fleet) {
        const dir = (k++ % 2) as 0 | 1;
        const tr = this.newTrain(ri, r, dir);
        this.trains.push(tr);
        ds.ready[dir].push(tr.id);
        count++;
      }
      // Dispatch timing: keep the old schedule if the path is unchanged (react to new headways).
      const pds = samePath ? this.dispatchById.get(r.id) : undefined;
      for (const d of [0, 1] as const) {
        if (pds) {
          const hw = r.headways[periodIndex(t)] || 600;
          ds.next[d] = Math.min(pds.next[d], this.nextServiceTime(r, t + hw));
          ds.pending[d] = pds.pending[d].slice(-2);
        } else ds.next[d] = this.nextServiceTime(r, t + (d === 1 ? 30 : 0));
      }
      newById.set(r.id, ds);
    });
    this.dispatchById = newById;
    // Routes that vanished: deliver anyone on board.
    for (const trs of oldByRoute.values()) for (const tr of trs) if (tr.load > 0) this.hooks.evacuate(tr, t);
  }

  private newTrain(ri: number, r: CRoute, dir: 0 | 1): Train {
    return {
      id: this.nextTrainId++,
      route: ri,
      routeId: r.id,
      dir,
      s: 0,
      v: 0,
      state: TState.Ready,
      stop: 0,
      until: 0,
      schedStart: 0,
      late: 0,
      buckets: Array.from(r.dirs[dir].stopS, () => []),
      load: 0,
      elem: 0,
      lim: 0,
      locks: [],
      stoppedSince: 0,
      lastS: 0,
    };
  }

  private toReady(tr: Train, dir: 0 | 1): void {
    this.releaseLocks(tr);
    tr.state = TState.Ready;
    tr.dir = dir;
    tr.v = 0;
    tr.s = 0;
    tr.stop = 0;
    tr.load = 0;
    const r = this.net!.routes[tr.route];
    tr.buckets = Array.from(r.dirs[dir].stopS, () => []);
    this.dispatch[tr.route].ready[dir].push(tr.id);
  }

  /** Earliest time ≥ t when the route has service. */
  nextServiceTime(r: CRoute, t: number): number {
    for (let k = 0; k < 48 * 6; k++) {
      const tt = t + k * 600;
      if (r.headways[periodIndex(tt)] > 0) return k === 0 ? t : Math.floor(tt / 600) * 600;
    }
    return Infinity;
  }

  // ------------------------------------------------------------------ stepping
  step(t: number, dt: number): void {
    const net = this.net;
    if (!net) return;
    this.runDispatch(t);
    this.buildOccupancy();
    const byId = this.trainIndex();
    for (const tr of this.trains) {
      switch (tr.state) {
        case TState.Dwelling:
          if (t >= tr.until) this.leaveStop(tr, t);
          break;
        case TState.Running:
          this.move(tr, t, dt, byId);
          break;
        case TState.Turnaround:
          if (t >= tr.until) this.toReady(tr, tr.dir === 0 ? 1 : 0);
          break;
      }
    }
  }

  private trainIndex(): Map<number, number> {
    const m = new Map<number, number>();
    this.trains.forEach((tr, i) => m.set(tr.id, i));
    return m;
  }

  private runDispatch(t: number): void {
    const net = this.net!;
    net.routes.forEach((r, ri) => {
      const ds = this.dispatch[ri];
      for (const d of [0, 1] as const) {
        // New departure slots.
        let guard = 0;
        while (t >= ds.next[d] && guard++ < 20) {
          ds.pending[d].push(ds.next[d]);
          const hw = r.headways[periodIndex(ds.next[d])];
          ds.next[d] = hw > 0 ? ds.next[d] + hw : this.nextServiceTime(r, ds.next[d] + 1);
        }
        // Too many missed slots: a late train still goes, but don't stack a backlog forever.
        while (ds.pending[d].length > 2) ds.pending[d].shift();
        if (!ds.pending[d].length || !ds.ready[d].length) continue;
        const dir = r.dirs[d];
        const headS = Math.min(dir.length, dir.stopS[0] + r.trainLength / 2);
        if (!this.regionFree(dir, headS - r.trainLength - 30, headS + 30)) continue;
        const slot = ds.pending[d].shift()!;
        const id = ds.ready[d].shift()!;
        const tr = this.trains.find((x) => x.id === id);
        if (!tr) continue;
        tr.dir = d;
        tr.s = headS;
        tr.lastS = headS;
        tr.v = 0;
        tr.stop = 0;
        tr.elem = 0;
        tr.lim = 0;
        tr.schedStart = slot;
        tr.late = Math.max(0, t - slot);
        tr.stoppedSince = t;
        if (tr.buckets.length !== dir.stopS.length) tr.buckets = Array.from(dir.stopS, () => []);
        this.advanceElem(tr, dir);
        this.register(tr, r, this.trains.indexOf(tr));
        this.arriveAt(tr, r, 0, t);
      }
    });
  }

  /** Is the stretch [s0, s1] of a route direction clear of other trains? */
  private regionFree(dir: CRouteDir, s0: number, s1: number): boolean {
    for (const el of dir.elems) {
      if (el.s1 < s0 || el.s0 > s1) continue;
      const u0 = el.u0 + (Math.max(s0, el.s0) - el.s0);
      const u1 = el.u0 + (Math.min(s1, el.s1) - el.s0);
      for (const o of this.occ[el.track]) if (o.head >= u0 && o.tail <= u1) return false;
    }
    return true;
  }

  private buildOccupancy(): void {
    for (const l of this.occ) l.length = 0;
    const net = this.net!;
    this.trains.forEach((tr, i) => {
      if (tr.state !== TState.Running && tr.state !== TState.Dwelling) return;
      this.register(tr, net.routes[tr.route], i);
    });
  }

  private register(tr: Train, r: CRoute, idx: number): void {
    const dir = r.dirs[tr.dir];
    const head = tr.s;
    const tail = tr.s - r.trainLength;
    for (let k = tr.elem; k >= 0; k--) {
      const el = dir.elems[k];
      if (el.s1 < tail) break;
      const a = Math.max(tail, el.s0), b = Math.min(head, el.s1);
      if (b < a) continue;
      this.occ[el.track].push({ train: idx, tail: el.u0 + (a - el.s0), head: el.u0 + (b - el.s0) });
    }
  }

  private advanceElem(tr: Train, dir: CRouteDir): void {
    while (tr.elem + 1 < dir.elems.length && dir.elems[tr.elem].s1 < tr.s) tr.elem++;
  }

  private move(tr: Train, t: number, dt: number, byId: Map<number, number>): void {
    const net = this.net!;
    const r = net.routes[tr.route];
    const dir = r.dirs[tr.dir];
    const L = r.trainLength;
    const b = r.brake;
    const s = tr.s;
    const v = tr.v;
    const look = (v * v) / (2 * b) + v * dt * 2 + OPERATIONS.safetyMargin + 80;
    let vAllow = r.vmax;
    let hard = dir.length; // never move past this

    // Curve limits apply until the tail clears the curve.
    while (tr.lim < dir.limS0.length && dir.limS1[tr.lim] < s - L) tr.lim++;
    for (let j = tr.lim; j < dir.limS0.length && dir.limS0[j] < s + look; j++) {
      const lv = dir.limV[j];
      if (dir.limS0[j] <= s && dir.limS1[j] >= s - L) vAllow = Math.min(vAllow, lv);
      else if (dir.limS0[j] > s) vAllow = Math.min(vAllow, Math.sqrt(lv * lv + 2 * b * (dir.limS0[j] - s)));
    }

    // Next stop: the head stops so the train is centred on the platform.
    const stopHead = Math.min(dir.length, dir.stopS[tr.stop] + L / 2);
    vAllow = Math.min(vAllow, Math.sqrt(2 * b * Math.max(0, stopHead - s)));
    hard = Math.min(hard, stopHead);

    // Moving block: stay braking distance + margin behind the train ahead.
    const me = byId.get(tr.id)!;
    let obs = Infinity;
    for (let k = tr.elem; k < dir.elems.length; k++) {
      const el = dir.elems[k];
      if (el.s0 > s + look) break;
      const myU = k === tr.elem ? el.u0 + (s - el.s0) : el.u0;
      const endU = el.u0 + (el.s1 - el.s0);
      for (const o of this.occ[el.track]) {
        if (o.train === me) continue;
        if (o.tail < myU - 0.01 || o.tail > endU) continue;
        const so = el.s0 + (o.tail - el.u0);
        if (so < obs) obs = so;
      }
      if (obs < Infinity) break;
    }
    if (obs < Infinity) {
      const room = obs - OPERATIONS.safetyMargin - s;
      vAllow = Math.min(vAllow, Math.sqrt(2 * b * Math.max(0, room)));
      hard = Math.min(hard, obs - 5);
    }

    // Junction merges: first come, first served.
    for (let k = tr.elem + 1; k < dir.elems.length; k++) {
      const el = dir.elems[k];
      if (el.s0 > s + look) break;
      if (el.lock < 0) continue;
      // A train ahead of us will reach this junction first — let it claim it.
      if (obs < el.s0) break;
      const holder = this.lockHolder[el.lock];
      if (holder === tr.id) continue;
      if (holder === -1) {
        this.lockHolder[el.lock] = tr.id;
        tr.locks.push({ lock: el.lock, release: el.s0 + L + 1, s0: el.s0, since: t });
      } else {
        const room = el.s0 - 15 - s;
        vAllow = Math.min(vAllow, Math.sqrt(2 * b * Math.max(0, room)));
        hard = Math.min(hard, el.s0 - 10);
        break;
      }
    }

    // Integrate.
    let vNew = Math.min(v + r.accel * dt, vAllow);
    vNew = Math.max(vNew, v - OPERATIONS.emergencyBrake * dt, 0);
    let ds = ((v + vNew) / 2) * dt;
    if (s + ds > hard) {
      ds = Math.max(0, hard - s);
      vNew = Math.min(vNew, ds / dt);
    }
    tr.s = s + ds;
    tr.v = vNew;
    this.day.carKm += (ds * r.cars) / 1000;
    this.advanceElem(tr, dir);

    // Release junctions the tail has cleared; give up claims while stalled far from them.
    if (tr.locks.length) {
      tr.locks = tr.locks.filter((l) => {
        if (tr.s >= l.release) {
          if (this.lockHolder[l.lock] === tr.id) this.lockHolder[l.lock] = -1;
          return false;
        }
        if (tr.v < 0.1 && tr.s < l.s0 - 1 && t - tr.stoppedSince > OPERATIONS.lockStallRelease) {
          if (this.lockHolder[l.lock] === tr.id) this.lockHolder[l.lock] = -1;
          return false;
        }
        return true;
      });
    }

    // Arrival.
    if (tr.s >= stopHead - 0.5) {
      tr.s = stopHead;
      tr.v = 0;
      this.arriveAt(tr, r, tr.stop, t);
    }

    // Watchdog.
    if (tr.s - tr.lastS > 1) {
      tr.lastS = tr.s;
      tr.stoppedSince = t;
    } else if (t - tr.stoppedSince > OPERATIONS.deadlockAfter) {
      this.day.deadlocks++;
      if (tr.load > 0) this.hooks.evacuate(tr, t);
      this.toReady(tr, tr.dir === 0 ? 1 : 0);
    }
  }

  private arriveAt(tr: Train, r: CRoute, stopIdx: number, t: number): void {
    const dir = r.dirs[tr.dir];
    tr.state = TState.Dwelling;
    tr.stop = stopIdx;
    tr.stoppedSince = t;
    tr.lastS = tr.s;
    if (stopIdx > 0) {
      tr.late = t - (tr.schedStart + dir.schedArrive[stopIdx]);
      this.day.lateSum += Math.max(0, tr.late);
      this.day.lateCount++;
      let rl = this.day.routeLate.get(r.id);
      if (!rl) this.day.routeLate.set(r.id, (rl = { sum: 0, n: 0 }));
      rl.sum += Math.max(0, tr.late);
      rl.n++;
    }
    const overComfort = tr.load > r.capComfort;
    const { alight, board } = this.hooks.arrive(tr, r, stopIdx, t);
    let dwell = OPERATIONS.dwellBase + ((alight + board) * OPERATIONS.dwellPerPassenger) / r.cars;
    dwell = Math.min(OPERATIONS.dwellMax, dwell);
    if (overComfort || tr.load > r.capComfort) dwell *= OPERATIONS.dwellCrowdedFactor;
    if (stopIdx === 0) dwell = Math.max(dwell, OPERATIONS.dwellBase);
    tr.until = t + dwell;
  }

  private leaveStop(tr: Train, t: number): void {
    const r = this.net!.routes[tr.route];
    const dir = r.dirs[tr.dir];
    if (tr.stop >= dir.stopS.length - 1) {
      // Terminal: clear the platform, turn around off the running track.
      this.releaseLocks(tr);
      tr.state = TState.Turnaround;
      tr.until = t + OPERATIONS.turnaround;
      tr.load = 0;
      return;
    }
    this.hooks.depart(tr, r, tr.stop, t);
    tr.stop++;
    tr.state = TState.Running;
    tr.stoppedSince = t;
  }

  private releaseLocks(tr: Train): void {
    for (const l of tr.locks) if (this.lockHolder[l.lock] === tr.id) this.lockHolder[l.lock] = -1;
    tr.locks = [];
  }

  resetDay(): void {
    this.day = newDayStats();
  }

  /** Trains currently in service per route index. */
  inService(ri: number): number {
    return this.trains.filter((tr) => tr.route === ri && tr.state !== TState.Ready).length;
  }
}

function newDayStats(): TrainDayStats {
  return { carKm: 0, lateSum: 0, lateCount: 0, deadlocks: 0, routeLate: new Map() };
}

function samePaths(a: CRoute, b: CRoute): boolean {
  if (a.trainLength !== b.trainLength) return false;
  for (const d of [0, 1]) {
    const x = a.dirs[d], y = b.dirs[d];
    if (Math.abs(x.length - y.length) > 0.5 || x.stopS.length !== y.stopS.length || x.elems.length !== y.elems.length) return false;
    for (let i = 0; i < x.elems.length; i++) if (x.elems[i].edge !== y.elems[i].edge) return false;
    for (let i = 0; i < x.stopS.length; i++) if (Math.abs(x.stopS[i] - y.stopS[i]) > 0.5) return false;
  }
  return true;
}

/** Period index (night, am, midday, pm, evening) for a game time. */
export function periodIndex(t: number): number {
  const h = ((t % 86400) + 86400) % 86400 / 3600;
  if (h < 6) return 0;
  if (h < 10) return 1;
  if (h < 16) return 2;
  if (h < 20) return 3;
  return 4;
}

export const SIM_STEP = TIME.simStep;
