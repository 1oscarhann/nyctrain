/**
 * Finances: cash, debt and bonds, fare, yesterday's income and expense breakdown, this month so
 * far, and the monthly revenue vs operating costs chart.
 */
import { ECONOMY } from '../../balance';
import { monthKey } from '../../core/calendar';
import { fmtMoney } from '../../core/units';
import type { App } from '../app';
import { financeChart } from '../charts';
import { h } from '../dom';
import { kv, section, shell, statCard, type Panel } from './common';

function signed(v: number): HTMLElement {
  return h('span', { class: v > 0 ? 'hw-green' : v < 0 ? 'hw-red' : '' }, fmtMoney(v, { sign: true }));
}

export function financePanel(app: App): Panel {
  const game = app.game;
  const f = game.finance;
  const sh = shell(game.sandbox ? 'Sandbox — money is unlimited' : 'Money', 'Finances', () => game.select(null));
  const body = sh.body;
  let chart: { destroy(): void } | null = null;
  const render = () => {
    chart?.destroy();
    chart = null;
    body.replaceChildren();
    const debt = f.debt();
    if (f.negativeDays > 0 && !game.sandbox) {
      body.append(h('div', { class: 'err' }, `Cash has been negative for ${f.negativeDays} day${f.negativeDays > 1 ? 's' : ''}. After ${ECONOMY.bankruptcyDays} days with no bond room left, the authority goes bankrupt.`));
    }
    body.append(
      h('div', { class: 'stat-grid' }, statCard('Cash', game.sandbox ? '∞' : fmtMoney(f.cash), f.cash < 0 ? 'red' : undefined), statCard('Debt', fmtMoney(debt)), statCard('Bond room', fmtMoney(f.bondRoom())), statCard('Assets', fmtMoney(f.assetValue))),
    );
    // Fare
    const fareVal = h('b', { class: 'num' }, `$${game.fare.toFixed(2)}`);
    const fare = h('input', { type: 'range', min: String(ECONOMY.fareMin), max: String(ECONOMY.fareMax), step: String(ECONOMY.fareStep), value: String(game.fare), style: 'flex:1' }) as HTMLInputElement;
    fare.addEventListener('input', () => {
      fareVal.textContent = `$${Number(fare.value).toFixed(2)}`;
    });
    fare.addEventListener('change', () => app.setFare(Number(fare.value)));
    body.append(section('Fare (flat, transfers free)'), h('div', { style: 'display:flex;gap:10px;align-items:center' }, fare, fareVal), h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:2px' }, 'Takes effect in the next morning’s mode choice. Lower earners are most sensitive.'));
    // Bonds
    const issue = h('button', { class: 'hw-btn small', disabled: game.sandbox || f.bondRoom() < ECONOMY.bondChunk, onclick: () => app.issueBond() }, `Issue ${fmtMoney(ECONOMY.bondChunk)} bond`);
    body.append(section(`Bonds · ${+(ECONOMY.bondRate * 100).toFixed(2)}% over ${ECONOMY.bondYears} years`), h('div', { style: 'display:flex;gap:8px;align-items:center' }, issue, h('span', { class: 'hw-muted', style: 'font-size:12px' }, `Up to ${fmtMoney(ECONOMY.bondMax)} in total`)));
    if (f.bonds.length) {
      body.append(kv(f.bonds.map((b) => [`Bond ${b.id}`, `${fmtMoney(b.balance)} left · ${fmtMoney(b.monthlyPayment)}/mo`] as [string, string])));
    }
    // Yesterday
    const y = f.history[f.history.length - 1];
    if (y) {
      const opCost = y.operating + y.staffing + y.maintenance;
      body.append(
        section('Yesterday'),
        kv([
          ['Fares', signed(y.revenue)],
          ['Train operations', signed(-y.operating)],
          ['Station staffing', signed(-y.staffing)],
          ['Maintenance', signed(-y.maintenance)],
          ['Bond payments', signed(-(y.bondInterest + y.bondPrincipal))],
          ['Operating result', signed(y.revenue - opCost - y.bondInterest)],
          ['Construction & trains', signed(-(y.construction + y.trains - y.refunds))],
        ]),
      );
    } else body.append(section('Yesterday'), h('div', { class: 'hw-muted' }, 'Finances settle at midnight.'));
    // This month so far
    const key = monthKey(game.day);
    const days = f.history.filter((d) => monthKey(d.day) === key);
    const sum = (fn: (d: (typeof days)[number]) => number) => days.reduce((s, d) => s + fn(d), 0);
    if (days.length) {
      body.append(
        section(`This month so far (${days.length} day${days.length > 1 ? 's' : ''})`),
        kv([
          ['Fares', signed(sum((d) => d.revenue))],
          ['Operating costs', signed(-sum((d) => d.operating + d.staffing + d.maintenance))],
          ['Capital spending', signed(-sum((d) => d.construction + d.trains - d.refunds))],
        ]),
      );
    }
    // Monthly chart
    const months = f.months.slice(-12);
    body.append(section('Monthly revenue vs operating costs'));
    if (months.length) {
      const wrap = h('div', { class: 'chart' });
      body.append(wrap);
      chart = financeChart(wrap, months.map((m) => m.label), months.map((m) => m.revenue), months.map((m) => m.operatingCosts));
      const last = months[months.length - 1];
      body.append(h('div', { style: 'font-size:12.5px;margin-top:4px' }, `${last.label}: operating profit `, signed(last.profit)));
    } else body.append(h('div', { class: 'hw-muted' }, 'The first monthly report appears when the month ends.'));
  };
  render();
  return { el: sh.el, dayEnd: render, destroy: () => chart?.destroy() };
}
