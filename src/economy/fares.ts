/**
 * Fare policy (v2): a peak and an off-peak fare, and a low-income multiplier for the lowest
 * earnings band. Pure: used by mode choice and billing in the worker, and by the UI.
 *
 * Fares are billed once per linked journey, at its first boarding, at the fare for the rider's band
 * and the period of that boarding (transfers are free). Mode choice sees a per-group expected fare
 * (the share of the group's trips that start in a peak), plus a per-agent odds adjustment for agents
 * who travel off-peak (commuters.ts). A flat policy (peak = off-peak) is exactly v1's single fare.
 */
import { ECONOMY, FARES, OPERATIONS } from '../balance';
import { cityBalance } from '../cities';
import { fmtFare } from '../core/units';

export interface FarePolicy {
  /** Fare in FARES.peakPeriods (6–10 am, 4–8 pm). */
  peak: number;
  /** Fare at other times (never above the peak fare). */
  offPeak: number;
  /** Multiplier for earnings band FARES.lowIncomeBand: one of FARES.lowIncomeChoices (1 full, 0.5 half, 0 free). */
  lowIncome: number;
}

/** Distance fares (ECONOMY.fareDistanceKm): the multiplier on the fare for a home–work distance in metres (1 in the metro cities). */
export function distanceFareMult(distanceM: number): number {
  if (!isFinite(ECONOMY.fareDistanceKm)) return 1;
  return 1 + Math.max(0, distanceM / 1000 - ECONOMY.fareFreeKm) / ECONOMY.fareDistanceKm;
}

/** One fare all day for everyone (v1's policy). */
export function flatFares(f: number): FarePolicy {
  return { peak: f, offPeak: f, lowIncome: 1 };
}

/** The current city's policy for a new game (CITY_BALANCE[city].fares). */
export function defaultFares(): FarePolicy {
  return { ...cityBalance().fares };
}

/** Round to the city's fare step (and to cents, so 0.1 steps don't carry float noise). */
function snapFare(x: number, fallback: number): number {
  const v = Number.isFinite(x) ? x : fallback;
  const c = Math.max(ECONOMY.fareMin, Math.min(ECONOMY.fareMax, v));
  const s = Math.round(c / ECONOMY.fareStep) * ECONOMY.fareStep;
  return Math.round(Math.max(ECONOMY.fareMin, Math.min(ECONOMY.fareMax, s)) * 100) / 100;
}

/**
 * A valid policy: fares clamped to [fareMin, fareMax] and snapped to the city's step, off-peak at
 * most the peak fare, and lowIncome snapped to the nearest of FARES.lowIncomeChoices. Missing
 * fields fall back to `fallback` (a flat fare) and full fare.
 */
export function normalizeFares(p: Partial<FarePolicy> | undefined | null, fallback = ECONOMY.fareDefault): FarePolicy {
  const peak = snapFare(Number(p?.peak), fallback);
  const offPeak = Math.min(peak, snapFare(Number(p?.offPeak ?? peak), peak));
  const li = Number(p?.lowIncome);
  const lowIncome = Number.isFinite(li) ? FARES.lowIncomeChoices.reduce((best, c) => (Math.abs(c - li) < Math.abs(best - li) ? c : best), FARES.lowIncomeChoices[0]) : 1;
  return { peak, offPeak, lowIncome };
}

/** Same fare at every time and for every band. */
export function isFlat(p: FarePolicy): boolean {
  return p.peak === p.offPeak && p.lowIncome === 1;
}

/** The fare varies by time of day (the per-agent odds adjustment applies). */
export function variesByTime(p: FarePolicy): boolean {
  return p.peak !== p.offPeak;
}

const PEAK_HOURS: boolean[] = Array.from({ length: 24 }, (_, h) => {
  const per = OPERATIONS.periods.find((x) => h >= x.start && h < x.end);
  return !!per && FARES.peakPeriods.includes(per.id);
});

/** Is a time of day (seconds since midnight, any day offset ignored) in a peak period? */
export function isPeakTod(secondsOfDay: number): boolean {
  const h = Math.floor((secondsOfDay - Math.floor(secondsOfDay / 86400) * 86400) / 3600);
  return PEAK_HOURS[h < 0 ? 0 : h > 23 ? 23 : h];
}

/** Is a game time in a peak period? (Called on every boarding: kept cheap.) */
export function isPeakTime(t: number): boolean {
  return isPeakTod(t);
}

export function bandFactor(p: FarePolicy, band: number): number {
  return band === FARES.lowIncomeBand ? p.lowIncome : 1;
}

/** The fare a rider of this band pays at a boarding in (or out of) the peak. */
export function fareAt(p: FarePolicy, band: number, peak: boolean): number {
  return bandFactor(p, band) * (peak ? p.peak : p.offPeak);
}

/** Mean of a commuter's two one-way fares when `peakTrips` (0, 1 or 2) of them are in a peak. */
export function tripFare(p: FarePolicy, band: number, peakTrips: number): number {
  if (p.peak === p.offPeak) return bandFactor(p, band) * p.peak;
  return bandFactor(p, band) * ((peakTrips * p.peak + (2 - peakTrips) * p.offPeak) / 2);
}

/** Expected one-way fare for a band when a share `peakFrac` of trips start in a peak (exactly the fare when flat). */
export function expectedFare(p: FarePolicy, band: number, peakFrac: number): number {
  if (p.peak === p.offPeak) return bandFactor(p, band) * p.peak;
  return bandFactor(p, band) * (peakFrac * p.peak + (1 - peakFrac) * p.offPeak);
}

const LOW_LABEL: Record<string, string> = { '1': 'full', '0.5': 'half', '0': 'free' };

/** "$3.00" · "$3.50 peak / $2.50 off-peak" · "… · low-income half" (in the current city's currency). */
export function fareSummary(p: FarePolicy): string {
  const base = p.peak === p.offPeak ? fmtFare(p.peak) : `${fmtFare(p.peak)} peak / ${fmtFare(p.offPeak)} off-peak`;
  return p.lowIncome === 1 ? base : `${base} · low-income ${LOW_LABEL[String(p.lowIncome)] ?? `×${p.lowIncome}`}`;
}

/** Fare breakdown index for a band and period (DayReport.fares): band × 2 + (peak ? 1 : 0). */
export function fareCell(band: number, peak: boolean): number {
  return band * 2 + (peak ? 1 : 0);
}
