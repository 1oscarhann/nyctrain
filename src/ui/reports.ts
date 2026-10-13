/** Monthly report, the year in review and the bankruptcy game-over screen. */
import { fmtCount, fmtMoney } from '../core/units';
import { yearOf } from '../core/calendar';
import type { MonthReport } from '../economy/finance';
import { buildYearReview } from '../economy/yearReview';
import { goalDefs } from '../core/goals';
import type { App } from './app';
import { CHART_TEAL, barChart } from './charts';
import { h } from './dom';
import { monthRatingText, ratingTone, yearReviewText } from './opsMoney';
import { modal } from './widgets';

export function showMonthReport(app: App, m: MonthReport): void {
  if (app.game.sandbox) {
    app.toast(`${m.label} report`, `${fmtCount(m.riders / Math.max(1, m.days))} riders a day`, 'green');
    return;
  }
  const kvs: [string, string, string][] = [
    ['Fares', fmtMoney(m.revenue), 'hw-green'],
    ['Operating costs', fmtMoney(-m.operatingCosts), 'hw-red'],
    ['Bond payments', fmtMoney(-m.bondPayments), m.bondPayments ? 'hw-red' : ''],
  ];
  if (m.fees) kvs.push(['Financing fees', fmtMoney(-m.fees), 'hw-red']);
  if (m.prepaid) kvs.push(['Bond prepayments', fmtMoney(-m.prepaid), 'hw-red']);
  kvs.push(
    ['Capital spending', fmtMoney(-m.capital), m.capital ? 'hw-red' : ''],
    ['Operating profit', fmtMoney(m.profit, { sign: true }), m.profit >= 0 ? 'hw-green' : 'hw-red'],
    ['Cash at month end', fmtMoney(m.cashEnd), m.cashEnd < 0 ? 'hw-red' : ''],
  );
  const grid = h('div', { class: 'kv', style: 'font-size:14px' });
  for (const [k, v, c] of kvs) grid.append(h('div', { class: 'k' }, k), h('div', { class: `v ${c}` }, v));
  if (m.rating) {
    // The rating before this review: the previous month's, else the one bonds were last rated at.
    const months = app.game.finance.months;
    const i = months.indexOf(m);
    const prev = i > 0 ? months[i - 1].rating : app.game.finance.market.history.at(-1)?.rating;
    const tone = ratingTone(m.rating);
    grid.append(h('div', { class: 'k' }, 'Credit rating'), h('div', { class: `v rating-badge ${tone}` }, monthRatingText(m.rating, prev, m.newRate)));
  }
  let close: () => void = () => {};
  const content = h(
    'div',
    null,
    h('h2', null, `${m.label} report`),
    h('div', { class: 'hw-muted', style: 'margin-bottom:12px' }, `${m.days} weekdays · ${fmtCount(m.riders / Math.max(1, m.days))} riders a day on average`),
    grid,
    h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => { close(); app.game.select({ kind: 'finance' }); } }, 'Open finances'), h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Continue')),
  );
  close = modal(app.root, content);
}

/**
 * The year in review (§2.5): ridership by month, money, the rating's path, the bond market,
 * service regularity and goals. Shown on the first weekday of January instead of the December
 * report (whose line is the last bar), and from the Finances panel for any year with data.
 */
export function showYearReview(app: App, year: number): void {
  const g = app.game;
  const rev = buildYearReview(g.finance, app.goals, year);
  // This year's months so far (the review of a finished year is shown from 1 January on).
  const partial = year >= yearOf(g.day);
  const t = yearReviewText(rev, { sandbox: g.sandbox, partial });
  let chart: { destroy(): void } | null = null;
  let close: () => void = () => {};
  const cards = h('div', { class: 'yr-cards' });
  for (const c of t.cards) {
    const isRating = c.label === 'credit rating';
    const tone = isRating ? ` rating-badge ${ratingTone(rev.credit.end)}` : c.tone ? ` hw-${c.tone}` : '';
    cards.append(h('div', { class: 'stat-card' }, h('div', { class: `value num${tone}` }, c.value), h('div', { class: 'label' }, c.label)));
  }
  const grid = h('div', { class: 'yr-grid' });
  const row = (k: string, ...v: (Node | string)[]) => grid.append(h('div', { class: 'k' }, k), h('div', null, ...v));
  const chartWrap = h('div', { class: 'chart' });
  row('Ridership', chartWrap, t.ridership ? h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, t.ridership) : '');
  if (g.sandbox) row('Money', h('span', { class: 'hw-muted' }, 'Sandbox — money unlimited'));
  else {
    row('Money', ...t.money.map((l) => h('div', { class: 'num' }, l)));
    row('Credit', t.credit);
    row('Bond market', t.market);
  }
  row('Service', t.service);
  row('Goals', t.goals.length ? h('div', null, ...t.goals.map((x) => h('div', { class: 'hw-green' }, x))) : h('span', { class: 'hw-muted' }, `None completed in ${year}`));
  const last = g.finance.months.filter((m) => m.key.startsWith(`${year}-`)).at(-1);
  const content = h(
    'div',
    null,
    h('div', { class: 'yr-head' }, h('h2', null, t.title), h('span', { class: 'hw-muted num' }, t.sub)),
    cards,
    grid,
    last && !g.sandbox ? h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:10px' }, `${last.label}: fares ${fmtMoney(last.revenue)} · operating profit ${fmtMoney(last.profit, { sign: true })} · cash ${fmtMoney(last.cashEnd)}`) : '',
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'hw-btn', onclick: () => { close(); app.financeTab = 'overview'; app.game.select({ kind: 'finance' }); } }, 'Open finances'),
      h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Continue'),
    ),
  );
  close = modal(app.root, content, { onClose: () => chart?.destroy() });
  content.parentElement?.classList.add('year-review');
  const by = rev.riders.byMonth;
  if (by.length) {
    const w = Math.max(280, Math.min(480, chartWrap.clientWidth || 470));
    chart = barChart(chartWrap, by.map((_, i) => i), by.map((m) => m.avg), CHART_TEAL, (i) => by[i]?.label.slice(0, 3) ?? '', 'Riders/day', w, 140);
  } else chartWrap.append(h('div', { class: 'hw-muted' }, 'No month has closed yet.'));
}

export function showGameOver(app: App): void {
  const g = app.game;
  const peak = Math.max(0, ...g.finance.history.map((d) => d.riders));
  const defs = goalDefs();
  const done = defs.filter((d) => app.goals[d.id] !== null).length;
  const stats: [string, string][] = [
    ['Days survived', String(g.day)],
    ['Peak daily riders', fmtCount(peak)],
    ['Stations', String([...g.network.stations.values()].filter((s) => s.status === 'built').length)],
    ['Routes', String(g.routes.list().length)],
    ['Debt', fmtMoney(g.finance.debt())],
    ['Goals', `${done} / ${defs.length}`],
  ];
  const grid = h('div', { class: 'stat-grid', style: 'margin:12px 0' });
  for (const [k, v] of stats) grid.append(h('div', { class: 'stat-card' }, h('div', { class: 'label' }, k), h('div', { class: 'value' }, v)));
  const content = h(
    'div',
    null,
    h('h2', { class: 'hw-red' }, 'Bankrupt'),
    h('div', { class: 'hw-muted' }, 'Cash stayed below zero for 30 days with no bond room left. The transit authority has been dissolved.'),
    grid,
    h('div', { class: 'actions' }, h('button', { class: 'hw-btn primary', onclick: () => app.exitToTitle() }, 'Back to title')),
  );
  modal(app.root, content, { dismissable: false });
}
