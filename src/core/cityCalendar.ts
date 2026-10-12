/**
 * City chaos calendar: special events and weather. Every function here is a pure function of
 * (seed, day, level) and the city's chaos table (balance.ts CHAOS_BY_CITY, the current city's by
 * default), so the main thread and the sim worker compute identical calendars with no history.
 * Each draw uses its own stateless stream Rng(hashSeed(seed, day, index, SALT)).
 */
import { CHAOS, EVENTS, WEATHER, type ChaosLevel, type CityChaos, type EventKindDef, type IncidentKind, type VenueDef, type WeatherKind } from '../balance';
import { cityBalance } from '../cities';
import type { WeatherMods } from '../sim/modeChoice';
import { dateOfDay } from './calendar';
import { toLocal } from './geo';
import { hashSeed, pickWeighted, Rng } from './rng';

export const SALT_EVENT = 0x45564e54;
export const SALT_WEATHER = 0x57544852;
export const SALT_FORECAST = 0x46435354;
export const SALT_INCIDENTS = 0x494e4344;
export const SALT_TRIPS = 0x54524950;

/** Venues per city are limited so event ids (day·16 + venue) stay unique. */
export const MAX_VENUES = 16;

export interface CityEvent {
  /** day·16 + venue index. */
  id: number;
  day: number;
  /** Index into the city's venues. */
  venue: number;
  /** Index into the city's event kinds. */
  kind: number;
  label: string;
  /** Expected people. */
  attendance: number;
  /** Seconds of day. */
  start: number;
  end: number;
  /** First game day on which the event is announced. */
  announced: number;
}

export interface DayWeather {
  kind: WeatherKind;
  /** 0 when clear, else in [WEATHER.minSeverity, 1]. */
  severity: number;
  /** A snow or heat spell carried over from the day before. */
  carried: boolean;
}

export interface Forecast {
  kind: WeatherKind;
  /** Shown as a percentage, in 5% steps. */
  confidence: number;
}

export type RateMods = Record<IncidentKind, number>;

/** Weather effects on the whole sim: mode choice (WeatherMods) plus trains and incidents. */
export interface FullWeatherMods extends WeatherMods {
  /** Speed cap on elevated and at-grade track as a factor of the route's top speed. */
  outdoorSpeed: number;
  /** Dwell time factor. */
  dwell: number;
  /** Crowding discomfort factor. */
  crowd: number;
  /** Incident rate factors. */
  rates: RateMods;
}

export const CLEAR: DayWeather = Object.freeze({ kind: 'clear', severity: 0, carried: false });
export const CLEAR_MODS: FullWeatherMods = Object.freeze({
  walkSpeed: 1,
  walkPenalty: 0,
  driveSpeed: 1,
  outdoorSpeed: 1,
  dwell: 1,
  crowd: 1,
  rates: Object.freeze({ signal: 1, breakdown: 1, sick: 1, police: 1 }),
});

function chaosOf(cc?: CityChaos): CityChaos {
  return cc ?? cityBalance().chaos;
}

const byVenueCache = new WeakMap<CityChaos, EventKindDef[][]>();
function kindsByVenue(cc: CityChaos): EventKindDef[][] {
  let v = byVenueCache.get(cc);
  if (!v) {
    v = cc.venues.map((ven) => cc.kinds.filter((k) => k.venue === ven.key));
    byVenueCache.set(cc, v);
  }
  return v;
}

function inSeason(k: EventKindDef, month: number, dom: number, dow: number): boolean {
  if (!k.months.includes(month)) return false;
  if (k.weekdays && !k.weekdays.includes(dow)) return false;
  if (k.window) {
    const [m0, d0, m1, d1] = k.window;
    const x = month * 100 + dom;
    if (x < m0 * 100 + d0 || x > m1 * 100 + d1) return false;
  }
  return true;
}

/**
 * The day's special events: at most one per venue, decided by a single draw per venue-day, so a
 * lower level's events are always a subset (by id) of Wild's.
 */
export function eventsForDay(seed: number, day: number, level: ChaosLevel, cc?: CityChaos): CityEvent[] {
  if (level === 'off' || day < 0) return [];
  const c = chaosOf(cc);
  const date = dateOfDay(day);
  const m = date.getUTCMonth(), dom = date.getUTCDate(), dow = date.getUTCDay();
  const byVenue = kindsByVenue(c);
  const mult = CHAOS.eventChance[level];
  const out: CityEvent[] = [];
  c.venues.forEach((_, vi) => {
    const kinds = byVenue[vi].filter((k) => inSeason(k, m, dom, dow));
    if (!kinds.length) return;
    const rng = new Rng(hashSeed(seed, day, vi, SALT_EVENT));
    const u = rng.next();
    let acc = 0;
    for (const k of kinds) {
      acc += k.chance * mult;
      if (u >= acc) continue;
      const attendance = Math.round((k.attendance[0] + (k.attendance[1] - k.attendance[0]) * rng.next()) / 100) * 100;
      const start = Math.round(pickWeighted(k.starts, rng.next()) * 3600);
      out.push({
        id: day * MAX_VENUES + vi,
        day,
        venue: vi,
        kind: c.kinds.indexOf(k),
        label: k.label,
        attendance,
        start,
        end: start + k.duration,
        announced: day - (k.announce ?? EVENTS.announceDays),
      });
      break;
    }
  });
  return out;
}

/** Longest notice of any event kind in the city (days). */
export function maxAnnounceDays(cc?: CityChaos): number {
  let n = EVENTS.announceDays;
  for (const k of chaosOf(cc).kinds) n = Math.max(n, k.announce ?? 0);
  return n;
}

/** Events known on `today`: today's and the announced ones in the next few days, by day then id. */
export function announcedEvents(seed: number, today: number, level: ChaosLevel, cc?: CityChaos): CityEvent[] {
  const out: CityEvent[] = [];
  const n = maxAnnounceDays(cc);
  for (let d = today; d <= today + n; d++) for (const ev of eventsForDay(seed, d, level, cc)) if (ev.announced <= today) out.push(ev);
  return out;
}

export function venueOf(ev: CityEvent, cc?: CityChaos): VenueDef {
  return chaosOf(cc).venues[ev.venue];
}

export function eventKind(ev: CityEvent, cc?: CityChaos): EventKindDef {
  return chaosOf(cc).kinds[ev.kind];
}

/** Venue position in local metres. */
export function venueXY(ev: CityEvent, cc?: CityChaos): [number, number] {
  const v = venueOf(ev, cc);
  return toLocal(v.lon, v.lat);
}

// ---------------------------------------------------------------------------
// Weather

/** The month's snow, rain and heat chances at a level, scaled down so they sum to at most the cap. */
export function weatherChances(level: ChaosLevel, month: number, cc?: CityChaos): [number, number, number] {
  const cl = chaosOf(cc).climate;
  const k = CHAOS.weatherChance[level];
  let s = cl.snow[month] * k, r = cl.rain[month] * k, h = cl.heat[month] * k;
  const sum = s + r + h;
  if (sum > CHAOS.weatherChanceMax) {
    const f = CHAOS.weatherChanceMax / sum;
    s *= f;
    r *= f;
    h *= f;
  }
  return [s, r, h];
}

function baseDraw(seed: number, day: number, level: ChaosLevel, cc: CityChaos): { kind: WeatherKind; severity: number; persist: number } {
  const m = dateOfDay(day).getUTCMonth();
  const rng = new Rng(hashSeed(seed, day, 0, SALT_WEATHER));
  const u = rng.next();
  const [s, r, h] = weatherChances(level, m, cc);
  const kind: WeatherKind = u < s ? 'snow' : u < s + r ? 'rain' : u < s + r + h ? 'heat' : 'clear';
  return { kind, severity: WEATHER.minSeverity + (1 - WEATHER.minSeverity) * rng.next(), persist: rng.next() };
}

/**
 * The day's weather. Days are drawn independently; a clear-drawn day after a snow or heat day
 * carries the spell on (weaker) with WEATHER.persist chance. The one-step lookback keeps it pure.
 */
export function weatherForDay(seed: number, day: number, level: ChaosLevel, cc?: CityChaos): DayWeather {
  if (level === 'off' || day < 0) return { ...CLEAR };
  const c = chaosOf(cc);
  const t = baseDraw(seed, day, level, c);
  if (t.kind === 'clear' && day > 0) {
    const y = baseDraw(seed, day - 1, level, c);
    const m = dateOfDay(day).getUTCMonth();
    if ((y.kind === 'snow' || y.kind === 'heat') && c.climate[y.kind][m] > 0 && t.persist < WEATHER.persist)
      return { kind: y.kind, severity: y.severity * WEATHER.carrySeverity, carried: true };
  }
  return { kind: t.kind, severity: t.kind === 'clear' ? 0 : t.severity, carried: false };
}

const round05 = (x: number) => Math.round(x * 20) / 20;

/** The forecast for `day` (shown during day − 1): right WEATHER.forecastAccuracy of the time. */
export function forecastFor(seed: number, day: number, level: ChaosLevel, cc?: CityChaos): Forecast {
  if (level === 'off') return { kind: 'clear', confidence: 1 };
  const c = chaosOf(cc);
  const actual = weatherForDay(seed, day, level, c);
  const rng = new Rng(hashSeed(seed, day, 1, SALT_FORECAST));
  if (rng.next() < WEATHER.forecastAccuracy) return { kind: actual.kind, confidence: round05(0.7 + 0.25 * rng.next()) };
  const m = dateOfDay(day).getUTCMonth();
  const miss: WeatherKind = actual.kind !== 'clear' ? 'clear' : c.climate.snow[m] > 0 ? 'snow' : c.climate.heat[m] > 0 ? 'heat' : 'rain';
  return { kind: miss, confidence: round05(0.5 + 0.2 * rng.next()) };
}

/** Effects of the weather, linear in severity; exactly CLEAR_MODS when clear. */
export function weatherMods(w: DayWeather): FullWeatherMods {
  if (w.kind === 'clear' || !(w.severity > 0)) return CLEAR_MODS;
  const e = WEATHER.effects[w.kind];
  const s = w.severity;
  const f = (x: number) => 1 - s * (1 - x);
  return {
    walkSpeed: f(e.walkSpeed),
    walkPenalty: s * e.walkPenalty,
    driveSpeed: f(e.driveSpeed),
    outdoorSpeed: f(e.outdoorSpeed),
    dwell: f(e.dwell),
    crowd: f(e.crowd),
    rates: { signal: f(e.rates.signal), breakdown: f(e.rates.breakdown), sick: f(e.rates.sick), police: f(e.rates.police) },
  };
}

export function weatherLabel(w: DayWeather): string {
  const heavy = w.severity >= WEATHER.heavyAt;
  switch (w.kind) {
    case 'clear':
      return 'Clear';
    case 'rain':
      return heavy ? 'Heavy rain' : 'Rain';
    case 'snow':
      return heavy ? 'Heavy snow' : 'Snow';
    case 'heat':
      return heavy ? 'Heat wave' : 'Hot';
  }
}
