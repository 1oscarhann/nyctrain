/**
 * Route panel (daily ridership, service regularity, peak-hour load profile per segment and
 * direction, trains in service, lateness, the frequency, train length and operations control
 * editor, timepoints in the stop list) and the route editor used by the route tool.
 *
 * Express service (v2, docs/v2/express-quad.md §2.3): the Service section (Local / Express, the
 * Express pattern and All stops buttons), the Line list (every station along the line, served or
 * skipped, with Skip / Stop here) and the Overtakes card.
 */
import { gaugeOf, OPERATIONS, OPS_CONTROL, stocksFor, TRAINS, type StockId } from '../../balance';
import { fmtClock, fmtCount, fmtDistance, fmtMinutes, fmtMoney, fmtSpeed } from '../../core/units';
import { describeAlert, shortDate } from '../alertFeed';
import { trainsNeeded } from '../../routes/compile';
import { suggestTimepoints } from '../../routes/control';
import { carSaleValue, fleetPlan, purchaseFleet } from '../../routes/fleet';
import type { RouteTool } from '../../routes/routeTool';
import { allStopsPattern, expressPattern, serveStops, skipStops, stationsAlongRoute, type AlongStation } from '../../routes/express';
import { lineRows, OVERTAKES_TIP, overtakesValue, pairWord, routeOnQuad, sameStopList, SERVICE_TIP, serviceEditNoop, skipsText, type LineRow } from '../express';
import { carsFitting, validStock } from '../../routes/routeSet';
import { BULLET_SHAPES, PERIOD_IDS, routePalette, type BulletShape, type PeriodId, type Route, type RouteControl } from '../../routes/types';
import { city } from '../../cities';
import type { RouteRegularityDetail } from '../../sim/protocol';
import type { App } from '../app';
import { loadChart, regularityChart } from '../charts';
import { headwayStepper, trainLengthStepper, trainTypePicker } from '../routeControls';
import { applyRouteChange } from '../routeOps';
import { bullet, h, svgIcon } from '../dom';
import { ICONS } from '../icons';
import { fmtMoneyFine, HOLD_TIP, LATENESS_TIP, RECOVERY_TIP, recoveryAdvice, regularityCards, regularityTag, regularityWithReport, TIMEPOINT_TIP } from '../opsMoney';
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
  /** Four-track sections (v2): overtakes of another route's train so far today (the worker's 'route' reply). */
  overtakesToday?: number;
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
function fleetLine(app: App, r: Route, opts: { sell?: boolean } = {}): HTMLElement {
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
      h('span', { class: 'grow hw-muted' }, `Idle: ${what}`),
      opts.sell ? h('button', { class: 'hw-btn small', onclick: () => app.sellIdleCars(r.id) }, `Sell for ${fmtMoneyFine(carSaleValue(r.cls, plan.idleCars))}`) : null,
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

export function routePanel(app: App, id: number): Panel {
  const game = app.game;
  const r = game.routes.get(id);
  if (!r) return { el: document.createElement('div') };
  const net = game.network;
  const path = game.routes.path(net, r);
  const op = game.routes.operational(net, r);
  const sh = shell(`Route · ${r.express ? 'Express · ' : ''}${TRAINS[r.stock].name} · ${r.cars} cars`, r.name, () => game.select(null), bullet(r.color, r.bullet, 34, r.express, r.shape));
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

  // ---- trains, frequency and operations all apply at once, the same as Routes & stations (N)
  const c: RouteControl = structuredClone(r.control);
  /** Commit the operations settings now (recovery can need more trains: bought, or refused with a toast). */
  const commitControl = () => {
    if (!applyRouteChange(app, r.id, { control: structuredClone(c) })) {
      Object.assign(c, structuredClone(r.control));
      renderOps();
      renderStops();
    }
  };

  // The Line list (v2): every station along the line in direction-0 order, served or skipped,
  // with timepoint toggles on served stops while holding is on.
  const along: AlongStation[] = path.ok ? stationsAlongRoute(net, r.id, r.stops, path) : [];
  const stopS = path.ok ? path.stopS : [];
  const inLine = (a: AlongStation) => a.served || (a.s >= (stopS[0] ?? 0) - 1 && a.s <= (stopS[stopS.length - 1] ?? Infinity) + 1);
  const rows: LineRow[] = lineRows(net, r, game.routes.list(), along.filter(inLine));
  const skipped = rows.filter((x) => !x.served).length;
  const stops = h('div', { class: 'list line-list', style: `margin-top:4px;--rc:${r.color}` });
  const renderStops = () => {
    stops.replaceChildren();
    const timepointToggle = (sid: number, name: string, i: number) => {
      const mid = i > 0 && i < r.stops.length - 1;
      if (!mid || !c.hold) return null;
      const on = c.timepoints.includes(sid);
      const toggle = h(
        'button',
        {
          class: `tp-toggle${on ? ' on' : ''}`,
          'aria-pressed': on ? 'true' : 'false',
          'aria-label': `Timepoint at ${name}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            const tps = c.timepoints;
            c.timepoints = on ? tps.filter((x) => x !== sid) : r.stops.filter((x) => x === sid || tps.includes(x));
            commitControl();
          },
        },
        svgIcon(ICONS.clock),
      );
      tip(toggle, on ? `Timepoint at ${name}` : `Make ${name} a timepoint`, TIMEPOINT_TIP);
      return toggle;
    };
    if (!rows.length) {
      // No path: the stop list as it is.
      r.stops.forEach((sid, i) => {
        const s = net.stations.get(sid);
        if (!s) return;
        stops.append(h('div', { class: 'list-item', onclick: () => game.select({ kind: 'station', id: sid }) }, h('span', { class: 'hw-muted num', style: 'width:18px' }, String(i + 1)), h('span', { class: 'grow' }, s.name)));
      });
      return;
    }
    for (const row of rows) {
      const sid = row.station;
      const i = row.served ? row.stopNo - 1 : -1;
      const on = row.served && c.timepoints.includes(sid);
      let action: HTMLElement | null = null;
      if (row.served && row.terminal) {
        action = h('span', { class: 'line-term' }, 'terminal');
        tip(action, 'Terminal', "Terminals can't be skipped — shorten the route instead");
      } else if (row.served) {
        action = h('button', { class: 'hw-btn ghost small', onclick: (e: Event) => { e.stopPropagation(); editStops(skipStops(net, r.stops, sid), `${row.name} skipped`); } }, 'Skip');
      } else {
        action = h('button', { class: 'hw-btn ghost small', onclick: (e: Event) => { e.stopPropagation(); editStops(serveStops(net, r.cls, r.stops, path, sid), `Stops at ${row.name}`); } }, 'Stop here');
      }
      stops.append(
        h(
          'div',
          { class: `list-item line-row${row.served ? '' : ' skipped'}${on && c.hold ? ' tp-on' : ''}`, onclick: () => game.select({ kind: 'station', id: sid }) },
          h('span', { class: 'line-mark' }),
          h('span', { class: 'hw-muted num', style: 'width:18px' }, row.served ? String(row.stopNo) : ''),
          h('span', { class: 'grow' }, row.name, row.tag ? h('span', { class: 'line-tag' }, ` ${row.tag}`) : null),
          ...row.others.map((o) => bullet(o.color, o.bullet, 16, o.express, o.shape)),
          row.served ? timepointToggle(sid, row.name, i) : null,
          action,
        ),
      );
    }
  };
  /** Change the stop list (and express flag) at once: checked by pathfinding and the fleet purchase, reverted with a toast. */
  const editStops = (res: { stops: number[] } | { error: string }, done?: string, express?: boolean) => {
    if ('error' in res) {
      app.toast(`Can't change ${r.name}`, res.error, 'red');
      return;
    }
    const sameStops = sameStopList(res.stops, r.stops);
    if (serviceEditNoop(r, res.stops, express)) {
      // Nothing changes (e.g. Express pattern on a route that already runs it): no edit, no restart.
      app.toast(done ? `${done}: nothing to change` : 'Nothing to change', `${r.name} already runs this pattern`, 'amber');
      return;
    }
    const before = { stops: [...r.stops], express: !!r.express, control: structuredClone(r.control) };
    game.routes.update(r.id, { stops: res.stops, ...(express !== undefined ? { express } : {}) });
    const p2 = game.routes.path(game.network, r);
    if (!p2.ok) {
      game.routes.update(r.id, before);
      app.toast(`Can't change ${r.name}`, p2.error ?? 'No path along the track', 'red');
      return;
    }
    const res2 = purchaseFleet(game, r);
    if (!res2.ok) {
      game.routes.update(r.id, before);
      app.toast("Can't afford the trains", `${fmtMoney(res2.cost)} needed`, 'red');
      return;
    }
    if (res2.cost) app.toast('Trains bought', fmtMoney(res2.cost), 'amber');
    else if (done) app.toast(done, sameStops ? r.name : `${r.name} · trains restart on the new pattern`, 'green');
    game.events.emit('routes', undefined);
    game.select({ kind: 'route', id: r.id });
  };

  // Service regularity and the load profile
  const reg = h('div');
  const charts = h('div');
  body.append(reg, section('Peak-hour load (8–9 am)'), charts);

  // Trains and frequency: the Routes & stations controls, priced on hover, applied at once.
  const fleetWrap = h('div');
  const row = (label: string, ctl: HTMLElement, note?: string) => h('div', { class: 'ops-row' }, h('span', { class: 'lbl' }, label), h('div', { class: 'ctl' }, ctl), note ? h('div', { class: 'note' }, note) : null);
  const trainsSec = h(
    'div',
    { class: 'rp-trains' },
    row('Train type', trainTypePicker(app, r)),
    row('Length', trainLengthStepper(app, r)),
    row('Peak', headwayStepper(app, r, 'peak', ['am', 'pm'], false), '6–10, 16–20'),
    row('Midday', headwayStepper(app, r, 'midday', ['midday'], false), '10–16'),
    row('Evening', headwayStepper(app, r, 'evening', ['evening'], false), '20–24'),
    row('Night', headwayStepper(app, r, 'no trains', ['night'], true), '0–6'),
  );
  const renderFleet = () => fleetWrap.replaceChildren(fleetLine(app, r, { sell: true }));

  // Operations control (§2.1)
  let detail: RouteDetail | null = null;
  // Yesterday's regularity: the worker's, or the saved last report's after a load (see regularityWithReport).
  const runTimes = fleetPlan(game, r).runTimes;
  const regDetail = () => regularityWithReport(detail?.regularity, app.report?.routeRegularity?.[r.id], runTimes ? (runTimes[0] + runTimes[1]) / 2 : null);
  const ops = h('div');
  const renderOps = () => {
    const hold = choiceSeg([0, 1], c.hold ? 1 : 0, (v) => (v ? 'On' : 'Off'), (v) => { c.hold = v === 1; commitControl(); });
    const holdLbl = h('span', { class: 'lbl' }, 'Holding');
    tip(holdLbl, 'Holding', HOLD_TIP, 'H');
    tip(hold, 'Holding', HOLD_TIP, 'H');
    const rows: HTMLElement[] = [h('div', { class: 'ops-row' }, holdLbl, h('div', { class: 'ctl' }, hold))];
    if (c.hold) {
      const thr = choiceSeg(OPS_CONTROL.holdFractionChoices, c.holdFraction, (v) => String(Math.round(v * 100)), (v) => { c.holdFraction = v; commitControl(); });
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
    const plan = fleetPlan(game, r);
    const rec = choiceSeg(OPS_CONTROL.recoveryChoices, c.recoveryPct, (v) => pct(v), (v) => { c.recoveryPct = v; commitControl(); });
    const recLbl = h('span', { class: 'lbl' }, 'Recovery');
    tip(recLbl, 'Recovery time', RECOVERY_TIP);
    tip(rec, 'Recovery time', RECOVERY_TIP);
    let recNote = 'No slack in the timetable';
    if (plan.runTimes && c.recoveryPct > 0) {
      const extra = plan.trainsNeeded - trainsNeeded({ headways: r.headways, control: { recoveryPct: 0 } }, plan.runTimes);
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
          commitControl();
        },
      }, 'Suggest');
      tip(suggest, 'Suggest timepoints', `Stops near ⅓ and ⅔ along the line, preferring stops no other route serves.`);
      const clear = h('button', { class: 'hw-btn small ghost', disabled: !c.timepoints.length, onclick: () => { c.timepoints = []; commitControl(); } }, 'Clear');
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

  renderFleet();
  renderOps();
  renderStops();
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
  // Service (v2): local or express, and the two patterns (shown when the route can use four tracks).
  const serviceSec = h('div');
  if (r.express || routeOnQuad(net, r.stops) || rows.some((x) => x.partner !== undefined)) {
    const kind = h(
      'div',
      { class: 'seg' },
      h('button', { class: r.express ? '' : 'on', onclick: () => r.express && editStops({ stops: [...r.stops] }, `${r.name} is a local`, false) }, 'Local'),
      h('button', { class: r.express ? 'on' : '', onclick: () => !r.express && editStops({ stops: [...r.stops] }, `${r.name} is an express`, true) }, 'Express'),
    );
    tip(kind, r.express ? 'Express' : 'Local', r.express ? SERVICE_TIP.express : SERVICE_TIP.local);
    const pattern = h('button', { class: 'hw-btn small', onclick: () => editStops({ stops: expressPattern(net, r.stops) }, 'Express pattern', true) }, 'Express pattern');
    tip(pattern, 'Express pattern', SERVICE_TIP.pattern);
    const all = h('button', { class: 'hw-btn small', onclick: () => editStops({ stops: path.ok ? allStopsPattern(net, r.cls, r.stops, path) : [...r.stops] }, 'All stops', false) }, 'All stops');
    tip(all, 'All stops', SERVICE_TIP.allStops);
    const skips = skipsText(along.filter(inLine));
    serviceSec.append(
      section('Service'),
      h('div', { class: 'ops-row' }, h('span', { class: 'lbl' }, 'Runs as'), h('div', { class: 'ctl' }, kind)),
      h('div', { class: 'ops-row' }, h('span', { class: 'lbl' }, 'Pattern'), h('div', { class: 'ctl' }, pattern, all), h('div', { class: 'note' }, skips ? `${skips} along the line` : 'Stops at every station along the line')),
    );
  }
  body.append(
    serviceSec,
    section('Trains & frequency'),
    service,
    trainsSec,
    h('div', { class: 'hw-muted rp-instant' }, 'Changes apply at once. Hover a button for what it costs.'),
    section('Operations'),
    ops,
    h('div', { style: 'margin-top:8px' }, fleetWrap),
    section(`Line · ${r.stops.length} stops${skipped ? `, skips ${skipped}` : ''} · ${fmtDistance(path.length || 0)}`),
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

  let chartObjs: { destroy(): void }[] = [];
  const renderStats = () => {
    const lateness = app.report?.routeLateness[r.id];
    const late = statCard('Running late', lateness === undefined ? '—' : lateness < 30 ? 'On time' : lateness < 90 ? `${Math.round(lateness)} s` : `${(lateness / 60).toFixed(1)} min`, lateness !== undefined && lateness > 120 ? 'red' : lateness !== undefined && lateness > 45 ? 'amber' : lateness !== undefined ? 'green' : undefined, 'average at each stop, yesterday');
    tip(late, 'Average lateness (yesterday)', LATENESS_TIP);
    const cards = [
      statCard('Riders yesterday', fmtCount(detail?.ridersYesterday ?? app.report?.routeRiders[r.id] ?? 0), undefined, 'trips on this line'),
      statCard('Riders today', fmtCount(detail?.ridersToday ?? 0), undefined, 'so far, live'),
      statCard('Trains running', `${detail?.inService ?? 0} of ${Math.floor(r.ownedCars / r.cars)}`, undefined, 'out on the line right now'),
      late,
    ];
    // Four-track sections (v2): overtakes between cross-platform stations.
    if (r.express || routeOnQuad(net, r.stops)) {
      const rep = app.report?.routeOvertakes;
      const card = statCard('Overtakes yesterday', overtakesValue(rep ? (rep[r.id] ?? 0) : undefined, detail?.overtakesToday));
      tip(card, 'Overtakes yesterday', OVERTAKES_TIP);
      cards.push(card);
    }
    stats.replaceChildren(...cards);
  };
  const renderReg = () => {
    const d = regDetail();
    const s = d ? (d.yesterday ?? d.today) : null;
    reg.replaceChildren();
    if (!op.ok) return;
    reg.append(section(`Service regularity${d ? (d.yesterday ? ' · yesterday' : ' · today so far') : ''}`));
    const grid = h('div', { class: 'stat-grid' });
    for (const c of regularityCards(s)) {
      const card = statCard(c.label, c.value, c.tone, c.hint);
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
    reg.append(h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:8px' }, `How even the gaps are at each stop${d.fromReport ? ' (today so far)' : ''} · lower is better, under the dashed line is even`));
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
      const hadAdvice = recoveryAdvice(regDetail(), c.recoveryPct);
      detail = d;
      renderStats();
      renderCharts();
      if (recoveryAdvice(regDetail(), c.recoveryPct) !== hadAdvice) renderOps();
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
  const sh = shell(d?.editing !== null && d ? 'Edit route' : 'New route', d?.name || 'Click stations in order', () => tool.cancel(), d ? bullet(d.color, d.bullet || '?', 34, d.express, d.shape) : null);
  const body = sh.body;
  if (!d) return { el: sh.el };
  const net = game.network;
  body.append(h('div', { class: 'opt-hint' }, 'Click stations on the map in order. Click a stop again to remove it; Shift-click adds at the start; a station the line already runs past is added in order. The path follows connected track automatically.'));
  // Local or express (E): which platform of a cross-platform station a click picks, and the bullet.
  const kind = h(
    'div',
    { class: 'seg' },
    h('button', { class: d.express ? '' : 'on', onclick: () => tool.setExpress(false) }, 'Local'),
    h('button', { class: d.express ? 'on' : '', onclick: () => tool.setExpress(true) }, 'Express'),
  );
  attachTip(kind, app.tooltip, d.express ? 'Express' : 'Local', 'E', d.express ? SERVICE_TIP.express : SERVICE_TIP.local);
  const kindRow = h('div', { class: 'ops-row' }, h('span', { class: 'lbl' }, 'Runs as'), h('div', { class: 'ctl' }, kind));
  if (d.stops.length >= 2 && (d.express || routeOnQuad(net, d.stops) || tool.along.some((a) => a.partner !== undefined))) {
    const pat = h('button', { class: 'hw-btn small', onclick: () => { d.stops = expressPattern(net, d.stops); d.express = true; tool.recompute(); } }, 'Express pattern');
    attachTip(pat, app.tooltip, 'Express pattern', undefined, SERVICE_TIP.pattern);
    const all = h('button', { class: 'hw-btn small', disabled: !tool.path?.ok, onclick: () => { if (tool.path?.ok && d.cls) { d.stops = allStopsPattern(net, d.cls, d.stops, tool.path); d.express = false; tool.recompute(); } } }, 'All stops');
    attachTip(all, app.tooltip, 'All stops', undefined, SERVICE_TIP.allStops);
    kindRow.append(h('span', { class: 'lbl' }, 'Pattern'), h('div', { class: 'ctl' }, pat, all));
  }
  body.append(kindRow);
  // The line: stops in order, and the stations the path runs past (Stop here inserts in order).
  const list = h('div', { class: 'list line-list', style: `margin:8px 0;--rc:${d.color}` });
  const along = tool.along;
  if (along.length && tool.path?.ok && d.cls) {
    const p = tool.path;
    const cls = d.cls;
    for (const a of along) {
      const s = net.stations.get(a.station);
      const i = a.served ? d.stops.indexOf(a.station) : -1;
      if (!a.served && (a.s < (p.stopS[0] ?? 0) - 1 || a.s > (p.stopS[p.stopS.length - 1] ?? Infinity) + 1)) continue;
      list.append(
        h(
          'div',
          { class: `list-item line-row${a.served ? '' : ' skipped'}` },
          h('span', { class: 'line-mark' }),
          h('span', { class: 'hw-muted num', style: 'width:18px' }, a.served ? String(i + 1) : ''),
          h('span', { class: 'grow' }, s?.name ?? '?', !a.served ? h('span', { class: 'line-tag' }, a.where === 'beside' ? ` on the ${pairWord(net, a.station) ?? 'other'} pair` : ' passes') : null),
          a.served
            ? h('button', { class: 'hw-btn ghost small', onclick: () => { d.stops.splice(i, 1); tool.recompute(); } }, '✕')
            : h('button', {
                class: 'hw-btn ghost small',
                onclick: () => {
                  const res = serveStops(net, cls, d.stops, p, a.station);
                  if ('error' in res) app.toast(`Can't stop at ${s?.name ?? 'this station'}`, res.error, 'red');
                  else {
                    d.stops = res.stops;
                    tool.recompute();
                  }
                },
              }, 'Stop here'),
        ),
      );
    }
  } else {
    d.stops.forEach((sid, i) => {
      const s = net.stations.get(sid);
      list.append(h('div', { class: 'list-item' }, h('span', { class: 'hw-muted num', style: 'width:18px' }, String(i + 1)), h('span', { class: 'grow' }, s?.name ?? '?'), h('button', { class: 'hw-btn ghost small', onclick: () => { d.stops.splice(i, 1); tool.recompute(); } }, '✕')));
    });
  }
  if (!d.stops.length) list.append(h('div', { class: 'hw-muted', style: 'padding:6px 0' }, 'No stations yet'));
  const skips = skipsText(along.filter((a) => a.served || !tool.path?.ok || (a.s >= (tool.path.stopS[0] ?? 0) - 1 && a.s <= (tool.path.stopS[tool.path.stopS.length - 1] ?? Infinity) + 1)));
  body.append(section(`Stops (${d.stops.length})${skips ? ` · ${skips}` : ''}`), list);
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
  for (const c of routePalette(city().theme)) colors.append(h('button', { class: c.toLowerCase() === d.color.toLowerCase() ? 'on' : '', style: { background: c }, title: c, onclick: () => { d.color = c; tool.recompute(); } }));
  // Any colour at all: the native picker.
  const custom = h('input', { type: 'color', class: 'color-custom', value: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#888888', title: 'Pick any colour' }) as HTMLInputElement;
  custom.addEventListener('change', () => {
    d.color = custom.value.toUpperCase();
    tool.recompute();
  });
  colors.append(custom);
  const shapes = h('div', { class: 'shape-row' }, h('span', { class: 'hw-muted', style: 'font-size:12px;margin-right:4px' }, 'Shape'));
  const SHAPE_NAME: Record<BulletShape, string> = { circle: 'Disc', square: 'Square', diamond: 'Diamond', bar: 'Line bar' };
  for (const sh of BULLET_SHAPES)
    shapes.append(h('button', { class: (d.shape ?? (city().theme === 'tfl' ? 'bar' : 'circle')) === sh ? 'on' : '', title: SHAPE_NAME[sh], onclick: () => { d.shape = sh; tool.recompute(); } }, bullet(d.color, d.bullet || '?', 22, false, sh)));
  body.append(section('Name and bullet'), h('div', { style: 'display:flex;gap:6px' }, name, bul), section('Colour and shape'), colors, shapes);
  // Train length and frequency
  if (d.cls) {
    const cls = d.cls;
    const stock = validStock(d.stock, cls);
    const fits = (s: StockId) => Math.min(TRAINS[s].maxCars, ...d.stops.map((sid) => { const st = net.stations.get(sid); return st ? carsFitting(net, st, s) : 99; }));
    const options = stocksFor(gaugeOf(cls));
    if (options.length > 1) {
      const pick = (s: StockId) => {
        d.stock = s;
        d.cars = Math.max(TRAINS[s].minCars, Math.min(d.cars, fits(s)));
        tool.recompute();
      };
      body.append(
        section('Trains'),
        h('div', { class: 'stock-grid' }, ...options.map((s) => h('button', { class: 'stock-btn' + (s === stock ? ' on' : ''), title: TRAINS[s].blurb, onclick: () => pick(s) }, h('b', null, TRAINS[s].name), h('span', { class: 'hw-muted' }, `${fmtSpeed(TRAINS[s].topSpeed)} · ${TRAINS[s].capacityComfort}/car · ${fmtMoney(TRAINS[s].costPerCar)}/car`)))),
        h('div', { class: 'opt-hint', style: 'margin-top:4px' }, TRAINS[stock].blurb + (stock === 'highspeed' ? '. Build high-speed line (track tool) for its full speed.' : '')),
      );
    }
    const maxCars = fits(stock);
    body.append(section('Train length'), carsPicker(TRAINS[stock].minCars, Math.max(TRAINS[stock].minCars, maxCars), d.cars, (c) => { d.cars = c; tool.recompute(); }));
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
        bullet(r.color, r.bullet, 24, r.express, r.shape),
        h('span', { class: 'grow' }, r.name, h('div', { class: op.ok ? 'hw-muted' : 'hw-amber', style: 'font-size:11.5px' }, op.ok ? `${r.express ? 'Express · ' : ''}${r.stops.length} stops` : op.reason ?? '', op.ok && tag ? h('span', { class: `hw-${tag.tone}` }, ` · ${tag.text}`) : null)),
        h('span', { class: 'num' }, fmtCount(app.report?.routeRiders[r.id] ?? 0)),
      ),
    );
  }
  sh.body.append(h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px' }, h('span', null, 'Route'), h('span', null, 'Riders yesterday')), list, h('button', { class: 'hw-btn primary small', style: 'margin-top:10px', onclick: () => app.setTool('route') }, 'New route'));
  return { el: sh.el, dayEnd: () => game.select({ kind: 'routes' }) };
}
