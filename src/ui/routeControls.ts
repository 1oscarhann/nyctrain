/**
 * Route controls shared by the Routes & stations screen and the route panel: train type, train
 * length and how often trains come, each applied at once (buying trains as needed) and priced on
 * hover first.
 */
import { TRAINS, type StockId } from '../balance';
import { fmtCount, fmtMoney } from '../core/units';
import type { PeriodId, Route } from '../routes/types';
import type { App } from './app';
import { h } from './dom';
import { applyRouteChange, headwayText, perHour, previewRouteChange, stepHeadway, stockChoices, type RoutePatch } from './routeOps';

/** A hover tip whose text is worked out when the pointer arrives (prices change as you play). */
export function lazyTip(app: App, el: HTMLElement, f: () => { title: string; body?: string }): void {
  el.addEventListener('mouseenter', () => {
    const t = f();
    const r = el.getBoundingClientRect();
    app.tooltip.show(`<div class="title">${t.title}</div>${t.body ? `<div class="hw-muted">${t.body}</div>` : ''}`, [r.right - 8, r.top - 6]);
  });
  el.addEventListener('mouseleave', () => app.tooltip.show(null));
  el.addEventListener('mousedown', () => app.tooltip.show(null));
}

export function priceText(app: App, r: Route, p: RoutePatch): { title: string; body?: string } {
  const pv = previewRouteChange(app.game, r, p);
  if (!pv.ok) return { title: "Can't", body: pv.reason };
  const d = pv.trainsAfter - pv.trainsNow;
  const trains = d === 0 ? 'Same number of trains' : d > 0 ? `+${d} train${d > 1 ? 's' : ''} (${pv.trainsAfter} in all)` : `${d} train${d < -1 ? 's' : ''} (${pv.trainsAfter} in all)`;
  const money = pv.cost > 0 ? `Buys ${pv.carsToBuy} cars · ${fmtMoney(pv.cost)}` : pv.fromSpare > 0 ? `Uses ${pv.fromSpare} spare cars` : 'Nothing to buy';
  const idle = pv.idleAfter > 0 ? ` · ${pv.idleAfter} cars left idle (sell them in Finances → Fleet)` : '';
  return { title: trains, body: `${money}${idle}` };
}

/** How often trains come in some periods: − more often, + less often (night can go off), priced on hover. */
export function headwayStepper(app: App, r: Route, label: string, periods: PeriodId[], allowOff: boolean, after: () => void = () => {}): HTMLElement {
  const cur = Math.min(...periods.map((p) => r.headways[p] || Infinity));
  const curV = isFinite(cur) ? cur : 0;
  const patchFor = (dir: -1 | 1): RoutePatch | null => {
    const v = stepHeadway(curV, dir, allowOff);
    if (v === null) return null;
    return { headways: Object.fromEntries(periods.map((p) => [p, v])) as Partial<Record<PeriodId, number>> };
  };
  const btn = (dir: -1 | 1, text: string, hint: string) => {
    const p = patchFor(dir);
    const b = h('button', { class: 'hw-btn small step', disabled: !p, onclick: () => p && applyRouteChange(app, r.id, p) && after() }, text) as HTMLButtonElement;
    if (p) lazyTip(app, b, () => { const t = priceText(app, r, p); return { title: `${hint}: every ${headwayText(...Object.values(p.headways!))}`, body: `${t.title}. ${t.body ?? ''}` }; });
    return b;
  };
  return h('div', { class: 'stepper' },
    btn(-1, '−', 'More often'),
    h('div', { class: 'step-val' }, h('b', null, headwayText(...periods.map((p) => r.headways[p]))), h('span', null, curV ? `${perHour(curV)}/h` : label)),
    btn(1, '+', 'Less often'),
  );
}

/** Train length: − / + a car, priced on hover. */
export function trainLengthStepper(app: App, r: Route, after: () => void = () => {}): HTMLElement {
  const game = app.game;
  const btn = (d: -1 | 1) => {
    const p: RoutePatch = { cars: r.cars + d };
    const pv = previewRouteChange(game, r, p);
    const b = h('button', { class: 'hw-btn small step', disabled: !pv.ok, onclick: () => applyRouteChange(app, r.id, p) && after() }, d < 0 ? '−' : '+') as HTMLButtonElement;
    lazyTip(app, b, () => (pv.ok ? { title: `${r.cars + d}-car trains`, body: `${priceText(app, r, p).body} · ${fmtCount((r.cars + d) * TRAINS[r.stock].capacityComfort)} people a train` } : { title: "Can't", body: pv.reason }));
    return b;
  };
  return h('div', { class: 'stepper' }, btn(-1), h('div', { class: 'step-val' }, h('b', null, `${r.cars} cars`), h('span', null, `${fmtCount(r.cars * TRAINS[r.stock].capacityComfort)} a train`)), btn(1));
}

/** Train type for the route's track family (asks first: the old cars go to spares). */
export function trainTypePicker(app: App, r: Route, after: () => void = () => {}): HTMLSelectElement {
  const game = app.game;
  const sel = h('select', { class: 'mgr-select' }) as HTMLSelectElement;
  for (const s of stockChoices(r)) sel.append(h('option', { value: s }, `${TRAINS[s].name} · ${Math.round(TRAINS[s].topSpeed * 3.6)} km/h`));
  sel.value = r.stock;
  sel.addEventListener('change', async () => {
    const s = sel.value as StockId;
    const p: RoutePatch = { stock: s };
    const pv = previewRouteChange(game, r, p);
    if (!pv.ok) {
      app.toast("Can't switch trains", pv.reason, 'red');
      sel.value = r.stock;
      return;
    }
    const ok = await app.confirm(
      `Run ${TRAINS[s].name} trains on ${r.name}?`,
      `${TRAINS[s].blurb}. ${pv.cost > 0 ? `Buys ${pv.carsToBuy} cars for ${fmtMoney(pv.cost)}` : 'Nothing to buy'}${pv.fromSpare ? ` (and uses ${pv.fromSpare} spare)` : ''}. The ${r.ownedCars} ${TRAINS[r.stock].name} cars go to the spare pool: reuse them on another route or sell them in Finances → Fleet.`,
      'Switch trains',
    );
    if (ok && applyRouteChange(app, r.id, p)) after();
    else sel.value = r.stock;
  });
  return sel;
}

