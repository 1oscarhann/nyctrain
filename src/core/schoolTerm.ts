/**
 * School days: weekdays in term time. England: autumn term September to the week before
 * Christmas, spring term January to Easter (the first two weeks of April off), summer term to the
 * third week of July, with a week off at each half term. New York: the Thursday after Labor Day to
 * late June, off over Christmas week, February and spring breaks. Approximate, the same every year.
 */
import { cityBalance } from '../cities';
import { dateOfDay } from './calendar';

export function isSchoolDay(day: number): boolean {
  const d = dateOfDay(day);
  const m = d.getUTCMonth(); // 0 = January
  const n = d.getUTCDate();
  if (cityBalance().schools?.terms === 'us') {
    if (m === 6 || m === 7) return false; // July, August
    if (m === 8 && n < 8) return false; // early September
    if (m === 5 && n > 26) return false; // end of June
    if ((m === 11 && n >= 24) || (m === 0 && n <= 1)) return false; // winter recess
    if (m === 1 && n >= 16 && n <= 20) return false; // mid-winter recess
    if (m === 3 && n >= 2 && n <= 10) return false; // spring recess
    return true;
  }
  if (m === 7) return false; // August
  if (m === 6 && n > 21) return false; // late July
  if (m === 8 && n < 4) return false; // early September
  if ((m === 11 && n >= 20) || (m === 0 && n <= 4)) return false; // Christmas
  if (m === 3 && n <= 14) return false; // Easter
  if (m === 9 && n >= 24) return false; // October half term
  if (m === 1 && n >= 16 && n <= 20) return false; // February half term
  if (m === 4 && n >= 26) return false; // May half term
  return true;
}
