/**
 * Elevated track in the 3D view: the structure (deck slab and pillars every ~30 m) as MapLibre
 * fill-extrusions so it sits among the buildings, and the coloured lines on top of it as deck.gl
 * paths at +8 m that are always drawn over everything.
 */
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import { PathLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { MAP } from '../balance';
import { toLonLat } from '../core/geo';
import type { Network } from '../construction/network';
import { edgePieces, lineScale, type NetworkLayers } from './networkLayers';
import { offsetPolyline, slicePolyline } from './polyline';
import { ADDITIVE, GLOW_MIN } from '../cinematic/glow';

export const STRUCTURE_SOURCE = 'hw-elevated-structure';
const offsetExt = new PathStyleExtension({ offset: true });

export class Elevated3D {
  constructor(private map: MLMap) {
    map.addSource(STRUCTURE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Above the 3D buildings in layer order; depth-tested with them (it's part of the city).
    map.addLayer({
      id: 'hw-elevated-structure',
      type: 'fill-extrusion',
      source: STRUCTURE_SOURCE,
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
  }

  /** Rebuild pillars and deck slabs for built elevated track (only shown in 3D). */
  update(net: Network, is3D: boolean): void {
    const features: Feature<Polygon>[] = [];
    if (is3D) {
      for (const e of net.edges.values()) {
        if (e.status !== 'built') continue;
        const g = net.geom(e.id);
        for (const piece of edgePieces(net, e.id)) {
          if (piece.level !== 'elevated') continue;
          const pts = slicePolyline(g.xs, g.ys, g.cum, piece.s0, piece.s1);
          if (pts.length < 2) continue;
          // Deck slab: a 7 m wide strip just under the rails.
          const left = offsetPolyline(pts, -3.5);
          const right = offsetPolyline(pts, 3.5).reverse();
          const ring = [...left, ...right, left[0]].map(([x, y]) => toLonLat(x, y));
          const topAt = (s: number) => Math.max(1, net.heightAt(e.id, s));
          const midTop = topAt((piece.s0 + piece.s1) / 2);
          features.push({ type: 'Feature', properties: { color: '#5B6570', base: midTop - 0.9, top: midTop - 0.1 }, geometry: { type: 'Polygon', coordinates: [ring] } });
          // Pillars.
          const len = piece.s1 - piece.s0;
          const n = Math.max(1, Math.floor(len / MAP.pillarSpacing));
          for (let k = 0; k <= n; k++) {
            const s = piece.s0 + (len * k) / n;
            const top = topAt(s) - 0.9;
            if (top < 1.5) continue;
            const [px, py] = slicePolyline(g.xs, g.ys, g.cum, s, s + 0.01)[0];
            const r = 0.9;
            const sq = [
              [px - r, py - r],
              [px + r, py - r],
              [px + r, py + r],
              [px - r, py + r],
              [px - r, py - r],
            ].map(([x, y]) => toLonLat(x, y));
            features.push({ type: 'Feature', properties: { color: '#4E5762', base: 0, top }, geometry: { type: 'Polygon', coordinates: [sq] } });
          }
        }
      }
    }
    (this.map.getSource(STRUCTURE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** Coloured elevated lines at deck height (3D only). */
  layers(net: NetworkLayers, is3D: boolean, zoom: number, glow = 0): Layer[] {
    if (!is3D || !net.elevated3d.length) return [];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const k = lineScale(zoom);
    const w = MAP.routeLineWidthPx * k;
    type D = NetworkLayers['elevated3d'][number];
    const gw = w + 10 * k;
    return [
      // Cinematic: the lines on the structure glow at night (additive, under the casing).
      glow >= GLOW_MIN &&
        new PathLayer<D, PathStyleExtensionProps<D>>({
          id: 'elevated-glow',
          data: net.elevated3d,
          getPath: (d) => d.path,
          getColor: (d) => [d.color[0], d.color[1], d.color[2], Math.round(d.color[3] * 0.45)],
          getWidth: gw,
          widthUnits: 'pixels',
          capRounded: true,
          getOffset: (d) => (d.offset * k) / gw,
          extensions: [offsetExt],
          opacity: glow,
          parameters: ADDITIVE,
          updateTriggers: { getOffset: k, getWidth: k },
        }),
      new PathLayer<D, PathStyleExtensionProps<D>>({
        id: 'elevated-casing',
        data: net.elevated3d,
        getPath: (d) => d.path,
        getColor: [213, 220, 227, 255],
        getWidth: w + 3 * k,
        widthUnits: 'pixels',
        getOffset: (d) => (d.offset * k) / (w + 3),
        extensions: [offsetExt],
        parameters: DEPTH,
        updateTriggers: { getOffset: k, getWidth: k },
      }),
      new PathLayer<D, PathStyleExtensionProps<D>>({
        id: 'elevated-lines',
        data: net.elevated3d,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: w,
        widthUnits: 'pixels',
        getOffset: (d) => (d.offset * k) / w,
        extensions: [offsetExt],
        parameters: DEPTH,
        updateTriggers: { getOffset: k, getWidth: k },
      }),
    ].filter(Boolean) as Layer[];
  }

  /** The MapLibre layers this owns (the timelapse player hides them while it plays). */
  layerIds(): string[] {
    return ['hw-elevated-structure'];
  }
}
