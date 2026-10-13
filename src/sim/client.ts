/**
 * Main-thread side of the simulation worker: commands, snapshots, queries, and interpolation of
 * train positions between snapshots.
 */
import { city } from '../cities';
import { Emitter } from '../core/emitter';
import type { Alert, ChaosInit, ChaosLevel, CompiledNetwork, DayChaosInfo, DayReport, FarePolicy, FromWorker, ModeState, Query, ServiceOverride, Snapshot, ToWorker } from './protocol';
import { SKIP_LABEL, TRAIN_STRIDE } from './protocol';

export interface SimEvents extends Record<string, unknown> {
  ready: { agents: number; groups: number; baseline: number };
  snapshot: Snapshot;
  dayEnd: DayReport;
  busy: string | null;
  event: { title: string; body?: string; tone?: 'green' | 'amber' | 'red' };
  error: string;
  /** City chaos: an incident started or cleared, today's weather (3 am), or an event wrap-up. */
  alert: Alert;
  /** City chaos: today's level, weather and events with the expected mode split (3 am, or on start). */
  dayChaos: DayChaosInfo;
}

export interface TrainView {
  id: number;
  route: number;
  dir: number;
  s: number;
  v: number;
  load: number;
  late: number;
  state: number;
  nextStop: number;
}

export class SimClient {
  readonly events = new Emitter<SimEvents>();
  private worker: Worker;
  private qid = 1;
  private pending = new Map<number, (d: unknown) => void>();
  prev: Snapshot | null = null;
  latest: Snapshot | null = null;
  private latestAt = 0;
  private interval = 100;
  speed = 0;
  /**
   * True while the worker runs a skip: what it posts meanwhile (alerts, wrap-ups) describes the
   * skipped hours and arrives in one burst, so the UI files it without toasts.
   */
  skipping = false;
  /** A network compile waiting out the edit debounce (see setNetworkSoon). */
  private pendingNet: { timer: ReturnType<typeof setTimeout>; build: () => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.events.emit('error', e.message);
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  init(opts: {
    agentScale: number;
    seed: number;
    time: number;
    fares: FarePolicy;
    modeState?: ModeState;
    chaos: ChaosInit;
    service: ServiceOverride[];
  }): void {
    const c = city();
    this.send({ type: 'init', city: c.id, dataBase: new URL(c.dataPath, document.baseURI).href, ...opts });
  }

  setNetwork(net: CompiledNetwork): void {
    this.send({ type: 'network', net });
  }

  /**
   * Compile and send the network after a short pause, so a burst of edits costs one compile
   * (`build` calls setNetwork when the network changed). A pending compile is flushed before any
   * skip or speed change: otherwise the worker would run the night (and the 3 am mode choice)
   * on the old network, and nobody would ride the new one until the next day.
   */
  setNetworkSoon(build: () => void, delayMs = 200): void {
    if (this.pendingNet) clearTimeout(this.pendingNet.timer);
    this.pendingNet = { build, timer: setTimeout(() => this.flushNetwork(), delayMs) };
  }

  /** Run a pending network compile now (no-op if none is waiting). */
  flushNetwork(): void {
    const p = this.pendingNet;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingNet = null;
    p.build();
  }

  setSpeed(speed: number): void {
    this.flushNetwork();
    this.speed = speed;
    this.send({ type: 'speed', speed });
  }

  skipTo(time: number): void {
    this.flushNetwork();
    this.send({ type: 'skipTo', time });
  }

  /** Fare policy (billing from the next boarding, mode choice from the next 3 am). */
  setFares(fares: FarePolicy): void {
    this.send({ type: 'fares', fares: { ...fares } });
  }

  /** City chaos level; the worker applies it from the next 3 am. */
  setChaosLevel(level: ChaosLevel): void {
    this.send({ type: 'chaosLevel', level });
  }

  /** Event service overrides (the full list, replacing the previous one). */
  setService(overrides: ServiceOverride[]): void {
    this.send({ type: 'service', overrides });
  }

  query<T>(q: Query): Promise<T> {
    const id = this.qid++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (d: unknown) => void);
      this.send({ type: 'query', id, q });
    });
  }

  terminate(): void {
    if (this.pendingNet) clearTimeout(this.pendingNet.timer);
    this.pendingNet = null;
    this.worker.terminate();
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'ready':
        this.events.emit('ready', m);
        break;
      case 'snapshot': {
        const now = performance.now();
        if (this.latest) this.interval = Math.max(30, Math.min(400, now - this.latestAt));
        this.prev = this.latest;
        this.latest = m.snap;
        this.latestAt = now;
        this.events.emit('snapshot', m.snap);
        break;
      }
      case 'dayEnd':
        this.events.emit('dayEnd', m.report);
        break;
      case 'busy':
        if (m.label === SKIP_LABEL) this.skipping = true;
        else if (m.label === null) this.skipping = false;
        this.events.emit('busy', m.label);
        break;
      case 'reply': {
        const r = this.pending.get(m.id);
        this.pending.delete(m.id);
        r?.(m.data);
        break;
      }
      case 'event':
        this.events.emit('event', m);
        break;
      case 'error':
        this.events.emit('error', m.message);
        break;
      case 'alert':
        this.events.emit('alert', m.alert);
        break;
      case 'dayChaos':
        this.events.emit('dayChaos', m.info);
        break;
    }
  }

  /**
   * Trains interpolated between the last two snapshots. Rendering runs one snapshot interval
   * behind so motion is smooth; trains that reversed or changed route snap to the latest state.
   */
  trains(now = performance.now()): TrainView[] {
    const cur = this.latest;
    if (!cur) return [];
    const prev = this.prev;
    const f = prev ? Math.max(0, Math.min(1, (now - this.latestAt) / this.interval)) : 1;
    const prevById = new Map<number, number>();
    if (prev) for (let i = 0; i < prev.trains.length; i += TRAIN_STRIDE) prevById.set(prev.trains[i], i);
    const out: TrainView[] = [];
    const A = cur.trains;
    for (let i = 0; i < A.length; i += TRAIN_STRIDE) {
      const id = A[i];
      let s = A[i + 3];
      const pi = prevById.get(id);
      if (prev && pi !== undefined && prev.trains[pi + 1] === A[i + 1] && prev.trains[pi + 2] === A[i + 2] && A[i + 3] >= prev.trains[pi + 3]) {
        s = prev.trains[pi + 3] + (A[i + 3] - prev.trains[pi + 3]) * f;
      }
      out.push({ id, route: A[i + 1], dir: A[i + 2], s, v: A[i + 4], load: A[i + 5], late: A[i + 6], state: A[i + 7], nextStop: A[i + 8] });
    }
    return out;
  }

  /** Interpolated game time. */
  time(now = performance.now()): number {
    const cur = this.latest;
    if (!cur) return 0;
    if (!this.prev || this.speed === 0) return cur.time;
    const f = Math.max(0, Math.min(1, (now - this.latestAt) / this.interval));
    return this.prev.time + (cur.time - this.prev.time) * f;
  }
}
