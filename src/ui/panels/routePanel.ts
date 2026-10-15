/**
 * Route panel (daily ridership, service regularity, peak-hour load profile per segment and
 * direction, trains in service, lateness, the frequency, train length and operations control
 * editor, timepoints in the stop list) and the route editor used by the route tool.
 */
import { OPERATIONS, OPS_CONTROL, STATION, TRAINS } from '../../balance';
import { cap } from '../../construction/describe';
import { fmtClock, fmtCount, fmtDistance, fmtMinutes, fmtMoney } from '../../core/units';
import { describeAlert, shortDate } from '../alertFeed';
import { trainsNeeded } from '../../routes/compile';
import { suggestTimepoints } from '../../routes/control';
import { carSaleValue, fleetPlan, purchaseFleet } from '../../routes/fleet';
import type { RouteTool } from '../../routes/routeTool';
import { maxCarsFor } from '../../routes/routeSet';
import { PERIOD_IDS, ROUTE_COLORS, type PeriodId, type Route, type RouteControl } from '../../routes/types';
import type { RouteRegularityDetail } from '../../sim/protocol';
import type { App } from '../app';
import { loadChart, regularityChart } from '../charts';
import { bullet, h, svgIcon } from '../dom';
import { ICONS } from '../icons';
import { draftOf, fmtMoneyFine, HOLD_TIP, LATENESS_TIP, mergeDraft, RECOVERY_TIP, recoveryAdvice, regularityCards, regularityTag, regularityWithReport, TIMEPOINT_TIP, type RouteDraft } from '../opsMoney';
import { attachTip } from '../widgets';
import { kv, section, shell, statCard, type Panel } from './common';

interface RouteDetail {
  dirs: { stations: string[]; load: number[]; capacity: number[] }[];
  /** Loads are yesterday's (else today's so far). */
  yesterday: boolean;
  ridersToday: number;
  ridersYesterday: number;
  inService: number;
  /** Operations control (v2): headway regularity (null when the route isn't in the compiled network). */
  regularity?: RouteRegularityDetail | null;
}

const PERIOD_LABEL: Record<PeriodId, string> = { night: 'Night 0–6', am: 'AM peak 6–10', midday: 'Midday 10–16', pm: 'PM peak 16–20', evening: 'Evening 20–24' };

/** Frequency table: "every X min" per period; night can be switched off. */
function frequencyTable(headways: Record<PeriodId, number>, onChange: (p: PeriodId, v: number) => void): HTMLElement {
  const t = h('table', { class: 'freq' });
  for (const p of PERIOD_IDS) {
    const sel = h('select', { onchange: (e: Event) => onChange(p, Number((e.target as HTMLSelectElement).value)) }) as HTMLSelectElement;
    if (p === 'night') sel.append(h('option', { value: '0' }, 'No service'));
    for (const m of OPERATIONS.headwayChoices) sel.append(h('option', { value: String(m) }, `every ${m} min`));
    sel.value = String(headways[p]);
    if (sel.value === '' && headways[p] > 0) {
      sel.append(h('option', { value: String(headways[p]) }, `every ${headways[p]} min`));
      sel.value = String(headways[p]);
    }
    t.append(h('tr', null, h('td', { class: 'hw-muted' }, PERIOD_LABEL[p]), h('td', null, sel)));
  }
  return t;
}

function carsPicker(min: number, max: number, value: number, onChange: (c: number) => void): HTMLElement {
  const seg = h('div', { class: 'seg' });
  for (let c = min; c <= max; c++) seg.append(h('button', { class: c === value ? 'on' : '', onclick: () => onChange(c) }, String(c)));
  return seg;
}

/** A segmented control over numeric choices. */
function choiceSeg(choices: readonly number[], value: number, label: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const seg = h('div', { class: 'seg' });
  for (const c of choices) seg.append(h('button', { class: Math.abs(c - value) < 1e-9 ? 'on' : '', onclick: () => onChange(c) }, label(c)));
  return seg;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Fleet sizing for a route (or a draft of it): run time, round trip with recovery, trains needed
 * and owned, what must be bought, and idle cars. `sell` (the route panel, with nothing unapplied)
 * offers the idle cars for sale.
 */
function fleetLine(app: App, r: Route, opts: { sell?: boolean; dirty?: boolean } = {}): HTMLElement {
  const plan = fleetPlan(app.game, r);
  if (!plan.runTimes) return h('div', { class: 'hw-muted' }, 'Trains needed: — (no path yet)');
  const owned = Math.floor(r.ownedCars / r.cars);
  const rows: [string, string][] = [['One-way run time', fmtMinutes(plan.runTimes[0])]];
  if (plan.recovery > 0) rows.push(['Recovery', `${(plan.recovery / 60).toFixed(1)} min × 2`]);
  rows.push(['Round trip', fmtMinutes(plan.roundTrip)], ['Trains needed', `${plan.trainsNeeded} (incl. ${OPERATIONS.spareTrains} spare)`], ['Trains owned', String(owned)]);
  let idle: HTMLElement | null = null;
  if (plan.idleCars > 0) {
    const trains = Math.floor(plan.idleCars / r.cars);
    const what = trains ? `${trains} train${trains > 1 ? 's' : ''} (${plan.idleCars} cars)` : `${plan.idleCars} cars`;
    idle = h(
      'div',
      { class: 'ev-service', style: 'margin-top:6px' },
      h('span', { class: 'grow hw-muted' }, `Idle: ${what}${opts.dirty ? ' · Apply first to sell' : ''}`),
      opts.sell && !opts.dirty ? h('button', { class: 'hw-btn small', onclick: () => app.sellIdleCars(r.id) }, `Sell for ${fmtMoneyFine(carSaleValue(r.cls, plan.idleCars))}`) : null,
    );
  }
  return h(
    'div',
    null,
    kv(rows),
    idle,
    plan.carsToBuy > 0
      ? h('div', { class: app.game.finance.canAfford(plan.cost) ? 'warn' : 'err' }, `Needs ${plan.carsToBuy} more cars · ${fmtMoney(plan.cost)}${plan.fromSpare ? ` (plus ${plan.fromSpare} spare)` : ''}`)
      : plan.fromSpare > 0
        ? h('div', { class: 'warn' }, `Uses ${plan.fromSpare} spare cars from deleted routes`)
        : null,
  );
}

export function routePanel(app: App, id: number, carry?: unknown): Panel {
  const game = app.game;
  const r = game.routes.get(id);
  if (!r) return { el: document.createElement('div') };
  const net = game.network;
  const path = game.routes.path(net, r);
  const op = game.routes.operational(net, r);
  const sh = shell(`Route · ${cap(r.cls)} metro · ${r.cars} cars`, r.name, () => game.select(null), bullet(r.color, r.bullet, 34));
  const body = sh.body;
  const tip = (el: HTMLElement, title: string, text?: string, key?: string) => attachTip(el, app.tooltip, title, key, text);
  if (!op.ok) body.append(h('div', { class: path.ok ? 'warn' : 'err' }, op.reason ?? 'Not running'));
  // City chaos: incidents on this route right now.
  const incidents = h('div');
  const renderIncidents = () => {
    incidents.replaceChildren(
      ...app.feed.activeOnRoute(r.id).map((a) => {
        const t = describeAlert(a, app.routeRef);
        return h('div', { class: a.severity === 3 ? 'err' : 'warn', style: 'cursor:pointer', onclick: () => game.select({ kind: 'alerts', focus: a.id }) }, h('b', null, t.title), ` · ${t.when}`);
      }),
    );
  };
  renderIncidents();
  const stats = h('div', { class: 'stat-grid', style: 'margin-top:6px' });
  body.append(incidents, stats);

  // ---- the draft: frequency, train length and operations control are applied together
  const base = draftOf(r);
  const prev = carry as { id: number; base: RouteDraft; draft: RouteDraft } | undefined;
  const draft: RouteDraft = prev && prev.id === r.id ? mergeDraft(prev.base, prev.draft, r) : draftOf(r);
  const sameControl = (a: RouteControl, b: RouteControl) => JSON.stringify({ ...a, timepoints: [...a.timepoints].sort() }) === JSON.stringify({ ...b, timepoints: [...b.timepoints].sort() });
  const dirty = () => draft.cars !== r.cars || PERIOD_IDS.some((p) => draft.headways[p] !== r.headways[p]) || !sameControl(draft.control, r.control);
  const draftRoute = (): Route => ({ ...r, headways: draft.headways, cars: draft.cars, control: draft.control });

  // Stops (with timepoint toggles while holding is on)
  const stops = h('div', { class: 'list', style: 'margin-top:4px' });
  const renderStops = () => {
    stops.replaceChildren();
    r.stops.forEach((sid, i) => {
      const s = net.stations.get(sid);
      if (!s) return;
      const others = game.routes.list().filter((o) => o.id !== r.id && o.stops.includes(sid));
      const mid = i > 0 && i < r.stops.length - 1;
      const on = draft.control.timepoints.includes(sid);
      let toggle: HTMLElement | null = null;
      if (mid && draft.control.hold) {
        toggle = h(
          'button',
          {
            class: `tp-toggle${on ? ' on' : ''}`,
            'aria-pressed': on ? 'true' : 'false',
            'aria-label': `Timepoint at ${s.name}`,
            onclick: (e: Event) => {
              e.stopPropagation();
              const tps = draft.control.timepoints;
              draft.control.timepoints = on ? tps.filter((x) => x !== sid) : r.stops.filter((x) => x === sid || tps.includes(x));
              renderStops();
              renderOps();
              renderFoot();
            },
          },
          svgIcon(ICONS.clock),
        );
        tip(toggle, on ? `Timepoint at ${s.name}` : `Make ${s.name} a timepoint`, TIMEPOINT_TIP);
      }
      stops.append(
        h(
          'div',
          { class: `list-item${on && draft.control.hold ? ' tp-on' : ''}`, onclick: () => game.select({ kind: 'station', id: sid }) },
          h('span', { class: 'hw-muted num', style: 'width:18px' }, String(i + 1)),
          h('span', { class: 'grow' }, s.name),
          ...others.map((o) => bullet(o.color, o.bullet, 16)),
          toggle,
        ),
      );
    });
  };

  // Service regularity and the load profile
  const reg = h('div');
  const charts = h('div');
  body.append(reg, section('Peak-hour load (8–9 am)'), charts);

  // Frequency editor
  const fleetWrap = h('div');
  const maxCars = maxCarsFor(net, r);
  const carsWrap = h('div');
  const renderCars = () => carsWrap.replaceChildren(carsPicker(TRAINS[r.cls].minCars, Math.max(TRAINS[r.cls].minCars, maxCars), draft.cars, (c) => { draft.cars = c; renderCars(); changed(); }));
  const renderFleet = () => fleetWrap.replaceChildren(fleetLine(app, draftRoute(), { sell: true, dirty: dirty() }));

  // Operations control (§2.1)
  let detail: RouteDetail | null = null;
  // Yesterday's regularity: the worker's, or the saved last report's after a load (see regularityWithReport).
  const runTimes = fleetPlan(game, r).runTimes;
  const regDetail = () => regularityWithReport(detail?.regularity, app.report?.routeRegularity?.[r.id], runTimes ? (runTimes[0] + runTimes[1]) / 2 : null);
  const ops = h('div');
  const renderOps = () => {
    const c = draft.control;
    const hold = choiceSeg([0, 1], c.hold ? 1 : 0, (v) => (v ? 'On' : 'Off'), (v) => { c.hold = v === 1; renderOps(); renderStops(); changed(); });
    const holdLbl = h('span', { class: 'lbl' }, 'Holding');
    tip(holdLbl, 'Holding', HOLD_TIP, 'H');
    tip(hold, 'Holding', HOLD_TIP, 'H');
    const rows: HTMLElement[] = [h('div', { class: 'ops-row' }, holdLbl, h('div', { class: 'ctl' }, hold))];
    if (c.hold) {
      const thr = choiceSeg(OPS_CONTROL.holdFractionChoices, c.holdFraction, (v) => String(Math.round(v * 100)), (v) => { c.holdFraction = v; renderOps(); changed(); });
      rows.push(
        h(
          'div',
          { class: 'ops-row' },
          h('span', { class: 'lbl' }, 'Threshold'),
          h('div', { class: 'ctl' }, thr, h('span', { class: 'hw-muted' }, '% of headway')),
          h('div', { class: 'note' }, `Trains wait while the gap to the one ahead is under ${pct(c.holdFraction)} of the headway: at the first stop, and up to ${OPS_CONTROL.maxHoldPerStop} s at timepoints.`),
        ),
      );
    }
    // Recovery
    const plan = fleetPlan(game, draftRoute());
    const rec = choiceSeg(OPS_CONTROL.recoveryChoices, c.recoveryPct, (v) => pct(v), (v) => { c.recoveryPct = v; renderOps(); changed(); });
    const recLbl = h('span', { class: 'lbl' }, 'Recovery');
    tip(recLbl, 'Recovery time', RECOVERY_TIP);
    tip(rec, 'Recovery time', RECOVERY_TIP);
    let recNote = 'No slack in the timetable';
    if (plan.runTimes && c.recoveryPct > 0) {
      const extra = plan.trainsNeeded - trainsNeeded({ headways: draft.headways, control: { recoveryPct: 0 } }, plan.runTimes);
      recNote = `≈ ${(plan.recovery / 60).toFixed(1)} min per terminal · ${extra > 0 ? `+${extra} train${extra > 1 ? 's' : ''}` : 'no extra trains'}`;
    }
    const advice = recoveryAdvice(regDetail(), c.recoveryPct);
    rows.push(h('div', { class: 'ops-row' }, recLbl, h('div', { class: 'ctl' }, rec), h('div', { class: 'note' }, recNote), advice ? h('div', { class: 'note advice' }, advice) : null));
    // Timepoints
    if (c.hold) {
      const names = c.timepoints.map((sid) => net.stations.get(sid)?.name ?? '?');
      const suggest = h('button', {
        class: 'hw-btn small',
        onclick: () => {
          c.timepoints = suggestTimepoints({ id: r.id, stops: r.stops }, game.routes.list());
          renderOps();
          renderStops();
          changed();
        },
      }, 'Suggest');
      tip(suggest, 'Suggest timepoints', `Stops near ⅓ and ⅔ along the line, preferring stops no other route serves.`);
      const clear = h('button', { class: 'hw-btn small ghost', disabled: !c.timepoints.length, onclick: () => { c.timepoints = []; renderOps(); renderStops(); changed(); } }, 'Clear');
      const tpLbl = h('span', { class: 'lbl' }, 'Timepoints');
      tip(tpLbl, 'Timepoints', `${TIMEPOINT_TIP}. Toggle the clock next to a stop below.`);
      rows.push(
        h(
          'div',
          { class: 'ops-row' },
          tpLbl,
          h('div', { class: 'ctl' }, h('span', { class: names.length ? '' : 'hw-muted', style: 'flex:1;min-width:0' }, names.length ? `${names.length} · ${names.join(', ')}` : 'None'), suggest, clear),
          r.stops.length < 3 ? h('div', { class: 'note' }, 'A route needs a stop between its terminals for a timepoint.') : null,
        ),
      );
    }
    ops.replaceChildren(...rows);
  };

  // Footer: Apply commits frequency, train length and operations together.
  const footNote = h('span', { class: 'grow' });
  const revert = h('button', {
    class: 'hw-btn small ghost',
    onclick: () => {
      draft.headways = { ...r.headways };
      draft.cars = r.cars;
      draft.control = structuredClone(r.control);
      game.select({ kind: 'route', id: r.id });
    },
  }, 'Revert');
  const apply = h('button', {
    class: 'hw-btn small',
    onclick: () => {
      const before = { headways: { ...r.headways }, cars: r.cars, control: structuredClone(r.control) };
      game.routes.update(r.id, { headways: { ...draft.headways }, cars: draft.cars, control: structuredClone(draft.control) });
      const res = purchaseFleet(game, r);
      if (!res.ok) {
        game.routes.update(r.id, before);
        app.toast("Can't afford the trains", `${fmtMoney(res.cost)} needed`, 'red');
        return;
      }
      if (res.cost) app.toast('Trains bought', fmtMoney(res.cost), 'amber');
      game.events.emit('routes', undefined);
      game.select({ kind: 'route', id: r.id });
    },
  }, 'Apply');
  const foot = h('div', { class: 'side-foot' }, footNote, revert, apply);
  const renderFoot = () => {
    const d = dirty();
    footNote.className = `grow ${d ? 'dirty' : 'hw-muted'}`;
    footNote.textContent = d ? 'Changes not applied yet' : 'Frequency, train length and operations';
    apply.className = `hw-btn small${d ? ' primary' : ''}`;
    revert.style.display = d ? '' : 'none';
  };
  function changed(): void {
    renderFleet();
    renderFoot();
  }

  renderCars();
  renderFleet();
  renderOps();
  renderStops();
  renderFoot();
  // Event service planned on this route (temporary headway overrides).
  const service = h('div');
  // Only service still to run or running (ended windows go at 3 am and midnight).
  const liveService = () => game.chaos.service.filter((o) => o.routeId === r.id && o.to > app.sim.time()).sort((a, b) => a.from - b.from);
  let serviceKey = '';
  const renderService = () => {
    const list = liveService();
    serviceKey = list.map((o) => o.id).join(',');
    service.replaceChildren(
      ...list.map((o) =>
        h(
          'div',
          { class: 'ev-service' },
          h('span', { class: 'grow' }, h('span', { class: 'hw-muted' }, `Event service ${Math.floor(o.from / 86400) === game.day ? 'today' : shortDate(Math.floor(o.from / 86400))}: `), `${fmtClock(o.from)}–${fmtClock(o.to)} every ${o.headwayMin} min`),
          h('button', { class: 'hw-btn ghost small', onclick: () => { app.removeEventService(o.id); renderService(); } }, 'Remove'),
        ),
      ),
    );
  };
  renderService();
  body.append(
    section('Frequency'),
    service,
    frequencyTable(draft.headways, (p, v) => { draft.headways[p] = v; changed(); }),
    section('Train length'),
    carsWrap,
    section('Operations'),
    ops,
    h('div', { style: 'margin-top:8px' }, fleetWrap),
    section(`Stops (${r.stops.length}) · ${fmtDistance(path.length || 0)}`),
    stops,
    h(
      'div',
      { style: 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap' },
      h('button', { class: 'hw-btn small', onclick: () => app.editRouteStops(r.id) }, 'Edit stops & style'),
      h('button', {
        class: 'hw-btn small danger',
        onclick: async () => {
          if (await app.confirm(`Delete route ${r.bullet}?`, 'Its cars go to a spare pool (still costing maintenance) and are reused before new ones are bought. Spare cars can be sold in Finances → Fleet.', 'Delete', true)) {
            game.routes.remove(r.id);
            game.events.emit('routes', undefined);
            game.select(null);
          }
        },
      }, 'Delete route'),
    ),
  );
  sh.el.append(foot);

  let chartObjs: { destroy(): void }[] = [];
  const renderStats = () => {
    const lateness = app.report?.routeLateness[r.id];
    const late = statCard('Avg lateness', lateness !== undefined ? `${Math.round(lateness)} s` : '—', lateness !== undefined && lateness > 120 ? 'red' : lateness !== undefined && lateness > 45 ? 'amber' : undefined);
    tip(late, 'Average lateness (yesterday)', LATENESS_TIP);
    stats.replaceChildren(
      statCard('Riders yesterday', fmtCount(detail?.ridersYesterday ?? app.report?.routeRiders[r.id] ?? 0)),
      statCard('Riders today', fmtCount(detail?.ridersToday ?? 0)),
      statCard('Trains in service', `${detail?.inService ?? 0} / ${Math.floor(r.ownedCars / r.cars)}`),
      late,
    );
  };
  const renderReg = () => {
    const d = regDetail();
    const s = d ? (d.yesterday ?? d.today) : null;
    reg.replaceChildren();
    if (!op.ok) return;
    reg.append(section(`Service regularity${d ? (d.yesterday ? ' · yesterday' : ' · today so far') : ''}`));
    const grid = h('div', { class: 'stat-grid' });
    for (const c of regularityCards(s)) {
      const card = statCard(c.label, c.value, c.tone);
      tip(card, c.label, c.tip);
      grid.append(card);
    }
    reg.append(grid);
    if (!d || !detail) {
      reg.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px;margin-top:4px' }, 'Gaps between trains are measured at every departure.'));
      return;
    }
    const stopNames = detail.dirs[0]?.stations ?? [];
    const has = d.cvByStop[0].some((v) => v >= 0) || d.cvByStop[1].some((v) => v >= 0);
    reg.append(h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:8px' }, `Headway spread along the line (CV by stop${d.fromReport ? ', today so far' : ''})`));
    if (has && stopNames.length) {
      const wrap = h('div', { class: 'chart' });
      reg.append(wrap);
      const first = stopNames[0];
      const last = stopNames[stopNames.length - 1];
      chartObjs.push(regularityChart(wrap, stopNames, d.cvByStop[0], d.cvByStop[1], [`Towards ${last}`, `Towards ${first}`], OPS_CONTROL.cvGood));
    } else reg.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'Appears once a few trains have left each stop.'));
    const tps = d.timepoints.map((k) => stopNames[k]).filter(Boolean);
    const holdText = d.hold ? `holding at ${pct(d.hold)}` : 'holding off';
    reg.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:2px' }, `${tps.length ? `Timepoints: ${tps.join(', ')}` : 'No timepoints'} · ${holdText}${d.shortTurns ? ` · ${d.shortTurns} short turnarounds today` : ''}`));
  };
  const renderCharts = () => {
    chartObjs.forEach((c) => c.destroy());
    chartObjs = [];
    renderReg();
    charts.replaceChildren();
    if (!detail) {
      charts.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, op.ok ? 'Load profile appears after the first morning rush.' : 'Not running yet.'));
      return;
    }
    charts.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px' }, detail.yesterday ? 'Yesterday' : 'Today so far'));
    detail.dirs.forEach((d) => {
      const terminal = d.stations[d.stations.length - 1];
      const wrap = h('div', { class: 'chart' });
      charts.append(h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:6px' }, `Towards ${terminal}`), wrap);
      chartObjs.push(loadChart(wrap, d.load, d.capacity, r.color, (i) => `${d.stations[i]} → ${d.stations[i + 1]}`));
    });
  };
  const fetch = () => {
    if (!op.ok) return;
    app.sim.query<RouteDetail | null>({ kind: 'route', route: r.id }).then((d) => {
      const hadAdvice = recoveryAdvice(regDetail(), draft.control.recoveryPct);
      detail = d;
      renderStats();
      renderCharts();
      if (recoveryAdvice(regDetail(), draft.control.recoveryPct) !== hadAdvice) renderOps();
    });
  };
  renderStats();
  renderCharts();
  fetch();
  let tick = 0;
  let feedVersion = app.feed.version;
  return {
    el: sh.el,
    update: () => {
      if (++tick % 10 === 0) fetch();
      if (app.feed.version !== feedVersion) {
        feedVersion = app.feed.version;
        renderIncidents();
        renderService();
      } else if (liveService().map((o) => o.id).join(',') !== serviceKey) renderService();
    },
    dayEnd: fetch,
    destroy: () => chartObjs.forEach((c) => c.destroy()),
    carry: () => ({ id: r.id, base, draft: structuredClone(draft) }),
  };
}

/** Editor for the route tool's draft (new route or editing stops/style of an existing one). */
export function routeEditor(app: App, tool: RouteTool): Panel {
  const d = tool.draft;
  const game = app.game;
  const sh = shell(d?.editing !== null && d ? 'Edit route' : 'New route', d?.name || 'Click stations in order', () => tool.cancel(), d ? bullet(d.color, d.bullet || '?', 34) : null);
  const body = sh.body;
  if (!d) return { el: sh.el };
  const net = game.network;
  body.append(h('div', { class: 'opt-hint' }, 'Click stations on the map in order. Click a stop again to remove it; Shift-click adds at the start. The path follows connected track automatically.'));
  // Stops
  const list = h('div', { class: 'list', style: 'margin:8px 0' });
  d.stops.forEach((sid, i) => {
    const s = net.stations.get(sid);
    list.append(h('div', { class: 'list-item' }, h('span', { class: 'hw-muted num', style: 'width:18px' }, String(i + 1)), h('span', { class: 'grow' }, s?.name ?? '?'), h('button', { class: 'hw-btn ghost small', onclick: () => { d.stops.splice(i, 1); tool.recompute(); } }, '✕')));
  });
  if (!d.stops.length) list.append(h('div', { class: 'hw-muted', style: 'padding:6px 0' }, 'No stations yet'));
  body.append(section(`Stops (${d.stops.length})`), list);
  if (tool.path && !tool.path.ok) body.append(h('div', { class: 'err' }, tool.path.error ?? 'No path'));
  else if (tool.path?.ok) body.append(h('div', { class: 'ok' }, `Path found · ${fmtDistance(tool.path.length)}`));
  // Name / bullet / colour
  const name = h('input', { type: 'text', value: d.name, placeholder: 'Route name', style: 'flex:1' }) as HTMLInputElement;
  name.addEventListener('input', () => { d.name = name.value; sh.titleEl.textContent = d.name || 'New route'; });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const bul = h('input', { type: 'text', value: d.bullet, maxlength: '2', style: 'width:52px;text-align:center;font-weight:800' }) as HTMLInputElement;
  bul.addEventListener('input', () => {
    d.bullet = bul.value.toUpperCase();
    const lead = sh.el.querySelector('.side-head .bullet');
    if (lead) lead.textContent = d.bullet || '?';
  });
  bul.addEventListener('keydown', (e) => e.stopPropagation());
  const colors = h('div', { class: 'color-grid' });
  for (const c of ROUTE_COLORS) colors.append(h('button', { class: c === d.color ? 'on' : '', style: { background: c }, title: c, onclick: () => { d.color = c; tool.recompute(); } }));
  body.append(section('Name and bullet'), h('div', { style: 'display:flex;gap:6px' }, name, bul), section('Colour'), colors);
  // Train length and frequency
  if (d.cls) {
    const maxCars = Math.min(STATION.cars[d.cls].max, ...d.stops.map((sid) => net.stations.get(sid)?.cars ?? 99));
    body.append(section('Train length'), carsPicker(TRAINS[d.cls].minCars, Math.max(TRAINS[d.cls].minCars, maxCars), d.cars, (c) => { d.cars = c; tool.recompute(); }));
  }
  const fleetWrap = h('div', { style: 'margin-top:8px' });
  const renderFleet = () => {
    const r = tool.asRoute();
    fleetWrap.replaceChildren(r && tool.path?.ok ? fleetLine(app, r) : h('div', { class: 'hw-muted' }, 'Trains needed appear once the path is found.'));
  };
  body.append(section('Frequency'), frequencyTable(d.headways, (p, v) => { d.headways[p] = v; renderFleet(); }), fleetWrap);
  renderFleet();
  const problems = tool.problems();
  const save = h('button', { class: 'hw-btn primary', disabled: problems.length > 0, onclick: () => tool.save() }, d.editing !== null ? 'Save changes' : 'Create route');
  body.append(
    problems.length ? h('div', { class: 'warn', style: 'margin-top:10px' }, problems[0]) : '',
    h('div', { style: 'display:flex;gap:6px;margin-top:10px' }, save, h('button', { class: 'hw-btn', onclick: () => tool.cancel() }, 'Cancel')),
  );
  return { el: sh.el };
}

export function routesList(app: App): Panel {
  const game = app.game;
  const sh = shell('Network', 'Routes', () => game.select(null));
  const list = h('div', { class: 'list' });
  const routes = game.routes.list();
  if (!routes.length) list.append(h('div', { class: 'hw-muted', style: 'padding:6px 0' }, 'No routes yet. Build track and stations, then use the route tool (R).'));
  for (const r of routes) {
    const op = game.routes.operational(game.network, r);
    // Regularity from yesterday's report (reports saved before operations control have none).
    const tag = regularityTag(app.report?.routeRegularity?.[r.id]);
    list.append(
      h(
        'div',
        { class: 'list-item', onclick: () => game.select({ kind: 'route', id: r.id }) },
        bullet(r.color, r.bullet, 24),
        h('span', { class: 'grow' }, r.name, h('div', { class: op.ok ? 'hw-muted' : 'hw-amber', style: 'font-size:11.5px' }, op.ok ? `${r.stops.length} stops` : op.reason ?? '', op.ok && tag ? h('span', { class: `hw-${tag.tone}` }, ` · ${tag.text}`) : null)),
        h('span', { class: 'num' }, fmtCount(app.report?.routeRiders[r.id] ?? 0)),
      ),
    );
  }
  sh.body.append(h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px' }, h('span', null, 'Route'), h('span', null, 'Riders yesterday')), list, h('button', { class: 'hw-btn primary small', style: 'margin-top:10px', onclick: () => app.setTool('route') }, 'New route'));
  return { el: sh.el, dayEnd: () => game.select({ kind: 'routes' }) };
}
