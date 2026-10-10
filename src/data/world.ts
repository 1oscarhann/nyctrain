/**
 * Loaded world data: tracts (with local metric coordinates), the OD table and land polygons.
 * Shared by the main thread, the sim worker and Node tests (pass a custom loader).
 */
import { toLocal } from '../core/geo';
import { decodeOD, type ODTable } from './odFormat';
import type { BoroughName, TractRecord, TractsFile } from './types';
import { BOROUGHS } from './types';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export interface Tract extends TractRecord {
  index: number;
  x: number;
  y: number;
  boroughIndex: number;
  /** Land area, km². */
  areaKm2: number;
  /** Residents + jobs per km². */
  density: number;
}

export interface World {
  meta: Omit<TractsFile, 'tracts'>;
  tracts: Tract[];
  od: ODTable;
}

export type LandCollection = FeatureCollection<Polygon | MultiPolygon, { code: number; borough: string }>;

export function buildWorld(file: TractsFile, odBuffer: ArrayBuffer): World {
  const tracts: Tract[] = file.tracts.map((t, index) => {
    const [x, y] = toLocal(t.lon, t.lat);
    const areaKm2 = (Math.PI * t.radius * t.radius) / 1e6;
    return {
      ...t,
      index,
      x,
      y,
      boroughIndex: BOROUGHS.indexOf(t.borough as BoroughName),
      areaKm2,
      density: (t.residents + t.jobs) / Math.max(areaKm2, 0.01),
    };
  });
  const { tracts: _omit, ...meta } = file;
  void _omit;
  return { meta, tracts, od: decodeOD(odBuffer) };
}

export async function fetchWorld(base = '/data/'): Promise<World> {
  const [tractsFile, odBuf] = await Promise.all([
    fetch(base + 'tracts.json').then((r) => {
      if (!r.ok) throw new Error('tracts.json: HTTP ' + r.status);
      return r.json() as Promise<TractsFile>;
    }),
    fetch(base + 'od.bin').then((r) => {
      if (!r.ok) throw new Error('od.bin: HTTP ' + r.status);
      return r.arrayBuffer();
    }),
  ]);
  return buildWorld(tractsFile, odBuf);
}

export async function fetchLand(base = '/data/'): Promise<LandCollection> {
  const r = await fetch(base + 'land.geojson');
  if (!r.ok) throw new Error('land.geojson: HTTP ' + r.status);
  return r.json();
}

/** Uniform grid over tract centroids for nearest-tract lookups. */
export class TractIndex {
  private cell = 1000;
  private grid = new Map<number, number[]>();
  constructor(private tracts: Tract[]) {
    for (const t of tracts) {
      const k = this.key(Math.floor(t.x / this.cell), Math.floor(t.y / this.cell));
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(t.index);
    }
  }
  private key(cx: number, cy: number) {
    return (cx + 1000) * 4096 + (cy + 1000);
  }
  nearest(x: number, y: number, maxRings = 6): Tract | null {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best: Tract | null = null;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let i = cx - ring; i <= cx + ring; i++) {
        for (let j = cy - ring; j <= cy + ring; j++) {
          if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== ring) continue;
          const arr = this.grid.get(this.key(i, j));
          if (!arr) continue;
          for (const idx of arr) {
            const t = this.tracts[idx];
            const d = Math.hypot(t.x - x, t.y - y);
            if (d < bestD) {
              bestD = d;
              best = t;
            }
          }
        }
      }
      if (best && bestD < ring * this.cell) break;
    }
    return best;
  }
  /** All tracts with centroid within r metres. */
  within(x: number, y: number, r: number): Tract[] {
    const out: Tract[] = [];
    const c0 = Math.floor((x - r) / this.cell);
    const c1 = Math.floor((x + r) / this.cell);
    const r0 = Math.floor((y - r) / this.cell);
    const r1 = Math.floor((y + r) / this.cell);
    for (let i = c0; i <= c1; i++)
      for (let j = r0; j <= r1; j++) {
        const arr = this.grid.get(this.key(i, j));
        if (!arr) continue;
        for (const idx of arr) {
          const t = this.tracts[idx];
          if (Math.hypot(t.x - x, t.y - y) <= r) out.push(t);
        }
      }
    return out;
  }
}
