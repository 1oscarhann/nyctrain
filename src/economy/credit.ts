/**
 * The bond market and the credit rating (v2). Pure: the finance model calls these at each month
 * end, and the UI previews them.
 *
 * - The base rate for *new* bonds is a seeded, mean-reverting random walk with occasional shocks,
 *   stepped once per month end. Each month's draw comes from a counter-based seed
 *   (mixSeed(seed, monthIndex)), so the path depends only on the game's seed and the previous rate,
 *   never on when the game was saved, loaded or replayed.
 * - The rating (AAA … CCC) comes from a scorecard of four ratios: farebox recovery, interest
 *   coverage, leverage and liquidity (months of cash). It adds a spread to the base rate.
 */
import { BONDS, CREDIT, ECONOMY } from '../balance';
import { hashSeed, Rng } from '../core/rng';

export type Rating = (typeof CREDIT.ratings)[number];

export interface CreditInputs {
  /** Mean fare revenue per service day (days with riders) in the review window. */
  revenuePerDay: number;
  /**
   * Living City: mean value capture per service day in the window (missing: 0). It counts in
   * interest coverage, as pledged, recurring revenue (the Hudson Yards bonds that paid for the 7
   * line extension were backed by the district's PILOTs and tax increment), but not in farebox
   * recovery, which is fares over operating costs by definition.
   */
  valueCapturePerDay?: number;
  /** Mean operating + staffing + maintenance per service day. */
  opCostPerDay: number;
  serviceDays: number;
  debt: number;
  /** Σ balance × coupon. */
  annualInterest: number;
  /** Σ level payments. */
  monthlyDebtService: number;
  assets: number;
  cash: number;
  /** Today's rate for a new bond (base + spread). */
  newRate: number;
}

export interface CreditMetric {
  id: 'farebox' | 'coverage' | 'leverage' | 'liquidity';
  label: string;
  /** The ratio (months for liquidity); null when not rated yet; Infinity for liquidity with nothing owed. */
  value: number | null;
  points: number;
  weight: number;
  /** "1.59×", "4.3 mo", "—". */
  display: string;
  /** "1.5× earns 80 points", "Not rated until 10 service days". */
  hint: string;
}

export interface CreditResult {
  score: number;
  /** The rating this score earns with no hysteresis (ratingFromScore(score, null)). */
  rating: Rating;
  metrics: CreditMetric[];
}

/** Piecewise-linear interpolation through (xs, ys), clamped at both ends. */
export function interp(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (!(x > xs[0])) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
  }
  return ys[n - 1];
}

const fmtX = (v: number) => `${v.toFixed(2)}×`;

/** The nearest anchor that would earn more points, for the hint ("1.50× earns 80 points"). */
function anchorHint(v: number, a: { x: number[]; y: number[] }, unit: (x: number) => string): string {
  const pts = interp(v, a.x, a.y);
  const up = a.y[a.y.length - 1] > a.y[0];
  const order = a.x.map((_, i) => i);
  if (!up) order.reverse();
  for (const i of order) if (a.y[i] > pts + 1e-9 && (up ? a.x[i] > v : a.x[i] < v)) return `${unit(a.x[i])} earns ${a.y[i]} points`;
  return 'Full marks';
}

/** The credit scorecard (§4.8 of docs/v2/ops-money.md). The rating here has no hysteresis. */
export function creditScore(inp: CreditInputs): CreditResult {
  const rated = inp.serviceDays >= CREDIT.minServiceDays;
  const W = CREDIT.weights;
  const metrics: CreditMetric[] = [];
  // Farebox recovery.
  const R = rated ? (inp.opCostPerDay > 0 ? inp.revenuePerDay / inp.opCostPerDay : inp.revenuePerDay > 0 ? Infinity : 0) : null;
  metrics.push({
    id: 'farebox',
    label: 'Farebox recovery',
    value: R,
    points: R === null ? CREDIT.notRatedPoints : interp(R, CREDIT.farebox.x, CREDIT.farebox.y),
    weight: W.farebox,
    display: R === null ? '—' : isFinite(R) ? fmtX(R) : '∞',
    hint: R === null ? `Not rated until ${CREDIT.minServiceDays} service days` : anchorHint(R, CREDIT.farebox, fmtX),
  });
  // Interest coverage: one new chunk counts pro forma, so a debt-free authority that loses money still rates poorly.
  const denom = inp.annualInterest + ECONOMY.bondChunk * inp.newRate;
  const C = rated ? (denom > 0 ? ((inp.revenuePerDay + (inp.valueCapturePerDay ?? 0) - inp.opCostPerDay) * ECONOMY.daysPerYear) / denom : 0) : null;
  metrics.push({
    id: 'coverage',
    label: 'Interest coverage',
    value: C,
    points: C === null ? CREDIT.notRatedPoints : interp(C, CREDIT.coverage.x, CREDIT.coverage.y),
    weight: W.coverage,
    display: C === null ? '—' : fmtX(C),
    hint: C === null ? `Not rated until ${CREDIT.minServiceDays} service days` : anchorHint(C, CREDIT.coverage, fmtX),
  });
  // Leverage.
  const base = inp.assets + Math.max(0, inp.cash);
  const L = inp.debt <= 0 ? 0 : base > 0 ? inp.debt / base : 1;
  metrics.push({
    id: 'leverage',
    label: 'Leverage',
    value: L,
    points: interp(L, CREDIT.leverage.x, CREDIT.leverage.y),
    weight: W.leverage,
    display: `${Math.round(L * 100)}%`,
    hint: anchorHint(L, CREDIT.leverage, (x) => `${Math.round(x * 100)}%`),
  });
  // Liquidity, in months of operating costs plus debt service.
  const monthly = inp.opCostPerDay * CREDIT.daysPerMonth + inp.monthlyDebtService;
  const Q = inp.cash <= 0 ? 0 : monthly > 0 ? inp.cash / monthly : Infinity;
  metrics.push({
    id: 'liquidity',
    label: 'Liquidity',
    value: Q,
    points: interp(Q, CREDIT.liquidity.x, CREDIT.liquidity.y),
    weight: W.liquidity,
    display: isFinite(Q) ? `${Q.toFixed(1)} mo` : '∞',
    hint: anchorHint(Q, CREDIT.liquidity, (x) => `${x} months`),
  });
  const score = metrics.reduce((s, m) => s + m.points * m.weight, 0);
  return { score, rating: ratingFromScore(score, null), metrics };
}

export function ratingIndex(r: Rating): number {
  return CREDIT.ratings.indexOf(r);
}

/**
 * The rating a score earns. With a previous rating it moves up only when the score clears the
 * better notch's threshold by CREDIT.hysteresis, and down only when it falls more than that below
 * the current notch's threshold, so ratings don't flap from month to month.
 */
export function ratingFromScore(score: number, prev: Rating | null): Rating {
  const T = CREDIT.thresholds;
  const N = CREDIT.ratings.length;
  let raw = T.findIndex((t) => score >= t);
  if (raw < 0) raw = N - 1;
  if (prev === null) return CREDIT.ratings[raw];
  const p = ratingIndex(prev);
  const h = CREDIT.hysteresis;
  let k = p;
  if (raw < p) while (k > 0 && score >= T[k - 1] + h) k--;
  else if (raw > p) while (k < N - 1 && score < T[k] - h) k++;
  return CREDIT.ratings[k];
}

export function spreadOf(r: Rating): number {
  return CREDIT.spreads[ratingIndex(r)];
}

/** Score the next notch up needs ("A needs 67"), with hysteresis; null at AAA. */
export function nextNotchScore(r: Rating): number | null {
  const i = ratingIndex(r);
  return i <= 0 ? null : CREDIT.thresholds[i - 1] + CREDIT.hysteresis;
}

/** Counter-based seed for month k of a market (never 0). */
export const mixSeed = (seed: number, k: number): number => (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0 || 1;

/** The game's market seed, derived from its game (chaos) seed: saves and reloads walk the same path. */
export function marketSeedFrom(gameSeed: number): number {
  return hashSeed(gameSeed >>> 0, 0x6d6b74 /* "mkt" */);
}

/**
 * One month of the base rate: mean reversion, a normal step and, rarely, a shock. Rounded to
 * 0.01%. Pure in (prev, seed, monthIdx).
 */
export function stepBaseRate(prev: number, seed: number, monthIdx: number): { rate: number; shock: number } {
  const rng = new Rng(mixSeed(seed, monthIdx));
  let next = prev + BONDS.reversion * (BONDS.mean - prev) + BONDS.volatility * rng.normal();
  let shock = 0;
  if (rng.next() < BONDS.shockChance) {
    shock = (rng.next() < BONDS.shockUpShare ? 1 : -1) * BONDS.shockSize;
    next += shock;
  }
  return { rate: Math.round(Math.min(BONDS.maxRate, Math.max(BONDS.minRate, next)) * 1e4) / 1e4, shock };
}

/** Balance-weighted mean coupon of a set of bonds (0 with no debt). */
export function weightedCoupon(bonds: readonly { balance: number; rate: number }[]): number {
  let b = 0, w = 0;
  for (const x of bonds) {
    b += x.balance;
    w += x.balance * x.rate;
  }
  return b > 0 ? w / b : 0;
}
