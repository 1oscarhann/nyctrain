/**
 * News ticker for the top bar: one line of items with coloured dots. When the line is wider than
 * the bar it scrolls right to left at 40 px/s (a compositor-only transform; the strip is doubled
 * for a seamless loop) and pauses on hover. With reduced motion it shows one item and "+N",
 * rotating every 5 s. The DOM is rebuilt only when the items change, so the scroll never restarts
 * on the top bar's 250 ms tick.
 */
import { h } from './dom';
import type { TickerItem } from './alertFeed';

const SPEED = 40; // px/s
const ROTATE_MS = 5000;

export class NewsTicker {
  readonly el: HTMLElement;
  private track: HTMLElement;
  private sig = '';
  private items: TickerItem[] = [];
  private rotateAt = -1;
  private reduced: MediaQueryList | null;

  constructor(private onPick: (item: TickerItem) => void) {
    this.track = h('div', { class: 'ticker-track' });
    this.el = h('div', { class: 'ticker', role: 'marquee', 'aria-label': 'Service news' }, this.track);
    this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  }

  set(items: TickerItem[], quiet = 'Good service on all lines'): void {
    const sig = items.map((i) => `${i.key}|${i.tone}|${i.text}`).join('\n') + '#' + quiet;
    if (this.reduced?.matches) {
      // One item at a time, rotating.
      const idx = items.length ? Math.floor(performance.now() / ROTATE_MS) % items.length : 0;
      if (sig === this.sig && idx === this.rotateAt) return;
      this.sig = sig;
      this.rotateAt = idx;
      this.items = items;
      this.renderStatic(items.length ? [items[idx]] : [], quiet, items.length > 1 ? `+${items.length - 1}` : '', true);
      return;
    }
    if (sig === this.sig) return;
    this.sig = sig;
    this.items = items;
    this.render(quiet);
  }

  private item(i: TickerItem): HTMLElement {
    return h('button', { class: `ticker-item tone-${i.tone}`, type: 'button', title: 'Open Service alerts', onclick: () => this.onPick(i) }, h('span', { class: 'dot' }), h('span', { class: 'ticker-text' }, i.text));
  }

  /** fit: one line that never overflows (the item is cut with an ellipsis, so "+N" stays visible). */
  private renderStatic(items: TickerItem[], quiet: string, more: string, fit = false): void {
    this.track.classList.remove('scrolling');
    this.track.classList.toggle('fit', fit);
    this.track.style.animationDuration = '';
    const strip = h('div', { class: 'ticker-strip' }, ...(items.length ? items.map((i) => this.item(i)) : [h('span', { class: 'ticker-quiet' }, h('span', { class: 'dot' }), quiet)]));
    if (more) strip.append(h('span', { class: 'ticker-more' }, more));
    this.track.replaceChildren(strip);
  }

  private render(quiet: string): void {
    const items = this.items;
    this.renderStatic(items, quiet, '');
    if (!items.length) return;
    // Measure after layout: scroll only when the line doesn't fit.
    requestAnimationFrame(() => {
      const strip = this.track.firstElementChild as HTMLElement | null;
      if (!strip || this.items !== items) return;
      const w = strip.scrollWidth;
      if (w <= this.el.clientWidth || this.el.clientWidth === 0) return;
      const copy = strip.cloneNode(true) as HTMLElement;
      copy.setAttribute('aria-hidden', 'true');
      // Clones need their own click handlers.
      copy.querySelectorAll<HTMLElement>('.ticker-item').forEach((b, k) => b.addEventListener('click', () => this.onPick(items[k])));
      this.track.append(copy);
      this.track.style.animationDuration = `${(w / SPEED).toFixed(2)}s`;
      this.track.classList.add('scrolling');
    });
  }
}
