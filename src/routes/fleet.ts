/**
 * Fleet sizing: trains needed = round-trip time ÷ headway, rounded up, plus one spare.
 * Cars are bought when the fleet must grow and never sold — idle trains still cost maintenance.
 * A deleted route's cars go to a spare pool that new or growing routes draw on first.
 */
import { TRAINS } from '../balance';
import type { Game } from '../core/game';
import { routeTimetable, trainsNeeded } from './compile';
import type { Route } from './types';

export interface FleetPlan {
  trainsNeeded: number;
  carsNeeded: number;
  /** Cars taken from deleted routes' spare pool. */
  fromSpare: number;
  carsToBuy: number;
  cost: number;
  runTimes: [number, number] | null;
}

export function fleetPlan(game: Game, r: Route): FleetPlan {
  const tt = routeTimetable(game, r);
  if (!tt) return { trainsNeeded: 0, carsNeeded: 0, fromSpare: 0, carsToBuy: 0, cost: 0, runTimes: null };
  const n = trainsNeeded(r, tt.runTimes);
  const carsNeeded = n * r.cars;
  const fromSpare = Math.min(game.routes.spareCars[r.cls], Math.max(0, carsNeeded - r.ownedCars));
  const carsToBuy = Math.max(0, carsNeeded - r.ownedCars - fromSpare);
  return { trainsNeeded: n, carsNeeded, fromSpare, carsToBuy, cost: carsToBuy * TRAINS[r.cls].costPerCar, runTimes: tt.runTimes };
}

/** Buy whatever the route needs. Returns false (buying nothing) if the money isn't there. */
export function purchaseFleet(game: Game, r: Route): { ok: boolean; cost: number; reason?: string } {
  const plan = fleetPlan(game, r);
  if (plan.carsToBuy + plan.fromSpare === 0) return { ok: true, cost: 0 };
  if (plan.carsToBuy > 0 && !game.finance.spend(plan.cost, 'trains')) return { ok: false, cost: plan.cost, reason: 'Not enough money for the trains' };
  game.routes.spareCars[r.cls] -= plan.fromSpare;
  r.ownedCars += plan.fromSpare + plan.carsToBuy;
  game.routes.invalidate();
  game.events.emit('money', undefined);
  return { ok: true, cost: plan.cost };
}
