/**
 * Express service on four-track sections (v2, docs/v2/express-quad.md §4.7): the stations a route
 * passes (served or skipped, on its own track or beside it on the other pair), skip and serve
 * edits, the Express pattern and All stops buttons, and which platform of a cross-platform pair a
 * click picks. Pure functions of the network and a route's stops and path.
 */
import { QUAD, type TrackClass } from '../balance';
import { projectOnPolyline } from '../construction/geometry';
import type { Network } from '../construction/network';
import type { QuadRole, Station } from '../construction/types';
import { findRoutePath } from './pathfind';
import type { RoutePath } from './types';

export interface AlongStation {
  /** Platform the route uses (or would use if it stopped there). */
  station: number;
  /** The other platform of a cross-platform pair. */
  partner?: number;
  /** Distance along the direction-0 path, m. */
  s: number;
  /** The route stops here (at `station`). */
  served: boolean;
  /** First or last stop. */
  terminal: boolean;
  /** On the route's own track, or beside it on the parallel pair (stopping needs crossovers). */
  where: 'on-track' | 'beside';
}

/** Which part of a four-track section a station's platform is on (null on ordinary track). */
export function quadRole(net: Network, stationId: number): QuadRole | null {
  const s = net.stations.get(stationId);
  return (s && net.edges.get(s.edge)?.quad?.role) ?? null;
}

/** The cross-platform partner of a platform, if it exists. */
export function partnerOf(net: Network, stationId: number): number | null {
  const p = net.stations.get(stationId)?.pair;
  return p !== undefined && net.stations.has(p) ? p : null;
}

/**
 * One key per station complex: the lower id of a cross-platform pair whose platforms are both
 * built (as the compiled network pairs them), else the station's own id. Value capture
 * (servedStations) books a pair's levy under this id.
 */
export function pairKeyId(net: Network, stationId: number): number {
  const s = net.stations.get(stationId);
  const p = s?.pair !== undefined ? net.stations.get(s.pair) : undefined;
  return s && p && s.status === 'built' && p.status === 'built' ? Math.min(s.id, p.id) : stationId;
}

/**
 * The platform a route-tool click picks: for a cross-platform pair the express platform when the
 * draft is an express (the local one with Alt), and the other way round for a local draft. A lone
 * platform is itself.
 */
export function choosePlatform(net: Network, stationId: number, express: boolean, alt: boolean): number {
  const p = partnerOf(net, stationId);
  if (p === null) return stationId;
  const want: QuadRole = express !== alt ? 'express' : 'local';
  if (quadRole(net, stationId) === want) return stationId;
  if (quadRole(net, p) === want) return p;
  return stationId;
}

/**
 * Every station along a route's path, in direction-0 order: platforms on the path's own track
 * (`on-track`) and, on four-track sections, platforms on the other pair beside it (`beside`). A
 * cross-platform pair is one entry (on-track preferred; `partner` is the other platform).
 */
export function stationsAlongPath(net: Network, stops: readonly number[], path: RoutePath): AlongStation[] {
  if (!path.ok || !path.legs.length) return [];
  const byEdge = new Map<number, Station[]>();
  for (const st of net.stations.values()) {
    const l = byEdge.get(st.edge);
    if (l) l.push(st);
    else byEdge.set(st.edge, [st]);
  }
  // Pair edges of each quad group by role, for the platforms beside the path (indexed once).
  let pairEdges: Map<number, { role: QuadRole; edge: number }[]> | null = null;
  const pairEdgesOf = (g: number) => {
    if (!pairEdges) {
      pairEdges = new Map();
      for (const e of net.edges.values()) {
        const t = e.quad;
        if (!t || t.role === 'link' || !byEdge.has(e.id)) continue;
        const l = pairEdges.get(t.g);
        if (l) l.push({ role: t.role, edge: e.id });
        else pairEdges.set(t.g, [{ role: t.role, edge: e.id }]);
      }
    }
    return pairEdges.get(g) ?? [];
  };
  const reach = QUAD.spacing + QUAD.partnerTolerance;
  const found = new Map<number, { id: number; s: number; where: 'on-track' | 'beside' }>();
  const add = (id: number, s: number, where: 'on-track' | 'beside') => {
    const p = partnerOf(net, id);
    const key = p === null ? id : Math.min(id, p);
    const cur = found.get(key);
    if (!cur || (cur.where === 'beside' && where === 'on-track') || (cur.where === where && s < cur.s)) found.set(key, { id, s, where });
  };
  let s0 = 0;
  for (const leg of path.legs) {
    const lo = Math.min(leg.u0, leg.u1), hi = Math.max(leg.u0, leg.u1);
    const at = (u: number) => s0 + (leg.dir === 0 ? u - lo : hi - u);
    for (const st of byEdge.get(leg.edge) ?? []) if (st.u >= lo - 0.5 && st.u <= hi + 0.5) add(st.id, at(Math.min(hi, Math.max(lo, st.u))), 'on-track');
    const t = net.edges.get(leg.edge)?.quad;
    if (t && t.role !== 'link') {
      const g = net.geom(leg.edge);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < g.xs.length; i++) {
        x0 = Math.min(x0, g.xs[i]);
        x1 = Math.max(x1, g.xs[i]);
        y0 = Math.min(y0, g.ys[i]);
        y1 = Math.max(y1, g.ys[i]);
      }
      for (const o of pairEdgesOf(t.g)) {
        if (o.role === t.role) continue;
        for (const st of byEdge.get(o.edge) ?? []) {
          const p = net.stationPos(st);
          if (p.x < x0 - reach || p.x > x1 + reach || p.y < y0 - reach || p.y > y1 + reach) continue;
          const pr = projectOnPolyline(g.xs, g.ys, g.cum, p.x, p.y);
          if (pr.d > reach || pr.s < lo - 1 || pr.s > hi + 1) continue;
          add(st.id, at(Math.min(hi, Math.max(lo, pr.s))), 'beside');
        }
      }
    }
    s0 += hi - lo;
  }
  const first = stops[0], last = stops[stops.length - 1];
  const stopIdx = new Map(stops.map((id, i) => [id, i]));
  const out: AlongStation[] = [];
  for (const f of found.values()) {
    const p = partnerOf(net, f.id);
    // The served platform of a pair (the route may stop at either).
    let station = f.id;
    if (!stopIdx.has(station) && p !== null && stopIdx.has(p)) station = p;
    const i = stopIdx.get(station);
    const served = i !== undefined;
    const partner = p === null ? undefined : station === f.id ? p : f.id;
    out.push({
      station,
      ...(partner !== undefined ? { partner } : {}),
      // A served stop sits exactly where the path says.
      s: served && path.stopS[i!] !== undefined ? path.stopS[i!] : f.s,
      served,
      terminal: station === first || station === last,
      where: f.where,
    });
  }
  out.sort((a, b) => a.s - b.s || a.station - b.station);
  return out;
}

const alongCache = new Map<number, { key: string; along: AlongStation[] }>();

/** stationsAlongPath for a route, cached per route by the network version, its stops and its path. */
export function stationsAlongRoute(net: Network, routeId: number, stops: readonly number[], path: RoutePath): AlongStation[] {
  const key = `${net.version}|${stops.join(',')}|${path.length}`;
  const c = alongCache.get(routeId);
  if (c && c.key === key) return c.along;
  const along = stationsAlongPath(net, stops, path);
  alongCache.set(routeId, { key, along });
  if (alongCache.size > 64) alongCache.delete(alongCache.keys().next().value!);
  return along;
}

function nameOf(net: Network, id: number): string {
  return net.stations.get(id)?.name ?? 'This station';
}

/**
 * Stop at a station the route passes: it goes in path order (before the first stop further along).
 * The path is checked; a station on the other pair with no crossover to reach it gets a specific
 * error.
 */
export function serveStops(net: Network, cls: TrackClass, stops: readonly number[], path: RoutePath, stationId: number): { stops: number[] } | { error: string } {
  const along = stationsAlongPath(net, stops, path);
  const p = partnerOf(net, stationId);
  const entry = along.find((a) => a.station === stationId || a.partner === stationId || (p !== null && a.station === p));
  if (!entry) return { error: `${nameOf(net, stationId)} isn't on this route's line` };
  if (entry.served) return { stops: [...stops] };
  let at = stops.length - 1;
  for (let i = 1; i < stops.length; i++) {
    if ((path.stopS[i] ?? Infinity) > entry.s) {
      at = i;
      break;
    }
  }
  const next = [...stops.slice(0, at), entry.station, ...stops.slice(at)];
  const res = findRoutePath(net, cls, next);
  if (!res.ok) {
    if (entry.where === 'beside') {
      const pair = quadRole(net, entry.station) === 'express' ? 'express' : 'local';
      return { error: `${nameOf(net, entry.station)} is on the ${pair} pair and no crossover reaches it — add crossovers before and after it (Track tool, 4 tracks, X)` };
    }
    return { error: res.error ?? `No path through ${nameOf(net, entry.station)}` };
  }
  return { stops: next };
}

/**
 * The route tool's click on a station the draft already runs past: stop there in path order, at
 * the platform clicked (a pair's express or local one, as choosePlatform picked it) when the
 * track allows, else at the platform the line passes (serveStops).
 */
export function insertStop(net: Network, cls: TrackClass, stops: readonly number[], path: RoutePath, stationId: number): { stops: number[] } | { error: string } {
  const res = serveStops(net, cls, stops, path, stationId);
  if ('error' in res) return res;
  const p = partnerOf(net, stationId);
  if (p === null || res.stops.includes(stationId)) return res;
  const want = res.stops.map((x) => (x === p ? stationId : x));
  return findRoutePath(net, cls, want).ok ? { stops: want } : res;
}

/** Stop serving a station (either platform of a pair). Terminals can't be skipped. */
export function skipStops(net: Network, stops: readonly number[], stationId: number): { stops: number[] } | { error: string } {
  const p = partnerOf(net, stationId);
  const i = stops.findIndex((s) => s === stationId || (p !== null && s === p));
  if (i < 0) return { stops: [...stops] };
  if (i === 0 || i === stops.length - 1) return { error: "Terminals can't be skipped — shorten the route instead" };
  return { stops: stops.filter((_, k) => k !== i) };
}

/**
 * The Express pattern: on four-track sections, local platforms of cross-platform pairs become their
 * express partners and local-only stops are dropped; terminals are never dropped (a terminal pair
 * moves to its express platform).
 */
export function expressPattern(net: Network, stops: readonly number[]): number[] {
  const out: number[] = [];
  stops.forEach((id, i) => {
    const terminal = i === 0 || i === stops.length - 1;
    if (quadRole(net, id) !== 'local') {
      out.push(id);
      return;
    }
    const p = partnerOf(net, id);
    if (p !== null && quadRole(net, p) === 'express') out.push(p);
    else if (terminal) out.push(id);
  });
  return out;
}

/**
 * All stops: every station along the route's line, choosing the local platform of each
 * cross-platform pair (terminal pairs too, so it undoes the Express pattern). The route keeps its
 * terminals.
 */
export function allStopsPattern(net: Network, _cls: TrackClass, stops: readonly number[], path: RoutePath): number[] {
  const along = stationsAlongPath(net, stops, path);
  const first = stops[0], last = stops[stops.length - 1];
  const out: number[] = [];
  for (const a of along) {
    let id = a.station;
    const p = partnerOf(net, id);
    if (p !== null && quadRole(net, id) !== 'local' && quadRole(net, p) === 'local') id = p;
    const isTerminal = a.station === first || a.station === last;
    // Nothing outside the terminals (a path's terminal extension never adds stations).
    if (!isTerminal && (a.s < (path.stopS[0] ?? 0) || a.s > (path.stopS[path.stopS.length - 1] ?? Infinity))) continue;
    if (!out.includes(id)) out.push(id);
  }
  if (!out.length) return [...stops];
  return out;
}
