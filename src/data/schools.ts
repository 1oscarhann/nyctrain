/**
 * Real schools (scripts/build-schools.ts → public/data/<city>/schools.json): names, places, kinds
 * and pupils. Shown on the map as the Schools layer and counted in station catchments.
 */
export type SchoolKind = 'nursery' | 'primary' | 'secondary' | 'allthrough' | 'special' | 'independent';

export const SCHOOL_KINDS: SchoolKind[] = ['primary', 'secondary', 'allthrough', 'special', 'independent', 'nursery'];

export const SCHOOL_KIND_LABEL: Record<SchoolKind, string> = {
  nursery: 'Nursery & early years',
  primary: 'Primary',
  secondary: 'Secondary',
  allthrough: 'All-through',
  special: 'Special & alternative',
  independent: 'Independent',
};

/** New York wording (elementary, middle and high school). */
export const SCHOOL_KIND_LABEL_NYC: Record<SchoolKind, string> = {
  nursery: 'Early childhood',
  primary: 'Elementary',
  secondary: 'Middle & high school',
  allthrough: 'K-8 & K-12',
  special: 'Ungraded & other',
  independent: 'Independent',
};

/** Map colours by kind (RGB). */
export const SCHOOL_KIND_COLOR: Record<SchoolKind, [number, number, number]> = {
  nursery: [255, 214, 102],
  primary: [96, 200, 255],
  secondary: [255, 138, 76],
  allthrough: [178, 132, 255],
  special: [94, 214, 160],
  independent: [235, 235, 240],
};

export interface SchoolRecord {
  /** Name. */
  n: string;
  lon: number;
  lat: number;
  k: SchoolKind;
  /** Pupils on roll (0 = not published). */
  p: number;
  /** Pupils of secondary age (11–18; New York grades 6–12). */
  s: number;
  /** Establishment type ("Academy converter", "High school"). */
  t?: string;
  /** Age range ("4–11"), England only. */
  a?: string;
}

export interface SchoolsFile {
  version: 1;
  year: string;
  source: string;
  schools: SchoolRecord[];
}

export interface School extends SchoolRecord {
  /** Local metres. */
  x: number;
  y: number;
}

/** Schools by position: a 1 km grid for catchment queries. */
export class SchoolIndex {
  private grid = new Map<number, School[]>();
  constructor(readonly all: School[]) {
    for (const s of all) {
      const k = this.key(Math.floor(s.x / 1000), Math.floor(s.y / 1000));
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(s);
    }
  }
  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }
  /** Schools within r metres of (x, y), nearest first. */
  near(x: number, y: number, r: number): { school: School; d: number }[] {
    const out: { school: School; d: number }[] = [];
    const n = Math.ceil(r / 1000);
    const cx = Math.floor(x / 1000), cy = Math.floor(y / 1000);
    for (let i = cx - n; i <= cx + n; i++)
      for (let j = cy - n; j <= cy + n; j++)
        for (const s of this.grid.get(this.key(i, j)) ?? []) {
          const d = Math.hypot(s.x - x, s.y - y);
          if (d <= r) out.push({ school: s, d });
        }
    return out.sort((a, b) => a.d - b.d);
  }
}
