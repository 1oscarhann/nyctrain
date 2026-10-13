/**
 * Fleet sizing: trains needed = round-trip time (with recovery) ÷ headway, rounded up, plus one
 * spare. Cars are bought when the fleet must grow. A deleted route's cars go to a spare pool that
 * new or growing routes draw on first. Idle cars (beyond a route's plan) and spare cars can be sold
 * for FLEET.resaleFraction of their new price (v2); they leave the maintenance base.
 */
import { FLEET, TRAINS, type TrackClass } from '../balance';
import type { Game } from '../core/game';
import { recoveryPerTerminal, roundTripTime, routeTimetable, trainsNeeded } from './compile';
import type { Route } from './types';

export interface FleetPlan {
  trainsNeeded: number;
  carsNeeded: number;
  /** Cars taken from deleted routes' spare pool. */
  fromSpare: number;
  carsToBuy: number;
  cost: number;
  runTimes: [number, number] | null;
  /** Scheduled round trip including recovery and turnarounds, s (0 with no path). */
  roundTrip: number;
  /** Recovery time at each terminal, s. */
  recovery: number;
  /** Cars owned beyond the plan (sellable). */
  idleCars: number;
}

export function fleetPlan(game: Game, r: Route): FleetPlan {
  const tt = routeTimetable(game, r);
  if (!tt) return { trainsNeeded: 0, carsNeeded: 0, fromSpare: 0, carsToBuy: 0, cost: 0, runTimes: null, roundTrip: 0, recovery: 0, idleCars: 0 };
  const n = trainsNeeded(r, tt.runTimes);
  const carsNeeded = n * r.cars;
  const fromSpare = Math.min(game.routes.spareCars[r.cls], Math.max(0, carsNeeded - r.ownedCars));
  const carsToBuy = Math.max(0, carsNeeded - r.ownedCars - fromSpare);
  return {
    trainsNeeded: n,
    carsNeeded,
    fromSpare,
    carsToBuy,
    cost: carsToBuy * TRAINS[r.cls].costPerCar,
    runTimes: tt.runTimes,
    roundTrip: roundTripTime(r, tt.runTimes),
    recovery: recoveryPerTerminal(r, tt.runTimes),
    idleCars: Math.max(0, r.ownedCars - carsNeeded),
  };
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

// ---------------------------------------------------------------------------- car sales (v2)

/** What `cars` used cars of a class sell for. */
export const carSaleValue = (cls: TrackClass, cars: number): number => cars * TRAINS[cls].costPerCar * FLEET.resaleFraction;

/** Cars a route owns beyond what its plan needs (0 for a route without a path). */
export function idleCars(game: Game, r: Route): number {
  return fleetPlan(game, r).idleCars;
}

export interface CarSale {
  ok: boolean;
  cars: number;
  proceeds: number;
  reason?: string;
}

/**
 * Sell a route's idle cars for FLEET.resaleFraction of their new price. Their full cost leaves the
 * asset (maintenance) base; proceeds are booked as refunds. The fleet shrinks on the next compile
 * (waiting trains go first).
 */
export function sellIdleCars(game: Game, r: Route): CarSale {
  const n = idleCars(game, r);
  if (!n) return { ok: false, cars: 0, proceeds: 0, reason: 'No idle cars' };
  const proceeds = game.finance.refund(n * TRAINS[r.cls].costPerCar, FLEET.resaleFraction);
  r.ownedCars -= n;
  game.routes.invalidate();
  game.events.emit('routes', undefined);
  game.events.emit('money', undefined);
  return { ok: true, cars: n, proceeds };
}

/** Sell cars from the spare pool (all of them by default). */
export function sellSpareCars(game: Game, cls: TrackClass, n = game.routes.spareCars[cls]): CarSale {
  const k = Math.max(0, Math.min(Math.floor(n), game.routes.spareCars[cls]));
  if (!k) return { ok: false, cars: 0, proceeds: 0, reason: 'No spare cars' };
  const proceeds = game.finance.refund(k * TRAINS[cls].costPerCar, FLEET.resaleFraction);
  game.routes.spareCars[cls] -= k;
  game.events.emit('money', undefined);
  return { ok: true, cars: k, proceeds };
}
