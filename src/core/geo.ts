/**
 * Local metric projection. All game geometry is stored in metres on a plane centred on the
 * city's origin (City Hall in New York, Charing Cross in London); over a city the scale error
 * is well under 0.5%. The origin is set per city by cities/applyCity() before any data loads.
 *
 * A city map is an equirectangular plane (exact enough over 100 km). The national map of Japan is
 * 2,000 km from Kagoshima to Wakkanai, where that plane would stretch Hokkaido east–west by 12%;
 * it uses a Lambert conformal conic projection (spherical, standard parallels 33° and 44° N) instead,
 * whose scale stays within 1% of true from 30° to 46° N.
 */
export let ORIGIN_LON = -74.006;
export let ORIGIN_LAT = 40.7128;
/** Metres per degree of latitude / longitude at the origin. */
export let M_PER_DEG_LAT = 0;
export let M_PER_DEG_LON = 0;

export type Projection = { kind: 'equirect' } | { kind: 'lcc'; lat1: number; lat2: number };

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;
/** Lambert conformal conic constants (n = 0: the equirectangular plane). */
let LCC_N = 0;
let LCC_RF = 0;
let LCC_RHO0 = 0;

export function setOrigin(lon: number, lat: number, projection: Projection = { kind: 'equirect' }): void {
  ORIGIN_LON = lon;
  ORIGIN_LAT = lat;
  const phi = lat * RAD;
  M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  if (projection.kind === 'lcc') {
    const p1 = projection.lat1 * RAD, p2 = projection.lat2 * RAD;
    const t = (p: number) => Math.tan(Math.PI / 4 + p / 2);
    LCC_N = Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
    LCC_RF = (R_EARTH * Math.cos(p1) * t(p1) ** LCC_N) / LCC_N;
    LCC_RHO0 = LCC_RF / t(phi) ** LCC_N;
  } else LCC_N = 0;
}
setOrigin(ORIGIN_LON, ORIGIN_LAT);

export type XY = [number, number];
export type LonLat = [number, number];

export function toLocal(lon: number, lat: number): XY {
  if (LCC_N) {
    const rho = LCC_RF / Math.tan(Math.PI / 4 + (lat * RAD) / 2) ** LCC_N;
    const th = LCC_N * (lon - ORIGIN_LON) * RAD;
    return [rho * Math.sin(th), LCC_RHO0 - rho * Math.cos(th)];
  }
  return [(lon - ORIGIN_LON) * M_PER_DEG_LON, (lat - ORIGIN_LAT) * M_PER_DEG_LAT];
}

export function toLonLat(x: number, y: number): LonLat {
  if (LCC_N) {
    const dy = LCC_RHO0 - y;
    const rho = Math.hypot(x, dy);
    const th = Math.atan2(x, dy);
    return [ORIGIN_LON + th / LCC_N / RAD, (2 * Math.atan((LCC_RF / rho) ** (1 / LCC_N)) - Math.PI / 2) / RAD];
  }
  return [ORIGIN_LON + x / M_PER_DEG_LON, ORIGIN_LAT + y / M_PER_DEG_LAT];
}

/** Ground metres per screen pixel at a zoom level (MapLibre's 512 px tiles), at the city's origin latitude. */
export function metresPerPixel(zoom: number): number {
  return (40075016.686 * Math.cos((ORIGIN_LAT * Math.PI) / 180)) / (512 * 2 ** zoom);
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
