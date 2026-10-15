/**
 * Year in review (v2): plain numbers and strings for the modal at each year end, built from the
 * finance history. Pure, so it is tested without a DOM.
 */
import { ECONOMY } from '../balance';
import { dateOfDay, monthKey, yearOf } from '../core/calendar';
import type { GoalState } from '../core/goals';
import type { Rating } from './credit';
import type { FinanceData, MonthReport } from './finance';

export interface YearReview {
  year: number;
  /** First and last settled game day of the year's closed months in the history (null if none is kept). */
  firstDay: number | null;
  lastDay: number | null;
  /** Weekdays (game days) settled in the year's months. */
  weekdays: number;
  riders: {
    avgDaily: number;
    peak: { day: number; riders: number } | null;
    byMonth: { label: string; avg: number }[];
    /** Last month's average against the first month's, % (null when the first month had no riders). */
    growthPct: number | null;
  };
  /** Mean transit share of the days with service figures (0 if none). */
  share: number;
  money: {
    fares: number;
    operating: number;
    interest: number;
    fees: number;
    capital: number;
    profit: number;
    cashStart: number;
    cashEnd: number;
    /** Null when unknown (months closed before v4 whose debt could not be rebuilt). */
    debtStart: number | null;
    debtEnd: number | null;
  };
  credit: { start: Rating | null; end: Rating | null; changes: { label: string; from: Rating; to: Rating }[] };
  market: {
    low: { label: string; rate: number } | null;
    high: { label: string; rate: number } | null;
    shocks: { label: string; size: number }[];
  };
  /** Day-weighted means of the months' service figures. */
  service: { lateness: number; bunched: number; ewt: number };
  /** Goal ids completed during the year. */
  goals: string[];
}

/** Years that have at least one closed month, ascending. */
export function yearsWithData(f: Pick<FinanceData, 'months'>): number[] {
  return [...new Set(f.months.map((m) => Number(m.key.slice(0, 4))))].sort((a, b) => a - b);
}

export function buildYearReview(f: Pick<FinanceData, 'months' | 'history' | 'market'>, goals: GoalState, year: number): YearReview {
  const prefix = `${year}-`;
  const months = f.months.filter((m) => m.key.startsWith(prefix));
  const before = f.months.filter((m) => m.key < prefix);
  const prev: MonthReport | undefined = before[before.length - 1];
  const sum = (g: (m: MonthReport) => number) => months.reduce((s, m) => s + g(m), 0);
  const weekdays = sum((m) => m.days);
  // The year's settled days in its closed months only, like every total here (a review "so far"
  // opened in February covers January; the open month's days aren't in the totals or the span).
  const closed = new Set(months.map((m) => m.key));
  const days = f.history.filter((h) => yearOf(h.day) === year && closed.has(monthKey(h.day)));
  // Peak day from the daily history (≤ 400 days, which covers a 261-day year).
  let peak: { day: number; riders: number } | null = null;
  for (const h of days) if (h.riders > 0 && (!peak || h.riders > peak.riders)) peak = { day: h.day, riders: h.riders };
  const byMonth = months.map((m) => ({ label: m.label, avg: m.days ? m.riders / m.days : 0 }));
  const first = byMonth[0]?.avg ?? 0;
  const lastAvg = byMonth[byMonth.length - 1]?.avg ?? 0;
  const kpiMonths = months.filter((m) => m.kpi);
  const kpiDays = kpiMonths.reduce((s, m) => s + m.days, 0);
  const kpiMean = (g: (k: NonNullable<MonthReport['kpi']>) => number) => (kpiDays ? kpiMonths.reduce((s, m) => s + g(m.kpi!) * m.days, 0) / kpiDays : 0);
  // Credit: the rating set at each month-end review, in order, starting from the one in force on
  // 1 January (last year's final review, or the rating during the year's first month).
  const mh = f.market.history.filter((h) => h.key.startsWith(prefix));
  const changes: { label: string; from: Rating; to: Rating }[] = [];
  let cur: Rating | null = prev?.rating ?? mh[0]?.rating ?? null;
  const startRating = cur;
  for (const m of months) {
    if (!m.rating) continue;
    if (cur && m.rating !== cur) changes.push({ label: m.label, from: cur, to: m.rating });
    cur = m.rating;
  }
  const endRating = cur;
  let low: { label: string; rate: number } | null = null;
  let high: { label: string; rate: number } | null = null;
  for (const m of mh) {
    if (!low || m.base < low.rate) low = { label: m.label, rate: m.base };
    if (!high || m.base > high.rate) high = { label: m.label, rate: m.base };
  }
  // No month before: the game's start (no debt). A month closed before v4 without a figure: unknown.
  const debtOf = (m: MonthReport | undefined) => (!m ? 0 : typeof m.debtEnd === 'number' ? m.debtEnd : null);
  return {
    year,
    firstDay: days.length ? days[0].day : null,
    lastDay: days.length ? days[days.length - 1].day : null,
    weekdays,
    riders: { avgDaily: weekdays ? sum((m) => m.riders) / weekdays : 0, peak, byMonth, growthPct: first > 0 ? ((lastAvg - first) / first) * 100 : null },
    share: kpiMean((k) => k.transitShare),
    money: {
      fares: sum((m) => m.revenue),
      operating: sum((m) => m.operatingCosts),
      interest: sum((m) => m.interest ?? 0),
      fees: sum((m) => m.fees ?? 0),
      capital: sum((m) => m.capital),
      profit: sum((m) => m.profit),
      cashStart: prev ? prev.cashEnd : ECONOMY.startingCash,
      cashEnd: months.length ? months[months.length - 1].cashEnd : prev ? prev.cashEnd : ECONOMY.startingCash,
      debtStart: debtOf(prev),
      debtEnd: months.length ? debtOf(months[months.length - 1]) : debtOf(prev),
    },
    credit: { start: startRating, end: endRating, changes },
    market: { low, high, shocks: mh.filter((m) => m.shock !== 0).map((m) => ({ label: m.label, size: m.shock })) },
    service: { lateness: kpiMean((k) => k.lateness), bunched: kpiMean((k) => k.bunched), ewt: kpiMean((k) => k.ewt) },
    goals: Object.entries(goals)
      .filter(([, d]) => d !== null && d !== undefined && dateOfDay(d).getUTCFullYear() === year)
      .map(([id]) => id),
  };
}
