/**
 * Top bar: cash (with daily change), date and time, speed controls, the weather chip and news
 * ticker (city chaos), daily riders, transit mode share, and average commute compared with the
 * no-subway baseline.
 */
import { TIME } from '../balance';
import { dayIndex, fmtDate, timeOfDay } from '../core/calendar';
import { weatherLabel } from '../core/cityCalendar';
import { fmtClock, fmtCount, fmtMoney, fmtPct } from '../core/units';
import { forecastText, LEVEL_LABEL, weatherEffects } from './alertFeed';
import type { App } from './app';
import { h, svgIcon } from './dom';
import { ICONS, WEATHER_ICON } from './icons';
import { NewsTicker } from './ticker';
import { attachTip } from './widgets';

export class TopBar {
  readonly el: HTMLElement;
  private cash = h('span', { class: 'value num' });
  private cashSub = h('span', { class: 'sub num' });
  private date = h('span', { class: 'value num' });
  private clock = h('span', { class: 'sub num' });
  private riders = h('span', { class: 'value num' });
  private ridersSub = h('span', { class: 'sub num' });
  private share = h('span', { class: 'value num' });
  private commute = h('span', { class: 'value num' });
  private commuteSub = h('span', { class: 'sub num' });
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private rate = h('span', { class: 'sub num hw-amber', style: 'display:none' });
  private weatherSep = h('div', { class: 'tb-sep' });
  private weather: HTMLElement;
  private weatherIcon = h('span', { class: 'tb-weather-icon' });
  private weatherValue = h('span', { class: 'value' });
  private weatherSub = h('span', { class: 'sub num' });
  private weatherKind = '';
  readonly ticker: NewsTicker;

  constructor(private app: App) {
    const stat = (label: string, value: HTMLElement, sub?: HTMLElement, onclick?: () => void) =>
      h('div', { class: 'tb-stat', style: onclick ? 'cursor:pointer' : '', onclick }, h('span', { class: 'label' }, label), value, sub ?? null);
    this.pauseBtn = h('button', { class: 'hw-btn ghost speed-btn', onclick: () => app.togglePause() }) as HTMLButtonElement;
    attachTip(this.pauseBtn, app.tooltip, 'Pause / resume', 'Space');
    TIME.speeds.forEach((s, i) => {
      const b = h('button', { class: 'hw-btn ghost speed-btn', onclick: () => app.setSpeedIndex(i) }, `${s}×`) as HTMLButtonElement;
      attachTip(b, app.tooltip, `${s}× speed`, String(i + 1), s === 1 ? '1 game minute per second' : `${s} game minutes per second`);
      this.speedBtns.push(b);
    });
    const skip = h('button', { class: 'hw-btn ghost speed-btn', onclick: () => app.skipTo6am() }, svgIcon(ICONS.skip));
    attachTip(skip, app.tooltip, 'Skip to 6am', undefined, 'Fast-forward through the night');
    const menu = h('button', { class: 'hw-btn ghost', id: 'btn-menu', style: 'width:38px;padding:0', onclick: () => app.openMenu() }, svgIcon(ICONS.menu));
    attachTip(menu, app.tooltip, 'Menu', undefined, 'Save, load, settings');
    // City chaos: weather chip (click for Service alerts) and the news ticker.
    this.weather = h(
      'div',
      { class: 'tb-stat tb-weather', role: 'button', tabindex: '0', onclick: () => app.openAlerts({ focus: app.feed.day * 1000 }) },
      this.weatherIcon,
      h('div', { class: 'tb-weather-text' }, h('span', { class: 'label' }, 'Weather'), this.weatherValue, this.weatherSub),
    );
    this.weather.addEventListener('mouseenter', () => {
      const r = this.weather.getBoundingClientRect();
      app.tooltip.show(this.weatherTip(), [r.left, r.bottom - 8]);
    });
    this.weather.addEventListener('mouseleave', () => app.tooltip.show(null));
    this.weather.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') app.openAlerts({ focus: app.feed.day * 1000 });
    });
    this.ticker = new NewsTicker((item) => app.openAlerts({ focus: item.focus, event: item.event }));
    this.el = h(
      'div',
      { id: 'topbar', class: 'hw-panel' },
      h('div', { class: 'brand' }, svgIcon(ICONS.logo), 'Headway'),
      h('div', { class: 'tb-sep' }),
      stat('Cash', this.cash, this.cashSub, () => app.game.select({ kind: 'finance' })),
      h('div', { class: 'tb-sep' }),
      stat('Date', this.date, this.clock),
      h('div', { class: 'tb-group' }, this.pauseBtn, ...this.speedBtns, skip),
      this.rate,
      this.weatherSep,
      this.weather,
      h('div', { class: 'tb-ticker-slot' }, this.ticker.el),
      h('div', { class: 'tb-sep' }),
      stat('Daily riders', this.riders, this.ridersSub),
      h('div', { class: 'tb-sep' }),
      stat('Transit share', this.share),
      h('div', { class: 'tb-sep' }),
      stat('Avg commute', this.commute, this.commuteSub),
      h('div', { class: 'tb-sep' }),
      menu,
    );
  }

  update(): void {
    const app = this.app;
    const g = app.game;
    const f = g.finance;
    this.cash.textContent = g.sandbox ? 'Sandbox' : fmtMoney(f.cash);
    this.cash.className = 'value num' + (!g.sandbox && f.cash < 0 ? ' hw-red' : '');
    const ch = f.lastDayChange();
    this.cashSub.textContent = g.sandbox ? 'unlimited' : f.history.length ? `${fmtMoney(ch, { sign: true })} yesterday` : 'no day settled yet';
    this.cashSub.className = 'sub num' + (g.sandbox ? '' : ch > 0 ? ' hw-green' : ch < 0 ? ' hw-red' : '');
    const t = app.sim.time();
    this.date.textContent = fmtDate(dayIndex(t));
    this.clock.textContent = fmtClock(timeOfDay(t));
    this.pauseBtn.replaceChildren(svgIcon(app.speedIndex < 0 ? ICONS.play : ICONS.pause));
    this.pauseBtn.classList.toggle('active', app.speedIndex < 0);
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === app.speedIndex));
    const want = app.speedIndex >= 0 ? TIME.speeds[app.speedIndex] * TIME.baseRate : 0;
    const got = app.sim.latest?.simRate ?? 0;
    if (want > 0 && got > 0 && got < want * 0.8) {
      this.rate.style.display = '';
      this.rate.textContent = `sim ${Math.round(got / TIME.baseRate)}×`;
    } else this.rate.style.display = 'none';
    const r = app.report;
    const live = app.sim.latest?.live;
    this.riders.textContent = r ? fmtCount(r.riders) : '—';
    this.ridersSub.textContent = live ? `${fmtCount(live.ridersToday)} so far today` : '';
    this.share.textContent = r ? fmtPct(r.transitShare) : '—';
    if (r) {
      const d = r.avgCommute - r.baselineCommute;
      this.commute.textContent = `${r.avgCommute.toFixed(1)} min`;
      this.commuteSub.textContent = `${d <= 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} vs no transit`;
      this.commuteSub.className = 'sub num ' + (d < -0.05 ? 'hw-green' : d > 0.05 ? 'hw-red' : '');
    } else {
      this.commute.textContent = app.baseline ? `${app.baseline.toFixed(1)} min` : '—';
      this.commuteSub.textContent = 'no-transit baseline';
      this.commuteSub.className = 'sub num';
    }
    this.updateChaos(t);
  }

  /** Weather chip and ticker; both stay quiet when chaos is off today and from 3 am. */
  private updateChaos(now: number): void {
    const feed = this.app.feed;
    const off = feed.off;
    this.weather.style.display = off ? 'none' : '';
    this.weatherSep.style.display = off ? 'none' : '';
    this.ticker.el.style.visibility = off ? 'hidden' : '';
    if (off) return;
    const w = feed.weather();
    const label = weatherLabel(w);
    if (this.weatherKind !== w.kind) {
      this.weatherKind = w.kind;
      this.weatherIcon.replaceChildren(svgIcon(WEATHER_ICON[w.kind]));
      this.weather.dataset.kind = w.kind;
    }
    if (this.weatherValue.textContent !== label) this.weatherValue.textContent = label;
    const fc = feed.forecast();
    const sub = `${fc.label}: ${forecastText(fc.f)}`;
    if (this.weatherSub.textContent !== sub) this.weatherSub.textContent = sub;
    this.ticker.set(feed.tickerItems(now, this.app.routeRef));
  }

  private weatherTip(): string {
    const feed = this.app.feed;
    const w = feed.weather();
    const fx = weatherEffects(w);
    const fc = feed.forecast();
    const lv = feed.levels();
    const level = lv.today === lv.next ? `${LEVEL_LABEL[lv.today]} chaos` : `${LEVEL_LABEL[lv.today]} chaos today, ${LEVEL_LABEL[lv.next]} from 3 am`;
    return (
      `<div class="title">${weatherLabel(w)}${w.carried ? ' (continuing)' : ''}<span class="kbd">A</span></div>` +
      `<div class="hw-muted">${fx.length ? fx.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' · ') : 'No weather effects today'}</div>` +
      `<div class="hw-muted">${fc.long}: ${forecastText(fc.f)} · ${level}</div>` +
      `<div class="hw-muted">Click for Service alerts</div>`
    );
  }
}
