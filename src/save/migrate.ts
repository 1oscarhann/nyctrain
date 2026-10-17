/**
 * Save migrations: each step upgrades a save by one version, so any old save can be brought up
 * to date by running the steps in order.
 */
import { BONDS, CHAOS, ECONOMY } from '../balance';
import { isCityId } from '../cities';
import { marketSeedFrom } from '../economy/credit';
import { remainingPayments } from '../economy/finance';
import { monthIndex } from '../core/calendar';
import { legacyControl } from '../routes/control';
import { SAVE_VERSION, type SaveFile } from './format';

type AnySave = Record<string, unknown> & { version?: number };
type Loose = Record<string, any>;

const STEPS: Record<number, (s: AnySave) => AnySave> = {
  // v1 → v2: v1 kept goals at the top level and had no tutorial flag or saved report.
  1: (s) => {
    const game = (s.game ?? {}) as Record<string, unknown>;
    if (!game.goals && s.goals) game.goals = s.goals;
    delete s.goals;
    game.tutorialDone ??= true;
    game.lastReport ??= null;
    s.game = game;
    s.version = 2;
    return s;
  },
  // v2 → v3: city chaos (events, disruptions, weather). Defaults only, so it is idempotent.
  2: (s) => {
    const game = (s.game ?? {}) as Record<string, unknown>;
    game.chaos ??= { level: CHAOS.defaultLevel, seed: CHAOS.defaultSeed, service: [], nextServiceId: 1 };
    s.game = game;
    s.version = 3;
    return s;
  },
  // v3 → v4: operations control and the money market. Defaults only (??=), so it is idempotent:
  // - the flat fare becomes a flat policy (no low-income discount);
  // - routes get legacyControl() (holding off, no recovery: the fleet is unchanged; short turns on);
  // - bonds keep 2.5% (v1's fixed rate) and get their remaining term from the annuity;
  // - ledgers and month reports get zero fees and prepayments (a month's interest is recovered
  //   exactly from v1's profit formula); the market starts at 2.5%, seeded from the game's seed,
  //   and is rated on load (Finance.fromData).
  3: (s) => {
    const game = (s.game ?? {}) as Loose;
    const fare = typeof game.fare === 'number' && Number.isFinite(game.fare) ? game.fare : ECONOMY.fareDefault;
    game.fares ??= { peak: fare, offPeak: fare, lowIncome: 1 };
    delete game.fare;
    const routes = game.routes && typeof game.routes === 'object' ? (game.routes as Loose) : null;
    for (const r of Array.isArray(routes?.routes) ? (routes!.routes as Loose[]) : []) r.control ??= legacyControl();
    const fin = (game.finance && typeof game.finance === 'object' ? game.finance : {}) as Loose;
    for (const b of Array.isArray(fin.bonds) ? (fin.bonds as Loose[]) : []) {
      b.rate ??= ECONOMY.bondRate;
      b.monthsLeft ??= b.balance >= b.principal - 1 ? BONDS.termMonths : remainingPayments(b.balance, b.monthlyPayment, b.rate);
    }
    for (const h of [...(Array.isArray(fin.history) ? fin.history : []), fin.today].filter((x): x is Loose => !!x && typeof x === 'object')) {
      h.fees ??= 0;
      h.prepaid ??= 0;
    }
    const bonds = Array.isArray(fin.bonds) ? (fin.bonds as Loose[]) : [];
    for (const m of Array.isArray(fin.months) ? (fin.months as Loose[]) : []) {
      m.interest ??= (m.revenue ?? 0) - (m.operatingCosts ?? 0) - (m.profit ?? 0);
      m.fees ??= 0;
      m.prepaid ??= 0;
      m.debtEnd ??= v3DebtAt(bonds, m.key);
    }
    const chaos = (game.chaos ?? {}) as Loose;
    const seed = typeof chaos.seed === 'number' && Number.isFinite(chaos.seed) ? chaos.seed >>> 0 : CHAOS.defaultSeed;
    fin.market ??= { seed: marketSeedFrom(seed), base: BONDS.start, rating: null, score: 0, history: [] };
    game.finance = fin;
    s.game = game;
    s.version = 4;
    return s;
  },
  // v4 → v5: Living City. Defaults only (??=), so it is idempotent:
  // - the game joins Living City on Steady (the menu can turn it off);
  // - ledgers, month reports and today get zero value capture (the year in review and the credit
  //   scorecard read it; months closed before v5 had none);
  // - the two new goals start open;
  // - growth is null: the starting city, so the v4 mode state's key (and its shares) still match.
  4: (s) => {
    const game = (s.game ?? {}) as Loose;
    game.growthPace ??= 'steady';
    const fin = (game.finance && typeof game.finance === 'object' ? game.finance : {}) as Loose;
    for (const h of [...(Array.isArray(fin.history) ? fin.history : []), ...(Array.isArray(fin.months) ? fin.months : []), fin.today].filter((x): x is Loose => !!x && typeof x === 'object')) {
      h.valueCapture ??= 0;
    }
    game.finance = fin;
    if (game.goals && typeof game.goals === 'object') {
      const goals = game.goals as Loose;
      goals.boomtown ??= null;
      goals['value-capture'] ??= null;
    }
    s.growth ??= null;
    s.game = game;
    s.version = 5;
    return s;
  },
  // v5 → v6: express services and four-track trunks (docs/v2/express-quad.md §8). Defaults only
  // (??=), so it is idempotent:
  // - every route is a local (express false);
  // - the saved day report has no overtakes or cross-platform transfers yet ({}).
  // Quad tags, twins and cross-platform pairs are optional network fields (absent: ordinary track,
  // lone platforms); Network.load drops malformed tags and dangling or one-way references.
  5: (s) => {
    const game = (s.game ?? {}) as Loose;
    const routes = game.routes && typeof game.routes === 'object' ? (game.routes as Loose) : null;
    for (const r of Array.isArray(routes?.routes) ? (routes!.routes as Loose[]) : []) if (r && typeof r === 'object') r.express ??= false;
    const lr = game.lastReport && typeof game.lastReport === 'object' ? (game.lastReport as Loose) : null;
    if (lr) {
      lr.routeOvertakes ??= {};
      lr.crossTransfers ??= {};
    }
    s.game = game;
    s.version = 6;
    return s;
  },
};

/**
 * Debt at the end of a month (key 'YYYY-MM') of a v1–v3 game, rebuilt from its bonds: before v4
 * nothing could repay a bond early, so every bond ever issued is still in the save, on v1's fixed
 * schedule (interest only in its issue month, then level payments at the month ends), replayed
 * with the same arithmetic as the old payment loop. Null when a bond can't be replayed.
 */
function v3DebtAt(bonds: Loose[], key: unknown): number | null {
  const mk = typeof key === 'string' ? /^(\d{4})-(\d{2})$/.exec(key) : null;
  if (!mk) return null;
  const idx = (Number(mk[1]) - 2030) * 12 + Number(mk[2]) - 1;
  let debt = 0;
  for (const b of bonds) {
    const { issuedDay, principal, monthlyPayment } = b;
    const rate = typeof b.rate === 'number' ? b.rate : ECONOMY.bondRate;
    if (![issuedDay, principal, monthlyPayment, rate].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    const n = idx - monthIndex(issuedDay);
    if (n < 0) continue;
    let bal = principal;
    for (let k = 0; k < n && bal > 1; k++) {
      const interest = (bal * rate) / 12;
      const pay = Math.min(monthlyPayment, bal + interest);
      bal = Math.max(0, bal - (pay - interest));
    }
    if (bal > 1) debt += bal;
  }
  return debt;
}

export class SaveError extends Error {}

export function migrate(raw: unknown): SaveFile {
  if (!raw || typeof raw !== 'object') throw new SaveError('Not a save file');
  let s = raw as AnySave;
  if (s.format !== 'headway-ny') throw new SaveError('Not a Headway save');
  let v = Number(s.version ?? 1);
  const from = v;
  if (v > SAVE_VERSION) throw new SaveError(`This save is from a newer version of the game (v${v})`);
  while (v < SAVE_VERSION) {
    const step = STEPS[v];
    if (!step) throw new SaveError(`No migration from save v${v}`);
    s = step(s);
    v = Number(s.version);
  }
  const f = s as unknown as SaveFile;
  if (!f.game?.network || !f.game?.routes || !f.game?.finance) throw new SaveError('Save file is incomplete');
  // The city field arrived with London, without a version bump: missing means New York.
  if (f.city === undefined) f.city = 'nyc';
  if (!isCityId(f.city)) throw new SaveError(`Unknown city "${String(f.city)}"`);
  if (f.meta) f.meta.city = f.city;
  if (from < SAVE_VERSION) f.migratedFrom = from;
  return f;
}
