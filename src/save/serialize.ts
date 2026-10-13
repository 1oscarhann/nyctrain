/** Game state ⇄ save file. */
import { CHAOS, type ChaosLevel } from '../balance';
import { city } from '../cities';
import type { ChaosSettings, Game } from '../core/game';
import type { GoalState } from '../core/goals';
import { Finance } from '../economy/finance';
import { normalizeFares } from '../economy/fares';
import type { DayExposure, DayReport, ModeState, ServiceOverride } from '../sim/protocol';
import { b64ToF32, f32ToB64, SAVE_VERSION, type SaveFile, type SaveSettings } from './format';

export function buildSave(
  game: Game,
  extra: { name: string; goals: GoalState; lastReport: DayReport | null; tutorialDone: boolean; settings: SaveSettings; modeState: ModeState | null },
): SaveFile {
  const ms = extra.modeState;
  return {
    format: 'headway-ny',
    version: SAVE_VERSION,
    city: city().id,
    meta: {
      city: city().id,
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
      fares: { ...game.fares },
      network: game.network.toData(),
      routes: game.routes.toData(),
      finance: game.finance.toData(),
      goals: { ...extra.goals },
      lastReport: extra.lastReport ? JSON.parse(JSON.stringify(extra.lastReport)) : null,
      tutorialDone: extra.tutorialDone,
      // Event service that has already ended is not saved.
      chaos: {
        level: game.chaos.level,
        levelToday: game.chaos.levelToday,
        seed: game.chaos.seed,
        service: game.chaos.service.filter((o) => o.to > game.time).map((o) => ({ ...o })),
        nextServiceId: game.chaos.nextServiceId,
        ...(game.chaos.dayExposure ? { dayExposure: JSON.parse(JSON.stringify(game.chaos.dayExposure)) as DayExposure } : {}),
      },
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
  game.fares = normalizeFares(g.fares);
  game.network.load(g.network);
  game.routes.load(g.routes);
  game.finance = Finance.fromData(g.finance);
  game.chaos = sanitizeChaos(g.chaos, g.time, new Set(game.routes.list().map((r) => r.id)));
  const ms = save.modeState;
  return {
    goals: { ...g.goals },
    lastReport: (g.lastReport as DayReport | null) ?? null,
    modeState: ms ? { key: ms.key, shares: b64ToF32(ms.shares), obsTime: b64ToF32(ms.obsTime), obsCrowd: b64ToF32(ms.obsCrowd) } : undefined,
    tutorialDone: g.tutorialDone,
  };
}

/**
 * Chaos settings from a save, made safe: an unknown level becomes Normal (today's level defaults
 * to it), a bad seed the default, malformed or finished event service (or service on a route not
 * in `routeIds`, when given) is dropped, the next id follows the largest one kept, and a malformed
 * plan basis is dropped.
 */
export function sanitizeChaos(raw: unknown, time: number, routeIds?: ReadonlySet<number>): ChaosSettings {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ChaosSettings, unknown>>;
  const isLevel = (x: unknown): x is ChaosLevel => CHAOS.levels.includes(x as ChaosLevel);
  const level: ChaosLevel = isLevel(c.level) ? c.level : 'normal';
  const levelToday: ChaosLevel = isLevel(c.levelToday) ? c.levelToday : level;
  const seedNum = Number(c.seed);
  const seed = typeof c.seed === 'number' && Number.isFinite(seedNum) ? seedNum >>> 0 : CHAOS.defaultSeed;
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const service: ServiceOverride[] = (Array.isArray(c.service) ? c.service : [])
    .filter((o): o is ServiceOverride => !!o && typeof o === 'object' && fin(o.id) && fin(o.routeId) && fin(o.from) && fin(o.to) && fin(o.headwayMin) && o.headwayMin > 0)
    .filter((o) => o.to > time && o.to > o.from && (!routeIds || routeIds.has(o.routeId)))
    .map((o) => ({ id: o.id, routeId: o.routeId, from: o.from, to: o.to, headwayMin: o.headwayMin, eventId: fin(o.eventId) ? o.eventId : 0 }));
  const nextServiceId = service.reduce((m, o) => Math.max(m, o.id + 1), 1);
  const out: ChaosSettings = { level, levelToday, seed, service, nextServiceId };
  const de = c.dayExposure as { day?: unknown; exposure?: Record<string, unknown> } | undefined;
  const ex = de && typeof de === 'object' ? de.exposure : undefined;
  if (
    de && fin(de.day) && ex && typeof ex === 'object' &&
    Array.isArray(ex.trainKmByPeriod) && ex.trainKmByPeriod.every(fin) &&
    fin(ex.trainKm) && fin(ex.trackKm) && fin(ex.stations)
  ) {
    out.dayExposure = { day: de.day, exposure: { trainKmByPeriod: (ex.trainKmByPeriod as number[]).slice(), trainKm: ex.trainKm, trackKm: ex.trackKm, stations: ex.stations } };
  }
  return out;
}
