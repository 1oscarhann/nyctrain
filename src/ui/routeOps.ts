/**
 * One-click route changes (the Routes manager): how often trains come, how long they are and which
 * train type, applied at once with the fleet bought (or freed) to match. A preview prices any change
 * first, so each button can say what it costs.
 */
import { gaugeOf, OPERATIONS, stocksFor, TRAINS, type StockId } from '../balance';
import { fmtMoney } from '../core/units';
import type { Game } from '../core/game';
import { purchaseFleet } from '../routes/fleet';
import { routeTimetable, trainsNeeded } from '../routes/compile';
import { maxCarsFor } from '../routes/routeSet';
import { PERIOD_IDS, type PeriodId, type Route, type RouteControl } from '../routes/types';
import type { App } from './app';

export interface RoutePatch {
  headways?: Partial<Record<PeriodId, number>>;
  cars?: number;
  stock?: StockId;
  /** Operations control (holding, threshold, recovery, timepoints). Recovery can change the trains needed. */
  control?: RouteControl;
}

export interface RoutePreview {
  ok: boolean;
  reason?: string;
  /** Trains the route runs now and after (incl. spares). */
  trainsNow: number;
  trainsAfter: number;
  /** Cars to buy, and their price (0: nothing to buy). */
  carsToBuy: number;
  cost: number;
  /** Cars taken from the spare pool. */
  fromSpare: number;
  /** Cars that would be left idle (sellable in Finances → Fleet). */
  idleAfter: number;
}

/** The route as it would be after the patch (a copy; the real route is untouched). */
export function patched(r: Route, p: RoutePatch): Route {
  const stock = p.stock ?? r.stock;
  const swapped = stock !== r.stock;
  let cars = p.cars ?? r.cars;
  if (swapped) cars = Math.max(TRAINS[stock].minCars, Math.min(TRAINS[stock].maxCars, cars));
  return { ...r, stock, cars, ownedCars: swapped ? 0 : r.ownedCars, headways: { ...r.headways, ...(p.headways ?? {}) }, control: p.control ? structuredClone(p.control) : r.control };
}

/** Run times are the expensive part (a route compile): cached per route shape and train type. */
const runCache = new Map<string, [number, number] | null>();
function runTimes(game: Game, r: Route): [number, number] | null {
  const key = `${game.network.version}|${r.id}|${r.stock}|${r.cars}|${r.stops.join(',')}|${r.express ? 1 : 0}`;
  if (!runCache.has(key)) {
    if (runCache.size > 400) runCache.clear();
    runCache.set(key, routeTimetable(game, r)?.runTimes ?? null);
  }
  return runCache.get(key)!;
}

/** fleetPlan's numbers, with cached run times (fine to call for every button on screen). */
export function quickPlan(game: Game, r: Route): { trainsNeeded: number; carsNeeded: number; fromSpare: number; carsToBuy: number; cost: number; idleCars: number } {
  const rt = runTimes(game, r);
  const n = rt ? trainsNeeded(r, rt) : 0;
  const carsNeeded = n * r.cars;
  const fromSpare = Math.min(game.routes.spareCars[r.stock], Math.max(0, carsNeeded - r.ownedCars));
  const carsToBuy = Math.max(0, carsNeeded - r.ownedCars - fromSpare);
  return { trainsNeeded: n, carsNeeded, fromSpare, carsToBuy, cost: carsToBuy * TRAINS[r.stock].costPerCar, idleCars: Math.max(0, r.ownedCars - carsNeeded) };
}

export function previewRouteChange(game: Game, r: Route, p: RoutePatch): RoutePreview {
  const now = quickPlan(game, r);
  const next = patched(r, p);
  const max = maxCarsFor(game.network, next);
  const base = { trainsNow: now.trainsNeeded, trainsAfter: 0, carsToBuy: 0, cost: 0, fromSpare: 0, idleAfter: 0 };
  if (next.cars < TRAINS[next.stock].minCars) return { ...base, ok: false, reason: `${TRAINS[next.stock].name} trains run with at least ${TRAINS[next.stock].minCars} cars` };
  if (next.cars > max) return { ...base, ok: false, reason: max < TRAINS[next.stock].minCars ? `${TRAINS[next.stock].name} trains don't fit these platforms` : `Platforms take ${max} cars at most — lengthen them in the Station tool` };
  if (PERIOD_IDS.every((k) => !next.headways[k])) return { ...base, ok: false, reason: 'A route needs service in at least one period' };
  // A new train type: the old cars go to the spare pool, so the plan sees them as spares of their type only.
  const plan = quickPlan(game, next);
  return { ok: true, trainsNow: now.trainsNeeded, trainsAfter: plan.trainsNeeded, carsToBuy: plan.carsToBuy, cost: plan.cost, fromSpare: plan.fromSpare, idleAfter: plan.idleCars };
}

/** Apply a change now: buy trains if needed (refusing if the money isn't there). */
export function applyRouteChange(app: App, routeId: number, p: RoutePatch): boolean {
  const game = app.game;
  const r = game.routes.get(routeId);
  if (!r) return false;
  const pv = previewRouteChange(game, r, p);
  if (!pv.ok) {
    app.toast("Can't make that change", pv.reason, 'red');
    return false;
  }
  if (pv.cost > 0 && !game.finance.canAfford(pv.cost)) {
    app.toast("Can't afford the trains", `${fmtMoney(pv.cost)} needed — issue a bond in Finances`, 'red');
    return false;
  }
  const next = patched(r, p);
  const before = { stock: r.stock, cars: r.cars, ownedCars: r.ownedCars, headways: { ...r.headways }, control: structuredClone(r.control) };
  const swapped = next.stock !== r.stock;
  if (swapped) game.routes.spareCars[r.stock] += r.ownedCars;
  game.routes.update(r.id, { stock: next.stock, cars: next.cars, ownedCars: next.ownedCars, headways: next.headways, control: next.control });
  const res = purchaseFleet(game, r);
  if (!res.ok) {
    if (swapped) game.routes.spareCars[before.stock] -= before.ownedCars;
    game.routes.update(r.id, before);
    app.toast("Can't afford the trains", `${fmtMoney(res.cost)} needed`, 'red');
    return false;
  }
  if (res.cost > 0) app.toast(`${r.name}: trains bought`, fmtMoney(res.cost), 'amber');
  game.events.emit('routes', undefined);
  return true;
}

/** Headway choices, shortest first (OPERATIONS.headwayChoices). */
export const HEADWAYS = [...OPERATIONS.headwayChoices].sort((a, b) => a - b);

/** One step more often (−1) or less often (+1) from a headway; 0 = no service. */
export function stepHeadway(cur: number, dir: -1 | 1, allowOff: boolean): number | null {
  if (cur <= 0) return dir < 0 ? HEADWAYS[HEADWAYS.length - 1] : null;
  const i = HEADWAYS.findIndex((v) => v >= cur - 1e-9);
  const at = i < 0 ? HEADWAYS.length - 1 : i;
  if (dir < 0) return at > 0 ? HEADWAYS[at - 1] : null;
  if (at < HEADWAYS.length - 1) return HEADWAYS[at + 1];
  return allowOff ? 0 : null;
}

/** Train types a route can switch to (its track family). */
export function stockChoices(r: Route): StockId[] {
  return stocksFor(gaugeOf(r.cls));
}

/** "every 4 min" / "4–5 min" / "off". */
export function headwayText(...hs: number[]): string {
  const on = hs.filter((v) => v > 0);
  if (!on.length) return 'off';
  const lo = Math.min(...on), hi = Math.max(...on);
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return lo === hi ? `${f(lo)} min` : `${f(lo)}–${f(hi)} min`;
}

/** Trains per hour at a headway. */
export const perHour = (hw: number): number => (hw > 0 ? Math.round(60 / hw) : 0);
