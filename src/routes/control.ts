/**
 * Operations control settings per route (v2): defaults, the configuration for routes from older
 * saves, the all-off configuration, and the timepoint suggestion.
 */
import { OPS_CONTROL } from '../balance';
import type { Route, RouteControl } from './types';

/** New routes: holding at 70% at the first stop, no timepoints, 10% recovery, short turnarounds. */
export function defaultControl(): RouteControl {
  return { hold: OPS_CONTROL.defaultHold, holdFraction: OPS_CONTROL.holdFraction, timepoints: [], recoveryPct: OPS_CONTROL.defaultRecovery, shortTurn: true };
}

/** Routes from saves before operations control: holding off and no recovery (the fleet is unchanged); short turnarounds on. */
export function legacyControl(): RouteControl {
  return { hold: false, holdFraction: OPS_CONTROL.holdFraction, timepoints: [], recoveryPct: 0, shortTurn: true };
}

/** Every mechanic off: trains run exactly as before operations control (the identity configuration). */
export function offControl(): RouteControl {
  return { hold: false, holdFraction: OPS_CONTROL.holdFraction, timepoints: [], recoveryPct: 0, shortTurn: false };
}

const nearest = (v: number, choices: readonly number[]) => choices.reduce((b, c) => (Math.abs(c - v) < Math.abs(b - v) ? c : b), choices[0]);

/** A valid control from anything (a save, a draft): unknown fields fall back to `base` (legacy by default). */
export function normalizeControl(c: Partial<RouteControl> | undefined | null, base: RouteControl = legacyControl()): RouteControl {
  const x = c && typeof c === 'object' ? c : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    hold: typeof x.hold === 'boolean' ? x.hold : base.hold,
    holdFraction: nearest(num(x.holdFraction, base.holdFraction), OPS_CONTROL.holdFractionChoices),
    timepoints: Array.isArray(x.timepoints) ? [...new Set(x.timepoints.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)))] : [...base.timepoints],
    recoveryPct: nearest(num(x.recoveryPct, base.recoveryPct), OPS_CONTROL.recoveryChoices),
    shortTurn: typeof x.shortTurn === 'boolean' ? x.shortTurn : base.shortTurn,
  };
}

/**
 * Suggested timepoints: for each fraction in OPS_CONTROL.suggestTimepointsAt, the intermediate stop
 * nearest that point of the stop list, preferring stops no other route serves (so a hold never sits
 * on an interlined platform) within (n − 1) / 6 stops of the target, and otherwise the nearest one
 * even if shared (so both don't end up at one end of an interlined route). Each stop is picked once,
 * and not next to one already picked when there is a choice. Routes with fewer than
 * OPS_CONTROL.suggestOneBelow stops get one timepoint at the midpoint.
 */
export function suggestTimepoints(r: Pick<Route, 'id' | 'stops'>, all: readonly Pick<Route, 'id' | 'stops'>[]): number[] {
  const n = r.stops.length;
  if (n < 3) return [];
  const shared = new Set<number>();
  for (const o of all) if (o.id !== r.id) for (const s of o.stops) shared.add(s);
  const fracs = n < OPS_CONTROL.suggestOneBelow ? [0.5] : OPS_CONTROL.suggestTimepointsAt;
  const picked: number[] = [];
  const pickedAt: number[] = [];
  const window = (n - 1) / 6;
  for (const f of fracs) {
    const target = Math.round(f * (n - 1));
    const free: number[] = [];
    for (let k = 1; k < n - 1; k++) if (!picked.includes(r.stops[k])) free.push(k);
    free.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    const apart = free.filter((c) => !pickedAt.some((p) => Math.abs(p - c) <= 1));
    const cands = apart.length ? apart : free;
    const k = cands.find((c) => Math.abs(c - target) <= window && !shared.has(r.stops[c])) ?? cands[0];
    if (k !== undefined) {
      picked.push(r.stops[k]);
      pickedAt.push(k);
    }
  }
  // In route order.
  return r.stops.filter((s) => picked.includes(s));
}

/** "holding 70% · 2 timepoints · recovery 10%" ("holding off · recovery 0%"). */
export function controlSummary(c: RouteControl): string {
  const parts = [c.hold ? `holding ${Math.round(c.holdFraction * 100)}%` : 'holding off'];
  if (c.hold && c.timepoints.length) parts.push(`${c.timepoints.length} timepoint${c.timepoints.length > 1 ? 's' : ''}`);
  parts.push(`recovery ${Math.round(c.recoveryPct * 100)}%`);
  if (!c.shortTurn) parts.push('standard turnarounds');
  return parts.join(' · ');
}
