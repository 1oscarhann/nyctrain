/**
 * Finances (M), in four tabs (docs/v2/ops-money.md §2.4):
 * - Overview: cash, debt, bond room, assets, the credit rating and today's new-bond rate,
 *   yesterday's ledger (with financing fees and prepayments), this month so far, the monthly
 *   revenue vs operating costs chart, and the year in review.
 * - Fares: peak and off-peak fares, the low-income fare, and yesterday's fares by band and period.
 * - Borrowing: the market and the spread, issuing bonds, the credit scorecard, the rate history
 *   chart, and each bond with Prepay and Refinance.
 * - Fleet: cars per class (on routes, needed, idle, spare) and car sales.
 * The open tab is remembered for the session (App.financeTab), not saved.
 */
import { BONDS, ECONOMY, TRAINS, type TrackClass } from '../../balance';
import { city } from '../../cities';
import { monthKey, monthLabel, yearOf } from '../../core/calendar';
import { fmtFare, fmtMoney } from '../../core/units';
import { fareSummary } from '../../economy/fares';
import { annuityMonthly } from '../../economy/finance';
import { yearsWithData } from '../../economy/yearReview';
import { carSaleValue, fleetPlan } from '../../routes/fleet';
import type { App } from '../app';
import { CHART_ORANGE, CHART_TEAL, financeChart, rateChart } from '../charts';
import { bullet, h } from '../dom';
import {
  BAND_LABELS,
  bondLine,
  borrowingHeader,
  creditOutlook,
  fareRange,
  fareYesterday,
  fareYesterdayLine,
  fmtMoneyFine,
  fmtRate,
  LOW_INCOME_OPTIONS,
  lowEarnersLine,
  lowIncomeTip,
  peakHoursLabel,
  ratingTone,
  refinanceText,
  sameAllDay,
  scoreLine,
  scoreParts,
} from '../opsMoney';
import { attachTip } from '../widgets';
import { valueCaptureHeading, valueCaptureSection } from '../livingCity';
import { kv, section, shareBar, shell, statCard, type Panel } from './common';

export type FinanceTab = 'overview' | 'fares' | 'borrowing' | 'fleet';
const TABS: { id: FinanceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'fares', label: 'Fares' },
  { id: 'borrowing', label: 'Borrowing' },
  { id: 'fleet', label: 'Fleet' },
];

function signed(v: number): HTMLElement {
  // Zero reads "$0" (no "+"), so empty rows such as Financing fees don't look like income.
  return h('span', { class: v > 0 ? 'hw-green' : v < 0 ? 'hw-red' : '' }, fmtMoney(v, { sign: v !== 0 }));
}

const muted = (text: string, style = 'font-size:11.5px;margin-top:4px') => h('div', { class: 'hw-muted', style }, text);

export function financePanel(app: App): Panel {
  const game = app.game;
  const f = game.finance;
  const sh = shell(game.sandbox ? 'Sandbox — money is unlimited' : 'Money', 'Finances', () => game.select(null));
  const tabs = h('div', { class: 'seg fin-tabs' });
  const content = h('div');
  sh.body.append(tabs, content);
  let charts: { destroy(): void }[] = [];
  const tip = (el: HTMLElement, title: string, body?: string) => attachTip(el, app.tooltip, title, undefined, body);

  // ------------------------------------------------------------------ Overview
  const overview = () => {
    const debt = f.debt();
    if (f.negativeDays > 0 && !game.sandbox) {
      content.append(h('div', { class: 'err' }, `Cash has been negative for ${f.negativeDays} day${f.negativeDays > 1 ? 's' : ''}. After ${ECONOMY.bankruptcyDays} days with no bond room left, the authority goes bankrupt.`));
    }
    const preview = f.previewCredit();
    const out = creditOutlook(preview, f.market);
    const rating = f.market.rating ?? preview.next;
    const ratingCard = h(
      'div',
      { class: 'stat-card', style: 'cursor:pointer', onclick: () => setTab('borrowing') },
      h('div', { class: 'label' }, 'Credit rating'),
      h('div', { class: `value rating-badge ${ratingTone(rating)}` }, rating, h('span', { class: 'outlook' }, out.arrow)),
    );
    tip(ratingCard, `Credit rating ${rating} · outlook ${out.word}`, `${scoreLine(preview, f.market)}. Reviewed at each month end. Click for the scorecard.`);
    const rateCard = statCard('New bonds', fmtRate(f.newBondRate()));
    tip(rateCard, 'Rate for a new bond', f.market.fixed ? 'Fixed rate: the bond market is off.' : 'The market’s base rate plus your rating’s spread. Each bond keeps the coupon it was issued at.');
    content.append(
      h('div', { class: 'stat-grid' }, statCard('Cash', game.sandbox ? '∞' : fmtMoney(f.cash), f.cash < 0 ? 'red' : undefined), statCard('Debt', fmtMoney(debt)), statCard('Bond room', fmtMoney(f.bondRoom())), statCard('Assets', fmtMoney(f.assetValue)), ratingCard, rateCard),
      muted(`Fares ${fareSummary(game.fares)} · ${f.bonds.length} bond${f.bonds.length === 1 ? '' : 's'}${f.bonds.length ? ` at an average ${fmtRate(f.weightedCoupon())}` : ''}`, 'font-size:11.5px;margin-top:6px'),
    );
    // Yesterday
    const y = f.history[f.history.length - 1];
    if (y) {
      const opCost = y.operating + y.staffing + y.maintenance;
      const fees = y.fees ?? 0;
      // Living City: booked on month-close days only (0 on others).
      const vc = y.valueCapture ?? 0;
      content.append(
        section('Yesterday'),
        kv([
          ['Fares', signed(y.revenue)],
          ['Value capture', signed(vc)],
          ['Train operations', signed(-y.operating)],
          ['Station staffing', signed(-y.staffing)],
          ['Maintenance', signed(-y.maintenance)],
          ['Bond payments', signed(-(y.bondInterest + y.bondPrincipal))],
          ['Financing fees', signed(-fees)],
          ['Bond prepayments', signed(-(y.prepaid ?? 0))],
          ['Operating result', signed(y.revenue + vc - opCost - y.bondInterest - fees)],
          ['Construction & trains', signed(-(y.construction + y.trains - y.refunds))],
        ]),
      );
    } else content.append(section('Yesterday'), h('div', { class: 'hw-muted' }, 'Finances settle at midnight.'));
    // This month so far
    const key = monthKey(game.day);
    const days = f.history.filter((d) => monthKey(d.day) === key);
    const sum = (fn: (d: (typeof days)[number]) => number) => days.reduce((s, d) => s + fn(d), 0);
    if (days.length) {
      content.append(
        section(`This month so far (${days.length} day${days.length > 1 ? 's' : ''})`),
        kv([
          ['Fares', signed(sum((d) => d.revenue))],
          ...(days.some((d) => d.valueCapture !== undefined) ? [['Value capture', signed(sum((d) => d.valueCapture ?? 0))] as [string, HTMLElement]] : []),
          ['Operating costs', signed(-sum((d) => d.operating + d.staffing + d.maintenance))],
          ['Capital spending', signed(-sum((d) => d.construction + d.trains - d.refunds))],
        ]),
      );
    }
    // Value capture (Living City): the district, last month's payment and this month's projection.
    const lastVc = [...f.months].reverse().find((m) => m.valueCapture !== undefined)?.valueCapture ?? null;
    const vcText = valueCaptureSection(app.growthView, lastVc, game.growthPace);
    const vcBody = h('div', { class: 'hw-muted', style: 'font-size:12.5px;line-height:1.45' }, vcText.body);
    const vcLast = h('div', { class: 'fin-line', style: 'margin-top:4px' }, vcText.last);
    content.append(section(valueCaptureHeading()), vcBody, vcLast);
    if (!app.growthView && game.growthPace !== 'off') {
      app.loadGrowthView().then((v) => {
        if (!v || !vcBody.isConnected) return;
        const t = valueCaptureSection(v, lastVc, game.growthPace);
        vcBody.textContent = t.body;
        vcLast.textContent = t.last;
      });
    }
    // Monthly chart
    const months = f.months.slice(-12);
    const withVc = game.growthPace !== 'off' || months.some((m) => (m.valueCapture ?? 0) > 0);
    content.append(section('Monthly revenue vs operating costs'));
    if (months.length) {
      const wrap = h('div', { class: 'chart' });
      content.append(wrap);
      charts.push(financeChart(wrap, months.map((m) => m.label), months.map((m) => m.revenue + (m.valueCapture ?? 0)), months.map((m) => m.operatingCosts), undefined, undefined, withVc ? 'Revenue (fares + value capture)' : 'Revenue'));
      const last = months[months.length - 1];
      content.append(h('div', { style: 'font-size:12.5px;margin-top:4px' }, `${last.label}: operating profit `, signed(last.profit)));
    } else content.append(h('div', { class: 'hw-muted' }, 'The first monthly report appears when the month ends.'));
    // Year in review: the last finished year, or this year so far.
    const years = yearsWithData(f);
    const thisYear = yearOf(game.day);
    content.append(section('Year in review'));
    if (!years.length) {
      content.append(h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('button', { class: 'hw-btn small', disabled: true }, 'Year in review'), h('span', { class: 'hw-muted', style: 'font-size:12px' }, 'Available after the first month end')));
    } else {
      const finished = years.filter((yv) => yv < thisYear);
      let pick = finished.length ? finished[finished.length - 1] : years[years.length - 1];
      const btn = h('button', { class: 'hw-btn small', onclick: () => app.showYearReview(pick) }, 'Year in review');
      const row = h('div', { style: 'display:flex;gap:8px;align-items:center' }, btn);
      if (years.length > 1) {
        const sel = h('select', { style: 'height:26px;font-size:12px', onchange: (e: Event) => (pick = Number((e.target as HTMLSelectElement).value)) }) as HTMLSelectElement;
        for (const yv of [...years].reverse()) sel.append(h('option', { value: String(yv) }, yv === thisYear ? `${yv} (so far)` : String(yv)));
        sel.value = String(pick);
        row.append(sel);
      } else row.append(h('span', { class: 'hw-muted', style: 'font-size:12px' }, pick === thisYear ? `${pick} so far` : String(pick)));
      content.append(row);
    }
  };

  // ------------------------------------------------------------------ Fares
  const fares = () => {
    const p = game.fares;
    const rng = fareRange();
    const locked = sameAllDay(p) && !app.fareSplit;
    // data-focus: a rebuilt panel (each change rebuilds it) puts keyboard focus back on the same
    // control, so arrow keys keep stepping a slider.
    const slider = (value: number, focus: string, disabled = false) =>
      h('input', { type: 'range', min: String(rng.min), max: String(rng.max), step: String(rng.step), value: String(value), disabled, style: 'flex:1', 'data-focus': focus }) as HTMLInputElement;
    // Peak
    const peakVal = h('b', { class: 'num', style: 'min-width:46px;text-align:right' }, fmtFare(p.peak));
    const peak = slider(p.peak, 'fare-peak');
    peak.addEventListener('input', () => {
      peakVal.textContent = fmtFare(Number(peak.value));
      if (locked) {
        off.value = peak.value;
        offVal.textContent = fmtFare(Number(peak.value));
      }
    });
    peak.addEventListener('change', () => {
      const v = Number(peak.value);
      // Adjusting a split policy stays split, even when the two fares meet (only the checkbox locks them).
      if (!locked) app.fareSplit = true;
      app.setFares(locked ? { peak: v, offPeak: v } : { peak: v, offPeak: Math.min(game.fares.offPeak, v) });
    });
    // Off-peak (capped at the peak fare)
    const offVal = h('b', { class: 'num', style: 'min-width:46px;text-align:right' }, fmtFare(p.offPeak));
    const off = slider(p.offPeak, 'fare-off', locked);
    off.addEventListener('input', () => {
      if (Number(off.value) > Number(peak.value)) off.value = peak.value;
      offVal.textContent = fmtFare(Number(off.value));
    });
    off.addEventListener('change', () => {
      app.fareSplit = true;
      app.setFares({ offPeak: Math.min(Number(off.value), game.fares.peak) });
    });
    const same = h('input', { type: 'checkbox', checked: locked, 'data-focus': 'fare-same' }) as HTMLInputElement;
    same.addEventListener('change', () => {
      app.fareSplit = !same.checked;
      if (same.checked && game.fares.offPeak !== game.fares.peak) app.setFares({ offPeak: game.fares.peak });
      else render();
    });
    // Low-income
    const low = h('div', { class: 'seg' });
    for (const o of LOW_INCOME_OPTIONS) low.append(h('button', { class: o.value === p.lowIncome ? 'on' : '', 'data-focus': `fare-low-${o.value}`, onclick: () => o.value !== game.fares.lowIncome && app.setFares({ lowIncome: o.value }) }, o.label));
    tip(low, 'Low-income fare', lowIncomeTip());
    content.append(
      h('div', { class: 'fin-line' }, h('b', null, fareSummary(p)), h('span', { class: 'hw-muted' }, ' · transfers free')),
      section(`Peak fare (${peakHoursLabel()})`),
      h('div', { style: 'display:flex;gap:10px;align-items:center' }, peak, peakVal),
      section('Off-peak fare'),
      h('div', { style: 'display:flex;gap:10px;align-items:center' }, off, offVal),
      h('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12.5px;margin-top:4px;cursor:pointer' }, same, 'Same fare all day'),
      section('Low-income fare'),
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, low, h('span', { class: 'hw-muted', style: 'font-size:12px' }, 'for the lowest earners')),
      muted(`For ${city().lowIncomeBand}. Billed at boarding; they decide at 3 am.`),
    );
    const yd = fareYesterday(app.report);
    content.append(section('By band and period'));
    if (yd) {
      content.append(
        h('div', { class: 'fin-line' }, fareYesterdayLine(yd)),
        h('div', { class: 'fin-line' }, lowEarnersLine(yd)),
        h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:8px' }, 'Fare revenue by earnings band'),
        shareBar(BAND_LABELS.map((label, i) => ({ label, value: yd.revenueByBand[i], color: [CHART_TEAL, CHART_ORANGE, '#8E99A5'][i] }))),
      );
    } else content.append(h('div', { class: 'hw-muted' }, 'Fares by band and period appear after the first day with riders.'));
    content.append(muted('Billing changes at once; commuters reconsider at 3 am. Fares move revenue more than ridership, and lower earners are most sensitive.', 'font-size:11.5px;margin-top:10px'));
  };

  // ------------------------------------------------------------------ Borrowing
  const borrowing = () => {
    const rate = f.newBondRate();
    if (game.sandbox) content.append(h('div', { class: 'warn' }, 'Sandbox — borrowing is off. The market and your rating are shown for information.'));
    content.append(h('div', { class: 'fin-line' }, borrowingHeader(f.market, rate, game.day)));
    const pay = annuityMonthly(ECONOMY.bondChunk, rate, BONDS.termMonths);
    const issue = h('button', { class: 'hw-btn small', disabled: game.sandbox || f.bondRoom() < ECONOMY.bondChunk, onclick: () => app.issueBond() }, `Issue ${fmtMoney(ECONOMY.bondChunk)} bond`);
    tip(issue, `Issue a ${fmtMoney(ECONOMY.bondChunk)} bond at ${fmtRate(rate)}`, `${fmtMoneyFine(pay)} a month for ${ECONOMY.bondYears} years (interest only in the month it is issued).`);
    content.append(h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, issue, h('span', { class: 'hw-muted', style: 'font-size:12px' }, `Room ${fmtMoney(f.bondRoom())} of ${fmtMoney(ECONOMY.bondMax)}`)));
    // Scorecard
    const preview = f.previewCredit();
    content.append(section('Credit scorecard'));
    const card = h('div');
    for (const m of preview.metrics) {
      const tone = m.points >= 65 ? 'good' : m.points >= 35 ? 'mid' : 'bad';
      const row = h(
        'div',
        { class: 'score-row' },
        h('span', null, m.label, h('span', { class: 'hw-muted' }, ` · ${Math.round(m.weight * 100)}%`)),
        h('span', { class: 'v' }, m.display, h('span', { class: 'hw-muted', style: 'font-weight:400' }, ` · ${Math.round(m.points)} pts`)),
        h('div', { class: `score-bar ${tone}` }, h('i', { style: { width: `${Math.max(2, Math.min(100, m.points))}%` } })),
        h('span', { class: 'hint' }, m.hint),
      );
      card.append(row);
    }
    const sp = scoreParts(preview, f.market);
    content.append(card, h('div', { class: 'fin-line', style: 'margin-top:6px' }, sp.head, h('span', { class: `rating-badge ${ratingTone(sp.rating)}` }, sp.rating), sp.tail));
    content.append(muted('Farebox recovery is fares ÷ operating costs; interest coverage counts value capture and one more bond pro forma; leverage is debt ÷ (assets + cash); liquidity is months of costs and debt service in cash.'));
    // Rate history
    content.append(section('Rate history'));
    const hist = f.market.history.slice(-(BONDS.historyMonths >= 59 ? 59 : BONDS.historyMonths));
    const labels = [...hist.map((m) => m.label), `${monthLabel(game.day)} (so far)`];
    const base = [...hist.map((m) => m.base), f.market.base];
    const yours = [...hist.map((m) => m.newRate), rate];
    const avg = [...hist.map((m) => (m.avgCost > 0 ? m.avgCost : null)), f.weightedCoupon() > 0 ? f.weightedCoupon() : null];
    const wrap = h('div', { class: 'chart' });
    content.append(wrap);
    charts.push(rateChart(wrap, labels, base, yours, avg));
    if (!hist.length) content.append(muted('The market moves at each month end; the first review is on the last weekday of the month.'));
    // Bonds
    content.append(section(f.bonds.length ? `Bonds (${f.bonds.length}) · ${fmtMoneyFine(f.bonds.reduce((s, b) => s + b.monthlyPayment, 0))} a month` : 'Bonds'));
    if (!f.bonds.length) content.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'No bonds outstanding.'));
    const list = h('div');
    for (const b of f.bonds) {
      const q = f.refinanceQuote(b.id);
      const prepay = h('button', { class: 'hw-btn small', disabled: game.sandbox, onclick: () => app.prepayBond(b.id) }, 'Prepay…');
      tip(prepay, 'Prepay part or all of this bond', `${Math.round(BONDS.prepayPenalty * 100)}% penalty on the amount. The bond keeps its maturity with a lower payment, and bond room is freed at once.`);
      const refi = h('button', { class: 'hw-btn small', disabled: !q?.ok, onclick: () => app.refinanceBond(b.id) }, `Refinance at ${fmtRate(q?.rate ?? rate)}`);
      tip(refi, 'Refinance at today’s new-bond rate', q ? (q.ok ? refinanceText(q) : `${q.reason}. ${Math.round(BONDS.refinanceFee * 100)}% fee on the balance; the remaining term is kept.`) : '');
      list.append(h('div', { class: 'bond-row' }, h('div', { class: 'num' }, bondLine(b)), h('div', { class: 'acts' }, prepay, refi)));
    }
    content.append(list);
  };

  // ------------------------------------------------------------------ Fleet
  const fleet = () => {
    const routes = game.routes.list();
    const classes: TrackClass[] = (['heavy', 'light'] as TrackClass[]).filter((c) => c === 'heavy' || routes.some((r) => r.cls === c) || game.routes.spareCars[c] > 0);
    const plans = new Map(routes.map((r) => [r.id, fleetPlan(game, r)]));
    const table = h('table', { class: 'fleet' }, h('tr', null, h('th', null, 'Cars'), h('th', null, 'On routes'), h('th', null, 'Needed'), h('th', null, 'Idle'), h('th', null, 'Spare pool')));
    for (const c of classes) {
      const rs = routes.filter((r) => r.cls === c);
      const owned = rs.reduce((s, r) => s + r.ownedCars, 0);
      const needed = rs.reduce((s, r) => s + (plans.get(r.id)?.carsNeeded ?? 0), 0);
      const idle = rs.reduce((s, r) => s + (plans.get(r.id)?.idleCars ?? 0), 0);
      table.append(h('tr', null, h('td', null, c === 'heavy' ? 'Heavy metro' : 'Light metro'), h('td', null, String(owned)), h('td', null, String(needed)), h('td', { class: idle ? 'hw-amber' : '' }, String(idle)), h('td', { class: game.routes.spareCars[c] ? 'hw-amber' : '' }, String(game.routes.spareCars[c]))));
    }
    content.append(table, muted(`Used cars sell for ${Math.round((carSaleValue('heavy', 1) / TRAINS.heavy.costPerCar) * 100)}% of the new price (${fmtMoneyFine(carSaleValue('heavy', 1))} a heavy car${classes.includes('light') ? `, ${fmtMoneyFine(carSaleValue('light', 1))} a light car` : ''}). Maintenance is ${Math.round(ECONOMY.maintenanceRatePerYear * 100)}% of the new price a year.`));
    content.append(section('Spare pool'));
    let anySpare = false;
    for (const c of classes) {
      const n = game.routes.spareCars[c];
      if (!n) continue;
      anySpare = true;
      content.append(h('div', { style: 'margin:4px 0' }, h('button', { class: 'hw-btn small', onclick: () => app.sellSpareCars(c) }, `Sell spare ${c} cars (${n}) for ${fmtMoneyFine(carSaleValue(c, n))}`)));
    }
    if (!anySpare) content.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'No spare cars. Deleting a route puts its cars here.'));
    content.append(section('Idle cars on routes'));
    const idleList = h('div', { class: 'list' });
    for (const r of routes) {
      const n = plans.get(r.id)?.idleCars ?? 0;
      if (!n) continue;
      const trains = Math.floor(n / r.cars);
      idleList.append(
        h(
          'div',
          { class: 'list-item', style: 'cursor:default' },
          bullet(r.color, r.bullet, 20),
          h('span', { class: 'grow' }, r.name, h('div', { class: 'hw-muted', style: 'font-size:11.5px' }, `Idle: ${trains ? `${trains} train${trains > 1 ? 's' : ''} (${n} cars)` : `${n} cars`}`)),
          h('button', { class: 'hw-btn small', onclick: () => app.sellIdleCars(r.id) }, `Sell for ${fmtMoneyFine(carSaleValue(r.cls, n))}`),
        ),
      );
    }
    if (!idleList.children.length) idleList.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'No route owns more cars than its plan needs. Lower a frequency or shorten trains to free some.'));
    content.append(idleList, muted('Sold cars leave service. If a route needs them back, new ones cost full price.', 'font-size:11.5px;margin-top:10px'));
  };

  const setTab = (t: FinanceTab) => {
    if (app.financeTab === t) return;
    app.financeTab = t;
    render();
    sh.body.scrollTop = 0;
  };
  const render = () => {
    // Keyboard focus survives the rebuild on controls that name themselves (data-focus).
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && sh.el.contains(active) ? active.dataset.focus : undefined;
    charts.forEach((c) => c.destroy());
    charts = [];
    app.tooltip.show(null);
    tabs.replaceChildren(...TABS.map((t) => h('button', { class: t.id === app.financeTab ? 'on' : '', 'data-tab': t.id, 'data-focus': `tab-${t.id}`, onclick: () => setTab(t.id) }, t.label)));
    content.replaceChildren();
    if (app.financeTab === 'fares') fares();
    else if (app.financeTab === 'borrowing') borrowing();
    else if (app.financeTab === 'fleet') fleet();
    else overview();
    if (focusKey) [...sh.el.querySelectorAll<HTMLElement>('[data-focus]')].find((x) => x.dataset.focus === focusKey && !(x as HTMLInputElement).disabled)?.focus({ preventScroll: true });
  };
  render();
  return {
    el: sh.el,
    dayEnd: () => {
      const top = sh.body.scrollTop;
      render();
      sh.body.scrollTop = top;
    },
    destroy: () => charts.forEach((c) => c.destroy()),
  };
}
