/**
 * Trains as small rounded capsules in the route colour (deck.gl), length scaled to car count,
 * oriented along the track and sitting on their route's interlined line. Positions are
 * interpolated between sim snapshots; in 3D they follow the height of elevated track.
 */
import { PathLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { MAP } from '../balance';
import { toLonLat } from '../core/geo';
import type { CompiledNetwork, CRouteDir } from '../sim/protocol';
import type { TrainView } from '../sim/client';
import { hexRgb } from '../map/networkLayers';
import { ADDITIVE, EXPRESS_GLOW, GLOW_MIN } from '../cinematic/glow';

export interface TrainDatum {
  id: number;
  path: [number, number, number][];
  color: [number, number, number, number];
  offset: number;
  train: TrainView;
  /** An express route's train (v2): a light casing, so an express sliding past a local is visible. */
  express: boolean;
}

/** Casing colours: dark for locals, light for expresses (docs/v2/express-quad.md §2.3). */
export const CASING_LOCAL: [number, number, number, number] = [16, 20, 25, 235];
export const CASING_EXPRESS: [number, number, number, number] = [236, 240, 244, 235];

const WIDTH = 6;
const offsetExt = new PathStyleExtension({ offset: true });

export class TrainLayer {
  data: TrainDatum[] = [];
  selected: number | null = null;
  /** Trains stalled or held by an incident (red casing). */
  alerted = new Set<number>();
  private alertedVersion = 0;
  private colors = new Map<number, [number, number, number, number]>();

  /** Rebuild positions for this frame. */
  update(net: CompiledNetwork | null, trains: TrainView[], offsets: Map<string, number>, is3D: boolean, scale = 1): void {
    if (!net) {
      this.data = [];
      return;
    }
    const out: TrainDatum[] = [];
    for (const t of trains) {
      const r = net.routes[t.route];
      if (!r) continue;
      const dir = r.dirs[t.dir];
      if (!dir) continue;
      let col = this.colors.get(r.id);
      if (!col) {
        const c = hexRgb(r.color);
        col = [c[0], c[1], c[2], 255];
        this.colors.set(r.id, col);
      }
      const head = Math.min(dir.length, t.s);
      const tail = Math.max(0, head - r.trainLength);
      const path = samplePath(dir, tail, head, is3D);
      if (path.length < 2) continue;
      out.push({ id: t.id, path, color: col, offset: trainOffsetPx(dir, r.id, head - r.trainLength / 2, offsets, scale) / WIDTH, train: t, express: !!r.express });
    }
    this.data = out;
  }

  /** Replace the alerted set (from the active alerts). */
  setAlerted(ids: Set<number>): void {
    if (ids.size === this.alerted.size && [...ids].every((id) => this.alerted.has(id))) return;
    this.alerted = ids;
    this.alertedVersion++;
  }

  layers(zoom: number, onPick: (id: number) => void, glow = 0): Layer[] {
    if (zoom < MAP.trainMinZoom || !this.data.length) return [];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const sel = this.selected;
    const al = this.alerted;
    const casing = (d: TrainDatum) => (d.id === sel || al.has(d.id) ? WIDTH + 5 : WIDTH + 2.5);
    // Stalled or held trains: a white rim outside the red casing, so it reads on red routes too.
    const halo = al.size ? this.data.filter((d) => al.has(d.id) && d.id !== sel) : [];
    const GW = WIDTH + 12;
    return [
      // Cinematic: a halo in the route colour at night (white for expresses), blended additively.
      glow >= GLOW_MIN &&
        new PathLayer<TrainDatum, PathStyleExtensionProps<TrainDatum>>({
          id: 'trains-glow',
          data: this.data,
          getPath: (d) => d.path,
          getColor: (d) => (d.express ? EXPRESS_GLOW : [d.color[0], d.color[1], d.color[2], 120]),
          getWidth: GW,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          getOffset: (d) => (d.offset * WIDTH) / GW,
          extensions: [offsetExt],
          opacity: glow,
          parameters: ADDITIVE,
        }),
      halo.length > 0 &&
        new PathLayer<TrainDatum, PathStyleExtensionProps<TrainDatum>>({
          id: 'trains-alert-rim',
          data: halo,
          getPath: (d) => d.path,
          getColor: [255, 255, 255, 235],
          getWidth: WIDTH + 8.5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          getOffset: (d) => (d.offset * WIDTH) / (WIDTH + 8.5),
          extensions: [offsetExt],
          parameters: DEPTH,
        }),
      new PathLayer<TrainDatum, PathStyleExtensionProps<TrainDatum>>({
        id: 'trains-casing',
        data: this.data,
        getPath: (d) => d.path,
        getColor: (d) => (d.id === sel ? [255, 194, 74, 255] : al.has(d.id) ? [255, 93, 93, 255] : d.express ? CASING_EXPRESS : CASING_LOCAL),
        getWidth: casing,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        getOffset: (d) => (d.offset * WIDTH) / casing(d),
        extensions: [offsetExt],
        parameters: DEPTH,
        updateTriggers: { getColor: [sel, this.alertedVersion], getWidth: [sel, this.alertedVersion], getOffset: [sel, this.alertedVersion] },
      }),
      new PathLayer<TrainDatum, PathStyleExtensionProps<TrainDatum>>({
        id: 'trains',
        data: this.data,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: WIDTH,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        getOffset: (d) => d.offset,
        extensions: [offsetExt],
        pickable: true,
        onClick: (info: PickingInfo<TrainDatum>) => {
          if (info.object) onPick(info.object.id);
          return true;
        },
        parameters: DEPTH,
      }),
    ].filter(Boolean) as Layer[];
  }
}

/**
 * The drawn sideways offset of a train (px at line scale 1 × scale, positive = right of travel):
 * its route's interline (and four-track pair) offset on the edge under its middle, plus the
 * right-hand running nudge. The follow-cam uses it to sit on the train as drawn.
 */
export function trainOffsetPx(dir: CRouteDir, routeId: number, sMid: number, offsets: Map<string, number>, scale = 1): number {
  const el = elementAt(dir, sMid);
  const offAB = el ? (offsets.get(`${el.edge}:${routeId}`) ?? 0) : 0;
  const travelOffset = el && el.edgeDir === 1 ? -offAB : offAB;
  // Right-hand running: each direction sits slightly to its own side of the line.
  return travelOffset * scale + 1.6;
}

/** Points of a route-direction polyline between path distances s0 and s1. */
export function samplePath(dir: CRouteDir, s0: number, s1: number, is3D: boolean): [number, number, number][] {
  const { xs, ys, zs, cum } = dir;
  const n = cum.length;
  const out: [number, number, number][] = [];
  const at = (s: number) => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    const L = cum[hi] - cum[lo] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[lo]) / L));
    return { i: lo, x: xs[lo] + (xs[hi] - xs[lo]) * f, y: ys[lo] + (ys[hi] - ys[lo]) * f, z: zs[lo] + (zs[hi] - zs[lo]) * f };
  };
  const a = at(s0);
  const b = at(s1);
  const push = (x: number, y: number, z: number) => {
    const [lon, lat] = toLonLat(x, y);
    out.push([lon, lat, is3D ? Math.max(0, z) : 0]);
  };
  push(a.x, a.y, a.z);
  for (let i = a.i + 1; i <= b.i; i++) push(xs[i], ys[i], zs[i]);
  push(b.x, b.y, b.z);
  return out;
}

export function elementAt(dir: CRouteDir, s: number) {
  const els = dir.elems;
  let lo = 0, hi = els.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (els[m].s0 <= s) lo = m;
    else hi = m - 1;
  }
  return els[lo];
}
