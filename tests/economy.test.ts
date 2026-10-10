import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/balance';
import { dateOfDay, isNewMonth, weekdaysInMonth } from '../src/core/calendar';
import { annuityPayment, Finance } from '../src/economy/finance';
import { RouteSet } from '../src/routes/routeSet';

const day = (d: number, revenue = 0) => ({ day: d, riders: 0, revenue, carKm: 0, stationsOpen: 0 });

/** First game day whose next day starts a new month. */
function monthEnd(from: number): number {
  let d = from;
  while (!isNewMonth(d + 1)) d++;
  return d;
}

describe('calendar', () => {
  it('skips weekends and counts weekdays per month', () => {
    for (let d = 0; d < 300; d++) {
      const w = dateOfDay(d).getUTCDay();
      expect(w).not.toBe(0);
      expect(w).not.toBe(6);
    }
    // January 2030 has 23 weekdays.
    expect(weekdaysInMonth(0)).toBe(23);
  });
});

describe('finance', () => {
  it('settles each day once', () => {
    const f = new Finance(false);
    f.assetValue = 1e9;
    f.settleDay(day(0, 1e6));
    const cash = f.cash;
    // A save from just before midnight re-closes day 0 after loading.
    const g = Finance.fromData(f.toData());
    g.settleDay(day(0, 1e6));
    expect(g.cash).toBe(cash);
    expect(g.history.length).toBe(1);
  });

  it('amortises a bond to zero over its term', () => {
    const p = annuityPayment(1e9, ECONOMY.bondRate, ECONOMY.bondYears);
    let bal = 1e9;
    for (let m = 0; m < ECONOMY.bondYears * 12; m++) {
      const interest = (bal * ECONOMY.bondRate) / 12;
      bal -= Math.min(p, bal + interest) - interest;
    }
    expect(Math.abs(bal)).toBeLessThan(1);
  });

  it('charges a new bond interest only for the days it was held in its first month', () => {
    const end = monthEnd(0);
    const f = new Finance(false);
    for (let d = 0; d < end; d++) f.settleDay(day(d));
    f.issueBond(end); // last weekday of the month
    const led = f.settleDay(day(end));
    const fullMonth = (ECONOMY.bondChunk * ECONOMY.bondRate) / 12;
    expect(led.bondInterest).toBeCloseTo(fullMonth / weekdaysInMonth(end), 0);
    expect(led.bondPrincipal).toBe(0);
    // The next month-end pays the level instalment.
    const end2 = monthEnd(end + 1);
    for (let d = end + 1; d < end2; d++) f.settleDay(day(d));
    const led2 = f.settleDay(day(end2));
    expect(led2.bondInterest + led2.bondPrincipal).toBeCloseTo(f.bonds[0].monthlyPayment, 0);
  });

  it('books fare revenue and frees bond room as principal is repaid', () => {
    const f = new Finance(false);
    f.settleDay(day(0, 3e6));
    expect(f.history[0].revenue).toBe(3e6);
    for (let i = 0; i < ECONOMY.bondMax / ECONOMY.bondChunk; i++) expect(f.issueBond(1)).not.toBeNull();
    expect(f.issueBond(1)).toBeNull();
    f.bonds[0].balance -= ECONOMY.bondChunk; // fully repaid
    f.bonds = f.bonds.filter((b) => b.balance > 1);
    expect(f.bondRoom()).toBeGreaterThanOrEqual(ECONOMY.bondChunk);
  });
});

describe('route fleet', () => {
  it("keeps a deleted route's cars as spares through save and load", () => {
    const rs = new RouteSet();
    const r = rs.create({ name: 'Test', bullet: 'A', color: '#fff', cls: 'heavy', cars: 8, stops: [], headways: { night: 20, am: 4, midday: 8, pm: 4, evening: 10 } } as never);
    r.ownedCars = 96;
    rs.remove(r.id);
    expect(rs.spareCars.heavy).toBe(96);
    const copy = new RouteSet();
    copy.load(rs.toData());
    expect(copy.spareCars.heavy).toBe(96);
    copy.load({ routes: [], nextId: 1 }); // older saves have no pool
    expect(copy.spareCars.heavy).toBe(0);
  });
});
