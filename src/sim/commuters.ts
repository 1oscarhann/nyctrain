/**
 * Commuters: agents generated from the real OD table, daily logit mode choice, transit
 * pathfinding, and an event-driven simulation of every transit trip (walk → platform queue →
 * train with capacity → transfers → walk) whose observed times feed the next day's choice.
 */
import { CHAOS, COMMUTERS, EVENTS, FARES, GOALS, OPERATIONS, QUAD, TIME } from '../balance';
import { distanceFareMult, expectedFare, fareAt, isPeakTime, isPeakTod, tripFare, variesByTime, type FarePolicy } from '../economy/fares';
import { emptyStats } from './regularity';
import { SECONDS_PER_DAY, dayIndex } from '../core/calendar';
import { CLEAR_MODS, eventKind, venueOf, weatherMods, SALT_TRIPS, type CityEvent, type DayWeather, type FullWeatherMods } from '../core/cityCalendar';
import { toLocal } from '../core/geo';
import { cityBalance, inZone } from '../cities';
import { hash32x4, hashSeed, pointInDisc, Rng, stochasticRound, triangular } from '../core/rng';
import type { ODTable } from '../data/odFormat';
import type { World } from '../data/world';
import { eventCosts, originCdf, reverseLegs, sampleBand, sampleCdf, venueGeometry } from './eventTrips';
import type { OdFactors } from './growth';
import {
  driveMoney,
  driveTripTime,
  fareOddsMultiplier,
  generalisedCosts,
  logitShares,
  logsum,
  moneyToMinutes,
  MODE_DRIVE,
  MODE_TRANSIT,
  MODE_WALK,
  transitBenefit,
  transitCost,
  walkTime,
  type PairGeometry,
  type TransitCostInput,
} from './modeChoice';
import { hasExpressService, type CabWhy, type CompiledNetwork, type CRoute, type CRouteDir, type DayReport, type EventDayInfo, type EventOutcome, type LiveStats, type ModeState, type ServiceOverride, type StoryPick, type StoryPlan, type StoryWho, type TraceEvent } from './protocol';
import type { DailyPicks, TraceSink } from './stories';
import { effectiveTransfers, TransitGraph } from './transitGraph';
import { periodIndex, TState, type PassengerHooks, type Train } from './trainSim';

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

/**
 * Express service (v2) boarding tables, built per network only when it has express service (a
 * cross-platform pair or an express route): without one, riders board exactly as before.
 */
interface ExpressBoarding {
  /** Station complex of each compiled station: the lower index of a cross-platform pair, else itself. */
  complex: Int32Array;
  /** Per route and direction: station complex → stop index. */
  cstop: Map<number, number>[][];
  /**
   * Per boarding platform: the other routes' boarding platforms at the same station complex (one
   * of the two routes an express, both heading on to a shared complex), at the same station and
   * across the island at the pair's other platform.
   */
  sibSame: (number[] | null)[];
  sibAcross: (number[] | null)[];
  /** Any cross-platform pair (riders on board may step across to a faster train). */
  pairs: boolean;
}

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

// ---------------------------------------------------------------------------
// Agent groups (Living City, docs/v2/living-city.md §3.4)

/** Commuter groups (home tract, work tract, earnings band) rounded from the OD table. */
export interface GroupTable {
  home: Int32Array;
  work: Int32Array;
  band: Uint8Array;
  count: Int32Array;
  /** First agent of each group (G + 1 entries; start[G] = A). */
  start: Int32Array;
  G: number;
  A: number;
  /** Group keys (home·T + work)·3 + band strictly increase (od.bin is sorted by home then work). */
  sorted: boolean;
  /** The rounding stream after its last draw: the starting city's agents are placed from it, in v1's order. */
  gen: Rng;
}

/**
 * Round the OD table (scaled by the Living City factors, OD'[h][w] = OD[h][w]·fHome[h]·fWork[w])
 * to agent groups with common random numbers: one draw from Rng(seed·7919 + 13) per non-zero
 * cell, in file order, whatever the factors. Growth never creates a non-zero cell, so the stream
 * stays aligned and each cell's count is monotone in its factor; with no factors the groups are
 * exactly v1's. Pure.
 */
export function buildGroups(od: ODTable, tractCount: number, scale: number, seed: number, factors: OdFactors | null, sizeHint = 0): GroupTable {
  const gen = new Rng(seed * 7919 + 13);
  // (A regeneration passes the old group count: the arrays then start about the right size.)
  let cap = Math.max(1024, sizeHint > 0 ? Math.ceil(sizeHint * 1.02) + 1024 : od.pairCount);
  let home = new Int32Array(cap), work = new Int32Array(cap), band = new Uint8Array(cap), count = new Int32Array(cap);
  const fh = factors?.home ?? null, fw = factors?.work ?? null;
  const odHome = od.home, odWork = od.work;
  // (One local per band: indexing od.counts[b] in the loop costs as much as the rounding itself.)
  const c0 = od.counts[0], c1 = od.counts[1], c2 = od.counts[2];
  let G = 0, A = 0, prev = -1, sorted = true;
  for (let i = 0; i < od.pairCount; i++) {
    const h = odHome[i], w = odWork[i];
    for (let b = 0; b < 3; b++) {
      const c = b === 0 ? c0[i] : b === 1 ? c1[i] : c2[i];
      if (!c) continue;
      const exact = fh && fw ? (c * fh[h] * fw[w]) / scale : c / scale;
      let n = Math.floor(exact);
      if (gen.next() < exact - n) n++;
      if (n === 0) continue;
      if (G === cap) {
        cap *= 2;
        const grow = <T extends Int32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
          const x = make(cap);
          x.set(a);
          return x;
        };
        home = grow(home, (n) => new Int32Array(n));
        work = grow(work, (n) => new Int32Array(n));
        band = grow(band, (n) => new Uint8Array(n));
        count = grow(count, (n) => new Int32Array(n));
      }
      const key = (h * tractCount + w) * 3 + b;
      if (key <= prev) sorted = false;
      prev = key;
      home[G] = h;
      work[G] = w;
      band[G] = b;
      count[G] = n;
      A += n;
      G++;
    }
  }
  const start = new Int32Array(G + 1);
  for (let g = 0; g < G; g++) start[g + 1] = start[g] + count[g];
  return { home: home.slice(0, G), work: work.slice(0, G), band: band.slice(0, G), count: count.slice(0, G), start, G, A, sorted, gen };
}

/**
 * The ModeState key of a set of groups. With no growth tag it is exactly v1's
 * `${source}|${tracts}|${pairs}|${scale}|${seed}|${A}|${G}`; a grown city appends `|g<months>:<hash>`.
 */
export function makeKey(world: World, scale: number, seed: number, A: number, G: number, tag?: string): string {
  const base = `${world.meta.source}|${world.tracts.length}|${world.od.pairCount}|${scale}|${seed}|${A}|${G}`;
  return tag ? `${base}|${tag}` : base;
}

/** Group keys (home·T + work)·3 + band. */
export function groupKeys(home: Int32Array, work: Int32Array, band: Uint8Array, G: number, tractCount: number): Float64Array {
  const k = new Float64Array(G);
  for (let g = 0; g < G; g++) k[g] = (home[g] * tractCount + work[g]) * 3 + band[g];
  return k;
}

/**
 * Match new groups to old ones by key: `exact` is the old group with the same (home, work, band)
 * (−1: none), `pair` an old group with the same home and work in any band (the exact one when
 * there is one). A merge-join when both key lists are sorted, else a Map join (custom data).
 */
export function matchGroups(oldKeys: ArrayLike<number>, newKeys: ArrayLike<number>, sorted: boolean): { exact: Int32Array; pair: Int32Array } {
  const Go = oldKeys.length, Gn = newKeys.length;
  const exact = new Int32Array(Gn).fill(-1);
  const pair = new Int32Array(Gn).fill(-1);
  if (sorted) {
    let i = 0;
    for (let g = 0; g < Gn; g++) {
      const k = newKeys[g];
      while (i < Go && oldKeys[i] < k) i++;
      if (i < Go && oldKeys[i] === k) {
        exact[g] = pair[g] = i;
        continue;
      }
      // Same pair, another band: at most two places either side of the merge position.
      const pk = Math.floor(k / 3);
      for (let j = Math.max(0, i - 2); j <= Math.min(Go - 1, i + 1); j++) {
        if (Math.floor(oldKeys[j] / 3) === pk) {
          pair[g] = j;
          break;
        }
      }
    }
  } else {
    const byKey = new Map<number, number>(), byPair = new Map<number, number>();
    for (let i = 0; i < Go; i++) {
      byKey.set(oldKeys[i], i);
      const pk = Math.floor(oldKeys[i] / 3);
      if (!byPair.has(pk)) byPair.set(pk, i);
    }
    for (let g = 0; g < Gn; g++) {
      const e = byKey.get(newKeys[g]);
      if (e !== undefined) exact[g] = pair[g] = e;
      else pair[g] = byPair.get(Math.floor(newKeys[g] / 3)) ?? -1;
    }
  }
  return { exact, pair };
}

/** What regeneration carries over from the groups and agents it replaces. */
interface OldGroups {
  G: number;
  keys: Float64Array;
  sorted: boolean;
  count: Int32Array;
  start: Int32Array;
  geom: PairGeometry[];
  walk: Float32Array;
  drive: Float32Array;
  driveHome: Float32Array;
  lsBase: Float32Array;
  baseT: Float64Array;
  shares: Float32Array;
  obsTime: Float32Array;
  obsCrowd: Float32Array;
  pathAM: (GroupPath | null)[];
  pathPM: (GroupPath | null)[];
  /** Agents were placed with per-agent seeds. */
  hashed: boolean;
  /**
   * Old groups 0 … placed−1 have per-agent placements in the arrays below (only those are
   * copied): all of them for a hashed city, the pre-placed prefix for the starting city (prePlace).
   */
  placed: number;
  aHx: Float32Array;
  aHy: Float32Array;
  aWx: Float32Array;
  aWy: Float32Array;
  aDepart: Float32Array;
  aReturn: Float32Array;
  aBand: Uint8Array;
  aPeak: Uint8Array;
  peakFrac: Float32Array;
}

/** Old groups with their exact and pair matches for the new groups. */
interface Carry {
  old: OldGroups;
  exact: Int32Array;
  pair: Int32Array;
}

/** Where agents are placed and when they travel (agent-indexed). */
interface AgentPlacement {
  aHx: Float32Array;
  aHy: Float32Array;
  aWx: Float32Array;
  aWy: Float32Array;
  aDepart: Float32Array;
  aReturn: Float32Array;
}

/**
 * Living City: per-agent placements of the starting city's agents, computed a few thousand per
 * step ahead of the first growth (Commuters.prePlace) into side arrays the sim never reads, so
 * the first regeneration copies them instead of re-placing every agent at the month-end midnight.
 */
interface PrePlacement extends AgentPlacement {
  /** Groups 0 … done−1 are placed. */
  done: number;
  aPeak: Uint8Array;
  peakFrac: Float32Array;
}

/**
 * Draw agent `a`: its home point in tract h, its work point in w (pointInDisc's draws and
 * arithmetic, inlined), its departure and its return. Shared by every placement path, so a
 * pre-placed, copied or freshly placed agent is bit-identical.
 */
function drawAgent(gen: Rng, h: { x: number; y: number; radius: number }, w: { x: number; y: number; radius: number }, a: number, out: AgentPlacement): void {
  const ah = gen.next() * Math.PI * 2;
  const dh = Math.sqrt(gen.next()) * h.radius;
  out.aHx[a] = h.x + Math.cos(ah) * dh;
  out.aHy[a] = h.y + Math.sin(ah) * dh;
  const aw = gen.next() * Math.PI * 2;
  const dw = Math.sqrt(gen.next()) * w.radius;
  out.aWx[a] = w.x + Math.cos(aw) * dw;
  out.aWy[a] = w.y + Math.sin(aw) * dw;
  const dep = COMMUTERS.departMean + gen.normal() * COMMUTERS.departSd;
  out.aDepart[a] = Math.max(COMMUTERS.departMin, Math.min(COMMUTERS.departMax, dep));
  out.aReturn[a] = COMMUTERS.workDuration + (gen.next() * 2 - 1) * COMMUTERS.returnJitter;
}

/** Fare periods of an agent's two trips (bit 0: the morning trip starts in a peak, bit 1: the return), from its stored times. */
function peakBits(depart: number, ret: number): number {
  return (isPeakTod(depart) ? 1 : 0) | (isPeakTod(depart + FARES.amTripEstimate + ret) ? 2 : 0);
}

/**
 * Runs of consecutive exact matches: fn(g0, o0, n) for new groups g0 … g0+n−1 matching old groups
 * o0 … o0+n−1 (most of a regeneration, so whole runs are copied with TypedArray.set). With
 * `count`, runs also break where a group's agent count changed.
 */
function forExactRuns(exact: Int32Array, fn: (g0: number, o0: number, n: number) => void, count?: { now: Int32Array; old: Int32Array }): void {
  const G = exact.length;
  let g = 0;
  while (g < G) {
    const o0 = exact[g];
    if (o0 < 0 || (count && count.now[g] !== count.old[o0])) {
      g++;
      continue;
    }
    let n = 1;
    while (g + n < G && exact[g + n] === o0 + n && (!count || count.now[g + n] === count.old[o0 + n])) n++;
    fn(g, o0, n);
    g += n;
  }
}

/** What one regeneration did (for scripts and tests). */
export interface RegenStats {
  groups: number;
  agents: number;
  /** Groups kept exactly (shares, observations and paths carried over). */
  kept: number;
  /** New groups of a known pair (geometry and paths copied; shares fresh). */
  newBands: number;
  /** New pairs (paths searched; shares fresh). */
  newPairs: number;
  /** Old groups that vanished. */
  dropped: number;
  /** Agents mid-trip when it ran (sent home, counted as stuck). */
  stuck: number;
  /** All agents were re-placed with per-agent seeds (the first growth). */
  replaced: boolean;
}

export class Commuters implements PassengerHooks {
  readonly scale: number;
  /** Commuter agents (0 … A−1); agents A … A+poolCap−1 are the event pool. Living City regeneration changes A and G. */
  A = 0;
  G = 0;
  /** City chaos: event agents available per day. */
  readonly poolCap: number;
  private world: World;
  private readonly seed: number;
  // Groups (home tract, work tract, band); set by adoptGroups
  gHome!: Int32Array;
  gWork!: Int32Array;
  gBand!: Uint8Array;
  gStart!: Int32Array;
  gCount!: Int32Array;
  gWalk!: Float32Array;
  gDrive!: Float32Array;
  gDriveHome!: Float32Array;
  gGeom!: PairGeometry[];
  /** Distance fares: each group's fare multiplier (all 1 in the metro cities). */
  gFareMult!: Float32Array;
  /** Expected no-subway one-way minutes per group (clear day), for the baseline. */
  private gBaseT!: Float64Array;
  /** The group keys strictly increase (merge-join on regeneration). */
  private gSorted = true;
  shares!: Float32Array; // G × 3
  obsTime!: Float32Array; // yesterday's average observed transit door-to-door (s), 0 = none
  obsCrowd!: Float32Array; // minutes
  private todayTimeSum!: Float32Array;
  private todayTimeN!: Uint16Array;
  private todayCrowdSum!: Float32Array;
  pathAM: (GroupPath | null)[] = [];
  pathPM: (GroupPath | null)[] = [];
  // Agents (A + poolCap); set by buildAgents
  aGroup!: Int32Array;
  aHx!: Float32Array;
  aHy!: Float32Array;
  aWx!: Float32Array;
  aWy!: Float32Array;
  aDepart!: Float32Array;
  aReturn!: Float32Array;
  aMode!: Uint8Array;
  aState!: Uint8Array;
  aLeg!: Uint8Array;
  aLegN!: Uint8Array;
  aLegs!: Int32Array; // A × MAX_LEGS × 3
  aTripStart!: Float64Array;
  aWaitStart!: Float64Array;
  aPlat!: Int32Array;
  aCrowd!: Float32Array;
  aLeft!: Uint8Array;
  aPM!: Uint8Array;
  /** Did this trip actually board a train? Only those count as riders (and pay a fare). */
  aBoarded!: Uint8Array;
  /** Earnings band per agent (commuters: their group's; event fans: drawn), for billing. */
  aBand!: Uint8Array;
  /**
   * Fare policy (v2): which of a commuter's trips start in a peak period (bit 0 the morning trip,
   * bit 1 the trip home, assuming a FARES.amTripEstimate morning trip). No RNG draws.
   */
  aPeak!: Uint8Array;
  /** Mean share of each group's trips that start in a peak (popcount(aPeak) / 2 over its agents). */
  gPeakFrac!: Float32Array;
  /**
   * Living City: agents are placed from per-agent seeds hash32x4(seed, home·3 + band, work, k)
   * (a grown city), not from v1's sequential stream (the starting city). Switches once, at the
   * first growth regeneration.
   */
  private hashed = false;
  /** Living City: the starting city's per-agent placements, computed ahead of the first growth (prePlace). */
  private pre: PrePlacement | null = null;
  private readonly preGen = new Rng(1);
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
  /** Express service (v2): first-train-of-either boarding and cross-platform switching; null without it. */
  private xp: ExpressBoarding | null = null;
  private qHead: Int32Array = new Int32Array(0);
  private qLive: Int32Array = new Int32Array(0);
  private fares: FarePolicy;
  /** fareAt(fares, band, peak) by band × 2 + peak (filled by setFares). */
  private fareTable = new Float64Array(6);
  private rng: Rng;
  private cb: EngineCb;
  key = '';
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
  private homeBand!: Float32Array;
  /** Living City: event-goers' origin weights (current residents); null = tracts.json's. */
  private originWeights: ArrayLike<number> | null = null;
  private wx: FullWeatherMods = CLEAR_MODS;
  /** Today's weather as set at 3 am (the baseline is recomputed from it after a regeneration). */
  private wxDay: DayWeather | null = null;
  private baselineStale = false;
  private closedUntil: Float64Array = new Float64Array(0);
  /** Stations within walking reach of each tract (kept from recomputePaths). */
  private access: { station: number; walk: number }[][] = [];
  private baselineCache = new Map<string, number>();
  /** The no-subway baseline under today's weather (equals baseline on a clear day). */
  baselineToday = 0;
  // ---- Commuter stories (v2, docs/v2/commuter-stories.md)
  /**
   * The traced agent (−1: nobody). Every hook is one `a === this.traceA` compare before a call
   * that only reads sim state and records an event: nothing the sim reads is written.
   */
  traceA = -1;
  tracer: TraceSink | null = null;
  /** Commuter of the day: O(1) candidate checks at boarding and arrival (null: off). */
  daily: DailyPicks | null = null;

  constructor(world: World, opts: { agentScale: number; seed: number; fares: FarePolicy; modeState?: ModeState; factors?: OdFactors | null }, cb: EngineCb = {}) {
    this.world = world;
    this.scale = opts.agentScale;
    this.seed = opts.seed;
    this.fares = opts.fares;
    this.setFares(opts.fares);
    this.cb = cb;
    this.rng = new Rng(opts.seed);
    this.poolCap = Math.ceil(EVENTS.maxPeoplePerDay / this.scale);
    const factors = opts.factors ?? null;
    // ---- groups (stochastic rounding of counts to agents, seeded), geometry, no-subway shares
    const tbl = buildGroups(world.od, world.tracts.length, this.scale, opts.seed, factors);
    this.adoptGroups(tbl, null);
    this.key = makeKey(world, this.scale, opts.seed, this.A, this.G, factors?.tag);
    // ---- agents (with room for the event pool after them): v1's stream for the starting city,
    // per-agent seeds once it has grown.
    this.hashed = factors !== null;
    this.buildAgents(tbl, null);
    // ---- mode shares: restore or start from the no-subway equilibrium
    const G = this.G;
    this.obsTime = new Float32Array(G);
    this.obsCrowd = new Float32Array(G);
    this.todayTimeSum = new Float32Array(G);
    this.todayTimeN = new Uint16Array(G);
    this.todayCrowdSum = new Float32Array(G);
    if (opts.modeState && opts.modeState.key === this.key && opts.modeState.shares.length === G * 3) {
      this.shares.set(opts.modeState.shares);
      this.obsTime.set(opts.modeState.obsTime);
      this.obsCrowd.set(opts.modeState.obsCrowd);
    }
    this.unserved = new Float32Array(world.tracts.length);
  }

  /**
   * Take a group table: the group arrays, pair geometry and walk/drive times, the no-subway logit
   * shares (every group; regeneration then overwrites the carried and fresh ones), the no-subway
   * logsum (gLsBase) and one-way minutes (gBaseT), the baseline and the resident band mix. With
   * `carry`, band-independent geometry is copied from an old group of the same pair and
   * band-dependent values from the exact old group (identical to computing them).
   */
  private adoptGroups(tbl: GroupTable, carry: Carry | null): void {
    const G = tbl.G;
    const tr = this.world.tracts;
    this.G = G;
    this.A = tbl.A;
    this.gHome = tbl.home;
    this.gWork = tbl.work;
    this.gBand = tbl.band;
    this.gCount = tbl.count;
    this.gStart = tbl.start;
    this.gSorted = tbl.sorted;
    const zones = cityBalance();
    const core = new Set(zones.coreRegions);
    const cbd = tr.map((t) => inZone(zones.cbd, t.lon, t.lat, t.borough));
    this.gWalk = new Float32Array(G);
    this.gDrive = new Float32Array(G);
    this.gDriveHome = new Float32Array(G);
    this.gGeom = new Array(G);
    this.gBaseT = new Float64Array(G);
    this.shares = new Float32Array(G * 3);
    const lsBase = new Float32Array(G);
    const old = carry?.old ?? null;
    const walk = this.gWalk, drive = this.gDrive, driveHome = this.gDriveHome, geoms = this.gGeom, baseT = this.gBaseT;
    // Kept groups (runs of exact matches): everything copied in bulk.
    const done = new Uint8Array(G);
    if (carry && old) {
      forExactRuns(carry.exact, (g0, o0, len) => {
        walk.set(old.walk.subarray(o0, o0 + len), g0);
        drive.set(old.drive.subarray(o0, o0 + len), g0);
        driveHome.set(old.driveHome.subarray(o0, o0 + len), g0);
        lsBase.set(old.lsBase.subarray(o0, o0 + len), g0);
        baseT.set(old.baseT.subarray(o0, o0 + len), g0);
        for (let k = 0; k < len; k++) geoms[g0 + k] = old.geom[o0 + k];
        done.fill(1, g0, g0 + len);
      });
    }
    for (let g = 0; g < G; g++) {
      if (done[g]) continue;
      const pr = carry ? carry.pair[g] : -1;
      if (old && pr >= 0) {
        // A new band of a known pair: the geometry does not depend on the band.
        geoms[g] = old.geom[pr];
        walk[g] = old.walk[pr];
        drive[g] = old.drive[pr];
        driveHome[g] = old.driveHome[pr];
      } else {
        const h = tr[this.gHome[g]], w = tr[this.gWork[g]];
        const d = h.index === w.index ? Math.max(200, h.radius * 0.6) : Math.hypot(h.x - w.x, h.y - w.y);
        const geom: PairGeometry = {
          distance: d,
          homeCore: core.has(h.borough),
          workCore: core.has(w.borough),
          workCbd: cbd[w.index],
          homeCbd: cbd[h.index],
        };
        geoms[g] = geom;
        walk[g] = walkTime(d);
        drive[g] = driveTripTime(geom);
        driveHome[g] = driveTripTime({ ...geom, workCbd: geom.homeCbd });
      }
      const c = generalisedCosts(geoms[g], this.gBand[g], null);
      lsBase[g] = logsum(c);
      const p = logitShares(c);
      this.shares[g * 3] = p[0];
      this.shares[g * 3 + 1] = p[1];
      this.shares[g * 3 + 2] = p[2];
      baseT[g] = (p[0] * (isFinite(walk[g]) ? walk[g] : 0) + p[1] * drive[g]) / 60;
    }
    this.gFareMult = new Float32Array(G);
    for (let g = 0; g < G; g++) this.gFareMult[g] = distanceFareMult(geoms[g].distance);
    let base = 0;
    let n = 0;
    const count = this.gCount;
    for (let g = 0; g < G; g++) {
      base += baseT[g] * count[g];
      n += count[g];
    }
    this.baseline = n ? base / n : 0;
    this.gLsBase = lsBase;
    this.baselineCache.clear();
    this.baselineCache.set('clear', this.baseline);
    // Today's weather baseline describes the old groups: recomputed when a report needs it (the
    // next 3 am sets the weather again first, so a month close at midnight never pays for it).
    this.baselineStale = this.wx !== CLEAR_MODS;
    this.baselineToday = this.baseline;
    // Resident band mix per tract, for event-goers.
    this.homeBand = new Float32Array(tr.length * 3);
    for (let g = 0; g < G; g++) this.homeBand[this.gHome[g] * 3 + this.gBand[g]] += this.gCount[g];
    for (let t = 0; t < tr.length; t++) {
      const o = t * 3;
      const sum = this.homeBand[o] + this.homeBand[o + 1] + this.homeBand[o + 2];
      for (let b = 0; b < 3; b++) this.homeBand[o + b] = sum > 0 ? this.homeBand[o + b] / sum : 1 / 3;
    }
  }

  /**
   * Allocate the agent arrays (A commuters plus the event pool) and place every commuter: from
   * the rounding stream `tbl.gen` in v1's order for the starting city, else agent k of group
   * (h, w, b) from Rng(hash32x4(seed, h·3 + b, w, k)), a pure function of its identity. With
   * `carry` (a regeneration of an already-hashed city), each kept group's first agents are copied
   * from its old slice, which equals placing them again.
   */
  private buildAgents(tbl: GroupTable, carry: Carry | null): void {
    const A = this.A, G = this.G;
    const cap = A + this.poolCap;
    const tr = this.world.tracts;
    const aGroup = (this.aGroup = new Int32Array(cap));
    const aHx = (this.aHx = new Float32Array(cap));
    const aHy = (this.aHy = new Float32Array(cap));
    const aWx = (this.aWx = new Float32Array(cap));
    const aWy = (this.aWy = new Float32Array(cap));
    const aDepart = (this.aDepart = new Float32Array(cap));
    const aReturn = (this.aReturn = new Float32Array(cap));
    // Trip state (written before it is read on every trip): reused, cleared, while it is large
    // enough, so a month close does not allocate ≈ 30 MB of it again; new arrays get room for a
    // few months of growth. Only [0, A + poolCap) is ever used.
    if (this.aState && this.aState.length >= cap) {
      this.aMode.fill(0);
      this.aState.fill(S_HOME);
      this.aLeg.fill(0);
      this.aLegN.fill(0);
      this.aLegs.fill(0);
      this.aTripStart.fill(0);
      this.aWaitStart.fill(0);
      this.aPlat.fill(-1);
      this.aCrowd.fill(0);
      this.aLeft.fill(0);
      this.aPM.fill(0);
      this.aBoarded.fill(0);
    } else {
      const room = cap + Math.ceil(A * 0.02);
      this.aMode = new Uint8Array(room);
      this.aState = new Uint8Array(room);
      this.aLeg = new Uint8Array(room);
      this.aLegN = new Uint8Array(room);
      this.aLegs = new Int32Array(room * MAX_LEGS * 3);
      this.aTripStart = new Float64Array(room);
      this.aWaitStart = new Float64Array(room);
      this.aPlat = new Int32Array(room).fill(-1);
      this.aCrowd = new Float32Array(room);
      this.aLeft = new Uint8Array(room);
      this.aPM = new Uint8Array(room);
      this.aBoarded = new Uint8Array(room);
    }
    const aBand = (this.aBand = new Uint8Array(cap));
    const aPeak = (this.aPeak = new Uint8Array(cap));
    const peakFrac = (this.gPeakFrac = new Float32Array(G));
    const gHome = this.gHome, gWork = this.gWork, gBand = this.gBand, gStart = this.gStart, gCount = this.gCount;
    const hashed = this.hashed;
    const seed = this.seed;
    const gen = hashed ? new Rng(1) : tbl.gen;
    const old = carry && carry.old.placed > 0 ? carry.old : null;
    const placed = old ? old.placed : 0;
    const exact = carry ? carry.exact : null;
    const out: AgentPlacement = { aHx, aHy, aWx, aWy, aDepart, aReturn };
    // Kept groups whose count did not change (nearly all): their agents are copied in bulk.
    const done = new Uint8Array(G);
    if (old && exact) {
      forExactRuns(
        exact,
        (g0, o0, run) => {
          // (Only old groups with per-agent placements: a partly pre-placed starting city places the rest below.)
          if (o0 >= placed) return;
          const len = Math.min(run, placed - o0);
          const s0 = gStart[g0], os = old.start[o0], oe = old.start[o0 + len];
          aHx.set(old.aHx.subarray(os, oe), s0);
          aHy.set(old.aHy.subarray(os, oe), s0);
          aWx.set(old.aWx.subarray(os, oe), s0);
          aWy.set(old.aWy.subarray(os, oe), s0);
          aDepart.set(old.aDepart.subarray(os, oe), s0);
          aReturn.set(old.aReturn.subarray(os, oe), s0);
          aBand.set(old.aBand.subarray(os, oe), s0);
          aPeak.set(old.aPeak.subarray(os, oe), s0);
          peakFrac.set(old.peakFrac.subarray(o0, o0 + len), g0);
          for (let g = g0; g < g0 + len; g++) {
            done[g] = 1;
            for (let a = gStart[g]; a < gStart[g + 1]; a++) aGroup[a] = g;
          }
        },
        { now: gCount, old: old.count },
      );
    }
    for (let g = 0; g < G; g++) {
      if (done[g]) continue;
      const hi = gHome[g], wi = gWork[g], b = gBand[g];
      const h = tr[hi], w = tr[wi];
      const s = gStart[g], n = gCount[g];
      let kept = 0;
      const o = old && exact ? exact[g] : -1;
      if (old && o >= 0 && o < placed) {
        // Most groups hold one or two agents: a plain loop beats subarray views here.
        kept = Math.min(n, old.count[o]);
        const d = old.start[o] - s;
        for (let a = s; a < s + kept; a++) {
          aHx[a] = old.aHx[a + d];
          aHy[a] = old.aHy[a + d];
          aWx[a] = old.aWx[a + d];
          aWy[a] = old.aWy[a + d];
          aDepart[a] = old.aDepart[a + d];
          aReturn[a] = old.aReturn[a + d];
        }
      }
      let peak = 0;
      for (let k = 0; k < n; k++) {
        const a = s + k;
        aGroup[a] = g;
        aBand[a] = b;
        if (k >= kept) {
          if (hashed) gen.reseed(hash32x4(seed, hi * 3 + b, wi, k));
          drawAgent(gen, h, w, a, out);
        }
        // Fare periods of the two trips (from the stored values; no extra draws).
        const pk = peakBits(aDepart[a], aReturn[a]);
        aPeak[a] = pk;
        peak += ((pk & 1) + (pk >> 1)) / 2;
      }
      peakFrac[g] = peak / Math.max(1, n);
    }
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
    return expectedFare(this.fares, this.gBand[g], this.gPeakFrac[g]) * this.gFareMult[g];
  }

  setTrains(getter: () => Train[]): void {
    this.trains = getter;
  }

  modeState(): ModeState {
    return { key: this.key, shares: this.shares.slice(), obsTime: this.obsTime.slice(), obsCrowd: this.obsCrowd.slice() };
  }

  // ------------------------------------------------------------------ Living City regeneration
  /**
   * Regenerate the groups and agents from the grown OD (docs/v2/living-city.md §3.4), normally
   * at the month-end midnight. Trips are reset first (agent indices change; anyone still out is
   * counted as stuck, as at 3 am), and the event pool's agents go (today's event tallies stay for
   * the wrap-ups). Groups are matched to the old ones by (home, work, band):
   * - kept groups carry their shares, observations, paths, geometry and no-subway costs over;
   * - a new band of a known pair copies the pair's geometry and paths;
   * - a new pair is searched (recomputePaths(only)).
   * New groups start at their logit target with the timetable's transit time (clear weather).
   * Agents: the first regeneration re-places every agent with per-agent seeds (a one-time
   * change from v1's sequential stream; the groups prePlace has done ahead are copied from its
   * side arrays); later ones copy kept groups' agents exactly. Either way
   * the result equals `new Commuters(world, { factors })` group for group and agent for agent.
   * Mid-day (tests, scripts) the rest of the day is scheduled again (startDay).
   */
  regenerate(factors: OdFactors, t: number): RegenStats {
    // Commuter stories: who is traced (agent indices change below), found again at the end.
    const traced = this.traceA >= 0 ? this.storyWho(this.traceA) : null;
    const stuck = this.resetTrips(t);
    this.day.stuck += stuck;
    // The pool's agents are indexed past A, which changes: they go now (as at 3 am). Today's
    // events and tallies stay, for wrap-ups still due.
    this.evUsed = 0;
    this.evGroups = [];
    const T = this.world.tracts.length;
    // The starting city's agents get per-agent placements now: the ones pre-placed ahead are copied.
    const pre = this.hashed ? null : this.pre;
    this.pre = null;
    const old: OldGroups = {
      G: this.G,
      keys: groupKeys(this.gHome, this.gWork, this.gBand, this.G, T),
      sorted: this.gSorted,
      count: this.gCount,
      start: this.gStart,
      geom: this.gGeom,
      walk: this.gWalk,
      drive: this.gDrive,
      driveHome: this.gDriveHome,
      lsBase: this.lsBase(),
      baseT: this.gBaseT,
      shares: this.shares,
      obsTime: this.obsTime,
      obsCrowd: this.obsCrowd,
      pathAM: this.pathAM,
      pathPM: this.pathPM,
      hashed: this.hashed,
      placed: this.hashed ? this.G : pre ? pre.done : 0,
      aHx: pre ? pre.aHx : this.aHx,
      aHy: pre ? pre.aHy : this.aHy,
      aWx: pre ? pre.aWx : this.aWx,
      aWy: pre ? pre.aWy : this.aWy,
      aDepart: pre ? pre.aDepart : this.aDepart,
      aReturn: pre ? pre.aReturn : this.aReturn,
      aBand: this.aBand,
      aPeak: pre ? pre.aPeak : this.aPeak,
      peakFrac: pre ? pre.peakFrac : this.gPeakFrac,
    };
    const tbl = buildGroups(this.world.od, T, this.scale, this.seed, factors, this.G);
    const m = matchGroups(old.keys, groupKeys(tbl.home, tbl.work, tbl.band, tbl.G, T), old.sorted && tbl.sorted);
    const carry: Carry = { old, exact: m.exact, pair: m.pair };
    this.adoptGroups(tbl, carry);
    const replaced = !old.hashed;
    this.hashed = true;
    this.buildAgents(tbl, carry);
    const G = this.G;
    // Per-group state: carried over or fresh.
    const shares = this.shares; // adoptGroups filled the no-subway shares of the groups it computed
    this.obsTime = new Float32Array(G);
    this.obsCrowd = new Float32Array(G);
    this.todayTimeSum = new Float32Array(G);
    this.todayTimeN = new Uint16Array(G);
    this.todayCrowdSum = new Float32Array(G);
    this.pathAM = new Array(G).fill(null);
    this.pathPM = new Array(G).fill(null);
    const fresh: number[] = [];
    const need: number[] = [];
    let kept = 0, newBands = 0;
    forExactRuns(m.exact, (g0, o0, len) => {
      shares.set(old.shares.subarray(o0 * 3, (o0 + len) * 3), g0 * 3);
      this.obsTime.set(old.obsTime.subarray(o0, o0 + len), g0);
      this.obsCrowd.set(old.obsCrowd.subarray(o0, o0 + len), g0);
      for (let k = 0; k < len; k++) {
        this.pathAM[g0 + k] = old.pathAM[o0 + k] ?? null;
        this.pathPM[g0 + k] = old.pathPM[o0 + k] ?? null;
      }
      kept += len;
    });
    for (let g = 0; g < G; g++) {
      if (m.exact[g] >= 0) continue;
      fresh.push(g);
      const p = m.pair[g];
      if (p >= 0) {
        this.pathAM[g] = old.pathAM[p] ?? null;
        this.pathPM[g] = old.pathPM[p] ?? null;
        newBands++;
      } else need.push(g);
    }
    this.key = makeKey(this.world, this.scale, this.seed, this.A, G, factors.tag);
    // New pairs get their paths; everyone's unserved demand is recounted.
    this.recomputePaths(need);
    // People who move next to a station know about it: new groups start at their logit target.
    for (const g of fresh) {
      const p = logitShares(generalisedCosts(this.gGeom[g], this.gBand[g], this.transitInput(g)));
      shares[g * 3] = p[0];
      shares[g * 3 + 1] = p[1];
      shares[g * 3 + 2] = p[2];
    }
    if (this.daily) this.daily.resize(this.aState.length);
    if (traced) this.retrace(traced, t);
    this.startDay(t);
    return { groups: G, agents: this.A, kept, newBands, newPairs: need.length, dropped: old.G - kept, stuck, replaced };
  }

  /** Living City: event-goers' origin weights per tract (current residents); null for tracts.json's. */
  setOriginWeights(w: ArrayLike<number> | null): void {
    this.originWeights = w;
  }

  /**
   * Living City, ahead of the first growth: give up to about `budget` more of the starting city's
   * agents their per-agent placements (whole groups, in group order) in side arrays the sim never
   * reads, so the first regeneration copies them (docs/v2/living-city.md, amendment 3: the one-time
   * re-placement) instead of placing ≈ 285k agents at the month-end midnight. True when every
   * group is done (or the city is already hashed). The engine calls it each step while growth is on.
   */
  prePlace(budget: number): boolean {
    if (this.hashed) return true;
    const G = this.G, A = this.A;
    let p = this.pre;
    if (!p) {
      p = this.pre = {
        done: 0,
        aHx: new Float32Array(A),
        aHy: new Float32Array(A),
        aWx: new Float32Array(A),
        aWy: new Float32Array(A),
        aDepart: new Float32Array(A),
        aReturn: new Float32Array(A),
        aPeak: new Uint8Array(A),
        peakFrac: new Float32Array(G),
      };
    }
    const tr = this.world.tracts;
    const gen = this.preGen;
    const { gHome, gWork, gBand, gStart, gCount, seed } = this;
    let used = 0;
    while (p.done < G && used < budget) {
      const g = p.done;
      const hi = gHome[g], wi = gWork[g], b = gBand[g];
      const s = gStart[g], n = gCount[g];
      let peak = 0;
      for (let k = 0; k < n; k++) {
        const a = s + k;
        gen.reseed(hash32x4(seed, hi * 3 + b, wi, k));
        drawAgent(gen, tr[hi], tr[wi], a, p);
        const pk = peakBits(p.aDepart[a], p.aReturn[a]);
        p.aPeak[a] = pk;
        peak += ((pk & 1) + (pk >> 1)) / 2;
      }
      p.peakFrac[g] = peak / Math.max(1, n);
      used += n;
      p.done++;
    }
    return p.done >= G;
  }

  /** How far prePlace has got: groups placed ahead, of G (tests). */
  prePlaced(): number {
    return this.hashed ? this.G : this.pre?.done ?? 0;
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
    this.xp = this.graph && hasExpressService(net) ? buildExpressBoarding(net, this.graph) : null;
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
        if (np < 0) this.finishByCab(a, t, 'network');
        else this.enqueue(a, np);
      }
    }
    this.recomputePaths();
    this.last.netVersion = net.version;
    // Commuter stories: the traced commuter's plan on the new network.
    if (this.traceA >= 0) this.tracer!.setPlan(this.storyPlan(this.traceA, t));
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

  /**
   * For each origin tract, one Dijkstra to every destination (AM home→work, PM work→home).
   * With `only` (Living City regeneration: groups of new pairs), the existing paths are kept and
   * only those groups are searched, from the access lists of the last full search (the network
   * has not changed); the timed-trip goal and the observations stay as they are. Unserved demand
   * is recomputed for every group either way.
   */
  recomputePaths(only?: ArrayLike<number>): void {
    const G = this.G;
    const subset = only !== undefined;
    const oldAM = this.pathAM;
    if (!subset) {
      this.pathAM = new Array(G).fill(null);
      this.pathPM = new Array(G).fill(null);
      this.goalTrip = null;
      this.access = [];
    }
    this.unserved.fill(0);
    const graph = this.graph;
    const net = this.net;
    if (graph && net && (!subset || (only.length > 0 && this.access.length === this.world.tracts.length))) {
      if (!subset) this.cb.busy?.('Updating routes');
      const t0 = Date.now();
      const tracts = this.world.tracts;
      // Stations within walking distance of each tract.
      const access: { station: number; walk: number }[][] = subset
        ? this.access
        : tracts.map((tr) => {
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
      const n = subset ? only.length : G;
      for (let i = 0; i < n; i++) {
        const g = subset ? only[i] : i;
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
      if (!subset) {
        const fromAcc = pointAccess(GOALS.tripFrom), toAcc = pointAccess(GOALS.tripTo);
        if (fromAcc.length && toAcc.length) {
          graph.run(fromAcc);
          const p = this.bestPath(graph, toAcc);
          this.goalTrip = p ? p.time / 60 : null;
        }
      }
      graph.setPeriod(3); // PM peak
      for (const [w, groups] of byWork) solve(w, groups, (g) => this.gHome[g], this.pathPM);
      graph.setPeriod(1);
      const ms = Date.now() - t0;
      this.lastPathMs = ms;
      if (!subset) this.cb.busy?.(null);
    }
    // Observed times describe the old network; drop them where the trip changed.
    if (!subset) {
      for (let g = 0; g < G; g++) {
        const o = oldAM[g], n = this.pathAM[g];
        // (Keep restored observations on the first network after loading a save.)
        if (!n || (o && Math.abs(o.time - n.time) > 0.05 * o.time)) {
          this.obsTime[g] = 0;
          this.obsCrowd[g] = 0;
        }
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
      // Four-track sections (v2): a transfer across a cross-platform pair counts (and was charged)
      // QUAD.crossPlatformPenaltyFactor of one; without pairs this is legs.length − 1 exactly.
      const transfers = effectiveTransfers(net, legs);
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
      const transit = this.transitInput(g);
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

  /**
   * The transit alternative as a group's mode choice sees it (null: no AM or PM path): yesterday's
   * observed door-to-door time (the timetable if nobody from the group rode), transfers, crowding
   * and the group's expected fare (band and peak share, fare policy v2).
   */
  private transitInput(g: number, out?: TransitCostInput): TransitCostInput | null {
    const am = this.pathAM[g], pm = this.pathPM[g];
    if (!am || !pm) return null;
    const sched = (am.time + pm.time) / 2;
    // Observed times include waits and crowding delays; blend toward schedule if stale.
    const time = this.obsTime[g] > 0 ? this.obsTime[g] : sched;
    const transfers = (am.transfers + pm.transfers) / 2, crowdMinutes = this.obsCrowd[g], fare = this.groupFare(g);
    if (!out) return { time, transfers, crowdMinutes, fare };
    // (Filled in place by loops over every group that only read it: no allocation per group.)
    out.time = time;
    out.transfers = transfers;
    out.crowdMinutes = crowdMinutes;
    out.fare = fare;
    return out;
  }

  /**
   * Living City: no-network logsum of each group (walk and drive on a clear day, minutes), set with
   * the groups. Whoever replaces the groups (regeneration) must set it again or null it (then it is
   * recomputed on the next use).
   */
  private gLsBase: Float32Array | null = null;

  private lsBase(): Float32Array {
    if (this.gLsBase && this.gLsBase.length === this.G) return this.gLsBase;
    const ls = new Float32Array(this.G);
    for (let g = 0; g < this.G; g++) ls[g] = logsum(generalisedCosts(this.gGeom[g], this.gBand[g], null));
    return (this.gLsBase = ls);
  }

  /**
   * Living City commute benefit (docs/v2/living-city.md §3.2): per tract, the mean generalised
   * minutes per commute that the network saves the agents living there (home) and working there
   * (work) against no network, weighted by agents. The logit logsum difference of the mode choice
   * the sim runs: transit at exactly the cost mode choice uses (observed time, transfers, crowding,
   * the group's band and peak fare); walk and drive on a clear day, so weather, incidents and
   * closures act only through observed times. Read-only. Groups without a path contribute 0.
   */
  commuteBenefit(): { home: Float64Array; work: Float64Array; mean: number } {
    const T = this.world.tracts.length;
    const ls = this.lsBase();
    const hs = new Float64Array(T), hn = new Float64Array(T);
    const ws = new Float64Array(T), wn = new Float64Array(T);
    let sum = 0, n = 0;
    const scratch: TransitCostInput = { time: 0, transfers: 0, crowdMinutes: 0, fare: 0 };
    for (let g = 0; g < this.G; g++) {
      const c = this.gCount[g];
      const t = this.transitInput(g, scratch);
      const b = t ? transitBenefit(ls[g], transitCost(t, this.gBand[g])) : 0;
      const h = this.gHome[g], w = this.gWork[g];
      hs[h] += c * b;
      hn[h] += c;
      ws[w] += c * b;
      wn[w] += c;
      sum += c * b;
      n += c;
    }
    for (let i = 0; i < T; i++) {
      hs[i] = hn[i] > 0 ? hs[i] / hn[i] : 0;
      ws[i] = wn[i] > 0 ? ws[i] / wn[i] : 0;
    }
    return { home: hs, work: ws, mean: n ? sum / n : 0 };
  }

  /** Everyone draws a mode from their pair's shares and their trips are scheduled. */
  private drawModesAndSchedule(dayStart: number, now: number): void {
    // Anyone still out from yesterday is sent home (counted as stuck); yesterday's event-goers
    // are removed (the pool empties).
    this.day.stuck += this.resetTrips(now);
    this.resetEventPool();
    // Commuter stories: an event-goer's day is over (the pool's agents are drawn again).
    if (this.traceA >= this.A) this.untrace('eventOver');
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
        for (let k = 0; k < 3; k++) mult[k] = fareOddsMultiplier(tripFare(this.fares, band, k) * this.gFareMult[g] - gf, band);
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
    // Commuter stories: the traced commuter's new day (today's mode and plan).
    if (this.traceA >= 0) this.tracer!.newDay(now, this.storyPlan(this.traceA, now));
  }

  /**
   * Nobody is travelling any more: every commuter and event-goer is at home with no platform,
   * train buckets and loads are emptied, the platform queues and the event heap are cleared.
   * Returns how many were mid-trip (stuck). Shared by the 3 am plan and regeneration, since
   * either can change agent indices or plans.
   */
  private resetTrips(t: number): number {
    let stuck = 0;
    const ta = this.traceA;
    if (ta >= 0) {
      const s = this.aState[ta];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) this.tracer!.add({ k: 'stuck', t });
    }
    for (let a = 0; a < this.A + this.evUsed; a++) {
      const s = this.aState[a];
      if (s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS) stuck++;
      this.aState[a] = S_HOME;
      this.aPlat[a] = -1;
    }
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
    return stuck;
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
            if (a === this.traceA) this.tracer!.add({ k: 'giveup', t: et, station: this.platStationId(this.aPlat[a]), waited: et - this.aWaitStart[a] });
            this.leaveQueue(a);
            this.day.gaveUp++;
            if (a >= this.A) this.evTally[this.evGroups[this.aGroup[a]].ev].gaveUp += this.scale;
            this.finishByCab(a, et, 'giveup');
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
    if (this.daily) this.daily.crossed[a] = 0;
    if (!path) {
      // Lost their transit option (network changed): drive today.
      const dt = this.driveTime(g, pm);
      if (a === this.traceA) this.tracer!.add({ k: 'drive', t, t1: t + dt, pm });
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
      this.finishByCab(a, t, 'gone');
      return;
    }
    const x = pm ? this.aWx[a] : this.aHx[a];
    const y = pm ? this.aWy[a] : this.aHy[a];
    const walk = (Math.hypot(st.x - x, st.y - y) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
    this.aState[a] = S_WALK;
    if (a === this.traceA) this.tracer!.add({ k: 'walk', t, t1: t + walk, why: 'access', from: [x, y], to: [st.x, st.y], station: st.id, pm });
    this.push(t + walk, a, E_PLATFORM);
  }

  private arrivePlatform(a: number, t: number): void {
    const p = this.platformFor(a);
    if (p < 0) {
      this.finishByCab(a, t, 'gone');
      return;
    }
    const cu = this.closedUntil;
    if (cu.length) {
      const until = cu[this.graph!.platStation[p]];
      if (until > t) {
        this.closedAt(a, until, t, this.graph!.platStation[p]);
        return;
      }
    }
    this.aWaitStart[a] = t;
    this.enqueue(a, p);
    if (a === this.traceA) this.tracer!.add(this.waitEvent(p, t));
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
    const ta = this.traceA;
    for (const a of off) {
      this.aLeg[a]++;
      if (a === ta) this.tracer!.add({ k: 'alight', t, station: station.id, route: route.id, train: train.id });
      if (this.aLeg[a] < this.aLegN[a]) {
        // Transfer: walk to the next platform.
        const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
        const ni = this.stationById.get(this.aLegs[o + 1]) ?? -1;
        const nextSt = net.stations[ni];
        let walk: number;
        const across = !!nextSt && station.pair === ni;
        if (nextSt && station.pair === ni) {
          // Four-track sections (v2): a step across the island platform to the partner.
          walk = QUAD.crossPlatformTransfer;
          const key = Math.min(station.id, nextSt.id);
          this.day.crossTransfers.set(key, (this.day.crossTransfers.get(key) ?? 0) + 1);
          if (this.daily) this.daily.crossed[a] = 1;
        } else walk = nextSt ? (Math.hypot(nextSt.x - station.x, nextSt.y - station.y) / (1.2 * this.wx.walkSpeed) + 60) : 60;
        this.aState[a] = S_WALK;
        if (a === ta) this.tracer!.add({ k: 'walk', t, t1: t + walk, why: across ? 'across' : 'transfer', from: [station.x, station.y], to: nextSt ? [nextSt.x, nextSt.y] : [station.x, station.y], station: nextSt?.id ?? -1, pm: this.aPM[a] === 1 });
        this.push(t + walk, a, E_PLATFORM);
      } else {
        const x = this.aPM[a] ? this.aHx[a] : this.aWx[a];
        const y = this.aPM[a] ? this.aHy[a] : this.aWy[a];
        const walk = (Math.hypot(station.x - x, station.y - y) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
        this.aState[a] = S_EGRESS;
        if (a === ta) this.tracer!.add({ k: 'walk', t, t1: t + walk, why: 'egress', from: [station.x, station.y], to: [x, y], station: -1, pm: this.aPM[a] === 1 });
        this.push(t + walk, a, E_ARRIVE);
      }
    }
    train.load -= off.length;
    // Express service: riders on board step across a cross-platform pair to a faster train.
    if (this.xp?.pairs) this.crossPlatform(train, route, stopIdx, t);
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
    const net = this.net!;
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
    const ta = this.traceA, daily = this.daily;
    let boarded = 0;
    while (head < q.length && train.load < capAgents) {
      const a = q[head++];
      if (this.aState[a] !== S_WAIT || this.aPlat[a] !== p) continue;
      const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
      const k = stops.get(this.aLegs[o + 2]);
      if (k === undefined || k <= stopIdx) {
        // Can't ride to the stop they want any more.
        this.leaveQueue(a);
        this.finishByCab(a, t, 'cantRide');
        continue;
      }
      this.leaveQueue(a);
      this.aState[a] = S_RIDE;
      // One fare per journey, at the fare in force when it first boards (transfers are free), for
      // the rider's band and the period of that boarding.
      const first = !this.aBoarded[a];
      if (first) {
        const cell = this.aBand[a] * 2 + peak;
        const f = ft[cell] * (a < this.A ? this.gFareMult[this.aGroup[a]] : 1);
        day.fareRevenue += f;
        day.fareCellTrips[cell]++;
        day.fareCellRevenue[cell] += f;
      }
      this.aBoarded[a] = 1;
      if (a >= this.A) this.day.eventBoard++;
      (train.buckets[k] ??= []).push(a);
      train.load++;
      boarded++;
      if (a === ta) this.traceBoard(a, train, route, stationIdx, k, t, first ? ft[this.aBand[a] * 2 + peak] * (a < this.A ? this.gFareMult[this.aGroup[a]] : 1) : 0, false);
      if (daily && a < this.A && t - this.aWaitStart[a] > daily.waitBest) daily.offerWait(a, t - this.aWaitStart[a], t, net.stations[stationIdx].id, route.id, this.aLeft[a] === 1);
      // Crowding experienced on this ride (load after boarding vs comfortable capacity).
      const ride = dir.schedArrive[k] - dir.schedArrive[stopIdx];
      this.aCrowd[a] += (ride / 60) * COMMUTERS.crowdingWeight * Math.max(0, (train.load * this.scale) / route.capComfort - 1) * this.wx.crowd;
      this.day.routeBoard.set(route.id, (this.day.routeBoard.get(route.id) ?? 0) + 1);
      const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
      this.stationHourly[stationIdx * 24 + hour] += this.scale;
    }
    // Express service: riders waiting for another route here board too when this train gets them
    // there about as soon ("first train of either").
    if (this.xp && train.load < capAgents) boarded += this.boardSiblings(train, route, stopIdx, t, !countLeft, capAgents, peak);
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
        if (ta >= 0 && this.aState[ta] === S_WAIT && this.aPlat[ta] === p) this.tracer!.add({ k: 'left', t, station: net.stations[stationIdx].id, route: route.id });
      }
    }
    return boarded;
  }

  /**
   * Express service (v2), common lines: riders waiting on the platforms of other routes at this
   * station complex (the same station, or across the island at a cross-platform pair, only while
   * the train has just arrived) board this train when it calls at their stop's complex later and
   * its scheduled ride there is no longer than their own route's plus the wait for it (half its
   * headway): a local takes riders the express would have, for a short hop, and the express takes
   * the local's riders bound for a stop both serve. Returns how many boarded.
   */
  private boardSiblings(train: Train, route: CRoute, stopIdx: number, t: number, atArrival: boolean, capAgents: number, peak: number): number {
    const xp = this.xp!, graph = this.graph!, net = this.net!;
    const p = graph.base[train.route][train.dir] + stopIdx;
    const dir = route.dirs[train.dir];
    const cst = xp.cstop[train.route][train.dir];
    const here = dir.stopStation[stopIdx];
    const period = periodIndex(t);
    const ft = this.fareTable, day = this.day;
    const ta = this.traceA, daily = this.daily;
    let boarded = 0;
    for (const list of atArrival ? [xp.sibSame[p], xp.sibAcross[p]] : [xp.sibSame[p]]) {
      if (!list) continue;
      for (const q of list) {
        if (train.load >= capAgents) return boarded;
        if (this.qLive[q] <= 0) continue;
        const rq = net.routes[graph.platRoute[q]];
        const dq = rq.dirs[graph.platDir[q]];
        const kq = graph.platStop[q];
        const stopsQ = this.stopIndex[graph.platRoute[q]][graph.platDir[q]];
        const hw = rq.headways[period];
        const wait = hw > 0 ? Math.min(COMMUTERS.waitCap, hw / 2) : COMMUTERS.waitCap;
        const queue = this.queues[q];
        for (let i = this.qHead[q]; i < queue.length && train.load < capAgents; i++) {
          const a = queue[i];
          if (this.aState[a] !== S_WAIT || this.aPlat[a] !== q) continue;
          const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
          const want = this.aLegs[o + 2];
          const ka = stopsQ.get(want);
          const si = this.stationById.get(want);
          if (ka === undefined || ka <= kq || si === undefined) continue;
          const k = cst.get(xp.complex[si]);
          if (k === undefined || k <= stopIdx) continue;
          if (dir.schedArrive[k] - dir.schedArrive[stopIdx] > dq.schedArrive[ka] - dq.schedArrive[kq] + wait) continue;
          this.leaveQueue(a);
          this.aState[a] = S_RIDE;
          const first = !this.aBoarded[a];
          if (first) {
            const cell = this.aBand[a] * 2 + peak;
            const f = ft[cell] * (a < this.A ? this.gFareMult[this.aGroup[a]] : 1);
            day.fareRevenue += f;
            day.fareCellTrips[cell]++;
            day.fareCellRevenue[cell] += f;
          }
          this.aBoarded[a] = 1;
          if (a >= this.A) day.eventBoard++;
          // The leg now rides this route, to its call at that complex.
          this.aLegs[o] = route.id;
          this.aLegs[o + 2] = net.stations[dir.stopStation[k]].id;
          (train.buckets[k] ??= []).push(a);
          train.load++;
          boarded++;
          if (a === ta) this.traceBoard(a, train, route, here, k, t, first ? ft[this.aBand[a] * 2 + peak] * (a < this.A ? this.gFareMult[this.aGroup[a]] : 1) : 0, true);
          if (daily && a < this.A && t - this.aWaitStart[a] > daily.waitBest) daily.offerWait(a, t - this.aWaitStart[a], t, net.stations[here].id, route.id, this.aLeft[a] === 1);
          const ride = dir.schedArrive[k] - dir.schedArrive[stopIdx];
          this.aCrowd[a] += (ride / 60) * COMMUTERS.crowdingWeight * Math.max(0, (train.load * this.scale) / route.capComfort - 1) * this.wx.crowd;
          day.routeBoard.set(route.id, (day.routeBoard.get(route.id) ?? 0) + 1);
          const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
          this.stationHourly[here * 24 + hour] += this.scale;
        }
      }
    }
    return boarded;
  }

  /**
   * Express service (v2), across the platform: a train has just called at one platform of a
   * cross-platform pair while another route's train dwells at the other (long enough to step
   * across). Riders on either who are bound for a station complex the other train reaches sooner
   * by its timetable, by more than the step across and QUAD.switchGain, change trains: the local's
   * riders to the express that caught it up, and back where a local is the quicker way. With no
   * express in yet, a local's riders step across to wait for the soonest one due (waitAcross).
   */
  private crossPlatform(train: Train, route: CRoute, stopIdx: number, t: number): void {
    const net = this.net!;
    const ps = net.stations[route.dirs[train.dir].stopStation[stopIdx]].pair;
    if (ps === undefined || ps < 0) return;
    /** The soonest express due at the other platform (not dwelling there yet), for this train's riders. */
    let due: { x: Train; rx: CRoute; kx: number; eta: number } | null = null;
    for (const x of this.trains()) {
      if (x === train || x.route === train.route) continue;
      if (x.state === TState.Dwelling && x.until - t >= QUAD.crossPlatformTransfer) {
        const rx = net.routes[x.route];
        if (rx && rx.dirs[x.dir].stopStation[x.stop] === ps) {
          this.switchTrains(train, route, stopIdx, x, rx, x.stop, t);
          this.switchTrains(x, rx, x.stop, train, route, stopIdx, t);
          continue;
        }
      }
      if (route.express || (x.state !== TState.Running && x.state !== TState.Dwelling)) continue;
      const rx = net.routes[x.route];
      if (!rx?.express) continue;
      const dx = rx.dirs[x.dir];
      const kx = this.xp!.cstop[x.route][x.dir].get(this.xp!.complex[ps]);
      if (kx === undefined || kx < x.stop || (kx === x.stop && x.state === TState.Dwelling) || dx.stopStation[kx] !== ps) continue;
      const eta = t + timeToStop(x, dx, kx, t);
      if (eta < t + QUAD.crossPlatformTransfer || eta > t + QUAD.crossPlatformWaitMax || (due && eta >= due.eta)) continue;
      due = { x, rx, kx, eta };
    }
    if (due) this.waitAcross(train, route, stopIdx, due, t);
  }

  /**
   * Express service (v2), across the platform: riders on a local just in at a cross-platform station
   * step across and wait for an express due at the other platform shortly (by its timetable from
   * where it is now) when it still gets them to their stop's station complex sooner, by more than
   * QUAD.switchGain, than staying on: the change the station's countdown invites. They queue there
   * like anyone else (a full express leaves them behind) and their leg rides the express.
   */
  private waitAcross(f: Train, rf: CRoute, kf: number, due: { x: Train; rx: CRoute; kx: number; eta: number }, t: number): void {
    const xp = this.xp!, net = this.net!;
    const df = rf.dirs[f.dir], dx = due.rx.dirs[due.x.dir];
    const cst = xp.cstop[due.x.route][due.x.dir];
    const wait = due.eta - t;
    const across = net.stations[dx.stopStation[due.kx]].id;
    const key = Math.min(across, net.stations[df.stopStation[kf]].id);
    for (let k = kf + 1; k < df.stopStation.length; k++) {
      const b = f.buckets[k];
      if (!b || !b.length) continue;
      const kx = cst.get(xp.complex[df.stopStation[k]]);
      if (kx === undefined || kx <= due.kx) continue;
      const rideF = df.schedArrive[k] - df.schedArrive[kf];
      if (wait + dx.schedArrive[kx] - dx.schedArrive[due.kx] + QUAD.switchGain >= rideF) continue;
      const alight = net.stations[dx.stopStation[kx]].id;
      // Crowding: the rest of the ride is no longer on this train (the express adds its own at boarding).
      const was = (rideF / 60) * COMMUTERS.crowdingWeight * Math.max(0, (f.load * this.scale) / rf.capComfort - 1) * this.wx.crowd;
      for (const a of b) {
        this.aCrowd[a] = Math.max(0, this.aCrowd[a] - was);
        const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
        this.aLegs[o] = due.rx.id;
        this.aLegs[o + 1] = across;
        this.aLegs[o + 2] = alight;
        this.aState[a] = S_WALK;
        if (this.daily) this.daily.crossed[a] = 1;
        if (a === this.traceA) this.traceAcross(f, rf, kf, due.rx.id, dx.stopStation[due.kx], due.eta, t);
        this.push(t + QUAD.crossPlatformTransfer, a, E_PLATFORM);
      }
      f.load -= b.length;
      this.day.crossTransfers.set(key, (this.day.crossTransfers.get(key) ?? 0) + b.length);
      f.buckets[k] = [];
    }
  }

  /** Move riders from train f (at stop kf) to train g (at stop kg) across a pair, where g gets them there sooner. */
  private switchTrains(f: Train, rf: CRoute, kf: number, g: Train, rg: CRoute, kg: number, t: number): void {
    const xp = this.xp!, net = this.net!;
    const df = rf.dirs[f.dir], dg = rg.dirs[g.dir];
    const cst = xp.cstop[g.route][g.dir];
    const cap = Math.floor(rg.capCrush / this.scale);
    const gain = QUAD.crossPlatformTransfer + QUAD.switchGain;
    const fromId = net.stations[df.stopStation[kf]].id, toId = net.stations[dg.stopStation[kg]].id;
    const key = Math.min(fromId, toId);
    const hour = Math.floor((t % SECONDS_PER_DAY) / 3600);
    for (let k = kf + 1; k < df.stopStation.length && g.load < cap; k++) {
      const b = f.buckets[k];
      if (!b || !b.length) continue;
      const kx = cst.get(xp.complex[df.stopStation[k]]);
      if (kx === undefined || kx <= kg) continue;
      const rideF = df.schedArrive[k] - df.schedArrive[kf];
      const rideG = dg.schedArrive[kx] - dg.schedArrive[kg];
      if (rideG + gain >= rideF) continue;
      const n = Math.min(b.length, cap - g.load);
      const moved = b.splice(0, n);
      f.load -= n;
      const dest = (g.buckets[kx] ??= []);
      for (const a of moved) {
        dest.push(a);
        g.load++;
        // Crowding: the rest of the ride is on g now.
        const was = (rideF / 60) * COMMUTERS.crowdingWeight * Math.max(0, (f.load * this.scale) / rf.capComfort - 1) * this.wx.crowd;
        const now = (rideG / 60) * COMMUTERS.crowdingWeight * Math.max(0, (g.load * this.scale) / rg.capComfort - 1) * this.wx.crowd;
        this.aCrowd[a] = Math.max(0, this.aCrowd[a] - was) + now;
        const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
        this.aLegs[o] = rg.id;
        this.aLegs[o + 2] = net.stations[dg.stopStation[kx]].id;
        if (this.daily) this.daily.crossed[a] = 1;
        if (a === this.traceA) this.tracer!.add({ k: 'switch', t, station: toId, route: rg.id, train: g.id, alight: this.aLegs[o + 2] }, g);
      }
      this.day.crossTransfers.set(key, (this.day.crossTransfers.get(key) ?? 0) + n);
      this.day.routeBoard.set(rg.id, (this.day.routeBoard.get(rg.id) ?? 0) + n);
      this.stationHourly[dg.stopStation[kg] * 24 + hour] += n * this.scale;
    }
  }

  evacuate(train: Train, t: number): void {
    for (const b of train.buckets) for (const a of b) if (this.aState[a] === S_RIDE) this.finishByCab(a, t, 'evacuated');
    train.buckets = train.buckets.map(() => []);
    train.load = 0;
  }

  private finishByCab(a: number, t: number, why: CabWhy): void {
    const g = this.aGroup[a];
    const rest = (a >= this.A ? this.evGroups[g].drive : this.driveTime(g, this.aPM[a] === 1)) * 0.6;
    if (a === this.traceA) this.tracer!.add({ k: 'cab', t, t1: t + rest, why });
    this.recordTrip(a, t + rest, true);
  }

  private completeTrip(a: number, t: number): void {
    if (this.daily && this.aBoarded[a]) this.dailyTrip(a, t);
    this.recordTrip(a, t, true);
  }

  private recordTrip(a: number, tEnd: number, transit: boolean): void {
    if (a === this.traceA) this.tracer!.add({ k: 'arrive', t: tEnd, pm: this.aPM[a] === 1, dur: tEnd - this.aTripStart[a], boarded: this.aBoarded[a] === 1 });
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
    if (this.baselineStale && this.wxDay) this.setWeather(this.wxDay);
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
    // Living City: the network's commute benefit for the people living here (as commuteBenefit).
    const ls = this.lsBase();
    let benefitSum = 0;
    for (let g = 0; g < this.G; g++) {
      if (this.gHome[g] !== tract) continue;
      const c = this.gCount[g];
      n += c;
      const ti = this.transitInput(g);
      if (ti) benefitSum += c * transitBenefit(ls[g], transitCost(ti, this.gBand[g]));
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
      /** Minutes per commute the network saves residents (agent-weighted, as Living City measures it). */
      benefit: n ? benefitSum / n : 0,
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
    this.wxDay = { ...w };
    this.baselineStale = false;
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
        this.closedAt(a, until, t, si);
      }
      this.queues[p] = [];
      this.qHead[p] = 0;
    }
  }

  private closedAt(a: number, until: number, t: number, si: number): void {
    if (until - t <= CHAOS.police.waitOutside) {
      this.aState[a] = S_WALK;
      if (a === this.traceA) this.tracer!.add({ k: 'closed', t, station: this.net!.stations[si]?.id ?? -1, until: until + (a % 120), cab: false });
      this.push(until + (a % 120), a, E_PLATFORM);
    } else {
      this.day.diverted++;
      if (a === this.traceA) this.tracer!.add({ k: 'closed', t, station: this.net!.stations[si]?.id ?? -1, until, cab: true });
      this.finishByCab(a, t, 'closed');
    }
  }

  /** A train runs through a closed stop: riders for it stay on to the next stop and walk from there. */
  pass(train: Train, route: CRoute, stopIdx: number, t: number): void {
    const b = train.buckets[stopIdx];
    if (!b || !b.length) return;
    const next = (train.buckets[stopIdx + 1] ??= []);
    const ta = this.traceA;
    for (const a of b) {
      next.push(a);
      if (a === ta) this.tracer!.add({ k: 'past', t, station: this.net!.stations[route.dirs[train.dir].stopStation[stopIdx]].id });
    }
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
      const cdf = originCdf(tracts, vx, vy, EVENTS.originDecay, this.originWeights);
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

  /**
   * Four-track sections (v2): today's transfers across each cross-platform pair (real people, key =
   * the lower station id of the pair), read by the engine before the day closes.
   */
  crossTransfersToday(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [k, n] of this.day.crossTransfers) out[k] = n * this.scale;
    return out;
  }

  /** Today's chaos counters (real people), read by the engine before the day closes. */
  chaosStats(): { eventRiders: number; diverted: number; carriedPast: number } {
    const d = this.day;
    return { eventRiders: d.eventBoard * this.scale, diverted: d.diverted * this.scale, carriedPast: d.carriedPast * this.scale };
  }

  // ------------------------------------------------------------------ Commuter stories (v2)
  // Everything below only reads the sim's state (docs/v2/commuter-stories.md): no RNG draw, no
  // event scheduled, no field the sim reads is written. Picks use hashes of their salt.

  /** Who agent `a` is (a commuter by group identity, an event-goer by today's event). */
  storyWho(a: number): StoryWho {
    if (a >= this.A) {
      const eg = this.evGroups[this.aGroup[a]];
      const ev = this.evEvents[eg.ev];
      const k = a - this.A;
      return {
        home: eg.tract,
        work: -1,
        band: this.aBand[a],
        k,
        nameSeed: hash32x4(this.seed ^ 0x51ed, ev.id, eg.tract * 3 + this.aBand[a], k),
        event: { id: ev.id, label: ev.label, venue: ev.venue, start: this.evDayStart + ev.start, end: this.evDayStart + ev.end },
      };
    }
    const g = this.aGroup[a];
    const h = this.gHome[g], w = this.gWork[g], b = this.gBand[g], k = a - this.gStart[g];
    return { home: h, work: w, band: b, k, nameSeed: hash32x4(this.seed ^ 0x570e, h * 3 + b, w, k) };
  }

  /** The commuter with this identity now (−1: their group is gone or smaller; event-goers are never found again). */
  findAgent(who: StoryWho): number {
    if (who.event || who.work < 0) return -1;
    for (let g = 0; g < this.G; g++) {
      if (this.gHome[g] !== who.home || this.gWork[g] !== who.work || this.gBand[g] !== who.band) continue;
      return who.k < this.gCount[g] ? this.gStart[g] + who.k : -1;
    }
    return -1;
  }

  /** Living City regeneration: trace the same commuter again (a new index), or end the story. */
  private retrace(who: StoryWho, t: number): void {
    const a = this.findAgent(who);
    if (a < 0) {
      this.untrace(who.event ? 'eventOver' : 'moved');
      return;
    }
    this.traceA = a;
    this.tracer!.add({ k: 'regen', t });
    this.tracer!.setPlan(this.storyPlan(a, t));
  }

  /** The traced agent is gone: the story ends (the tracer keeps what it recorded). */
  private untrace(why: 'moved' | 'eventOver'): void {
    this.traceA = -1;
    this.tracer?.ended(why);
  }

  /** Station id of platform p (−1 without a network). */
  private platStationId(p: number): number {
    const g = this.graph;
    return g && p >= 0 && p < g.P ? this.net!.stations[g.platStation[p]].id : -1;
  }

  /** The 'wait' event for platform p: its station, route and terminal. */
  private waitEvent(p: number, t: number, joined = false): TraceEvent {
    const g = this.graph!, net = this.net!;
    const r = net.routes[g.platRoute[p]];
    const dir = r.dirs[g.platDir[p]];
    const e: TraceEvent = { k: 'wait', t, station: net.stations[g.platStation[p]].id, route: r.id, towards: net.stations[dir.stopStation[dir.stopStation.length - 1]].id };
    if (joined) e.j = true;
    return e;
  }

  private traceBoard(a: number, train: Train, route: CRoute, stationIdx: number, k: number, t: number, fare: number, either: boolean, joined = false): void {
    const net = this.net!;
    const e: TraceEvent = {
      k: 'board',
      t,
      train: train.id,
      route: route.id,
      station: net.stations[stationIdx].id,
      alight: net.stations[route.dirs[train.dir].stopStation[k]].id,
      fare,
      load: train.load * this.scale,
      cap: route.capComfort,
      waited: joined ? 0 : t - this.aWaitStart[a],
      either,
    };
    if (joined) e.j = true;
    this.tracer!.add(e, train);
  }

  /** Express service: the traced rider steps across to wait for an express due at the other platform. */
  private traceAcross(f: Train, rf: CRoute, kf: number, routeId: number, acrossIdx: number, eta: number, t: number): void {
    const net = this.net!;
    const here = net.stations[rf.dirs[f.dir].stopStation[kf]], there = net.stations[acrossIdx];
    this.tracer!.add({ k: 'alight', t, station: here.id, route: rf.id, train: f.id });
    this.tracer!.add({ k: 'across', t, station: there.id, route: routeId, eta });
    this.tracer!.add({ k: 'walk', t, t1: t + QUAD.crossPlatformTransfer, why: 'across', from: [here.x, here.y], to: [there.x, there.y], station: there.id, pm: false });
  }

  /** Commuter of the day: a completed transit trip (boarded) is checked against the day's best. */
  private dailyTrip(a: number, t: number): void {
    const d = this.daily!;
    const dur = t - this.aTripStart[a];
    const pm = this.aPM[a] === 1;
    if (a >= this.A) {
      if (!pm && dur > d.fanBest) {
        const ev = this.evEvents[this.evGroups[this.aGroup[a]].ev];
        d.offer('fan', a, dur, this.aTripStart[a], t, pm, this.legsOf(a), { late: t > this.evDayStart + ev.start });
      }
      return;
    }
    const g = this.aGroup[a];
    const w = this.walkTimeToday(g), dr = this.driveTime(g, pm);
    const walkFaster = isFinite(w) && w < dr;
    const alt = walkFaster ? w : dr;
    const saved = alt - dur;
    if (saved > d.savedBest) d.offer('saved', a, saved, this.aTripStart[a], t, pm, this.legsOf(a), { alt, altMode: walkFaster ? MODE_WALK : MODE_DRIVE });
    if (d.crossed[a]) {
      d.crossed[a] = 0;
      if (saved > d.crossBest) d.offer('cross', a, saved, this.aTripStart[a], t, pm, this.legsOf(a), { alt, altMode: walkFaster ? MODE_WALK : MODE_DRIVE });
    }
  }

  /** Agent a's legs as ridden this trip ([route, board, alight] × n). */
  private legsOf(a: number): number[] {
    const n = this.aLegN[a];
    return Array.from(this.aLegs.subarray(a * MAX_LEGS * 3, (a * MAX_LEGS + n) * 3));
  }

  /** The time and type of agent a's next pending trip event (null: none). A scan of the heap, on demand only. */
  private pendingFor(a: number): { t: number; type: number } | null {
    let best: { t: number; type: number } | null = null;
    for (let i = 0; i < this.hN; i++) {
      const v = this.hV[i];
      if (v >> 3 !== a) continue;
      if (!best || this.hT[i] < best.t) best = { t: this.hT[i], type: v & 7 };
    }
    return best;
  }

  /**
   * Today's plan of agent a and the mode choice behind it: the generalised costs with today's
   * weather (as the 3 am choice saw them), their parts, the group's shares, the planned paths and
   * the fares its two trips are billed.
   */
  storyPlan(a: number, t: number): StoryPlan {
    const dayStart = dayIndex(t) * SECONDS_PER_DAY;
    const band = this.aBand[a];
    const vot = COMMUTERS.valueOfTime[band];
    const pathOf = (p: GroupPath | null) => (p ? { legs: Array.from(p.legs), time: p.time } : null);
    if (a >= this.A) {
      const eg = this.evGroups[this.aGroup[a]];
      const depart = dayStart + this.aDepart[a];
      const peakTo = isPeakTod(this.aDepart[a]) ? 1 : 0, peakFrom = isPeakTod(this.aReturn[a]) ? 1 : 0;
      return {
        day: dayIndex(t),
        mode: MODE_TRANSIT,
        depart,
        stay: Math.max(0, this.evDayStart + this.aReturn[a] - depart),
        costs: [null, null, null],
        walk: null,
        drive: null,
        transit: null,
        shares: null,
        am: pathOf(eg.to),
        pm: pathOf(eg.from),
        home: [this.aHx[a], this.aHy[a]],
        work: [this.aWx[a], this.aWy[a]],
        fares: [this.fareTable[band * 2 + peakTo], this.fareTable[band * 2 + peakFrom]],
        vot,
      };
    }
    const g = this.aGroup[a];
    const geom = this.gGeom[g];
    const ti = this.transitInput(g);
    const c = generalisedCosts(geom, band, ti, this.wx);
    const wt = walkTime(geom.distance, this.wx);
    const money = driveMoney(geom);
    const pk = this.aPeak[a];
    const fin = (x: number) => (isFinite(x) ? x : null);
    return {
      day: dayIndex(t),
      mode: this.aMode[a],
      depart: dayStart + this.aDepart[a],
      stay: this.aReturn[a],
      costs: [fin(c[0]), fin(c[1]), fin(c[2])],
      walk: isFinite(wt) ? { min: wt / 60, penalty: this.wx.walkPenalty } : null,
      drive: { min: driveTripTime(geom, this.wx) / 60, money, moneyMin: moneyToMinutes(money, band), constant: COMMUTERS.modeConstant.drive },
      transit: ti
        ? {
            min: ti.time / 60,
            transfers: ti.transfers,
            transferMin: (ti.transfers * COMMUTERS.transferPenalty) / 60,
            crowdMin: ti.crowdMinutes,
            fare: ti.fare,
            fareMin: moneyToMinutes(ti.fare, band),
            observed: this.obsTime[g] > 0,
          }
        : null,
      shares: [this.shares[g * 3], this.shares[g * 3 + 1], this.shares[g * 3 + 2]],
      am: pathOf(this.pathAM[g]),
      pm: pathOf(this.pathPM[g]),
      home: [this.aHx[a], this.aHy[a]],
      work: [this.aWx[a], this.aWy[a]],
      fares: [this.fareTable[band * 2 + (pk & 1)] * this.gFareMult[g], this.fareTable[band * 2 + (pk >> 1)] * this.gFareMult[g]],
      vot,
    };
  }

  /**
   * Choose an agent for a story (−1: nobody fits). Random: someone mid-trip by transit, else a
   * transit commuter still to travel today, else any of today's transit commuters. Station: someone
   * waiting on its platforms, else on the way to board there, else a commuter boarding there today.
   */
  storyPick(pick: StoryPick, t: number): number {
    if (pick.kind === 'who') return this.findAgent(pick.who);
    const n = this.A + this.evUsed;
    const salt = pick.salt | 0;
    const hashPick = (list: number[]) => (list.length ? list[hash32x4(salt, Math.floor(t), list.length, 0x51) % list.length] : -1);
    const moving = (s: number) => s === S_WALK || s === S_WAIT || s === S_RIDE || s === S_EGRESS;
    if (pick.kind === 'random') {
      const now: number[] = [];
      for (let a = 0; a < n; a++) if (moving(this.aState[a]) && this.aMode[a] === MODE_TRANSIT) now.push(a);
      if (now.length) return hashPick(now);
      // Nobody is travelling: a transit commuter whose next trip is soonest (ties by the hash).
      const later: number[] = [];
      for (let a = 0; a < this.A; a++) if (this.aMode[a] === MODE_TRANSIT && (this.aState[a] === S_HOME || this.aState[a] === S_WORK)) later.push(a);
      if (later.length) return this.soonest(later, salt, t);
      const any: number[] = [];
      for (let a = 0; a < this.A; a++) if (this.aMode[a] === MODE_TRANSIT && this.pathAM[this.aGroup[a]]) any.push(a);
      return hashPick(any);
    }
    const graph = this.graph, net = this.net;
    if (!graph || !net) return -1;
    const ids = new Set(pick.stations);
    const idx = pick.stations.map((id) => this.stationById.get(id)).filter((i): i is number => i !== undefined);
    const waiting: number[] = [];
    for (const si of idx) {
      for (const p of graph.stationBoard[si]) {
        const q = this.queues[p];
        for (let i = this.qHead[p]; i < q.length; i++) {
          const a = q[i];
          if (this.aState[a] === S_WAIT && this.aPlat[a] === p) waiting.push(a);
        }
      }
    }
    if (waiting.length) return hashPick(waiting);
    const coming: number[] = [];
    for (let a = 0; a < n; a++) {
      if (this.aState[a] !== S_WALK) continue;
      const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
      if (ids.has(this.aLegs[o + 1])) coming.push(a);
    }
    if (coming.length) return hashPick(coming);
    const later: number[] = [];
    for (let a = 0; a < this.A; a++) {
      if (this.aMode[a] !== MODE_TRANSIT) continue;
      const g = this.aGroup[a];
      const s = this.aState[a];
      const path = s === S_HOME ? this.pathAM[g] : s === S_WORK ? this.pathPM[g] : null;
      if (path && ids.has(path.legs[1])) later.push(a);
    }
    return later.length ? this.soonest(later, salt, t) : -1;
  }

  /** Of these agents, the one whose next trip starts soonest after t (the salt's hash breaks ties). */
  private soonest(list: number[], salt: number, t: number): number {
    const dayStart = dayIndex(t) * SECONDS_PER_DAY;
    let best = -1, bestT = Infinity, bestH = 0;
    for (const a of list) {
      const dep = dayStart + this.aDepart[a];
      // At work: home time is the morning trip's end plus the stay (approximated by the departure, an hour's trip and the stay).
      const next = this.aState[a] === S_HOME ? dep : dep + 1800 + this.aReturn[a];
      const nt = next >= t ? next : next + SECONDS_PER_DAY;
      const hh = hash32x4(salt, a, 0x50, 0);
      if (nt < bestT - 60 || (Math.abs(nt - bestT) <= 60 && hh > bestH)) {
        best = a;
        bestT = nt;
        bestH = hh;
      }
    }
    return best;
  }

  /**
   * Where agent a is right now, as trace events (a story that starts mid-trip): walking (with the
   * arrival time from its pending event), waiting, on a train (found in the trains' buckets), or
   * none (at home or at work).
   */
  storyJoin(a: number, t: number): { events: TraceEvent[]; train: Train | null } {
    const s = this.aState[a];
    const net = this.net, graph = this.graph;
    const pm = this.aPM[a] === 1;
    if (!net || !graph) return { events: [], train: null };
    if (s === S_WAIT && this.aPlat[a] >= 0) return { events: [this.waitEvent(this.aPlat[a], this.aWaitStart[a], true)], train: null };
    if (s === S_RIDE) {
      for (const tr of this.trains()) {
        for (let k = 0; k < tr.buckets.length; k++) {
          const b = tr.buckets[k];
          if (!b || b.indexOf(a) < 0) continue;
          const r = net.routes[tr.route];
          const dir = r.dirs[tr.dir];
          // (The current leg's board station; its alight is the bucket's stop.)
          const o = (a * MAX_LEGS + this.aLeg[a]) * 3;
          const e: TraceEvent = { k: 'board', t, train: tr.id, route: r.id, station: this.aLegs[o + 1], alight: net.stations[dir.stopStation[k]].id, fare: 0, load: tr.load * this.scale, cap: r.capComfort, waited: 0, either: false, j: true };
          return { events: [e], train: tr };
        }
      }
      return { events: [], train: null };
    }
    if (s === S_WALK || s === S_EGRESS) {
      const pend = this.pendingFor(a);
      const t1 = pend ? pend.t : t;
      const leg = this.aLeg[a];
      const o = (a * MAX_LEGS + leg) * 3;
      if (s === S_EGRESS) {
        const lo = (a * MAX_LEGS + Math.max(0, this.aLegN[a] - 1)) * 3;
        const st = net.stations[this.stationById.get(this.aLegs[lo + 2]) ?? -1];
        const to: [number, number] = pm ? [this.aHx[a], this.aHy[a]] : [this.aWx[a], this.aWy[a]];
        const from: [number, number] = st ? [st.x, st.y] : to;
        const dur = (Math.hypot(to[0] - from[0], to[1] - from[1]) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
        return { events: [{ k: 'walk', t: Math.min(t, t1 - dur), t1, why: 'egress', from, to, station: -1, pm, j: true }], train: null };
      }
      const st = net.stations[this.stationById.get(this.aLegs[o + 1]) ?? -1];
      if (!st) return { events: [], train: null };
      let from: [number, number];
      let why: 'access' | 'transfer' = 'access';
      if (leg === 0) from = pm ? [this.aWx[a], this.aWy[a]] : [this.aHx[a], this.aHy[a]];
      else {
        const prev = net.stations[this.stationById.get(this.aLegs[(a * MAX_LEGS + leg - 1) * 3 + 2]) ?? -1];
        from = prev ? [prev.x, prev.y] : [st.x, st.y];
        why = 'transfer';
      }
      const dur = (Math.hypot(st.x - from[0], st.y - from[1]) * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * this.wx.walkSpeed);
      return { events: [{ k: 'walk', t: Math.min(t, t1 - dur), t1, why, from, to: [st.x, st.y], station: st.id, pm, j: true }], train: null };
    }
    return { events: [], train: null };
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
    // Four-track sections (v2): agents transferring across a cross-platform pair, by the pair's lower station id.
    crossTransfers: new Map<number, number>(),
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

/**
 * Express service (v2): the boarding tables (see ExpressBoarding). Siblings of a boarding platform
 * are the boarding platforms of other routes at its station or across the pair, where one of the
 * two routes is an express and both call at some station complex further on.
 */
function buildExpressBoarding(net: CompiledNetwork, graph: TransitGraph): ExpressBoarding {
  const S = net.stations.length;
  const complex = new Int32Array(S);
  let pairs = false;
  net.stations.forEach((s, i) => {
    const pr = s.pair !== undefined && s.pair >= 0 ? s.pair : -1;
    if (pr >= 0) pairs = true;
    complex[i] = pr >= 0 ? Math.min(i, pr) : i;
  });
  const cstop = net.routes.map((r) =>
    r.dirs.map((d) => {
      const m = new Map<number, number>();
      d.stopStation.forEach((si, k) => {
        if (!m.has(complex[si])) m.set(complex[si], k);
      });
      return m;
    }),
  );
  const P = graph.P;
  const sibSame: (number[] | null)[] = new Array(P).fill(null);
  const sibAcross: (number[] | null)[] = new Array(P).fill(null);
  const ahead = (ri: number, d: number, k: number): Set<number> => {
    const st = net.routes[ri].dirs[d].stopStation;
    const out = new Set<number>();
    for (let j = k + 1; j < st.length; j++) out.add(complex[st[j]]);
    return out;
  };
  for (let p = 0; p < P; p++) {
    if (!graph.canBoard[p]) continue;
    const st = graph.platStation[p];
    const rp = graph.platRoute[p];
    const mine = ahead(rp, graph.platDir[p], graph.platStop[p]);
    const pr = net.stations[st].pair;
    for (const [s2, out] of [[st, sibSame], [pr !== undefined && pr >= 0 ? pr : -1, sibAcross]] as const) {
      if (s2 < 0) continue;
      for (const q of graph.stationBoard[s2]) {
        const rq = graph.platRoute[q];
        if (rq === rp || !(net.routes[rp].express || net.routes[rq].express)) continue;
        let shared = false;
        for (const c of ahead(rq, graph.platDir[q], graph.platStop[q])) if (mine.has(c)) shared = true;
        if (!shared) continue;
        (out[p] ??= []).push(q);
      }
    }
  }
  return { complex, cstop, sibSame, sibAcross, pairs };
}

/**
 * Express service (v2): scheduled seconds until train x reaches stop k (k ≥ its next stop) of its
 * direction d, from where it is now: the rest of its dwell, or the unrun share of the leg to its
 * next stop, then the timetable.
 */
function timeToStop(x: Train, d: CRouteDir, k: number, t: number): number {
  const j = x.stop;
  if (x.state === TState.Dwelling) return Math.max(0, x.until - t) + (d.schedArrive[k] - d.schedDepart[j]);
  const s0 = j > 0 ? d.stopS[j - 1] : 0, s1 = d.stopS[j];
  const f = s1 > s0 ? Math.min(1, Math.max(0, (x.s - s0) / (s1 - s0))) : 1;
  const t0 = j > 0 ? d.schedDepart[j - 1] : 0;
  return (1 - f) * (d.schedArrive[j] - t0) + (d.schedArrive[k] - d.schedArrive[j]);
}
