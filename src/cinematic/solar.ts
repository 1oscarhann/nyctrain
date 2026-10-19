/**
 * Where the sun is (docs/v2/cinematic.md §3): altitude and azimuth from the NOAA solar
 * calculator's equations (Meeus; about a minute of accuracy), sunrise, sunset and civil twilight,
 * and the US and EU daylight-saving rules. The game clock is the city's local civil time.
 * Pure: no Date.now, no randomness.
 */
import { cityBalance, city } from '../cities';
import { dateOfDay } from '../core/calendar';

export type DstRule = 'us' | 'eu' | 'none';

export interface TimeZone {
  /** Standard time offset from UTC, hours (New York −5, London 0). */
  utcOffset: number;
  dst: DstRule;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Day of the month of the n-th (1-based) Sunday of a month; n = -1: the last Sunday. */
function nthSunday(year: number, month: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  }
  const len = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, len)).getUTCDay();
  return len - last;
}

/**
 * UTC offset (hours) in force at local civil time `todSec` on a local date. US: from 02:00 local
 * standard time on the second Sunday of March to 02:00 local daylight time on the first Sunday of
 * November. EU: from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of
 * October.
 */
export function utcOffsetAt(tz: TimeZone, year: number, month: number, day: number, todSec: number): number {
  if (tz.dst === 'none') return tz.utcOffset;
  // Local civil time as a UTC-based timestamp, compared with the switch moments in the same frame.
  const local = Date.UTC(year, month, day) + todSec * 1000;
  let start: number, end: number;
  if (tz.dst === 'us') {
    start = Date.UTC(year, 2, nthSunday(year, 2, 2), 2); // 02:00 standard
    end = Date.UTC(year, 10, nthSunday(year, 10, 1), 1); // 02:00 daylight = 01:00 standard
  } else {
    start = Date.UTC(year, 2, nthSunday(year, 2, -1), 1) + tz.utcOffset * 3_600_000;
    end = Date.UTC(year, 9, nthSunday(year, 9, -1), 1) + tz.utcOffset * 3_600_000;
  }
  // `end` is in local standard time; daylight clocks read an hour more (the repeated hour counts as daylight).
  const inDst = local >= start && local - 3_600_000 < end;
  return tz.utcOffset + (inDst ? 1 : 0);
}

/** UTC milliseconds of local civil time `todSec` on a local calendar date. */
export function localToUtcMs(tz: TimeZone, year: number, month: number, day: number, todSec: number): number {
  return Date.UTC(year, month, day) + todSec * 1000 - utcOffsetAt(tz, year, month, day, todSec) * 3_600_000;
}

interface SolarTerms {
  /** Declination, radians. */
  decl: number;
  /** Equation of time, minutes. */
  eqTime: number;
}

/** Declination and equation of time at a UTC instant (NOAA spreadsheet equations). */
export function solarTerms(utcMs: number): SolarTerms {
  const jd = utcMs / 86_400_000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  return { decl, eqTime };
}

export interface SunPosition {
  /** Degrees above the horizon (negative below), without refraction. */
  altitude: number;
  /** Degrees clockwise from north. */
  azimuth: number;
  /** True solar time is before noon. */
  morning: boolean;
}

/** The sun at a UTC instant seen from (lat, lon) in degrees. */
export function sunPosition(utcMs: number, lat: number, lon: number): SunPosition {
  const { decl, eqTime } = solarTerms(utcMs);
  const utcMin = (((utcMs / 60_000) % 1440) + 1440) % 1440;
  const tst = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZ = Math.max(-1, Math.min(1, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)));
  const zen = Math.acos(cosZ);
  const az = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) * DEG + 180 + 360) % 360;
  return { altitude: 90 - zen * DEG, azimuth: az, morning: tst < 720 };
}

export interface SunTimes {
  /** Local civil clock, seconds after midnight; NaN when the sun never crosses that altitude. */
  dawn: number;
  sunrise: number;
  noon: number;
  sunset: number;
  dusk: number;
}

/**
 * Civil dawn (−6°), sunrise (−0.833°: refraction and the sun's radius), solar noon, sunset and
 * civil dusk on a local calendar date, in local civil seconds (daylight saving included).
 */
export function sunTimes(tz: TimeZone, year: number, month: number, day: number, lat: number, lon: number): SunTimes {
  const phi = lat * RAD;
  const at = (zenithDeg: number, sign: number): number => {
    // Two passes: the terms at local noon, then at the first estimate.
    let utcMin = 720 - 4 * lon;
    for (let pass = 0; pass < 2; pass++) {
      const t = solarTerms(Date.UTC(year, month, day) + utcMin * 60_000);
      const noon = 720 - 4 * lon - t.eqTime;
      if (sign === 0) {
        utcMin = noon;
        continue;
      }
      const c = Math.cos(zenithDeg * RAD) / (Math.cos(phi) * Math.cos(t.decl)) - Math.tan(phi) * Math.tan(t.decl);
      if (c < -1 || c > 1) return NaN;
      utcMin = noon + sign * 4 * Math.acos(c) * DEG;
    }
    // UTC minutes of the date → local civil seconds (the offset in force at that local time).
    const off = utcOffsetAt(tz, year, month, day, utcMin * 60 + tz.utcOffset * 3600);
    return utcMin * 60 + off * 3600;
  };
  return { dawn: at(96, -1), sunrise: at(90.833, -1), noon: at(90, 0), sunset: at(90.833, 1), dusk: at(96, 1) };
}

/** The current city's position (its projection origin) and time zone. */
export function citySolar(): { lat: number; lon: number; tz: TimeZone } {
  const [lon, lat] = cityBalance().origin;
  return { lat, lon, tz: city().timeZone };
}

/** The sun over the current city at game day `day`, local clock `todSec`. */
export function gameSun(day: number, todSec: number): SunPosition {
  const d = dateOfDay(day);
  const { lat, lon, tz } = citySolar();
  return sunPosition(localToUtcMs(tz, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), todSec), lat, lon);
}

/** Sunrise, sunset and twilight over the current city on game day `day`. */
export function gameSunTimes(day: number): SunTimes {
  const d = dateOfDay(day);
  const { lat, lon, tz } = citySolar();
  return sunTimes(tz, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), lat, lon);
}
