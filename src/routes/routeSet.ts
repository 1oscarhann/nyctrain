/**
 * The player's routes, with cached paths along the track.
 */
import { defaultStock, gaugeOf, OPERATIONS, STATION, STOCK_IDS, TRAINS, type StockId } from '../balance';
import { platformLength, type Network } from '../construction/network';
import type { Station } from '../construction/types';
import { defaultControl, legacyControl, normalizeControl } from './control';
import { findRoutePath, pathEdges } from './pathfind';
import { city } from '../cities';
import { isBulletShape, PERIOD_IDS, routePalette, type PeriodId, type Route, type RouteControl, type RoutePath } from './types';

export class RouteSet {
  routes = new Map<number, Route>();
  nextId = 1;
  /** Cars left over from deleted routes, by train type: reused before buying new ones. */
  spareCars: Record<StockId, number> = emptySpares();
  private cache = new Map<number, { key: string; path: RoutePath }>();
  version = 0;
  /**
   * Operations control for routes created without one (not saved): the v2 defaults. Headless runs
   * set offControl() here for the all-off configuration.
   */
  newControl: () => RouteControl = defaultControl;

  invalidate(): void {
    this.cache.clear();
    this.version++;
  }

  list(): Route[] {
    return [...this.routes.values()];
  }

  get(id: number): Route | undefined {
    return this.routes.get(id);
  }

  create(partial: Omit<Route, 'id' | 'ownedCars' | 'control' | 'stock'> & { ownedCars?: number; control?: Partial<RouteControl>; stock?: StockId }): Route {
    const base = this.newControl();
    const control = partial.control ? normalizeControl(partial.control, base) : base;
    const r: Route = { ownedCars: 0, ...partial, stock: validStock(partial.stock, partial.cls), express: partial.express ?? false, control, id: this.nextId++ };
    r.control.timepoints = r.control.timepoints.filter((s) => r.stops.includes(s));
    this.routes.set(r.id, r);
    this.invalidate();
    return r;
  }

  remove(id: number): void {
    const r = this.routes.get(id);
    if (r) this.spareCars[r.stock] += r.ownedCars;
    this.routes.delete(id);
    this.invalidate();
  }

  update(id: number, patch: Partial<Route>): void {
    const r = this.routes.get(id);
    if (!r) return;
    Object.assign(r, patch);
    r.stock = validStock(r.stock, r.cls);
    if (patch.control) r.control = normalizeControl(patch.control, r.control);
    // Timepoints follow the stop list.
    r.control.timepoints = r.control.timepoints.filter((s) => r.stops.includes(s));
    this.invalidate();
  }

  path(net: Network, r: Route): RoutePath {
    const key = `${net.version}|${r.cls}|${r.stops.join(',')}`;
    const c = this.cache.get(r.id);
    if (c && c.key === key) return c.path;
    // Prefer built track: a route keeps running on what exists while a shortcut is planned or
    // under construction, and switches over once it opens. Otherwise show the planned path.
    // (Four tracks: only built platforms count as ones the route runs past.)
    const built = findRoutePath(net, r.cls, r.stops, (id) => net.edges.get(id)?.status === 'built', { platform: (s) => s.status === 'built' });
    const path = built.ok ? built : findRoutePath(net, r.cls, r.stops);
    this.cache.set(r.id, { key, path });
    return path;
  }

  usingEdge(net: Network, edgeId: number): string[] {
    const out: string[] = [];
    for (const r of this.routes.values()) {
      const p = this.path(net, r);
      if (p.ok && pathEdges(p.legs).has(edgeId)) out.push(routeLabel(r));
    }
    return out;
  }

  usingStation(stationId: number): string[] {
    return this.list()
      .filter((r) => r.stops.includes(stationId))
      .map(routeLabel);
  }

  /** Drop stations that no longer exist from every route. */
  pruneMissing(net: Network): void {
    let changed = false;
    for (const r of this.routes.values()) {
      const kept = r.stops.filter((s) => net.stations.has(s));
      if (kept.length !== r.stops.length) {
        r.stops = kept;
        changed = true;
      }
      const tps = r.control.timepoints.filter((s) => r.stops.includes(s));
      if (tps.length !== r.control.timepoints.length) {
        r.control.timepoints = tps;
        changed = true;
      }
    }
    if (changed) this.invalidate();
  }

  /** A route runs once every edge on its path and every station it serves is built. */
  operational(net: Network, r: Route): { ok: boolean; reason?: string } {
    const p = this.path(net, r);
    if (!p.ok) return { ok: false, reason: p.error };
    for (const l of p.legs) {
      if (net.edges.get(l.edge)!.status !== 'built') return { ok: false, reason: 'Waiting for track construction' };
    }
    for (const sid of r.stops) {
      const s = net.stations.get(sid)!;
      if (s.status !== 'built') return { ok: false, reason: `Waiting for ${s.name} to open` };
      if (carsFitting(net, s, r.stock) < r.cars) return { ok: false, reason: `${s.name}'s platform is too short for ${r.cars}-car trains` };
    }
    return { ok: true };
  }

  nextColor(): string {
    const used = new Set(this.list().map((r) => r.color));
    const pal = routePalette(city().theme);
    return pal.find((c) => !used.has(c)) ?? pal[this.routes.size % pal.length];
  }

  nextBullet(): string {
    const used = new Set(this.list().map((r) => r.bullet));
    for (const c of 'ABCDEFGHJKLMNPQRSTUVWXYZ') if (!used.has(c)) return c;
    for (let i = 1; i < 100; i++) if (!used.has(String(i))) return String(i);
    return '?';
  }

  toData(): RouteSetData {
    return { routes: JSON.parse(JSON.stringify(this.list())), nextId: this.nextId, spareCars: { ...this.spareCars } };
  }

  load(d: RouteSetData): void {
    this.routes.clear();
    // Routes saved before operations control have none: legacy settings (holding off, no recovery).
    // Express service (v2): routes saved before it are locals.
    // Train types: routes saved before them run the metro trains of their track ('heavy' / 'light').
    for (const r of d.routes) this.routes.set(r.id, { ...r, stock: validStock(r.stock, r.cls), headways: { ...r.headways }, stops: [...r.stops], control: normalizeControl(r.control, legacyControl()), express: r.express === true, shape: isBulletShape(r.shape) ? r.shape : undefined });
    this.nextId = d.nextId;
    this.spareCars = emptySpares();
    for (const s of STOCK_IDS) this.spareCars[s] = Math.max(0, Math.floor(Number(d.spareCars?.[s] ?? 0)) || 0);
    this.invalidate();
  }
}

export interface RouteSetData {
  routes: Route[];
  nextId: number;
  /** Added after save v2 shipped; missing means none. Keyed by train type (old saves: heavy / light). */
  spareCars?: Partial<Record<StockId, number>>;
}

export function routeLabel(r: Route): string {
  return `${r.bullet} ${r.name}`.trim();
}

export function defaultHeadways(): Record<PeriodId, number> {
  return { ...OPERATIONS.defaultHeadways };
}

export function periodOf(timeOfDay: number): PeriodId {
  const h = timeOfDay / 3600;
  for (const p of OPERATIONS.periods) if (h >= p.start && h < p.end) return p.id;
  return 'night';
}

export function minHeadway(r: Route): number {
  let m = Infinity;
  for (const p of PERIOD_IDS) if (r.headways[p] > 0) m = Math.min(m, r.headways[p]);
  return m;
}

export function trainLength(r: Route): number {
  return r.cars * TRAINS[r.stock].carLength;
}

function emptySpares(): Record<StockId, number> {
  return Object.fromEntries(STOCK_IDS.map((s) => [s, 0])) as Record<StockId, number>;
}

/** A train type that can run on the route's track family (else that family's metro trains). */
export function validStock(s: unknown, cls: Route['cls']): StockId {
  const g = gaugeOf(cls);
  return typeof s === 'string' && s in TRAINS && TRAINS[s as StockId].gauge === g ? (s as StockId) : defaultStock(g);
}

/** Usable platform length at a station, m (what a train may occupy). */
export function platformRoom(net: Network, s: Station): number {
  const cls = net.edges.get(s.edge)?.cls ?? 'heavy';
  return platformLength(s.cars, cls) - STATION.platformMargin;
}

/** Cars of a train type that fit a station's platform. */
export function carsFitting(net: Network, s: Station, stock: StockId): number {
  return Math.floor(platformRoom(net, s) / TRAINS[stock].carLength + 1e-6);
}

export function maxCarsFor(net: Network, r: Route): number {
  let m = TRAINS[r.stock].maxCars;
  for (const sid of r.stops) {
    const s = net.stations.get(sid);
    if (s) m = Math.min(m, carsFitting(net, s, r.stock));
  }
  return m;
}
