/**
 * Money: cash, spending by category, daily settlement, monthly reports, bonds and bankruptcy, and
 * (v2) the money market: each bond keeps its own coupon, new bonds borrow at the market's base
 * rate plus the authority's credit spread, bonds can be prepaid or refinanced, and a credit review
 * at each month end re-rates the authority and steps the base rate.
 * Pure logic — the headless sim drives it directly.
 */
import { BONDS, CREDIT, ECONOMY } from '../balance';
import { isNewMonth, monthIndex, monthKey, monthLabel, weekdaysInMonth } from '../core/calendar';
import { creditScore, ratingFromScore, ratingIndex, spreadOf, stepBaseRate, weightedCoupon, type CreditInputs, type CreditResult, type Rating } from './credit';

export type SpendCategory = 'construction' | 'trains';

export interface DayLedger {
  day: number;
  revenue: number;
  refunds: number;
  construction: number;
  trains: number;
  operating: number;
  staffing: number;
  maintenance: number;
  bondInterest: number;
  bondPrincipal: number;
  riders: number;
  carKm: number;
  /** Cash at the end of the day. */
  cash: number;
  /** Prepayment penalties and refinancing fees, paid at once (not in the settle formula). */
  fees: number;
  /** Bond principal prepaid at once (not in the settle formula). */
  prepaid: number;
  /**
   * Living City value capture paid to the authority this day (the month's payment, booked on the
   * month-close day). Set only on days a growth month closed, so a game with growth Off keeps
   * exactly the ledgers it had before Living City; read it as `valueCapture ?? 0`.
   */
  valueCapture?: number;
  /** Service figures for monthly and yearly reviews. */
  kpi?: DayKpi;
}

/** A day's service figures (from the DayReport). */
export interface DayKpi {
  transitShare: number;
  /** Mean lateness, s. */
  lateness: number;
  /** Network share of bunched headways. */
  bunched: number;
  /** Network excess wait, s. */
  ewt: number;
}

export interface MonthReport {
  key: string;
  label: string;
  days: number;
  revenue: number;
  operatingCosts: number;
  capital: number;
  bondPayments: number;
  /** Operating profit: revenue + value capture − (operating + staffing + maintenance + bond interest + financing fees). */
  profit: number;
  /** Living City value capture in the month (present when a growth month closed in it; read as `?? 0`). */
  valueCapture?: number;
  riders: number;
  cashEnd: number;
  /** Bond interest paid. */
  interest: number;
  /** Prepayment penalties and refinancing fees. */
  fees: number;
  /** Principal prepaid. */
  prepaid: number;
  /** Debt at the month end (null on months from saves before v2). */
  debtEnd: number | null;
  /** Mean of the month's daily service figures. */
  kpi?: DayKpi;
  /** Rating set at this month end's review, and the new-bond rate after it. */
  rating?: Rating;
  newRate?: number;
}

export interface Bond {
  id: number;
  principal: number;
  /** Outstanding balance. */
  balance: number;
  monthlyPayment: number;
  issuedDay: number;
  /** Annual coupon, fixed when issued (or refinanced). */
  rate: number;
  /** Level payments still to make. */
  monthsLeft: number;
  /** Rating when issued or last refinanced. */
  rating?: Rating;
  refinancedDay?: number;
}

/** One month end of the bond market (kept for charts and the year in review). */
export interface MarketMonth {
  key: string;
  label: string;
  /** Base rate in force during the month (before this review's step). */
  base: number;
  /** Rating during the month. */
  rating: Rating;
  /** New-bond rate during the month. */
  newRate: number;
  /** Balance-weighted coupon of the authority's debt at the month end. */
  avgCost: number;
  /** The review's score. */
  score: number;
  /** Shock applied at this review (±BONDS.shockSize, or 0). */
  shock: number;
}

export interface MarketData {
  /** Seed of the base-rate walk (derived from the game's seed). */
  seed: number;
  /** Base rate for new bonds now. */
  base: number;
  /** Current rating (null: not rated yet, on a migrated save before its first load). */
  rating: Rating | null;
  score: number;
  history: MarketMonth[];
  /**
   * The all-off configuration: new bonds always borrow at ECONOMY.bondRate (v1's fixed rate) with no
   * spread and the base rate never moves. Reviews still score the authority, for information.
   */
  fixed?: boolean;
}

/** Something the main thread should toast after a settle (not saved). */
export interface FinanceEvent {
  kind: 'upgrade' | 'downgrade' | 'shock';
  title: string;
  body: string;
  tone: 'green' | 'amber' | 'red';
}

export interface DayInputs {
  day: number;
  /** Boardings (for reports and goals). */
  riders: number;
  /** Fares collected: one per linked journey (transfers are free), at the fare when it boarded. */
  revenue: number;
  carKm: number;
  stationsOpen: number;
  /** Service figures for the reviews (optional). */
  kpi?: DayKpi;
  /** Living City: the month's value capture, on the day a growth month closed (DayReport.growth.valueCapture); omit on other days. */
  valueCapture?: number;
}

export interface FinanceData {
  cash: number;
  sandbox: boolean;
  bonds: Bond[];
  nextBondId: number;
  history: DayLedger[];
  months: MonthReport[];
  assetValue: number;
  negativeDays: number;
  today: DayLedger;
  bankrupt: boolean;
  market: MarketData;
}

export function blankDay(day: number, cash = 0): DayLedger {
  return {
    day,
    revenue: 0,
    refunds: 0,
    construction: 0,
    trains: 0,
    operating: 0,
    staffing: 0,
    maintenance: 0,
    bondInterest: 0,
    bondPrincipal: 0,
    riders: 0,
    carKm: 0,
    cash,
    fees: 0,
    prepaid: 0,
  };
}

/** A day's service figures from its DayReport (for the reviews). */
export function dayKpi(r: { transitShare: number; avgLateness: number; regularity?: { bunched: number; ewt: number } }): DayKpi {
  return { transitShare: r.transitShare, lateness: r.avgLateness, bunched: r.regularity?.bunched ?? 0, ewt: r.regularity?.ewt ?? 0 };
}

/** Level monthly payment for a loan of P repaid over `months` payments at an annual rate. */
export function annuityMonthly(P: number, annualRate: number, months: number): number {
  const i = annualRate / 12;
  if (months <= 0) return P;
  return i === 0 ? P / months : (P * i) / (1 - Math.pow(1 + i, -months));
}

/** Level monthly payment for a loan repaid over n years (v1's signature). */
export function annuityPayment(principal: number, annualRate: number, years: number): number {
  return annuityMonthly(principal, annualRate, years * 12);
}

/** Payments left on a level loan (the inverse annuity): used to migrate bonds from older saves. */
export function remainingPayments(balance: number, payment: number, annualRate: number, term = BONDS.termMonths): number {
  const i = annualRate / 12;
  if (balance <= 1) return 0;
  if (!(payment > 0)) return term;
  if (i === 0) return Math.min(term, Math.ceil(balance / payment));
  const x = 1 - (balance * i) / payment;
  if (x <= 0) return term;
  return Math.max(1, Math.min(term, Math.round(-Math.log(x) / Math.log(1 + i))));
}

/** A fresh market: the base rate at BONDS.start, rated from the current state at the first review. */
export function newMarket(seed: number, fixed = false): MarketData {
  return { seed: seed >>> 0 || 1, base: BONDS.start, rating: 'AAA', score: 100, history: [], ...(fixed ? { fixed: true } : {}) };
}

export class Finance {
  cash: number;
  sandbox: boolean;
  bonds: Bond[] = [];
  nextBondId = 1;
  history: DayLedger[] = [];
  months: MonthReport[] = [];
  /** Build cost of everything owned (track, stations, trains) — maintenance base. */
  assetValue = 0;
  negativeDays = 0;
  bankrupt = false;
  today: DayLedger;
  market: MarketData;
  /** Rating changes and market shocks from the last settle (cleared at each settle; not saved). */
  events: FinanceEvent[] = [];

  constructor(sandbox: boolean, day = 0, seed = BONDS.defaultSeed) {
    this.sandbox = sandbox;
    this.cash = ECONOMY.startingCash;
    this.today = blankDay(day, this.cash);
    this.market = newMarket(seed);
    this.market.score = creditScore(this.creditInputs()).score;
  }

  canAfford(amount: number): boolean {
    return this.sandbox || amount <= this.cash;
  }

  /** Capital spending (construction, train purchases). Adds to the maintenance base. */
  spend(amount: number, cat: SpendCategory): boolean {
    if (!this.canAfford(amount)) return false;
    if (!this.sandbox) this.cash -= amount;
    this.today[cat] += amount;
    this.assetValue += amount;
    return true;
  }

  /** Bulldozing refunds part of an asset's cost. */
  refund(assetCost: number, fraction: number): number {
    const r = assetCost * fraction;
    if (!this.sandbox) this.cash += r;
    this.today.refunds += r;
    this.assetValue = Math.max(0, this.assetValue - assetCost);
    return r;
  }

  debt(): number {
    return this.bonds.reduce((s, b) => s + b.balance, 0);
  }

  /** The $20B limit is on outstanding debt: repaying principal frees room to borrow again. */
  bondRoom(): number {
    return Math.max(0, ECONOMY.bondMax - this.debt());
  }

  /** Coupon for a bond issued now: the market's base rate plus the rating's spread (fixed: v1's rate). */
  newBondRate(): number {
    if (this.market.fixed) return ECONOMY.bondRate;
    return this.market.base + spreadOf(this.market.rating ?? 'AAA');
  }

  issueBond(day: number): Bond | null {
    if (this.bondRoom() < ECONOMY.bondChunk - 1) return null;
    const p = ECONOMY.bondChunk;
    const rate = this.newBondRate();
    const b: Bond = {
      id: this.nextBondId++,
      principal: p,
      balance: p,
      monthlyPayment: annuityMonthly(p, rate, BONDS.termMonths),
      issuedDay: day,
      rate,
      monthsLeft: BONDS.termMonths,
      rating: this.market.rating ?? 'AAA',
    };
    this.bonds.push(b);
    this.cash += p;
    if (this.cash >= 0) this.negativeDays = 0;
    return b;
  }

  /**
   * Settle the day at midnight: fares in, operating costs out, maintenance, and monthly bond
   * payments when a new month starts. Returns the closed ledger.
   */
  settleDay(inp: DayInputs): DayLedger {
    // A day is settled once (e.g. a save taken just before midnight re-closes it on load).
    const last = this.history[this.history.length - 1];
    if (last && inp.day <= last.day) return last;
    this.events.length = 0;
    const d = this.today;
    d.fees ??= 0;
    d.prepaid ??= 0;
    if (inp.kpi) d.kpi = { ...inp.kpi };
    d.day = inp.day;
    d.riders = inp.riders;
    d.carKm = inp.carKm;
    d.revenue = inp.revenue;
    // Living City: its own ledger line, not fares (sandbox: recorded, no cash change, like fares).
    if (inp.valueCapture !== undefined) d.valueCapture = inp.valueCapture;
    const vc = d.valueCapture ?? 0;
    d.operating = inp.carKm * ECONOMY.operatingPerCarKm;
    d.staffing = inp.stationsOpen * ECONOMY.staffingPerStationDay;
    d.maintenance = (this.assetValue * ECONOMY.maintenanceRatePerYear) / ECONOMY.daysPerYear;
    // Bond payments fall due on the first weekday of each month (for the month just ended).
    if (isNewMonth(inp.day + 1)) {
      for (const b of this.bonds) {
        if (b.balance <= 0) continue;
        // In the month a bond is issued it pays interest only, for the days it was held; level
        // instalments start at the end of its first full month.
        const issueMonth = monthKey(b.issuedDay) === monthKey(inp.day);
        const held = issueMonth ? Math.min(1, (inp.day - b.issuedDay + 1) / weekdaysInMonth(inp.day)) : 1;
        const interest = ((b.balance * b.rate) / 12) * held;
        // The last level payment clears any rounding, so re-amortised bonds still mature on time.
        const pay = issueMonth ? interest : b.monthsLeft <= 1 ? b.balance + interest : Math.min(b.monthlyPayment, b.balance + interest);
        if (!issueMonth) b.monthsLeft = Math.max(0, b.monthsLeft - 1);
        d.bondInterest += interest;
        d.bondPrincipal += pay - interest;
        b.balance = Math.max(0, b.balance - (pay - interest));
      }
      this.bonds = this.bonds.filter((b) => b.balance > 1);
    }
    if (!this.sandbox) {
      this.cash += d.revenue + vc - d.operating - d.staffing - d.maintenance - d.bondInterest - d.bondPrincipal;
    }
    d.cash = this.cash;
    this.history.push(d);
    if (this.history.length > 400) this.history.shift();
    // Bankruptcy: cash below zero for N days in a row with no bond room left.
    if (!this.sandbox && this.cash < 0) {
      this.negativeDays++;
      if (this.negativeDays >= ECONOMY.bankruptcyDays && this.bondRoom() < ECONOMY.bondChunk) this.bankrupt = true;
    } else this.negativeDays = 0;
    // Month roll-up, then the credit review and the bond market's step.
    if (isNewMonth(inp.day + 1)) {
      this.closeMonth(inp.day);
      this.reviewMonth(inp.day);
    }
    this.today = blankDay(inp.day + 1, this.cash);
    return d;
  }

  private closeMonth(lastDay: number): void {
    const key = monthKey(lastDay);
    const days = this.history.filter((h) => monthKey(h.day) === key);
    const sum = (f: (h: DayLedger) => number) => days.reduce((s, h) => s + f(h), 0);
    const revenue = sum((h) => h.revenue);
    const operatingCosts = sum((h) => h.operating + h.staffing + h.maintenance);
    const interest = sum((h) => h.bondInterest);
    const fees = sum((h) => h.fees ?? 0);
    // Value capture is its own line, and counts towards the month's profit.
    const hasVc = days.some((h) => h.valueCapture !== undefined);
    const valueCapture = sum((h) => h.valueCapture ?? 0);
    const withKpi = days.filter((h) => h.kpi);
    const kpiMean = (f: (k: DayKpi) => number) => withKpi.reduce((s, h) => s + f(h.kpi!), 0) / withKpi.length;
    this.months.push({
      key,
      label: monthLabel(lastDay),
      days: days.length,
      revenue,
      operatingCosts,
      capital: sum((h) => h.construction + h.trains - h.refunds),
      bondPayments: sum((h) => h.bondInterest + h.bondPrincipal),
      profit: revenue + valueCapture - operatingCosts - interest - fees,
      ...(hasVc ? { valueCapture } : {}),
      riders: sum((h) => h.riders),
      cashEnd: this.cash,
      interest,
      fees,
      prepaid: sum((h) => h.prepaid ?? 0),
      debtEnd: this.debt(),
      ...(withKpi.length ? { kpi: { transitShare: kpiMean((k) => k.transitShare), lateness: kpiMean((k) => k.lateness), bunched: kpiMean((k) => k.bunched), ewt: kpiMean((k) => k.ewt) } } : {}),
    });
    if (this.months.length > 240) this.months.shift();
  }

  // ------------------------------------------------------------------ credit and the bond market
  /**
   * The scorecard's inputs from the last CREDIT.windowDays settled days and the balance sheet now.
   * Living City value capture is averaged over the same service days (it arrives once a month) and
   * counts in interest coverage only: see CreditInputs.valueCapturePerDay.
   */
  creditInputs(): CreditInputs {
    const win = this.history.slice(-CREDIT.windowDays).filter((h) => h.riders > 0);
    const n = win.length;
    const revenuePerDay = n ? win.reduce((s, h) => s + h.revenue, 0) / n : 0;
    const opCostPerDay = n ? win.reduce((s, h) => s + h.operating + h.staffing + h.maintenance, 0) / n : 0;
    const valueCapturePerDay = n ? win.reduce((s, h) => s + (h.valueCapture ?? 0), 0) / n : 0;
    return {
      revenuePerDay,
      opCostPerDay,
      valueCapturePerDay,
      serviceDays: n,
      debt: this.debt(),
      annualInterest: this.bonds.reduce((s, b) => s + b.balance * b.rate, 0),
      monthlyDebtService: this.bonds.reduce((s, b) => s + b.monthlyPayment, 0),
      assets: this.assetValue,
      cash: this.cash,
      newRate: this.newBondRate(),
    };
  }

  /** The scorecard now, and the rating it would give at a review (with hysteresis). */
  previewCredit(): CreditResult & { next: Rating } {
    const res = creditScore(this.creditInputs());
    return { ...res, next: ratingFromScore(res.score, this.market.rating) };
  }

  /** Balance-weighted coupon of the debt. */
  weightedCoupon(): number {
    return weightedCoupon(this.bonds);
  }

  /**
   * Month-end review (after closeMonth): re-rate the authority from the scorecard, record the
   * month in the market history, then step the base rate (seeded by the month index). The month
   * just closed gets the new rating and new-bond rate.
   */
  reviewMonth(lastDay: number): void {
    const m = this.market;
    const res = creditScore(this.creditInputs());
    const prev = m.rating;
    const rating = ratingFromScore(res.score, prev);
    const before = this.newBondRate();
    const step = m.fixed ? { rate: m.base, shock: 0 } : stepBaseRate(m.base, m.seed, monthIndex(lastDay));
    m.history.push({ key: monthKey(lastDay), label: monthLabel(lastDay), base: m.base, rating: prev ?? rating, newRate: before, avgCost: this.weightedCoupon(), score: res.score, shock: step.shock });
    if (m.history.length > BONDS.historyMonths) m.history.shift();
    m.rating = rating;
    m.score = res.score;
    m.base = step.rate;
    const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
    if (prev && rating !== prev) {
      const up = ratingIndex(rating) < ratingIndex(prev);
      this.events.push(
        up
          ? { kind: 'upgrade', title: `Credit rating upgraded to ${rating}`, body: `New bonds now ${pct(this.newBondRate())}.`, tone: 'green' }
          : { kind: 'downgrade', title: `Credit rating downgraded to ${rating}`, body: `New bonds now ${pct(this.newBondRate())}.`, tone: ratingIndex(rating) >= ratingIndex('BB') ? 'red' : 'amber' },
      );
    }
    if (step.shock) {
      this.events.push({ kind: 'shock', title: `Bond market shock: rates ${step.shock > 0 ? 'up' : 'down'} ${(Math.abs(step.shock) * 100).toFixed(2)}%`, body: `New bonds now ${pct(this.newBondRate())}.`, tone: step.shock > 0 ? 'amber' : 'green' });
    }
    const mo = this.months[this.months.length - 1];
    if (mo && mo.key === monthKey(lastDay)) {
      mo.rating = rating;
      mo.newRate = this.newBondRate();
    }
  }

  // ------------------------------------------------------------------ prepay and refinance
  /**
   * Prepay `amount` of a bond's balance now, with a BONDS.prepayPenalty fee. The bond keeps its
   * maturity with a lower level payment (or goes, when fully repaid). Bond room is freed at once.
   */
  prepayBond(id: number, amount: number, day: number): { ok: boolean; fee: number; reason?: string; bond?: Bond } {
    void day;
    const b = this.bonds.find((x) => x.id === id);
    if (this.sandbox) return { ok: false, fee: 0, reason: 'Sandbox: borrowing is off' };
    if (!b) return { ok: false, fee: 0, reason: 'No such bond' };
    if (!(amount > 0) || amount > b.balance + 1e-6) return { ok: false, fee: 0, reason: 'Amount must be between 0 and the balance' };
    const amt = Math.min(amount, b.balance);
    const fee = amt * BONDS.prepayPenalty;
    if (this.cash < amt + fee) return { ok: false, fee, reason: 'Not enough cash' };
    this.cash -= amt + fee;
    this.today.prepaid = (this.today.prepaid ?? 0) + amt;
    this.today.fees = (this.today.fees ?? 0) + fee;
    b.balance -= amt;
    if (b.balance <= 1) this.bonds = this.bonds.filter((x) => x !== b);
    else b.monthlyPayment = annuityMonthly(b.balance, b.rate, Math.max(1, b.monthsLeft));
    return { ok: true, fee, bond: b };
  }

  /** What refinancing a bond now would do (null if no such bond), whether or not it is allowed. */
  refinanceQuote(id: number): { rate: number; fee: number; oldPayment: number; newPayment: number; saving: number; paybackMonths: number; ok: boolean; reason?: string } | null {
    const b = this.bonds.find((x) => x.id === id);
    if (!b) return null;
    const rate = this.newBondRate();
    const fee = b.balance * BONDS.refinanceFee;
    const newPayment = annuityMonthly(b.balance, rate, Math.max(1, b.monthsLeft));
    const saving = b.monthlyPayment - newPayment;
    const reason = this.sandbox
      ? 'Sandbox: borrowing is off'
      : rate > b.rate - BONDS.refinanceMinGain
        ? `The new-bond rate must be at least ${(BONDS.refinanceMinGain * 100).toFixed(2)}% below the coupon`
        : this.cash < fee
          ? 'Not enough cash for the fee'
          : undefined;
    return { rate, fee, oldPayment: b.monthlyPayment, newPayment, saving, paybackMonths: saving > 0 ? fee / saving : Infinity, ok: !reason, ...(reason ? { reason } : {}) };
  }

  /** Refinance a bond at today's new-bond rate for a BONDS.refinanceFee fee, keeping its remaining term. */
  refinanceBond(id: number, day: number): { ok: boolean; fee: number; saving: number; paybackMonths: number; reason?: string } {
    const q = this.refinanceQuote(id);
    if (!q) return { ok: false, fee: 0, saving: 0, paybackMonths: Infinity, reason: 'No such bond' };
    if (!q.ok) return { ok: false, fee: q.fee, saving: q.saving, paybackMonths: q.paybackMonths, reason: q.reason };
    const b = this.bonds.find((x) => x.id === id)!;
    this.cash -= q.fee;
    this.today.fees = (this.today.fees ?? 0) + q.fee;
    b.rate = q.rate;
    b.monthlyPayment = q.newPayment;
    b.rating = this.market.rating ?? 'AAA';
    b.refinancedDay = day;
    return { ok: true, fee: q.fee, saving: q.saving, paybackMonths: q.paybackMonths };
  }

  /** Change in cash over the last settled day. */
  lastDayChange(): number {
    const n = this.history.length;
    if (n === 0) return 0;
    const prev = n > 1 ? this.history[n - 2].cash : ECONOMY.startingCash;
    return this.history[n - 1].cash - prev;
  }

  toData(): FinanceData {
    return JSON.parse(
      JSON.stringify({
        cash: this.cash,
        sandbox: this.sandbox,
        bonds: this.bonds,
        nextBondId: this.nextBondId,
        history: this.history,
        months: this.months,
        assetValue: this.assetValue,
        negativeDays: this.negativeDays,
        today: this.today,
        bankrupt: this.bankrupt,
        market: this.market,
      }),
    );
  }

  /**
   * Restore from a save (migrated to the current version). A save not rated yet (from before the
   * money market) is rated from its own state, the same way every time.
   */
  static fromData(d: FinanceData): Finance {
    const f = new Finance(d.sandbox);
    Object.assign(f, JSON.parse(JSON.stringify(d)));
    f.events = [];
    if (!f.market) f.market = newMarket(BONDS.defaultSeed);
    if (!f.market.rating) {
      const res = creditScore(f.creditInputs());
      f.market.rating = ratingFromScore(res.score, null);
      f.market.score = res.score;
    }
    return f;
  }
}
