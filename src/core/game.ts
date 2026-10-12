/**
 * Game state on the main thread: the network design, routes, money and the clock mirror.
 * The sim worker owns the moving parts (trains, commuters); this owns what the player builds.
 */
import { CHAOS, TIME, TRACK, type ChaosLevel } from '../balance';
import { Network } from '../construction/network';
import {
  advanceConstruction,
  BlueprintHistory,
  blueprintSummary,
  commitBlueprints,
  type BlueprintSummary,
} from '../construction/blueprint';
import type { Terrain } from '../construction/validate';
import { Finance } from '../economy/finance';
import type { World } from '../data/world';
import { Emitter } from './emitter';
import { dayIndex } from './calendar';
import { RouteSet } from '../routes/routeSet';
import type { ChaosInit, DayExposure, ServiceOverride } from '../sim/protocol';

/** City chaos settings (saved). The calendar, weather and incident plan all derive from the seed. */
export interface ChaosSettings {
  /** The player's level: the sim applies it from the next 3 am. */
  level: ChaosLevel;
  /** The level in force today (the worker's since its last 3 am), so a mid-day load keeps today as it was. */
  levelToday: ChaosLevel;
  seed: number;
  /** Planned event service (temporary headway overrides). */
  service: ServiceOverride[];
  nextServiceId: number;
  /** What today's incidents were planned from at 3 am (a mid-day load replans the same ones). */
  dayExposure?: DayExposure;
}

/** A fresh chaos seed for a new game (main thread only; the sim never draws its own). */
export function newChaosSeed(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] || 1;
}

export interface GameEvents extends Record<string, unknown> {
  /** Track/stations changed (design or construction status). */
  network: void;
  /** Routes changed (stops, frequency, colours…). */
  routes: void;
  /** Cash or ledger changed. */
  money: void;
  time: number;
  toast: { title: string; body?: string; tone?: 'green' | 'amber' | 'red' };
  select: Selection | null;
  /** City chaos settings changed (level or event service). */
  chaos: void;
}

export type Selection =
  | { kind: 'station'; id: number }
  | { kind: 'edge'; id: number }
  | { kind: 'route'; id: number }
  | { kind: 'train'; id: number }
  | { kind: 'tract'; index: number }
  | { kind: 'finance' }
  | { kind: 'goals' }
  | { kind: 'routes' }
  /** Service alerts panel, optionally focused on an alert (alert id) or a city event (event id). */
  | { kind: 'alerts'; focus?: number; event?: number };

export class Game {
  readonly events = new Emitter<GameEvents>();
  network = new Network();
  routes = new RouteSet();
  history = new BlueprintHistory();
  finance: Finance;
  time = TIME.startTimeOfDay;
  fare: number;
  sandbox: boolean;
  selection: Selection | null = null;
  /** City chaos: level (default Normal for new games), seed and planned event service. */
  chaos: ChaosSettings;

  constructor(
    readonly world: World,
    readonly terrain: Terrain,
    opts: { sandbox: boolean; fare: number; chaos?: ChaosLevel; chaosSeed?: number },
  ) {
    this.sandbox = opts.sandbox;
    this.fare = opts.fare;
    this.finance = new Finance(opts.sandbox, dayIndex(this.time));
    const level = opts.chaos ?? CHAOS.defaultLevel;
    this.chaos = { level, levelToday: level, seed: (opts.chaosSeed ?? CHAOS.defaultSeed) >>> 0, service: [], nextServiceId: 1 };
  }

  // ------------------------------------------------------------------ city chaos
  /** The sim applies a new level from the next 3 am. */
  setChaosLevel(level: ChaosLevel): void {
    this.chaos.level = level;
    this.events.emit('chaos', undefined);
  }

  /** For the sim worker: today's level (a mid-day load keeps it), the player's from the next 3 am, and today's plan basis. */
  chaosInit(): ChaosInit {
    const c = this.chaos;
    return { level: c.levelToday, nextLevel: c.level, seed: c.seed, ...(c.dayExposure ? { dayExposure: c.dayExposure } : {}) };
  }

  /** The worker's 3 am plan for a day: the level in force and the exposure its incidents were drawn from (kept for saves). */
  setChaosToday(info: { day: number; level: ChaosLevel; exposure?: DayExposure['exposure'] }): void {
    this.chaos.levelToday = info.level;
    if (info.exposure) this.chaos.dayExposure = { day: info.day, exposure: info.exposure };
    else delete this.chaos.dayExposure;
  }

  /** Plan event service (one override per route and window). */
  addService(o: Omit<ServiceOverride, 'id'>): ServiceOverride {
    const s: ServiceOverride = { ...o, id: this.chaos.nextServiceId++ };
    this.chaos.service.push(s);
    this.events.emit('chaos', undefined);
    return s;
  }

  removeService(id: number): boolean {
    const n = this.chaos.service.length;
    this.chaos.service = this.chaos.service.filter((o) => o.id !== id);
    if (this.chaos.service.length === n) return false;
    this.events.emit('chaos', undefined);
    return true;
  }

  /** Drop event service on routes that no longer exist. Returns the dropped overrides. */
  pruneServiceRoutes(): ServiceOverride[] {
    const gone = this.chaos.service.filter((o) => !this.routes.get(o.routeId));
    if (!gone.length) return gone;
    this.chaos.service = this.chaos.service.filter((o) => this.routes.get(o.routeId));
    this.events.emit('chaos', undefined);
    return gone;
  }

  /** Drop event service that has ended (at midnight, 3 am and on save). Returns how many were dropped. */
  pruneService(now: number): number {
    const n = this.chaos.service.length;
    this.chaos.service = this.chaos.service.filter((o) => o.to > now);
    const dropped = n - this.chaos.service.length;
    if (dropped) this.events.emit('chaos', undefined);
    return dropped;
  }

  get day(): number {
    return dayIndex(this.time);
  }

  // ------------------------------------------------------------------ blueprint edits
  /** Wrap a blueprint edit so it can be undone. */
  editBlueprint<T>(fn: () => T): T {
    this.history.record(this.network);
    const out = fn();
    this.afterNetworkChange();
    return out;
  }

  undo(): void {
    if (this.history.undo(this.network)) this.afterNetworkChange();
  }

  redo(): void {
    if (this.history.redo(this.network)) this.afterNetworkChange();
  }

  afterNetworkChange(): void {
    this.routes.invalidate();
    this.events.emit('network', undefined);
    this.events.emit('routes', undefined);
  }

  blueprintSummary(): BlueprintSummary {
    return blueprintSummary(this.network, this.terrain);
  }

  /** Commit all blueprints: spend the money and start construction. */
  build(instant = this.sandbox): { ok: boolean; reason?: string; cost?: number } {
    const sum = this.blueprintSummary();
    if (sum.edges + sum.stations === 0) return { ok: false, reason: 'Nothing planned' };
    if (sum.invalid.length) return { ok: false, reason: `Fix ${sum.invalid.length} invalid item${sum.invalid.length > 1 ? 's' : ''} first` };
    if (!this.finance.canAfford(sum.cost)) return { ok: false, reason: 'Not enough money — issue a bond or plan less' };
    const spent = commitBlueprints(this.network, this.terrain, this.time, instant);
    this.finance.spend(spent, 'construction');
    this.history.clear();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, cost: spent };
  }

  discardBlueprints(): void {
    this.editBlueprint(() => {
      for (const s of [...this.network.stations.values()]) if (s.status === 'blueprint') this.network.removeStation(s.id);
      for (const e of [...this.network.edges.values()]) if (e.status === 'blueprint') this.network.removeEdge(e.id);
    });
  }

  // ------------------------------------------------------------------ bulldoze
  /** Routes that use an edge or station (they block bulldozing). */
  routesUsingEdge(edgeId: number): string[] {
    return this.routes.usingEdge(this.network, edgeId);
  }
  routesUsingStation(stationId: number): string[] {
    return this.routes.usingStation(stationId);
  }

  bulldozeEdge(id: number): { ok: boolean; reason?: string; refund?: number } {
    const e = this.network.edges.get(id);
    if (!e) return { ok: false, reason: 'Nothing here' };
    const users = this.routesUsingEdge(id);
    if (users.length) return { ok: false, reason: `Used by ${users.join(', ')} — edit the route off this track first` };
    for (const s of this.network.stations.values()) {
      if (s.edge === id && this.routesUsingStation(s.id).length)
        return { ok: false, reason: `${s.name} is served by ${this.routesUsingStation(s.id).join(', ')}` };
    }
    if (e.status === 'blueprint') {
      this.editBlueprint(() => this.network.removeEdge(id));
      return { ok: true, refund: 0 };
    }
    // Costs before removal: removing an edge can also take a dangling lead stub with it.
    const costs = new Map([...this.network.edges.values()].map((x) => [x.id, x.status === 'blueprint' ? 0 : x.cost]));
    const stationCosts = [...this.network.stations.values()].map((s) => ({ edge: s.edge, cost: s.status === 'blueprint' ? 0 : s.cost }));
    const removed = this.network.removeEdge(id);
    let refund = 0;
    for (const rid of removed) {
      refund += this.finance.refund(costs.get(rid) ?? 0, TRACK.bulldozeRefund);
      for (const s of stationCosts) if (s.edge === rid) refund += this.finance.refund(s.cost, TRACK.bulldozeRefund);
    }
    this.history.clear();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, refund };
  }

  bulldozeStation(id: number): { ok: boolean; reason?: string; refund?: number } {
    const s = this.network.stations.get(id);
    if (!s) return { ok: false, reason: 'Nothing here' };
    const users = this.routesUsingStation(id);
    if (users.length) return { ok: false, reason: `Served by ${users.join(', ')} — remove it from the route first` };
    if (s.status === 'blueprint') {
      this.editBlueprint(() => this.network.removeStation(id));
      return { ok: true, refund: 0 };
    }
    const refund = this.finance.refund(s.cost, TRACK.bulldozeRefund);
    this.network.removeStation(id);
    this.history.clear();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, refund };
  }

  // ------------------------------------------------------------------ time
  /** Called with the sim clock; finishes construction jobs. */
  setTime(t: number): void {
    this.time = t;
    if (advanceConstruction(this.network, t)) {
      this.afterNetworkChange();
      this.events.emit('toast', { title: 'Construction complete', body: 'New track or stations are open.', tone: 'green' });
    }
    this.events.emit('time', t);
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.events.emit('select', sel);
  }
}
