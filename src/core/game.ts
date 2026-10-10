/**
 * Game state on the main thread: the network design, routes, money and the clock mirror.
 * The sim worker owns the moving parts (trains, commuters); this owns what the player builds.
 */
import { TIME, TRACK } from '../balance';
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
}

export type Selection =
  | { kind: 'station'; id: number }
  | { kind: 'edge'; id: number }
  | { kind: 'route'; id: number }
  | { kind: 'train'; id: number }
  | { kind: 'tract'; index: number }
  | { kind: 'finance' }
  | { kind: 'goals' }
  | { kind: 'routes' };

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

  constructor(
    readonly world: World,
    readonly terrain: Terrain,
    opts: { sandbox: boolean; fare: number },
  ) {
    this.sandbox = opts.sandbox;
    this.fare = opts.fare;
    this.finance = new Finance(opts.sandbox, dayIndex(this.time));
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
    let refund = this.finance.refund(e.cost, TRACK.bulldozeRefund);
    for (const s of [...this.network.stations.values()]) {
      if (s.edge === id && s.status !== 'blueprint') refund += this.finance.refund(s.cost, TRACK.bulldozeRefund);
    }
    this.network.removeEdge(id);
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
