/**
 * The player's routes, with cached paths along the track.
 */
import { OPERATIONS, STATION, TRAINS } from '../balance';
import type { Network } from '../construction/network';
import { findRoutePath, pathEdges } from './pathfind';
import { PERIOD_IDS, ROUTE_COLORS, type PeriodId, type Route, type RoutePath } from './types';

export class RouteSet {
  routes = new Map<number, Route>();
  nextId = 1;
  private cache = new Map<number, { key: string; path: RoutePath }>();
  version = 0;

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

  create(partial: Omit<Route, 'id' | 'ownedCars'> & { ownedCars?: number }): Route {
    const r: Route = { ownedCars: 0, ...partial, id: this.nextId++ };
    this.routes.set(r.id, r);
    this.invalidate();
    return r;
  }

  remove(id: number): void {
    this.routes.delete(id);
    this.invalidate();
  }

  update(id: number, patch: Partial<Route>): void {
    const r = this.routes.get(id);
    if (!r) return;
    Object.assign(r, patch);
    this.invalidate();
  }

  path(net: Network, r: Route): RoutePath {
    const key = `${net.version}|${r.cls}|${r.stops.join(',')}`;
    const c = this.cache.get(r.id);
    if (c && c.key === key) return c.path;
    // Prefer built track: a route keeps running on what exists while a shortcut is planned or
    // under construction, and switches over once it opens. Otherwise show the planned path.
    const built = findRoutePath(net, r.cls, r.stops, (id) => net.edges.get(id)?.status === 'built');
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
      if (s.cars < r.cars) return { ok: false, reason: `${s.name}'s platform is too short for ${r.cars}-car trains` };
    }
    return { ok: true };
  }

  nextColor(): string {
    const used = new Set(this.list().map((r) => r.color));
    return ROUTE_COLORS.find((c) => !used.has(c)) ?? ROUTE_COLORS[this.routes.size % ROUTE_COLORS.length];
  }

  nextBullet(): string {
    const used = new Set(this.list().map((r) => r.bullet));
    for (const c of 'ABCDEFGHJKLMNPQRSTUVWXYZ') if (!used.has(c)) return c;
    for (let i = 1; i < 100; i++) if (!used.has(String(i))) return String(i);
    return '?';
  }

  toData(): { routes: Route[]; nextId: number } {
    return { routes: JSON.parse(JSON.stringify(this.list())), nextId: this.nextId };
  }

  load(d: { routes: Route[]; nextId: number }): void {
    this.routes.clear();
    for (const r of d.routes) this.routes.set(r.id, { ...r, headways: { ...r.headways }, stops: [...r.stops] });
    this.nextId = d.nextId;
    this.invalidate();
  }
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
  return r.cars * TRAINS[r.cls].carLength;
}

export function maxCarsFor(net: Network, r: Route): number {
  let m = STATION.cars[r.cls].max;
  for (const sid of r.stops) {
    const s = net.stations.get(sid);
    if (s) m = Math.min(m, s.cars);
  }
  return m;
}
