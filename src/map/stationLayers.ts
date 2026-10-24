/**
 * Stations (deck.gl): small off-white dots with a thin soft outline, sized by daily ridership.
 * Interchanges are white pills joining the platforms. Crowded stations pulse amber, then red.
 * A cross-platform station (v2, docs/v2/express-quad.md §2.5) is one wide capsule laid across the
 * four-track section from one pair's route bundle to the other's, with one label.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { MAP, QUAD } from '../balance';
import { metresPerPixel, toLonLat } from '../core/geo';
import { lineScale } from './networkLayers';
import type { Game } from '../core/game';
import { progress } from '../construction/blueprint';
import { computeInterchanges } from '../routes/interchange';
import { ADDITIVE, GLOW_MIN, STATION_GLOW } from '../cinematic/glow';
import { city } from '../cities';

/** Station dot look: small and quiet so the route lines lead (radii in pixels). */
const DOT_MIN = 3.5;
const DOT_GROW = 4;
const DOT_FILL: [number, number, number, number] = [226, 231, 236, 225];
const DOT_FILL_BLUEPRINT: [number, number, number, number] = [226, 231, 236, 110];
const DOT_OUTLINE: [number, number, number, number] = [22, 27, 33, 170];
const DOT_OUTLINE_PX = 1.25;
const dotRadius = (boardings: number) => DOT_MIN + Math.min(DOT_GROW, Math.sqrt(boardings / 4000));

/** London style (theme 'tfl'): ticks for one-line stations, white rings for interchanges. */
const TFL_RING_FILL: [number, number, number, number] = [255, 255, 255, 255];
const TFL_RING_LINE: [number, number, number, number] = [10, 10, 12, 255];
const TFL_RING_PX = 4.5;
const TFL_RING_LINE_PX = 2;
/** How far a tick sticks out beyond the line's edge, px. */
const TFL_TICK_PX = 6;

function hexRgb(hex: string): [number, number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? [n >> 16, (n >> 8) & 255, n & 255, 255] : [255, 255, 255, 255];
}

export interface StationStat {
  /** Daily boardings (real people, scaled up). */
  boardings: number;
  /** People waiting right now (scaled). */
  waiting: number;
  /** Waiting relative to what one train can carry: >1 means people get left behind. */
  crowding: number;
}

interface StationDatum {
  id: number;
  pos: [number, number, number];
  name: string;
  status: string;
  radius: number;
  crowding: number;
  progress: number;
  /**
   * A lone platform on a four-track pair (a local-only stop) sits on its pair's route bundle,
   * which the map pushes a few px away from the other pair: local metres, the unit vector to the
   * pushed side, and the quad group.
   */
  push?: { x: number; y: number; ax: number; ay: number; g: number };
  /** Local metres and the unit normal of the track there (London-style ticks). */
  lx?: number;
  ly?: number;
  nx?: number;
  ny?: number;
}

interface TickDatum {
  d: StationDatum;
  color: [number, number, number, number];
}

interface PillDatum {
  path: [number, number, number][];
  width: number;
}

/** A cross-platform pair drawn as one capsule across the four-track section. */
interface PairDatum extends StationDatum {
  /** The other platform (id is the lower one). */
  b: number;
  /** Midpoint of the platforms, local metres, and the height there. */
  cx: number;
  cy: number;
  z: number;
  /** Unit vector across the track, from platform a to platform b. */
  nx: number;
  ny: number;
  /** Half the distance between the platforms, m. */
  half: number;
  /** Quad group (its pixel push decides how far the capsule reaches). */
  g: number;
}

const DEPTH_OFF = { depthCompare: 'always', depthWriteEnabled: false } as const;

export class StationLayers {
  private data: StationDatum[] = [];
  private pills: PillDatum[] = [];
  private pairs: PairDatum[] = [];
  /** London style: one-line stations drawn as ticks (the rest stay discs, drawn as rings). */
  private ticks: TickDatum[] = [];
  private tickIds = new Set<number>();
  /** Four-track pair push per quad group (px at line scale 1), from NetworkLayers. */
  private quadQ = new Map<number, number>();
  stats = new Map<number, StationStat>();
  /** Stations closed by an incident (police activity): red outline, "· CLOSED" label. */
  closed = new Set<number>();
  private version = 0;
  /** Bumped when the stations or the closures change (not by the per-snapshot stats). */
  private layoutVersion = 0;

  /** Replace the closed set (from the active alerts). */
  setClosed(ids: Set<number>): void {
    if (ids.size === this.closed.size && [...ids].every((id) => this.closed.has(id))) return;
    this.closed = ids;
    this.version++;
    this.layoutVersion++;
  }

  constructor(private game: Game) {}

  update(is3D: boolean, quadQ: Map<number, number> = new Map()): void {
    const net = this.game.network;
    this.quadQ = quadQ;
    const data: StationDatum[] = [];
    const pairs: PairDatum[] = [];
    /** Where a station is drawn: its own circle, or its pair's capsule. */
    const drawnAs = new Map<number, StationDatum>();
    const rank = { blueprint: 0, construction: 1, built: 2 } as Record<string, number>;
    for (const s of net.stations.values()) {
      const q = s.pair !== undefined ? net.stations.get(s.pair) : undefined;
      if (q && q.pair === s.id) {
        if (s.id > q.id) continue; // drawn with its partner
        const pa = net.stationPos(s), pb = net.stationPos(q);
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const d = Math.hypot(dx, dy) || 1;
        const cx = (pa.x + pb.x) / 2, cy = (pa.y + pb.y) / 2;
        const [lon, lat] = toLonLat(cx, cy);
        const z = is3D ? Math.max(0, (net.heightAt(s.edge, s.u) + net.heightAt(q.edge, q.u)) / 2) : 0;
        // The least-built platform says how the station looks.
        const least = rank[s.status] <= rank[q.status] ? s : q;
        const pd: PairDatum = {
          id: s.id,
          b: q.id,
          pos: [lon, lat, z],
          name: s.name,
          status: least.status,
          radius: DOT_MIN,
          crowding: 0,
          progress: progress(least, this.game.time),
          cx,
          cy,
          z,
          nx: dx / d,
          ny: dy / d,
          half: d / 2,
          g: net.edges.get(s.edge)?.quad?.g ?? -1,
        };
        pairs.push(pd);
        drawnAs.set(s.id, pd);
        drawnAs.set(q.id, pd);
        continue;
      }
      const p = net.stationPos(s);
      const [lon, lat] = toLonLat(p.x, p.y);
      const z = is3D ? Math.max(0, net.heightAt(s.edge, s.u)) : 0;
      const dd: StationDatum = { id: s.id, pos: [lon, lat, z], name: s.name, status: s.status, radius: DOT_MIN, crowding: 0, progress: progress(s, this.game.time), lx: p.x, ly: p.y, nx: p.hy, ny: -p.hx };
      const t = net.edges.get(s.edge)?.quad;
      // `away` is to the right of the edge's a→b heading (h); its right normal is (hy, −hx).
      if (t && t.role !== 'link' && t.away) dd.push = { x: p.x, y: p.y, ax: t.away * p.hy, ay: -t.away * p.hx, g: t.g };
      data.push(dd);
      drawnAs.set(s.id, dd);
    }
    this.data = data;
    this.pairs = pairs;
    this.applyStats();
    const ic = computeInterchanges(net);
    const pills: PillDatum[] = [];
    for (const g of ic.groups) {
      // A pair is one node of the interchange (its capsule), not two.
      const pts = [...new Set(g.map((id) => drawnAs.get(id)).filter((x): x is StationDatum => !!x))];
      if (pts.length < 2) continue;
      // Chain the platforms with a minimum spanning tree so pills join neighbours.
      const inTree = new Set([0]);
      while (inTree.size < pts.length) {
        let best: [number, number, number] = [Infinity, -1, -1];
        for (const i of inTree)
          for (let j = 0; j < pts.length; j++) {
            if (inTree.has(j)) continue;
            const d = Math.hypot(pts[i].pos[0] - pts[j].pos[0], (pts[i].pos[1] - pts[j].pos[1]) * 1.3);
            if (d < best[0]) best = [d, i, j];
          }
        inTree.add(best[2]);
        const a = pts[best[1]], b = pts[best[2]];
        pills.push({ path: [a.pos, b.pos], width: Math.max(a.radius, b.radius) * 2 });
      }
    }
    this.pills = pills;
    // London style: a built station served by exactly one route, and not part of an interchange,
    // is a tick in that route's colour on the side of the line.
    this.ticks = [];
    this.tickIds = new Set();
    if (city().theme === 'tfl') {
      const inGroup = new Set(ic.groups.filter((g) => g.length > 1).flat());
      const served = new Map<number, string[]>();
      for (const r of this.game.routes.list()) for (const sid of new Set(r.stops)) (served.get(sid) ?? served.set(sid, []).get(sid)!).push(r.color);
      for (const d of data) {
        const cols = served.get(d.id);
        if (d.status !== 'built' || d.push || inGroup.has(d.id) || !cols || new Set(cols).size !== 1) continue;
        this.ticks.push({ d, color: hexRgb(cols[0]) });
        this.tickIds.add(d.id);
      }
    }
    this.version++;
    this.layoutVersion++;
  }

  /** Sizes and crowding from the stats: a pair by its combined boardings and its more crowded platform. */
  private applyStats(): void {
    for (const d of this.data) {
      const st = this.stats.get(d.id);
      d.radius = dotRadius(st?.boardings ?? 0);
      d.crowding = st?.crowding ?? 0;
    }
    for (const d of this.pairs) {
      const a = this.stats.get(d.id), b = this.stats.get(d.b);
      d.radius = dotRadius((a?.boardings ?? 0) + (b?.boardings ?? 0));
      d.crowding = Math.max(a?.crowding ?? 0, b?.crowding ?? 0);
    }
  }

  /** Update sizes, crowding and progress in place (cheap; called on every snapshot). */
  refreshStats(): void {
    this.applyStats();
    const net = this.game.network;
    for (const d of this.data) {
      const s = net.stations.get(d.id);
      if (s) d.progress = progress(s, this.game.time);
    }
    for (const d of this.pairs) {
      const s = net.stations.get(d.id), q = net.stations.get(d.b);
      if (s && q) d.progress = progress(s.status === 'built' ? q : s, this.game.time);
    }
    this.version++;
  }

  /** Capsule ends: across the track, reaching each pair's route bundle at this zoom. */
  private capsulePath(d: PairDatum, zoom: number): [number, number, number][] {
    const reach = d.half + (this.quadQ.get(d.g) ?? MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2) * lineScale(zoom) * metresPerPixel(zoom);
    const [lon0, lat0] = toLonLat(d.cx - d.nx * reach, d.cy - d.ny * reach);
    const [lon1, lat1] = toLonLat(d.cx + d.nx * reach, d.cy + d.ny * reach);
    return [
      [lon0, lat0, d.z],
      [lon1, lat1, d.z],
    ];
  }

  private allCache: { version: number; all: StationDatum[] } | null = null;

  layers(zoom: number, time: number, glow = 0): Layer[] {
    const pulse = 0.5 + 0.5 * Math.sin(time / 260);
    const tfl = city().theme === 'tfl';
    const showLabels = zoom >= 13.2;
    const zKey = Math.round(zoom * 20);
    const pxPerM = 1 / metresPerPixel(zoom);
    // Labels and halos: lone platforms and pair capsules alike.
    const all: StationDatum[] = this.pairs.length ? [...this.data, ...this.pairs] : this.data;
    const labelOffset = (d: StationDatum): [number, number] => {
      const p = d as PairDatum;
      if (p.b === undefined) return [d.radius + 5, 0];
      // Clear the capsule: its horizontal reach on screen (it lies across the track), plus the radius.
      const reach = (p.half + (this.quadQ.get(p.g) ?? MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2) * lineScale(zoom) * metresPerPixel(zoom)) * pxPerM;
      return [d.radius + 5 + reach * Math.abs(p.nx), 0];
    };
    // Lone platforms on a four-track pair follow their pair's push (zoom-dependent).
    const posOf = (d: StationDatum): [number, number, number] => {
      const q = d.push;
      if (!q) return d.pos;
      const m = (this.quadQ.get(q.g) ?? MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2) * lineScale(zoom) * metresPerPixel(zoom);
      const [lon, lat] = toLonLat(q.x + q.ax * m, q.y + q.ay * m);
      return [lon, lat, d.pos[2]];
    };
    const pairLine = (d: PairDatum): [number, number, number, number] =>
      this.closed.has(d.id) || this.closed.has(d.b) ? [255, 93, 93, 255] : d.status === 'construction' ? [255, 194, 74, 255] : d.status === 'blueprint' ? [255, 255, 255, 140] : DOT_OUTLINE;
    // Cinematic: a warm glow around every built station at night; a closed one (police activity)
    // is dark. The same data object until the stations or the closures change (not every snapshot).
    if (this.allCache?.version !== this.layoutVersion) {
      const closed = (d: StationDatum) => this.closed.has(d.id) || this.closed.has((d as PairDatum).b ?? -1);
      this.allCache = { version: this.layoutVersion, all: all.filter((d) => d.status === 'built' && !closed(d)) };
    }
    const lit = this.allCache.all;
    return [
      // Two soft discs (a wide faint one and a tight one) read as a pool of platform light.
      ...([
        ['station-glow', 7, 0.2],
        ['station-glow-core', 2.5, 0.32],
      ] as const).map(
        ([id, extra, a]) =>
          glow >= GLOW_MIN &&
          lit.length > 0 &&
          new ScatterplotLayer<StationDatum>({
            id,
            data: lit,
            getPosition: posOf,
            getRadius: (d) => d.radius + extra,
            radiusUnits: 'pixels',
            getFillColor: STATION_GLOW,
            opacity: glow * a,
            parameters: ADDITIVE,
            updateTriggers: { getPosition: [this.layoutVersion, zKey], getRadius: this.version },
          }),
      ),
      new PathLayer<PillDatum>({
        id: 'station-pill-outline',
        data: this.pills,
        getPath: (d) => d.path,
        getWidth: (d) => d.width + (tfl ? TFL_RING_LINE_PX : DOT_OUTLINE_PX) * 2,
        widthUnits: 'pixels',
        capRounded: true,
        getColor: tfl ? TFL_RING_LINE : DOT_OUTLINE,
        parameters: DEPTH_OFF,
        updateTriggers: { getPath: this.version, getWidth: this.version },
      }),
      new PathLayer<PillDatum>({
        id: 'station-pill',
        data: this.pills,
        getPath: (d) => d.path,
        getWidth: (d) => d.width,
        widthUnits: 'pixels',
        capRounded: true,
        getColor: tfl ? TFL_RING_FILL : DOT_FILL,
        parameters: DEPTH_OFF,
        updateTriggers: { getPath: this.version, getWidth: this.version },
      }),
      // Cross-platform stations: one capsule across both pairs.
      this.pairs.length > 0 &&
        new PathLayer<PairDatum>({
          id: 'station-pair-outline',
          data: this.pairs,
          getPath: (d) => this.capsulePath(d, zoom),
          getWidth: (d) => d.radius * 2 + (d.status === 'construction' || this.closed.has(d.id) || this.closed.has(d.b) ? 5 : DOT_OUTLINE_PX * 2),
          widthUnits: 'pixels',
          capRounded: true,
          getColor: pairLine,
          parameters: DEPTH_OFF,
          updateTriggers: { getPath: [this.version, zKey], getWidth: this.version, getColor: this.version },
        }),
      this.pairs.length > 0 &&
        new PathLayer<PairDatum>({
          id: 'station-pair',
          data: this.pairs,
          getPath: (d) => this.capsulePath(d, zoom),
          getWidth: (d) => d.radius * 2,
          widthUnits: 'pixels',
          capRounded: true,
          getColor: (d) => (d.status === 'blueprint' ? DOT_FILL_BLUEPRINT : DOT_FILL),
          parameters: DEPTH_OFF,
          updateTriggers: { getPath: [this.version, zKey], getWidth: this.version, getColor: this.version },
        }),
      // Crowding halo
      new ScatterplotLayer<StationDatum>({
        id: 'station-crowd',
        data: all.filter((d) => d.crowding > 0.6 && d.status === 'built'),
        getPosition: posOf,
        getRadius: (d) => d.radius + 3 + pulse * 4,
        radiusUnits: 'pixels',
        getFillColor: (d) => (d.crowding > 1 ? [255, 93, 93, 90 + 80 * pulse] : [255, 194, 74, 70 + 70 * pulse]),
        parameters: DEPTH_OFF,
        updateTriggers: { getPosition: [this.version, zKey], getRadius: [this.version, Math.round(pulse * 20)], getFillColor: [this.version, Math.round(pulse * 20)] },
      }),
      tfl &&
        this.ticks.length > 0 &&
        new PathLayer<TickDatum>({
          id: 'station-ticks',
          data: this.ticks.filter((t) => !this.closed.has(t.d.id)),
          getPath: (t) => {
            const d = t.d;
            const mpp = metresPerPixel(zoom);
            const half = (MAP.routeLineWidthPx * lineScale(zoom)) / 2;
            const [lon1, lat1] = toLonLat(d.lx! + d.nx! * (half + TFL_TICK_PX) * mpp, d.ly! + d.ny! * (half + TFL_TICK_PX) * mpp);
            const [lon0, lat0] = toLonLat(d.lx!, d.ly!);
            return [
              [lon0, lat0, d.pos[2]],
              [lon1, lat1, d.pos[2]],
            ];
          },
          getWidth: () => Math.max(2.5, MAP.routeLineWidthPx * lineScale(zoom) * 0.85),
          widthUnits: 'pixels',
          capRounded: false,
          getColor: (t) => t.color,
          parameters: DEPTH_OFF,
          updateTriggers: { getPath: [this.version, zKey], getWidth: zKey, getColor: this.version },
        }),
      new ScatterplotLayer<StationDatum>({
        id: 'stations',
        data: tfl ? this.data.filter((d) => !this.tickIds.has(d.id) || this.closed.has(d.id)) : this.data,
        getPosition: posOf,
        getRadius: (d) => (tfl && d.status === 'built' ? TFL_RING_PX + (d.radius - DOT_MIN) * 0.4 : d.radius),
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: (d) => (d.status === 'blueprint' ? DOT_FILL_BLUEPRINT : tfl ? TFL_RING_FILL : DOT_FILL),
        getLineColor: (d) => (this.closed.has(d.id) ? [255, 93, 93, 255] : d.status === 'construction' ? [255, 194, 74, 255] : d.status === 'blueprint' ? [255, 255, 255, 140] : tfl ? TFL_RING_LINE : DOT_OUTLINE),
        getLineWidth: (d) => (d.status === 'construction' || this.closed.has(d.id) ? 2.5 : tfl ? TFL_RING_LINE_PX : DOT_OUTLINE_PX),
        lineWidthUnits: 'pixels',
        pickable: true,
        parameters: DEPTH_OFF,
        updateTriggers: { getFillColor: this.version, getLineColor: this.version, getLineWidth: this.version, getRadius: this.version, getPosition: [this.version, zKey] },
      }),
      showLabels &&
        new TextLayer<StationDatum>({
          id: 'station-labels',
          data: all,
          getPosition: posOf,
          getText: (d) => (d.status === 'construction' ? `${d.name} · ${Math.floor(d.progress * 100)}%` : this.closed.has(d.id) || this.closed.has((d as PairDatum).b ?? -1) ? `${d.name} • CLOSED` : d.name),
          getSize: 12.5,
          getColor: (d) => (d.status === 'blueprint' ? [231, 235, 239, 150] : this.closed.has(d.id) || this.closed.has((d as PairDatum).b ?? -1) ? [255, 93, 93, 255] : [231, 235, 239, 255]),
          getPixelOffset: labelOffset,
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          fontFamily: tfl ? 'Cabin, Overpass, sans-serif' : 'Overpass, sans-serif',
          fontWeight: 700,
          fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
          outlineWidth: 3,
          outlineColor: [22, 27, 33, 230],
          characterSet: 'auto',
          parameters: DEPTH_OFF,
          updateTriggers: { getText: [this.version, Math.floor(this.game.time / 3600)], getColor: this.version, getPixelOffset: [this.version, zKey], getPosition: [this.version, zKey] },
        }),
    ].filter(Boolean) as Layer[];
  }

  /** Station nearest a screen point (by local metres), within tolerance. */
  pick(x: number, y: number, tol: number): number | null {
    let best: number | null = null;
    let bestD = tol;
    for (const s of this.game.network.stations.values()) {
      const p = this.game.network.stationPos(s);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }
}

export const STATION_MIN_ZOOM = MAP.trainMinZoom;
