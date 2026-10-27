/**
 * Text for the operations-control and money-market UI (route panel Operations and Service
 * regularity, the finance tabs, the year in review, toasts). Pure — no DOM — so the wording, the
 * currency and each city's fare split are unit-tested in both cities (tests/opsUi.test.ts).
 */
import { BONDS, CREDIT, ECONOMY, FARES, OPERATIONS, OPS_CONTROL, TRAINS, type StockId } from '../balance';
import { city } from '../cities';
import { dateOfDay, monthKey } from '../core/calendar';
import { goalTitle } from '../core/goals';
import { currency, currencyScale, fmtCount, fmtFare, fmtMoney, fmtPct } from '../core/units';
import { nextNotchScore, ratingIndex, type CreditResult, type Rating } from '../economy/credit';
import type { FarePolicy } from '../economy/fares';
import { annuityMonthly, type Bond, type MarketData } from '../economy/finance';
import type { YearReview } from '../economy/yearReview';
import { grade, suggestRecovery } from '../sim/regularity';
import type { DayReport, RegularityStats, RouteRegularityDetail } from '../sim/protocol';

export type Tone = 'green' | 'amber' | 'red' | undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "3.12%". */
export const fmtRate = (r: number): string => `${(r * 100).toFixed(2)}%`;

/** Money with a little more precision than fmtMoney in the millions: "$3.95M", "£12.4M", "$970M", "$1.20B". */
export function fmtMoneyFine(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const cur = currency();
  if (currencyScale() !== 1) return fmtMoney(v);
  if (a >= 1e6 && a < 1e7) return `${sign}${cur}${(a / 1e6).toFixed(2).replace(/(\.\d)0$/, '$1')}M`;
  if (a >= 1e7 && a < 1e8) return `${sign}${cur}${(a / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return fmtMoney(v);
}

/** "27 y 4 m", "29 y", "4 m". */
export function fmtTerm(months: number): string {
  const m = Math.max(0, Math.round(months));
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (!y) return `${r} m`;
  return r ? `${y} y ${r} m` : `${y} y`;
}

/** Payback: "2 y 1 m", "8 months", "never". */
export function fmtPayback(months: number): string {
  if (!isFinite(months) || months <= 0) return 'never';
  const m = Math.ceil(months);
  return m < 12 ? `${m} month${m > 1 ? 's' : ''}` : fmtTerm(m);
}

function hourRange(a: number, b: number): string {
  const ap = (x: number) => (x % 24 < 12 ? 'am' : 'pm');
  const h12 = (x: number) => ((x % 12) || 12);
  return ap(a) === ap(b === 24 ? 23 : b) ? `${h12(a)}–${h12(b)} ${ap(a)}` : `${h12(a)} ${ap(a)}–${h12(b)} ${ap(b)}`;
}

/** The peak fare's hours: "6–10 am, 4–8 pm". */
export function peakHoursLabel(): string {
  return OPERATIONS.periods
    .filter((p) => FARES.peakPeriods.includes(p.id))
    .map((p) => hourRange(p.start, p.end))
    .join(', ');
}

/** Low-income fare choices for the segmented control. */
export const LOW_INCOME_OPTIONS: { value: number; label: string }[] = FARES.lowIncomeChoices.map((v) => ({ value: v, label: v === 1 ? 'Full' : v === 0 ? 'Free' : v === 0.5 ? 'Half' : `×${v}` }));

/** Tooltip for the low-income fare (names who gets it in this city). */
export function lowIncomeTip(): string {
  return `A “fair fares” discount for the lowest earners: ${city().lowIncomeBand}. Billed at boarding; they decide at 3 am.`;
}

/** The fare slider range of the current city. */
export function fareRange(): { min: number; max: number; step: number } {
  return { min: ECONOMY.fareMin, max: ECONOMY.fareMax, step: ECONOMY.fareStep };
}

/** Yesterday's fares by band and period, from the DayReport (null for reports saved before v2). */
export interface FareYesterday {
  trips: number;
  revenue: number;
  peakShare: number;
  avgFare: number;
  /** Lowest band's share of fare trips. */
  lowShare: number;
  /** Lowest band's transit share, and everyone's. */
  lowTransit: number | null;
  allTransit: number;
  revenueByBand: number[];
}

export function fareYesterday(r: Pick<DayReport, 'fares' | 'bandShare' | 'transitShare'> | null | undefined): FareYesterday | null {
  const f = r?.fares;
  if (!f || !f.trips || f.trips.length < 6) return null;
  const trips = f.trips.reduce((s, x) => s + x, 0);
  if (!(trips > 0)) return null;
  const revenue = f.revenue.reduce((s, x) => s + x, 0);
  const peak = f.trips[1] + f.trips[3] + f.trips[5];
  const lb = FARES.lowIncomeBand;
  return {
    trips,
    revenue,
    peakShare: peak / trips,
    avgFare: revenue / trips,
    lowShare: (f.trips[lb * 2] + f.trips[lb * 2 + 1]) / trips,
    lowTransit: r?.bandShare?.[lb] ?? null,
    allTransit: r?.transitShare ?? 0,
    revenueByBand: [0, 1, 2].map((b) => f.revenue[b * 2] + f.revenue[b * 2 + 1]),
  };
}

/** "Yesterday: 96% of fare trips at peak · average fare $2.98". */
export function fareYesterdayLine(y: FareYesterday): string {
  return `Yesterday: ${Math.round(y.peakShare * 100)}% of fare trips at peak · average fare ${fmtFare(y.avgFare)}`;
}

/** "Lowest earners: 6.8% of riders · 13% ride transit (all commuters 21%)". */
export function lowEarnersLine(y: FareYesterday): string {
  const ride = y.lowTransit === null ? '' : ` · ${Math.round(y.lowTransit * 100)}% ride transit (all commuters ${Math.round(y.allTransit * 100)}%)`;
  return `Lowest earners: ${fmtPct(y.lowShare)} of riders${ride}`;
}

/** The fare toast: "$3.50 peak / $2.50 off-peak · low-income half — commuters reconsider at 3 am". */
export function fareToastBody(summary: string): string {
  return `${summary} — commuters reconsider at 3 am`;
}

// ---------------------------------------------------------------------------------- regularity

export interface StatText {
  label: string;
  value: string;
  tone: Tone;
  tip: string;
  /** One plain line under the number. */
  hint?: string;
}

/** The four Service regularity cards (§2.2): regularity grade, bunched, extra wait, holds. */
export function regularityCards(s: RegularityStats | null): StatText[] {
  const none = !s || s.samples === 0;
  const g = s ? grade(s.cv) : 'even';
  const gw = g === 'even' ? 'Even' : g === 'uneven' ? 'Uneven' : 'Bunching';
  const ewt = s ? Math.max(0, Math.round(s.ewt)) : 0;
  return [
    {
      label: 'Train spacing',
      value: none ? '—' : gw,
      tone: none ? undefined : g === 'even' ? 'green' : g === 'uneven' ? 'amber' : 'red',
      hint: none ? 'No trains measured yet' : g === 'even' ? 'Trains arrive at steady gaps' : g === 'uneven' ? 'Gaps vary: some long waits' : 'Trains arrive in clumps',
      tip: `How evenly trains are spaced (spread of the gaps ${s ? s.cv.toFixed(2) : '—'}; under ${OPS_CONTROL.cvGood} is even, under ${OPS_CONTROL.cvFair} uneven, above that trains bunch).`,
    },
    {
      label: 'Trains bunched',
      value: none ? '—' : `${Math.round(s!.bunched * 100)}%`,
      tone: none ? undefined : s!.bunched > 0.25 ? 'red' : s!.bunched > 0.1 ? 'amber' : undefined,
      hint: 'of trains came right behind another',
      tip: `Share of gaps under ${Math.round(OPS_CONTROL.bunchFactor * 100)}% of the timetable gap: two trains arriving close together.`,
    },
    {
      label: 'Extra wait',
      value: none ? '—' : `+${ewt} s`,
      tone: none ? undefined : ewt > 120 ? 'red' : ewt > 60 ? 'amber' : undefined,
      hint: 'per rider, from uneven gaps',
      tip: 'How much longer a rider arriving at random waits than with perfectly even gaps.',
    },
    {
      label: 'Trains held',
      value: s && s.holds ? fmtCount(s.holds) : none ? '—' : '0',
      tone: undefined,
      hint: s && s.holds ? `about ${Math.round(s.holdSec / s.holds)} s each, to even the gaps` : 'held to even out the gaps',
      tip: 'Trains held by the dispatcher (at the first stop and at timepoints) and their average wait.',
    },
  ];
}

/** Routes list tag: "gaps even" / "uneven" / "bunching" (null with no measurements). */
export function regularityTag(s: RegularityStats | null | undefined): { text: string; tone: Tone } | null {
  if (!s || s.samples === 0) return null;
  const g = grade(s.cv);
  return g === 'even' ? { text: 'gaps even', tone: 'green' } : g === 'uneven' ? { text: 'uneven', tone: 'amber' } : { text: 'bunching', tone: 'red' };
}

/**
 * The route panel's regularity: the worker's, with yesterday's figures taken from the saved last
 * report when the worker has none (it doesn't keep yesterday across a load or Continue), so the
 * cards and the recovery advice still show yesterday. `fromReport` marks that case: the per-stop
 * chart is then today's so far. `runTime` (mean scheduled one-way run, s) re-derives the advice.
 */
export function regularityWithReport(
  d: RouteRegularityDetail | null | undefined,
  saved: RegularityStats | null | undefined,
  runTime: number | null,
): (RouteRegularityDetail & { fromReport?: boolean }) | null {
  if (!d || d.yesterday || !saved) return d ?? null;
  return { ...d, yesterday: saved, suggestRecovery: runTime ? suggestRecovery(saved.termLate, runTime) : d.suggestRecovery, fromReport: true };
}

/** "Suggested: 10% — trains reached terminals 1.4 min late on average yesterday" (only above the current setting). */
export function recoveryAdvice(d: Pick<RouteRegularityDetail, 'suggestRecovery' | 'today' | 'yesterday'> | null | undefined, current: number): string | null {
  if (!d || !(d.suggestRecovery > current + 1e-9)) return null;
  const s = d.yesterday ?? d.today;
  const when = d.yesterday ? 'yesterday' : 'today so far';
  return `Suggested: ${Math.round(d.suggestRecovery * 100)}% — trains reached terminals ${(s.termLate / 60).toFixed(1)} min late on average ${when}`;
}

export const HOLD_TIP = `Hold a train whose gap to the one ahead is under the threshold share of the headway. At the first stop it waits off the running track. At timepoints it waits up to ${OPS_CONTROL.maxHoldPerStop} s, and never while another route's train is queued behind it.`;
export const RECOVERY_TIP = 'Extra layover in the timetable at each end, as a share of the one-way run time. More trains are needed. Late trains use this slack to get back on schedule.';
export const TIMEPOINT_TIP = 'Timepoint: trains may be held here to even out gaps';
export const LATENESS_TIP = 'Mean lateness against the timetable. Holding can raise lateness slightly while making gaps even; regularity is what riders feel.';

// ---------------------------------------------------------------------------------- credit

/** Badge tone: AAA–A green, BBB plain, BB–B amber, CCC red. */
export function ratingTone(r: Rating | null): 'good' | 'mid' | 'weak' | 'bad' {
  if (!r) return 'mid';
  const i = ratingIndex(r);
  return i <= 2 ? 'good' : i === 3 ? 'mid' : i <= 5 ? 'weak' : 'bad';
}

/** Outlook from a live preview: the rating a review would give now, else the score's drift since the last review. */
export function creditOutlook(preview: CreditResult & { next: Rating }, market: Pick<MarketData, 'rating' | 'score'>): { arrow: string; word: 'positive' | 'stable' | 'negative' } {
  const cur = market.rating ?? preview.next;
  const d = ratingIndex(preview.next) - ratingIndex(cur);
  const drift = preview.score - market.score;
  if (d < 0 || (d === 0 && drift > 1.5)) return { arrow: '↗', word: 'positive' };
  if (d > 0 || (d === 0 && drift < -1.5)) return { arrow: '↘', word: 'negative' };
  return { arrow: '→', word: 'stable' };
}

/** The score line in three parts, so the panel can set the rating as a coloured badge: "Score 56 → ", "BBB", " (A needs 67) · outlook stable". */
export function scoreParts(preview: CreditResult & { next: Rating }, market: Pick<MarketData, 'rating' | 'score'>): { head: string; rating: Rating; tail: string } {
  const need = nextNotchScore(preview.next);
  const up = ratingIndex(preview.next) > 0 ? CREDIT.ratings[ratingIndex(preview.next) - 1] : null;
  return {
    head: `Score ${Math.round(preview.score)} → `,
    rating: preview.next,
    tail: `${need !== null && up ? ` (${up} needs ${need})` : ''} · outlook ${creditOutlook(preview, market).word}`,
  };
}

/** "Score 56 → BBB (A needs 67) · outlook stable". */
export function scoreLine(preview: CreditResult & { next: Rating }, market: Pick<MarketData, 'rating' | 'score'>): string {
  const p = scoreParts(preview, market);
  return `${p.head}${p.rating}${p.tail}`;
}

/** Last weekday of the month containing `day` (the month-end review). */
export function nextReviewDay(day: number): number {
  const k = monthKey(day);
  let d = day;
  while (monthKey(d + 1) === k) d++;
  return d;
}

/** "31 Oct". */
export function dayMonth(day: number): string {
  const d = dateOfDay(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Thu 12 Dec". */
export function weekdayDayMonth(day: number): string {
  return `${DOW[dateOfDay(day).getUTCDay()]} ${dayMonth(day)}`;
}

/** "Market 2.52% · BBB spread +0.60% → new bonds 3.12% for 30 years · next review 31 Oct". */
export function borrowingHeader(market: MarketData, newRate: number, day: number): string {
  const review = `next review ${dayMonth(nextReviewDay(day))}`;
  if (market.fixed) return `Fixed rate ${fmtRate(newRate)} for ${ECONOMY.bondYears} years (bond market off) · ${review}`;
  const r = market.rating ?? 'AAA';
  const spread = newRate - market.base;
  return `Market ${fmtRate(market.base)} · ${r} spread +${(Math.max(0, spread) * 100).toFixed(2)}% → new bonds ${fmtRate(newRate)} for ${ECONOMY.bondYears} years · ${review}`;
}

/** "Bond 3 · $970M · 2.50% · $3.95M/mo · 27 y 4 m left · AAA". */
export function bondLine(b: Bond): string {
  return `Bond ${b.id} · ${fmtMoney(b.balance)} · ${fmtRate(b.rate)} · ${fmtMoneyFine(b.monthlyPayment)}/mo · ${fmtTerm(b.monthsLeft)} left${b.rating ? ` · ${b.rating}` : ''}`;
}

export interface PrepayOption {
  amount: number;
  label: string;
  fee: number;
  /** Level payment after prepaying (0 when the bond is repaid). */
  newPayment: number;
  ok: boolean;
  reason?: string;
}

/** Prepay choices for a bond: BONDS.prepayChoices below its balance, then All. */
export function prepayOptions(b: Pick<Bond, 'balance' | 'rate' | 'monthsLeft'>, cash: number): PrepayOption[] {
  const amounts = BONDS.prepayChoices.filter((a) => a < b.balance - 1);
  const opts = [...amounts.map((a) => ({ amount: a, label: fmtMoney(a) })), { amount: b.balance, label: `All (${fmtMoney(b.balance)})` }];
  return opts.map((o) => {
    const fee = o.amount * BONDS.prepayPenalty;
    const left = b.balance - o.amount;
    const ok = cash >= o.amount + fee;
    return { ...o, fee, newPayment: left <= 1 ? 0 : annuityMonthly(left, b.rate, Math.max(1, b.monthsLeft)), ok, ...(ok ? {} : { reason: 'Not enough cash' }) };
  });
}

/** "Fee $9.7M now · saves $0.4M a month · pays for itself in 2 y 1 m". */
export function refinanceText(q: { fee: number; saving: number; paybackMonths: number }): string {
  return `Fee ${fmtMoneyFine(q.fee)} now · saves ${fmtMoneyFine(q.saving)} a month · pays for itself in ${fmtPayback(q.paybackMonths)}`;
}

// ---------------------------------------------------------------------------------- fleet

/** "They cost $60M new. Maintenance falls by $0.6M a year." */
export function saleText(cls: StockId, cars: number): string {
  const cost = cars * TRAINS[cls].costPerCar;
  return `They cost ${fmtMoneyFine(cost)} new. Maintenance falls by ${fmtMoneyFine(cost * ECONOMY.maintenanceRatePerYear)} a year.`;
}

// ---------------------------------------------------------------------------------- year in review

export interface YearReviewText {
  title: string;
  sub: string;
  cards: { label: string; value: string; tone: Tone }[];
  ridership: string;
  money: string[];
  credit: string;
  market: string;
  service: string;
  goals: string[];
}

const shortMonth = (label: string) => label.slice(0, 3);
const signed = (v: number) => fmtMoney(v, { sign: true });

export function yearReviewText(r: YearReview, opts: { sandbox: boolean; partial: boolean }): YearReviewText {
  const span = r.firstDay !== null && r.lastDay !== null ? `${dayMonth(r.firstDay)} – ${dayMonth(r.lastDay)} · ` : '';
  const cash = r.money.cashEnd - r.money.cashStart;
  const rating = r.credit.start && r.credit.end && r.credit.start !== r.credit.end ? `${r.credit.start} → ${r.credit.end}` : (r.credit.end ?? r.credit.start ?? '—');
  const cards: YearReviewText['cards'] = [
    { label: 'riders/day', value: fmtCount(r.riders.avgDaily), tone: undefined },
    { label: 'transit share', value: `${Math.round(r.share * 100)}%`, tone: undefined },
  ];
  if (!opts.sandbox) {
    cards.push({ label: 'cash', value: signed(cash), tone: cash > 0 ? 'green' : cash < 0 ? 'red' : undefined });
    cards.push({ label: 'credit rating', value: rating, tone: undefined });
  }
  const parts: string[] = [];
  if (r.riders.peak) parts.push(`Peak day ${fmtCount(r.riders.peak.riders)} (${weekdayDayMonth(r.riders.peak.day)})`);
  if (r.riders.growthPct !== null && r.riders.byMonth.length > 1) {
    const g = r.riders.growthPct;
    parts.push(`${g >= 0 ? 'up' : 'down'} ${Math.round(Math.abs(g)).toLocaleString()}% on ${shortMonth(r.riders.byMonth[0].label)}`);
  }
  const m = r.money;
  const money = [
    // Living City's value capture is its own line (shown once the city has paid any).
    `Fares ${fmtMoney(m.fares)}${m.valueCapture > 0 ? ` · Value capture ${fmtMoney(m.valueCapture)}` : ''} · Operating ${fmtMoney(-m.operating)} · Interest ${fmtMoney(-m.interest)} · Fees ${fmtMoney(-m.fees)}`,
    `Capital ${fmtMoney(-m.capital)} · Profit ${signed(m.profit)} · Debt ${m.debtStart === null ? '—' : fmtMoney(m.debtStart)} → ${m.debtEnd === null ? '—' : fmtMoney(m.debtEnd)} · Cash ${fmtMoney(m.cashStart)} → ${fmtMoney(m.cashEnd)}`,
  ];
  let credit: string;
  if (!r.credit.start && !r.credit.end) credit = 'Not rated yet';
  else if (!r.credit.changes.length) credit = `${r.credit.end ?? r.credit.start} all ${opts.partial ? 'year so far' : 'year'}`;
  else {
    // Each change is labelled with the month whose review made it. The opening rating gets the
    // year's first month, unless that month's own review already changed it ("AAA → Jan AA").
    const first = r.riders.byMonth[0]?.label ?? '';
    const lead = first && r.credit.changes[0]?.label !== first ? `${shortMonth(first)} ${r.credit.start}` : `${r.credit.start}`;
    const steps = [lead, ...r.credit.changes.map((c) => `${shortMonth(c.label)} ${c.to}`)];
    const n = r.credit.changes.length;
    credit = `${steps.join(' → ')} (${n} change${n > 1 ? 's' : ''}) · ended ${r.credit.end}`;
  }
  const mk = r.market;
  const shocks = mk.shocks.length ? ` · ${mk.shocks.length} shock${mk.shocks.length > 1 ? 's' : ''} (${mk.shocks.map((s) => `${shortMonth(s.label)}, ${s.size > 0 ? '+' : '−'}${(Math.abs(s.size) * 100).toFixed(2)}%`).join('; ')})` : ' · no shocks';
  const market = mk.low && mk.high ? `low ${fmtRate(mk.low.rate)} (${shortMonth(mk.low.label)}) · high ${fmtRate(mk.high.rate)} (${shortMonth(mk.high.label)})${shocks}` : 'No month-end reviews yet';
  const sv = r.service;
  const service = `Avg lateness ${Math.round(sv.lateness)} s · bunched ${fmtPct(sv.bunched)} · extra wait +${Math.max(0, Math.round(sv.ewt))} s`;
  return {
    title: `${r.year} in review${opts.partial ? ' (so far)' : ''}`,
    sub: `${span}${r.weekdays} weekdays`,
    cards,
    ridership: parts.join(' · '),
    money,
    credit,
    market,
    service,
    goals: r.goals.map((g) => `✓ ${goalTitle(g)}`),
  };
}

/** A month report's credit row: "BBB (was A) · new bonds 3.12%". */
export function monthRatingText(rating: Rating, prev: Rating | null | undefined, newRate: number | undefined): string {
  const was = prev && prev !== rating ? ` (was ${prev})` : '';
  return `${rating}${was}${newRate !== undefined ? ` · new bonds ${fmtRate(newRate)}` : ''}`;
}

/** H key / holding toggle toast. */
export function holdingToast(on: boolean, bullet: string, name: string): string {
  return `Holding ${on ? 'on' : 'off'} for ${bullet} ${name}`;
}

/** Fare policy summary helper for the share bar labels. */
export const BAND_LABELS = ['Lowest earners', 'Middle', 'Highest'];

/** True when the off-peak fare is locked to the peak fare. */
export function sameAllDay(p: FarePolicy): boolean {
  return p.peak === p.offPeak;
}
