/**
 * Living City overlay arithmetic (pure, no deck.gl): a tract's growth since the start, where it
 * sits on the diverging ramp, the ramp's span (it widens with the city's biggest change, so the
 * first months are visible), and the 3D columns' radius classes. Used by the overlay, the hover
 * tip, the goals panel and the tests.
 */
import type { Tract } from '../data/world';
import type { GrowthView } from '../sim/protocol';

/** Growth below this (|Δ| of residents + jobs since the start) is not drawn. */
export const GROWTH_MIN_DRAWN = 0.002;
/** The widest ramp: its ends are ±20% since the start ("+20%+"). */
export const GROWTH_RAMP_SPAN = 0.2;
/**
 * The ramp's possible ends. One Steady month moves the best tract about 0.4%, a year about 5%:
 * against a fixed ±20% the first months would be almost transparent, so the ramp uses the
 * smallest of these that covers the biggest change, and the legend shows it.
 */
export const GROWTH_RAMP_STEPS = [0.02, 0.05, 0.1, 0.2] as const;

/** Residents + jobs growth of a tract since the start (0 without growth data or for an empty tract). */
export function tractGrowthSince(t: Pick<Tract, 'index' | 'residents' | 'jobs'>, v: Pick<GrowthView, 'mRes' | 'mJobs'> | null | undefined): number {
  if (!v) return 0;
  const base = t.residents + t.jobs;
  if (!(base > 0)) return 0;
  return (t.residents * (v.mRes[t.index] ?? 1) + t.jobs * (v.mJobs[t.index] ?? 1)) / base - 1;
}

/** Residents and jobs added since the start (real people; negative for a decline). */
export function tractPeopleAdded(t: Pick<Tract, 'index' | 'residents' | 'jobs'>, v: Pick<GrowthView, 'mRes' | 'mJobs'> | null | undefined): number {
  if (!v) return 0;
  return t.residents * ((v.mRes[t.index] ?? 1) - 1) + t.jobs * ((v.mJobs[t.index] ?? 1) - 1);
}

/** The ramp's end for a city whose biggest change since the start is maxAbs (a fraction). */
export function growthSpan(maxAbs: number): number {
  for (const s of GROWTH_RAMP_STEPS) if (maxAbs <= s + 1e-9) return s;
  return GROWTH_RAMP_SPAN;
}

/**
 * Ramp position of a tract's growth since the start (u = 0.05 is +5%): 0.5 is no change, 1 is
 * +span or more, 0 is −span or less, with a gamma that lifts small changes off the neutral centre.
 */
export function growthT(u: number, span = GROWTH_RAMP_SPAN): number {
  if (!Number.isFinite(u) || u === 0) return 0.5;
  return 0.5 + 0.5 * Math.sign(u) * Math.min(1, Math.abs(u) / span) ** 0.6;
}

/** The legend's ends for a span: ["−2%", "+2%+"]. */
export function growthLegendEnds(span: number): [string, string] {
  const p = `${Math.round(span * 100)}%`;
  return [`−${p}`, `+${p}+`];
}

/** ColumnLayer has one radius per layer, so the 3D columns go in 25 m radius classes (at least 25 m). */
export function columnRadiusClass(r: number): number {
  return Math.max(25, Math.round(r / 25) * 25);
}
