/**
 * Money: cash, spending by category, daily settlement, monthly reports, bonds and bankruptcy.
 * Pure logic — the headless sim drives it directly.
 */
import { ECONOMY } from '../balance';
import { isNewMonth, monthKey, monthLabel } from '../core/calendar';

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
}

export interface MonthReport {
  key: string;
  label: string;
  days: number;
  revenue: number;
  operatingCosts: number;
  capital: number;
  bondPayments: number;
  /** Operating profit: revenue − (operating + staffing + maintenance + bond interest). */
  profit: number;
  riders: number;
  cashEnd: number;
}

export interface Bond {
  id: number;
  principal: number;
  /** Outstanding balance. */
  balance: number;
  monthlyPayment: number;
  issuedDay: number;
}

export interface DayInputs {
  day: number;
  riders: number;
  fare: number;
  carKm: number;
  stationsOpen: number;
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
  };
}

/** Level monthly payment for a loan repaid over n months at monthly rate i. */
export function annuityPayment(principal: number, annualRate: number, years: number): number {
  const i = annualRate / 12;
  const n = years * 12;
  if (i === 0) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
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

  constructor(sandbox: boolean, day = 0) {
    this.sandbox = sandbox;
    this.cash = ECONOMY.startingCash;
    this.today = blankDay(day, this.cash);
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

  bondRoom(): number {
    return Math.max(0, ECONOMY.bondMax - this.bonds.reduce((s, b) => s + b.principal, 0));
  }

  issueBond(day: number): Bond | null {
    if (this.bondRoom() < ECONOMY.bondChunk - 1) return null;
    const p = ECONOMY.bondChunk;
    const b: Bond = {
      id: this.nextBondId++,
      principal: p,
      balance: p,
      monthlyPayment: annuityPayment(p, ECONOMY.bondRate, ECONOMY.bondYears),
      issuedDay: day,
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
    const d = this.today;
    d.day = inp.day;
    d.riders = inp.riders;
    d.carKm = inp.carKm;
    d.revenue = inp.riders * inp.fare;
    d.operating = inp.carKm * ECONOMY.operatingPerCarKm;
    d.staffing = inp.stationsOpen * ECONOMY.staffingPerStationDay;
    d.maintenance = (this.assetValue * ECONOMY.maintenanceRatePerYear) / ECONOMY.daysPerYear;
    // Bond payments fall due on the first weekday of each month (for the month just ended).
    if (isNewMonth(inp.day + 1)) {
      for (const b of this.bonds) {
        if (b.balance <= 0) continue;
        const interest = (b.balance * ECONOMY.bondRate) / 12;
        const pay = Math.min(b.monthlyPayment, b.balance + interest);
        d.bondInterest += interest;
        d.bondPrincipal += pay - interest;
        b.balance = Math.max(0, b.balance - (pay - interest));
      }
      this.bonds = this.bonds.filter((b) => b.balance > 1);
    }
    if (!this.sandbox) {
      this.cash += d.revenue - d.operating - d.staffing - d.maintenance - d.bondInterest - d.bondPrincipal;
    }
    d.cash = this.cash;
    this.history.push(d);
    if (this.history.length > 400) this.history.shift();
    // Bankruptcy: cash below zero for N days in a row with no bond room left.
    if (!this.sandbox && this.cash < 0) {
      this.negativeDays++;
      if (this.negativeDays >= ECONOMY.bankruptcyDays && this.bondRoom() < ECONOMY.bondChunk) this.bankrupt = true;
    } else this.negativeDays = 0;
    // Month roll-up.
    if (isNewMonth(inp.day + 1)) this.closeMonth(inp.day);
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
    this.months.push({
      key,
      label: monthLabel(lastDay),
      days: days.length,
      revenue,
      operatingCosts,
      capital: sum((h) => h.construction + h.trains - h.refunds),
      bondPayments: sum((h) => h.bondInterest + h.bondPrincipal),
      profit: revenue - operatingCosts - interest,
      riders: sum((h) => h.riders),
      cashEnd: this.cash,
    });
    if (this.months.length > 240) this.months.shift();
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
      }),
    );
  }

  static fromData(d: FinanceData): Finance {
    const f = new Finance(d.sandbox);
    Object.assign(f, JSON.parse(JSON.stringify(d)));
    return f;
  }
}
