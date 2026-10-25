/**
 * Game state on the main thread: the network design, routes, money and the clock mirror.
 * The sim worker owns the moving parts (trains, commuters); this owns what the player builds.
 */
import { CHAOS, ECONOMY, GROWTH, PARK_RIDE, TIME, TRACK, type ChaosLevel, type GrowthPace } from '../balance';
import { Network } from '../construction/network';
import type { Company } from './company';
import { nextTier, tierCost, tierInfo, tierOf } from '../construction/stationTiers';
import {
  advanceConstruction,
  BlueprintHistory,
  blueprintSummary,
  commitBlueprints,
  type BlueprintSummary,
} from '../construction/blueprint';
import type { Terrain } from '../construction/validate';
import { Finance } from '../economy/finance';
import { marketSeedFrom } from '../economy/credit';
import { defaultFares, flatFares, normalizeFares, type FarePolicy } from '../economy/fares';
import type { World } from '../data/world';
import { Emitter } from './emitter';
import { dayIndex, SECONDS_PER_DAY } from './calendar';
import { RouteSet } from '../routes/routeSet';
import type { ChaosInit, DayExposure, ServiceOverride } from '../sim/protocol';
import { emptyTimelapse, encodeTimelapse, recordFrame, type SavedTimelapse, type Timelapse, type TLFrame } from '../cinematic/timelapse';

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
  /** Routes & stations manager (full screen). */
  | { kind: 'routes'; tab?: 'routes' | 'stations' }
  /** Service alerts panel, optionally focused on an alert (alert id) or a city event (event id). */
  | { kind: 'alerts'; focus?: number; event?: number };

export class Game {
  readonly events = new Emitter<GameEvents>();
  network = new Network();
  routes = new RouteSet();
  history = new BlueprintHistory();
  finance: Finance;
  time = TIME.startTimeOfDay;
  /** Fare policy (v2): peak and off-peak fares and the low-income multiplier. */
  fares: FarePolicy;
  sandbox: boolean;
  /** Living City pace (menu → City growth; saved). The sim applies it at the next month close. */
  growthPace: GrowthPace = GROWTH.defaultPace;
  selection: Selection | null = null;
  /** Your company (name, logo, start-up grant); null for games from before companies. */
  company: Company | null = null;
  /** City chaos: level (default Normal for new games), seed and planned event service. */
  chaos: ChaosSettings;
  /**
   * Cinematic (v2): the network at each month close, for the timelapse player (saved, v7). Main
   * thread only: nothing in the simulation reads it.
   */
  private _timelapse: Timelapse = emptyTimelapse();
  private timelapseSaved: SavedTimelapse | null = null;

  constructor(
    readonly world: World,
    readonly terrain: Terrain,
    opts: {
      sandbox: boolean;
      /** Fare policy; default: the city's (CITY_BALANCE[city].fares), or flat `fare` when given. */
      fares?: FarePolicy;
      /** Legacy: one flat fare. */
      fare?: number;
      chaos?: ChaosLevel;
      chaosSeed?: number;
      /** Bond market seed; default: derived from the chaos seed (the game's seed). */
      marketSeed?: number;
      /** New bonds always at v1's fixed rate with no spread (the all-off configuration). */
      fixedRate?: boolean;
      /** Living City pace (default GROWTH.defaultPace). */
      growthPace?: GrowthPace;
    },
  ) {
    this.sandbox = opts.sandbox;
    if (opts.growthPace) this.growthPace = opts.growthPace;
    this.fares = opts.fares ? normalizeFares(opts.fares) : opts.fare !== undefined ? flatFares(opts.fare) : defaultFares();
    const level = opts.chaos ?? CHAOS.defaultLevel;
    this.chaos = { level, levelToday: level, seed: (opts.chaosSeed ?? CHAOS.defaultSeed) >>> 0, service: [], nextServiceId: 1 };
    this.finance = new Finance(opts.sandbox, dayIndex(this.time), opts.marketSeed ?? marketSeedFrom(this.chaos.seed));
    if (opts.fixedRate) this.finance.market.fixed = true;
  }

  /**
   * A new career's seed (main thread): city chaos and the bond market both derive from it, so a
   * reload walks the same market path.
   */
  setGameSeed(seed: number): void {
    this.chaos.seed = seed >>> 0;
    this.finance.market.seed = marketSeedFrom(this.chaos.seed);
  }

  /** Set the fare policy (normalized to the city's range and step). Returns the policy in force. */
  setFares(p: Partial<FarePolicy>): FarePolicy {
    this.fares = normalizeFares({ ...this.fares, ...p }, ECONOMY.fareDefault);
    this.events.emit('money', undefined);
    return this.fares;
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

  // ------------------------------------------------------------------ timelapse (Cinematic)
  get timelapse(): Timelapse {
    return this._timelapse;
  }

  set timelapse(tl: Timelapse) {
    this._timelapse = tl;
    this.timelapseSaved = null;
  }

  /** Record the network as it is now as a timelapse frame (at a month close: the App and the headless scripts). */
  recordTimelapse(day = this.day): TLFrame {
    this.timelapseSaved = null;
    return recordFrame(this._timelapse, day, this.network, this.routes);
  }

  /** The timelapse as a save stores it (encoded once per recorded frame). */
  timelapseData(): SavedTimelapse {
    return (this.timelapseSaved ??= encodeTimelapse(this._timelapse));
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

  /**
   * Demolish a station. A cross-platform pair (v2) goes together by default (`withPartner: false`:
   * just this platform; the partner becomes a lone platform); refused while a route serves either.
   */
  bulldozeStation(id: number, opts: { withPartner?: boolean } = {}): { ok: boolean; reason?: string; refund?: number } {
    const s = this.network.stations.get(id);
    if (!s) return { ok: false, reason: 'Nothing here' };
    const partner = (opts.withPartner ?? true) && s.pair !== undefined ? this.network.stations.get(s.pair) : undefined;
    const all = partner ? [s, partner] : [s];
    const users = [...new Set(all.flatMap((x) => this.routesUsingStation(x.id)))];
    if (users.length) return { ok: false, reason: `Served by ${users.join(', ')} — remove it from the route first` };
    if (all.every((x) => x.status === 'blueprint')) {
      this.editBlueprint(() => {
        for (const x of all) this.network.removeStation(x.id);
      });
      return { ok: true, refund: 0 };
    }
    let refund = 0;
    for (const x of all) {
      if (x.status !== 'blueprint') refund += this.finance.refund(x.cost, TRACK.bulldozeRefund);
      this.network.removeStation(x.id);
    }
    this.history.clear();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, refund };
  }

  /** Park & ride: add car park spaces to a built station (paid now, open at once). */
  addParking(id: number, spaces: number): { ok: boolean; reason?: string; cost?: number } {
    const s = this.network.stations.get(id);
    if (!s || s.status !== 'built') return { ok: false, reason: 'Open the station first' };
    const now = s.parking ?? 0;
    const add = Math.max(0, Math.min(spaces, PARK_RIDE.maxSpaces - now));
    if (!add) return { ok: false, reason: `Car parks hold at most ${PARK_RIDE.maxSpaces.toLocaleString()} spaces` };
    const cost = add * PARK_RIDE.costPerSpace;
    if (!this.finance.spend(cost, 'construction')) return { ok: false, reason: 'Not enough money — issue a bond' };
    s.parking = now + add;
    s.cost += cost;
    this.network.touch();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, cost };
  }

  /**
   * Rebuild a station to its next tier (balance.ts STATION_TIERS): pay now, works take days (instant
   * in Sandbox). During works the platforms hold a little less.
   */
  upgradeStation(id: number): { ok: boolean; reason?: string; cost?: number } {
    const s = this.network.stations.get(id);
    if (!s || s.status !== 'built') return { ok: false, reason: 'Open the station first' };
    if (s.tierTo !== undefined) return { ok: false, reason: 'Works are already under way here' };
    const t = nextTier(s);
    if (t === null) return { ok: false, reason: 'Already a grand interchange: the top level' };
    const cost = tierCost(this.network, s, t);
    if (!this.finance.spend(cost, 'construction')) return { ok: false, reason: 'Not enough money — issue a bond' };
    s.cost += cost;
    if (this.sandbox) s.tier = t;
    else {
      s.tierTo = t;
      s.tierStart = this.time;
      s.tierEnd = this.time + tierInfo(t).days * SECONDS_PER_DAY;
    }
    this.network.touch();
    this.afterNetworkChange();
    this.events.emit('money', undefined);
    return { ok: true, cost };
  }

  /** Station works that finish by t: the new tier comes into force. */
  private finishStationWorks(t: number): string[] {
    const done: string[] = [];
    for (const s of this.network.stations.values()) {
      if (s.tierTo !== undefined && s.tierEnd !== undefined && t >= s.tierEnd) {
        s.tier = s.tierTo;
        delete s.tierTo;
        delete s.tierStart;
        delete s.tierEnd;
        done.push(`${s.name}: ${tierInfo(tierOf(s)).name}`);
      }
    }
    if (done.length) this.network.touch();
    return done;
  }

  // ------------------------------------------------------------------ time
  /** Called with the sim clock; finishes construction jobs. */
  setTime(t: number): void {
    this.time = t;
    if (advanceConstruction(this.network, t)) {
      this.afterNetworkChange();
      this.events.emit('toast', { title: 'Construction complete', body: 'New track or stations are open.', tone: 'green' });
    }
    const works = this.finishStationWorks(t);
    if (works.length) {
      this.afterNetworkChange();
      this.events.emit('toast', { title: 'Station upgrade finished', body: works.join(' · '), tone: 'green' });
    }
    this.events.emit('time', t);
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.events.emit('select', sel);
  }
}
