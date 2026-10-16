/**
 * Names for tracts (Living City toasts, the month report, hover; docs/v2/living-city.md §2.4).
 * There is no neighbourhood dataset, so a tract's name comes from, in order:
 * 1. the nearest map place label seen this session within 1.2 km, on land (OpenMapTiles `place`
 *    features of the city's classes, the same ones station naming uses: London adds villages and
 *    hamlets), harvested whenever the map goes idle;
 * 2. the nearest served station within 1.2 km, as "around 36 St";
 * 3. the tract panel's own name: London's MSOA name ("Camden 028"), New York's "Queens tract 57".
 */
import type { Map as MLMap } from 'maplibre-gl';
import { toLocal } from '../core/geo';
import type { Tract } from '../data/world';
import { placeClasses } from './naming';

/** How far a place label or a station may be from the tract centre to name it (metres). */
export const TRACT_NAME_RADIUS = 1200;

export interface PlacePoint {
  name: string;
  x: number;
  y: number;
}

/** Place labels by position (pure; a 1 km grid). */
export class PlaceIndex {
  private cell = 1000;
  private grid = new Map<number, PlacePoint[]>();
  private seen = new Set<string>();
  size = 0;

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  /** Add a label (the same name within 200 m of one already kept is a duplicate from another tile). */
  add(name: string, x: number, y: number): boolean {
    const dedupe = `${name}|${Math.round(x / 200)}|${Math.round(y / 200)}`;
    if (this.seen.has(dedupe)) return false;
    this.seen.add(dedupe);
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push({ name, x, y });
    this.size++;
    return true;
  }

  /** The nearest label within maxD metres (ties: the alphabetically first name), or null. */
  nearest(x: number, y: number, maxD = TRACT_NAME_RADIUS): string | null {
    const r = Math.ceil(maxD / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best: PlacePoint | null = null;
    let bestD = maxD;
    for (let i = cx - r; i <= cx + r; i++)
      for (let j = cy - r; j <= cy + r; j++) {
        for (const p of this.grid.get(this.key(i, j)) ?? []) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bestD || (d === bestD && best && p.name < best.name)) {
            bestD = d;
            best = p;
          }
        }
      }
    return best?.name ?? null;
  }
}

/** Harvests the map's place labels each time it goes idle (debounced), on land only. */
export class PlaceNames extends PlaceIndex {
  private timer = 0;

  constructor(
    private map: MLMap,
    private isLand: (x: number, y: number) => boolean,
  ) {
    super();
    map.on('idle', this.onIdle);
    this.harvest();
  }

  private onIdle = () => {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.harvest(), 500);
  };

  harvest(): void {
    const classes = placeClasses();
    try {
      for (const f of this.map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' })) {
        const props = f.properties as Record<string, unknown>;
        if (!classes.includes(String(props.class))) continue;
        const nm = (props['name:en'] as string) || (props.name as string);
        const c = (f.geometry as { coordinates?: number[] }).coordinates;
        if (!nm || !c || typeof c[0] !== 'number') continue;
        const [x, y] = toLocal(c[0], c[1]);
        if (!this.isLand(x, y)) continue;
        this.add(nm.trim(), x, y);
      }
    } catch {
      // The style or source isn't ready yet: the next idle tries again.
    }
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.map.off('idle', this.onIdle);
  }
}

/** The tract panel's own name: London's MSOA name ("Camden 028"), New York's "Queens tract 57". */
export function formalTractName(t: Pick<Tract, 'name' | 'borough' | 'id'>): string {
  return t.name ?? `${t.borough} tract ${String(Number(t.id.slice(5)) / 100).replace(/\.0+$/, '')}`;
}

/**
 * A tract's name (§2.4): a place label near it, else "around <station>" for a served station
 * within TRACT_NAME_RADIUS, else its formal name. Never empty.
 */
export function tractName(t: Pick<Tract, 'name' | 'borough' | 'id' | 'x' | 'y'>, places: { nearest(x: number, y: number, maxD?: number): string | null } | null, served: readonly { name: string; x: number; y: number }[]): string {
  const place = places?.nearest(t.x, t.y, TRACT_NAME_RADIUS);
  if (place) return place;
  let best: { name: string } | null = null;
  let bestD = TRACT_NAME_RADIUS;
  for (const s of served) {
    const d = Math.hypot(s.x - t.x, s.y - t.y);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best) return `around ${best.name}`;
  return formalTractName(t);
}
