/**
 * Commuters: agents generated from the real OD table, daily logit mode choice, transit
 * pathfinding, and an event-driven simulation of every transit trip (walk → platform queue →
 * train with capacity → transfers → walk) whose observed times feed the next day's choice.
 */
import { CHAOS, COMMUTERS, EVENTS, FARES, GOALS, OPERATIONS, TIME } from '../balance';
import { expectedFare, fareAt, isPeakTime, isPeakTod, tripFare, variesByTime, type FarePolicy } from '../economy/fares';
import { emptyStats } from './regularity';
import { SECONDS_PER_DAY, dayIndex } from '../core/calendar';
import { CLEAR_MODS, eventKind, venueOf, weatherMods, SALT_TRIPS, type CityEvent, type DayWeather, type FullWeatherMods } from '../core/cityCalendar';
import { toLocal } from '../core/geo';
import { cityBalance, inZone } from '../cities';
import { hashSeed, pointInDisc, Rng, stochasticRound, triangular } from '../core/rng';
import type { World } from '../data/world';
import { eventCosts, originCdf, reverseLegs, sampleBand, sampleCdf, venueGeometry } from './eventTrips';
import {
  driveTripTime,
  fareOddsMultiplier,
  generalisedCosts,
  logitShares,
  MODE_DRIVE,
  MODE_TRANSIT,
  MODE_WALK,
  walkTime,
  type PairGeometry,
} from './modeChoice';
import type { CompiledNetwork, CRoute, DayReport, EventDayInfo, EventOutcome, LiveStats, ModeState, ServiceOverride } from './protocol';
import { TransitGraph } from './transitGraph';
import { periodIndex, type PassengerHooks, type Train } from './trainSim';

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

export interface GroupPath {
  /** [routeId, boardStationId, alightStationId] × legs */
  legs: Int32Array;
  time: number;
  transfers: number;
}

/** City chaos: event-goers from one origin tract to one event (agents a ≥ A point here via aGroup). */
interface EventGroup {
  /** Index into today's events (evEvents). */
  ev: number;
  tract: number;
  /** Home → venue. */
  to: GroupPath;
  /** Venue → home. */
  from: GroupPath;
  /** Drive time (s) for a cab fallback. */
  drive: number;
}

/** Per event, real people. */
interface EventTally {
  /** [walk, drive, transit] as chosen at 3 am (overflow counted as drive). */
  planned: [number, number, number];
  overflow: number;
  arrived: number;
  late: number;
  gaveUp: number;
  home: number;
  timeSum: number;
  timeN: number;
}

const newTally = (): EventTally => ({ planned: [0, 0, 0], overflow: 0, arrived: 0, late: 0, gaveUp: 0, home: 0, timeSum: 0, timeN: 0 });

export class Commuters implements PassengerHooks {
  readonly scale: number;
  /** Commuter agents (0 … A−1); agents A … A+poolCap−1 are the event pool. */
  readonly A: number;
  readonly G: number;
  /** City chaos: event agents available per day. */
  readonly poolCap: number;
  private world: World;
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
  /** Did this trip actually board a train? Only those count as riders (and pay a fare). */
  aBoarded: Uint8Array;
  /** Earnings band per agent (commuters: their group's; event fans: drawn), for billing. */
  aBand: Uint8Array;
  /**
   * Fare policy (v2): which of a commuter's trips start in a peak period (bit 0 the morning trip,
   * bit 1 the trip home, assuming a FARES.amTripEstimate morning trip). No RNG draws.
   */
  aPeak: Uint8Array;
  /** Mean share of each group's trips that start in a peak (popcount(aPeak) / 2 over its agents). */
  gPeakFrac: Float32Array;
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
  private fares: FarePolicy;
  /** fareAt(fares, band, peak) by band × 2 + peak (filled by setFares). */
  private fareTable = new Float64Array(6);
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
  goalTrip: number | null = null;
  // ---- city chaos
  private evUsed = 0;
  private evGroups: EventGroup[] = [];
  private evTally: EventTally[] = [];
  private evEvents: CityEvent[] = [];
  private evDayStart = 0;
  /** Resident band mix per tract (tracts × 3 shares), for drawing event-goers. */
  private homeBand: Float32Array;
  private wx: FullWeatherMods = CLEAR_MODS;
  private closedUntil: Float64Array = new Float64Array(0);
  /** Stations within walking reach of each tract (kept from recomputePaths). */
  private access: { station: number; walk: number }[][] = [];
  private baselineCache = new Map<string, number>();
  /** The no-subway baseline under today's weather (equals baseline on a clear day). */
  baselineToday = 0;

  constructor(world: World, opts: { agentScale: number; seed: number; fares: FarePolicy; modeState?: ModeState }, cb: EngineCb = {}) {
    this.world = world;
    this.scale = opts.agentScale;
    this.fares = opts.fares;
    this.setFares(opts.fares);
    this.cb = cb;
    this.rng = new Rng(opts.seed);
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
    this.poolCap = Math.ceil(EVENTS.maxPeoplePerDay / this.scale);
    const cap = A + this.poolCap;
    this.key = `${world.meta.source}|${world.tracts.length}|${od.pairCount}|${this.scale}|${opts.seed}|${A}|${G}`;
    // ---- pair geometry and walk/drive times
    const zones = cityBalance();
    const core = new Set(zones.coreRegions);
    const cbd = tr.map((t) => inZone(zones.cbd, t.lon, t.lat, t.borough));
    this.gWalk = new Float32Array(G);
    this.gDrive = new Float32Array(G);
    this.gDriveHome = new Float32Array(G);
    this.gGeom = new Array(G);
    for (let g = 0; g < G; g++) {
      const h = tr[this.gHome[g]], w = tr[this.gWork[g]];
      const d = h.index === w.index ? Math.max(200, h.radius * 0.6) : Math.hypot(h.x - w.x, h.y - w.y);
      const geom: PairGeometry = {
        distance: d,
        homeCore: core.has(h.borough),
        workCore: core.has(w.borough),
        workCbd: cbd[w.index],
        homeCbd: cbd[h.index],
      };
      this.gGeom[g] = geom;
      this.gWalk[g] = walkTime(d);
      this.gDrive[g] = driveTripTime(geom);
      this.gDriveHome[g] = driveTripTime({ ...geom, workCbd: geom.homeCbd });
    }
    // ---- agents (with room for the event pool after them)
    this.aGroup = new Int32Array(cap);
    this.aHx = new Float32Array(cap);
    this.aHy = new Float32Array(cap);
    this.aWx = new Float32Array(cap);
    this.aWy = new Float32Array(cap);
    this.aDepart = new Float32Array(cap);
    this.aReturn = new Float32Array(cap);
    this.aMode = new Uint8Array(cap);
    this.aState = new Uint8Array(cap);
    this.aLeg = new Uint8Array(cap);
    this.aLegN = new Uint8Array(cap);
    this.aLegs = new Int32Array(cap * MAX_LEGS * 3);
    this.aTripStart = new Float64Array(cap);
    this.aWaitStart = new Float64Array(cap);
    this.aPlat = new Int32Array(cap).fill(-1);
    this.aCrowd = new Float32Array(cap);
    this.aLeft = new Uint8Array(cap);
    this.aPM = new Uint8Array(cap);
    this.aBoarded = new Uint8Array(cap);
    this.aBand = new Uint8Array(cap);
    this.aPeak = new Uint8Array(cap);
    this.gPeakFrac = new Float32Array(G);
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
        // Fare periods of the two trips (from the stored values; no extra draws).
        this.aBand[a] = this.gBand[g];
        const pk = (isPeakTod(this.aDepart[a]) ? 1 : 0) | (isPeakTod(this.aDepart[a] + FARES.amTripEstimate + this.aReturn[a]) ? 2 : 0);
        this.aPeak[a] = pk;
        this.gPeakFrac[g] += ((pk & 1) + (pk >> 1)) / 2;
      }
      this.gPeakFrac[g] /= Math.max(1, this.gCount[g]);
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
    this.baselineToday = this.baseline;
    this.baselineCache.set('clear', this.baseline);
    // Resident band mix per tract, for event-goers.
    this.homeBand = new Float32Array(tr.length * 3);
    for (let g = 0; g < G; g++) this.homeBand[this.gHome[g] * 3 + this.gBand[g]] += this.gCount[g];
    for (let t = 0; t < tr.length; t++) {
      const o = t * 3;
      const sum = this.homeBand[o] + this.homeBand[o + 1] + this.homeBand[o + 2];
      for (let b = 0; b < 3; b++) this.homeBand[o + b] = sum > 0 ? this.homeBand[o + b] / sum : 1 / 3;
    }
    if (opts.modeState && opts.modeState.key === this.key && opts.modeState.shares.length === G * 3) {
      this.shares.set(opts.modeState.shares);
      this.obsTime.set(opts.modeState.obsTime);
      this.obsCrowd.set(opts.modeState.obsCrowd);
    }
    this.unserved = new Float32Array(tr.length);
  }

  /** Fare policy: billing uses it from the next boarding, mode choice from the next 3 am. */
  setFares(p: FarePolicy): void {
    this.fares = { ...p };
    for (let b = 0; b < 3; b++) {
      this.fareTable[b * 2] = fareAt(this.fares, b, false);
      this.fareTable[b * 2 + 1] = fareAt(this.fares, b, true);
    }
  }

  farePolicy(): FarePolicy {
    return { ...this.fares };
  }

  /** The fare a group's mode choice sees: its band's fare, weighted by the share of its trips in a peak. */
  groupFare(g: number): number {
    return expectedFare(this.fares, this.gBand[g], this.gPeakFrac[g]);
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
    // Two passes: collect every live waiter first (stale queue entries fail the aPlat check),
    // then re-enqueue, so nobody can be queued twice when platform indices shift.
    if (old && oldGraph) {
      const moving: number[] = [];
      for (let p = 0; p < oldQueues.length; p++) {
        const q = oldQueues[p];
        for (let i = 0; i < q.length; i++) {
          const a = q[i];
          if (this.aState[a] !== S_WAIT || this.aPlat[a] !== p) continue;
          this.aPlat[a] = -1;
          moving.push(a);
        }
      }
      for (const a of moving) {
        const np = this.platformFor(a);
        if (np < 0) this.finishByCab(a, t);
        else this.enqueue(a, np);
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
    const oldAM = this.pathAM;
    this.pathAM = new Array(G).fill(null);
    this.pathPM = new Array(G).fill(null);
    this.unserved.fill(0);
    this.goalTrip = null;
    this.access = [];
    const graph = this.graph;
    const net = this.net;
    if (graph && net) {
      this.cb.busy?.('Updating routes');
      const t0 = Date.now();
      const tracts = this.world.tracts;
      // Stations within walking distance of each tract.
      const access: { station: number; walk: number }[][] = tracts.map((tr) => {
        const reach = COMMUTERS.maxAccessWalk + COMMUTERS.accessRadiusTractShare * tr.radius;
        const out: { station: number; walk: number }[] = [];
        net.stations.forEach((s, i) => {
          const d = Math.hypot(s.x - tr.x, s.y - tr.y);
          if (d <= reach) out.push({ station: i, walk: (d * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed });
        });
        return out;
      });
      this.access = access;
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
      for (const [h, groups] of byHome) solve(h, groups, (g) => this.gWork[g], this.pathAM);
      // The timed-trip goal, door to door from the goal points themselves (not tract centres:
      // London's Heathrow MSOA centre is 2.4 km from the terminals).
      const pointAccess = (p: [number, number]) => {
        const [px, py] = toLocal(p[0], p[1]);
        const out: { station: number; walk: number }[] = [];
        net.stations.forEach((s, i) => {
          const d = Math.hypot(s.x - px, s.y - py);
          if (d <= COMMUTERS.maxAccessWalk) out.push({ station: i, walk: (d * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed });
        });
        return out;
      };
      const fromAcc = pointAccess(GOALS.tripFrom), toAcc = pointAccess(GOALS.tripTo);
      if (fromAcc.length && toAcc.length) {
        graph.run(fromAcc);
        const p = this.bestPath(graph, toAcc);
        this.goalTrip = p ? p.time / 60 : null;
      }
      graph.setPeriod(3); // PM peak
      for (const [w, groups] of byWork) solve(w, groups, (g) => this.gHome[g], this.pathPM);
      graph.setPeriod(1);
      const ms = Date.now() - t0;
      this.lastPathMs = ms;
      this.cb.busy?.(null);
    }
    // Observed times describe the old network; drop them where the trip changed.
    for (let g = 0; g < G; g++) {
      const o = oldAM[g], n = this.pathAM[g];
      // (Keep restored observations on the first network after loading a save.)
      if (!n || (o && Math.abs(o.time - n.time) > 0.05 * o.time)) {
        this.obsTime[g] = 0;
        this.obsCrowd[g] = 0;
      }
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
    const net = this.net!;
    const cands: { cost: number; plat: number; station: number }[] = [];
    for (const e of egress) {
      const a = graph.bestArrival(e.station);
      if (a.plat < 0) continue;
      const c = a.cost + e.walk;
      if (c < Infinity) cands.push({ cost: c, plat: a.plat, station: e.station });
    }
    cands.sort((x, y) => x.cost - y.cost);
    for (const cand of cands) {
      const legs = graph.legsTo(cand.plat);
      if (!legs.length || legs.length > MAX_LEGS) continue;
      // A trip that ends back where it boarded is a round trip, not a commute.
      const l0 = legs[0];
      const firstSt = net.routes[l0.route].dirs[l0.dir].stopStation[l0.board];
      if (net.stations[firstSt].group === net.stations[cand.station].group) continue;
      const arr = new Int32Array(legs.length * 3);
      legs.forEach((l, i) => {
        const r = net.routes[l.route];
        const dir = r.dirs[l.dir];
        arr[i * 3] = r.id;
        arr[i * 3 + 1] = net.stations[dir.stopStation[l.board]].id;
        arr[i * 3 + 2] = net.stations[dir.stopStation[l.alight]].id;
      });
      const transfers = legs.length - 1;
      return { legs: arr, time: cand.cost - transfers * COMMUTERS.transferPenalty, transfers };
    }
    return null;
  }

  // ------------------------------------------------------------------ daily cycle
  startDay(t: number): void {
    // Before 3am the daily mode choice will plan the day; scheduling now would plan it twice.
    if (t - dayIndex(t) * SECONDS_PER_DAY < TIME.modeChoiceAt) return;
    // A game started (or loaded) after 3am: schedule today's trips without re-choosing modes.
    this.drawModesAndSchedule(dayIndex(t) * SECONDS_PER_DAY, t);
  }

  /** 3 am: update mode shares from yesterday's experience, then everyone plans their day. */
  dailyModeChoice(t: number): void {
    // New shares.
    for (let g = 0; g < this.G; g++) {
      const am = this.pathAM[g], pm = this.pathPM[g];
      let transit = null;
      if (am && pm) {
        const sched = (am.time + pm.time) / 2;
        // Observed times include waits and crowding delays; blend toward schedule if stale.
        const time = this.obsTime[g] > 0 ? this.obsTime[g] : sched;
        transit = { time, transfers: (am.transfers + pm.transfers) / 2, crowdMinutes: this.obsCrowd[g], fare: this.groupFare(g) };
      }
      const c = generalisedCosts(this.gGeom[g], this.gBand[g], transit, this.wx);
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
    // Anyone still out from yesterday is sent home (counted as stuck); yesterday's event-goers
    // are removed (the pool empties).
    let stuck = 0;
    for (let a = 0; a < this.A + this.evUsed; a++) {
      const s = this.aState[a];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) stuck++;
      this.aState[a] = S_HOME;
      this.aPlat[a] = -1;
    }
    this.day.stuck += stuck;
    this.resetEventPool();
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
    // Fares that vary by time of day tilt each agent's transit odds by its own trips' fare against
    // the group's expected fare (no extra RNG draws; with one fare all day the draw is exactly v1's).
    const tilt = variesByTime(this.fares);
    const mult = [1, 1, 1];
    for (let g = 0; g < this.G; g++) {
      const o = g * 3;
      const hasTransit = this.pathAM[g] && this.pathPM[g];
      const pw = this.shares[o], pd = this.shares[o + 1];
      const pt = hasTransit ? this.shares[o + 2] : 0;
      const sum = pw + pd + pt || 1;
      const band = this.gBand[g];
      const tiltG = tilt && pt > 0;
      if (tiltG) {
        const gf = this.groupFare(g);
        for (let k = 0; k < 3; k++) mult[k] = fareOddsMultiplier(tripFare(this.fares, band, k) - gf, band);
      }
      for (let a = this.gStart[g]; a < this.gStart[g + 1]; a++) {
        let mode: number;
        if (tiltG) {
          const pk = this.aPeak[a];
          const ptA = pt * mult[(pk & 1) + (pk >> 1)];
          const r = this.rng.next() * (pw + pd + ptA || 1);
          mode = r < pw ? MODE_WALK : r < pw + pd ? MODE_DRIVE : MODE_TRANSIT;
        } else {
          const r = this.rng.next() * sum;
          mode = r < pw ? MODE_WALK : r < pw + pd ? MODE_DRIVE : MODE_TRANSIT;
        }
        this.aMode[a] = mode;
        d.bandMode[band * 3 + mode]++;
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
          // Walking and driving aren't simulated step by step — their times are known (today's weather).
          const tAm = mode === MODE_WALK ? this.walkTimeToday(g) : this.driveTime(g, false);
          const tPm = mode === MODE_WALK ? this.walkTimeToday(g) : this.driveTime(g, true);
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
            if (a >= this.A) this.evTally[this.evGroups[this.aGroup[a]].ev].gaveUp += this.scale;
            this.finishByCab(a, et);
          }
          break;
      }
    }
  }

  private beginTrip(a: number, t: number, pm: boolean): void {
    const g = this.aGroup[a];
    const path = a >= this.A ? (pm ? this.evGroups[g].from : this.evGroups[g].to) : pm ? this.pathPM[g] : this.pathAM[g];
    this.aPM[a] = pm ? 1 : 0;
    this.aTripStart[a] = t;
    this.aCrowd[a] = 0;
    this.aBoarded[a] = 0;
    this.aLeft[a] = 0;
    if (!path) {
      // Lost their transit option (network changed): drive today.
      const dt = this.driveTime(g, pm);
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
    const walk = (Math.hypot(st.x - x, st.y - y) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
    this.aState[a] = S_WALK;
    this.push(t + walk, a, E_PLATFORM);
  }

  private arrivePlatform(a: number, t: number): void {
    const p = this.platformFor(a);
    if (p < 0) {
      this.finishByCab(a, t);
      return;
    }
    const cu = this.closedUntil;
    if (cu.length) {
      const until = cu[this.graph!.platStation[p]];
      if (until > t) {
        this.closedAt(a, until, t);
        return;
      }
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
        const walk = nextSt ? (Math.hypot(nextSt.x - station.x, nextSt.y - station.y) / (1.2 * this.wx.walkSpeed) + 60) : 60;
        this.aState[a] = S_WALK;
        this.push(t + walk, a, E_PLATFORM);
      } else {
        const x = this.aPM[a] ? this.aHx[a] : this.aWx[a];
        const y = this.aPM[a] ? this.aHy[a] : this.aWy[a];
        const walk = (Math.hypot(station.x - x, station.y - y) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
        this.aState[a] = S_EGRESS;
        this.push(t + walk, a, E_ARRIVE);
      }
    }
    train.load -= off.length;
    const board = this.board(train, route, stopIdx, t, false);
    return { alight: off.length * this.scale, board: board * this.scale };
  }

  depart(train: Train, route: CRoute, stopIdx: number, t: number): void {
    if (!this.graph) return;
    this.board(train, route, stopIdx, t, true);
    // Peak-hour load on the segment leaving this stop.
    const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
    if (hour === OPERATIONS.peakHour) {
      const p = this.graph.base[train.route][train.dir] + stopIdx;
      this.peakLoad[p] += train.load * this.scale;
      this.peakTrains[p]++;
    }
  }

  /** Board from the platform queue up to crush capacity. Left-behinds are counted once, as the train leaves. */
  private board(train: Train, route: CRoute, stopIdx: number, t: number, countLeft: boolean): number {
    const graph = this.graph!;
    const p = graph.base[train.route][train.dir] + stopIdx;
    const q = this.queues[p];
    let head = this.qHead[p];
    const capAgents = Math.floor(route.capCrush / this.scale);
    const stops = this.stopIndex[train.route][train.dir];
    const dir = route.dirs[train.dir];
    const stationIdx = dir.stopStation[stopIdx];
    // City chaos: nobody boards at a closed station (a train already dwelling when it closed, or a closed terminal).
    if (this.closedUntil.length && this.closedUntil[stationIdx] > t) return 0;
    // Fares by band and by the period of the first boarding.
    const peak = isPeakTime(t) ? 1 : 0;
    const ft = this.fareTable;
    const day = this.day;
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
      // One fare per journey, at the fare in force when it first boards (transfers are free), for
      // the rider's band and the period of that boarding.
      if (!this.aBoarded[a]) {
        const cell = this.aBand[a] * 2 + peak;
        const f = ft[cell];
        day.fareRevenue += f;
        day.fareCellTrips[cell]++;
        day.fareCellRevenue[cell] += f;
      }
      this.aBoarded[a] = 1;
      if (a >= this.A) this.day.eventBoard++;
      (train.buckets[k] ??= []).push(a);
      train.load++;
      boarded++;
      // Crowding experienced on this ride (load after boarding vs comfortable capacity).
      const ride = dir.schedArrive[k] - dir.schedArrive[stopIdx];
      this.aCrowd[a] += (ride / 60) * COMMUTERS.crowdingWeight * Math.max(0, (train.load * this.scale) / route.capComfort - 1) * this.wx.crowd;
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
    if (countLeft && train.load >= capAgents) {
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
    const rest = (a >= this.A ? this.evGroups[g].drive : this.driveTime(g, this.aPM[a] === 1)) * 0.6;
    this.recordTrip(a, t + rest, true);
  }

  private completeTrip(a: number, t: number): void {
    this.recordTrip(a, t, true);
  }

  private recordTrip(a: number, tEnd: number, transit: boolean): void {
    if (a >= this.A) {
      this.recordEventTrip(a, tEnd);
      return;
    }
    const g = this.aGroup[a];
    const dur = tEnd - this.aTripStart[a];
    const d = this.day;
    d.trips++;
    d.tripTimeSum += dur;
    if (transit) {
      if (this.aBoarded[a]) d.transitTrips++;
      // Give-ups still count towards how transit felt for this pair.
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
    let boardings = 0;
    for (const n of this.day.routeBoard.values()) boardings += n;
    return { ridersToday: boardings * this.scale, tripsInProgress: this.hN, inSystem: inSystem * this.scale };
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
      riders: [...d.routeBoard.values()].reduce((s, n) => s + n, 0) * this.scale,
      fareTrips: d.transitTrips * this.scale,
      fareRevenue: d.fareRevenue * this.scale,
      commuters: totalAgents * this.scale,
      transitShare: transitCommuters / totalAgents,
      walkShare: d.modeCount[MODE_WALK] / totalAgents,
      driveShare: d.modeCount[MODE_DRIVE] / totalAgents,
      avgCommute: d.trips ? d.tripTimeSum / d.trips / 60 : this.baselineToday,
      baselineCommute: this.baselineToday,
      carKm: 0,
      stationsOpen: 0,
      avgLateness: 0,
      leftBehind: d.leftBehind * this.scale,
      gaveUp: d.gaveUp * this.scale,
      deadlocks: 0,
      routeRiders,
      routeLateness: {},
      stationBoardings,
      goalTrip: this.goalTrip,
      boroughsServed: [],
      fares: { trips: Array.from(d.fareCellTrips, (x) => x * this.scale), revenue: Array.from(d.fareCellRevenue, (x) => x * this.scale) },
      bandShare: [0, 1, 2].map((b) => {
        const n = d.bandMode[b * 3] + d.bandMode[b * 3 + 1] + d.bandMode[b * 3 + 2];
        return n ? d.bandMode[b * 3 + 2] / n : 0;
      }),
      // Filled by the engine (train side).
      routeRegularity: {},
      regularity: emptyStats(),
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
    this.finishObservations();
    return report;
  }

  /**
   * Midnight: turn the day's experienced transit times into tomorrow's observations. Done at
   * midnight (not 3 am) so the midnight autosave already holds them.
   */
  private finishObservations(): void {
    for (let g = 0; g < this.G; g++) {
      const n = this.todayTimeN[g];
      if (n > 0) {
        this.obsTime[g] = this.todayTimeSum[g] / n;
        this.obsCrowd[g] = this.todayCrowdSum[g] / n;
      } else {
        // Nobody from this pair rode today: fall back to the timetable.
        this.obsTime[g] = 0;
        this.obsCrowd[g] = 0;
      }
    }
    this.todayTimeSum.fill(0);
    this.todayTimeN.fill(0);
    this.todayCrowdSum.fill(0);
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
      if (this.last.netVersion === net?.version && this.last.stationHourly.length === this.stationHourly.length) {
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
    // Yesterday's peak loads when they describe this same network and the route carried
    // anyone; otherwise today's so far (a new route, or the first day).
    let ranYesterday = false;
    if (this.last.netVersion === net.version && this.last.peakLoad.length === this.peakLoad.length) {
      for (const d of [0, 1]) {
        const base = this.graph.base[ri][d];
        for (let k = 0; k < r.dirs[d].stopS.length - 1; k++) if (this.last.peakLoad[base + k] > 0) ranYesterday = true;
      }
    }
    const src = ranYesterday ? this.last.peakLoad : this.peakLoad;
    const srcT = ranYesterday ? this.last.peakTrains : this.peakTrains;
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
    return { dirs, yesterday: ranYesterday, ridersToday: (this.day.routeBoard.get(routeId) ?? 0) * this.scale, ridersYesterday: this.last.report?.routeRiders[routeId] ?? 0 };
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

  // ------------------------------------------------------------------ city chaos
  /**
   * Today's weather (3 am, before mode choice): slower walks and drives, a walking penalty, more
   * crowding discomfort. The day's no-subway baseline is recomputed under it (cached per kind and
   * 0.1 severity bucket, since it loops over every group).
   */
  setWeather(w: DayWeather): void {
    this.wx = weatherMods(w);
    if (this.wx === CLEAR_MODS) {
      this.baselineToday = this.baseline;
      return;
    }
    const bucket = Math.round(w.severity * 10) / 10;
    const key = `${w.kind}:${bucket}`;
    let b = this.baselineCache.get(key);
    if (b === undefined) {
      b = this.computeBaseline(weatherMods({ kind: w.kind, severity: bucket, carried: false }));
      this.baselineCache.set(key, b);
    }
    this.baselineToday = b;
  }

  weather(): FullWeatherMods {
    return this.wx;
  }

  /** Average door-to-door minutes if there were no subway, under the given weather. */
  private computeBaseline(wx: FullWeatherMods): number {
    let base = 0;
    let n = 0;
    for (let g = 0; g < this.G; g++) {
      const p = logitShares(generalisedCosts(this.gGeom[g], this.gBand[g], null, wx));
      const walk = isFinite(this.gWalk[g]) ? this.gWalk[g] / wx.walkSpeed : 0;
      const t = (p[0] * walk + p[1] * this.driveTimeWx(g, false, wx)) / 60;
      base += t * this.gCount[g];
      n += this.gCount[g];
    }
    return n ? base / n : 0;
  }

  private walkTimeToday(g: number): number {
    const f = this.wx.walkSpeed;
    return f === 1 ? this.gWalk[g] : this.gWalk[g] / f;
  }

  /** One-way drive time today: only the road part slows (exactly the stored time when the factor is 1). */
  private driveTime(g: number, pm: boolean): number {
    return this.driveTimeWx(g, pm, this.wx);
  }

  private driveTimeWx(g: number, pm: boolean, wx: FullWeatherMods): number {
    const base = pm ? this.gDriveHome[g] : this.gDrive[g];
    const f = wx.driveSpeed;
    if (f === 1) return base;
    const geom = this.gGeom[g];
    const park = (pm ? geom.homeCbd : geom.workCbd) ? COMMUTERS.parkingCbdTime : COMMUTERS.parkingOtherTime;
    return (base - park) / f + park;
  }

  /** Closed stations by compiled station index (shared with the train sim). */
  setClosures(arr: Float64Array): void {
    this.closedUntil = arr;
  }

  /**
   * A station closes: everyone waiting on its platforms leaves. Short closures: they wait at the
   * gate and come back when it reopens (with a little jitter). Long ones: they give up and take a cab.
   */
  evictStation(si: number, until: number, t: number): void {
    const graph = this.graph;
    if (!graph || si < 0 || si >= graph.stationBoard.length) return;
    for (const p of graph.stationBoard[si]) {
      const q = this.queues[p];
      for (let i = this.qHead[p]; i < q.length; i++) {
        const a = q[i];
        if (this.aState[a] !== S_WAIT || this.aPlat[a] !== p) continue;
        this.leaveQueue(a);
        this.closedAt(a, until, t);
      }
      this.queues[p] = [];
      this.qHead[p] = 0;
    }
  }

  private closedAt(a: number, until: number, t: number): void {
    if (until - t <= CHAOS.police.waitOutside) {
      this.aState[a] = S_WALK;
      this.push(until + (a % 120), a, E_PLATFORM);
    } else {
      this.day.diverted++;
      this.finishByCab(a, t);
    }
  }

  /** A train runs through a closed stop: riders for it stay on to the next stop and walk from there. */
  pass(train: Train, _route: CRoute, stopIdx: number, _t: number): void {
    const b = train.buckets[stopIdx];
    if (!b || !b.length) return;
    const next = (train.buckets[stopIdx + 1] ??= []);
    for (const a of b) next.push(a);
    train.buckets[stopIdx] = [];
    this.day.carriedPast += b.length;
  }

  private resetEventPool(): void {
    this.evUsed = 0;
    this.evGroups = [];
    this.evEvents = [];
    this.evTally = [];
  }

  /**
   * Today's special events: event-goers drawn from residents (weighted towards the venue) choose
   * walk, drive (with venue parking) or transit; the transit ones become agents in the pool for
   * today only. Run at 3 am after mode choice, or after startDay on a mid-day load (fans already
   * at the venue then only make the trip home). Deterministic per event: Rng(seed, event id).
   */
  injectEvents(events: CityEvent[], dayStart: number, now: number, ctx: { seed: number; service?: readonly ServiceOverride[] }): EventDayInfo[] {
    // The pool is empty here (drawModesAndSchedule reset it); describe today's events.
    this.resetEventPool();
    this.evEvents = [...events].sort((a, b) => a.id - b.id);
    this.evDayStart = dayStart;
    this.evTally = this.evEvents.map(newTally);
    if (!this.evEvents.length) return [];
    const tracts = this.world.tracts;
    const graph = this.graph, net = this.net;
    const scale = this.scale;
    const wx = this.wx;
    const zones = cityBalance();
    const core = new Set(zones.coreRegions);
    let periodChanged = false;
    const out: EventDayInfo[] = [];
    this.evEvents.forEach((ev, ei) => {
      const venue = venueOf(ev);
      const kind = eventKind(ev);
      const [vx, vy] = toLocal(venue.lon, venue.lat);
      const venueCore = core.has(venue.region);
      const rng = new Rng(hashSeed(ctx.seed, ev.id, 0, SALT_TRIPS));
      const tally = this.evTally[ei];
      // Stations within reach of the venue; one Dijkstra from the venue to everywhere (the trip home).
      const vAcc: { station: number; walk: number }[] = [];
      if (net) {
        net.stations.forEach((st, i) => {
          const d = Math.hypot(st.x - vx, st.y - vy);
          if (d <= EVENTS.venueAccess) vAcc.push({ station: i, walk: (d * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * wx.walkSpeed) });
        });
      }
      const canRide = graph !== null && vAcc.length > 0;
      if (canRide) {
        graph.setPeriod(periodIndex(dayStart + ev.end));
        periodChanged = true;
        // Event service planned for the trip home shortens the expected waits (and so wins fans).
        const lo = dayStart + ev.end + EVENTS.serviceAfter[0], hi = dayStart + ev.end + EVENTS.serviceAfter[1];
        for (const o of ctx.service ?? []) {
          const ri = this.routeById.get(o.routeId);
          if (ri !== undefined && o.from < hi && o.to > lo) graph.capWait(ri, Math.min(COMMUTERS.waitCap, o.headwayMin * 30));
        }
        graph.run(vAcc);
      }
      const cdf = originCdf(tracts, vx, vy);
      // Fare periods of a fan's two trips: arriving around the start, leaving at the end.
      const evPeakTrips = (isPeakTod(ev.start + kind.arrive[0]) ? 1 : 0) + (isPeakTod(ev.end) ? 1 : 0);
      const n = stochasticRound(rng, ev.attendance / scale);
      const pathCache = new Map<number, GroupPath | null>();
      const shareCache = new Map<number, number[]>();
      const groupOf = new Map<number, number>();
      const geomOf = (t: number) => venueGeometry(tracts[t], vx, vy, core.has(tracts[t].borough), venueCore);
      for (let k = 0; k < n; k++) {
        const tract = sampleCdf(cdf, rng.next());
        const band = sampleBand(this.homeBand, tract, rng.next());
        let path = pathCache.get(tract);
        if (path === undefined) {
          path = canRide && this.access[tract]?.length ? this.bestPath(graph, this.access[tract]) : null;
          pathCache.set(tract, path);
        }
        let p = shareCache.get(tract * 3 + band);
        if (!p) {
          p = logitShares(eventCosts(geomOf(tract), band, path, venue, wx, tripFare(this.fares, band, evPeakTrips)));
          shareCache.set(tract * 3 + band, p);
        }
        const u = rng.next();
        const mode = u < p[0] ? MODE_WALK : u < p[0] + p[1] ? MODE_DRIVE : MODE_TRANSIT;
        if (mode !== MODE_TRANSIT || !path) {
          tally.planned[mode === MODE_TRANSIT ? MODE_DRIVE : mode] += scale;
          continue;
        }
        if (this.evUsed >= this.poolCap) {
          tally.overflow += scale;
          tally.planned[MODE_DRIVE] += scale;
          continue;
        }
        const a = this.A + this.evUsed++;
        let gi = groupOf.get(tract);
        if (gi === undefined) {
          gi = this.evGroups.length;
          groupOf.set(tract, gi);
          this.evGroups.push({ ev: ei, tract, from: path, to: reverseLegs(path), drive: driveTripTime(geomOf(tract), wx) });
        }
        this.aGroup[a] = gi;
        this.aBand[a] = band;
        this.aMode[a] = MODE_TRANSIT;
        this.aPM[a] = 0;
        this.aBoarded[a] = 0;
        this.aLeft[a] = 0;
        this.aCrowd[a] = 0;
        this.aPlat[a] = -1;
        const home = tracts[tract];
        const [hx, hy] = pointInDisc(rng, home.x, home.y, home.radius);
        const [wx2, wy2] = pointInDisc(rng, vx, vy, EVENTS.venueScatter);
        this.aHx[a] = hx;
        this.aHy[a] = hy;
        this.aWx[a] = wx2;
        this.aWy[a] = wy2;
        const arrive = dayStart + ev.start + triangular(rng, kind.arrive[0], kind.arrive[1]);
        const depart = arrive - path.time * EVENTS.tripBuffer;
        const leave = ev.end + triangular(rng, kind.leave[0], kind.leave[1]);
        // Seconds of day (relative, so Float32 keeps 1/128 s precision).
        this.aReturn[a] = leave;
        this.aDepart[a] = depart - dayStart;
        if (depart >= now) {
          this.aState[a] = S_HOME;
          this.push(depart, a, E_DEPART);
        } else {
          // Loaded after they set off: the trip to the venue happened before the save, so it
          // counts for the outcome at its expected time (door to door, no queues).
          tally.arrived += scale;
          if (depart + path.time > dayStart + ev.start) tally.late += scale;
          tally.timeSum += path.time * scale;
          tally.timeN += scale;
          if (dayStart + leave >= now) {
            // Mid-event: they're at the venue.
            this.aState[a] = S_WORK;
            this.push(dayStart + leave, a, E_RETURN);
          } else {
            this.aState[a] = S_DONE;
            tally.home += scale;
          }
        }
        tally.planned[MODE_TRANSIT] += scale;
      }
      out.push({
        id: ev.id,
        label: ev.label,
        venue: ev.venue,
        attendance: ev.attendance,
        start: ev.start,
        end: ev.end,
        byWalk: tally.planned[MODE_WALK],
        byDrive: tally.planned[MODE_DRIVE],
        byTransit: tally.planned[MODE_TRANSIT],
        overflow: tally.overflow,
      });
    });
    // Restore what recomputePaths leaves.
    if (periodChanged) graph!.setPeriod(1);
    return out;
  }

  /** An event-goer's trip ends: it counts for the event (and a fare-paying trip), never for commuters' choices. */
  private recordEventTrip(a: number, tEnd: number): void {
    const eg = this.evGroups[this.aGroup[a]];
    const tally = this.evTally[eg.ev];
    const ev = this.evEvents[eg.ev];
    if (this.aBoarded[a]) {
      this.day.transitTrips++;
      this.day.eventTrips++;
    }
    if (!this.aPM[a]) {
      tally.arrived += this.scale;
      if (tEnd > this.evDayStart + ev.start) tally.late += this.scale;
      tally.timeSum += (tEnd - this.aTripStart[a]) * this.scale;
      tally.timeN += this.scale;
      this.aState[a] = S_WORK;
      this.push(Math.max(tEnd + 60, this.evDayStart + this.aReturn[a]), a, E_RETURN);
    } else {
      tally.home += this.scale;
      this.aState[a] = S_DONE;
    }
  }

  /** Today's events so far (real people). */
  eventOutcomes(): EventOutcome[] {
    return this.evEvents.map((ev, i) => {
      const t = this.evTally[i];
      return {
        id: ev.id,
        label: ev.label,
        attendance: ev.attendance,
        byTransit: t.planned[MODE_TRANSIT],
        arrived: t.arrived,
        late: t.late,
        gaveUp: t.gaveUp,
        avgTripMin: t.timeN ? t.timeSum / t.timeN / 60 : 0,
      };
    });
  }

  /** Event agents in today's pool. */
  eventAgentCount(): number {
    return this.evUsed;
  }

  /** Event agents mid-trip. */
  eventInFlight(): number {
    let n = 0;
    for (let a = this.A; a < this.A + this.evUsed; a++) {
      const s = this.aState[a];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) n++;
    }
    return n;
  }

  /** Today's chaos counters (real people), read by the engine before the day closes. */
  chaosStats(): { eventRiders: number; diverted: number; carriedPast: number } {
    const d = this.day;
    return { eventRiders: d.eventBoard * this.scale, diverted: d.diverted * this.scale, carriedPast: d.carriedPast * this.scale };
  }
}

function newDayStats(day: number) {
  return {
    day,
    trips: 0,
    tripTimeSum: 0,
    transitTrips: 0,
    fareRevenue: 0,
    modeCount: [0, 0, 0],
    leftBehind: 0,
    gaveUp: 0,
    stuck: 0,
    routeBoard: new Map<number, number>(),
    // City chaos (agents): event fans' boardings and completed fare-paying trips, people sent
    // away from closed stations by cab, and riders carried past a closed station.
    eventBoard: 0,
    eventTrips: 0,
    diverted: 0,
    carriedPast: 0,
    // Fares (v2): first boardings and fares by band × 2 + peak, and modes drawn by band × 3 + mode.
    fareCellTrips: new Float64Array(6),
    fareCellRevenue: new Float64Array(6),
    bandMode: new Float64Array(9),
  };
}

export { S_HOME, S_WORK, S_DONE };
