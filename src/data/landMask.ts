/**
 * Raster land mask built from the borough land polygons with a scanline fill.
 * Each cell stores the NYC borough code (1–5) or 0 for water. Lookups are O(1),
 * which lets the track tools test every few metres of a segment for water while dragging.
 */
import { toLocal } from '../core/geo';
import type { LandCollection } from './world';

export class LandMask {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;

  constructor(land: LandCollection, cell = 20) {
    this.cell = cell;
    // Collect rings in local metres.
    const polys: { code: number; rings: Float64Array[] }[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of land.features) {
      const code = f.properties.code;
      const multi = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of multi) {
        const rings: Float64Array[] = [];
        for (const ring of poly) {
          const arr = new Float64Array(ring.length * 2);
          ring.forEach(([lon, lat], i) => {
            const [x, y] = toLocal(lon, lat);
            arr[i * 2] = x;
            arr[i * 2 + 1] = y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          });
          rings.push(arr);
        }
        polys.push({ code, rings });
      }
    }
    const pad = cell * 4;
    this.x0 = Math.floor((minX - pad) / cell) * cell;
    this.y0 = Math.floor((minY - pad) / cell) * cell;
    this.w = Math.ceil((maxX + pad - this.x0) / cell);
    this.h = Math.ceil((maxY + pad - this.y0) / cell);
    this.data = new Uint8Array(this.w * this.h);

    for (const { code, rings } of polys) this.fill(code, rings);
  }

  /** Even–odd scanline fill of one polygon (outer ring + holes). */
  private fill(code: number, rings: Float64Array[]) {
    const { cell, x0, y0, w, h } = this;
    // Edge table bucketed by row.
    const rowsEdges: number[][] = [];
    let rMin = h, rMax = -1;
    const edges: number[] = []; // flat [xa, ya, xb, yb]
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const xa = ring[i * 2], ya = ring[i * 2 + 1], xb = ring[i * 2 + 2], yb = ring[i * 2 + 3];
        if (ya === yb) continue;
        const e = edges.length / 4;
        edges.push(xa, ya, xb, yb);
        const lo = Math.max(0, Math.ceil((Math.min(ya, yb) - y0) / cell - 0.5));
        const hi = Math.min(h - 1, Math.floor((Math.max(ya, yb) - y0) / cell - 0.5));
        for (let r = lo; r <= hi; r++) (rowsEdges[r] ??= []).push(e);
        if (lo < rMin) rMin = lo;
        if (hi > rMax) rMax = hi;
      }
    }
    const xs: number[] = [];
    for (let r = rMin; r <= rMax; r++) {
      const list = rowsEdges[r];
      if (!list) continue;
      const y = y0 + (r + 0.5) * cell;
      xs.length = 0;
      for (const e of list) {
        const xa = edges[e * 4], ya = edges[e * 4 + 1], xb = edges[e * 4 + 2], yb = edges[e * 4 + 3];
        if ((ya <= y && yb > y) || (yb <= y && ya > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5));
        const c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
        const base = r * w;
        for (let c = c0; c <= c1; c++) this.data[base + c] = code;
      }
    }
  }

  /** Borough code at a local point (0 = water / outside NYC). */
  codeAt(x: number, y: number): number {
    const c = Math.floor((x - this.x0) / this.cell);
    const r = Math.floor((y - this.y0) / this.cell);
    if (c < 0 || r < 0 || c >= this.w || r >= this.h) return 0;
    return this.data[r * this.w + c];
  }

  isWater(x: number, y: number): boolean {
    return this.codeAt(x, y) === 0;
  }
}
