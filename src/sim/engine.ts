/**
 * The simulation engine: clock, trains and commuters. Pure TypeScript with no DOM, so it runs
 * inside the Web Worker and directly in Node for the headless test.
 */
import { CHAOS, ECONOMY, GROWTH, TIME, type ChaosLevel, type GrowthPace } from '../balance';
import { dayIndex, isNewMonth, SECONDS_PER_DAY, timeOfDay } from '../core/calendar';
import type { World } from '../data/world';
import { ChaosController } from './chaos';
import { Commuters, type RegenStats } from './commuters';
import { flatFares, type FarePolicy } from '../economy/fares';
import { Growth, servedStations, type Benefits } from './growth';
import { emptyStats } from './regularity';
import type { Alert, ChaosInit, CompiledNetwork, DayChaosInfo, DayReport, GrowthData, GrowthMonth, GrowthView, LiveStats, ModeState, ServiceOverride, SimState, Snapshot, TractGrowth } from './protocol';
import { GROWTH_LABEL, SNAP_HELD, TRAIN_STRIDE } from './protocol';
import { TrainSim, TState } from './trainSim';

export interface EngineCallbacks {
  dayEnd?(r: DayReport): void;
  busy?(label: string | null): void;
  event?(title: string, body?: string, tone?: 'green' | 'amber' | 'red'): void;
  /** City chaos: an incident started or cleared, today's weather, or an event wrap-up. */
  alert?(a: Alert): void;
  /** City chaos: today's level, weather and events (3 am, or on start after 3 am). */
  dayChaos?(info: DayChaosInfo): void;
}

export interface EngineOptions {
  agentScale: number;
  seed: number;
  time: number;
  /** Fare policy (v2). */
  fares?: FarePolicy;
  /** Legacy flat fare (used when `fares` is missing; default ECONOMY.fareDefault). */
  fare?: number;
  modeState?: ModeState;
  /** City chaos level and seed (default Off: the sim is exactly v1), and a load's level from 3 am and plan basis. */
  chaos?: ChaosInit;
  /** Planned event service. */
  service?: ServiceOverride[];
  /** Living City: the growth state the saved groups were generated from (null: the starting city). */
  growth?: GrowthData | null;
  /** Living City pace (default GROWTH.defaultPace). */
  growthPace?: GrowthPace;
  /** Tuning only (scripts/balance.ts months=): close a growth month every N days instead of at calendar month ends. */
  monthEvery?: number;
}

export class Engine {
  time: number;
  readonly trains: TrainSim;
  readonly commuters: Commuters | null;
  /** City chaos: weather, events and incidents. */
  readonly chaos: ChaosController;
  net: CompiledNetwork | null = null;
  /** Living City: the city's growth (null without a world). */
  readonly growth: Growth | null;
  /** Saved growth that did not fit this world was dropped (the city starts over; a toast says so). */
  readonly growthReset: boolean;
  /** What the last month close's regeneration did (scripts and tests). */
  lastRegen: RegenStats | null = null;
  private readonly monthEvery: number;
  /** Commute benefits for panel queries, cached until the next midnight, network, fare or regeneration. */
  private benefitCache: Benefits | null = null;
  private cb: EngineCallbacks;

  constructor(world: World | null, opts: EngineOptions, cb: EngineCallbacks = {}) {
    this.time = opts.time;
    this.cb = cb;
    this.monthEvery = opts.monthEvery && opts.monthEvery > 0 ? Math.floor(opts.monthEvery) : 0;
    const fares = opts.fares ?? flatFares(opts.fare ?? ECONOMY.fareDefault);
    this.growth = world ? Growth.fromData(world, opts.growth ?? null, opts.growthPace ?? GROWTH.defaultPace) : null;
    this.growthReset = this.growth?.dropped ?? false;
    const factors = this.growth?.factors() ?? null;
    this.commuters = world ? new Commuters(world, { agentScale: opts.agentScale, seed: opts.seed, fares, modeState: opts.modeState, factors }, cb) : null;
    // A grown city's event-goers come from today's residents.
    if (this.growth && factors) this.commuters?.setOriginWeights(this.growth.currentResidents());
    if (this.growthReset) cb.event?.('City growth was reset', "The saved city growth doesn't fit this city's data, so the city starts again from today.", 'amber');
    this.trains = new TrainSim(
      this.commuters ?? {
        arrive: () => ({ alight: 0, board: 0 }),
        depart: () => {},
        evacuate: () => {},
        pass: () => {},
      },
      opts.agentScale,
    );
    this.commuters?.setTrains(() => this.trains.trains);
    this.chaos = new ChaosController(opts.chaos ?? { level: 'off', seed: CHAOS.defaultSeed }, this.trains, this.commuters, {
      alert: (a) => cb.alert?.(a),
      dayChaos: (i) => cb.dayChaos?.(i),
    });
    if (opts.service?.length) this.chaos.setService(opts.service);
  }

  private started = false;
  /**
   * Schedule today's trips. Deferred to the first step so a loaded network is in place first.
   * After 3 am the day begins now (weather, events, incidents still to come); before it, the
   * 3 am step plans the day.
   */
  private start(): void {
    this.started = true;
    if (timeOfDay(this.time) >= TIME.modeChoiceAt) this.beginDay(dayIndex(this.time), this.time, false);
    else this.commuters?.startDay(this.time);
  }

  /**
   * 3 am (choose = true: daily mode choice, and the next level takes over), or a start after
   * 3 am (schedule without re-choosing; today's level and plan stay as they were at 3 am).
   */
  private beginDay(day: number, now: number, choose: boolean): void {
    const c = this.commuters;
    // Yesterday's late wrap-ups go out before the event pool resets.
    this.chaos.flushWrapups();
    const events = this.chaos.beginDay(day, now, choose);
    if (choose) c?.dailyModeChoice(now);
    else c?.startDay(now);
    const info = c ? c.injectEvents(events, day * SECONDS_PER_DAY, now, { seed: this.chaos.seed, service: this.chaos.serviceList() }) : [];
    this.chaos.setEventInfo(day, events, info, choose ? -Infinity : now);
  }

  setNetwork(net: CompiledNetwork): void {
    this.net = net;
    this.benefitCache = null;
    this.trains.setNetwork(net, this.time);
    this.commuters?.setNetwork(net, this.time);
    this.chaos.setNetwork(net, this.time);
  }

  /** Fare policy: billing from the next boarding, mode choice from the next 3 am. */
  setFares(p: FarePolicy): void {
    this.commuters?.setFares(p);
    this.benefitCache = null;
  }

  /** Event service overrides (the full list). */
  setService(list: ServiceOverride[]): void {
    this.chaos.setService(list);
  }

  /** City chaos level, from the next 3 am. */
  setChaosLevel(level: ChaosLevel): void {
    this.chaos.setLevel(level);
  }

  /** Advance the clock by dt game seconds (one fixed step). */
  step(dt = TIME.simStep): void {
    if (!this.started) this.start();
    const t0 = this.time;
    const t1 = t0 + dt;
    // Midnight: close the day.
    if (dayIndex(t1) !== dayIndex(t0)) {
      this.time = dayIndex(t1) * SECONDS_PER_DAY;
      this.closeDay(dayIndex(t0));
    }
    // 3 am: daily mode choice and a fresh set of trips (with today's weather and events).
    const mc = dayIndex(t1) * SECONDS_PER_DAY + TIME.modeChoiceAt;
    if (t0 < mc && t1 >= mc) this.beginDay(dayIndex(t1), mc, true);
    this.time = t1;
    // Incidents fire and clear before the trains move.
    this.chaos.step(t1);
    this.trains.step(t1, dt);
    this.commuters?.step(t1);
  }

  /** Jump forward (e.g. "Skip to 6am"), stepping the sim quickly through the gap. */
  skipTo(target: number, maxSteps = 200000): void {
    let n = 0;
    while (this.time + TIME.simStep <= target && n++ < maxSteps) this.step(TIME.simStep);
  }

  private closeDay(day: number): void {
    const c = this.commuters;
    const tr = this.trains.day;
    const routeLateness: Record<number, number> = {};
    for (const [rid, v] of tr.routeLate) routeLateness[rid] = v.n ? v.sum / v.n : 0;
    // Chaos counters and event outcomes, read before the commuters' day resets.
    const chaosStats = c?.chaosStats() ?? { eventRiders: 0, diverted: 0, carriedPast: 0 };
    const outcomes = c?.eventOutcomes() ?? [];
    const base = c?.dayReport(day) ?? emptyReport(day);
    // Operations control: the day's regularity (the accumulators roll over to tomorrow).
    const reg = this.trains.closeDayRegularity();
    this.benefitCache = null;
    // Living City: the month closes at the same midnight as the finances' month (fresh
    // observations are in; nobody is travelling), before the report goes out and the autosave.
    const growth = this.isMonthEnd(day) ? this.monthClose(day) : null;
    const report: DayReport = {
      ...base,
      carKm: tr.carKm,
      avgLateness: tr.lateCount ? tr.lateSum / tr.lateCount : 0,
      deadlocks: tr.deadlocks,
      routeLateness,
      stationsOpen: this.net?.stations.length ?? 0,
      chaos: this.chaos.daySummary(outcomes, chaosStats),
      routeRegularity: reg.routes,
      regularity: reg.network,
      ...(growth ? { growth } : {}),
    };
    this.chaos.endDay();
    this.trains.resetDay();
    this.cb.dayEnd?.(report);
  }

  // ------------------------------------------------------------------ Living City
  /** A growth month closes after this day: the finances' month end (or every monthEvery days, for tuning). */
  private isMonthEnd(day: number): boolean {
    return this.monthEvery > 0 ? (day + 1) % this.monthEvery === 0 : isNewMonth(day + 1);
  }

  /**
   * Close a growth month on `day` (docs/v2/living-city.md §3.6): measure the commute benefits,
   * grow the city, rebalance the OD and regenerate the agents from it. Null (nothing changes) on
   * pace Off, without a world, or for a day already applied, so it is idempotent. Public so
   * tests and scripts can force one; the engine calls it at each month-end midnight.
   */
  monthClose(day: number): GrowthMonth | null {
    const g = this.growth, c = this.commuters;
    if (!g || !c || !(GROWTH.paceMultiplier[g.pace] > 0) || day <= g.appliedThroughDay) return null;
    this.cb.busy?.(GROWTH_LABEL);
    try {
      const b = c.commuteBenefit();
      const rep = g.step(day, b, servedStations(this.net));
      if (!rep) return null;
      this.lastRegen = c.regenerate(g.factors()!, this.time);
      c.setOriginWeights(g.currentResidents());
      this.benefitCache = null;
      rep.agents = c.A;
      rep.commuters = c.A * c.scale;
      return rep;
    } finally {
      this.cb.busy?.(null);
    }
  }

  /** Mode shares and the growth state their groups belong to, captured together (saves). */
  simState(): SimState {
    const g = this.growth;
    return { mode: this.commuters!.modeState(), growth: g && !g.isIdentity() ? g.toData() : null };
  }

  /** The growth overlay's and panels' data (null without a world). */
  growthView(): GrowthView | null {
    return this.growth ? this.growth.view(servedStations(this.net)) : null;
  }

  /** One tract's growth, with today's commute benefits (null without a world or for a bad index). */
  tractGrowth(i: number): TractGrowth | null {
    const g = this.growth;
    if (!g || !this.commuters || !(i >= 0 && i < g.T)) return null;
    this.benefitCache ??= this.commuters.commuteBenefit();
    return g.tract(i, servedStations(this.net), this.benefitCache);
  }

  /** Living City pace: takes effect at the next month close. */
  setGrowthPace(p: GrowthPace): void {
    this.growth?.setPace(p);
  }

  snapshot(simRate: number): Snapshot {
    const trains = this.trains.trains.filter((t) => t.state === TState.Running || t.state === TState.Dwelling);
    const arr = new Float64Array(trains.length * TRAIN_STRIDE);
    trains.forEach((t, i) => {
      const o = i * TRAIN_STRIDE;
      arr[o] = t.id;
      arr[o + 1] = t.route;
      arr[o + 2] = t.dir;
      arr[o + 3] = t.s;
      arr[o + 4] = t.v;
      arr[o + 5] = t.load;
      arr[o + 6] = t.late;
      arr[o + 7] = this.trains.isHeld(t) ? SNAP_HELD : t.state;
      arr[o + 8] = t.stop;
    });
    const waiting = this.commuters?.waitingByStation(this.net?.stations.length ?? 0) ?? new Float64Array(this.net?.stations.length ?? 0);
    const live: LiveStats = this.commuters?.live() ?? { ridersToday: 0, tripsInProgress: 0, inSystem: 0 };
    return { time: this.time, netVersion: this.net?.version ?? -1, trains: arr, waiting, live, simRate };
  }
}

function emptyReport(day: number): DayReport {
  return {
    day,
    riders: 0,
    fareTrips: 0,
    fareRevenue: 0,
    commuters: 0,
    transitShare: 0,
    walkShare: 0,
    driveShare: 0,
    avgCommute: 0,
    baselineCommute: 0,
    carKm: 0,
    stationsOpen: 0,
    avgLateness: 0,
    leftBehind: 0,
    gaveUp: 0,
    deadlocks: 0,
    routeRiders: {},
    routeLateness: {},
    stationBoardings: {},
    goalTrip: null,
    boroughsServed: [],
    fares: { trips: [0, 0, 0, 0, 0, 0], revenue: [0, 0, 0, 0, 0, 0] },
    bandShare: [0, 0, 0],
    routeRegularity: {},
    regularity: emptyStats(),
  };
}
