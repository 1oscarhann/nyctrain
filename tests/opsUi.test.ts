/**
 * Operations control and the money market on the main thread (no DOM): the wording, currency and
 * numbers of the route panel's Operations and Service regularity sections, the finance tabs, the
 * prepay and refinance dialogs, car sales and the year in review, in both cities.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/balance';
import { applyCity } from '../src/cities';
import { creditScore } from '../src/economy/credit';
import { defaultFares, fareSummary, normalizeFares } from '../src/economy/fares';
import { annuityMonthly, Finance, type FinanceData } from '../src/economy/finance';
import { buildYearReview } from '../src/economy/yearReview';
import { emptyStats } from '../src/sim/regularity';
import { defaultControl } from '../src/routes/control';
import type { Route } from '../src/routes/types';
import type { FareBreakdown } from '../src/sim/protocol';
import {
  bondLine,
  borrowingHeader,
  creditOutlook,
  fareRange,
  fareToastBody,
  fareYesterday,
  fareYesterdayLine,
  fmtMoneyFine,
  fmtPayback,
  fmtRate,
  fmtTerm,
  holdingToast,
  lowEarnersLine,
  lowIncomeTip,
  monthRatingText,
  nextReviewDay,
  peakHoursLabel,
  prepayOptions,
  ratingTone,
  recoveryAdvice,
  refinanceText,
  regularityCards,
  regularityTag,
  regularityWithReport,
  draftOf,
  mergeDraft,
  saleText,
  scoreLine,
  scoreParts,
  yearReviewText,
} from '../src/ui/opsMoney';

afterAll(() => applyCity('nyc'));

const stats = (over: Partial<ReturnType<typeof emptyStats>>) => ({ ...emptyStats(), samples: 100, ...over });

/** Yesterday's fares: 1,000 trips, 96% at peak, band 0 at half fare. */
function report(peak: number, off: number, low: number): { fares: FareBreakdown; bandShare: number[]; transitShare: number } {
  const trips = [4, 96, 20, 380, 20, 480];
  const fare = (b: number, p: number) => (b === 0 ? low : 1) * (p ? peak : off);
  return { fares: { trips, revenue: trips.map((t, i) => t * fare(Math.floor(i / 2), i % 2)) }, bandShare: [0.13, 0.2, 0.25], transitShare: 0.21 };
}

describe('formatting', () => {
  it('rates, terms, payback and money in the millions', () => {
    applyCity('nyc');
    expect(fmtRate(0.0312)).toBe('3.12%');
    expect(fmtTerm(328)).toBe('27 y 4 m');
    expect(fmtTerm(348)).toBe('29 y');
    expect(fmtTerm(4)).toBe('4 m');
    expect(fmtPayback(24.2)).toBe('2 y 1 m');
    expect(fmtPayback(7.5)).toBe('8 months');
    expect(fmtPayback(Infinity)).toBe('never');
    expect(fmtMoneyFine(3.95e6)).toBe('$3.95M');
    expect(fmtMoneyFine(9.7e6)).toBe('$9.7M');
    expect(fmtMoneyFine(-12.44e6)).toBe('−$12.4M');
    expect(fmtMoneyFine(970e6)).toBe('$970M');
    expect(peakHoursLabel()).toBe('6–10 am, 4–8 pm');
  });
});

describe('fares tab', () => {
  it('New York: one $3 fare by default, quarter steps, and yesterday by band and period', () => {
    applyCity('nyc');
    expect(fareRange()).toEqual({ min: 0, max: 5, step: 0.25 });
    expect(fareSummary(defaultFares())).toBe('$3.00');
    expect(fareToastBody(fareSummary(normalizeFares({ peak: 3.5, offPeak: 2.5, lowIncome: 0.5 })))).toBe('$3.50 peak / $2.50 off-peak · low-income half — commuters reconsider at 3 am');
    const y = fareYesterday(report(3.5, 2.5, 0.5))!;
    expect(y.trips).toBe(1000);
    expect(y.peakShare).toBeCloseTo(0.956, 6);
    expect(fareYesterdayLine(y)).toBe(`Yesterday: 96% of fare trips at peak · average fare $${y.avgFare.toFixed(2)}`);
    expect(lowEarnersLine(y)).toBe('Lowest earners: 10.0% of riders · 13% ride transit (all commuters 21%)');
    expect(y.revenueByBand[0]).toBeCloseTo((4 * 2.5 + 96 * 3.5) / 2, 9);
    expect(lowIncomeTip()).toContain('$1,250 a month');
    // Reports saved before the fare policy have no breakdown.
    expect(fareYesterday({ transitShare: 0.2 } as never)).toBeNull();
  });

  it('London: £2.80 peak / £2.70 off-peak, 10p steps and pounds throughout', () => {
    applyCity('london');
    expect(fareRange()).toEqual({ min: 0, max: 5, step: 0.1 });
    const p = defaultFares();
    expect(p).toEqual({ peak: 2.8, offPeak: 2.7, lowIncome: 1 });
    expect(fareSummary(p)).toBe('£2.80 peak / £2.70 off-peak');
    expect(fareSummary(normalizeFares({ peak: 3.04, offPeak: 2.46, lowIncome: 0 }))).toBe('£3.00 peak / £2.50 off-peak · low-income free');
    const y = fareYesterday(report(2.8, 2.7, 1))!;
    expect(fareYesterdayLine(y)).toMatch(/^Yesterday: 96% of fare trips at peak · average fare £2\.\d\d$/);
    expect(lowIncomeTip()).toContain('lowest of three earnings bands');
    expect(fmtMoneyFine(3.83e6)).toBe('£3.83M');
    expect(saleText('heavy', 24)).toBe('They cost £60M new. Maintenance falls by £600k a year.');
    applyCity('nyc');
    expect(saleText('heavy', 24)).toBe('They cost $60M new. Maintenance falls by $600k a year.');
  });
});

describe('route panel', () => {
  it('regularity cards grade, tone and clamp', () => {
    const even = regularityCards(stats({ cv: 0.21, bunched: 0.06, ewt: -2, holds: 142, holdSec: 142 * 37 }));
    expect(even.map((c) => c.value)).toEqual(['Even · CV 0.21', '6%', '+0 s', '142 · avg 37 s']);
    expect(even.map((c) => c.tone)).toEqual(['green', undefined, undefined, undefined]);
    const uneven = regularityCards(stats({ cv: 0.38, bunched: 0.12, ewt: 61 }));
    expect(uneven.map((c) => c.value)).toEqual(['Uneven · 0.38', '12%', '+61 s', '0']);
    expect(uneven.map((c) => c.tone)).toEqual(['amber', 'amber', 'amber', undefined]);
    const bunched = regularityCards(stats({ cv: 0.61, bunched: 0.3, ewt: 130 }));
    expect(bunched[0].value).toBe('Bunched · 0.61');
    expect(bunched.map((c) => c.tone)).toEqual(['red', 'red', 'red', undefined]);
    expect(regularityCards(null).map((c) => c.value)).toEqual(['—', '—', '—', '—']);
    expect(regularityTag(stats({ cv: 0.2 }))).toEqual({ text: 'gaps even', tone: 'green' });
    expect(regularityTag(stats({ cv: 0.5 }))).toEqual({ text: 'bunching', tone: 'red' });
    expect(regularityTag({ ...emptyStats() })).toBeNull();
    expect(regularityTag(undefined)).toBeNull();
  });

  it('recovery advice appears only above the current setting', () => {
    const d = { suggestRecovery: 0.1, today: stats({ termLate: 20 }), yesterday: stats({ termLate: 84 }) };
    expect(recoveryAdvice(d, 0)).toBe('Suggested: 10% — trains reached terminals 1.4 min late on average yesterday');
    expect(recoveryAdvice(d, 0.1)).toBeNull();
    expect(recoveryAdvice({ ...d, yesterday: null }, 0.05)).toBe('Suggested: 10% — trains reached terminals 0.3 min late on average today so far');
    expect(recoveryAdvice(null, 0)).toBeNull();
    expect(holdingToast(true, 'A', 'Lexington')).toBe('Holding on for A Lexington');
  });

  it('a rebuilt route panel keeps unapplied edits and shows changes applied meanwhile (H)', () => {
    const route = { id: 1, stops: [5, 6, 7, 8], cars: 8, headways: { night: 20, am: 4, midday: 8, pm: 4, evening: 10 }, control: { ...defaultControl(), hold: true, timepoints: [6] } } as unknown as Route;
    const base = draftOf(route);
    // The player sets a 3-minute peak and 10 cars, and a timepoint at stop 7, without applying...
    const mine = draftOf(route);
    mine.headways.am = 3;
    mine.cars = 10;
    mine.control.timepoints = [6, 7];
    // ...then presses H: holding goes off on the route itself, and the panel is rebuilt.
    const now = { ...route, control: { ...route.control, hold: false } } as Route;
    const d = mergeDraft(base, mine, now);
    expect(d.headways).toEqual({ ...route.headways, am: 3 });
    expect(d.cars).toBe(10);
    expect(d.control.hold).toBe(false);
    expect(d.control.timepoints).toEqual([6, 7]);
    expect(d.control.recoveryPct).toBe(route.control.recoveryPct);
    // Nothing edited: the rebuilt draft is the route as it is now (so Apply and Revert come out clean).
    expect(mergeDraft(base, draftOf(route), now)).toEqual(draftOf(now));
    // Timepoints at stops the route no longer has are dropped.
    expect(mergeDraft(base, mine, { ...now, stops: [5, 6, 8] } as Route).control.timepoints).toEqual([6]);
  });

  it('after a load, yesterday comes from the saved report (the worker forgets it)', () => {
    // The worker's detail after Continue: today so far only, no suggestion yet.
    const fresh = { today: emptyStats(), yesterday: null, cvByStop: [[-1, -1], [-1, -1]] as [number[], number[]], timepoints: [], suggestRecovery: 0, hold: 0.7, shortTurns: 0 };
    const saved = stats({ samples: 900, cv: 0.54, bunched: 0.2, ewt: 70, termLate: 296 });
    const d = regularityWithReport(fresh, saved, 1800)!;
    expect(d.fromReport).toBe(true);
    expect(d.yesterday).toBe(saved);
    expect(regularityCards(d.yesterday)[0].value).toBe('Bunched · 0.54');
    // 1.5 × 296 s on a 30-minute run is 24.7%: the largest choice.
    expect(d.suggestRecovery).toBe(0.2);
    expect(recoveryAdvice(d, 0.1)).toBe('Suggested: 20% — trains reached terminals 4.9 min late on average yesterday');
    // The worker's own yesterday wins; nothing saved (a new route) leaves today so far.
    const live = { ...fresh, yesterday: stats({ cv: 0.2 }) };
    expect(regularityWithReport(live, saved, 1800)).toBe(live);
    expect(regularityWithReport(fresh, undefined, 1800)).toBe(fresh);
    expect(regularityWithReport(null, saved, 1800)).toBeNull();
  });
});

describe('borrowing tab', () => {
  it('header, next review, bond line and badge tones', () => {
    applyCity('nyc');
    // Day 0 is Mon 7 Jan 2030; the review is on the last weekday of January (Thu 31 Jan).
    expect(nextReviewDay(0)).toBe(18);
    const market = { seed: 1, base: 0.0252, rating: 'BBB' as const, score: 56, history: [] };
    expect(borrowingHeader(market, 0.0312, 0)).toBe('Market 2.52% · BBB spread +0.60% → new bonds 3.12% for 30 years · next review 31 Jan');
    expect(borrowingHeader({ ...market, fixed: true }, ECONOMY.bondRate, 0)).toBe('Fixed rate 2.50% for 30 years (bond market off) · next review 31 Jan');
    const b = { id: 3, principal: 1e9, balance: 970e6, monthlyPayment: 3.95e6, issuedDay: 0, rate: 0.025, monthsLeft: 328, rating: 'AAA' as const };
    expect(bondLine(b)).toBe('Bond 3 · $970M · 2.50% · $3.95M/mo · 27 y 4 m left · AAA');
    applyCity('london');
    expect(bondLine(b)).toBe('Bond 3 · £970M · 2.50% · £3.95M/mo · 27 y 4 m left · AAA');
    applyCity('nyc');
    expect(['AAA', 'A', 'BBB', 'BB', 'B', 'CCC'].map((r) => ratingTone(r as never))).toEqual(['good', 'good', 'mid', 'weak', 'weak', 'bad']);
    expect(monthRatingText('BBB', 'A', 0.0312)).toBe('BBB (was A) · new bonds 3.12%');
    expect(monthRatingText('BBB', 'BBB', 0.0312)).toBe('BBB · new bonds 3.12%');
  });

  it('prepay options show the penalty and the new payment, and need the cash', () => {
    const b = { balance: 1e9, rate: 0.025, monthsLeft: 300 };
    const opts = prepayOptions(b, 600e6);
    expect(opts.map((o) => o.amount)).toEqual([250e6, 500e6, 1e9]);
    expect(opts.map((o) => o.fee)).toEqual([2.5e6, 5e6, 1e7]);
    expect(opts[0].newPayment).toBeCloseTo(annuityMonthly(750e6, 0.025, 300), 6);
    expect(opts[2].newPayment).toBe(0);
    expect(opts.map((o) => o.ok)).toEqual([true, true, false]);
    // A small balance offers All only.
    expect(prepayOptions({ balance: 200e6, rate: 0.03, monthsLeft: 10 }, 1e9).map((o) => o.label)).toEqual(['All ($200M)']);
  });

  it('refinance text matches a real quote', () => {
    const f = new Finance(false, 0, 7);
    f.cash = 1e9;
    f.bonds.push({ id: 1, principal: 1e9, balance: 1e9, monthlyPayment: annuityMonthly(1e9, 0.035, 300), issuedDay: 0, rate: 0.035, monthsLeft: 300 });
    const q = f.refinanceQuote(1)!;
    expect(q.ok).toBe(true);
    expect(refinanceText(q)).toMatch(/^Fee \$10M now · saves \$\d+k a month · pays for itself in \d y( \d+ m)?$/);
    expect(refinanceText({ fee: 9.7e6, saving: 0.4e6, paybackMonths: 24.25 })).toBe('Fee $9.7M now · saves $400k a month · pays for itself in 2 y 1 m');
  });

  it('scorecard line and outlook', () => {
    const f = new Finance(false, 0, 7);
    const p = f.previewCredit();
    expect(p.next).toBe('AAA');
    expect(scoreLine(p, f.market)).toBe(`Score ${Math.round(p.score)} → AAA · outlook stable`);
    const res = creditScore({ revenuePerDay: 3.5e6, opCostPerDay: 2.2e6, serviceDays: 40, debt: 17e9, annualInterest: 17e9 * 0.025, monthlyDebtService: 17 * 3.95e6, assets: 23e9, cash: 0.5e9, newRate: 0.031 });
    const pv = { ...res, next: res.rating };
    expect(res.rating).toBe('BBB');
    expect(scoreLine(pv, { rating: 'BBB', score: res.score })).toBe(`Score ${Math.round(res.score)} → BBB (A needs 67) · outlook stable`);
    // The panel sets the rating as a badge between the two halves of the same line.
    const parts = scoreParts(pv, { rating: 'BBB', score: res.score });
    expect(parts).toEqual({ head: `Score ${Math.round(res.score)} → `, rating: 'BBB', tail: ' (A needs 67) · outlook stable' });
    expect(creditOutlook(pv, { rating: 'A', score: 70 }).word).toBe('negative');
    expect(creditOutlook(pv, { rating: 'BB', score: 40 }).word).toBe('positive');
  });
});

describe('year in review', () => {
  function data(): Pick<FinanceData, 'months' | 'history' | 'market'> {
    const month = (k: number, rating: 'AAA' | 'A' | 'BBB') => ({
      key: `2030-${String(k + 1).padStart(2, '0')}`,
      label: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][k]} 2030`,
      days: 20,
      revenue: 60e6,
      operatingCosts: 40e6,
      capital: k === 0 ? 20e9 : 0,
      bondPayments: 0,
      profit: 5e6,
      riders: 20 * (1e6 + k * 1e4),
      cashEnd: 1e9,
      interest: 15e6,
      fees: 0,
      prepaid: 0,
      debtEnd: 17e9,
      kpi: { transitShare: 0.2, lateness: 90, bunched: 0.06, ewt: 40 },
      rating,
    });
    const months = [...Array(12)].map((_, k) => month(k, k < 1 ? 'AAA' : k < 3 ? 'A' : 'BBB'));
    const history = [{ day: 100, riders: 1.34e6 } as never];
    const market = { seed: 1, base: 0.025, rating: 'BBB' as const, score: 56, history: months.map((m, k) => ({ key: m.key, label: m.label, base: 0.025 + (k === 5 ? -0.004 : k === 9 ? 0.005 : 0), rating: m.rating, newRate: 0.03, avgCost: 0.025, score: 56, shock: k === 9 ? 0.0075 : 0 })) };
    return { months, history, market };
  }

  it('summarises a year in the doc’s layout, and hides money in sandbox', () => {
    applyCity('nyc');
    const rev = buildYearReview(data(), { 'first-line': 3 }, 2030);
    const t = yearReviewText(rev, { sandbox: false, partial: false });
    expect(t.title).toBe('2030 in review');
    expect(t.cards.map((c) => c.label)).toEqual(['riders/day', 'transit share', 'cash', 'credit rating']);
    expect(t.cards[3].value).toBe('AAA → BBB');
    expect(t.credit).toBe('Jan AAA → Feb A → Apr BBB (2 changes) · ended BBB');
    expect(t.market).toBe('low 2.10% (Jun) · high 3.00% (Oct) · 1 shock (Oct, +0.75%)');
    expect(t.service).toBe('Avg lateness 90 s · bunched 6.0% · extra wait +40 s');
    expect(t.money[0]).toBe('Fares $720M · Operating −$480M · Interest −$180M · Fees $0');
    expect(t.ridership).toContain('up 11% on Jan');
    expect(t.goals).toEqual(['✓ Open your first line']);
    // A change at the first month's own review doesn't repeat the month: "AAA → Jan A …".
    const d2 = data();
    d2.months[0].rating = 'A';
    expect(yearReviewText(buildYearReview(d2, {}, 2030), { sandbox: false, partial: false }).credit).toBe('AAA → Jan A → Apr BBB (2 changes) · ended BBB');
    const sb = yearReviewText(rev, { sandbox: true, partial: true });
    expect(sb.title).toBe('2030 in review (so far)');
    expect(sb.cards.map((c) => c.label)).toEqual(['riders/day', 'transit share']);
  });
});
