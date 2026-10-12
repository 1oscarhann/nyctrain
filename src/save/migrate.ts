/**
 * Save migrations: each step upgrades a save by one version, so any old save can be brought up
 * to date by running the steps in order.
 */
import { CHAOS } from '../balance';
import { isCityId } from '../cities';
import { SAVE_VERSION, type SaveFile } from './format';

type AnySave = Record<string, unknown> & { version?: number };

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
