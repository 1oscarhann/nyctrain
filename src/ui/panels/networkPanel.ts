/**
 * Routes & stations (N), full screen: every route in one table with one-click controls for how
 * often trains come (peak, midday, evening, night), how long they are and which train type, each
 * button priced on hover; and every station with how full it gets, its upgrade level and one-click
 * upgrades and car parks. "Map" opens the route or station panel beside the map.
 */
import { PARK_RIDE, STATION_CROWD, STATION_TIERS } from '../../balance';
import { fmtDate } from '../../core/calendar';
import { fmtCount, fmtDistance, fmtMoney } from '../../core/units';
import { MAX_TIER, nextTier, stationCapacity, tierCost, tierInfo, tierOf } from '../../construction/stationTiers';
import type { Station } from '../../construction/types';
import type { PeriodId, Route } from '../../routes/types';
import type { App } from '../app';
import { bullet, h, svgIcon } from '../dom';
import { ICONS } from '../icons';
import { quickPlan } from '../routeOps';
import { headwayStepper, lazyTip, refitButton, trainLengthStepper, trainTypePicker } from '../routeControls';
import { regularityTag } from '../opsMoney';
import { shell, statCard, type Panel } from './common';

export type NetworkTab = 'routes' | 'stations';
type StationSort = 'busiest' | 'boardings' | 'name' | 'level';
type StationFilter = 'all' | 'crowded' | 'upgrading';

/** Per-viewer UI state for the session. */
const ui: { stationSort: StationSort; stationFilter: StationFilter } = { stationSort: 'busiest', stationFilter: 'all' };

export function networkPanel(app: App, tab: NetworkTab = 'routes'): Panel {
  const game = app.game;
  const sh = shell('Your network', 'Routes & stations', () => game.select(null));
  const tabs = h('div', { class: 'seg fin-tabs' });
  const summary = h('div', { class: 'stat-grid mgr-summary' });
  const content = h('div');
  sh.body.append(tabs, summary, content);
  let current = tab;
  /** Live cells refreshed a few times a second (waiting counts). */
  let live: (() => void)[] = [];

  const setTab = (t: NetworkTab) => {
    current = t;
    game.select({ kind: 'routes', tab: t });
  };

  const renderSummary = () => {
    const routes = game.routes.list();
    const rep = app.report;
    const riders = rep?.riders ?? 0;
    const loads = Object.values(rep?.routePeakLoad ?? {});
    const worstLoad = loads.length ? Math.max(...loads) : 0;
    const built = [...game.network.stations.values()].filter((s) => s.status === 'built');
    const crowded = built.filter((s) => (rep?.stationPeak?.[s.id] ?? 0) > 1).length;
    const trains = routes.reduce((t, r) => t + quickPlan(game, r).trainsNeeded, 0);
    summary.replaceChildren(
      statCard('Routes', String(routes.length), undefined, `${trains} trains in service`),
      statCard('Riders yesterday', rep ? fmtCount(riders) : '—', undefined, 'journeys on your network'),
      statCard('Fullest route', loads.length ? `${Math.round(worstLoad * 100)}%` : '—', worstLoad > 1 ? 'red' : worstLoad > 0.85 ? 'amber' : undefined, 'of comfortable capacity, 8–9 am'),
      statCard('Stations', String(built.length), undefined, `${built.filter((s) => tierOf(s) > 0).length} upgraded`),
      statCard('Overcrowded stations', rep ? String(crowded) : '—', crowded ? 'red' : undefined, 'over capacity at their busiest yesterday'),
    );
  };

  // ------------------------------------------------------------------ Routes
  const stepper = (r: Route, label: string, periods: PeriodId[], allowOff: boolean) => headwayStepper(app, r, label, periods, allowOff, rerender);
  const carsStepper = (r: Route) => trainLengthStepper(app, r, rerender);
  const stockPicker = (r: Route) => trainTypePicker(app, r, rerender);

  const routesTab = () => {
    const routes = game.routes.list();
    if (!routes.length) {
      content.append(h('div', { class: 'mgr-empty' }, h('b', null, 'No routes yet.'), ' Use the Line tool (L) to click out a whole line with stations, or build track (T) and stations (S) and then a route (R).', h('div', { style: 'margin-top:10px' }, h('button', { class: 'hw-btn primary', onclick: () => app.setTool('line') }, 'Build a line'))));
      return;
    }
    const rep = app.report;
    const table = h('div', { class: 'mgr-table routes' });
    table.append(
      h('div', { class: 'mgr-row head' },
        h('div', null, 'Route'),
        h('div', null, 'Riders yesterday'),
        h('div', null, 'Fullest at peak'),
        h('div', null, 'Trains'),
        h('div', null, 'Train length'),
        h('div', null, 'Peak (6–10, 16–20)'),
        h('div', null, 'Midday'),
        h('div', null, 'Evening'),
        h('div', null, 'Night'),
        h('div', null, ''),
      ),
    );
    for (const r of routes) {
      const op = game.routes.operational(game.network, r);
      const load = rep?.routePeakLoad?.[r.id];
      const plan = quickPlan(game, r);
      const tag = regularityTag(rep?.routeRegularity?.[r.id]);
      const path = game.routes.path(game.network, r);
      const loadTone = load === undefined ? '' : load > 1 ? 'red' : load > 0.85 ? 'amber' : 'green';
      const loadCell = h('div', { class: 'load-cell' },
        h('div', { class: 'mini-bar' }, h('div', { class: `fill ${loadTone}`, style: { width: `${Math.min(100, (load ?? 0) * 100)}%` } })),
        h('span', { class: `num hw-${loadTone}` }, load !== undefined ? `${Math.round(load * 100)}%` : '—'),
      );
      if (load !== undefined) lazyTip(app, loadCell, () => ({ title: `${Math.round(load * 100)}% of comfortable capacity`, body: load > 1 ? 'Packed: run trains more often at peak or make them longer.' : load > 0.85 ? 'Busy but OK.' : 'Room to spare: you could run fewer trains and save money.' }));
      table.append(
        h('div', { class: `mgr-row${op.ok ? '' : ' warn-row'}` },
          h('div', { class: 'route-cell' },
            bullet(r.color, r.bullet, 26, r.express, r.shape),
            h('div', null,
              h('div', { class: 'name' }, r.name),
              h('div', { class: op.ok ? 'hw-muted sub' : 'hw-amber sub' }, op.ok ? `${r.stops.length} stops${path.ok ? ` · ${fmtDistance(path.length)}` : ''}${tag ? ' · ' : ''}` : op.reason ?? '', op.ok && tag ? h('span', { class: `hw-${tag.tone}` }, tag.text) : null),
            ),
          ),
          h('div', { class: 'num big' }, rep ? fmtCount(rep.routeRiders[r.id] ?? 0) : '—'),
          loadCell,
          h('div', null, stockPicker(r), refitButton(app, r, rerender) ?? h('div', { class: 'hw-muted sub' }, `${plan.trainsNeeded} trains · ${fmtCount(plan.carsNeeded)} cars`)),
          carsStepper(r),
          stepper(r, 'peak', ['am', 'pm'], false),
          stepper(r, 'midday', ['midday'], false),
          stepper(r, 'evening', ['evening'], false),
          stepper(r, 'no trains', ['night'], true),
          h('div', { class: 'row-actions' },
            h('button', { class: 'hw-btn small ghost icon-only', title: 'Show on the map', onclick: () => game.select({ kind: 'route', id: r.id }) }, svgIcon(ICONS.routes)),
          ),
        ),
      );
    }
    content.append(
      table,
      h('div', { class: 'mgr-foot' },
        h('span', { class: 'hw-muted' }, 'Changes apply at once and buy the trains they need. Hover a button to see what it costs. Fewer trains leave cars idle: sell them in Finances → Fleet.'),
        h('button', { class: 'hw-btn primary small', onclick: () => app.setTool('line') }, 'New line'),
      ),
    );
  };

  // ------------------------------------------------------------------ Stations
  const routesAt = (id: number) => game.routes.list().filter((r) => r.stops.includes(id));

  const upgradeCell = (s: Station) => {
    if (s.tierTo !== undefined && s.tierEnd !== undefined && s.tierStart !== undefined) {
      const pct = Math.max(0, Math.min(1, (game.time - s.tierStart) / Math.max(1, s.tierEnd - s.tierStart)));
      return h('div', { class: 'works' }, h('div', { class: 'mini-bar' }, h('div', { class: 'fill amber', style: { width: `${pct * 100}%` } })), h('span', { class: 'sub' }, `${tierInfo(s.tierTo).name} · opens ${fmtDate(Math.floor(s.tierEnd / 86400))}`));
    }
    const t = nextTier(s);
    if (t === null) return h('span', { class: 'hw-green sub' }, 'Top level');
    const cost = tierCost(game.network, s, t);
    const b = h('button', { class: 'hw-btn small primary', disabled: !game.finance.canAfford(cost), onclick: () => upgrade(s) }, `${tierInfo(t).name} · ${fmtMoney(cost)}`) as HTMLButtonElement;
    const info = tierInfo(t);
    lazyTip(app, b, () => ({ title: `Level ${t}: ${info.name}`, body: `${info.blurb}. Holds ${fmtCount(Math.round(stationCapacity(game.network, s) / tierInfo(tierOf(s)).capacity * info.capacity))} waiting (×${info.capacity}), boards ${Math.round((1 - info.boarding) * 100)}% faster, changes ${info.transferSave} s quicker.${game.sandbox ? '' : ` Works take ${info.days} days.`}` }));
    return b;
  };

  const upgrade = (s: Station) => {
    const r = game.upgradeStation(s.id);
    if (r.ok) app.toast(game.sandbox ? `${s.name} upgraded` : `Works started at ${s.name}`, `${fmtMoney(r.cost ?? 0)}`, 'green');
    else app.toast("Can't upgrade", r.reason, 'red');
    rerender();
  };

  const stationsTab = () => {
    const rep = app.report;
    const all = [...game.network.stations.values()].filter((s) => s.status === 'built');
    if (!all.length) {
      content.append(h('div', { class: 'mgr-empty' }, h('b', null, 'No stations open yet.'), ' Stations appear here once they are built.'));
      return;
    }
    const peak = (s: Station) => rep?.stationPeak?.[s.id] ?? 0;
    const boards = (s: Station) => rep?.stationBoardings[s.id] ?? 0;
    let list = all.filter((s) => (ui.stationFilter === 'crowded' ? peak(s) > 1 : ui.stationFilter === 'upgrading' ? s.tierTo !== undefined : true));
    const by: Record<StationSort, (a: Station, b: Station) => number> = {
      busiest: (a, b) => peak(b) - peak(a) || boards(b) - boards(a),
      boardings: (a, b) => boards(b) - boards(a),
      name: (a, b) => a.name.localeCompare(b.name),
      level: (a, b) => tierOf(b) - tierOf(a) || peak(b) - peak(a),
    };
    list = list.sort(by[ui.stationSort]);
    // Bulk: every overcrowded station that can go up a level.
    const crowded = all.filter((s) => peak(s) > 1 && nextTier(s) !== null);
    const bulkCost = crowded.reduce((t, s) => t + tierCost(game.network, s, nextTier(s)!), 0);
    const seg = <T extends string>(opts: [T, string][], cur: T, set: (v: T) => void) =>
      h('div', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { set(v); rerender(); } }, l)));
    content.append(
      h('div', { class: 'mgr-tools' },
        seg<StationFilter>([['all', `All ${all.length}`], ['crowded', `Overcrowded ${all.filter((s) => peak(s) > 1).length}`], ['upgrading', `Works ${all.filter((s) => s.tierTo !== undefined).length}`]], ui.stationFilter, (v) => (ui.stationFilter = v)),
        h('span', { class: 'hw-muted', style: 'margin-left:auto' }, 'Sort'),
        seg<StationSort>([['busiest', 'Fullest'], ['boardings', 'Busiest'], ['level', 'Level'], ['name', 'A–Z']], ui.stationSort, (v) => (ui.stationSort = v)),
        crowded.length
          ? h('button', { class: 'hw-btn small primary', disabled: !game.finance.canAfford(bulkCost), onclick: async () => {
              if (!(await app.confirm(`Upgrade ${crowded.length} overcrowded station${crowded.length > 1 ? 's' : ''}?`, `Each goes up one level, for ${fmtMoney(bulkCost)} in all.`, 'Upgrade them'))) return;
              let n = 0;
              for (const s of crowded) if (game.upgradeStation(s.id).ok) n++;
              app.toast(`${n} station upgrade${n === 1 ? '' : 's'} started`, fmtMoney(bulkCost), 'green');
              rerender();
            } }, `Upgrade all overcrowded · ${fmtMoney(bulkCost)}`)
          : null,
      ),
    );
    if (!list.length) {
      content.append(h('div', { class: 'mgr-empty' }, ui.stationFilter === 'crowded' ? 'No station was over capacity yesterday. Nice.' : 'No works under way.'));
      return;
    }
    const table = h('div', { class: 'mgr-table stations' });
    table.append(
      h('div', { class: 'mgr-row head' },
        h('div', null, 'Station'),
        h('div', null, 'Level'),
        h('div', null, 'Waiting now'),
        h('div', null, 'Fullest yesterday'),
        h('div', null, 'Boarded yesterday'),
        h('div', null, 'Upgrade'),
        h('div', null, 'Car park'),
        h('div', null, ''),
      ),
    );
    for (const s of list) {
      const tier = tierOf(s);
      const p = peak(s);
      const pTone = p > 1 ? 'red' : p > STATION_CROWD.warnAt * 0.6 ? 'amber' : 'green';
      const waitFill = h('div', { class: 'fill' });
      const waitText = h('span', { class: 'num sub' });
      const refresh = () => {
        const cap = stationCapacity(game.network, s);
        const w = app.waitingAt(s.id);
        const f = cap ? w / cap : 0;
        waitFill.className = `fill ${f > 1 ? 'red' : f > 0.75 ? 'amber' : 'green'}`;
        waitFill.style.width = `${Math.min(100, f * 100)}%`;
        waitText.textContent = `${fmtCount(w)} / ${fmtCount(cap)}`;
      };
      refresh();
      live.push(refresh);
      const pips = h('div', { class: 'pips' }, ...STATION_TIERS.slice(1).map((_, i) => h('span', { class: i < tier ? 'on' : s.tierTo === i + 1 ? 'building' : '' })));
      const spaces = s.parking ?? 0;
      const addN = PARK_RIDE.buildChoices.find((n) => spaces + n <= PARK_RIDE.maxSpaces);
      table.append(
        h('div', { class: 'mgr-row' },
          h('div', { class: 'route-cell' },
            h('div', null,
              h('div', { class: 'name' }, s.name),
              h('div', { class: 'sub' }, ...routesAt(s.id).map((r) => bullet(r.color, r.bullet, 16, r.express, r.shape)), routesAt(s.id).length ? null : h('span', { class: 'hw-amber' }, 'No route yet ·'), h('span', { class: 'hw-muted' }, ` ${game.network.stationLevel(s).replace('-', ' ')} · ${s.cars}-car`)),
            ),
          ),
          h('div', null, pips, h('div', { class: 'sub' }, tierInfo(tier).name)),
          h('div', { class: 'load-cell' }, h('div', { class: 'mini-bar' }, waitFill), waitText),
          h('div', null, h('div', { class: `num big ${rep && p > 0 ? `hw-${pTone}` : 'hw-muted'}` }, rep && p > 0 ? `${Math.round(p * 100)}%` : rep ? 'quiet' : '—'), rep?.stationTurnedAway?.[s.id] ? h('div', { class: 'sub hw-red' }, `${fmtCount(rep.stationTurnedAway[s.id])} turned away`) : null),
          h('div', { class: 'num' }, rep ? fmtCount(boards(s)) : '—'),
          upgradeCell(s),
          h('div', null,
            h('div', { class: 'sub' }, spaces ? `${fmtCount(spaces)} spaces` : 'None'),
            addN
              ? h('button', { class: 'hw-btn small ghost', onclick: () => {
                  const res = game.addParking(s.id, addN);
                  if (res.ok) app.toast(`Car park at ${s.name}`, `+${addN} spaces · ${fmtMoney(res.cost ?? 0)}`, 'green');
                  else app.toast("Can't build the car park", res.reason, 'red');
                  rerender();
                } }, `+${addN} · ${fmtMoney(addN * PARK_RIDE.costPerSpace)}`)
              : null,
          ),
          h('div', { class: 'row-actions' }, h('button', { class: 'hw-btn small ghost icon-only', title: 'Show on the map', onclick: () => game.select({ kind: 'station', id: s.id }) }, svgIcon(ICONS.station))),
        ),
      );
    }
    content.append(table, h('div', { class: 'mgr-foot' }, h('span', { class: 'hw-muted' }, `Up to level ${MAX_TIER}: each level holds more people, boards faster and makes changes quicker. ${game.sandbox ? 'Upgrades are instant in Sandbox.' : 'Works take weeks; the platforms hold a bit less meanwhile.'}`)));
  };

  const rerender = () => {
    const top = sh.body.scrollTop;
    live = [];
    app.tooltip.show(null);
    tabs.replaceChildren(
      h('button', { class: current === 'routes' ? 'on' : '', onclick: () => setTab('routes') }, `Routes (${game.routes.list().length})`),
      h('button', { class: current === 'stations' ? 'on' : '', onclick: () => setTab('stations') }, `Stations (${[...game.network.stations.values()].filter((s) => s.status === 'built').length})`),
    );
    renderSummary();
    content.replaceChildren();
    if (current === 'stations') stationsTab();
    else routesTab();
    sh.body.scrollTop = top;
  };
  rerender();
  let tick = 0;
  return {
    el: sh.el,
    full: true,
    update: () => {
      for (const f of live) f();
      // Works progress bars and affordability move with time and money: a light rebuild every few seconds.
      if (++tick % 20 === 0 && current === 'stations' && !sh.el.matches(':hover')) rerender();
    },
    dayEnd: () => rerender(),
  };
}
