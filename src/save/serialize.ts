/** Game state ⇄ save file. */
import { CHAOS, GROWTH, type ChaosLevel, type GrowthPace } from '../balance';
import { city } from '../cities';
import type { ChaosSettings, Game } from '../core/game';
import type { GoalState } from '../core/goals';
import { Finance } from '../economy/finance';
import { normalizeFares } from '../economy/fares';
import type { DayExposure, DayReport, GrowthData, ModeState, ServiceOverride } from '../sim/protocol';
import { b64ToF32, b64ToU16, bytesToB64, f32ToB64, SAVE_VERSION, type SavedGrowth, type SaveFile, type SaveSettings } from './format';

/** Living City state for a save (typed arrays as base64). */
export function encodeGrowth(d: GrowthData): SavedGrowth {
  return {
    version: 1,
    appliedThroughDay: d.appliedThroughDay,
    months: d.months,
    sbar: [d.sbar[0], d.sbar[1]],
    mRes: f32ToB64(d.mRes),
    mJobs: f32ToB64(d.mJobs),
    fHome: f32ToB64(d.fHome),
    fWork: f32ToB64(d.fWork),
    premium: f32ToB64(d.premium),
    history: d.history.map((h) => ({ day: h.day, q: bytesToB64(h.q) })),
    city: d.city.map((c) => [c.day, c.residents, c.jobs, c.valueCapture]),
  };
}

/**
 * Growth state from a save. Never throws: a malformed field decodes to an empty array, which the
 * worker's length check against the city's tracts (Growth.fromData) then rejects, starting the
 * city over with the "City growth was reset" toast.
 */
export function decodeGrowth(s: SavedGrowth): GrowthData {
  const f32 = (x: unknown) => {
    try {
      return typeof x === 'string' ? b64ToF32(x) : new Float32Array(0);
    } catch {
      return new Float32Array(0);
    }
  };
  const u16 = (x: unknown) => {
    try {
      return typeof x === 'string' ? b64ToU16(x) : new Uint16Array(0);
    } catch {
      return new Uint16Array(0);
    }
  };
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    version: 1,
    appliedThroughDay: num(s.appliedThroughDay, -1),
    months: num(s.months, 0),
    sbar: [num(s.sbar?.[0], 0), num(s.sbar?.[1], 0)],
    mRes: f32(s.mRes),
    mJobs: f32(s.mJobs),
    fHome: f32(s.fHome),
    fWork: f32(s.fWork),
    premium: f32(s.premium),
    history: (Array.isArray(s.history) ? s.history : []).map((h) => ({ day: num(h?.day, 0), q: u16(h?.q) })),
    city: (Array.isArray(s.city) ? s.city : []).filter(Array.isArray).map((c) => ({ day: num(c[0], 0), residents: num(c[1], 0), jobs: num(c[2], 0), valueCapture: num(c[3], 0) })),
  };
}

export function isGrowthPace(x: unknown): x is GrowthPace {
  return GROWTH.paces.includes(x as GrowthPace);
}

export function buildSave(
  game: Game,
  extra: { name: string; goals: GoalState; lastReport: DayReport | null; tutorialDone: boolean; settings: SaveSettings; modeState: ModeState | null; growth?: GrowthData | null },
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
      growthPace: game.growthPace,
    },
    settings: { ...extra.settings },
    modeState: ms ? { key: ms.key, shares: f32ToB64(ms.shares), obsTime: f32ToB64(ms.obsTime), obsCrowd: f32ToB64(ms.obsCrowd) } : null,
    growth: extra.growth ? encodeGrowth(extra.growth) : null,
  };
}

/** Load a save into a fresh Game. */
export function applySave(game: Game, save: SaveFile): { goals: GoalState; lastReport: DayReport | null; modeState: ModeState | undefined; growth: GrowthData | null; tutorialDone: boolean } {
  const g = save.game;
  game.time = g.time;
  game.sandbox = g.sandbox;
  game.growthPace = isGrowthPace(g.growthPace) ? g.growthPace : 'steady';
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
    growth: save.growth && typeof save.growth === 'object' ? decodeGrowth(save.growth) : null,
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
