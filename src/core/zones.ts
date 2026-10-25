/**
 * Tunnel-only zones: inner London (roughly fare zones 1–2) is too dense for new surface railway,
 * so track and stations there must be underground (cut-and-cover or deep tunnel). Per city
 * (CITY_BALANCE[city].tunnelZone); a map without one has no rule.
 */
import { cityBalance, city } from '../cities';
import { toLocal } from './geo';

interface Zone {
  name: string;
  ll: [number, number][];
  xy: [number, number][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

let cache: { id: string; zone: Zone | null } | null = null;

export function tunnelZone(): Zone | null {
  const id = city().id;
  if (cache?.id === id) return cache.zone;
  const z = cityBalance().tunnelZone;
  let zone: Zone | null = null;
  if (z && z.poly.length >= 3) {
    const xy = z.poly.map(([lon, lat]) => toLocal(lon, lat) as [number, number]);
    zone = {
      name: z.name,
      ll: z.poly,
      xy,
      minX: Math.min(...xy.map((p) => p[0])),
      maxX: Math.max(...xy.map((p) => p[0])),
      minY: Math.min(...xy.map((p) => p[1])),
      maxY: Math.max(...xy.map((p) => p[1])),
    };
  }
  cache = { id, zone };
  return zone;
}

/** Inside the tunnel-only zone (local metres). */
export function inTunnelZone(x: number, y: number): boolean {
  const z = tunnelZone();
  if (!z || x < z.minX || x > z.maxX || y < z.minY || y > z.maxY) return false;
  let inside = false;
  const p = z.xy;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const TUNNEL_ZONE_ERROR = (name: string) => `${name} is tunnel-only: use cut-and-cover or deep tunnel here`;
