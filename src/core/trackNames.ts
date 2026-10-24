/**
 * Names for track classes and trains in the UI. The intertown map calls heavy track "main line";
 * the metro cities call it heavy metro.
 */
import { TRAINS, type StockId, type TrackClass } from '../balance';
import { city } from '../cities';

export function trackClassName(cls: TrackClass): string {
  const intertown = city().intertown === true;
  if (cls === 'highspeed') return 'High-speed line';
  if (cls === 'light') return intertown ? 'Light rail' : 'Light metro';
  return intertown ? 'Main line' : 'Heavy metro';
}

export function stockName(s: StockId): string {
  return TRAINS[s]?.name ?? 'Metro';
}
