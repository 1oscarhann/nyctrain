/**
 * The money market (v2): the credit scorecard and rating hysteresis, the seeded base-rate walk,
 * per-bond coupons, refinancing and prepayment, the monthly review, the year in review, and the
 * v3 → v4 save migration.
 */
import { describe, expect, it } from 'vitest';
import { BONDS, CREDIT, ECONOMY, GOALS } from '../src/balance';
import { isNewMonth, monthKey, monthLabel, weekdaysInMonth } from '../src/core/calendar';
import { Game } from '../src/core/game';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { creditScore, marketSeedFrom, mixSeed, nextNotchScore, ratingFromScore, spreadOf, stepBaseRate, type CreditInputs, type Rating } from '../src/economy/credit';
import { annuityMonthly, annuityPayment, Finance, remainingPayments, type FinanceData, type MonthReport } from '../src/economy/finance';
import { buildYearReview, yearsWithData } from '../src/economy/yearReview';
import { legacyControl } from '../src/routes/control';
import { SAVE_VERSION } from '../src/save/format';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave } from '../src/save/serialize';
import { Rng } from '../src/core/rng';
import { checkGoals, emptyGoals, goalDefs } from '../src/core/goals';
import type { DayReport } from '../src/sim/protocol';
import { emptyStats } from '../src/sim/regularity';

const OP = 1e6;
const RATE = 0.025;

/** Scorecard inputs that produce the given ratios (null R/C: not rated yet). */
function inputs(R: number | null, C: number | null, L: number, Q: number, debt: number, cash: number): CreditInputs {
  const rated = R !== null;
  const op = rated ? OP : 0;
  const rev = rated ? R! * OP : 0;
  const annualInterest = rated && C ? ((rev - op) * ECONOMY.daysPerYear) / C - ECONOMY.bondChunk * RATE : 0;
  const assets = L > 0 ? debt / L - Math.max(0, cash) : 0;
  const monthly = isFinite(Q) && Q > 0 ? cash / Q : 0;
  return {
    revenuePerDay: rev,
    opCostPerDay: op,
    serviceDays: rated ? 60 : 0,
    debt,
    annualInterest,
    monthlyDebtService: Math.max(0, monthly - op * CREDIT.daysPerMonth),
    assets,
    cash,
    newRate: RATE,
  };
}

/** First game day whose next day starts a new month, from `from`. */
function monthEnd(from: number): number {
  let d = from;
  while (!isNewMonth(d + 1)) d++;
  return d;
}

const day = (d: number, revenue = 0, riders = 0) => ({ day: d, riders, revenue, carKm: 0, stationsOpen: 0 });

describe('credit scorecard', () => {
  it('rates the §4.8 table', () => {
    const rows: [string, CreditInputs, number, Rating][] = [
      ['new game', inputs(null, null, 0, Infinity, 0, 6e9), 88.0, 'AAA'],
      ['core under construction', inputs(null, null, 0.72, 5.7, 17e9, 0.5e9), 67.6, 'A'],
      ['core 1.31M riders', inputs(1.59, 0.75, 0.72, 4.3, 17e9, 0.5e9), 56.4, 'BBB'],
      ['same, cash ≈ 0', inputs(1.59, 0.75, 0.74, 0.4, 17e9, 0.05e9), 48.4, 'BB'],
      ['core 1.5M riders', inputs(1.81, 1.03, 0.72, 4.3, 17e9, 0.5e9), 63.0, 'BBB'],
      ['core 1.5M at $3.50', inputs(2.08, 1.37, 0.71, 8.6, 17e9, 0.5e9), 73.5, 'A'],
      ['core paid down to $12B', inputs(1.81, 1.44, 0.48, 15.7, 12e9, 0.5e9), 81.1, 'AA'],
      ['sprawl, no debt', inputs(0.05, -8.4, 0, 55, 0, 5e9), 40.0, 'BB'],
      ['sprawl with $3B debt', inputs(0.04, -1.9, 0.36, 9.3, 3e9, 3e9), 32.5, 'B'],
      ['$20B debt, losing money', inputs(0.8, -0.25, 0.91, 0, 20e9, -1e8), 12.4, 'CCC'],
    ];
    for (const [label, inp, score, rating] of rows) {
      const r = creditScore(inp);
      expect(Math.abs(r.score - score), label).toBeLessThanOrEqual(0.5);
      expect(r.rating, label).toBe(rating);
      expect(r.metrics.map((m) => m.id)).toEqual(['farebox', 'coverage', 'leverage', 'liquidity']);
    }
    const nr = creditScore(rows[0][1]);
    expect(nr.metrics[0].value).toBeNull();
    expect(nr.metrics[0].points).toBe(CREDIT.notRatedPoints);
    expect(nr.metrics[3].value).toBe(Infinity);
    expect(creditScore(rows[2][1]).metrics[0].hint).toBe('2.00× earns 100 points');
  });

  it('is monotonic in cash, debt and revenue', () => {
    const rng = new Rng(7);
    const make = (debt: number, cash: number, rev: number): CreditInputs => ({
      revenuePerDay: rev,
      opCostPerDay: 2e6,
      serviceDays: 60,
      debt,
      annualInterest: debt * 0.03,
      monthlyDebtService: annuityMonthly(debt, 0.03, 360),
      assets: 20e9,
      cash,
      newRate: 0.03,
    });
    for (let i = 0; i < 2000; i++) {
      const debt = rng.next() * 20e9, cash = rng.next() * 4e9 - 1e9, rev = rng.next() * 6e6;
      const s = creditScore(make(debt, cash, rev)).score;
      expect(creditScore(make(debt, cash + rng.next() * 1e9, rev)).score).toBeGreaterThanOrEqual(s - 1e-9);
      expect(creditScore(make(debt + rng.next() * 3e9, cash, rev)).score).toBeLessThanOrEqual(s + 1e-9);
      expect(creditScore(make(debt, cash, rev + rng.next() * 1e6)).score).toBeGreaterThanOrEqual(s - 1e-9);
    }
  });

  it('moves a notch only past the hysteresis margin', () => {
    expect(ratingFromScore(64, 'A')).toBe('A');
    expect(ratingFromScore(62, 'A')).toBe('BBB');
    expect(ratingFromScore(66, 'BBB')).toBe('BBB');
    expect(ratingFromScore(67, 'BBB')).toBe('A');
    expect(ratingFromScore(66, null)).toBe('A');
    expect(ratingFromScore(30, 'AAA')).toBe('B');
    expect(ratingFromScore(10, null)).toBe('CCC');
    expect(ratingFromScore(99, 'CCC')).toBe('AAA');
    expect(nextNotchScore('BBB')).toBe(67);
    expect(nextNotchScore('AAA')).toBeNull();
  });

  it('adds the rating spread to the base rate for new bonds', () => {
    expect(spreadOf('BBB')).toBe(0.006);
    expect(spreadOf('AAA')).toBe(0);
    const f = new Finance(false);
    expect(f.newBondRate()).toBe(ECONOMY.bondRate);
    f.market.base = 0.03;
    f.market.rating = 'BBB';
    expect(f.newBondRate()).toBeCloseTo(0.036, 12);
    f.market.fixed = true;
    expect(f.newBondRate()).toBe(ECONOMY.bondRate);
  });
});

describe('bond market walk', () => {
  it('mean-reverts around 2.5% within the bounds, deterministically per seed and month', () => {
    const path = (seed: number, n: number) => {
      const out: number[] = [];
      let r = BONDS.start;
      for (let k = 0; k < n; k++) out.push((r = stepBaseRate(r, seed, k).rate));
      return out;
    };
    const p = path(12345, 10_000);
    expect(Math.min(...p)).toBeGreaterThanOrEqual(BONDS.minRate);
    expect(Math.max(...p)).toBeLessThanOrEqual(BONDS.maxRate);
    const mean = p.reduce((a, b) => a + b, 0) / p.length;
    expect(Math.abs(mean - BONDS.mean)).toBeLessThan(0.0025);
    let num = 0, den = 0;
    for (let i = 0; i < p.length; i++) {
      den += (p[i] - mean) ** 2;
      if (i) num += (p[i] - mean) * (p[i - 1] - mean);
    }
    expect(num / den).toBeGreaterThan(0.8);
    expect(path(12345, 50)).toEqual(p.slice(0, 50));
    expect(path(1, 24)).not.toEqual(path(2, 24));
    // Replaying month k alone from the stored previous rate gives the sequential value.
    for (const k of [0, 7, 400, 9999]) expect(stepBaseRate(k ? p[k - 1] : BONDS.start, 12345, k).rate).toBe(p[k]);
    expect(mixSeed(0, 0)).not.toBe(0);
    expect(marketSeedFrom(2030)).toBe(marketSeedFrom(2030));
    expect(marketSeedFrom(2030)).not.toBe(marketSeedFrom(2031));
  });
});

describe('bonds', () => {
  it('keep their own coupon and level payment', () => {
    const f = new Finance(false);
    const a = f.issueBond(0)!;
    expect(a.rate).toBe(0.025);
    expect(a.monthsLeft).toBe(360);
    expect(a.monthlyPayment).toBe(annuityPayment(1e9, ECONOMY.bondRate, ECONOMY.bondYears));
    f.market.base = 0.04;
    const b = f.issueBond(0)!;
    expect(b.rate).toBe(0.04);
    const end = monthEnd(0);
    for (let d = 0; d < end; d++) f.settleDay(day(d));
    const held = (end + 1) / weekdaysInMonth(end);
    const led = f.settleDay(day(end));
    // Issue month: interest only, pro-rated, each at its own coupon.
    expect(led.bondInterest).toBeCloseTo((1e9 * 0.025) / 12 * held + (1e9 * 0.04) / 12 * held, 3);
    expect(led.bondPrincipal).toBe(0);
    // The next month end: level payments at each bond's own payment.
    const end2 = monthEnd(end + 1);
    for (let d = end + 1; d < end2; d++) f.settleDay(day(d));
    const led2 = f.settleDay(day(end2));
    expect(led2.bondInterest).toBeCloseTo((1e9 * 0.025) / 12 + (1e9 * 0.04) / 12, 3);
    expect(led2.bondInterest + led2.bondPrincipal).toBeCloseTo(a.monthlyPayment + b.monthlyPayment, 3);
    expect(a.monthsLeft).toBe(359);
    expect(b.monthsLeft).toBe(359);
    expect(a.balance).toBeCloseTo(1e9 - (a.monthlyPayment - (1e9 * 0.025) / 12), 3);
  });

  it('refinance at a lower rate keeps the term, charges 1% and pays for itself', () => {
    const f = new Finance(false);
    const b = f.issueBond(0)!;
    Object.assign(b, { rate: 0.035, monthsLeft: 300, monthlyPayment: annuityMonthly(1e9, 0.035, 300), issuedDay: -1000 });
    const old = b.monthlyPayment;
    f.market.base = 0.025;
    f.market.rating = 'AAA';
    // Refused when the gain is under 0.05%.
    f.market.base = 0.0346;
    expect(f.refinanceBond(b.id, 0).ok).toBe(false);
    f.market.base = 0.025;
    const cash = f.cash, debt = f.debt();
    const res = f.refinanceBond(b.id, 0);
    expect(res.ok).toBe(true);
    expect(b.rate).toBe(0.025);
    expect(b.monthsLeft).toBe(300);
    expect(b.monthlyPayment).toBeCloseTo(annuityMonthly(1e9, 0.025, 300), 6);
    expect(f.cash).toBe(cash - 1e7);
    expect(f.today.fees).toBe(1e7);
    expect(f.debt()).toBe(debt);
    expect(res.saving).toBeCloseTo(old - b.monthlyPayment, 6);
    expect(res.paybackMonths).toBeCloseTo(1e7 / res.saving, 6);
    // 300 month ends retire it exactly; the payments saved beat the fee.
    let d = 0, n = 0;
    while (f.bonds.length) {
      d = monthEnd(d);
      f.settleDay(day(d));
      d++;
      n++;
      expect(n).toBeLessThanOrEqual(300);
    }
    expect(n).toBe(300);
    expect(res.saving * 300).toBeGreaterThan(res.fee);
    // Refused when cash is short.
    const g = new Finance(false);
    const c = g.issueBond(0)!;
    Object.assign(c, { rate: 0.04, issuedDay: -1000 });
    g.cash = 1e6;
    expect(g.refinanceBond(c.id, 0)).toMatchObject({ ok: false });
    // ...and in sandbox.
    const s = new Finance(true);
    const sb = s.issueBond(0)!;
    sb.rate = 0.05;
    expect(s.refinanceBond(sb.id, 0).ok).toBe(false);
  });

  it('prepay lowers the payment, keeps the maturity and frees bond room', () => {
    const f = new Finance(false);
    const b = f.issueBond(0)!;
    const cash = f.cash;
    expect(f.prepayBond(b.id, 250e6, 0).ok).toBe(true);
    expect(b.balance).toBe(750e6);
    expect(f.cash).toBe(cash - 252.5e6);
    expect(f.today.prepaid).toBe(250e6);
    expect(f.today.fees).toBe(2.5e6);
    expect(b.monthsLeft).toBe(360);
    expect(b.monthlyPayment).toBeCloseTo(annuityMonthly(750e6, b.rate, 360), 6);
    // Settling the day doesn't take the fee or the prepayment again.
    const before = f.cash;
    const led = f.settleDay(day(0));
    expect(f.cash).toBe(before);
    expect(led.fees).toBe(2.5e6);
    expect(led.prepaid).toBe(250e6);
    // It still matures on schedule (1 interest-only month + 360 level payments).
    let d = 1, n = 0;
    while (f.bonds.length) {
      d = monthEnd(d);
      f.settleDay(day(d));
      d++;
      n++;
    }
    expect(n).toBe(361);
    // "All" removes the bond and frees its room; refused when cash is short.
    const g = new Finance(false);
    const c = g.issueBond(0)!;
    const room = g.bondRoom();
    expect(g.prepayBond(c.id, c.balance, 0).ok).toBe(true);
    expect(g.bonds).toHaveLength(0);
    expect(g.bondRoom()).toBe(room + 1e9);
    const h = new Finance(false);
    const e = h.issueBond(0)!;
    h.cash = 100e6;
    expect(h.prepayBond(e.id, 250e6, 0).ok).toBe(false);
    expect(h.prepayBond(e.id, 2e9, 0).ok).toBe(false);
  });

  it('inverts the annuity to find the payments left', () => {
    const pmt = annuityPayment(1e9, 0.025, 30);
    let bal = 1e9;
    for (let k = 0; k <= 359; k++) {
      if ([0, 1, 59, 359].includes(k)) expect(remainingPayments(bal, pmt, 0.025)).toBe(360 - k);
      const interest = (bal * 0.025) / 12;
      bal -= pmt - interest;
    }
    expect(remainingPayments(0.5, pmt, 0.025)).toBe(0);
  });
});

describe('monthly review', () => {
  it('re-rates the authority, records the market and closes the month with fees and debt', () => {
    const f = new Finance(false);
    for (let i = 0; i < 17; i++) f.issueBond(0);
    f.spend(22.5e9, 'construction');
    const end = monthEnd(0);
    let prepaid = false;
    for (let d = 0; d <= end; d++) {
      if (d === 5) prepaid = f.prepayBond(f.bonds[0].id, 250e6, d).ok;
      f.settleDay({ day: d, riders: 1.3e6, revenue: 3.5e6, carKm: 300_000, stationsOpen: 40, kpi: { transitShare: 0.2, lateness: 90, bunched: 0.06, ewt: 30 } });
    }
    expect(prepaid).toBe(true);
    expect(f.market.history).toHaveLength(1);
    expect(f.market.history[0]).toMatchObject({ key: monthKey(end), label: monthLabel(end), base: BONDS.start, rating: 'AAA', newRate: 0.025 });
    const m = f.months[f.months.length - 1];
    expect(m.rating).toBeDefined();
    expect(m.rating).not.toBe('AAA');
    expect(m.newRate).toBe(f.newBondRate());
    expect(f.events.some((e) => e.kind === 'downgrade' && e.title.includes(m.rating!))).toBe(true);
    expect(m.fees).toBeCloseTo(2.5e6, 6);
    expect(m.prepaid).toBe(250e6);
    expect(m.profit).toBeCloseTo(m.revenue - m.operatingCosts - m.interest - m.fees, 3);
    expect(m.debtEnd).toBe(f.debt());
    expect(m.kpi!.transitShare).toBeCloseTo(0.2, 12);
    expect(m.kpi!.bunched).toBeCloseTo(0.06, 12);
    expect(m.kpi!.lateness).toBeCloseTo(90, 9);
    // The base rate stepped from the game's seed for this month.
    expect(f.market.base).toBe(stepBaseRate(BONDS.start, f.market.seed, 0).rate);
    // Events are cleared at the next settle; nothing is saved of them.
    f.settleDay(day(end + 1));
    expect(f.events).toHaveLength(0);
    expect('events' in f.toData()).toBe(false);
    // A fixed-rate market never moves.
    const fx = new Finance(false);
    fx.market.fixed = true;
    for (let d = 0; d <= end; d++) fx.settleDay(day(d));
    expect(fx.market.base).toBe(BONDS.start);
    expect(fx.newBondRate()).toBe(ECONOMY.bondRate);
  });
});

describe('year in review', () => {
  it('sums the year, lists rating changes in order and finds the peak day', () => {
    const month = (y: number, mo: number, extra: Partial<MonthReport> = {}): MonthReport => ({
      key: `${y}-${String(mo).padStart(2, '0')}`,
      label: `M${mo} ${y}`,
      days: 21,
      revenue: 60e6 + mo,
      operatingCosts: 40e6,
      capital: mo === 1 ? 20e9 : 0,
      bondPayments: 30e6,
      profit: 5e6,
      riders: 21 * (1e6 + mo * 1e4),
      cashEnd: 1e9 - mo * 1e7,
      interest: 15e6,
      fees: mo === 6 ? 1e6 : 0,
      prepaid: 0,
      debtEnd: 17e9 - mo * 1e8,
      kpi: { transitShare: 0.2, lateness: 90, bunched: 0.05, ewt: 20 },
      rating: mo < 3 ? 'A' : mo < 7 ? 'BBB' : 'A',
      newRate: 0.03,
      ...extra,
    });
    const months = [...Array.from({ length: 12 }, (_, i) => month(2030, i + 1)), month(2031, 1), month(2031, 2, { rating: 'AA' })];
    const history = [{ day: 100, riders: 1.5e6 }, { day: 101, riders: 1.7e6 }, { day: 290, riders: 2e6 }].map((h) => ({ ...h }) as unknown as FinanceData['history'][number]);
    const market = { seed: 1, base: 0.025, rating: 'A' as Rating, score: 70, history: months.map((m, i) => ({ key: m.key, label: m.label, base: 0.02 + i * 0.001, rating: (i === 0 ? 'AAA' : months[i - 1].rating!) as Rating, newRate: 0.03, avgCost: 0.025, score: 60, shock: i === 9 ? 0.0075 : 0 })) };
    const f = { months, history, market };
    expect(yearsWithData(f)).toEqual([2030, 2031]);
    const y = buildYearReview(f, { 'first-line': 3, 'riders-1000000': 150, old: null, later: 300 }, 2030);
    expect(y.weekdays).toBe(12 * 21);
    expect(y.money.fares).toBe(months.slice(0, 12).reduce((s, m) => s + m.revenue, 0));
    expect(y.money.fees).toBe(1e6);
    expect(y.money.interest).toBe(12 * 15e6);
    expect(y.money.capital).toBe(20e9);
    expect(y.money.cashStart).toBe(ECONOMY.startingCash);
    expect(y.money.cashEnd).toBe(months[11].cashEnd);
    expect(y.money.debtStart).toBe(0);
    expect(y.money.debtEnd).toBe(months[11].debtEnd);
    expect(y.riders.byMonth).toHaveLength(12);
    expect(y.riders.peak).toEqual({ day: 101, riders: 1.7e6 });
    expect(y.credit.start).toBe('AAA');
    expect(y.credit.changes.map((c) => `${c.from}>${c.to}`)).toEqual(['AAA>A', 'A>BBB', 'BBB>A']);
    expect(y.credit.end).toBe('A');
    expect(y.market.low).toEqual({ label: 'M1 2030', rate: 0.02 });
    expect(y.market.shocks).toEqual([{ label: 'M10 2030', size: 0.0075 }]);
    expect(y.service.bunched).toBeCloseTo(0.05, 12);
    expect(y.goals.sort()).toEqual(['first-line', 'riders-1000000']);
    const y31 = buildYearReview(f, {}, 2031);
    expect(y31.money.cashStart).toBe(months[11].cashEnd);
    expect(y31.credit.start).toBe('A');
    expect(y31.credit.changes.map((c) => `${c.from}>${c.to}`)).toEqual(['A>AA']);
    expect(y31.riders.peak).toEqual({ day: 290, riders: 2e6 });
    // "So far", opened on Mon 4 Feb 2030 with Fri 1 Feb settled: the span and the peak day cover
    // the closed month (January: days 0–18, 19 weekdays), like the totals.
    const jan = [month(2030, 1, { days: 19 })];
    const daily = Array.from({ length: 20 }, (_, d) => ({ day: d, riders: d === 19 ? 3e6 : 1e6 + d }) as unknown as FinanceData['history'][number]);
    const sofar = buildYearReview({ months: jan, history: daily, market }, {}, 2030);
    expect(monthKey(19)).toBe('2030-02');
    expect([sofar.firstDay, sofar.lastDay, sofar.weekdays]).toEqual([0, 18, 19]);
    expect(sofar.riders.peak).toEqual({ day: 18, riders: 1e6 + 18 });
  });
});

describe('save v4 (operations control and the money market)', () => {
  /** A v3 save as the code before v4 wrote it, from a real game. */
  function v3Save() {
    const game = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3, chaos: 'normal', chaosSeed: 777 });
    game.routes.create({ name: 'A', bullet: 'A', color: '#fff', cls: 'heavy', stops: [], cars: 8, headways: { night: 0, am: 4, midday: 8, pm: 4, evening: 10 } });
    game.finance.issueBond(0);
    game.finance.issueBond(0);
    game.finance.settleDay({ day: 0, riders: 1000, revenue: 3000, carKm: 10, stationsOpen: 2 });
    const save = JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1885 }, modeState: null })));
    // Back to the v3 shape.
    save.version = 3;
    delete save.game.fares;
    save.game.fare = 3.25;
    for (const r of save.game.routes.routes) delete r.control;
    const fin = save.game.finance;
    delete fin.market;
    const pmt = annuityPayment(1e9, 0.025, 30);
    let bal = 1e9;
    for (let k = 0; k < 13; k++) bal -= pmt - (bal * 0.025) / 12;
    fin.bonds[1].balance = bal;
    for (const b of fin.bonds) {
      delete b.rate;
      delete b.monthsLeft;
      delete b.rating;
    }
    for (const h of [...fin.history, fin.today]) {
      delete h.fees;
      delete h.prepaid;
      delete h.kpi;
    }
    fin.months = [{ key: '2030-01', label: 'Jan 2030', days: 19, revenue: 50e6, operatingCosts: 30e6, capital: 1e9, bondPayments: 4e6, profit: 16e6, riders: 1e6, cashEnd: 5e9 }];
    return save;
  }

  it('migrates a v3 save to v4 defaults, idempotently, and rates it on load', () => {
    const m = migrate(v3Save());
    expect(m.version).toBe(SAVE_VERSION);
    // (v5 since Living City, v6 since express service and v7 since the Cinematic timelapse: their steps run on the way.)
    expect(SAVE_VERSION).toBe(7);
    expect(m.migratedFrom).toBe(3);
    expect(m.game.fares).toEqual({ peak: 3.25, offPeak: 3.25, lowIncome: 1 });
    expect('fare' in m.game).toBe(false);
    expect(m.game.routes.routes[0].control).toEqual(legacyControl());
    const fin = m.game.finance;
    expect(fin.bonds.map((b) => b.monthsLeft)).toEqual([360, 347]);
    expect(fin.bonds.map((b) => b.rate)).toEqual([0.025, 0.025]);
    expect(fin.history[0].fees).toBe(0);
    expect(fin.history[0].prepaid).toBe(0);
    expect(fin.today.fees).toBe(0);
    expect(fin.months[0].interest).toBe(50e6 - 30e6 - 16e6);
    // Rebuilt from the bonds (both issued in January 2030: interest only that month).
    expect(fin.months[0].debtEnd).toBe(2e9);
    expect(fin.market).toEqual({ seed: marketSeedFrom(777), base: BONDS.start, rating: null, score: 0, history: [] });
    const again = migrate(JSON.parse(JSON.stringify({ ...m, migratedFrom: undefined })));
    expect(again.game).toEqual(m.game);
    const game = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    applySave(game, m);
    expect(game.fares).toEqual({ peak: 3.25, offPeak: 3.25, lowIncome: 1 });
    expect(game.finance.market.rating).not.toBeNull();
    expect(game.finance.market.seed).toBe(marketSeedFrom(777));
    expect(game.routes.list()[0].control).toEqual(legacyControl());
    // A v4 round trip keeps the policy, the market and the controls.
    game.setFares({ peak: 3.5, offPeak: 2.5, lowIncome: 0.5 });
    game.finance.market.base = 0.031;
    const back = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    applySave(back, migrate(JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1885 }, modeState: null })))));
    expect(back.fares).toEqual({ peak: 3.5, offPeak: 2.5, lowIncome: 0.5 });
    expect(back.finance.market.base).toBe(0.031);
    expect(back.finance.bonds.map((b) => [b.rate, b.monthsLeft])).toEqual(game.finance.bonds.map((b) => [b.rate, b.monthsLeft]));
  });

  it('rebuilds the month-end debt of a v3 game from its bonds, for the year in review', () => {
    // A v3 game on v1's fixed 2.5% schedule: 17 bonds in January 2030, one more in April.
    const f = new Finance(false, 0);
    f.market.fixed = true;
    const actual: number[] = [];
    for (let d = 0; d < 300; d++) {
      if (d < 17 || d === 60) f.issueBond(d);
      f.settleDay({ day: d, riders: 1.2e6, revenue: 3.3e6, carKm: 250000, stationsOpen: 40 });
      if (isNewMonth(d + 1)) actual.push(f.debt());
    }
    const fin = f.toData() as unknown as Record<string, any>;
    delete fin.market;
    for (const b of fin.bonds) for (const k of ['rate', 'monthsLeft', 'rating']) delete b[k];
    for (const m of fin.months) for (const k of ['interest', 'fees', 'prepaid', 'debtEnd', 'kpi', 'rating', 'newRate']) delete m[k];
    const v3 = { format: 'headway-ny', version: 3, city: 'nyc', game: { time: 300 * 86400, fare: 3, routes: { routes: [], nextId: 1 }, network: {}, finance: fin, chaos: { level: 'off', seed: 77, service: [], nextServiceId: 1 } } };
    const m = migrate(v3);
    expect(m.game.finance.months.map((x) => x.debtEnd)).toEqual(actual);
    expect(actual[0]).toBe(17e9);
    // Played on into 2031: the review's debt line runs from the real figures, not from $0.
    const g = Finance.fromData(m.game.finance);
    for (let d = 300; d < 540; d++) g.settleDay({ day: d, riders: 1.2e6, revenue: 3.3e6, carKm: 250000, stationsOpen: 40 });
    const y30 = buildYearReview(g.toData(), {} as never, 2030);
    const y31 = buildYearReview(g.toData(), {} as never, 2031);
    expect(y30.money.debtStart).toBe(0);
    expect(y30.money.debtEnd).toBe(actual[m.game.finance.months.findIndex((x) => x.key === '2030-12')]);
    expect(y30.money.debtEnd!).toBeGreaterThan(16e9);
    expect(y31.money.debtStart).toBe(y30.money.debtEnd);
    // A month whose debt is unknown reads as unknown, not as $0.
    const data = g.toData();
    data.months[data.months.findIndex((x) => x.key === '2030-12')].debtEnd = null;
    expect(buildYearReview(data, {} as never, 2030).money.debtEnd).toBeNull();
    expect(buildYearReview(data, {} as never, 2031).money.debtStart).toBeNull();
  });

  it('seeds a new game market from the game seed', () => {
    const a = new Game({} as World, {} as Terrain, { sandbox: false });
    a.setGameSeed(99);
    expect(a.chaos.seed).toBe(99);
    expect(a.finance.market.seed).toBe(marketSeedFrom(99));
    const b = new Game({} as World, {} as Terrain, { sandbox: false, chaosSeed: 99 });
    expect(b.finance.market.seed).toBe(marketSeedFrom(99));
  });
});

describe('money and service goals', () => {
  it('marks investment grade with debt, and clockwork service on a busy, even day', () => {
    const game = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    const goals = emptyGoals();
    expect('rating-a' in goals && 'clockwork' in goals).toBe(true);
    for (let i = 0; i < 5; i++) game.finance.issueBond(0);
    const reg = { ...emptyStats(), samples: 900, bunched: 0.04, cv: 0.2 };
    const report = { riders: 600_000, transitShare: 0.1, baselineCommute: 50, avgCommute: 49, goalTrip: null, regularity: reg, routeRegularity: { 1: reg, 2: reg, 3: reg } } as unknown as DayReport;
    // Day 0: the starting AAA is a placeholder, not a review, so borrowing $5B doesn't earn it.
    expect(game.finance.market.rating).toBe('AAA');
    expect(checkGoals(game, emptyGoals(), report, () => 0)).not.toContain('rating-a');
    // After a month-end review that rates it A.
    for (let d = 0; d < 19; d++) game.finance.settleDay({ day: d, riders: 0, revenue: 0, carKm: 0, stationsOpen: 0 });
    expect(game.finance.market.history.length).toBe(1);
    game.finance.market.rating = 'A';
    const done = checkGoals(game, goals, report, () => 0);
    expect(done).toContain('rating-a');
    expect(done).toContain('clockwork');
    // Not with two routes, too much bunching, BBB, or too little debt.
    const g2 = emptyGoals();
    game.finance.market.rating = 'BBB';
    expect(checkGoals(game, g2, { ...report, routeRegularity: { 1: reg, 2: reg } } as DayReport, () => 0)).not.toContain('clockwork');
    expect(checkGoals(game, g2, { ...report, regularity: { ...reg, bunched: 0.06 } } as DayReport, () => 0)).not.toContain('clockwork');
    expect(g2['rating-a']).toBeNull();
    const poor = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    poor.finance.market.rating = 'AAA';
    expect(checkGoals(poor, emptyGoals(), null, () => 0)).not.toContain('rating-a');
  });
});

describe('Living City in the credit scorecard and the year in review', () => {
  const base = { revenuePerDay: 3e6, opCostPerDay: 2e6, serviceDays: 60, debt: 15e9, annualInterest: 15e9 * 0.03, monthlyDebtService: 6e7, assets: 2e10, cash: 1e9, newRate: 0.03 };
  it('value capture counts in interest coverage (pledged, recurring: TIF) but not in farebox recovery', () => {
    const without = creditScore(base);
    const withVc = creditScore({ ...base, valueCapturePerDay: 0.35e6 });
    const m = (r: ReturnType<typeof creditScore>, id: string) => r.metrics.find((x) => x.id === id)!.value!;
    expect(m(withVc, 'farebox')).toBe(m(without, 'farebox'));
    expect(m(withVc, 'coverage')).toBeGreaterThan(m(without, 'coverage'));
    expect(m(withVc, 'coverage')).toBeCloseTo(((3e6 + 0.35e6 - 2e6) * 261) / (15e9 * 0.03 + 1e9 * 0.03), 9);
    expect(withVc.score).toBeGreaterThan(without.score);
    // Missing and zero are the same as before Living City, bit for bit.
    expect(creditScore({ ...base, valueCapturePerDay: 0 })).toEqual(without);
  });

  it('the finance model annualises the monthly payments: the same rate at every review and mid-month', () => {
    // A payment of 4M at every month close is 48M a year, so 48M / 261 per service day, whatever the
    // day: the old mean over the window's days counted 2 or 3 payments (×0.73 … ×1.15).
    const f = new Finance(false);
    const rate = (4e6 * 12) / ECONOMY.daysPerYear;
    expect(f.creditInputs().valueCapturePerDay).toBe(0);
    const seen: number[] = [];
    for (let d = 0; d < 200; d++) {
      const close = isNewMonth(d + 1);
      f.settleDay({ day: d, riders: 1e5, revenue: 1e6, carKm: 100, stationsOpen: 10, ...(close ? { valueCapture: 4e6 } : {}) });
      if (f.months.length) {
        const v = f.creditInputs().valueCapturePerDay!;
        expect(v).toBeCloseTo(rate, 6);
        seen.push(v);
      } else expect(f.creditInputs().valueCapturePerDay).toBe(0);
    }
    expect(seen.length).toBeGreaterThan(150);
    // A month that paid nothing (growth Off) counts as 0 in the mean, so the rate falls with it.
    const g = new Finance(false);
    for (let d = 0; d < 120; d++) g.settleDay({ day: d, riders: 1e5, revenue: 1e6, carKm: 100, stationsOpen: 10, ...(isNewMonth(d + 1) && monthKey(d) !== '2030-04' ? { valueCapture: 4e6 } : {}) });
    const k0 = monthKey(g.history.slice(-CREDIT.windowDays)[0].day);
    const months = g.months.filter((m) => m.key >= k0);
    const paid = months.filter((m) => m.valueCapture).length;
    expect(paid).toBeLessThan(months.length);
    expect(g.creditInputs().valueCapturePerDay).toBeCloseTo((rate * paid) / months.length, 6);
  });

  it('the year in review has a value-capture line, and its profit includes it', () => {
    const market = { seed: 1, base: 0.025, rating: 'A' as const, score: 70, history: [] };
    const months = [
      { key: '2030-01', label: 'Jan 2030', days: 19, revenue: 50e6, operatingCosts: 30e6, capital: 0, bondPayments: 0, profit: 22e6, riders: 1e6, cashEnd: 5e9, interest: 0, fees: 0, prepaid: 0, debtEnd: 0, valueCapture: 2e6 },
      { key: '2030-02', label: 'Feb 2030', days: 20, revenue: 50e6, operatingCosts: 30e6, capital: 0, bondPayments: 0, profit: 20e6, riders: 1e6, cashEnd: 5e9, interest: 0, fees: 0, prepaid: 0, debtEnd: 0 },
    ];
    const y = buildYearReview({ months, history: [], market }, {}, 2030);
    expect(y.money.valueCapture).toBe(2e6);
    expect(y.money.profit).toBe(42e6);
  });
});

describe('Living City goals', () => {
  it('a monthly profit counts value capture (the profit includes it), and the goal says so', () => {
    expect(goalDefs().find((g) => g.id === 'monthly-profit')!.detail).toMatch(/fares and value capture/i);
    const game = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    const month = (revenue: number, valueCapture?: number): MonthReport => ({
      key: '2030-02', label: 'Feb 2030', days: 20, revenue, operatingCosts: 20.6e6, capital: 0, bondPayments: 0, interest: 18.7e6, fees: 0, prepaid: 0, debtEnd: 0, riders: 1e6, cashEnd: 1e9,
      profit: revenue + (valueCapture ?? 0) - 20.6e6 - 18.7e6,
      ...(valueCapture !== undefined ? { valueCapture } : {}),
    });
    // Fares alone lose ≈ $0.7M; $1.5M of value capture turns the month into a profit.
    game.finance.months.push(month(38.6e6));
    expect(checkGoals(game, emptyGoals(), null, () => 0)).not.toContain('monthly-profit');
    game.finance.months.push(month(38.6e6, 1.5e6));
    expect(checkGoals(game, emptyGoals(), null, () => 0)).toContain('monthly-profit');
  });

  it('Boomtown from the month’s largest tract growth; Land value pays from one month’s value capture, not in the sandbox', () => {
    const report = (growth?: Partial<NonNullable<DayReport['growth']>>) =>
      ({ riders: 1000, transitShare: 0.1, baselineCommute: 50, avgCommute: 49, goalTrip: null, regularity: emptyStats(), routeRegularity: {}, ...(growth ? { growth } : {}) }) as unknown as DayReport;
    const game = new Game({} as World, {} as Terrain, { sandbox: false, fare: 3 });
    const goals = emptyGoals();
    expect('boomtown' in goals && 'value-capture' in goals).toBe(true);
    expect(checkGoals(game, goals, report(), () => 0)).not.toContain('boomtown');
    expect(checkGoals(game, goals, report({ maxTractGrowth: 0.2, valueCapture: GOALS.valueCaptureMonth * 0.9 }), () => 0)).toEqual([]);
    const done = checkGoals(game, goals, report({ maxTractGrowth: GOALS.boomtownGrowth, valueCapture: GOALS.valueCaptureMonth }), () => 0);
    expect(done).toContain('boomtown');
    expect(done).toContain('value-capture');
    const sandbox = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 });
    const sg = checkGoals(sandbox, emptyGoals(), report({ maxTractGrowth: 0.3, valueCapture: 1e9 }), () => 0);
    expect(sg).toContain('boomtown');
    expect(sg).not.toContain('value-capture');
  });
});
