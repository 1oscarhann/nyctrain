/**
 * Mode choice: generalised cost per mode (minutes) and a multinomial logit split.
 * Money becomes minutes through the value of time of each earnings band, so lower earners
 * are more sensitive to fares and parking.
 */
import { COMMUTERS } from '../balance';

export const MODE_WALK = 0;
export const MODE_DRIVE = 1;
export const MODE_TRANSIT = 2;

/** Money → minutes for an earnings band (0, 1, 2). */
export function moneyToMinutes(dollars: number, band: number): number {
  return (dollars / COMMUTERS.valueOfTime[band]) * 60;
}

export interface PairGeometry {
  /** Straight-line distance between home and work, metres. */
  distance: number;
  /** Either end in the city's congested core regions (Manhattan; inner London). */
  homeCore: boolean;
  workCore: boolean;
  /** Work is in the CBD (Manhattan below 60th St; central London's charging zone). */
  workCbd: boolean;
  homeCbd: boolean;
}

/** Walking time in seconds, or Infinity beyond the walking limit. */
export function walkTime(d: number): number {
  if (d > COMMUTERS.walkMaxDistance) return Infinity;
  return (d * COMMUTERS.walkDetour) / COMMUTERS.walkSpeed;
}

/** One-way drive time in seconds (door to door, including parking) and money cost. */
export function driveTripTime(g: PairGeometry): number {
  const road = g.distance * COMMUTERS.driveDetour;
  const vM = COMMUTERS.driveSpeedCore;
  const vO = COMMUTERS.driveSpeedOther;
  let t: number;
  if (g.homeCore && g.workCore) t = road / vM;
  else if (g.homeCore || g.workCore) t = road * (0.5 / vM + 0.5 / vO);
  else t = road / vO;
  return t + (g.workCbd ? COMMUTERS.parkingCbdTime : COMMUTERS.parkingOtherTime);
}

export function driveMoney(g: PairGeometry): number {
  return (g.distance * COMMUTERS.driveDetour * COMMUTERS.driveCostPerKm) / 1000 + (g.workCbd ? COMMUTERS.parkingCbdCost : 0);
}

export interface TransitCostInput {
  /** Door-to-door seconds (observed yesterday, or scheduled). */
  time: number;
  transfers: number;
  /** Extra minutes of crowding discomfort. */
  crowdMinutes: number;
  fare: number;
}

/** Generalised costs in minutes: [walk, drive, transit] (Infinity = unavailable). */
export function generalisedCosts(g: PairGeometry, band: number, transit: TransitCostInput | null): [number, number, number] {
  const tw = walkTime(g.distance);
  const walk = isFinite(tw) ? tw / 60 + COMMUTERS.modeConstant.walk : Infinity;
  const drive = driveTripTime(g) / 60 + moneyToMinutes(driveMoney(g), band) + COMMUTERS.modeConstant.drive;
  let tr = Infinity;
  if (transit && isFinite(transit.time)) {
    tr =
      transit.time / 60 +
      (transit.transfers * COMMUTERS.transferPenalty) / 60 +
      transit.crowdMinutes +
      moneyToMinutes(transit.fare, band) +
      COMMUTERS.modeConstant.transit;
  }
  return [walk, drive, tr];
}

/** Multinomial logit: P_m = exp(−θ·C_m) / Σ exp(−θ·C_k). */
export function logitShares(costs: readonly number[], theta = COMMUTERS.logitScale): number[] {
  let min = Infinity;
  for (const c of costs) if (c < min) min = c;
  if (!isFinite(min)) return costs.map((_, i) => (i === MODE_DRIVE ? 1 : 0));
  const ex = costs.map((c) => (isFinite(c) ? Math.exp(-theta * (c - min)) : 0));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

/** Move shares part of the way toward a target (daily adaptation). */
export function smoothShares(cur: number[], target: number[], k = COMMUTERS.dailySmoothing): number[] {
  return cur.map((c, i) => c + k * (target[i] - c));
}
