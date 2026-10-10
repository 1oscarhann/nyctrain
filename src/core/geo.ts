/**
 * Local metric projection for NYC. All game geometry is stored in metres on a plane
 * centred on City Hall; over the five boroughs the scale error is well under 0.5%.
 */
export const ORIGIN_LON = -74.006;
export const ORIGIN_LAT = 40.7128;

const phi = (ORIGIN_LAT * Math.PI) / 180;
/** Metres per degree of latitude / longitude at the origin. */
export const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

export type XY = [number, number];
export type LonLat = [number, number];

export function toLocal(lon: number, lat: number): XY {
  return [(lon - ORIGIN_LON) * M_PER_DEG_LON, (lat - ORIGIN_LAT) * M_PER_DEG_LAT];
}

export function toLonLat(x: number, y: number): LonLat {
  return [ORIGIN_LON + x / M_PER_DEG_LON, ORIGIN_LAT + y / M_PER_DEG_LAT];
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Distance from point p to segment ab, with the parameter t of the closest point. */
export function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d: number; t: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { d: Math.hypot(px - x, py - y), t, x, y };
}
