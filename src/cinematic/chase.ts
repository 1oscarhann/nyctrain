/**
 * Follow-cam maths (docs/v2/cinematic.md §3), pure: a train's pose on its route direction, the
 * chase camera's centre and zoom, and angle easing. Local metres (x east, y north); headings and
 * bearings in degrees clockwise from north, MapLibre's convention.
 */

/** Anything with a sampled polyline and its cumulative distances (a compiled route direction). */
export interface PathLike {
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  zs: ArrayLike<number>;
  cum: ArrayLike<number>;
}

/** What the camera follows: a point (local metres), its height above ground and its heading. */
export interface FollowPose {
  x: number;
  y: number;
  /** Height above ground, metres (elevated track: +8). */
  z: number;
  /** Degrees clockwise from north. */
  heading: number;
}

const DEG = 180 / Math.PI;

/** Normalise an angle to [0, 360). */
export function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Signed shortest turn from a to b, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = wrap360(b - a);
  return d > 180 ? d - 360 : d;
}

/** Position and height on a path at distance s (clamped to the path). */
export function pointOnPath(p: PathLike, s: number): { x: number; y: number; z: number } {
  const n = p.cum.length;
  if (n === 0) return { x: 0, y: 0, z: 0 };
  if (s <= p.cum[0] || n === 1) return { x: p.xs[0], y: p.ys[0], z: p.zs[0] };
  if (s >= p.cum[n - 1]) return { x: p.xs[n - 1], y: p.ys[n - 1], z: p.zs[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (p.cum[m] <= s) lo = m;
    else hi = m;
  }
  const L = p.cum[hi] - p.cum[lo] || 1;
  const f = (s - p.cum[lo]) / L;
  return { x: p.xs[lo] + (p.xs[hi] - p.xs[lo]) * f, y: p.ys[lo] + (p.ys[hi] - p.ys[lo]) * f, z: p.zs[lo] + (p.zs[hi] - p.zs[lo]) * f };
}

/** Heading of the path tangent at s, from the chord over ±window metres (smooths sampled curves). */
export function headingAt(p: PathLike, s: number, window = 15): number {
  const n = p.cum.length;
  const len = n ? p.cum[n - 1] : 0;
  const s0 = Math.max(0, Math.min(len, s - window));
  const s1 = Math.max(0, Math.min(len, s + window));
  const a = pointOnPath(p, s0), b = pointOnPath(p, s1);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return 0;
  return wrap360(Math.atan2(dx, dy) * DEG);
}

/**
 * Pose at distance s on a path, moved `lateral` metres to the right of travel (the drawn
 * interline and four-track pair offset; negative = left). Height is clamped at ground level
 * (underground trains are drawn on the surface).
 */
export function poseOnPath(p: PathLike, s: number, lateral = 0, window = 15): FollowPose {
  const q = pointOnPath(p, s);
  const heading = headingAt(p, s, window);
  const h = heading / DEG;
  // Right of a heading (sin h, cos h) is (cos h, −sin h).
  return { x: q.x + Math.cos(h) * lateral, y: q.y - Math.sin(h) * lateral, z: Math.max(0, q.z), heading };
}

/**
 * Ground point the chase camera centres on, so that the followed point at height z (track height)
 * sits at the screen centre: the central ray meets height z at z·tan(pitch) before the ground, so
 * the centre moves that far ahead along the heading, plus a look-ahead.
 */
export function chaseCentre(pose: FollowPose, pitchDeg: number, lookAhead = 0): { x: number; y: number } {
  const h = pose.heading / DEG;
  const ahead = lookAhead + pose.z * Math.tan(Math.min(85, Math.max(0, pitchDeg)) / DEG);
  return { x: pose.x + Math.sin(h) * ahead, y: pose.y + Math.cos(h) * ahead };
}

/** MapLibre's default vertical field of view (0.6435 rad). */
export const DEFAULT_FOV = 36.8698976;

/** Camera-to-centre distance in screen pixels for a viewport height (MapLibre: 0.5 / tan(fov / 2) × height). */
export function cameraToCenterPx(viewportHeightPx: number, fovDeg = DEFAULT_FOV): number {
  return (0.5 / Math.tan(fovDeg / 2 / DEG)) * viewportHeightPx;
}

/** Zoom at which the camera sits `distM` metres from the centre (any pitch), at latitude lat. */
export function zoomForDistance(distM: number, viewportHeightPx: number, lat: number, fovDeg = DEFAULT_FOV): number {
  const px = cameraToCenterPx(viewportHeightPx, fovDeg);
  return Math.log2((40075016.686 * Math.cos(lat / DEG) * px) / (512 * Math.max(1, distM)));
}

/** The inverse: camera-to-centre distance in metres at a zoom. */
export function distanceForZoom(zoom: number, viewportHeightPx: number, lat: number, fovDeg = DEFAULT_FOV): number {
  return (40075016.686 * Math.cos(lat / DEG) * cameraToCenterPx(viewportHeightPx, fovDeg)) / (512 * 2 ** zoom);
}

/** Exponential easing of an angle towards a target over the shortest turn (time constant tau, seconds). */
export function easeAngle(current: number, target: number, dtSec: number, tauSec: number): number {
  if (tauSec <= 0 || !Number.isFinite(current)) return wrap360(target);
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  return wrap360(current + angleDelta(current, target) * k);
}

/** Exponential easing of a value. */
export function easeValue(current: number, target: number, dtSec: number, tauSec: number): number {
  if (tauSec <= 0 || !Number.isFinite(current)) return target;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtSec) / tauSec));
}
