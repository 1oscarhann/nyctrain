/**
 * Cinematic copy (docs/v2/cinematic.md), pure so it is tested in both cities: the follow-cam's
 * status line, the photo caption and the timelapse's counters. Units, currency-free.
 */
import { fmtDate } from '../core/calendar';
import { weatherLabel } from '../core/cityCalendar';
import { fmtClock, fmtCount, fmtDistance } from '../core/units';
import type { DayWeather } from '../core/cityCalendar';

export type Tone = 'green' | 'amber' | 'red' | null;

export interface FollowTrainInfo {
  /** Snapshot state: 2 dwelling, SNAP_HELD (4) held at a timepoint. */
  held: boolean;
  dwelling: boolean;
  next: string;
  terminal: string;
  /** People on board (scaled). */
  people: number;
  /** An incident on this train (breakdown or sick passenger), its place and expected end (game s). */
  incident?: { kind: 'breakdown' | 'sick'; place: string; until: number } | null;
  /** The next stop is closed (police activity): trains run through. */
  nextClosed?: boolean;
  /** Game time now (minutes left on a hold). */
  now: number;
}

/** "Towards 125 St · next 96 St · 1,240 on board", with the incident or the hold first. */
export function followStatus(t: FollowTrainInfo): { text: string; tone: Tone } {
  const ride = `Towards ${t.terminal} · ${fmtCount(t.people)} on board`;
  if (t.incident?.kind === 'breakdown') return { text: `Stalled: mechanical problem, moving again ~${fmtClock(t.incident.until)} · ${ride}`, tone: 'red' };
  if (t.incident?.kind === 'sick') return { text: `Held at ${t.incident.place}: sick passenger, ~${Math.max(1, Math.round((t.incident.until - t.now) / 60))} min · ${ride}`, tone: 'amber' };
  if (t.held) return { text: `Held at ${t.next} for an even gap · ${ride}`, tone: 'amber' };
  if (t.nextClosed) return { text: `${t.next} is closed: running through · ${ride}`, tone: 'red' };
  return { text: `${t.dwelling ? 'At' : 'Next'} ${t.next} · ${ride}`, tone: null };
}

/** The photo caption: "Tue 14 May 2030 · 18:42 · New York", and the weather when it isn't clear. */
export function captionText(day: number, todSec: number, cityName: string, weather?: DayWeather | null): string {
  const w = weather && weather.kind !== 'clear' && weather.severity > 0 ? ` · ${weatherLabel(weather)}` : '';
  return `${fmtDate(day)} · ${fmtClock(todSec)} · ${cityName}${w}`;
}

/** The timelapse counter: "42.1 km of track · 31 stations · 4 routes running". */
export function timelapseStats(trackM: number, stations: number, routes: number): string {
  return `${fmtDistance(trackM)} of track · ${stations} ${stations === 1 ? 'station' : 'stations'} · ${routes} ${routes === 1 ? 'route' : 'routes'} running`;
}
