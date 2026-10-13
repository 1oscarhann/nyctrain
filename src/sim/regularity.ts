/**
 * Service regularity (v2): headways measured at every departure, per route, direction and stop.
 * Pure (worker + Node). TrainSim keeps one RouteReg per route id and feeds it; the day's figures
 * go into the DayReport and the route query.
 *
 * Headways are measured as h / H against the scheduled headway H in force (event service
 * included). The coefficient of variation of h / H is the headline; "bunched" is the share of
 * headways under OPS_CONTROL.bunchFactor × H, and the excess wait is what a rider arriving at
 * random waits beyond a perfectly even service: Σh²/(2Σh) − ΣhH/(2Σh).
 */
import { OPS_CONTROL } from '../balance';

export interface RegularityStats {
  /** Headways measured. */
  samples: number;
  /** sd ÷ mean of h/H. */
  cv: number;
  /** Share with h < bunchFactor·H. */
  bunched: number;
  /** Share with h > gapFactor·H. */
  gaps: number;
  /** Excess wait, seconds per random-arrival rider. */
  ewt: number;
  /** Holds (terminal and timepoint) and their total seconds. */
  holds: number;
  holdSec: number;
  /** Mean lateness arriving at terminals, s. */
  termLate: number;
}

export interface RouteReg {
  routeId: number;
  /** Last departure time per stop (−Infinity = none yet). */
  lastDep: [Float64Array, Float64Array];
  n: [Float64Array, Float64Array];
  sx: [Float64Array, Float64Array];
  sxx: [Float64Array, Float64Array];
  sumH: number;
  sumH2: number;
  sumHS: number;
  bunched: number;
  gaps: number;
  holds: number;
  holdSec: number;
  termLateSum: number;
  termLateN: number;
  /** Scheduled one-way run time (mean of the directions), s: the recovery advisor's base. */
  termRun: number;
  /** Short turnarounds today (crews turning in OPS_CONTROL.turnaroundMin). */
  shortTurns: number;
}

export function newRouteReg(routeId: number, stops0: number, stops1: number, runTime: number): RouteReg {
  const z = (k: number) => new Float64Array(k);
  return {
    routeId,
    lastDep: [z(stops0).fill(-Infinity), z(stops1).fill(-Infinity)],
    n: [z(stops0), z(stops1)],
    sx: [z(stops0), z(stops1)],
    sxx: [z(stops0), z(stops1)],
    sumH: 0,
    sumH2: 0,
    sumHS: 0,
    bunched: 0,
    gaps: 0,
    holds: 0,
    holdSec: 0,
    termLateSum: 0,
    termLateN: 0,
    termRun: runTime,
    shortTurns: 0,
  };
}

/**
 * A train left stop k of direction d at time t with scheduled headway H (s). The headway since
 * the previous departure counts unless it is the first, there is no service, or the period (or
 * the headway in force) changed in between.
 */
export function recordHeadway(g: RouteReg, d: 0 | 1, k: number, t: number, H: number, samePeriod: boolean): void {
  const last = g.lastDep[d][k];
  g.lastDep[d][k] = t;
  if (!isFinite(last) || !(H > 0) || !samePeriod) return;
  const h = Math.min(t - last, OPS_CONTROL.maxHeadwayFactor * H);
  const x = h / H;
  g.n[d][k]++;
  g.sx[d][k] += x;
  g.sxx[d][k] += x * x;
  g.sumH += h;
  g.sumH2 += h * h;
  g.sumHS += h * H;
  if (x < OPS_CONTROL.bunchFactor) g.bunched++;
  else if (x > OPS_CONTROL.gapFactor) g.gaps++;
}

export function emptyStats(): RegularityStats {
  return { samples: 0, cv: 0, bunched: 0, gaps: 0, ewt: 0, holds: 0, holdSec: 0, termLate: 0 };
}

interface Sums {
  N: number;
  SX: number;
  SXX: number;
  sumH: number;
  sumH2: number;
  sumHS: number;
  bunched: number;
  gaps: number;
  holds: number;
  holdSec: number;
  termLateSum: number;
  termLateN: number;
}

function sumsOf(gs: readonly RouteReg[]): Sums {
  const s: Sums = { N: 0, SX: 0, SXX: 0, sumH: 0, sumH2: 0, sumHS: 0, bunched: 0, gaps: 0, holds: 0, holdSec: 0, termLateSum: 0, termLateN: 0 };
  for (const g of gs) {
    for (const d of [0, 1] as const) {
      const n = g.n[d], sx = g.sx[d], sxx = g.sxx[d];
      for (let k = 0; k < n.length; k++) {
        s.N += n[k];
        s.SX += sx[k];
        s.SXX += sxx[k];
      }
    }
    s.sumH += g.sumH;
    s.sumH2 += g.sumH2;
    s.sumHS += g.sumHS;
    s.bunched += g.bunched;
    s.gaps += g.gaps;
    s.holds += g.holds;
    s.holdSec += g.holdSec;
    s.termLateSum += g.termLateSum;
    s.termLateN += g.termLateN;
  }
  return s;
}

function statsOf(s: Sums): RegularityStats {
  const N = s.N;
  const mean = N ? s.SX / N : 0;
  return {
    samples: N,
    cv: N > 1 && mean > 0 ? Math.sqrt(Math.max(0, s.SXX / N - mean * mean)) / mean : 0,
    bunched: N ? s.bunched / N : 0,
    gaps: N ? s.gaps / N : 0,
    // Riders arriving at random wait Σh²/(2Σh); a perfect timetable gives ΣhH/(2Σh).
    ewt: s.sumH > 0 ? (s.sumH2 - s.sumHS) / (2 * s.sumH) : 0,
    holds: s.holds,
    holdSec: s.holdSec,
    termLate: s.termLateN ? s.termLateSum / s.termLateN : 0,
  };
}

/** The route's figures so far (pooled over its stops and both directions). */
export function summarize(g: RouteReg): RegularityStats {
  return statsOf(sumsOf([g]));
}

/** Network figure: the routes' raw sums added up, then recomputed. */
export function poolStats(gs: readonly RouteReg[]): RegularityStats {
  return statsOf(sumsOf(gs));
}

/** Headway CV per stop, −1 where fewer than 2 samples; direction 1 reversed into direction-0 stop order. */
export function cvByStop(g: RouteReg): [number[], number[]] {
  const one = (d: 0 | 1) => {
    const n = g.n[d], sx = g.sx[d], sxx = g.sxx[d];
    const out: number[] = [];
    for (let k = 0; k < n.length; k++) {
      const m = n[k] ? sx[k] / n[k] : 0;
      out.push(n[k] > 1 && m > 0 ? Math.sqrt(Math.max(0, sxx[k] / n[k] - m * m)) / m : -1);
    }
    return out;
  };
  return [one(0), one(1).reverse()];
}

/**
 * Midnight: the day's figures (kept as yesterday's), then the accumulators are zeroed. lastDep is
 * kept, so the first morning headway is measured against last night's train (the period check
 * then skips it).
 */
export function rollDay(g: RouteReg): { stats: RegularityStats; byStop: [number[], number[]] } {
  const out = { stats: summarize(g), byStop: cvByStop(g) };
  for (const d of [0, 1] as const) {
    g.n[d].fill(0);
    g.sx[d].fill(0);
    g.sxx[d].fill(0);
  }
  g.sumH = g.sumH2 = g.sumHS = 0;
  g.bunched = g.gaps = g.holds = g.holdSec = g.termLateSum = g.termLateN = g.shortTurns = 0;
  return out;
}

/** Route panel grade: even / uneven / bunched at OPS_CONTROL.cvGood and cvFair. */
export function grade(cv: number): 'even' | 'uneven' | 'bunched' {
  return cv < OPS_CONTROL.cvGood ? 'even' : cv < OPS_CONTROL.cvFair ? 'uneven' : 'bunched';
}

/**
 * Recovery advisor: the smallest recovery choice covering recoverySuggestFactor × the mean
 * terminal lateness as a share of the one-way run time (capped at the largest choice).
 */
export function suggestRecovery(termLate: number, runTime: number): number {
  const ch = OPS_CONTROL.recoveryChoices;
  if (!(runTime > 0) || !(termLate > 0)) return ch[0];
  const need = (OPS_CONTROL.recoverySuggestFactor * termLate) / runTime;
  for (const c of ch) if (c >= need - 1e-12) return c;
  return ch[ch.length - 1];
}
