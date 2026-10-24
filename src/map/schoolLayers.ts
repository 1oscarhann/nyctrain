/**
 * Schools layer (deck.gl): every real school on the map (public/data/<city>/schools.json), as a dot
 * coloured by kind and sized by pupils, named from zoom 14. It sits on top of any overlay and is
 * filtered by kind (Overlays menu → Schools). Per viewer: on/off and the kinds shown are remembered.
 */
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { city } from '../cities';
import { toLocal } from '../core/geo';
import { SCHOOL_KIND_COLOR, SCHOOL_KIND_LABEL, SCHOOL_KIND_LABEL_NYC, SCHOOL_KINDS, SchoolIndex, type School, type SchoolKind, type SchoolsFile } from '../data/schools';

const KEY = 'headway-schools';
const DEPTH_OFF = { depthCompare: 'always', depthWriteEnabled: false } as const;

interface Prefs {
  on: boolean;
  kinds: SchoolKind[];
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    const kinds = Array.isArray(raw?.kinds) ? raw!.kinds.filter((k): k is SchoolKind => SCHOOL_KINDS.includes(k as SchoolKind)) : SCHOOL_KINDS;
    return { on: raw?.on === true, kinds };
  } catch {
    return { on: false, kinds: [...SCHOOL_KINDS] };
  }
}

function storePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: not remembered */
  }
}

export function schoolKindLabel(k: SchoolKind): string {
  return (city().id === 'nyc' ? SCHOOL_KIND_LABEL_NYC : SCHOOL_KIND_LABEL)[k];
}

export class SchoolLayers {
  index: SchoolIndex | null = null;
  source = '';
  year = '';
  on: boolean;
  kinds: Set<SchoolKind>;
  private version = 0;
  private shown: School[] = [];
  private loading: Promise<void> | null = null;
  onChange: () => void = () => {};

  constructor() {
    const p = loadPrefs();
    this.on = p.on;
    this.kinds = new Set(p.kinds);
  }

  /** Fetch the city's schools once (quietly: a map without the file just has no schools). */
  load(base: string): Promise<void> {
    this.loading ??= fetch(base + 'schools.json')
      .then((r) => (r.ok ? (r.json() as Promise<SchoolsFile>) : null))
      .then((f) => {
        if (!f?.schools) return;
        const all = f.schools.map((s) => {
          const [x, y] = toLocal(s.lon, s.lat);
          return { ...s, x, y };
        });
        this.index = new SchoolIndex(all);
        this.source = f.source;
        this.year = f.year;
        this.refilter();
      })
      .catch(() => undefined);
    return this.loading;
  }

  /** Kinds present on this map, with counts. */
  counts(): Map<SchoolKind, number> {
    const m = new Map<SchoolKind, number>();
    for (const s of this.index?.all ?? []) m.set(s.k, (m.get(s.k) ?? 0) + 1);
    return m;
  }

  setOn(on: boolean): void {
    this.on = on;
    this.save();
  }

  toggleKind(k: SchoolKind): void {
    if (this.kinds.has(k)) this.kinds.delete(k);
    else this.kinds.add(k);
    this.save();
  }

  /** Only these kinds (or every kind). */
  setKinds(ks: SchoolKind[]): void {
    this.kinds = new Set(ks);
    this.save();
  }

  private save(): void {
    storePrefs({ on: this.on, kinds: [...this.kinds] });
    this.refilter();
  }

  private refilter(): void {
    this.shown = (this.index?.all ?? []).filter((s) => this.kinds.has(s.k));
    this.version++;
    this.onChange();
  }

  /** Shown schools within r metres (for the station panel and hover), nearest first. */
  near(x: number, y: number, r: number, all = false): { school: School; d: number }[] {
    const hits = this.index?.near(x, y, r) ?? [];
    return all ? hits : hits.filter((h) => this.kinds.has(h.school.k));
  }

  /** The shown school under the pointer, if the layer is on. */
  pick(x: number, y: number, tol: number): School | null {
    if (!this.on) return null;
    return this.near(x, y, tol)[0]?.school ?? null;
  }

  layers(zoom: number): Layer[] {
    if (!this.on || !this.shown.length) return [];
    // Small dots when zoomed out (thousands of schools), growing with pupils and zoom.
    const zf = Math.max(0.45, Math.min(1.25, (zoom - 9) / 4));
    const out: Layer[] = [
      new ScatterplotLayer<School>({
        id: 'schools',
        data: this.shown,
        getPosition: (s) => [s.lon, s.lat],
        getRadius: (s) => (2 + Math.min(7, Math.sqrt(s.p || 100) / 5)) * zf,
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: (s) => [...SCHOOL_KIND_COLOR[s.k], 225] as [number, number, number, number],
        getLineColor: [10, 10, 12, 220],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        parameters: DEPTH_OFF,
        updateTriggers: { getRadius: Math.round(zf * 20), getFillColor: this.version },
      }),
    ];
    if (zoom >= 14)
      out.push(
        new TextLayer<School>({
          id: 'school-labels',
          data: this.shown,
          getPosition: (s) => [s.lon, s.lat],
          getText: (s) => s.n,
          getSize: 11,
          getColor: (s) => [...SCHOOL_KIND_COLOR[s.k], 255] as [number, number, number, number],
          getPixelOffset: [0, 12],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          fontFamily: city().theme === 'tfl' ? 'Cabin, Overpass, sans-serif' : 'Overpass, sans-serif',
          fontWeight: 600,
          fontSettings: { sdf: true, fontSize: 40, buffer: 6 },
          outlineWidth: 3,
          outlineColor: [10, 10, 12, 230],
          characterSet: 'auto',
          parameters: DEPTH_OFF,
          updateTriggers: { getColor: this.version },
        }),
      );
    return out;
  }
}

/** Hover text for a school. */
export function schoolTip(s: School): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const bits = [schoolKindLabel(s.k), s.p ? `${s.p.toLocaleString()} pupils` : null, s.a ? `ages ${s.a}` : null].filter(Boolean).join(' · ');
  return `<div class="title">${esc(s.n)}</div><div class="hw-muted">${esc(bits)}${s.t ? `<br>${esc(s.t)}` : ''}</div>`;
}
