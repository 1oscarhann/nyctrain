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

/**
 * Today's weather as mode choice sees it (city chaos). Every factor is exactly 1 and the
 * penalty exactly 0 on a clear day, so the arithmetic is unchanged from v1.
 */
export interface WeatherMods {
  /** Walking speed factor (walks take 1/walkSpeed as long). */
  walkSpeed: number;
  /** Minutes added to the walk mode's generalised cost. */
  walkPenalty: number;
  /** Road speed factor (parking time is not scaled). */
  driveSpeed: number;
}

export const CLEAR_WX: WeatherMods = { walkSpeed: 1, walkPenalty: 0, driveSpeed: 1 };

/** Walking time in seconds, or Infinity beyond the walking limit. */
export function walkTime(d: number, wx?: WeatherMods): number {
  if (d > COMMUTERS.walkMaxDistance) return Infinity;
  return (d * COMMUTERS.walkDetour) / (COMMUTERS.walkSpeed * (wx?.walkSpeed ?? 1));
}

/** One-way drive time in seconds (door to door, including parking) and money cost. */
export function driveTripTime(g: PairGeometry, wx?: WeatherMods): number {
  const road = g.distance * COMMUTERS.driveDetour;
  const f = wx?.driveSpeed ?? 1;
  const vM = COMMUTERS.driveSpeedCore * f;
  const vO = COMMUTERS.driveSpeedOther * f;
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

/** Generalised costs in minutes: [walk, drive, transit] (Infinity = unavailable). Weather (wx) slows walking and driving. */
export function generalisedCosts(g: PairGeometry, band: number, transit: TransitCostInput | null, wx?: WeatherMods): [number, number, number] {
  const tw = walkTime(g.distance, wx);
  const walk = isFinite(tw) ? tw / 60 + COMMUTERS.modeConstant.walk + (wx?.walkPenalty ?? 0) : Infinity;
  const drive = driveTripTime(g, wx) / 60 + moneyToMinutes(driveMoney(g), band) + COMMUTERS.modeConstant.drive;
  const tr = transit && isFinite(transit.time) ? transitCost(transit, band) : Infinity;
  return [walk, drive, tr];
}

/**
 * Generalised cost of the transit alternative in minutes: door-to-door time, transfer penalties,
 * crowding, the fare at the band's value of time and the mode constant (weather never enters it).
 */
export function transitCost(t: TransitCostInput, band: number): number {
  return t.time / 60 + (t.transfers * COMMUTERS.transferPenalty) / 60 + t.crowdMinutes + moneyToMinutes(t.fare, band) + COMMUTERS.modeConstant.transit;
}

/**
 * Logit logsum (expected minimum cost, minutes): −(1/θ)·ln Σ exp(−θ·C), computed as
 * min − ln Σ exp(−θ(C − min)) / θ. Infinity when every alternative is unavailable.
 */
export function logsum(costs: readonly number[], theta = COMMUTERS.logitScale): number {
  let min = Infinity;
  for (const c of costs) if (c < min) min = c;
  if (!isFinite(min)) return Infinity;
  let sum = 0;
  for (const c of costs) if (isFinite(c)) sum += Math.exp(-theta * (c - min));
  return min - Math.log(sum) / theta;
}

/**
 * Living City commute benefit (consumer surplus of the network, minutes per commute): the logsum
 * without transit minus the logsum with it, (1/θ)·ln(1 + exp(θ·(lsNoTransit − transitCostMin))).
 * Always ≥ 0; 0 when transit is unavailable; ≈ lsNoTransit − transitCostMin when transit dominates.
 */
export function transitBenefit(lsNoTransit: number, transitCostMin: number, theta = COMMUTERS.logitScale): number {
  if (!isFinite(transitCostMin)) return 0;
  if (!isFinite(lsNoTransit)) return Infinity;
  const x = theta * (lsNoTransit - transitCostMin);
  return x > 30 ? x / theta : Math.log1p(Math.exp(x)) / theta;
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

/**
 * Odds multiplier on the transit alternative when one agent's fare differs from the group's by
 * dFare: exp(−θ · minutes(dFare)), the exact logit result of shifting one alternative's utility
 * (fare policy v2: off-peak travellers in a group whose expected fare is mostly peak).
 */
export function fareOddsMultiplier(dFare: number, band: number, theta = COMMUTERS.logitScale): number {
  return Math.exp(-theta * moneyToMinutes(dFare, band));
}
