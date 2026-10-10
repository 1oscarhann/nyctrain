/**
 * Station auto-naming from the vector tiles: the two nearest named streets
 * ("Nostrand Av & Fulton St"), falling back to the nearest neighbourhood label.
 */
import type { Map as MLMap } from 'maplibre-gl';
import { STATION } from '../balance';
import { toLocal } from '../core/geo';
import { pointSegment } from '../core/geo';

const WORD_ABBR: [RegExp, string][] = [
  [/\bAvenue\b/g, 'Av'],
  [/\bStreet\b/g, 'St'],
  [/\bBoulevard\b/g, 'Blvd'],
  [/\bRoad\b/g, 'Rd'],
  [/\bPlace\b/g, 'Pl'],
  [/\bParkway\b/g, 'Pkwy'],
  [/\bExpressway\b/g, 'Expwy'],
  [/\bDrive\b/g, 'Dr'],
  [/\bLane\b/g, 'Ln'],
  [/\bSquare\b/g, 'Sq'],
  [/\bTerrace\b/g, 'Ter'],
  [/\bCourt\b/g, 'Ct'],
  [/\bHighway\b/g, 'Hwy'],
  [/\bTurnpike\b/g, 'Tpke'],
  [/\bPlaza\b/g, 'Plz'],
  // Directions only before a numbered street: "West 42nd Street" → "W 42nd St", but "West Street" stays.
  [/^East (?=\d)/, 'E '],
  [/^West (?=\d)/, 'W '],
  [/^North (?=\d)/, 'N '],
  [/^South (?=\d)/, 'S '],
];

export function abbreviateStreet(name: string): string {
  let s = name.trim();
  for (const [re, rep] of WORD_ABBR) s = s.replace(re, rep);
  return s;
}

type Coords = number[][];

function distToGeometry(px: number, py: number, geom: { type: string; coordinates: unknown }): number {
  const lines: Coords[] =
    geom.type === 'LineString'
      ? [geom.coordinates as Coords]
      : geom.type === 'MultiLineString'
        ? (geom.coordinates as Coords[])
        : geom.type === 'Point'
          ? [[geom.coordinates as number[]]]
          : [];
  let best = Infinity;
  for (const line of lines) {
    let prev: [number, number] | null = null;
    for (const c of line) {
      const p = toLocal(c[0], c[1]);
      if (prev) best = Math.min(best, pointSegment(px, py, prev[0], prev[1], p[0], p[1]).d);
      else best = Math.min(best, Math.hypot(p[0] - px, p[1] - py));
      prev = p;
    }
  }
  return best;
}

export function nameStationAt(map: MLMap | null, x: number, y: number, taken: Set<string>, onLand?: (x: number, y: number) => boolean): string {
  if (map) {
    try {
      // Nearest distance to each named street from whatever tiles are loaded.
      const streets = new Map<string, number>();
      for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' })) {
        const props = f.properties as Record<string, unknown>;
        const raw = (props['name:en'] as string) || (props.name as string);
        if (!raw || props.class === 'path' || props.class === 'service' || props.class === 'ferry' || /tunnel|bridge|greenway|esplanade/i.test(raw)) continue;
        const d = distToGeometry(x, y, f.geometry as never);
        if (d > STATION.nameSearchRadius * 3) continue;
        const name = abbreviateStreet(raw);
        if ((streets.get(name) ?? Infinity) > d) streets.set(name, d);
      }
      const ranked = [...streets.entries()].sort((a, b) => a[1] - b[1]);
      // Zoomed-out tiles drop minor street names, so widen the search before giving up.
      for (const radius of [STATION.nameSearchRadius, STATION.nameSearchRadius * 2, STATION.nameSearchRadius * 3]) {
        const near = ranked.filter(([, d]) => d <= radius).map(([n]) => n);
        for (let i = 0; i < near.length; i++)
          for (let j = i + 1; j < near.length; j++) {
            const n = `${near[i]} & ${near[j]}`;
            if (!taken.has(n)) return n;
          }
      }
      // Neighbourhood fallback: real neighbourhood labels on NYC land, nearest first.
      let bestP: string | null = null;
      let bestD = Infinity;
      for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' })) {
        const props = f.properties as Record<string, unknown>;
        if (!['neighbourhood', 'quarter', 'suburb'].includes(String(props.class))) continue;
        const nm = (props['name:en'] as string) || (props.name as string);
        const c = (f.geometry as { coordinates: number[] }).coordinates;
        if (!nm || !c) continue;
        const [px, py] = toLocal(c[0], c[1]);
        if (onLand && !onLand(px, py)) continue;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD && d < 2500) {
          bestD = d;
          bestP = nm;
        }
      }
      const nearest = ranked[0]?.[0];
      if (bestP) {
        if (!taken.has(bestP)) return bestP;
        if (nearest && !taken.has(`${bestP} – ${nearest}`)) return `${bestP} – ${nearest}`;
        for (let k = 2; k < 20; k++) if (!taken.has(`${bestP} ${k}`)) return `${bestP} ${k}`;
      }
      if (nearest && !taken.has(nearest)) return nearest;
    } catch {
      // Tiles not loaded — fall through to a numbered name.
    }
  }
  for (let k = 1; k < 10000; k++) if (!taken.has(`Station ${k}`)) return `Station ${k}`;
  return 'Station';
}
