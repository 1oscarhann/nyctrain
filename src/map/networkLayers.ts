/**
 * Track and route lines as MapLibre line layers.
 *
 * Every edge is split where its level changes (ramps change style half way). Built track with no
 * route shows in muted grey with its level styling; routes draw over it in their own colours.
 * Where routes share track they are drawn as parallel lines with per-feature `line-offset`,
 * in a consistent order along the trunk so lines never swap sides.
 *
 * Four-track sections (v2, docs/v2/express-quad.md §2.5, §4.10): each pair is pushed a few pixels
 * away from the other (on top of their 9 m), so the local and express bundles never overlap; an
 * unrouted built quad shows as four thin rails.
 */
import type { GeoJSONSource, Map as MLMap, LineLayerSpecification } from 'maplibre-gl';

import type { Feature, FeatureCollection, LineString } from 'geojson';
import { MAP, QUAD, type TrackLevel } from '../balance';
import type { Game, Selection } from '../core/game';
import { otherEnd } from '../construction/geometry';
import { edgeReport } from '../construction/validate';
import { progress } from '../construction/blueprint';
import type { Network } from '../construction/network';
import type { TrackEdge } from '../construction/types';
import { slicePolyline, toLonLatLine } from './polyline';
import type { Route } from '../routes/types';

export const NETWORK_SOURCE = 'hw-network';
export const ROUTE_SOURCE = 'hw-routes';
export const HILITE_SOURCE = 'hw-hilite';

const MUTED = '#8E99A5';
const AMBER = '#FFC24A';
const RED = '#FF5D5D';

/** Line widths and offsets scale with zoom; deck.gl layers use lineScale() to match. */
const ZOOM_SCALE: [number, number][] = [
  [10, 0.55],
  [13, 1],
  [16, 1.5],
];
const W = (base: number) => ['interpolate', ['linear'], ['zoom'], ...ZOOM_SCALE.flatMap(([z, k]) => [z, base * k])] as never;

export function lineScale(zoom: number): number {
  if (zoom <= ZOOM_SCALE[0][0]) return ZOOM_SCALE[0][1];
  for (let i = 0; i + 1 < ZOOM_SCALE.length; i++) {
    const [z0, k0] = ZOOM_SCALE[i];
    const [z1, k1] = ZOOM_SCALE[i + 1];
    if (zoom <= z1) return k0 + ((zoom - z0) / (z1 - z0)) * (k1 - k0);
  }
  return ZOOM_SCALE[ZOOM_SCALE.length - 1][1];
}

interface HalfPiece {
  edge: number;
  s0: number;
  s1: number;
  level: TrackLevel;
}

/** Split an edge (or part of it) into pieces at the level change. */
export function edgePieces(net: Network, edgeId: number, s0 = 0, s1?: number): HalfPiece[] {
  const e = net.edges.get(edgeId)!;
  const L = net.geom(edgeId).length;
  const end = s1 ?? L;
  const la = net.nodes.get(e.a)!.level;
  const lb = net.nodes.get(e.b)!.level;
  if (la === lb) return [{ edge: edgeId, s0, s1: end, level: la }];
  const mid = L / 2;
  const out: HalfPiece[] = [];
  if (s0 < mid) out.push({ edge: edgeId, s0, s1: Math.min(mid, end), level: la });
  if (end > mid) out.push({ edge: edgeId, s0: Math.max(mid, s0), s1: end, level: lb });
  return out;
}

/**
 * Orient edges consistently along chains: walking through a node onto an aligned edge keeps the
 * same direction. Returns true for edges whose oriented direction is b→a.
 */
export function orientEdges(net: Network): Map<number, boolean> {
  const flip = new Map<number, boolean>();
  const ALIGN = Math.cos((25 * Math.PI) / 180);
  const ids = [...net.edges.keys()].sort((a, b) => a - b);
  for (const start of ids) {
    if (flip.has(start)) continue;
    flip.set(start, false);
    const stack = [start];
    while (stack.length) {
      const eid = stack.pop()!;
      const e = net.edges.get(eid)!;
      const f = flip.get(eid)!;
      // Oriented end node (where travel arrives) and start node.
      for (const [node, arriving] of [
        [f ? e.a : e.b, true],
        [f ? e.b : e.a, false],
      ] as [number, boolean][]) {
        const [hx, hy] = net.departHeading(eid, node);
        for (const oid of net.incident(node)) {
          if (oid === eid || flip.has(oid)) continue;
          const [ox, oy] = net.departHeading(oid, node);
          // Aligned continuation: headings leaving the node point opposite ways.
          if (-(hx * ox + hy * oy) < ALIGN) continue;
          const o = net.edges.get(oid)!;
          // If we arrive at `node` along e, o must depart from node (o's oriented start = node).
          const oStartsAtA = o.a === node;
          flip.set(oid, arriving ? !oStartsAtA : oStartsAtA);
          stack.push(oid);
        }
      }
    }
  }
  return flip;
}

/**
 * Pixel push of each four-track group's pairs (at line scale 1): half its widest route bundle, half
 * a line and half the gap between the pairs. Keyed by quad group id.
 */
export function quadOffsets(net: Network, routesOnEdge: Map<number, readonly unknown[]>): Map<number, number> {
  const Q = new Map<number, number>();
  for (const e of net.edges.values()) {
    const t = e.quad;
    if (!t || t.role === 'link') continue;
    const k = Math.max(1, routesOnEdge.get(e.id)?.length ?? 0);
    const q = ((k - 1) * MAP.interlineSpacingPx) / 2 + MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2;
    Q.set(t.g, Math.max(Q.get(t.g) ?? 0, q));
  }
  return Q;
}

/**
 * An edge's pair offset in px, in its own a→b frame (positive = right of a→b, MapLibre's
 * `line-offset` sign): `away` points away from the partner pair. 0 off four-track sections and on
 * connectors. The drawn offset is −this when the edge is drawn b→a (orientEdges).
 */
export function pairOffsetAB(e: TrackEdge, Q: Map<number, number>): number {
  return e.quad?.away ? e.quad.away * (Q.get(e.quad.g) ?? 0) : 0;
}

export interface RouteDrawInfo {
  route: Route;
  operational: boolean;
}

export class NetworkLayers {
  private hatchFrame = 0;
  private hatchTimer: number | null = null;
  /** Elevated pieces for the 3D renderer: [lon, lat, z] paths with colour/offset. */
  elevated3d: { path: [number, number, number][]; color: [number, number, number, number]; offset: number; casing: boolean }[] = [];
  /** Construction labels for deck.gl. */
  constructionLabels: { pos: [number, number]; text: string }[] = [];
  /** Interline offset (px) of each route on each edge, for trains. key = `${edge}:${route}` */
  routeOffsets = new Map<string, number>();
  /** Edge orientation flags (true = drawn b→a). */
  flips = new Map<number, boolean>();
  /** Four-track pair push per quad group, px at line scale 1 (station capsules use it). */
  quadOffsets = new Map<number, number>();

  constructor(
    private map: MLMap,
    private game: Game,
  ) {
    this.addHatchImages();
    this.addLayers();
  }

  private addHatchImages(): void {
    for (let k = 0; k < 4; k++) {
      const w = 16, h = 8;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'rgba(255,194,74,0.22)';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 3;
      for (let x = -16; x < 32; x += 8) {
        const o = x + k * 2;
        ctx.beginPath();
        ctx.moveTo(o, h + 1);
        ctx.lineTo(o + h + 2, -1);
        ctx.stroke();
      }
      const img = ctx.getImageData(0, 0, w, h);
      this.map.addImage(`hw-hatch-${k}`, { width: w, height: h, data: new Uint8Array(img.data.buffer) });
    }
  }

  private addLayers(): void {
    const map = this.map;
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    map.addSource(NETWORK_SOURCE, { type: 'geojson', data: empty });
    map.addSource(ROUTE_SOURCE, { type: 'geojson', data: empty });
    map.addSource(HILITE_SOURCE, { type: 'geojson', data: empty });
    const add = (l: LineLayerSpecification) => map.addLayer(l);
    const base = { type: 'line' as const, layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const } };
    const built = (level: TrackLevel): unknown[] => ['all', ['==', ['get', 'status'], 'built'], ['==', ['get', 'level'], level], ['!', ['get', 'routed']], ['!', ['get', 'quad']]];
    const builtQuad = (level: TrackLevel): unknown[] => ['all', ['==', ['get', 'status'], 'built'], ['==', ['get', 'level'], level], ['!', ['get', 'routed']], ['get', 'quad']];
    const elevatedVisible = ['!', ['get', 'hide3d']];
    // Four-track pairs are pushed apart by `pairOff` px (zoom-scaled like the route offsets).
    const pairOff = ['interpolate', ['linear'], ['zoom'], ...ZOOM_SCALE.flatMap(([z, k]) => [z, ['*', ['get', 'pairOff'], k]])] as never;

    // Selection glow sits under everything.
    add({
      ...base,
      id: 'hw-hilite',
      source: HILITE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': AMBER, 'line-opacity': 0.28, 'line-width': W(11), 'line-blur': 4 },
    });

    // ---- built track without routes
    add({ ...base, id: 'hw-track-elevated-casing', source: NETWORK_SOURCE, filter: ['all', built('elevated'), elevatedVisible] as never, paint: { 'line-color': '#C9D1D9', 'line-width': W(5.5) } });
    add({ ...base, id: 'hw-track-elevated', source: NETWORK_SOURCE, filter: ['all', built('elevated'), elevatedVisible] as never, paint: { 'line-color': MUTED, 'line-width': W(3) } });
    add({ ...base, id: 'hw-track-at-grade', source: NETWORK_SOURCE, filter: built('at-grade') as never, paint: { 'line-color': MUTED, 'line-width': W(3) } });
    add({ ...base, id: 'hw-track-cut', source: NETWORK_SOURCE, filter: built('cut-and-cover') as never, paint: { 'line-color': MUTED, 'line-width': W(3), 'line-dasharray': [3, 1.6] } });
    add({
      ...base,
      id: 'hw-track-deep',
      source: NETWORK_SOURCE,
      filter: built('deep') as never,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': MUTED, 'line-width': W(3.4), 'line-dasharray': [0.05, 1.8], 'line-opacity': 0.6 },
    });
    // ---- built four-track pairs without routes: two thin rails per pair (four in all)
    const rails = (extra: Record<string, unknown> = {}) => ({ 'line-color': MUTED, 'line-width': W(QUAD.railWidthPx), 'line-gap-width': W(QUAD.railGapPx), 'line-offset': pairOff, ...extra });
    add({ ...base, id: 'hw-quad-elevated', source: NETWORK_SOURCE, filter: ['all', builtQuad('elevated'), elevatedVisible] as never, paint: rails({ 'line-color': '#C9D1D9' }) as never });
    add({ ...base, id: 'hw-quad-at-grade', source: NETWORK_SOURCE, filter: builtQuad('at-grade') as never, paint: rails() as never });
    add({ ...base, id: 'hw-quad-cut', source: NETWORK_SOURCE, filter: builtQuad('cut-and-cover') as never, paint: rails({ 'line-dasharray': [3, 1.6] }) as never });
    add({ ...base, id: 'hw-quad-deep', source: NETWORK_SOURCE, filter: builtQuad('deep') as never, paint: rails({ 'line-dasharray': [1.2, 1.4], 'line-opacity': 0.7 }) as never });

    // ---- under construction: animated amber hatching
    add({ ...base, id: 'hw-construct-frame', source: NETWORK_SOURCE, filter: ['==', ['get', 'status'], 'construction'], paint: { 'line-color': AMBER, 'line-opacity': 0.35, 'line-width': W(8), 'line-offset': pairOff } });
    for (let k = 0; k < 4; k++) {
      add({
        ...base,
        id: `hw-construct-${k}`,
        source: NETWORK_SOURCE,
        filter: ['==', ['get', 'status'], 'construction'],
        paint: { 'line-pattern': `hw-hatch-${k}`, 'line-width': W(6), 'line-offset': pairOff, 'line-opacity': k === 0 ? 1 : 0, 'line-opacity-transition': { duration: 0, delay: 0 } },
      });
    }

    // ---- routes (interlined)
    const routeLevel = (level: TrackLevel) => ['==', ['get', 'level'], level];
    const routePaint = (extra: Record<string, unknown> = {}) => ({
      'line-color': ['get', 'color'],
      'line-offset': ['interpolate', ['linear'], ['zoom'], ...ZOOM_SCALE.flatMap(([z, k]) => [z, ['*', ['get', 'offset'], k]])],
      'line-width': W(MAP.routeLineWidthPx),
      'line-opacity': ['get', 'opacity'],
      ...extra,
    });
    add({ ...base, id: 'hw-route-elevated-casing', source: ROUTE_SOURCE, filter: ['all', routeLevel('elevated'), elevatedVisible] as never, paint: { ...routePaint(), 'line-color': '#D5DCE3', 'line-width': W(MAP.routeLineWidthPx + 3) } as never });
    add({ ...base, id: 'hw-route-elevated', source: ROUTE_SOURCE, filter: ['all', routeLevel('elevated'), elevatedVisible] as never, paint: routePaint() as never });
    add({ ...base, id: 'hw-route-at-grade', source: ROUTE_SOURCE, filter: routeLevel('at-grade') as never, paint: routePaint() as never });
    add({ ...base, id: 'hw-route-cut', source: ROUTE_SOURCE, filter: routeLevel('cut-and-cover') as never, paint: routePaint({ 'line-dasharray': [3, 1.6] }) as never });
    add({
      ...base,
      id: 'hw-route-deep',
      source: ROUTE_SOURCE,
      filter: routeLevel('deep') as never,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: routePaint({ 'line-dasharray': [0.05, 1.7], 'line-opacity': ['*', ['get', 'opacity'], 0.6] }) as never,
    });

    // ---- blueprint on top so plans are always visible
    add({
      ...base,
      id: 'hw-blueprint',
      source: NETWORK_SOURCE,
      filter: ['all', ['==', ['get', 'status'], 'blueprint'], ['get', 'valid']],
      paint: { 'line-color': '#FFFFFF', 'line-opacity': 0.5, 'line-width': W(3), 'line-dasharray': [2, 1.4], 'line-offset': pairOff },
    });
    add({
      ...base,
      id: 'hw-blueprint-invalid',
      source: NETWORK_SOURCE,
      filter: ['all', ['==', ['get', 'status'], 'blueprint'], ['!', ['get', 'valid']]],
      paint: { 'line-color': RED, 'line-opacity': 0.95, 'line-width': W(3.4), 'line-dasharray': [2, 1.4], 'line-offset': pairOff },
    });
  }

  /** Rebuild all line features from the game state. */
  update(routes: RouteDrawInfo[], is3D: boolean): void {
    const game = this.game;
    const net = game.network;
    const features: Feature<LineString>[] = [];
    this.constructionLabels = [];
    this.elevated3d = [];
    this.routeOffsets.clear();
    const flips = orientEdges(net);
    this.flips = flips;

    // Which parts of which edges carry routes, in a consistent global order.
    const routesOnEdge = new Map<number, { route: Route; operational: boolean; u0: number; u1: number }[]>();
    const sorted = [...routes].sort((a, b) => a.route.id - b.route.id);
    for (const info of sorted) {
      const p = game.routes.path(net, info.route);
      if (!p.ok) continue;
      for (const leg of p.legs) {
        let l = routesOnEdge.get(leg.edge);
        if (!l) routesOnEdge.set(leg.edge, (l = []));
        const u0 = Math.min(leg.u0, leg.u1), u1 = Math.max(leg.u0, leg.u1);
        const existing = l.find((x) => x.route.id === info.route.id);
        if (existing) {
          existing.u0 = Math.min(existing.u0, u0);
          existing.u1 = Math.max(existing.u1, u1);
        } else l.push({ route: info.route, operational: info.operational, u0, u1 });
      }
    }
    // Four-track pairs: each group's push (px), and every pair edge's drawn offset.
    const Q = quadOffsets(net, routesOnEdge);
    this.quadOffsets = Q;
    const drawnPairOff = (e: TrackEdge) => {
      const pab = pairOffsetAB(e, Q);
      return flips.get(e.id) ? -pab : pab;
    };

    for (const e of net.edges.values()) {
      const g = net.geom(e.id);
      const L = g.length;
      const flip = flips.get(e.id) ?? false;
      const onEdge = routesOnEdge.get(e.id) ?? [];
      const coveredFully = onEdge.some((r) => r.u0 <= 1 && r.u1 >= L - 1);
      const valid = e.status !== 'blueprint' || edgeReport(net, e.id, game.terrain).ok;
      const quad = !!e.quad && e.quad.role !== 'link';
      const pairOff = drawnPairOff(e);
      for (const piece of edgePieces(net, e.id)) {
        let pts = slicePolyline(g.xs, g.ys, g.cum, piece.s0, piece.s1);
        if (flip) pts = pts.reverse();
        const coords = toLonLatLine(pts);
        const hide3d = is3D && piece.level === 'elevated' && e.status === 'built';
        features.push({
          type: 'Feature',
          properties: { eid: e.id, level: piece.level, status: e.status, cls: e.cls, valid, routed: coveredFully && e.status === 'built', hide3d, quad, pairOff },
          geometry: { type: 'LineString', coordinates: coords },
        });
        if (hide3d && !coveredFully) {
          this.elevated3d.push({ path: this.lift(pts, net, e.id, piece.s0, piece.s1, flip), color: [142, 153, 165, 255], offset: pairOff, casing: true });
        }
      }
      if (e.status === 'construction') {
        const mid = sampleMid(g.xs, g.ys, g.cum);
        this.constructionLabels.push({ pos: mid, text: `${Math.floor(progress(e, game.time) * 100)}%` });
      }
    }

    // Route features with interline offsets.
    const routeFeatures: Feature<LineString>[] = [];
    const spacing = MAP.interlineSpacingPx;
    for (const [edgeId, list] of routesOnEdge) {
      const g = net.geom(edgeId);
      const flip = flips.get(edgeId) ?? false;
      const k = list.length;
      // On a four-track pair the bundle is centred on the pair's push.
      const base = drawnPairOff(net.edges.get(edgeId)!);
      list.forEach((r, i) => {
        const offset = base + (i - (k - 1) / 2) * spacing;
        this.routeOffsets.set(`${edgeId}:${r.route.id}`, flip ? -offset : offset);
        for (const piece of edgePieces(net, edgeId, r.u0, r.u1)) {
          let pts = slicePolyline(g.xs, g.ys, g.cum, piece.s0, piece.s1);
          if (flip) pts = pts.reverse();
          const e = net.edges.get(edgeId)!;
          const hide3d = is3D && piece.level === 'elevated' && e.status === 'built';
          routeFeatures.push({
            type: 'Feature',
            properties: { route: r.route.id, color: r.route.color, offset, level: piece.level, opacity: r.operational ? 1 : 0.45, hide3d },
            geometry: { type: 'LineString', coordinates: toLonLatLine(pts) },
          });
          if (hide3d) {
            const rgb = hexRgb(r.route.color);
            this.elevated3d.push({
              path: this.lift(pts, net, edgeId, piece.s0, piece.s1, flip),
              color: [rgb[0], rgb[1], rgb[2], r.operational ? 255 : 115],
              offset,
              casing: true,
            });
          }
        }
      });
    }

    (this.map.getSource(NETWORK_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    (this.map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: routeFeatures });
    this.ensureHatchAnimation(net);
  }

  /** Lift a local polyline to [lon, lat, z] using the edge's height profile (elevated only). */
  private lift(pts: [number, number][], net: Network, edgeId: number, s0: number, s1: number, flip: boolean): [number, number, number][] {
    const n = pts.length;
    let acc = 0;
    const out: [number, number, number][] = [];
    const total = Math.max(1e-6, s1 - s0);
    for (let i = 0; i < n; i++) {
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const f = Math.min(1, acc / total);
      const s = flip ? s1 - f * (s1 - s0) : s0 + f * (s1 - s0);
      const [lon, lat] = toLonLatLine([pts[i]])[0];
      out.push([lon, lat, Math.max(0, net.heightAt(edgeId, s))]);
    }
    return out;
  }

  private ensureHatchAnimation(net: Network): void {
    const any = [...net.edges.values()].some((e) => e.status === 'construction');
    if (any && this.hatchTimer === null) {
      this.hatchTimer = window.setInterval(() => {
        const prev = this.hatchFrame;
        this.hatchFrame = (this.hatchFrame + 1) % 4;
        this.map.setPaintProperty(`hw-construct-${prev}`, 'line-opacity', 0);
        this.map.setPaintProperty(`hw-construct-${this.hatchFrame}`, 'line-opacity', 1);
      }, 140);
    } else if (!any && this.hatchTimer !== null) {
      clearInterval(this.hatchTimer);
      this.hatchTimer = null;
    }
  }

  /** Amber glow under the selected edge or route. */
  highlight(sel: Selection | null): void {
    const net = this.game.network;
    const features: Feature<LineString>[] = [];
    const addEdge = (eid: number, s0 = 0, s1?: number) => {
      if (!net.edges.has(eid)) return;
      const g = net.geom(eid);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: toLonLatLine(slicePolyline(g.xs, g.ys, g.cum, s0, s1 ?? g.length)) },
      });
    };
    if (sel?.kind === 'edge') addEdge(sel.id);
    if (sel?.kind === 'route') {
      const r = this.game.routes.get(sel.id);
      if (r) {
        const p = this.game.routes.path(net, r);
        for (const l of p.legs) addEdge(l.edge, Math.min(l.u0, l.u1), Math.max(l.u0, l.u1));
      }
    }
    (this.map.getSource(HILITE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }
}

function sampleMid(xs: Float64Array, ys: Float64Array, cum: Float64Array): [number, number] {
  const L = cum[cum.length - 1];
  const pts = slicePolyline(xs, ys, cum, L / 2, L / 2 + 0.01);
  return toLonLatLine([pts[0]])[0];
}

export function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export { otherEnd };
