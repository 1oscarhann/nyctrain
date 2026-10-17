/**
 * Train operations: dispatch from terminals on schedule, kinematics, dwell, moving-block
 * signalling over shared track, first-come-first-served junction merges, turnarounds, and (v2)
 * operations control: headway holding at the first stop and at timepoints, short turnarounds, and
 * regularity statistics.
 *
 * Positions are path distances `s` (metres) along a route direction's compiled path; the
 * train's head is at s and its tail at s − trainLength.
 */
import { OPERATIONS, OPS_CONTROL, TIME } from '../balance';
import type { CompiledNetwork, CRoute, CRouteDir, RouteRegularityDetail, ServiceOverride } from './protocol';
import { cvByStop, newRouteReg, poolStats, recordHeadway, rollDay, suggestRecovery, summarize, type RegularityStats, type RouteReg } from './regularity';

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
  /** City chaos: broken down (stalled) until this time. */
  holdUntil: number;
  /** City chaos: sick passenger; extra seconds to hold at the next open, non-terminal stop. */
  holdNext: number;
  /** Id of the incident (alert) affecting this train, or 0. */
  incident: number;
  /** Outdoor-stretch cursor (like lim for curve limits). */
  out: number;
}

/** A timepoint hold in progress (operations control), kept off the Train objects (hot in move/register). */
interface Hold {
  /** The hold ends by this time at the latest. */
  cap: number;
  start: number;
}

/** A temporary speed restriction (signal problem) on a directed track, in track coordinates. */
export interface TrackRestriction {
  id: number;
  edge: number;
  edgeDir: 0 | 1;
  u0: number;
  u1: number;
  /** Crawl speed, m/s. */
  v: number;
  until: number;
  /** Dense track index in the current network (filled by setRestrictions; −1 if the track is gone). */
  track: number;
}

/** Callbacks into the passenger model. */
export interface PassengerHooks {
  /** Train arrived at a stop: alight + board. Returns counts for the dwell time. */
  arrive(train: Train, route: CRoute, stopIdx: number, t: number): { alight: number; board: number };
  /** Train about to leave: last-moment boarding. */
  depart(train: Train, route: CRoute, stopIdx: number, t: number): void;
  /** Train removed with people on board (route changed or deadlock): deliver them. */
  evacuate(train: Train, t: number): void;
  /** Train runs through a closed stop: riders for it ride on to the next stop. */
  pass(train: Train, route: CRoute, stopIdx: number, t: number): void;
}

interface DispatchState {
  next: [number, number];
  pending: [number[], number[]];
  ready: [number[], number[]];
  /** Last departure slot per direction (event service pulls the next slot in from it). */
  last: [number, number];
  /** Operations control: a departure has been held at the first stop since this time (NaN = none). */
  holdSince: [number, number];
}

const NO_OVERRIDES: ServiceOverride[] = [];

export interface OccEntry {
  /** Index into TrainSim.trains. */
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
  /** Terminal turnarounds shortened because the next departure was already due. */
  shortTurns: number;
  /**
   * Four-track sections (v2), per route id: overtakes of another route's train between two
   * consecutive cross-platform stations both trains call at.
   */
  overtakes: Map<number, number>;
}

/** A train's last call at a cross-platform pair (the overtake counter). */
interface PairCall {
  key: number;
  t: number;
  /** Travel direction along the pair's reference platform (0/1). */
  sgn: number;
  route: number;
  routeId: number;
  dir: 0 | 1;
  stop: number;
}

/** Arrivals at a pair are remembered this long for the overtake counter (s), at most PAIR_LOG_MAX each. */
const PAIR_LOG_SPAN = 1800;
const PAIR_LOG_MAX = 16;

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
  // ---- city chaos (all inert at their defaults)
  /** Closed stations by compiled station index (game time they reopen); trains run through. */
  closedUntil: Float64Array = new Float64Array(0);
  /**
   * The deadlock watchdog ignores a route's stall time before this (an incident in progress on it,
   * or on a route it shares track or a junction with), by compiled route index.
   */
  private graceByRoute = new Float64Array(0);
  /** Routes that share track or a junction get the same group (compiled route index → group). */
  private routeGroup: Int32Array = new Int32Array(0);
  /** A sick-passenger hold has started at a station (compiled index). */
  onHold: ((tr: Train, stationIdx: number, t: number) => void) | null = null;
  private outdoorFactor = 1;
  private dwellFactor = 1;
  private restr: TrackRestriction[] = [];
  private restrOnTrack = new Uint8Array(0);
  private overrides: ServiceOverride[] = [];
  private ovByRoute: (ServiceOverride[] | undefined)[] = [];
  // ---- operations control (v2)
  /** Regularity accumulators by compiled route index (kept per route id while its path is unchanged). */
  private regs: RouteReg[] = [];
  private regById = new Map<number, RouteReg>();
  /** Yesterday's regularity per route id (rolled at midnight). */
  private yesterdayById = new Map<number, { stats: RegularityStats; byStop: [number[], number[]] }>();
  /** Timepoint holds in progress, by train id. */
  private holds = new Map<number, Hold>();
  // ---- four-track sections (v2): the overtake counter (inert without cross-platform pairs)
  private pairOn = false;
  /** Per compiled station: the pair key (the lower compiled index of its pair), or −1. */
  private pairKey = new Int32Array(0);
  /** Per route index and direction, per stop: travel sign along the pair's reference platform (−1: not a pair). */
  private stopSgn: [Int8Array, Int8Array][] = [];
  /** Per route index and direction, per stop: the key of the next pair called at after it (−1: none). */
  private nextPairAt: [Int32Array, Int32Array][] = [];
  /** Recent arrivals by key × 2 + sgn. */
  private pairLog = new Map<number, { train: number; t: number }[]>();
  /** Each train's last pair call, by train id. */
  private lastPair = new Map<number, PairCall>();

  /** Real people per agent: train loads are counted in agents, capacities in people. */
  constructor(private hooks: PassengerHooks, private agentScale = 1) {}

  // ------------------------------------------------------------------ network updates
  setNetwork(net: CompiledNetwork, t: number): void {
    const old = this.net;
    const oldTrains = this.trains;
    const oldGrace = new Map<number, number>();
    old?.routes.forEach((r, i) => {
      if (this.graceByRoute[i] > t) oldGrace.set(r.id, this.graceByRoute[i]);
    });
    this.graceByRoute = Float64Array.from(net.routes, (r) => oldGrace.get(r.id) ?? -Infinity);
    this.routeGroup = routeGroups(net);
    this.net = net;
    this.trains = [];
    this.dispatch = [];
    this.regs = [];
    const newRegs = new Map<number, RouteReg>();
    this.occ = Array.from({ length: net.trackCount }, () => []);
    this.lockHolder = new Int32Array(net.lockCount).fill(-1);
    this.resolveOverrides();
    this.setRestrictions(this.restr);
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
      const ds: DispatchState = { next: [0, 0], pending: [[], []], ready: [[], []], last: [-Infinity, -Infinity], holdSince: [NaN, NaN] };
      this.dispatch.push(ds);
      // Regularity survives an unchanged path (stops and their order are the same).
      let reg = samePath ? this.regById.get(r.id) : undefined;
      if (!reg) {
        reg = newRouteReg(r.id, r.dirs[0].stopS.length, r.dirs[1].stopS.length, (r.dirs[0].runTime + r.dirs[1].runTime) / 2);
        this.yesterdayById.delete(r.id);
      }
      newRegs.set(r.id, reg);
      this.regs.push(reg);
      const keep = oldByRoute.get(r.id) ?? [];
      oldByRoute.delete(r.id);
      for (const tr of keep) {
        tr.route = ri;
        tr.locks = [];
        // Holding switched off (or the path changed) while held at a timepoint: the hold ends now.
        const hd = this.holds.size ? this.holds.get(tr.id) : undefined;
        if (hd && (!r.hold || !samePath)) {
          reg.holds++;
          reg.holdSec += Math.max(0, t - hd.start);
          this.holds.delete(tr.id);
        }
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
      // Shrink the fleet if fewer (longer) trains fit the cars owned: idle trains go first.
      if (keep.length > r.fleet) {
        const order = [TState.Ready, TState.Turnaround, TState.Dwelling, TState.Running];
        const drop = [...keep].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)).slice(0, keep.length - r.fleet);
        const gone = new Set(drop.map((tr) => tr.id));
        for (const tr of drop) {
          if (tr.load > 0) this.hooks.evacuate(tr, t);
          this.releaseLocks(tr);
        }
        this.trains = this.trains.filter((tr) => !gone.has(tr.id));
        ds.ready[0] = ds.ready[0].filter((id) => !gone.has(id));
        ds.ready[1] = ds.ready[1].filter((id) => !gone.has(id));
        keep.splice(0, keep.length, ...keep.filter((tr) => !gone.has(tr.id)));
      }
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
          const hw = this.headwayAt(ri, r, t) || 600;
          ds.next[d] = Math.min(pds.next[d], this.nextServiceTime(ri, r, t + hw));
          ds.pending[d] = pds.pending[d].slice(-2);
          ds.last[d] = pds.last[d];
          if (r.hold) ds.holdSince[d] = pds.holdSince[d];
        } else ds.next[d] = this.nextServiceTime(ri, r, t + (d === 1 ? 30 : 0));
      }
      newById.set(r.id, ds);
    });
    this.dispatchById = newById;
    this.regById = newRegs;
    // Holds of trains that left the network (a shrunk fleet, a deleted route).
    if (this.holds.size) {
      const ids = new Set(this.trains.map((x) => x.id));
      for (const id of [...this.holds.keys()]) if (!ids.has(id)) this.holds.delete(id);
    }
    for (const id of [...this.yesterdayById.keys()]) if (!newRegs.has(id)) this.yesterdayById.delete(id);
    this.buildPairs(net);
    // Routes that vanished: deliver anyone on board.
    for (const trs of oldByRoute.values()) for (const tr of trs) if (tr.load > 0) this.hooks.evacuate(tr, t);
  }

  /**
   * An incident on these routes (ids) until `until`: trains on them, and on every route sharing
   * track or a junction with them (they can queue behind it), aren't counted as deadlocked meanwhile.
   */
  extendGrace(routeIds: readonly number[], until: number): void {
    const net = this.net;
    if (!net || !routeIds.length) return;
    const groups = new Set<number>();
    net.routes.forEach((r, ri) => {
      if (routeIds.includes(r.id)) groups.add(this.routeGroup[ri]);
    });
    for (let ri = 0; ri < net.routes.length; ri++) if (groups.has(this.routeGroup[ri]) && this.graceByRoute[ri] < until) this.graceByRoute[ri] = until;
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
      holdUntil: 0,
      holdNext: 0,
      incident: 0,
      out: 0,
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
    tr.holdUntil = 0;
    tr.holdNext = 0;
    tr.incident = 0;
    tr.out = 0;
    if (this.holds.size) this.holds.delete(tr.id);
    if (this.pairOn) this.lastPair.delete(tr.id);
    const r = this.net!.routes[tr.route];
    tr.buckets = Array.from(r.dirs[dir].stopS, () => []);
    this.dispatch[tr.route].ready[dir].push(tr.id);
  }

  /** Earliest time ≥ t when the route has service (its own or event service). */
  nextServiceTime(ri: number, r: CRoute, t: number): number {
    for (let k = 0; k < 48 * 6; k++) {
      const tt = t + k * 600;
      if (this.headwayAt(ri, r, tt) > 0) return k === 0 ? t : Math.floor(tt / 600) * 600;
    }
    return Infinity;
  }

  // ------------------------------------------------------------------ city chaos
  /** Today's weather: speed cap on outdoor track (factor of top speed) and the dwell factor. */
  setWeather(outdoor: number, dwell: number): void {
    this.outdoorFactor = outdoor;
    this.dwellFactor = dwell;
  }

  /** Replace the temporary speed restrictions; fills their track indices from the current network. */
  setRestrictions(list: TrackRestriction[]): void {
    this.restr = list;
    const net = this.net;
    this.restrOnTrack = new Uint8Array(net?.trackCount ?? 0);
    if (!net) return;
    for (const q of list) {
      q.track = -1;
      for (const r of net.routes) {
        for (const dir of r.dirs) {
          const el = dir.elems.find((e) => e.edge === q.edge && e.edgeDir === q.edgeDir);
          if (el) q.track = el.track;
        }
        if (q.track >= 0) break;
      }
      if (q.track >= 0) this.restrOnTrack[q.track] = 1;
    }
  }

  restrictions(): readonly TrackRestriction[] {
    return this.restr;
  }

  /** Event service: temporary headway overrides (the full list). */
  setOverrides(list: ServiceOverride[]): void {
    this.overrides = list.slice();
    this.resolveOverrides();
  }

  private resolveOverrides(): void {
    const net = this.net;
    this.ovByRoute = net ? net.routes.map((r) => {
      const l = this.overrides.filter((o) => o.routeId === r.id);
      return l.length ? l : undefined;
    }) : [];
  }

  /** Headway (s) at time tt: the route's own, shortened (or started, where it has none) by event service. */
  headwayAt(ri: number, r: CRoute, tt: number): number {
    const base = r.headways[periodIndex(tt)];
    const ovs = this.ovByRoute[ri];
    if (ovs) for (const o of ovs) if (tt >= o.from && tt < o.to) return base > 0 ? Math.min(base, o.headwayMin * 60) : o.headwayMin * 60;
    return base;
  }

  private activeOverride(ri: number, t: number): ServiceOverride | null {
    for (const o of this.ovByRoute[ri] ?? NO_OVERRIDES) if (t >= o.from && t < o.to) return o;
    return null;
  }

  // ------------------------------------------------------------------ stepping
  step(t: number, dt: number): void {
    const net = this.net;
    if (!net) return;
    // Occupancy first, so dispatch sees where every train is right now.
    this.buildOccupancy();
    this.runDispatch(t);
    const byId = this.trainIndex();
    for (const tr of this.trains) {
      switch (tr.state) {
        case TState.Dwelling:
          // (Timepoint holding only on routes that hold; setNetwork ends holds on routes that stop.)
          if (t >= tr.until && !(net.routes[tr.route].hold && this.holdAtTimepoint(tr, t))) this.leaveStop(tr, t);
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
          const hw = this.headwayAt(ri, r, ds.next[d]);
          if (hw > 0) {
            ds.pending[d].push(ds.next[d]);
            ds.last[d] = ds.next[d];
          }
          ds.next[d] = hw > 0 ? ds.next[d] + hw : this.nextServiceTime(ri, r, ds.next[d] + 1);
        }
        // Event service starting: pull the next slot in (only while an override is active, so
        // ordinary period changes behave exactly as before).
        if (this.ovByRoute[ri] && this.activeOverride(ri, t)) {
          const h = this.headwayAt(ri, r, t);
          const pulled = Math.max(t, ds.last[d] + h);
          if (ds.next[d] > pulled) ds.next[d] = pulled;
        }
        // Too many missed slots: a late train still goes, but don't stack a backlog forever.
        while (ds.pending[d].length > 2) ds.pending[d].shift();
        if (!ds.pending[d].length || !ds.ready[d].length) continue;
        const dir = r.dirs[d];
        const headS = Math.min(dir.length, dir.stopS[0] + r.trainLength / 2);
        // Clear platform, and nothing close enough behind that it couldn't stop for us.
        const behind = OPERATIONS.safetyMargin + (r.vmax * r.vmax) / (2 * r.brake);
        if (!this.regionFree(dir, headS - r.trainLength - behind, headS + 30)) continue;
        // Operations control: terminal holding (only on routes that hold).
        if ((r.hold || !isNaN(ds.holdSince[d])) && this.holdAtTerminal(ri, r, ds, d, t)) continue;
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
        tr.out = 0;
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
    for (let k = 0; k < dir.elems.length; k++) {
      const el = dir.elems[k];
      if ((el.s1 < s0 && k > 0) || el.s0 > s1) continue;
      // The first element also covers track behind the path start (other routes run through).
      const u0 = k === 0 && s0 < el.s0 ? Math.max(0, el.u0 - (el.s0 - s0)) : el.u0 + (Math.max(s0, el.s0) - el.s0);
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

    // City chaos: closed stations are run through (never the first or last stop).
    const cu = this.closedUntil;
    if (cu.length) {
      const last = dir.stopS.length - 1;
      while (tr.stop > 0 && tr.stop < last && cu[dir.stopStation[tr.stop]] > t) {
        this.hooks.pass(tr, r, tr.stop, t);
        tr.stop++;
      }
    }

    // Curve limits apply until the tail clears the curve.
    while (tr.lim < dir.limS0.length && dir.limS1[tr.lim] < s - L) tr.lim++;
    for (let j = tr.lim; j < dir.limS0.length && dir.limS0[j] < s + look; j++) {
      const lv = dir.limV[j];
      if (dir.limS0[j] <= s && dir.limS1[j] >= s - L) vAllow = Math.min(vAllow, lv);
      else if (dir.limS0[j] > s) vAllow = Math.min(vAllow, Math.sqrt(lv * lv + 2 * b * (dir.limS0[j] - s)));
    }

    // City chaos: weather speed cap on outdoor track, applied like a curve limit.
    if (this.outdoorFactor < 1 && dir.outS0 && dir.outS1) {
      const o0 = dir.outS0, o1 = dir.outS1;
      const cap = r.vmax * this.outdoorFactor;
      while (tr.out < o0.length && o1[tr.out] < s - L) tr.out++;
      for (let j = tr.out; j < o0.length && o0[j] < s + look; j++) {
        if (o0[j] <= s && o1[j] >= s - L) vAllow = Math.min(vAllow, cap);
        else if (o0[j] > s) vAllow = Math.min(vAllow, Math.sqrt(cap * cap + 2 * b * (o0[j] - s)));
      }
    }

    // City chaos: temporary restrictions (signal problems) on the tracks under and ahead of the train.
    if (this.restr.length) {
      for (let k = Math.max(0, tr.elem - 1); k < dir.elems.length; k++) {
        const el = dir.elems[k];
        if (el.s0 > s + look) break;
        if (!this.restrOnTrack[el.track]) continue;
        for (const q of this.restr) {
          if (q.track !== el.track) continue;
          const a = el.s0 + Math.max(0, q.u0 - el.u0);
          const z = el.s0 + Math.min(el.s1 - el.s0, q.u1 - el.u0);
          if (z <= a) continue;
          if (s >= a && s - L <= z) vAllow = Math.min(vAllow, q.v);
          else if (a > s) vAllow = Math.min(vAllow, Math.sqrt(q.v * q.v + 2 * b * (a - s)));
        }
      }
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
        if (k === tr.elem && o.tail < myU - 0.01 && o.head >= myU - 0.01) {
          // Already overlapping (should never happen): stop rather than drive through it.
          obs = Math.min(obs, s);
          continue;
        }
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

    // City chaos: a broken-down train brakes hard (integrate clamps to emergency braking) and stays put.
    if (tr.holdUntil > t) vAllow = 0;

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
        // A train got between us and the junction: it goes first.
        const between = obs < l.s0;
        if (between || (tr.v < 0.1 && tr.s < l.s0 - 1 && t - tr.stoppedSince > OPERATIONS.lockStallRelease)) {
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
    } else if (t - Math.max(tr.stoppedSince, this.graceByRoute[tr.route]) > OPERATIONS.deadlockAfter) {
      // (Stall time during an incident on this route or one sharing its track doesn't count.)
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
      // Regularity: lateness reaching the terminal (the recovery advisor).
      if (stopIdx === dir.stopS.length - 1) {
        const g = this.regs[tr.route];
        g.termLateSum += Math.max(0, tr.late);
        g.termLateN++;
      }
    }
    if (this.pairOn) this.notePair(tr, stopIdx, t);
    const overComfort = tr.load * this.agentScale > r.capComfort;
    const { alight, board } = this.hooks.arrive(tr, r, stopIdx, t);
    let dwell = OPERATIONS.dwellBase + ((alight + board) * OPERATIONS.dwellPerPassenger) / r.cars;
    dwell = Math.min(OPERATIONS.dwellMax, dwell * this.dwellFactor);
    if (overComfort || tr.load * this.agentScale > r.capComfort) dwell *= OPERATIONS.dwellCrowdedFactor;
    if (stopIdx === 0) dwell = Math.max(dwell, OPERATIONS.dwellBase);
    tr.until = t + dwell;
    // City chaos: a sick passenger holds the train at the next open, non-terminal stop.
    if (tr.holdNext > 0) {
      if (stopIdx > 0 && stopIdx < dir.stopS.length - 1) {
        tr.until += tr.holdNext;
        this.onHold?.(tr, dir.stopStation[stopIdx], t);
      } else if (stopIdx > 0) tr.incident = 0; // reached the terminal first: the hold is dropped
      if (stopIdx > 0) tr.holdNext = 0;
    }
  }

  private leaveStop(tr: Train, t: number): void {
    const r = this.net!.routes[tr.route];
    const dir = r.dirs[tr.dir];
    if (tr.stop >= dir.stopS.length - 1) {
      // Terminal: clear the platform, turn around off the running track. Operations control: when
      // the next departure the other way is already due and no train is waiting for it, the crew
      // turns the train in OPS_CONTROL.turnaroundMin.
      this.releaseLocks(tr);
      tr.state = TState.Turnaround;
      let turn = OPERATIONS.turnaround;
      if (r.shortTurn) {
        const od = tr.dir === 0 ? 1 : 0;
        const ds = this.dispatch[tr.route];
        if (ds.ready[od].length === 0 && (ds.pending[od].length > 0 || ds.next[od] < t + OPERATIONS.turnaround)) {
          turn = OPS_CONTROL.turnaroundMin;
          this.day.shortTurns++;
          this.regs[tr.route].shortTurns++;
        }
      }
      tr.until = t + turn;
      tr.load = 0;
      return;
    }
    this.hooks.depart(tr, r, tr.stop, t);
    this.noteDeparture(tr, r, t);
    tr.stop++;
    tr.state = TState.Running;
    tr.stoppedSince = t;
  }

  private releaseLocks(tr: Train): void {
    for (const l of tr.locks) if (this.lockHolder[l.lock] === tr.id) this.lockHolder[l.lock] = -1;
    tr.locks = [];
  }

  // ------------------------------------------------------------------ four-track sections (v2)
  /**
   * The overtake counter's tables (docs/v2/express-quad.md §4.8): pair keys per station, and per
   * route direction and stop the travel sign along the pair's reference platform and the next pair
   * called at. Pair calls in progress are forgotten (an edit just after an overtake may miss it).
   */
  private buildPairs(net: CompiledNetwork): void {
    this.pairLog.clear();
    this.lastPair.clear();
    this.pairOn = net.stations.some((s) => s.pair !== undefined && s.pair >= 0);
    if (!this.pairOn) {
      this.pairKey = new Int32Array(0);
      this.stopSgn = [];
      this.nextPairAt = [];
      return;
    }
    const key = Int32Array.from(net.stations, (s, i) => (s.pair !== undefined && s.pair >= 0 ? Math.min(i, s.pair) : -1));
    this.pairKey = key;
    this.stopSgn = net.routes.map((r) =>
      r.dirs.map((dir) => {
        const n = dir.stopStation.length;
        const sg = new Int8Array(n).fill(-1);
        let e = 0;
        for (let k = 0; k < n; k++) {
          const si = dir.stopStation[k];
          if (key[si] < 0) continue;
          const s = dir.stopS[k];
          while (e + 1 < dir.elems.length && dir.elems[e].s1 < s) e++;
          const ed = dir.elems[e]?.edgeDir ?? 0;
          // Relative to the reference platform: flipped on the partner when the two run opposite ways.
          sg[k] = si !== key[si] && net.stations[si].pairSameDir === false ? 1 - ed : ed;
        }
        return sg;
      }) as [Int8Array, Int8Array],
    );
    this.nextPairAt = net.routes.map((r) =>
      r.dirs.map((dir) => {
        const n = dir.stopStation.length;
        const nx = new Int32Array(n).fill(-1);
        let next = -1;
        for (let k = n - 1; k >= 0; k--) {
          nx[k] = next;
          const kk = key[dir.stopStation[k]];
          if (kk >= 0) next = kk;
        }
        return nx;
      }) as [Int32Array, Int32Array],
    );
  }

  /**
   * An overtake is an inversion of order between two consecutive cross-platform stations both trains
   * call at: this train reaches pair `key` while another route's train, which left the previous pair
   * before it, has not got here yet (its next pair call is this one).
   */
  private notePair(tr: Train, k: number, t: number): void {
    const dir = this.net!.routes[tr.route].dirs[tr.dir];
    const key = this.pairKey[dir.stopStation[k]];
    if (key < 0) return;
    const sgn = this.stopSgn[tr.route][tr.dir][k];
    const prev = this.lastPair.get(tr.id);
    if (prev && prev.sgn === sgn && prev.key !== key) {
      const log = this.pairLog.get(prev.key * 2 + sgn);
      if (log) {
        for (const e of log) {
          if (e.t >= prev.t || e.train === tr.id) continue;
          const y = this.lastPair.get(e.train);
          if (!y || y.routeId === tr.routeId || y.key !== prev.key || y.t !== e.t || y.sgn !== sgn) continue;
          if (this.nextPairAt[y.route]?.[y.dir]?.[y.stop] !== key) continue;
          this.day.overtakes.set(tr.routeId, (this.day.overtakes.get(tr.routeId) ?? 0) + 1);
        }
      }
    }
    const lk = key * 2 + sgn;
    let log = this.pairLog.get(lk);
    if (!log) this.pairLog.set(lk, (log = []));
    log.push({ train: tr.id, t });
    while (log.length > PAIR_LOG_MAX || (log.length && t - log[0].t > PAIR_LOG_SPAN)) log.shift();
    this.lastPair.set(tr.id, { key, t, sgn, route: tr.route, routeId: tr.routeId, dir: tr.dir, stop: k });
  }

  // ------------------------------------------------------------------ operations control
  /**
   * Terminal holding: a departure whose gap behind the train ahead would be under hold × H waits off
   * the running track (so it blocks nobody), while the slots keep ticking. Returns true to hold now;
   * on release the hold is counted.
   */
  private holdAtTerminal(ri: number, r: CRoute, ds: DispatchState, d: 0 | 1, t: number): boolean {
    if (r.hold) {
      const g = this.regs[ri];
      const last = g.lastDep[d][0];
      // Judged against the gap the timetable gives behind the train ahead (see gapHeadway), from
      // its slot and the slot this departure takes.
      const H = isFinite(last) ? this.gapHeadway(ri, r, g.lastSched[d][0], ds.pending[d][0]) : 0;
      if (H > 0 && t + OPERATIONS.dwellBase - last < r.hold * H) {
        if (isNaN(ds.holdSince[d])) ds.holdSince[d] = t;
        return true;
      }
    }
    if (!isNaN(ds.holdSince[d])) {
      const g = this.regs[ri];
      g.holds++;
      g.holdSec += t - ds.holdSince[d];
      ds.holdSince[d] = NaN;
    }
    return false;
  }

  /**
   * Regularity: the headway behind the previous departure from this stop, judged against the
   * headway this train was dispatched under (its slot, schedStart), not the one in force when it
   * gets here: a train sent at 09:58 under the 4-minute peak reaches stop 10 after 10:00. It counts
   * when the previous train was dispatched in the same period of the same day, at the same headway
   * in force (event service).
   */
  private noteDeparture(tr: Train, r: CRoute, t: number): void {
    const g = this.regs[tr.route];
    const d = tr.dir, k = tr.stop;
    const prev = g.lastSched[d][k];
    const s = tr.schedStart;
    g.lastSched[d][k] = s;
    const day0 = Math.floor(s / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const pi = periodOfTod(s - day0);
    const ov = this.ovByRoute[tr.route] !== undefined;
    const H = ov ? this.headwayAt(tr.route, r, s) : r.headways[pi];
    recordHeadway(g, d, k, t, H, prev >= day0 + PERIOD_START[pi] && prev <= s && (!ov || this.headwayAt(tr.route, r, prev) === H));
  }

  /**
   * The headway to hold against behind the train ahead: the shorter of the headways in force at
   * its dispatch slot and at this train's. The timetable's gap between two consecutive slots is
   * never shorter (it is the first one's headway, or the second's where event service pulls a slot
   * in), so an on-time train is never held across a period change or the start or end of event
   * service, while a late one is still spaced out.
   */
  private gapHeadway(ri: number, r: CRoute, aheadSlot: number, slot: number): number {
    const ha = this.headwayAt(ri, r, aheadSlot);
    const hb = this.headwayAt(ri, r, slot);
    return ha > 0 ? (hb > 0 ? Math.min(ha, hb) : ha) : hb;
  }

  /**
   * Timepoint holding: a train due to leave a timepoint while its gap behind the train ahead is
   * under hold × H waits (re-checked every step) until the gap is right, at most
   * OPS_CONTROL.maxHoldPerStop, and leaves at once if another route's train queues behind it.
   * Returns true while the train is held. People arriving meanwhile still board (leaveStop's depart).
   */
  private holdAtTimepoint(tr: Train, t: number): boolean {
    const r = this.net!.routes[tr.route];
    const dir = r.dirs[tr.dir];
    let hd = this.holds.size ? this.holds.get(tr.id) : undefined;
    const held = hd !== undefined;
    // Not a timepoint (or holding is off), a closed station (city chaos: nobody can board), no
    // service or no train ahead yet: no hold (and one in progress ends).
    let ok = !!r.hold && !!dir.timepoint && dir.timepoint[tr.stop] === 1;
    if (ok && this.closedUntil.length && this.closedUntil[dir.stopStation[tr.stop]] > t) ok = false;
    const g = this.regs[tr.route];
    const last = ok ? g.lastDep[tr.dir][tr.stop] : -Infinity;
    // The headway the two trains were dispatched under (not the one in force here and now).
    const H = ok && isFinite(last) ? this.gapHeadway(tr.route, r, g.lastSched[tr.dir][tr.stop], tr.schedStart) : 0;
    if (!ok || !(H > 0) || !isFinite(last)) {
      if (held) this.endHold(tr, t);
      return false;
    }
    const target = last + r.hold! * H;
    if (!hd) {
      if (t >= target) return false;
      hd = { cap: t + OPS_CONTROL.maxHoldPerStop, start: t };
      this.holds.set(tr.id, hd);
      // Don't sit on a junction claimed during the approach while waiting.
      this.releaseLocksAhead(tr);
    }
    const end = Math.min(target, hd.cap);
    if (t >= end || this.otherRouteQueuedBehind(tr, r)) {
      this.endHold(tr, t);
      return false;
    }
    tr.until = Math.min(end, t + TIME.simStep);
    return true;
  }

  private endHold(tr: Train, t: number): void {
    const hd = this.holds.get(tr.id);
    if (!hd) return;
    const g = this.regs[tr.route];
    g.holds++;
    g.holdSec += t - hd.start;
    this.holds.delete(tr.id);
  }

  /** Give up junction claims the head hasn't reached (claims the train is physically on stay). */
  private releaseLocksAhead(tr: Train): void {
    if (!tr.locks.length) return;
    tr.locks = tr.locks.filter((l) => {
      if (l.s0 <= tr.s) return true;
      if (this.lockHolder[l.lock] === tr.id) this.lockHolder[l.lock] = -1;
      return false;
    });
  }

  /** Is another route's train queued within OPS_CONTROL.yieldLookback behind this train's tail (on its path's tracks)? */
  private otherRouteQueuedBehind(tr: Train, r: CRoute): boolean {
    const dir = r.dirs[tr.dir];
    if (!dir.elems.length) return false;
    const tail = tr.s - r.trainLength;
    let k = Math.min(tr.elem, dir.elems.length - 1);
    while (k > 0 && dir.elems[k].s0 > tail) k--;
    let el = dir.elems[k];
    let uTail = el.u0 + (Math.max(tail, el.s0) - el.s0);
    let look = OPS_CONTROL.yieldLookback;
    const routeOf = (i: number) => this.trains[i]?.route ?? tr.route;
    for (;;) {
      if (queuedBehind(this.occ, el.track, uTail, look, tr.route, routeOf)) return true;
      const back = uTail - el.u0;
      if (back >= look || k === 0) return false;
      look -= back;
      el = dir.elems[--k];
      uTail = el.u0 + (el.s1 - el.s0);
    }
  }

  /** Midnight: the day's regularity per route and for the network; the accumulators roll over. */
  closeDayRegularity(): { routes: Record<number, RegularityStats>; network: RegularityStats } {
    const network = poolStats(this.regs);
    const routes: Record<number, RegularityStats> = {};
    for (const g of this.regs) {
      const y = rollDay(g);
      routes[g.routeId] = y.stats;
      this.yesterdayById.set(g.routeId, y);
    }
    return { routes, network };
  }

  /** The route panel's regularity (the 'route' query), or null for a route not running. */
  regularityDetail(routeId: number): RouteRegularityDetail | null {
    const net = this.net;
    const ri = net ? net.routes.findIndex((r) => r.id === routeId) : -1;
    if (!net || ri < 0) return null;
    const r = net.routes[ri];
    const g = this.regs[ri];
    const y = this.yesterdayById.get(routeId) ?? null;
    const today = summarize(g);
    const timepoints: number[] = [];
    r.dirs[0].timepoint?.forEach((v, k) => {
      if (v) timepoints.push(k);
    });
    return {
      today,
      yesterday: y?.stats ?? null,
      cvByStop: y ? y.byStop : cvByStop(g),
      timepoints,
      suggestRecovery: suggestRecovery((y?.stats ?? today).termLate, g.termRun),
      hold: r.hold ?? 0,
      shortTurns: g.shortTurns,
    };
  }

  /** The network's regularity so far today (all routes pooled). */
  regularityToday(): RegularityStats {
    return poolStats(this.regs);
  }

  /** Is this train held at a timepoint (snapshot state SNAP_HELD)? */
  isHeld(tr: Train): boolean {
    return this.holds.size > 0 && this.holds.has(tr.id);
  }

  /** Trains held at a timepoint right now. */
  heldCount(): number {
    return this.holds.size;
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
  return { carKm: 0, lateSum: 0, lateCount: 0, deadlocks: 0, routeLate: new Map(), shortTurns: 0, overtakes: new Map() };
}

/**
 * The yield rule (pure): is any train of another route on `track` with its head within `lookback`
 * metres behind `uTail` (track coordinates)? Trains ahead of the tail and trains of the same route
 * don't count.
 */
export function queuedBehind(occ: readonly (readonly OccEntry[])[], track: number, uTail: number, lookback: number, route: number, routeOfOcc: (train: number) => number): boolean {
  const list = occ[track];
  if (!list) return false;
  for (const o of list) if (o.head >= uTail - lookback && o.head <= uTail && routeOfOcc(o.train) !== route) return true;
  return false;
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

const SECONDS_PER_DAY = 86400;
/** Start of each period (night, am, midday, pm, evening), seconds of the day. */
const PERIOD_START = [0, 6 * 3600, 10 * 3600, 16 * 3600, 20 * 3600];

/** Period index for a time of day in [0, 86400) (as periodIndex; cheap, for per-departure statistics). */
function periodOfTod(tod: number): number {
  return tod < PERIOD_START[1] ? 0 : tod < PERIOD_START[2] ? 1 : tod < PERIOD_START[3] ? 2 : tod < PERIOD_START[4] ? 3 : 4;
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

/** Connected groups of routes that share a directed track or a junction lock (union–find over compiled route indices). */
function routeGroups(net: CompiledNetwork): Int32Array {
  const parent = Int32Array.from(net.routes, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const byTrack = new Map<number, number>();
  const byLock = new Map<number, number>();
  const join = (m: Map<number, number>, key: number, ri: number) => {
    const o = m.get(key);
    if (o === undefined) m.set(key, ri);
    else parent[find(o)] = find(ri);
  };
  net.routes.forEach((r, ri) => {
    for (const dir of r.dirs) {
      for (const el of dir.elems) {
        join(byTrack, el.track, ri);
        if (el.lock >= 0) join(byLock, el.lock, ri);
      }
    }
  });
  return Int32Array.from(net.routes, (_, i) => find(i));
}
