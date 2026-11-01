/**
 * The Line tool's geometry (pure: no map or deck.gl, so headless tests use it too).
 */
import { TRACK, type TrackClass, type TrackLevel } from '../balance';
import { platformLength } from './network';
import type { StrokePoint } from './types';

/** Straight track kept beyond each end of a new platform, m. */
export const PLATFORM_CLEAR = 60;
/** Shortest leg between a platform's end and the vertex where the curve beyond it starts, m. */
const MIN_LEG = 25;
/**
 * Every leg also leaves room to turn this far at the class's minimum radius (TRACK.minRadius): the
 * line from existing track starts with a lead along the old track's axis, so the first curve can
 * turn more than the stops alone say.
 */
const SLACK_TURN = (30 * Math.PI) / 180;

/**
 * The stroke the Line tool lays through its stops: at each new station a straight platform pointing
 * from the previous stop to the next, with a straight-through vertex at each platform end (no
 * deflection, so no curve: auto-fillet would otherwise let the curves either side eat into the
 * platform) and, beyond it, the vertex where the curve to the next stop is. Each leg from a
 * platform end to its curve vertex is long enough to turn at the class's station radius
 * (TRACK.lineStationRadius) through the turn actually made there (solved over a few passes, since
 * moving one curve vertex changes its neighbours' turns), at most 45% of the way to the next stop.
 * A plain vertex where the line continues from existing track (isNew false). Also used by
 * headless tests.
 */
export function stationStroke(all: { x: number; y: number; isNew: boolean; level?: TrackLevel }[], cls: TrackClass, cars: number, level: TrackLevel, startLevel?: TrackLevel): StrokePoint[] {
  const half = platformLength(cars, cls) / 2 + PLATFORM_CLEAR;
  const R = TRACK.lineStationRadius[cls];
  const slack = TRACK.minRadius[cls] * Math.tan(SLACK_TURN / 2);
  const n = all.length;
  // Platform axes: the bisector of the directions from the previous stop and to the next.
  const axis = all.map((p, i) => {
    const prev = all[i - 1], next = all[i + 1];
    const din = prev ? unitVec(p.x - prev.x, p.y - prev.y) : null;
    const dout = next ? unitVec(next.x - p.x, next.y - p.y) : null;
    const dx = (din?.[0] ?? 0) + (dout?.[0] ?? 0), dy = (din?.[1] ?? 0) + (dout?.[1] ?? 0);
    const dl = Math.hypot(dx, dy) || 1;
    return [dx / dl, dy / dl] as [number, number];
  });
  const cap = (i: number, j: number) => Math.max(half + MIN_LEG, 0.45 * Math.hypot(all[j].x - all[i].x, all[j].y - all[i].y));
  // Distance from each new stop to its curve vertices (in towards the previous stop, out towards the next).
  const rin = all.map((p, i) => (p.isNew && i > 0 ? Math.min(cap(i, i - 1), half + slack) : half));
  const rout = all.map((p, i) => (p.isNew && i < n - 1 ? Math.min(cap(i, i + 1), half + slack) : half));
  const inPt = (i: number) => (all[i].isNew ? { x: all[i].x - axis[i][0] * rin[i], y: all[i].y - axis[i][1] * rin[i] } : all[i]);
  const outPt = (i: number) => (all[i].isNew ? { x: all[i].x + axis[i][0] * rout[i], y: all[i].y + axis[i][1] * rout[i] } : all[i]);
  const turn = (d: [number, number] | null, a: [number, number]) => (d ? Math.acos(Math.max(-1, Math.min(1, d[0] * a[0] + d[1] * a[1]))) : 0);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      if (!all[i].isNew) continue;
      if (i > 0) {
        const a = outPt(i - 1), b = inPt(i);
        const th = turn(unitVec(b.x - a.x, b.y - a.y), axis[i]);
        rin[i] = Math.min(cap(i, i - 1), half + Math.max(MIN_LEG, slack, 1.05 * R * Math.tan(th / 2)));
      }
      if (i < n - 1) {
        const a = outPt(i), b = inPt(i + 1);
        const th = turn(unitVec(b.x - a.x, b.y - a.y), axis[i]);
        rout[i] = Math.min(cap(i, i + 1), half + Math.max(MIN_LEG, slack, 1.05 * R * Math.tan(th / 2)));
      }
    }
  }
  const pts: StrokePoint[] = [];
  all.forEach((p, i) => {
    const lv = p.level ?? level;
    if (!p.isNew) {
      pts.push({ x: p.x, y: p.y, level: startLevel ?? lv });
      return;
    }
    const [dx, dy] = axis[i];
    if (i > 0) pts.push({ x: p.x - dx * rin[i], y: p.y - dy * rin[i], level: lv });
    pts.push({ x: p.x - dx * half, y: p.y - dy * half, level: lv });
    pts.push({ x: p.x + dx * half, y: p.y + dy * half, level: lv });
    if (i < n - 1) pts.push({ x: p.x + dx * rout[i], y: p.y + dy * rout[i], level: lv });
  });
  return pts;
}

function unitVec(x: number, y: number): [number, number] | null {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? [x / l, y / l] : null;
}

