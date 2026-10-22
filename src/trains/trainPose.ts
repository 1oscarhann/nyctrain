/**
 * Where trains are drawn, without the renderer (pure; the follow-cam and tests use it): the
 * element under a path distance, a train's drawn sideways offset and its drawn pose.
 */
import { poseOnPath, type FollowPose } from '../cinematic/chase';
import type { CRouteDir } from '../sim/protocol';

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

/**
 * Where a train is drawn, for the follow-cam (docs/v2/cinematic.md §3): its middle (head at `s`)
 * on its route direction, moved sideways by its drawn offset (px at line scale `scale`, as metres
 * at `metresPerPx`: the screen centre's), heading along the path tangent. Height is the track's in
 * 3D (elevated +8 m; underground and 2D trains are drawn on the ground).
 */
export function drawnTrainPose(dir: CRouteDir, s: number, trainLength: number, routeId: number, offsets: Map<string, number>, scale: number, metresPerPx: number, is3D: boolean): FollowPose {
  const head = Math.min(dir.length, s);
  const mid = Math.max(0, head - trainLength / 2);
  const pose = poseOnPath(dir, mid, trainOffsetPx(dir, routeId, mid, offsets, scale) * metresPerPx);
  if (!is3D) pose.z = 0;
  return pose;
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
