/**
 * Data overlays (one at a time): residents, jobs, city growth, unserved demand, crowding and
 * commuter flows. Tract-based overlays draw each tract as a disc of its approximate radius,
 * coloured by density (residents and jobs as they are now, once the city has grown) or by growth
 * since the start. The growth overlay adds the value-capture district's rings and, tilted, 3D
 * "new development" columns.
 */
import { ScatterplotLayer, ArcLayer, ColumnLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { MAP, VALUE_CAPTURE } from '../balance';
import { monthLabel } from '../core/calendar';
import type { Tract } from '../data/world';
import type { GrowthView } from '../sim/protocol';
import { RAMP_COOL, RAMP_DIVERGE, RAMP_VIOLET, RAMP_WARM, logT, type RGBA } from './colorRamp';
import { Emitter } from '../core/emitter';

export type OverlayMode = 'none' | 'residents' | 'jobs' | 'growth' | 'unserved' | 'crowding' | 'flows';

export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  none: 'No overlay',
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

/** Growth below this (|Δ| of residents + jobs since the start) is not drawn. */
export const GROWTH_MIN_DRAWN = 0.002;
/** The ramp's ends: ±20% since the start. */
export const GROWTH_RAMP_SPAN = 0.2;

/**
 * Ramp position of a tract's growth since the start (u = 0.05 is +5%): 0.5 is no change, 1 is
 * +20% or more, 0 is −20% or less, with a gamma that lifts small changes off the neutral centre.
 */
export function growthT(u: number): number {
  if (!Number.isFinite(u) || u === 0) return 0.5;
  return 0.5 + 0.5 * Math.sign(u) * Math.min(1, Math.abs(u) / GROWTH_RAMP_SPAN) ** 0.6;
}

/** Residents + jobs growth of tract i since the start (0 without growth data or for an empty tract). */
export function tractGrowthSince(t: Tract, v: GrowthView | null | undefined): number {
  if (!v) return 0;
  const base = t.residents + t.jobs;
  if (!(base > 0)) return 0;
  return (t.residents * (v.mRes[t.index] ?? 1) + t.jobs * (v.mJobs[t.index] ?? 1)) / base - 1;
}

/** Residents and jobs added since the start (real people; negative for a decline). */
export function tractPeopleAdded(t: Tract, v: GrowthView | null | undefined): number {
  if (!v) return 0;
  return t.residents * ((v.mRes[t.index] ?? 1) - 1) + t.jobs * ((v.mJobs[t.index] ?? 1) - 1);
}

export interface OverlayLegend {
  title: string;
  ramp: (t: number) => RGBA;
  lo: string;
  hi: string;
  note?: string;
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

export class Overlays {
  mode: OverlayMode = 'none';
  readonly events = new Emitter<{ change: OverlayMode }>();
  private discs: Disc[] = [];
  private columns: Column[] = [];
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
    this.data = { ...this.data, ...data };
    if (this.mode !== 'none' && this.mode !== 'crowding') this.rebuild();
  }

  /** The growth data the overlays draw from (null until loaded). */
  get growth(): GrowthView | null {
    return this.data.growth ?? null;
  }

  legend(): OverlayLegend | null {
    switch (this.mode) {
      case 'residents':
        return { title: 'Residents (commuters living here)', ramp: RAMP_COOL, lo: this.densityScale(1000), hi: this.densityScale(60000) };
      case 'jobs':
        return { title: 'Jobs', ramp: RAMP_WARM, lo: this.densityScale(1000), hi: this.densityScale(200000) };
      case 'growth': {
        const v = this.data.growth;
        const ring = this.districtWord();
        return {
          title: `Growth since ${monthLabel(0)}`,
          ramp: RAMP_DIVERGE,
          lo: '−20%',
          hi: '+20%+',
          note:
            v && v.months === 0
              ? `No month has closed yet: the city grows around good transit at each month end. Rings: value-capture district (${ring} of a served station).`
              : `Residents + jobs. Rings: value-capture district (${ring} of a served station). Tilt (V) to see new development.`,
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

  private rebuild(): void {
    this.version++;
    const tracts = this.tracts;
    const discs: Disc[] = [];
    const columns: Column[] = [];
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
      for (const t of tracts) {
        const u = tractGrowthSince(t, gv);
        if (Math.abs(u) >= GROWTH_MIN_DRAWN) discs.push({ pos: [t.lon, t.lat], r: t.radius * 1.12, t: growthT(u), tract: t });
        // New development (3D): a hexagonal column per growing tract, its height the people added.
        const added = tractPeopleAdded(t, gv);
        if (added > 50) columns.push({ pos: [t.lon, t.lat], r: Math.min(250, 0.6 * t.radius), height: added * MAP.growthColumnMetresPerPerson });
      }
      // Declines under growth, so the bright growing tracts sit on top where discs overlap.
      discs.sort((a, b) => Math.abs(a.t - 0.5) - Math.abs(b.t - 0.5));
      this.discs = discs;
      this.columns = columns;
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
    this.columns = columns;
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
        // ColumnLayer has one radius per layer, so columns go in 25 m radius classes.
        const top = RAMP_DIVERGE(1);
        const byR = new Map<number, Column[]>();
        for (const c of this.columns) {
          const r = Math.max(25, Math.round(c.r / 25) * 25);
          let arr = byR.get(r);
          if (!arr) byR.set(r, (arr = []));
          arr.push(c);
        }
        for (const [r, data] of [...byR.entries()].sort((a, b) => a[0] - b[0])) {
          out.push(
            new ColumnLayer<Column>({
              id: `overlay-growth-columns-${r}`,
              data,
              diskResolution: 6,
              radius: r,
              getPosition: (d) => d.pos,
              getElevation: (d) => d.height,
              extruded: true,
              getFillColor: [top[0], top[1], top[2], 220],
              material: { ambient: 0.55, diffuse: 0.6, shininess: 16, specularColor: [60, 70, 80] },
              pickable: false,
              updateTriggers: { getElevation: this.version },
            }),
          );
        }
      }
      return out;
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
