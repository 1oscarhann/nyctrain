/**
 * Data overlays (one at a time): residents, jobs, city growth, unserved demand, crowding and
 * commuter flows. Tract-based overlays draw each tract as a disc of its approximate radius,
 * coloured by density (residents and jobs as they are now, once the city has grown) or by growth
 * since the start. The growth overlay adds the value-capture district's rings and, tilted, 3D
 * "new development" columns.
 */
import { ScatterplotLayer, ArcLayer, ColumnLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { VALUE_CAPTURE } from '../balance';
import { monthLabel } from '../core/calendar';
import type { Tract } from '../data/world';
import type { GrowthView } from '../sim/protocol';
import { RAMP_COOL, RAMP_DIVERGE, RAMP_VIOLET, RAMP_WARM, logT, type RGBA } from './colorRamp';
import { columnHeight, columnRadiusClass, GROWTH_MIN_DRAWN, GROWTH_RAMP_SPAN, growthLegendEnds, growthSpan, growthT, tractGrowthSince, tractPeopleAdded } from './growthMath';
import { Emitter } from '../core/emitter';

export type OverlayMode = 'none' | 'demand' | 'demandWork' | 'residents' | 'jobs' | 'growth' | 'unserved' | 'crowding' | 'flows';

export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  none: 'No overlay',
  demand: 'Demand: where people live',
  demandWork: 'Demand: where people work',
  residents: 'Residents density',
  jobs: 'Jobs density',
  // The start year comes from TIME.startDate (read when the menu is built, after applyCity).
  get growth() {
    return `City growth since ${monthLabel(0).slice(-4)}`;
  },
  unserved: 'Unserved demand',
  crowding: 'Crowding',
  flows: 'Commuter flows',
};

export { GROWTH_MIN_DRAWN, GROWTH_RAMP_SPAN, growthT, tractGrowthSince, tractPeopleAdded } from './growthMath';

export interface OverlayLegend {
  title: string;
  ramp: (t: number) => RGBA;
  lo: string;
  hi: string;
  note?: string;
  /** A colour key instead of a ramp (demand dots). */
  items?: { label: string; color: RGBA }[];
}

/** Demand dots: how people travel today. */
export const DEMAND_COLORS: { label: string; color: RGBA }[] = [
  { label: 'Walk', color: [110, 205, 140, 230] },
  { label: 'Drive', color: [240, 86, 86, 230] },
  { label: 'Transit', color: [72, 156, 255, 240] },
];

interface Dot {
  pos: [number, number];
  m: number;
}

export interface FlowLine {
  from: [number, number];
  to: [number, number];
  count: number;
  /** 0..1 share using transit, for colouring. */
  transitShare: number;
}

export interface OverlayData {
  /** Per tract: commuters (residents) whose trips have no reasonable transit option. */
  unserved?: Float32Array;
  flows?: FlowLine[];
  /** Living City: the grown city (residents, jobs and growth overlays). */
  growth?: GrowthView | null;
  /** Served stations' positions (lon, lat): the value-capture district is within districtRadius of them. */
  served?: [number, number][];
  /** Demand dots: per tract [home walk, drive, transit, work walk, drive, transit] (Commuters.modesByTract). */
  modes?: Float32Array;
}

interface Disc {
  pos: [number, number];
  r: number;
  t: number;
  tract: Tract;
}

interface Column {
  pos: [number, number];
  r: number;
  height: number;
}

/** The 3D columns of one radius class (one ColumnLayer each). */
interface ColumnGroup {
  r: number;
  data: Column[];
}

/** New development columns: the top of the growth ramp. */
const COLUMN_TOP = RAMP_DIVERGE(1);
const COLUMN_COLOR: RGBA = [COLUMN_TOP[0], COLUMN_TOP[1], COLUMN_TOP[2], 220];

export class Overlays {
  mode: OverlayMode = 'none';
  readonly events = new Emitter<{ change: OverlayMode }>();
  private discs: Disc[] = [];
  private dots: Dot[] = [];
  /** People per demand dot (shown in the legend). */
  private perDot = 0;
  private columns: ColumnGroup[] = [];
  /** The growth ramp's current end (±span), from the biggest change drawn. */
  private span = GROWTH_RAMP_SPAN;
  private data: OverlayData = {};
  private version = 0;
  /** Crowding is drawn by the network renderer; it just needs to know the mode. */

  constructor(private tracts: Tract[], private densityScale: (km2: number) => string) {}

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    this.rebuild();
    this.events.emit('change', mode);
  }

  setData(data: OverlayData): void {
    // Rebuild only when something new arrived (the growth view is cached, and handed over again at
    // every day end).
    const changed = (Object.keys(data) as (keyof OverlayData)[]).some((k) => data[k] !== this.data[k]);
    this.data = { ...this.data, ...data };
    if (changed && this.mode !== 'none' && this.mode !== 'crowding') this.rebuild();
  }

  /** The growth data the overlays draw from (null until loaded). */
  get growth(): GrowthView | null {
    return this.data.growth ?? null;
  }

  legend(): OverlayLegend | null {
    switch (this.mode) {
      case 'demand':
      case 'demandWork':
        return {
          title: this.mode === 'demand' ? 'Commuters by home: how they travel' : 'Commuters by workplace: how they travel',
          ramp: RAMP_COOL,
          lo: '',
          hi: '',
          items: DEMAND_COLORS,
          note: this.data.modes ? `Each dot is about ${this.perDot.toLocaleString()} people. Updated each morning.` : 'Loading…',
        };
      case 'residents':
        return { title: 'Residents (commuters living here)', ramp: RAMP_COOL, lo: this.densityScale(1000), hi: this.densityScale(60000) };
      case 'jobs':
        return { title: 'Jobs', ramp: RAMP_WARM, lo: this.densityScale(1000), hi: this.densityScale(200000) };
      case 'growth': {
        const v = this.data.growth;
        const rings = `Rings: value-capture district (${this.districtWord()} of a served station).`;
        const [lo, hi] = growthLegendEnds(this.span);
        const off = this.growthOff();
        return {
          title: `Growth since ${monthLabel(0)}`,
          ramp: RAMP_DIVERGE,
          lo,
          hi,
          note:
            v && v.months === 0
              ? off
                ? `City growth is off (Menu → City growth). ${rings}`
                : `No month has closed yet: the city grows around good transit at each month end. ${rings}`
              : `Residents + jobs${off ? ' (city growth is off: no more change)' : ''}. ${rings} Tilt (V) to see new development.`,
        };
      }
      case 'unserved':
        return {
          title: 'Unserved demand',
          ramp: RAMP_VIOLET,
          lo: '100',
          hi: '5k+ commuters',
          note: 'Commuters from each tract with no reasonable transit option',
        };
      case 'crowding':
        return {
          title: 'Crowding',
          ramp: (t) => crowdColor(t * 1.4),
          lo: 'quiet',
          hi: 'crush',
          note: 'Peak-hour load on each segment, waiting crowds at stations',
        };
      case 'flows':
        return {
          title: 'Commuter flows',
          ramp: (t) => flowColor(t),
          lo: 'by car / foot',
          hi: 'by transit',
          note: 'Largest home → work tract pairs',
        };
      default:
        return null;
    }
  }

  /** "½ mi" or "800 m": the district radius in the player's units (set by the app). */
  districtWord: () => string = () => `${VALUE_CAPTURE.districtRadius} m`;
  /** City growth is off (set by the app; the legend says so). */
  growthOff: () => boolean = () => false;

  private rebuild(): void {
    this.version++;
    const tracts = this.tracts;
    this.dots = [];
    if ((this.mode === 'demand' || this.mode === 'demandWork') && this.data.modes) {
      // About 12,000 dots across the map, each a fixed number of people, scattered over the tract
      // (the same places every time) and coloured in proportion to how its people travel.
      const m = this.data.modes;
      const off = this.mode === 'demandWork' ? 3 : 0;
      let total = 0;
      for (let i = 0; i < tracts.length; i++) total += m[i * 6 + off] + m[i * 6 + off + 1] + m[i * 6 + off + 2];
      const per = (this.perDot = Math.max(100, Math.round(total / 12000 / 50) * 50 || 100));
      const hash = (a: number, b: number) => {
        let h = Math.imul(a + 0x9e37, 0x85ebca6b) ^ Math.imul(b + 0x51ed, 0xc2b2ae35);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        return (h >>> 0) / 4294967296;
      };
      tracts.forEach((t, i) => {
        const w = m[i * 6 + off], d = m[i * 6 + off + 1], tr = m[i * 6 + off + 2];
        const sum = w + d + tr;
        const n = Math.round(sum / per);
        if (n <= 0) return;
        // Largest remainder: dots per mode match the shares exactly in total.
        const want = [w, d, tr].map((v) => (v / sum) * n);
        const k = want.map(Math.floor);
        let left = n - k[0] - k[1] - k[2];
        const order = [0, 1, 2].sort((a, b) => want[b] - k[b] - (want[a] - k[a]));
        for (const j of order) if (left-- > 0) k[j]++;
        let idx = 0;
        const kmLat = 1 / 111_000, kmLon = 1 / (111_000 * Math.cos((t.lat * Math.PI) / 180));
        for (let mode = 0; mode < 3; mode++)
          for (let q = 0; q < k[mode]; q++, idx++) {
            const r = t.radius * 0.9 * Math.sqrt(hash(i, idx * 2));
            const a = hash(i, idx * 2 + 1) * Math.PI * 2;
            this.dots.push({ pos: [t.lon + Math.cos(a) * r * kmLon, t.lat + Math.sin(a) * r * kmLat], m: mode });
          }
      });
    }
    const discs: Disc[] = [];
    const gv = this.data.growth ?? null;
    if (this.mode === 'residents' || this.mode === 'jobs') {
      const jobs = this.mode === 'jobs';
      // Residents and jobs as they are now: the start × the tract's multiplier.
      const m = gv ? (jobs ? gv.mJobs : gv.mRes) : null;
      for (const t of tracts) {
        const v = ((jobs ? t.jobs : t.residents) * (m ? (m[t.index] ?? 1) : 1)) / Math.max(t.areaKm2, 0.02);
        if (v < 50) continue;
        discs.push({ pos: [t.lon, t.lat], r: t.radius * 1.12, t: logT(v, 1000, jobs ? 200000 : 60000), tract: t });
      }
    } else if (this.mode === 'growth' && gv) {
      const drawn: { t: Tract; u: number }[] = [];
      const byR = new Map<number, Column[]>();
      let maxAbs = 0;
      for (const t of tracts) {
        const u = tractGrowthSince(t, gv);
        if (Math.abs(u) >= GROWTH_MIN_DRAWN) {
          drawn.push({ t, u });
          maxAbs = Math.max(maxAbs, Math.abs(u));
        }
        // New development (3D): a hexagonal column per growing tract, its height the people added.
        const height = columnHeight(tractPeopleAdded(t, gv));
        if (height > 0) {
          const r = columnRadiusClass(Math.min(250, 0.6 * t.radius));
          let arr = byR.get(r);
          if (!arr) byR.set(r, (arr = []));
          arr.push({ pos: [t.lon, t.lat], r, height });
        }
      }
      // The ramp widens with the biggest change (±2% … ±20%), so the first months show.
      this.span = growthSpan(maxAbs);
      for (const { t, u } of drawn) discs.push({ pos: [t.lon, t.lat], r: t.radius * 1.12, t: growthT(u, this.span), tract: t });
      // Declines under growth, so the bright growing tracts sit on top where discs overlap.
      discs.sort((a, b) => Math.abs(a.t - 0.5) - Math.abs(b.t - 0.5));
      this.discs = discs;
      this.columns = [...byR.entries()].sort((a, b) => a[0] - b[0]).map(([r, data]) => ({ r, data }));
      return;
    } else if (this.mode === 'unserved' && this.data.unserved) {
      const u = this.data.unserved;
      for (const t of tracts) {
        const v = u[t.index];
        if (v < 20) continue;
        discs.push({ pos: [t.lon, t.lat], r: t.radius * 1.12, t: logT(v, 100, 5000), tract: t });
      }
    }
    discs.sort((a, b) => a.t - b.t);
    this.discs = discs;
    this.columns = [];
  }

  /** Deck layers for the current mode; `is3D` adds the growth overlay's new-development columns. */
  layers(is3D = false): Layer[] {
    const out: Layer[] = [];
    if (this.mode === 'growth') {
      out.push(
        new ScatterplotLayer<Disc>({
          id: 'overlay-growth',
          data: this.discs,
          getPosition: (d) => d.pos,
          getRadius: (d) => d.r,
          radiusUnits: 'meters',
          getFillColor: (d) => RAMP_DIVERGE(d.t),
          stroked: false,
          pickable: false,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
          updateTriggers: { getFillColor: this.version, getRadius: this.version },
        }),
      );
      const served = this.data.served ?? [];
      if (served.length) {
        // The district boundary: districtRadius around every served station (their union).
        out.push(
          new ScatterplotLayer<[number, number]>({
            id: 'overlay-district',
            data: served,
            getPosition: (d) => d,
            getRadius: VALUE_CAPTURE.districtRadius,
            radiusUnits: 'meters',
            filled: false,
            stroked: true,
            getLineColor: [231, 235, 239, 90],
            getLineWidth: 1,
            lineWidthUnits: 'pixels',
            pickable: false,
            parameters: { depthCompare: 'always', depthWriteEnabled: false },
            updateTriggers: { getPosition: this.version },
          }),
        );
      }
      if (is3D && this.columns.length) {
        // ColumnLayer has one radius per layer: the columns come in 25 m radius classes (grouped in rebuild).
        for (const { r, data } of this.columns) {
          out.push(
            new ColumnLayer<Column>({
              id: `overlay-growth-columns-${r}`,
              data,
              diskResolution: 6,
              radius: r,
              getPosition: (d) => d.pos,
              getElevation: (d) => d.height,
              extruded: true,
              getFillColor: COLUMN_COLOR,
              material: { ambient: 0.55, diffuse: 0.6, shininess: 16, specularColor: [60, 70, 80] },
              pickable: false,
              updateTriggers: { getElevation: this.version },
            }),
          );
        }
      }
      return out;
    }
    if ((this.mode === 'demand' || this.mode === 'demandWork') && this.dots.length) {
      out.push(
        new ScatterplotLayer<Dot>({
          id: 'overlay-demand',
          data: this.dots,
          getPosition: (d) => d.pos,
          getRadius: 2.3,
          radiusUnits: 'pixels',
          radiusMinPixels: 1.6,
          getFillColor: (d) => DEMAND_COLORS[d.m].color,
          stroked: false,
          pickable: false,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
          updateTriggers: { getFillColor: this.version },
        }),
      );
    }
    if (this.mode === 'residents' || this.mode === 'jobs' || this.mode === 'unserved') {
      const ramp = this.mode === 'residents' ? RAMP_COOL : this.mode === 'jobs' ? RAMP_WARM : RAMP_VIOLET;
      out.push(
        new ScatterplotLayer<Disc>({
          id: 'overlay-tracts',
          data: this.discs,
          getPosition: (d) => d.pos,
          getRadius: (d) => d.r,
          radiusUnits: 'meters',
          getFillColor: (d) => ramp(d.t),
          stroked: false,
          pickable: false,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
          updateTriggers: { getFillColor: [this.mode, this.version], getRadius: this.version },
        }),
      );
    } else if (this.mode === 'flows' && this.data.flows) {
      const flows = this.data.flows;
      const max = flows.reduce((m, f) => Math.max(m, f.count), 1);
      out.push(
        new ArcLayer<FlowLine>({
          id: 'overlay-flows',
          data: flows,
          getSourcePosition: (f) => f.from,
          getTargetPosition: (f) => f.to,
          getSourceColor: (f) => flowColor(f.transitShare, 0.35),
          getTargetColor: (f) => flowColor(f.transitShare, 0.9),
          getWidth: (f) => 1 + 7 * Math.sqrt(f.count / max),
          widthUnits: 'pixels',
          getHeight: 0.35,
          greatCircle: false,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
          updateTriggers: { getSourceColor: this.version, getTargetColor: this.version, getWidth: this.version },
        }),
      );
    }
    return out;
  }
}

/** 0 = empty, 1 = comfortable capacity, 1.4+ = crush. Green → amber → red as the signal palette. */
export function crowdColor(loadFactor: number, alpha = 230): RGBA {
  const stops: [number, [number, number, number]][] = [
    [0, [76, 208, 138]],
    [0.75, [76, 208, 138]],
    [1.0, [255, 194, 74]],
    [1.4, [255, 93, 93]],
  ];
  const x = Math.max(0, loadFactor);
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (x <= b) {
      const f = (x - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f, alpha];
    }
  }
  return [255, 93, 93, alpha];
}

export function flowColor(share: number, alpha = 0.85): RGBA {
  // Muted grey-blue (cars/feet) → bright cyan (transit)
  const a: [number, number, number] = [142, 153, 165];
  const b: [number, number, number] = [80, 220, 255];
  const s = Math.max(0, Math.min(1, share));
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, alpha * 255];
}
