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
  [/^East\b/, 'E'],
  [/^West\b/, 'W'],
  [/^North\b/, 'N'],
  [/^South\b/, 'S'],
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

export function nameStationAt(map: MLMap | null, x: number, y: number, taken: Set<string>): string {
  if (map) {
    try {
      const streets = new Map<string, number>();
      const feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' });
      const r = STATION.nameSearchRadius;
      for (const f of feats) {
        const props = f.properties as Record<string, unknown>;
        const raw = (props['name:en'] as string) || (props.name as string);
        if (!raw || props.class === 'path' || props.class === 'service') continue;
        const d = distToGeometry(x, y, f.geometry as never);
        if (d > r) continue;
        const name = abbreviateStreet(raw);
        if ((streets.get(name) ?? Infinity) > d) streets.set(name, d);
      }
      const ranked = [...streets.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
      // Try pairs of nearby streets until we find an unused name.
      for (let i = 0; i < ranked.length; i++)
        for (let j = i + 1; j < ranked.length; j++) {
          const n = `${ranked[i]} & ${ranked[j]}`;
          if (!taken.has(n)) return n;
        }
      if (ranked.length >= 1 && !taken.has(ranked[0])) return ranked[0];
      // Neighbourhood fallback.
      const places = map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' });
      let bestP: string | null = null;
      let bestD = Infinity;
      for (const f of places) {
        const props = f.properties as Record<string, unknown>;
        if (!['suburb', 'neighbourhood', 'quarter', 'hamlet', 'village', 'town'].includes(String(props.class))) continue;
        const nm = (props['name:en'] as string) || (props.name as string);
        if (!nm) continue;
        const d = distToGeometry(x, y, f.geometry as never);
        if (d < bestD) {
          bestD = d;
          bestP = nm;
        }
      }
      if (bestP) {
        if (!taken.has(bestP)) return bestP;
        for (const r of ranked) if (!taken.has(`${bestP} – ${r}`)) return `${bestP} – ${r}`;
        for (let k = 2; k < 20; k++) if (!taken.has(`${bestP} ${k}`)) return `${bestP} ${k}`;
      }
    } catch {
      // Tiles not loaded — fall through to a numbered name.
    }
  }
  for (let k = 1; k < 10000; k++) if (!taken.has(`Station ${k}`)) return `Station ${k}`;
  return 'Station';
}
