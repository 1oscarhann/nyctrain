/** One-line description of a save slot, in that save's own city and currency. */
import { CITIES, city } from '../cities';
import { fmtDate } from '../core/calendar';
import { fmtMoney, setCurrency } from '../core/units';
import type { SaveFile } from './format';

/** Money in another city's currency. */
export function moneyIn(id: keyof typeof CITIES, v: number): string {
  setCurrency(CITIES[id].currency);
  const s = fmtMoney(v);
  setCurrency(city().currency);
  return s;
}

export function saveSummary(m: SaveFile['meta']): string {
  const c = m.city ?? 'nyc';
  return `${CITIES[c].name} · ${fmtDate(m.day)} · ${m.sandbox ? 'Sandbox' : moneyIn(c, m.cash)}`;
}
