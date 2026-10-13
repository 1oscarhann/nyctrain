/**
 * The simulation engine: clock, trains and commuters. Pure TypeScript with no DOM, so it runs
 * inside the Web Worker and directly in Node for the headless test.
 */
import { CHAOS, ECONOMY, TIME, type ChaosLevel } from '../balance';
import { dayIndex, SECONDS_PER_DAY, timeOfDay } from '../core/calendar';
import type { World } from '../data/world';
import { ChaosController } from './chaos';
import { Commuters } from './commuters';
import { flatFares, type FarePolicy } from '../economy/fares';
import { emptyStats } from './regularity';
import type { Alert, ChaosInit, CompiledNetwork, DayChaosInfo, DayReport, LiveStats, ModeState, ServiceOverride, Snapshot } from './protocol';
import { SNAP_HELD, TRAIN_STRIDE } from './protocol';
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
}

export class Engine {
  time: number;
  readonly trains: TrainSim;
  readonly commuters: Commuters | null;
  /** City chaos: weather, events and incidents. */
  readonly chaos: ChaosController;
  net: CompiledNetwork | null = null;
  private cb: EngineCallbacks;

  constructor(world: World | null, opts: EngineOptions, cb: EngineCallbacks = {}) {
    this.time = opts.time;
    this.cb = cb;
    const fares = opts.fares ?? flatFares(opts.fare ?? ECONOMY.fareDefault);
    this.commuters = world ? new Commuters(world, { ...opts, fares }, cb) : null;
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
    this.trains.setNetwork(net, this.time);
    this.commuters?.setNetwork(net, this.time);
    this.chaos.setNetwork(net, this.time);
  }

  /** Fare policy: billing from the next boarding, mode choice from the next 3 am. */
  setFares(p: FarePolicy): void {
    this.commuters?.setFares(p);
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
    };
    this.chaos.endDay();
    this.trains.resetDay();
    this.cb.dayEnd?.(report);
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
