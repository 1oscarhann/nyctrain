/**
 * Station auto-naming from the vector tiles. New York: the two nearest named streets that cross
 * ("Nostrand Av & Fulton St"). London: the neighbourhood you're in, else the street ("Old Street").
 * Both fall back to the nearest neighbourhood label.
 */
import type { Map as MLMap } from 'maplibre-gl';
import { STATION } from '../balance';
import { city } from '../cities';
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

/** Distance to the nearest point of a line geometry, and the line's unit direction there. */
function nearestOnGeometry(px: number, py: number, geom: { type: string; coordinates: unknown }): { d: number; dx: number; dy: number } {
  const lines: Coords[] =
    geom.type === 'LineString'
      ? [geom.coordinates as Coords]
      : geom.type === 'MultiLineString'
        ? (geom.coordinates as Coords[])
        : [];
  const best = { d: Infinity, dx: 0, dy: 0 };
  for (const line of lines) {
    let prev: [number, number] | null = null;
    for (const c of line) {
      const p = toLocal(c[0], c[1]);
      if (prev) {
        const d = pointSegment(px, py, prev[0], prev[1], p[0], p[1]).d;
        const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        if (d < best.d && len > 0) Object.assign(best, { d, dx: (p[0] - prev[0]) / len, dy: (p[1] - prev[1]) / len });
      }
      prev = p;
    }
  }
  return best;
}

/**
 * OpenMapTiles `place` classes that name a neighbourhood. London also counts villages and hamlets
 * (old village names are what its stations and districts are called); New York keeps its v1
 * classes. Station names and Living City's tract names (PlaceNames) both use these.
 */
export function placeClasses(): string[] {
  return city().naming === 'place' ? ['neighbourhood', 'quarter', 'suburb', 'village', 'hamlet'] : ['neighbourhood', 'quarter', 'suburb'];
}

/**
 * Tract names (PlaceNames) also take London's `town` labels (Greenwich, Ilford, Lewisham,
 * Woolwich, Bromley…), which the tiles carry from low zooms on, so an outer MSOA gets a real name
 * before the player zooms in; station names keep the finer classes above.
 */
export function tractPlaceClasses(): string[] {
  return city().naming === 'place' ? [...placeClasses(), 'town'] : placeClasses();
}

/** Streets crossing at less than this angle count as parallel ("W 47th St & W 46th St"). */
const MIN_CROSSING_SIN = Math.sin((35 * Math.PI) / 180);

export function nameStationAt(map: MLMap | null, x: number, y: number, taken: Set<string>, onLand?: (x: number, y: number) => boolean): string {
  const style = city().naming;
  if (map) {
    try {
      // Nearest point (and direction there) of each named street in whatever tiles are loaded.
      const streets = new Map<string, { d: number; dx: number; dy: number }>();
      for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' })) {
        const props = f.properties as Record<string, unknown>;
        const raw = (props['name:en'] as string) || (props.name as string);
        if (!raw || props.class === 'path' || props.class === 'service' || props.class === 'ferry' || /tunnel|bridge|greenway|esplanade/i.test(raw)) continue;
        const near = nearestOnGeometry(x, y, f.geometry as never);
        if (near.d > STATION.nameSearchRadius * 3) continue;
        // London names keep the full street ("Old Street"); New York abbreviates ("W 42nd St").
        const name = style === 'cross-streets' ? abbreviateStreet(raw) : raw.trim();
        if ((streets.get(name)?.d ?? Infinity) > near.d) streets.set(name, near);
      }
      const ranked = [...streets.entries()].sort((a, b) => a[1].d - b[1].d);
      // Neighbourhood labels on land, nearest first.
      const classes = placeClasses();
      const places: { name: string; d: number }[] = [];
      for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' })) {
        const props = f.properties as Record<string, unknown>;
        if (!classes.includes(String(props.class))) continue;
        const nm = (props['name:en'] as string) || (props.name as string);
        const c = (f.geometry as { coordinates: number[] }).coordinates;
        if (!nm || !c) continue;
        const [px, py] = toLocal(c[0], c[1]);
        if (onLand && !onLand(px, py)) continue;
        const d = Math.hypot(px - x, py - y);
        if (d < 2500 && !places.some((q) => q.name === nm && q.d <= d)) places.push({ name: nm, d });
      }
      places.sort((a, b) => a.d - b.d);
      if (style === 'cross-streets') {
        // Two streets that actually cross, nearest first. Zoomed-out tiles drop minor street
        // names, so widen the search before giving up.
        for (const radius of [STATION.nameSearchRadius, STATION.nameSearchRadius * 2, STATION.nameSearchRadius * 3]) {
          const near = ranked.filter(([, v]) => v.d <= radius);
          for (let i = 0; i < near.length; i++)
            for (let j = i + 1; j < near.length; j++) {
              const a = near[i][1], b = near[j][1];
              if (Math.abs(a.dx * b.dy - a.dy * b.dx) < MIN_CROSSING_SIN) continue;
              const n = `${near[i][0]} & ${near[j][0]}`;
              if (!taken.has(n)) return n;
            }
        }
      } else {
        // Like real London stations: the place you're in ("Camden Town"), else the street
        // you're on ("Old Street").
        const place = places.find((p) => p.d <= STATION.placeNameRadius && !taken.has(p.name));
        if (place) return place.name;
        for (const radius of [STATION.nameSearchRadius, STATION.nameSearchRadius * 2]) {
          const st = ranked.find(([n, v]) => v.d <= radius && !taken.has(n));
          if (st) return st[0];
        }
      }
      const bestP = places[0]?.name ?? null;
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
