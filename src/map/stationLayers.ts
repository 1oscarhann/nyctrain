/**
 * Stations (deck.gl): white circles with a dark outline, sized by daily ridership.
 * Interchanges are white pills joining the platforms. Crowded stations pulse amber, then red.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { MAP } from '../balance';
import { toLonLat } from '../core/geo';
import type { Game } from '../core/game';
import { progress } from '../construction/blueprint';
import { computeInterchanges } from '../routes/interchange';

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
}

interface PillDatum {
  path: [number, number, number][];
  width: number;
}

const DEPTH_OFF = { depthCompare: 'always', depthWriteEnabled: false } as const;

export class StationLayers {
  private data: StationDatum[] = [];
  private pills: PillDatum[] = [];
  stats = new Map<number, StationStat>();
  private version = 0;

  constructor(private game: Game) {}

  update(is3D: boolean): void {
    const net = this.game.network;
    const data: StationDatum[] = [];
    for (const s of net.stations.values()) {
      const p = net.stationPos(s);
      const [lon, lat] = toLonLat(p.x, p.y);
      const z = is3D ? Math.max(0, net.heightAt(s.edge, s.u)) : 0;
      const st = this.stats.get(s.id);
      const radius = 5 + Math.min(7, Math.sqrt((st?.boardings ?? 0) / 2500));
      data.push({ id: s.id, pos: [lon, lat, z], name: s.name, status: s.status, radius, crowding: st?.crowding ?? 0, progress: progress(s, this.game.time) });
    }
    this.data = data;
    const byId = new Map(data.map((d) => [d.id, d]));
    const ic = computeInterchanges(net);
    const pills: PillDatum[] = [];
    for (const g of ic.groups) {
      if (g.length < 2) continue;
      // Chain the platforms with a minimum spanning tree so pills join neighbours.
      const pts = g.map((id) => byId.get(id)!);
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
    this.version++;
  }

  layers(zoom: number, time: number): Layer[] {
    const pulse = 0.5 + 0.5 * Math.sin(time / 260);
    const showLabels = zoom >= 13.2;
    return [
      new PathLayer<PillDatum>({
        id: 'station-pill-outline',
        data: this.pills,
        getPath: (d) => d.path,
        getWidth: (d) => d.width + 3,
        widthUnits: 'pixels',
        capRounded: true,
        getColor: [22, 27, 33, 255],
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
        getColor: [255, 255, 255, 255],
        parameters: DEPTH_OFF,
        updateTriggers: { getPath: this.version, getWidth: this.version },
      }),
      // Crowding halo
      new ScatterplotLayer<StationDatum>({
        id: 'station-crowd',
        data: this.data.filter((d) => d.crowding > 0.6 && d.status === 'built'),
        getPosition: (d) => d.pos,
        getRadius: (d) => d.radius + 4 + pulse * 6,
        radiusUnits: 'pixels',
        getFillColor: (d) => (d.crowding > 1 ? [255, 93, 93, 90 + 80 * pulse] : [255, 194, 74, 70 + 70 * pulse]),
        parameters: DEPTH_OFF,
        updateTriggers: { getRadius: [this.version, Math.round(pulse * 20)], getFillColor: [this.version, Math.round(pulse * 20)] },
      }),
      new ScatterplotLayer<StationDatum>({
        id: 'stations',
        data: this.data,
        getPosition: (d) => d.pos,
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: (d) => (d.status === 'blueprint' ? [255, 255, 255, 120] : [255, 255, 255, 255]),
        getLineColor: (d) => (d.status === 'construction' ? [255, 194, 74, 255] : d.status === 'blueprint' ? [255, 255, 255, 160] : [22, 27, 33, 255]),
        getLineWidth: (d) => (d.status === 'construction' ? 3 : 2),
        lineWidthUnits: 'pixels',
        pickable: true,
        parameters: DEPTH_OFF,
        updateTriggers: { getFillColor: this.version, getLineColor: this.version, getRadius: this.version, getPosition: this.version },
      }),
      showLabels &&
        new TextLayer<StationDatum>({
          id: 'station-labels',
          data: this.data,
          getPosition: (d) => d.pos,
          getText: (d) => (d.status === 'construction' ? `${d.name} · ${Math.floor(d.progress * 100)}%` : d.name),
          getSize: 12.5,
          getColor: (d) => (d.status === 'blueprint' ? [231, 235, 239, 150] : [231, 235, 239, 255]),
          getPixelOffset: (d) => [d.radius + 6, 0],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          fontFamily: 'Overpass, sans-serif',
          fontWeight: 700,
          fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
          outlineWidth: 3,
          outlineColor: [22, 27, 33, 230],
          characterSet: 'auto',
          parameters: DEPTH_OFF,
          updateTriggers: { getText: [this.version, Math.floor(this.game.time / 3600)], getColor: this.version, getPixelOffset: this.version, getPosition: this.version },
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
