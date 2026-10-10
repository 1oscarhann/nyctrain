import { toLonLat } from '../core/geo';

/** Extract the part of a sampled polyline between distances s0 and s1 (local metres). */
export function slicePolyline(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  cum: ArrayLike<number>,
  s0: number,
  s1: number,
): [number, number][] {
  const out: [number, number][] = [];
  const n = cum.length;
  if (n < 2 || s1 <= s0) return out;
  const at = (s: number): [number, number] => {
    let i = 0;
    while (i + 1 < n - 1 && cum[i + 1] < s) i++;
    const L = cum[i + 1] - cum[i] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[i]) / L));
    return [xs[i] + (xs[i + 1] - xs[i]) * f, ys[i] + (ys[i + 1] - ys[i]) * f];
  };
  out.push(at(s0));
  for (let i = 0; i < n; i++) if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push([xs[i], ys[i]]);
  out.push(at(s1));
  return out;
}

export function toLonLatLine(pts: [number, number][]): [number, number][] {
  return pts.map(([x, y]) => toLonLat(x, y));
}

/** Offset a local-metre polyline sideways by d metres (positive = right of travel). */
export function offsetPolyline(pts: [number, number][], d: number): [number, number][] {
  if (d === 0 || pts.length < 2) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] + (dy / L) * d, pts[i][1] - (dx / L) * d]);
  }
  return out;
}
