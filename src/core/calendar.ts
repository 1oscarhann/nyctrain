import { TIME } from '../balance';

/**
 * Weekday-only calendar. Game day 0 is TIME.startDate (a Monday); each game day is the next
 * weekday. Game time t is seconds since 00:00 on day 0.
 */
const DAY = 86400;

export function dayIndex(t: number): number {
  return Math.floor(t / DAY);
}

export function timeOfDay(t: number): number {
  return t - dayIndex(t) * DAY;
}

export function dateOfDay(day: number): Date {
  const { year, month, day: d0 } = TIME.startDate;
  const weeks = Math.floor(day / 5);
  const rem = day % 5;
  // startDate is a Monday, so weekday offset = rem.
  return new Date(Date.UTC(year, month, d0 + weeks * 7 + rem));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDate(day: number): string {
  const d = dateOfDay(day);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function monthKey(day: number): string {
  const d = dateOfDay(day);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(day: number): string {
  const d = dateOfDay(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** True when `day` is the first weekday of a new month. */
export function isNewMonth(day: number): boolean {
  return day > 0 && monthKey(day) !== monthKey(day - 1);
}

export const SECONDS_PER_DAY = DAY;
