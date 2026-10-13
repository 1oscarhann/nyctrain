/**
 * Save migrations: each step upgrades a save by one version, so any old save can be brought up
 * to date by running the steps in order.
 */
import { BONDS, CHAOS, ECONOMY } from '../balance';
import { isCityId } from '../cities';
import { marketSeedFrom } from '../economy/credit';
import { remainingPayments } from '../economy/finance';
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
    for (const m of Array.isArray(fin.months) ? (fin.months as Loose[]) : []) {
      m.interest ??= (m.revenue ?? 0) - (m.operatingCosts ?? 0) - (m.profit ?? 0);
      m.fees ??= 0;
      m.prepaid ??= 0;
      m.debtEnd ??= null;
    }
    const chaos = (game.chaos ?? {}) as Loose;
    const seed = typeof chaos.seed === 'number' && Number.isFinite(chaos.seed) ? chaos.seed >>> 0 : CHAOS.defaultSeed;
    fin.market ??= { seed: marketSeedFrom(seed), base: BONDS.start, rating: null, score: 0, history: [] };
    game.finance = fin;
    s.game = game;
    s.version = 4;
    return s;
  },
};

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
