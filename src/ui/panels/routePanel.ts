/**
 * Route panel (daily ridership, peak-hour load profile per segment and direction, trains in
 * service, lateness, frequency editor) and the route editor used by the route tool.
 */
import { OPERATIONS, STATION, TRAINS } from '../../balance';
import { cap } from '../../construction/describe';
import { fmtClock, fmtCount, fmtDistance, fmtMinutes, fmtMoney } from '../../core/units';
import { describeAlert, shortDate } from '../alertFeed';
import { fleetPlan, purchaseFleet } from '../../routes/fleet';
import type { RouteTool } from '../../routes/routeTool';
import { maxCarsFor } from '../../routes/routeSet';
import { PERIOD_IDS, ROUTE_COLORS, type PeriodId, type Route } from '../../routes/types';
import type { App } from '../app';
import { loadChart } from '../charts';
import { bullet, h } from '../dom';
import { kv, section, shell, statCard, type Panel } from './common';

interface RouteDetail {
  dirs: { stations: string[]; load: number[]; capacity: number[] }[];
  /** Loads are yesterday's (else today's so far). */
  yesterday: boolean;
  ridersToday: number;
  ridersYesterday: number;
  inService: number;
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

function fleetLine(app: App, r: Route): HTMLElement {
  const plan = fleetPlan(app.game, r);
  if (!plan.runTimes) return h('div', { class: 'hw-muted' }, 'Trains needed: — (no path yet)');
  const rt = plan.runTimes[0] + plan.runTimes[1] + 2 * OPERATIONS.turnaround;
  const owned = Math.floor(r.ownedCars / r.cars);
  return h(
    'div',
    null,
    kv([
      ['One-way run time', fmtMinutes(plan.runTimes[0])],
      ['Round trip', fmtMinutes(rt)],
      ['Trains needed', `${plan.trainsNeeded} (incl. ${OPERATIONS.spareTrains} spare)`],
      ['Trains owned', String(owned)],
    ]),
    plan.carsToBuy > 0
      ? h('div', { class: app.game.finance.canAfford(plan.cost) ? 'warn' : 'err' }, `Needs ${plan.carsToBuy} more cars · ${fmtMoney(plan.cost)}${plan.fromSpare ? ` (plus ${plan.fromSpare} spare)` : ''}`)
      : plan.fromSpare > 0
        ? h('div', { class: 'warn' }, `Uses ${plan.fromSpare} spare cars from deleted routes`)
        : null,
  );
}

export function routePanel(app: App, id: number): Panel {
  const game = app.game;
  const r = game.routes.get(id);
  if (!r) return { el: document.createElement('div') };
  const net = game.network;
  const path = game.routes.path(net, r);
  const op = game.routes.operational(net, r);
  const sh = shell(`Route · ${cap(r.cls)} metro · ${r.cars} cars`, r.name, () => game.select(null), bullet(r.color, r.bullet, 34));
  const body = sh.body;
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

  // Stops
  const stops = h('div', { class: 'list', style: 'margin-top:4px' });
  r.stops.forEach((sid, i) => {
    const s = net.stations.get(sid);
    if (!s) return;
    const others = game.routes.list().filter((o) => o.id !== r.id && o.stops.includes(sid));
    stops.append(
      h(
        'div',
        { class: 'list-item', onclick: () => game.select({ kind: 'station', id: sid }) },
        h('span', { class: 'hw-muted num', style: 'width:18px' }, String(i + 1)),
        h('span', { class: 'grow' }, s.name),
        ...others.map((o) => bullet(o.color, o.bullet, 16)),
      ),
    );
  });
  const charts = h('div');
  body.append(section('Peak-hour load (8–9 am)'), charts);

  // Frequency editor
  const draft = { headways: { ...r.headways }, cars: r.cars };
  const fleetWrap = h('div');
  const maxCars = maxCarsFor(net, r);
  const carsWrap = h('div');
  const renderCars = () => carsWrap.replaceChildren(carsPicker(TRAINS[r.cls].minCars, Math.max(TRAINS[r.cls].minCars, maxCars), draft.cars, (c) => { draft.cars = c; renderCars(); renderFleet(); }));
  const renderFleet = () => fleetWrap.replaceChildren(fleetLine(app, { ...r, headways: draft.headways, cars: draft.cars }));
  const apply = h('button', {
    class: 'hw-btn primary small',
    onclick: () => {
      const before = { headways: { ...r.headways }, cars: r.cars };
      game.routes.update(r.id, { headways: { ...draft.headways }, cars: draft.cars });
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
  renderCars();
  renderFleet();
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
    frequencyTable(draft.headways, (p, v) => { draft.headways[p] = v; renderFleet(); }),
    section('Train length'),
    carsWrap,
    h('div', { style: 'margin-top:8px' }, fleetWrap),
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, apply),
    section(`Stops (${r.stops.length}) · ${fmtDistance(path.length || 0)}`),
    stops,
    h(
      'div',
      { style: 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap' },
      h('button', { class: 'hw-btn small', onclick: () => app.editRouteStops(r.id) }, 'Edit stops & style'),
      h('button', {
        class: 'hw-btn small danger',
        onclick: async () => {
          if (await app.confirm(`Delete route ${r.bullet}?`, 'Its cars go to a spare pool (still costing maintenance) and are reused before new ones are bought.', 'Delete', true)) {
            game.routes.remove(r.id);
            game.events.emit('routes', undefined);
            game.select(null);
          }
        },
      }, 'Delete route'),
    ),
  );

  let chartObjs: { destroy(): void }[] = [];
  let detail: RouteDetail | null = null;
  const renderStats = () => {
    const lateness = app.report?.routeLateness[r.id];
    stats.replaceChildren(
      statCard('Riders yesterday', fmtCount(detail?.ridersYesterday ?? app.report?.routeRiders[r.id] ?? 0)),
      statCard('Riders today', fmtCount(detail?.ridersToday ?? 0)),
      statCard('Trains in service', `${detail?.inService ?? 0} / ${Math.floor(r.ownedCars / r.cars)}`),
      statCard('Avg lateness', lateness !== undefined ? `${Math.round(lateness)} s` : '—', lateness !== undefined && lateness > 120 ? 'red' : lateness !== undefined && lateness > 45 ? 'amber' : undefined),
    );
  };
  const renderCharts = () => {
    chartObjs.forEach((c) => c.destroy());
    chartObjs = [];
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
      detail = d;
      renderStats();
      renderCharts();
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
    list.append(
      h(
        'div',
        { class: 'list-item', onclick: () => game.select({ kind: 'route', id: r.id }) },
        bullet(r.color, r.bullet, 24),
        h('span', { class: 'grow' }, r.name, h('div', { class: op.ok ? 'hw-muted' : 'hw-amber', style: 'font-size:11.5px' }, op.ok ? `${r.stops.length} stops` : op.reason ?? '')),
        h('span', { class: 'num' }, fmtCount(app.report?.routeRiders[r.id] ?? 0)),
      ),
    );
  }
  sh.body.append(h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px' }, h('span', null, 'Route'), h('span', null, 'Riders yesterday')), list, h('button', { class: 'hw-btn primary small', style: 'margin-top:10px', onclick: () => app.setTool('route') }, 'New route'));
  return { el: sh.el, dayEnd: () => game.select({ kind: 'routes' }) };
}
