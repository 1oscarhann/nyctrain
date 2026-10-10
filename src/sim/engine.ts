/**
 * The simulation engine: clock, trains and commuters. Pure TypeScript with no DOM, so it runs
 * inside the Web Worker and directly in Node for the headless test.
 */
import { TIME } from '../balance';
import { dayIndex, SECONDS_PER_DAY } from '../core/calendar';
import type { World } from '../data/world';
import { Commuters } from './commuters';
import type { CompiledNetwork, DayReport, LiveStats, ModeState, Snapshot } from './protocol';
import { TRAIN_STRIDE } from './protocol';
import { TrainSim, TState } from './trainSim';

export interface EngineCallbacks {
  dayEnd?(r: DayReport): void;
  busy?(label: string | null): void;
  event?(title: string, body?: string, tone?: 'green' | 'amber' | 'red'): void;
}

export interface EngineOptions {
  agentScale: number;
  seed: number;
  time: number;
  fare: number;
  modeState?: ModeState;
}

export class Engine {
  time: number;
  readonly trains: TrainSim;
  readonly commuters: Commuters | null;
  net: CompiledNetwork | null = null;
  private cb: EngineCallbacks;

  constructor(world: World | null, opts: EngineOptions, cb: EngineCallbacks = {}) {
    this.time = opts.time;
    this.cb = cb;
    this.commuters = world ? new Commuters(world, opts, cb) : null;
    this.trains = new TrainSim(
      this.commuters ?? {
        arrive: () => ({ alight: 0, board: 0 }),
        depart: () => {},
        evacuate: () => {},
      },
      opts.agentScale,
    );
    this.commuters?.setTrains(() => this.trains.trains);
  }

  private started = false;
  /** Schedule today's trips. Deferred to the first step so a loaded network is in place first. */
  private start(): void {
    this.started = true;
    this.commuters?.startDay(this.time);
  }

  setNetwork(net: CompiledNetwork): void {
    this.net = net;
    this.trains.setNetwork(net, this.time);
    this.commuters?.setNetwork(net, this.time);
  }

  setFare(f: number): void {
    this.commuters?.setFare(f);
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
    // 3 am: daily mode choice and a fresh set of trips.
    const mc = dayIndex(t1) * SECONDS_PER_DAY + TIME.modeChoiceAt;
    if (t0 < mc && t1 >= mc) this.commuters?.dailyModeChoice(mc);
    this.time = t1;
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
    const base = c?.dayReport(day) ?? emptyReport(day);
    const report: DayReport = {
      ...base,
      carKm: tr.carKm,
      avgLateness: tr.lateCount ? tr.lateSum / tr.lateCount : 0,
      deadlocks: tr.deadlocks,
      routeLateness,
      stationsOpen: this.net?.stations.length ?? 0,
    };
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
      arr[o + 7] = t.state;
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
    midtownJfk: null,
    boroughsServed: [],
  };
}
