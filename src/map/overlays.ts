/**
 * Data overlays (one at a time): residents, jobs, unserved demand, crowding and commuter flows.
 * Tract-based overlays draw each tract as a disc of its approximate radius, coloured by density.
 */
import { ScatterplotLayer, ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Tract } from '../data/world';
import { RAMP_COOL, RAMP_VIOLET, RAMP_WARM, logT, type RGBA } from './colorRamp';
import { Emitter } from '../core/emitter';

export type OverlayMode = 'none' | 'residents' | 'jobs' | 'unserved' | 'crowding' | 'flows';

export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  none: 'No overlay',
  residents: 'Residents density',
  jobs: 'Jobs density',
  unserved: 'Unserved demand',
  crowding: 'Crowding',
  flows: 'Commuter flows',
};

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
}

interface Disc {
  pos: [number, number];
  r: number;
  t: number;
  tract: Tract;
}

export class Overlays {
  mode: OverlayMode = 'none';
  readonly events = new Emitter<{ change: OverlayMode }>();
  private discs: Disc[] = [];
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
    if (this.mode === 'unserved' || this.mode === 'flows') this.rebuild();
  }

  legend(): OverlayLegend | null {
    switch (this.mode) {
      case 'residents':
        return { title: 'Residents (commuters living here)', ramp: RAMP_COOL, lo: this.densityScale(1000), hi: this.densityScale(60000) };
      case 'jobs':
        return { title: 'Jobs', ramp: RAMP_WARM, lo: this.densityScale(1000), hi: this.densityScale(200000) };
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

  private rebuild(): void {
    this.version++;
    const tracts = this.tracts;
    const discs: Disc[] = [];
    if (this.mode === 'residents' || this.mode === 'jobs') {
      const jobs = this.mode === 'jobs';
      for (const t of tracts) {
        const v = (jobs ? t.jobs : t.residents) / Math.max(t.areaKm2, 0.02);
        if (v < 50) continue;
        discs.push({ pos: [t.lon, t.lat], r: t.radius * 1.12, t: logT(v, 1000, jobs ? 200000 : 60000), tract: t });
      }
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
  }

  layers(): Layer[] {
    const out: Layer[] = [];
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
