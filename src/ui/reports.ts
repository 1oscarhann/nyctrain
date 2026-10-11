/** Monthly report and the bankruptcy game-over screen. */
import { fmtCount, fmtMoney } from '../core/units';
import type { MonthReport } from '../economy/finance';
import { goalDefs } from '../core/goals';
import type { App } from './app';
import { h } from './dom';
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
    ['Capital spending', fmtMoney(-m.capital), m.capital ? 'hw-red' : ''],
    ['Operating profit', fmtMoney(m.profit, { sign: true }), m.profit >= 0 ? 'hw-green' : 'hw-red'],
    ['Cash at month end', fmtMoney(m.cashEnd), m.cashEnd < 0 ? 'hw-red' : ''],
  ];
  const grid = h('div', { class: 'kv', style: 'font-size:14px' });
  for (const [k, v, c] of kvs) grid.append(h('div', { class: 'k' }, k), h('div', { class: `v ${c}` }, v));
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
