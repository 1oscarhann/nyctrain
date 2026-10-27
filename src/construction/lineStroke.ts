/**
 * The Line tool's geometry (pure: no map or deck.gl, so headless tests use it too).
 */
import { TRACK, type TrackClass, type TrackLevel } from '../balance';
import { platformLength } from './network';
import type { StrokePoint } from './types';

/** Straight track kept beyond each end of a new platform, m. */
export const PLATFORM_CLEAR = 60;

/**
 * The stroke the Line tool lays through its stops: at each new station a straight platform section
 * pointing from the previous stop to the next, long enough that the curves on either side can turn
 * at the class's station radius (TRACK.lineStationRadius) before the platform starts. A plain
 * vertex where the line continues from existing track (isNew false). Also used by headless tests.
 */
export function stationStroke(all: { x: number; y: number; isNew: boolean; level?: TrackLevel }[], cls: TrackClass, cars: number, level: TrackLevel, startLevel?: TrackLevel): StrokePoint[] {
  const half = platformLength(cars, cls) / 2 + PLATFORM_CLEAR;
  const R = TRACK.lineStationRadius[cls];
  const pts: StrokePoint[] = [];
  all.forEach((p, i) => {
    const lv = p.level ?? level;
    if (!p.isNew) {
      pts.push({ x: p.x, y: p.y, level: startLevel ?? lv });
      return;
    }
    const prev = all[i - 1], next = all[i + 1];
    const din = prev ? unitVec(p.x - prev.x, p.y - prev.y) : null;
    const dout = next ? unitVec(next.x - p.x, next.y - p.y) : null;
    let dx = (din?.[0] ?? 0) + (dout?.[0] ?? 0), dy = (din?.[1] ?? 0) + (dout?.[1] ?? 0);
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    // Room for the curve on each side: tangent length R·tan(θ/2) of the turn onto the platform
    // axis, at most 45% of the way to the neighbouring stop.
    const room = (d: [number, number] | null, other: { x: number; y: number } | undefined) => {
      if (!d || !other) return half;
      const th = Math.acos(Math.max(-1, Math.min(1, d[0] * dx + d[1] * dy)));
      const cap = 0.45 * Math.hypot(other.x - p.x, other.y - p.y);
      return Math.max(half, Math.min(cap, R * Math.tan(th / 2) + platformLength(cars, cls) / 2));
    };
    const hin = room(din, prev), hout = room(dout, next);
    pts.push({ x: p.x - dx * hin, y: p.y - dy * hin, level: lv });
    pts.push({ x: p.x + dx * hout, y: p.y + dy * hout, level: lv });
  });
  return pts;
}

function unitVec(x: number, y: number): [number, number] | null {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? [x / l, y / l] : null;
}

