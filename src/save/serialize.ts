/** Game state ⇄ save file. */
import type { Game } from '../core/game';
import type { GoalState } from '../core/goals';
import { Finance } from '../economy/finance';
import type { DayReport, ModeState } from '../sim/protocol';
import { b64ToF32, f32ToB64, SAVE_VERSION, type SaveFile, type SaveSettings } from './format';

export function buildSave(
  game: Game,
  extra: { name: string; goals: GoalState; lastReport: DayReport | null; tutorialDone: boolean; settings: SaveSettings; modeState: ModeState | null },
): SaveFile {
  const ms = extra.modeState;
  return {
    format: 'headway-ny',
    version: SAVE_VERSION,
    meta: {
      name: extra.name,
      savedAt: new Date().toISOString(),
      day: game.day,
      time: game.time,
      sandbox: game.sandbox,
      cash: game.finance.cash,
      riders: extra.lastReport?.riders ?? 0,
    },
    game: {
      time: game.time,
      sandbox: game.sandbox,
      fare: game.fare,
      network: game.network.toData(),
      routes: game.routes.toData(),
      finance: game.finance.toData(),
      goals: { ...extra.goals },
      lastReport: extra.lastReport ? JSON.parse(JSON.stringify(extra.lastReport)) : null,
      tutorialDone: extra.tutorialDone,
    },
    settings: { ...extra.settings },
    modeState: ms ? { key: ms.key, shares: f32ToB64(ms.shares), obsTime: f32ToB64(ms.obsTime), obsCrowd: f32ToB64(ms.obsCrowd) } : null,
  };
}

/** Load a save into a fresh Game. */
export function applySave(game: Game, save: SaveFile): { goals: GoalState; lastReport: DayReport | null; modeState: ModeState | undefined; tutorialDone: boolean } {
  const g = save.game;
  game.time = g.time;
  game.sandbox = g.sandbox;
  game.fare = g.fare;
  game.network.load(g.network);
  game.routes.load(g.routes);
  game.finance = Finance.fromData(g.finance);
  const ms = save.modeState;
  return {
    goals: { ...g.goals },
    lastReport: (g.lastReport as DayReport | null) ?? null,
    modeState: ms ? { key: ms.key, shares: b64ToF32(ms.shares), obsTime: b64ToF32(ms.obsTime), obsCrowd: b64ToF32(ms.obsCrowd) } : undefined,
    tutorialDone: g.tutorialDone,
  };
}
