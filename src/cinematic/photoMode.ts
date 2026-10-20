/**
 * Photo mode (P; docs/v2/cinematic.md §1): every piece of UI chrome hidden by one class on the
 * root (panels are kept as they are and come back on exit), an optional letterbox (L) and a
 * subtle caption (C: date, time, city). The map attribution stays visible: the letterbox bars sit
 * under MapLibre's control layer, and only the attribution control is left there.
 */
import { city } from '../cities';
import { dayIndex, fmtDate, timeOfDay } from '../core/calendar';
import { fmtClock } from '../core/units';
import { Emitter } from '../core/emitter';
import { h } from '../ui/dom';

export interface PhotoPrefs {
  letterbox: boolean;
  caption: boolean;
}

/** The caption: "Tue 14 May 2030 · 18:42 · New York". */
export function photoCaption(gameTime: number, cityName = city().name): string {
  return `${fmtDate(dayIndex(gameTime))} · ${fmtClock(timeOfDay(gameTime))} · ${cityName}`;
}

export class PhotoMode {
  readonly events = new Emitter<{ change: boolean }>();
  private _active = false;
  private top = h('div', { class: 'hw-letterbox top' });
  private bottom = h('div', { class: 'hw-letterbox bottom' });
  private caption = h('div', { class: 'hw-photo-caption' });
  private hint = h('div', { class: 'hw-photo-hint' });
  private hintTimer = 0;
  private lastCaption = '';

  constructor(
    private root: HTMLElement,
    mapContainer: HTMLElement,
    readonly prefs: PhotoPrefs,
    private onPrefs: (p: PhotoPrefs) => void,
  ) {
    // Inside the map container, under MapLibre's controls (z-index 2): the attribution stays on top.
    mapContainer.append(this.top, this.bottom, this.caption);
    root.append(this.hint);
  }

  get active(): boolean {
    return this._active;
  }

  toggle(force?: boolean): void {
    const on = force ?? !this._active;
    if (on === this._active) return;
    this._active = on;
    this.root.classList.toggle('hw-photo', on);
    this.apply();
    if (on) {
      this.hint.textContent = 'Photo mode · L letterbox · C caption · P or Esc to leave';
      this.hint.classList.add('show');
      clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => this.hint.classList.remove('show'), 2600);
    } else this.hint.classList.remove('show');
    this.events.emit('change', on);
  }

  setLetterbox(on = !this.prefs.letterbox): void {
    this.prefs.letterbox = on;
    this.onPrefs(this.prefs);
    this.apply();
  }

  setCaption(on = !this.prefs.caption): void {
    this.prefs.caption = on;
    this.onPrefs(this.prefs);
    this.apply();
  }

  private apply(): void {
    const on = this._active;
    this.root.classList.toggle('hw-photo-letterbox', on && this.prefs.letterbox);
    this.caption.style.display = on && this.prefs.caption ? '' : 'none';
  }

  /** The caption text (a few times a second, only while it shows). */
  tick(gameTime: number): void {
    if (!this._active || !this.prefs.caption) return;
    const text = photoCaption(gameTime);
    if (text !== this.lastCaption) {
      this.lastCaption = text;
      this.caption.textContent = text;
    }
  }

  destroy(): void {
    clearTimeout(this.hintTimer);
    this.root.classList.remove('hw-photo', 'hw-photo-letterbox');
    this.top.remove();
    this.bottom.remove();
    this.caption.remove();
    this.hint.remove();
  }
}
