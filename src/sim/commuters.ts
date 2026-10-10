/**
 * Commuters: agents generated from the real OD table, daily logit mode choice, transit
 * pathfinding, and an event-driven simulation of every transit trip (walk → platform queue →
 * train with capacity → transfers → walk) whose observed times feed the next day's choice.
 */
import { COMMUTERS, GOALS, OPERATIONS, TIME } from '../balance';
import { SECONDS_PER_DAY, dayIndex } from '../core/calendar';
import { toLocal } from '../core/geo';
import { pointInDisc, Rng } from '../core/rng';
import type { World } from '../data/world';
import { TractIndex } from '../data/world';
import {
  driveTripTime,
  generalisedCosts,
  logitShares,
  MODE_DRIVE,
  MODE_TRANSIT,
  MODE_WALK,
  walkTime,
  type PairGeometry,
} from './modeChoice';
import type { CompiledNetwork, CRoute, DayReport, LiveStats, ModeState } from './protocol';
import { TransitGraph } from './transitGraph';
import type { PassengerHooks, Train } from './trainSim';

const MAX_LEGS = 5;
// Agent trip state
const S_HOME = 0;
const S_WALK = 1; // walking to a platform (event pending)
const S_WAIT = 2;
const S_RIDE = 3;
const S_EGRESS = 4;
const S_WORK = 5;
const S_DONE = 6;
// Event types
const E_DEPART = 1;
const E_PLATFORM = 2;
const E_ARRIVE = 3;
const E_GIVEUP = 4;
const E_RETURN = 5;

export interface EngineCb {
  busy?(label: string | null): void;
  event?(title: string, body?: string, tone?: 'green' | 'amber' | 'red'): void;
}

interface GroupPath {
  /** [routeId, boardStationId, alightStationId] × legs */
  legs: Int32Array;
  time: number;
  transfers: number;
}

export class Commuters implements PassengerHooks {
  readonly scale: number;
  readonly A: number;
  readonly G: number;
  private world: World;
  private tractIndex: TractIndex;
  // Groups (home tract, work tract, band)
  gHome: Int32Array;
  gWork: Int32Array;
  gBand: Uint8Array;
  gStart: Int32Array;
  gCount: Int32Array;
  gWalk: Float32Array;
  gDrive: Float32Array;
  gDriveHome: Float32Array;
  gGeom: PairGeometry[];
  shares: Float32Array; // G × 3
  obsTime: Float32Array; // yesterday's average observed transit door-to-door (s), 0 = none
  obsCrowd: Float32Array; // minutes
  private todayTimeSum: Float32Array;
  private todayTimeN: Uint16Array;
  private todayCrowdSum: Float32Array;
  pathAM: (GroupPath | null)[] = [];
  pathPM: (GroupPath | null)[] = [];
  // Agents
  aGroup: Int32Array;
  aHx: Float32Array;
  aHy: Float32Array;
  aWx: Float32Array;
  aWy: Float32Array;
  aDepart: Float32Array;
  aReturn: Float32Array;
  aMode: Uint8Array;
  aState: Uint8Array;
  aLeg: Uint8Array;
  aLegN: Uint8Array;
  aLegs: Int32Array; // A × MAX_LEGS × 3
  aTripStart: Float64Array;
  aWaitStart: Float64Array;
  aPlat: Int32Array;
  aCrowd: Float32Array;
  aLeft: Uint8Array;
  aPM: Uint8Array;
  // Event heap
  private hT = new Float64Array(1024);
  private hV = new Int32Array(1024);
  private hN = 0;
  // Network
  private net: CompiledNetwork | null = null;
  private graph: TransitGraph | null = null;
  private stopIndex: Map<number, number>[][] = []; // [route][dir] stationId → stop index
  private routeById = new Map<number, number>();
  private stationById = new Map<number, number>();
  private queues: number[][] = [];
  private qHead: Int32Array = new Int32Array(0);
  private qLive: Int32Array = new Int32Array(0);
  private fare: number;
  private rng: Rng;
  private cb: EngineCb;
  readonly key: string;
  baseline = 0;
  private trains: () => Train[] = () => [];
  // Daily stats
  private day = newDayStats(0);
  private stationHourly = new Float32Array(0);
  private peakLoad = new Float32Array(0);
  private peakTrains = new Int32Array(0);
  /** Yesterday's copies for panels. */
  last: {
    report: DayReport | null;
    stationHourly: Float32Array;
    stationLeft: Float32Array;
    peakLoad: Float32Array;
    peakTrains: Int32Array;
    netVersion: number;
  } = { report: null, stationHourly: new Float32Array(0), stationLeft: new Float32Array(0), peakLoad: new Float32Array(0), peakTrains: new Int32Array(0), netVersion: -1 };
  private stationLeft = new Float32Array(0);
  unserved = new Float32Array(0);
  midtownJfk: number | null = null;
  private midtownTract: number;
  private jfkTract: number;

  constructor(world: World, opts: { agentScale: number; seed: number; fare: number; modeState?: ModeState }, cb: EngineCb = {}) {
    this.world = world;
    this.scale = opts.agentScale;
    this.fare = opts.fare;
    this.cb = cb;
    this.rng = new Rng(opts.seed);
    this.tractIndex = new TractIndex(world.tracts);
    const od = world.od;
    const tr = world.tracts;
    // ---- groups (stochastic rounding of counts to agents, seeded)
    const gen = new Rng(opts.seed * 7919 + 13);
    const gh: number[] = [], gw: number[] = [], gb: number[] = [], gc: number[] = [];
    for (let i = 0; i < od.pairCount; i++) {
      for (let b = 0; b < 3; b++) {
        const c = od.counts[b][i];
        if (!c) continue;
        const exact = c / this.scale;
        let n = Math.floor(exact);
        if (gen.next() < exact - n) n++;
        if (n === 0) continue;
        gh.push(od.home[i]);
        gw.push(od.work[i]);
        gb.push(b);
        gc.push(n);
      }
    }
    const G = gh.length;
    this.G = G;
    this.gHome = Int32Array.from(gh);
    this.gWork = Int32Array.from(gw);
    this.gBand = Uint8Array.from(gb);
    this.gCount = Int32Array.from(gc);
    this.gStart = new Int32Array(G + 1);
    for (let g = 0; g < G; g++) this.gStart[g + 1] = this.gStart[g] + gc[g];
    const A = this.gStart[G];
    this.A = A;
    this.key = `${world.meta.source}|${world.tracts.length}|${od.pairCount}|${this.scale}|${opts.seed}|${A}|${G}`;
    // ---- pair geometry and walk/drive times
    this.gWalk = new Float32Array(G);
    this.gDrive = new Float32Array(G);
    this.gDriveHome = new Float32Array(G);
    this.gGeom = new Array(G);
    for (let g = 0; g < G; g++) {
      const h = tr[this.gHome[g]], w = tr[this.gWork[g]];
      const d = h.index === w.index ? Math.max(200, h.radius * 0.6) : Math.hypot(h.x - w.x, h.y - w.y);
      const geom: PairGeometry = {
        distance: d,
        homeManhattan: h.borough === 'Manhattan',
        workManhattan: w.borough === 'Manhattan',
        workCbd: w.borough === 'Manhattan' && w.lat < COMMUTERS.cbdLat,
        homeCbd: h.borough === 'Manhattan' && h.lat < COMMUTERS.cbdLat,
      };
      this.gGeom[g] = geom;
      this.gWalk[g] = walkTime(d);
      this.gDrive[g] = driveTripTime(geom);
      this.gDriveHome[g] = driveTripTime({ ...geom, workCbd: geom.homeCbd });
    }
    // ---- agents
    this.aGroup = new Int32Array(A);
    this.aHx = new Float32Array(A);
    this.aHy = new Float32Array(A);
    this.aWx = new Float32Array(A);
    this.aWy = new Float32Array(A);
    this.aDepart = new Float32Array(A);
    this.aReturn = new Float32Array(A);
    this.aMode = new Uint8Array(A);
    this.aState = new Uint8Array(A);
    this.aLeg = new Uint8Array(A);
    this.aLegN = new Uint8Array(A);
    this.aLegs = new Int32Array(A * MAX_LEGS * 3);
    this.aTripStart = new Float64Array(A);
    this.aWaitStart = new Float64Array(A);
    this.aPlat = new Int32Array(A).fill(-1);
    this.aCrowd = new Float32Array(A);
    this.aLeft = new Uint8Array(A);
    this.aPM = new Uint8Array(A);
    for (let g = 0; g < G; g++) {
      const h = tr[this.gHome[g]], w = tr[this.gWork[g]];
      for (let a = this.gStart[g]; a < this.gStart[g + 1]; a++) {
        this.aGroup[a] = g;
        const [hx, hy] = pointInDisc(gen, h.x, h.y, h.radius);
        const [wx, wy] = pointInDisc(gen, w.x, w.y, w.radius);
        this.aHx[a] = hx;
        this.aHy[a] = hy;
        this.aWx[a] = wx;
        this.aWy[a] = wy;
        const dep = COMMUTERS.departMean + gen.normal() * COMMUTERS.departSd;
        this.aDepart[a] = Math.max(COMMUTERS.departMin, Math.min(COMMUTERS.departMax, dep));
        this.aReturn[a] = COMMUTERS.workDuration + (gen.next() * 2 - 1) * COMMUTERS.returnJitter;
      }
    }
    // ---- mode shares: restore or start from the no-subway equilibrium
    this.shares = new Float32Array(G * 3);
    this.obsTime = new Float32Array(G);
    this.obsCrowd = new Float32Array(G);
    this.todayTimeSum = new Float32Array(G);
    this.todayTimeN = new Uint16Array(G);
    this.todayCrowdSum = new Float32Array(G);
    let base = 0;
    let n = 0;
    for (let g = 0; g < G; g++) {
      const c = generalisedCosts(this.gGeom[g], this.gBand[g], null);
      const p = logitShares(c);
      this.shares[g * 3] = p[0];
      this.shares[g * 3 + 1] = p[1];
      this.shares[g * 3 + 2] = p[2];
      const t = (p[0] * (isFinite(this.gWalk[g]) ? this.gWalk[g] : 0) + p[1] * this.gDrive[g]) / 60;
      base += t * this.gCount[g];
      n += this.gCount[g];
    }
    this.baseline = n ? base / n : 0;
    if (opts.modeState && opts.modeState.key === this.key && opts.modeState.shares.length === G * 3) {
      this.shares.set(opts.modeState.shares);
      this.obsTime.set(opts.modeState.obsTime);
      this.obsCrowd.set(opts.modeState.obsCrowd);
    }
    this.midtownTract = this.tractIndex.nearest(...toLocal(...GOALS.midtown))!.index;
    this.jfkTract = this.tractIndex.nearest(...toLocal(...GOALS.jfk))!.index;
    this.unserved = new Float32Array(tr.length);
  }

  setFare(f: number): void {
    this.fare = f;
  }

  setTrains(getter: () => Train[]): void {
    this.trains = getter;
  }

  modeState(): ModeState {
    return { key: this.key, shares: this.shares.slice(), obsTime: this.obsTime.slice(), obsCrowd: this.obsCrowd.slice() };
  }

  // ------------------------------------------------------------------ network & pathfinding
  setNetwork(net: CompiledNetwork, t: number): void {
    const old = this.net;
    const oldQueues = this.queues;
    const oldGraph = this.graph;
    this.net = net;
    this.routeById = new Map(net.routes.map((r, i) => [r.id, i]));
    this.stationById = new Map(net.stations.map((s, i) => [s.id, i]));
    this.stopIndex = net.routes.map((r) => r.dirs.map((d) => new Map(Array.from(d.stopStation, (si, k) => [net.stations[si].id, k]))));
    this.graph = net.routes.length ? new TransitGraph(net) : null;
    const P = this.graph?.P ?? 0;
    this.queues = Array.from({ length: P }, () => []);
    this.qHead = new Int32Array(P);
    this.qLive = new Int32Array(P);
    if (this.stationHourly.length !== net.stations.length * 24) {
      this.stationHourly = new Float32Array(net.stations.length * 24);
      this.stationLeft = new Float32Array(net.stations.length);
    }
    this.peakLoad = new Float32Array(P);
    this.peakTrains = new Int32Array(P);
    // Re-queue people waiting on platforms; in-flight trips on vanished routes finish by cab.
    if (old && oldGraph) {
      for (let p = 0; p < oldQueues.length; p++) {
        const q = oldQueues[p];
        for (let i = 0; i < q.length; i++) {
          const a = q[i];
          if (this.aState[a] !== S_WAIT || this.aPlat[a] !== p) continue;
          this.aPlat[a] = -1;
          const np = this.platformFor(a);
          if (np < 0) this.finishByCab(a, t);
          else this.enqueue(a, np);
        }
      }
    }
    this.recomputePaths();
    this.last.netVersion = net.version;
  }

  /** Platform for an agent's current leg in the current network (−1 if it no longer exists). */
  private platformFor(a: number): number {
    const leg = this.aLeg[a];
    const o = (a * MAX_LEGS + leg) * 3;
    const ri = this.routeById.get(this.aLegs[o]);
    if (ri === undefined || !this.graph) return -1;
    const board = this.aLegs[o + 1], alight = this.aLegs[o + 2];
    for (const d of [0, 1]) {
      const kb = this.stopIndex[ri][d].get(board);
      const ka = this.stopIndex[ri][d].get(alight);
      if (kb !== undefined && ka !== undefined && kb < ka) return this.graph.base[ri][d] + kb;
    }
    return -1;
  }

  /** For each origin tract, one Dijkstra to every destination (AM home→work, PM work→home). */
  recomputePaths(): void {
    const G = this.G;
    this.pathAM = new Array(G).fill(null);
    this.pathPM = new Array(G).fill(null);
    this.unserved.fill(0);
    this.midtownJfk = null;
    const graph = this.graph;
    const net = this.net;
    if (graph && net) {
      this.cb.busy?.('Updating routes');
      const t0 = Date.now();
      const tracts = this.world.tracts;
      // Stations within walking distance of each tract.
      const access: { station: number; walk: number }[][] = tracts.map((tr) => {
        const reach = 800 + COMMUTERS.accessRadiusTractShare * tr.radius;
        const out: { station: number; walk: number }[] = [];
        net.stations.forEach((s, i) => {
          const d = Math.hypot(s.x - tr.x, s.y - tr.y);
          if (d <= reach) out.push({ station: i, walk: (d * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed });
        });
        return out;
      });
      const byHome = new Map<number, number[]>();
      const byWork = new Map<number, number[]>();
      for (let g = 0; g < G; g++) {
        const h = this.gHome[g], w = this.gWork[g];
        if (!access[h].length || !access[w].length) continue;
        (byHome.get(h) ?? byHome.set(h, []).get(h)!).push(g);
        (byWork.get(w) ?? byWork.set(w, []).get(w)!).push(g);
      }
      const solve = (origin: number, groups: number[], destOf: (g: number) => number, out: (GroupPath | null)[]) => {
        graph.run(access[origin]);
        const cache = new Map<number, GroupPath | null>();
        for (const g of groups) {
          const dest = destOf(g);
          let gp = cache.get(dest);
          if (gp === undefined) {
            gp = this.bestPath(graph, access[dest]);
            cache.set(dest, gp);
          }
          out[g] = gp;
        }
        return cache;
      };
      graph.setPeriod(1); // AM peak
      for (const [h, groups] of byHome) {
        const cache = solve(h, groups, (g) => this.gWork[g], this.pathAM);
        if (h === this.midtownTract) {
          const p = cache.get(this.jfkTract) ?? this.bestPath(graph, access[this.jfkTract]);
          this.midtownJfk = p ? p.time / 60 : null;
        }
      }
      if (this.midtownJfk === null && access[this.midtownTract].length && access[this.jfkTract].length) {
        graph.run(access[this.midtownTract]);
        const p = this.bestPath(graph, access[this.jfkTract]);
        this.midtownJfk = p ? p.time / 60 : null;
      }
      graph.setPeriod(3); // PM peak
      for (const [w, groups] of byWork) solve(w, groups, (g) => this.gHome[g], this.pathPM);
      graph.setPeriod(1);
      const ms = Date.now() - t0;
      this.lastPathMs = ms;
      this.cb.busy?.(null);
    }
    // Unserved demand: commuters by home tract with no reasonable transit option.
    for (let g = 0; g < G; g++) {
      const p = this.pathAM[g];
      const bad = !p || !this.pathPM[g] || p.time > COMMUTERS.unservedRatio * this.gDrive[g];
      if (bad) this.unserved[this.gHome[g]] += this.gCount[g] * this.scale;
    }
  }
  lastPathMs = 0;

  private bestPath(graph: TransitGraph, egress: { station: number; walk: number }[]): GroupPath | null {
    let best = Infinity;
    let plat = -1;
    let walkOut = 0;
    for (const e of egress) {
      const a = graph.bestArrival(e.station);
      if (a.plat < 0) continue;
      const c = a.cost + e.walk;
      if (c < best) {
        best = c;
        plat = a.plat;
        walkOut = e.walk;
      }
    }
    if (plat < 0 || !isFinite(best)) return null;
    const legs = graph.legsTo(plat);
    if (!legs.length || legs.length > MAX_LEGS) return null;
    const net = this.net!;
    const arr = new Int32Array(legs.length * 3);
    legs.forEach((l, i) => {
      const r = net.routes[l.route];
      const dir = r.dirs[l.dir];
      arr[i * 3] = r.id;
      arr[i * 3 + 1] = net.stations[dir.stopStation[l.board]].id;
      arr[i * 3 + 2] = net.stations[dir.stopStation[l.alight]].id;
    });
    void walkOut;
    const transfers = legs.length - 1;
    return { legs: arr, time: best - transfers * COMMUTERS.transferPenalty, transfers };
  }

  // ------------------------------------------------------------------ daily cycle
  startDay(t: number): void {
    // A new game starts mid-morning-ish (5am): schedule today's trips without re-choosing modes.
    this.drawModesAndSchedule(dayIndex(t) * SECONDS_PER_DAY, t);
  }

  /** 3 am: update mode shares from yesterday's experience, then everyone plans their day. */
  dailyModeChoice(t: number): void {
    // Finish yesterday's observations.
    for (let g = 0; g < this.G; g++) {
      const n = this.todayTimeN[g];
      if (n > 0) {
        this.obsTime[g] = this.todayTimeSum[g] / n;
        this.obsCrowd[g] = this.todayCrowdSum[g] / n;
      }
    }
    this.todayTimeSum.fill(0);
    this.todayTimeN.fill(0);
    this.todayCrowdSum.fill(0);
    // New shares.
    for (let g = 0; g < this.G; g++) {
      const am = this.pathAM[g], pm = this.pathPM[g];
      let transit = null;
      if (am && pm) {
        const sched = (am.time + pm.time) / 2;
        // Observed times include waits and crowding delays; blend toward schedule if stale.
        const time = this.obsTime[g] > 0 ? this.obsTime[g] : sched;
        transit = { time, transfers: (am.transfers + pm.transfers) / 2, crowdMinutes: this.obsCrowd[g], fare: this.fare };
      }
      const c = generalisedCosts(this.gGeom[g], this.gBand[g], transit);
      const target = logitShares(c);
      const o = g * 3;
      for (let m = 0; m < 3; m++) this.shares[o + m] += COMMUTERS.dailySmoothing * (target[m] - this.shares[o + m]);
      if (!transit) {
        // No transit option today: its share collapses into the others immediately.
        const tr = this.shares[o + 2];
        if (tr > 0) {
          const rest = this.shares[o] + this.shares[o + 1] || 1;
          this.shares[o] += (tr * this.shares[o]) / rest;
          this.shares[o + 1] += (tr * this.shares[o + 1]) / rest;
          this.shares[o + 2] = 0;
        }
      }
    }
    this.drawModesAndSchedule(t - TIME.modeChoiceAt, t);
  }

  /** Everyone draws a mode from their pair's shares and their trips are scheduled. */
  private drawModesAndSchedule(dayStart: number, now: number): void {
    // Anyone still out from yesterday is sent home (counted as stuck).
    let stuck = 0;
    for (let a = 0; a < this.A; a++) {
      const s = this.aState[a];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) stuck++;
      this.aState[a] = S_HOME;
      this.aPlat[a] = -1;
    }
    this.day.stuck += stuck;
    for (const tr of this.trains()) {
      tr.buckets = tr.buckets.map(() => []);
      tr.load = 0;
    }
    for (let p = 0; p < this.queues.length; p++) {
      this.queues[p] = [];
      this.qHead[p] = 0;
      this.qLive[p] = 0;
    }
    this.hN = 0;
    const d = this.day;
    for (let g = 0; g < this.G; g++) {
      const o = g * 3;
      const hasTransit = this.pathAM[g] && this.pathPM[g];
      const pw = this.shares[o], pd = this.shares[o + 1];
      const pt = hasTransit ? this.shares[o + 2] : 0;
      const sum = pw + pd + pt || 1;
      for (let a = this.gStart[g]; a < this.gStart[g + 1]; a++) {
        const r = this.rng.next() * sum;
        const mode = r < pw ? MODE_WALK : r < pw + pd ? MODE_DRIVE : MODE_TRANSIT;
        this.aMode[a] = mode;
        const dep = dayStart + this.aDepart[a];
        if (mode === MODE_TRANSIT) {
          d.modeCount[MODE_TRANSIT]++;
          if (dep >= now) this.push(dep, a, E_DEPART);
          else {
            // Loaded mid-day: they already went to work; only the trip home remains.
            const back = dep + 1800 + this.aReturn[a];
            this.aPM[a] = 0;
            if (back >= now) {
              this.aState[a] = S_WORK;
              this.push(back, a, E_RETURN);
            } else this.aState[a] = S_DONE;
          }
        } else {
          // Walking and driving aren't simulated step by step — their times are known.
          const tAm = mode === MODE_WALK ? this.gWalk[g] : this.gDrive[g];
          const tPm = mode === MODE_WALK ? this.gWalk[g] : this.gDriveHome[g];
          d.tripTimeSum += tAm + tPm;
          d.trips += 2;
          d.modeCount[mode]++;
          this.aState[a] = S_DONE;
        }
      }
    }
  }

  // ------------------------------------------------------------------ events
  step(t: number): void {
    while (this.hN > 0 && this.hT[0] <= t) {
      const et = this.hT[0];
      const v = this.pop();
      const a = v >> 3;
      const type = v & 7;
      switch (type) {
        case E_DEPART:
          this.beginTrip(a, et, false);
          break;
        case E_RETURN:
          this.beginTrip(a, et, true);
          break;
        case E_PLATFORM:
          this.arrivePlatform(a, et);
          break;
        case E_ARRIVE:
          this.completeTrip(a, et);
          break;
        case E_GIVEUP:
          if (this.aState[a] === S_WAIT && et - this.aWaitStart[a] >= COMMUTERS.maxPlatformWait - 1) {
            this.leaveQueue(a);
            this.day.gaveUp++;
            this.finishByCab(a, et);
          }
          break;
      }
    }
  }

  private beginTrip(a: number, t: number, pm: boolean): void {
    const g = this.aGroup[a];
    const path = pm ? this.pathPM[g] : this.pathAM[g];
    this.aPM[a] = pm ? 1 : 0;
    this.aTripStart[a] = t;
    this.aCrowd[a] = 0;
    this.aLeft[a] = 0;
    if (!path) {
      // Lost their transit option (network changed): drive today.
      const dt = pm ? this.gDriveHome[g] : this.gDrive[g];
      this.recordTrip(a, t + dt, false);
      return;
    }
    const n = path.legs.length / 3;
    this.aLegN[a] = n;
    this.aLeg[a] = 0;
    this.aLegs.set(path.legs, a * MAX_LEGS * 3);
    const net = this.net!;
    const st = net.stations[this.stationById.get(path.legs[1]) ?? -1];
    if (!st) {
      this.finishByCab(a, t);
      return;
    }
    const x = pm ? this.aWx[a] : this.aHx[a];
    const y = pm ? this.aWy[a] : this.aHy[a];
    const walk = (Math.hypot(st.x - x, st.y - y) * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed;
    this.aState[a] = S_WALK;
    this.push(t + walk, a, E_PLATFORM);
  }

  private arrivePlatform(a: number, t: number): void {
    const p = this.platformFor(a);
    if (p < 0) {
      this.finishByCab(a, t);
      return;
    }
    this.aWaitStart[a] = t;
    this.enqueue(a, p);
    this.push(t + COMMUTERS.maxPlatformWait, a, E_GIVEUP);
  }

  private enqueue(a: number, p: number): void {
    this.aState[a] = S_WAIT;
    this.aPlat[a] = p;
    this.queues[p].push(a);
    this.qLive[p]++;
  }

  private leaveQueue(a: number): void {
    const p = this.aPlat[a];
    if (p >= 0) this.qLive[p]--;
    this.aPlat[a] = -1;
  }

  /** Train arrives: riders for this stop get off, then the queue boards up to crush capacity. */
  arrive(train: Train, route: CRoute, stopIdx: number, t: number): { alight: number; board: number } {
    if (!this.graph) return { alight: 0, board: 0 };
    const net = this.net!;
    const dir = route.dirs[train.dir];
    const stationIdx = dir.stopStation[stopIdx];
    const station = net.stations[stationIdx];
    // Alight
    const off = train.buckets[stopIdx] ?? [];
    train.buckets[stopIdx] = [];
    for (const a of off) {
      this.aLeg[a]++;
      if (this.aLeg[a] < this.aLegN[a]) {
        // Transfer: walk to the next platform.
        const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
        const nextSt = net.stations[this.stationById.get(this.aLegs[o + 1]) ?? -1];
        const walk = nextSt ? (Math.hypot(nextSt.x - station.x, nextSt.y - station.y) / 1.2 + 60) : 60;
        this.aState[a] = S_WALK;
        this.push(t + walk, a, E_PLATFORM);
      } else {
        const x = this.aPM[a] ? this.aHx[a] : this.aWx[a];
        const y = this.aPM[a] ? this.aHy[a] : this.aWy[a];
        const walk = (Math.hypot(station.x - x, station.y - y) * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed;
        this.aState[a] = S_EGRESS;
        this.push(t + walk, a, E_ARRIVE);
      }
    }
    train.load -= off.length;
    const board = this.board(train, route, stopIdx, t);
    return { alight: off.length * this.scale, board: board * this.scale };
  }

  depart(train: Train, route: CRoute, stopIdx: number, t: number): void {
    if (!this.graph) return;
    this.board(train, route, stopIdx, t);
    // Peak-hour load on the segment leaving this stop.
    const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
    if (hour === OPERATIONS.peakHour) {
      const p = this.graph.base[train.route][train.dir] + stopIdx;
      this.peakLoad[p] += train.load * this.scale;
      this.peakTrains[p]++;
    }
  }

  private board(train: Train, route: CRoute, stopIdx: number, t: number): number {
    const graph = this.graph!;
    const p = graph.base[train.route][train.dir] + stopIdx;
    const q = this.queues[p];
    let head = this.qHead[p];
    const capAgents = Math.floor(route.capCrush / this.scale);
    const stops = this.stopIndex[train.route][train.dir];
    const dir = route.dirs[train.dir];
    const stationIdx = dir.stopStation[stopIdx];
    let boarded = 0;
    while (head < q.length && train.load < capAgents) {
      const a = q[head++];
      if (this.aState[a] !== S_WAIT || this.aPlat[a] !== p) continue;
      const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
      const k = stops.get(this.aLegs[o + 2]);
      if (k === undefined || k <= stopIdx) {
        // Can't ride to the stop they want any more.
        this.leaveQueue(a);
        this.finishByCab(a, t);
        continue;
      }
      this.leaveQueue(a);
      this.aState[a] = S_RIDE;
      (train.buckets[k] ??= []).push(a);
      train.load++;
      boarded++;
      // Crowding experienced on this ride (load after boarding vs comfortable capacity).
      const ride = dir.schedArrive[k] - dir.schedArrive[stopIdx];
      this.aCrowd[a] += (ride / 60) * COMMUTERS.crowdingWeight * Math.max(0, (train.load * this.scale) / route.capComfort - 1);
      this.day.routeBoard.set(route.id, (this.day.routeBoard.get(route.id) ?? 0) + 1);
      const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
      this.stationHourly[stationIdx * 24 + hour] += this.scale;
    }
    // Compact the queue occasionally.
    if (head > 512 && head > q.length / 2) {
      this.queues[p] = q.slice(head);
      head = 0;
    }
    this.qHead[p] = head;
    // Everyone still waiting has been left behind by a full train.
    if (train.load >= capAgents) {
      const left = this.qLive[p];
      if (left > 0) {
        this.day.leftBehind += left;
        this.stationLeft[stationIdx] += left * this.scale;
        for (let i = head; i < this.queues[p].length; i++) this.aLeft[this.queues[p][i]] = 1;
      }
    }
    return boarded;
  }

  evacuate(train: Train, t: number): void {
    for (const b of train.buckets) for (const a of b) if (this.aState[a] === S_RIDE) this.finishByCab(a, t);
    train.buckets = train.buckets.map(() => []);
    train.load = 0;
  }

  private finishByCab(a: number, t: number): void {
    const g = this.aGroup[a];
    const rest = (this.aPM[a] ? this.gDriveHome[g] : this.gDrive[g]) * 0.6;
    this.recordTrip(a, t + rest, true);
  }

  private completeTrip(a: number, t: number): void {
    this.recordTrip(a, t, true);
  }

  private recordTrip(a: number, tEnd: number, transit: boolean): void {
    const g = this.aGroup[a];
    const dur = tEnd - this.aTripStart[a];
    const d = this.day;
    d.trips++;
    d.tripTimeSum += dur;
    if (transit) {
      d.transitTrips++;
      this.todayTimeSum[g] += dur;
      this.todayCrowdSum[g] += this.aCrowd[a];
      this.todayTimeN[g]++;
    }
    if (!this.aPM[a]) {
      this.aState[a] = S_WORK;
      this.push(tEnd + this.aReturn[a], a, E_RETURN);
    } else {
      this.aState[a] = S_DONE;
    }
  }

  // ------------------------------------------------------------------ reporting
  waitingByStation(n: number): Float64Array {
    const out = new Float64Array(n);
    const graph = this.graph;
    if (!graph) return out;
    for (let p = 0; p < graph.P; p++) {
      const s = graph.platStation[p];
      if (s < n) out[s] += this.qLive[p] * this.scale;
    }
    return out;
  }

  live(): LiveStats {
    let inSystem = 0;
    for (let p = 0; p < this.qLive.length; p++) inSystem += this.qLive[p];
    return { ridersToday: this.day.transitTrips * this.scale, tripsInProgress: this.hN, inSystem: inSystem * this.scale };
  }

  dayReport(day: number): DayReport {
    const d = this.day;
    const net = this.net;
    const totalAgents = this.A;
    const stationBoardings: Record<number, number> = {};
    if (net) {
      net.stations.forEach((s, i) => {
        let sum = 0;
        for (let h = 0; h < 24; h++) sum += this.stationHourly[i * 24 + h];
        stationBoardings[s.id] = sum;
      });
    }
    const routeRiders: Record<number, number> = {};
    for (const [rid, n] of d.routeBoard) routeRiders[rid] = n * this.scale;
    const transitCommuters = d.modeCount[MODE_TRANSIT];
    const report: DayReport = {
      day,
      riders: d.transitTrips * this.scale,
      commuters: totalAgents * this.scale,
      transitShare: transitCommuters / totalAgents,
      walkShare: d.modeCount[MODE_WALK] / totalAgents,
      driveShare: d.modeCount[MODE_DRIVE] / totalAgents,
      avgCommute: d.trips ? d.tripTimeSum / d.trips / 60 : this.baseline,
      baselineCommute: this.baseline,
      carKm: 0,
      stationsOpen: 0,
      avgLateness: 0,
      leftBehind: d.leftBehind * this.scale,
      gaveUp: d.gaveUp * this.scale,
      deadlocks: 0,
      routeRiders,
      routeLateness: {},
      stationBoardings,
      midtownJfk: this.midtownJfk,
      boroughsServed: [],
    };
    // Keep yesterday's detail for panels, then reset.
    this.last = {
      report,
      stationHourly: this.stationHourly.slice(),
      stationLeft: this.stationLeft.slice(),
      peakLoad: this.peakLoad.slice(),
      peakTrains: this.peakTrains.slice(),
      netVersion: net?.version ?? -1,
    };
    this.stationHourly.fill(0);
    this.stationLeft.fill(0);
    this.peakLoad.fill(0);
    this.peakTrains.fill(0);
    this.day = newDayStats(day + 1);
    return report;
  }

  /** Expected transit riders per group today (agents × transit share). */
  private transitAgents(g: number): number {
    return this.gCount[g] * this.shares[g * 3 + 2];
  }

  stationDetail(stationId: number) {
    const net = this.net;
    const si = this.stationById.get(stationId);
    const hourlyToday = new Array(24).fill(0);
    const hourlyYesterday = new Array(24).fill(0);
    let leftToday = 0, leftYesterday = 0;
    if (si !== undefined) {
      for (let h = 0; h < 24; h++) hourlyToday[h] = this.stationHourly[si * 24 + h];
      leftToday = this.stationLeft[si];
      if (this.last.stationHourly.length === this.stationHourly.length) {
        for (let h = 0; h < 24; h++) hourlyYesterday[h] = this.last.stationHourly[si * 24 + h];
        leftYesterday = this.last.stationLeft[si];
      }
    }
    // Where riders boarding here come from and are going to.
    const from = new Map<number, number>();
    const to = new Map<number, number>();
    if (net) {
      for (let g = 0; g < this.G; g++) {
        const n = this.transitAgents(g) * this.scale;
        if (n < 0.01) continue;
        const am = this.pathAM[g], pm = this.pathPM[g];
        if (am && am.legs[1] === stationId) {
          from.set(this.gHome[g], (from.get(this.gHome[g]) ?? 0) + n);
          to.set(this.gWork[g], (to.get(this.gWork[g]) ?? 0) + n);
        }
        if (pm && pm.legs[1] === stationId) {
          from.set(this.gWork[g], (from.get(this.gWork[g]) ?? 0) + n);
          to.set(this.gHome[g], (to.get(this.gHome[g]) ?? 0) + n);
        }
      }
    }
    const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tract, count]) => ({ tract, count }));
    return { hourlyToday, hourlyYesterday, leftToday, leftYesterday, waiting: si !== undefined ? this.waitingByStation(net!.stations.length)[si] : 0, from: top(from), to: top(to) };
  }

  routeDetail(routeId: number) {
    const ri = this.routeById.get(routeId);
    const net = this.net;
    if (ri === undefined || !net || !this.graph) return null;
    const r = net.routes[ri];
    const useLast = this.last.peakLoad.length === this.peakLoad.length;
    const src = useLast ? this.last.peakLoad : this.peakLoad;
    const srcT = useLast ? this.last.peakTrains : this.peakTrains;
    const dirs = [0, 1].map((d) => {
      const n = r.dirs[d].stopS.length;
      const base = this.graph!.base[ri][d];
      const load: number[] = [];
      const capacity: number[] = [];
      for (let k = 0; k < n - 1; k++) {
        load.push(src[base + k]);
        capacity.push(srcT[base + k] * r.capComfort);
      }
      return { stations: Array.from(r.dirs[d].stopStation, (si) => net.stations[si].name), load, capacity };
    });
    return { dirs, ridersToday: (this.day.routeBoard.get(routeId) ?? 0) * this.scale, ridersYesterday: this.last.report?.routeRiders[routeId] ?? 0 };
  }

  tractDetail(tract: number) {
    let n = 0;
    const share = [0, 0, 0];
    let timeSum = 0, timeN = 0;
    for (let g = 0; g < this.G; g++) {
      if (this.gHome[g] !== tract) continue;
      const c = this.gCount[g];
      n += c;
      for (let m = 0; m < 3; m++) share[m] += this.shares[g * 3 + m] * c;
      // Expected one-way commute: walk/drive known, transit observed or scheduled.
      const tw = isFinite(this.gWalk[g]) ? this.gWalk[g] : 0;
      const tt = this.obsTime[g] > 0 ? this.obsTime[g] : this.pathAM[g]?.time ?? 0;
      timeSum += c * (this.shares[g * 3] * tw + this.shares[g * 3 + 1] * this.gDrive[g] + this.shares[g * 3 + 2] * tt);
      timeN += c;
    }
    return {
      commuters: n * this.scale,
      share: n ? share.map((s) => s / n) : [0, 0, 0],
      avgCommute: timeN ? timeSum / timeN / 60 : 0,
      unserved: this.unserved[tract],
    };
  }

  flows(limit: number) {
    // Aggregate bands per tract pair.
    const pairs = new Map<number, { h: number; w: number; n: number; t: number }>();
    const T = this.world.tracts.length;
    for (let g = 0; g < this.G; g++) {
      const k = this.gHome[g] * T + this.gWork[g];
      if (this.gHome[g] === this.gWork[g]) continue;
      let p = pairs.get(k);
      if (!p) pairs.set(k, (p = { h: this.gHome[g], w: this.gWork[g], n: 0, t: 0 }));
      p.n += this.gCount[g];
      p.t += this.transitAgents(g);
    }
    return [...pairs.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)
      .map((p) => ({ home: p.h, work: p.w, count: p.n * this.scale, transitShare: p.n ? p.t / p.n : 0 }));
  }

  // ------------------------------------------------------------------ heap
  private push(t: number, a: number, type: number): void {
    if (this.hN >= this.hT.length) {
      const nt = new Float64Array(this.hT.length * 2);
      nt.set(this.hT);
      const nv = new Int32Array(this.hV.length * 2);
      nv.set(this.hV);
      this.hT = nt;
      this.hV = nv;
    }
    const v = (a << 3) | type;
    let i = this.hN++;
    const T = this.hT, V = this.hV;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (T[par] <= t) break;
      T[i] = T[par];
      V[i] = V[par];
      i = par;
    }
    T[i] = t;
    V[i] = v;
  }

  private pop(): number {
    const T = this.hT, V = this.hV;
    const top = V[0];
    const n = --this.hN;
    if (n > 0) {
      const t = T[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && T[c + 1] < T[c]) c++;
        if (T[c] >= t) break;
        T[i] = T[c];
        V[i] = V[c];
        i = c;
      }
      T[i] = t;
      V[i] = v;
    }
    return top;
  }

  /** Agents currently mid-trip (for the stuck-agent check). */
  inFlight(): number {
    let n = 0;
    for (let a = 0; a < this.A; a++) {
      const s = this.aState[a];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) n++;
    }
    return n;
  }

  stuckCount(): number {
    return this.day.stuck;
  }
}

function newDayStats(day: number) {
  return {
    day,
    trips: 0,
    tripTimeSum: 0,
    transitTrips: 0,
    modeCount: [0, 0, 0],
    leftBehind: 0,
    gaveUp: 0,
    stuck: 0,
    routeBoard: new Map<number, number>(),
  };
}

export { S_HOME, S_WORK, S_DONE };
