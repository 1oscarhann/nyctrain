/**
 * Names for tracts (Living City toasts, the month report, hover; docs/v2/living-city.md §2.4).
 * There is no neighbourhood dataset, so a tract's name comes from, in order:
 * 1. the nearest map place label seen this session within 1.2 km of the tract's edge (its disc;
 *    London's MSOAs are ≈ 2.5× New York's tracts), on land (OpenMapTiles `place` features of the
 *    city's classes, the ones station naming uses: London adds villages and hamlets, and towns for
 *    tract names), harvested whenever the map goes idle;
 * 2. the nearest served station within the same distance, as "around 36 St";
 * 3. the tract panel's own name: London's MSOA name ("Camden 028"), New York's "Queens tract 57".
 * Labels and stations in another borough than the tract are skipped when both boroughs are known,
 * so a tract on one bank of a river is not named after the other bank.
 */
import type { Map as MLMap } from 'maplibre-gl';
import { toLocal } from '../core/geo';
import type { Tract } from '../data/world';
import { tractPlaceClasses } from './naming';

/** How far beyond a tract's edge a place label or a station may be to name it (metres). */
export const TRACT_NAME_RADIUS = 1200;

/** The naming search radius from a tract's centre: TRACT_NAME_RADIUS beyond its disc. */
export function tractNameRadius(radius = 0): number {
  return TRACT_NAME_RADIUS + Math.max(0, radius);
}

export interface PlacePoint {
  name: string;
  x: number;
  y: number;
  /** Borough (region) code at the point; 0 = unknown. */
  region?: number;
}

/** Whether a point in region b may name something in region a (either unknown: yes). */
function sameRegion(a: number | undefined, b: number | undefined): boolean {
  return !a || !b || a === b;
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
  add(name: string, x: number, y: number, region = 0): boolean {
    const dedupe = `${name}|${Math.round(x / 200)}|${Math.round(y / 200)}`;
    if (this.seen.has(dedupe)) return false;
    this.seen.add(dedupe);
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push({ name, x, y, region });
    this.size++;
    return true;
  }

  /** The nearest label within maxD metres (ties: the alphabetically first name) in the same region when known, or null. */
  nearest(x: number, y: number, maxD = TRACT_NAME_RADIUS, region = 0): string | null {
    const r = Math.ceil(maxD / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best: PlacePoint | null = null;
    let bestD = maxD;
    for (let i = cx - r; i <= cx + r; i++)
      for (let j = cy - r; j <= cy + r; j++) {
        for (const p of this.grid.get(this.key(i, j)) ?? []) {
          if (!sameRegion(region, p.region)) continue;
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
    private regionAt: (x: number, y: number) => number = () => 0,
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
    const classes = tractPlaceClasses();
    try {
      for (const f of this.map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' })) {
        const props = f.properties as Record<string, unknown>;
        if (!classes.includes(String(props.class))) continue;
        const nm = (props['name:en'] as string) || (props.name as string);
        const c = (f.geometry as { coordinates?: number[] }).coordinates;
        if (!nm || !c || typeof c[0] !== 'number') continue;
        const [x, y] = toLocal(c[0], c[1]);
        if (!this.isLand(x, y)) continue;
        this.add(nm.trim(), x, y, this.regionAt(x, y));
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
 * A tract's name (§2.4): a place label near it, else "around <station>" for a served station,
 * both within tractNameRadius(radius) of its centre, else its formal name. Never empty. `region`
 * is the borough code at the tract (0 = unknown): labels and stations elsewhere are skipped.
 */
export function tractName(
  t: Pick<Tract, 'name' | 'borough' | 'id' | 'x' | 'y'> & { radius?: number },
  places: { nearest(x: number, y: number, maxD?: number, region?: number): string | null } | null,
  served: readonly { name: string; x: number; y: number; region?: number }[],
  region = 0,
): string {
  const maxD = tractNameRadius(t.radius);
  const place = places?.nearest(t.x, t.y, maxD, region);
  if (place) return place;
  let best: { name: string } | null = null;
  let bestD = maxD;
  for (const s of served) {
    if (!sameRegion(region, s.region)) continue;
    const d = Math.hypot(s.x - t.x, s.y - t.y);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best) return `around ${best.name}`;
  return formalTractName(t);
}
