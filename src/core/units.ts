/** Display formatting. Internal values are SI; the UI shows miles/mph by default. */
export type UnitSystem = 'imperial' | 'metric';

let unitSystem: UnitSystem = 'imperial';
const listeners = new Set<() => void>();

export function setUnits(u: UnitSystem): void {
  unitSystem = u;
  listeners.forEach((fn) => fn());
}
export function getUnits(): UnitSystem {
  return unitSystem;
}
export function onUnitsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** Long distances: "2.4 mi" / "3.9 km"; short ones in feet / metres. */
export function fmtDistance(m: number, short = false): string {
  if (unitSystem === 'imperial') {
    if (short || m < 400) return `${Math.round(m / M_PER_FT).toLocaleString()} ft`;
    const mi = m / M_PER_MI;
    return `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
  }
  if (short || m < 1000) return `${Math.round(m).toLocaleString()} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
}

export function fmtSpeed(mps: number): string {
  if (unitSystem === 'imperial') return `${Math.round(mps * 2.236936)} mph`;
  return `${Math.round(mps * 3.6)} km/h`;
}

export function fmtPerDistance(dollarsPerM: number): string {
  if (unitSystem === 'imperial') return `${fmtMoney(dollarsPerM * M_PER_MI)}/mi`;
  return `${fmtMoney(dollarsPerM * 1000)}/km`;
}

let CUR = '$';
let SCALE = 1;

/**
 * Currency of the current city (set by cities/applyCity): its symbol and how many of it one unit of
 * game money is. Dollars and pounds are 1; Japan keeps the game's numbers by counting money in
 * hundreds of yen (a metro car is ≈ 2.5M units in every city), so its displays multiply by 100.
 */
export function setCurrency(symbol: string, scale = 1): void {
  CUR = symbol;
  SCALE = scale;
}

export function currency(): string {
  return CUR;
}

/** Display currency per unit of game money (100 in Japan: amounts are kept in hundreds of yen). */
export function currencyScale(): number {
  return SCALE;
}

export function fmtMoney(d: number, opts: { sign?: boolean; precise?: boolean } = {}): string {
  const sign = d < 0 ? '−' : opts.sign ? '+' : '';
  const a = Math.abs(d) * SCALE;
  let s: string;
  if (a >= 1e12) s = `${CUR}${(a / 1e12).toFixed(a >= 1e13 ? 1 : 2)}T`;
  else if (a >= 1e9) s = `${CUR}${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  else if (a >= 1e6) s = `${CUR}${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  else if (a >= 1e4 && !opts.precise) s = `${CUR}${(a / 1e3).toFixed(0)}k`;
  else if (SCALE !== 1) s = `${CUR}${Math.round(a).toLocaleString('en-GB')}`;
  else s = `${CUR}${a.toLocaleString(undefined, { maximumFractionDigits: a < 10 ? 2 : 0, minimumFractionDigits: a < 10 && a % 1 ? 2 : 0 })}`;
  return sign + s;
}

/** A fare-sized amount with pence/cents, e.g. "$3.00", "£2.80"; whole yen ("¥14,700"). */
export function fmtFare(v: number): string {
  if (SCALE !== 1) return `${CUR}${Math.round(v * SCALE).toLocaleString('en-GB')}`;
  return `${CUR}${v.toFixed(2)}`;
}

/** A chart axis amount: "$1.2B", "£40M", "¥3.5T" (compact, no decimals beyond one). */
export function fmtMoneyAxis(v: number, compact: (x: number) => string): string {
  return CUR + compact(v * SCALE);
}

export function fmtCount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return Math.round(n).toLocaleString();
}

export function fmtPct(f: number, digits = 1): string {
  return `${(f * 100).toFixed(digits)}%`;
}

/** Minutes, e.g. "34 min" or "1 h 05 min". */
export function fmtMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function fmtClock(secondsOfDay: number): string {
  const s = ((secondsOfDay % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fmtDensity(perKm2: number): string {
  if (unitSystem === 'imperial') return `${fmtCount(perKm2 * 2.589988)}/mi²`;
  return `${fmtCount(perKm2)}/km²`;
}
