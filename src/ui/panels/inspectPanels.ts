/** Train, tract and track panels. */
import { city } from '../../cities';
import { TRAINS } from '../../balance';
import { edgeTooltip } from '../../construction/describe';
import { fmtDate, isNewMonth, monthLabel } from '../../core/calendar';
import { fmtClock, fmtCount, fmtDensity, fmtSpeed } from '../../core/units';
import { formalTractName } from '../../map/placeNames';
import type { App } from '../app';
import { indexChart } from '../charts';
import { bullet, h } from '../dom';
import { fmtSignedPct, indexSeries, startDateText, startMonth, tractGrowthSentence, tractPanelTitle, tractValueCaptureLine } from '../livingCity';
import { kv, section, shareBar, shell, SHARE_COLORS, statCard, type Panel } from './common';
import { SNAP_HELD, type TractGrowth } from '../../sim/protocol';

export function trainPanel(app: App, id: number): Panel {
  const sh = shell('Train', '—', () => app.game.select(null));
  const body = sh.body;
  const render = () => {
    const d = app.trains.data.find((t) => t.id === id);
    const t = d?.train;
    const r = t ? app.compiledRoute(t.route) : null;
    if (!t || !r) {
      sh.titleEl.textContent = 'Not in service';
      body.replaceChildren(h('div', { class: 'hw-muted' }, 'This train has finished its run or is turning around at a terminal.'));
      return;
    }
    const dir = r.dirs[t.dir];
    const st = app.compiled?.net.stations;
    const terminal = st?.[dir.stopStation[dir.stopStation.length - 1]]?.name ?? '';
    const next = st?.[dir.stopStation[Math.min(t.nextStop, dir.stopStation.length - 1)]]?.name ?? '';
    const people = t.load * app.agentScale;
    const lf = people / r.capComfort;
    sh.titleEl.replaceChildren(bullet(r.color, r.bullet, 22), ' ', `${r.name}`);
    // City chaos: stalled (breakdown) or held at a station (sick passenger).
    const inc = app.feed.activeFor({ trainId: id });
    const banner = inc
      ? h(
          'div',
          { class: inc.kind === 'breakdown' ? 'err' : 'warn', style: 'cursor:pointer', onclick: () => app.game.select({ kind: 'alerts', focus: inc.id }) },
          inc.kind === 'breakdown'
            ? `Stalled: mechanical problem, moving again ~${fmtClock(inc.until)}`
            : `Held at ${inc.place}: sick passenger, ~${Math.max(1, Math.round((inc.until - app.sim.time()) / 60))} min`,
        )
      : null;
    // Operations control: held at a timepoint for an even gap behind the train ahead.
    const held = t.state === SNAP_HELD;
    const dwelling = t.state === 2 || held;
    body.replaceChildren(
      banner ?? '',
      held && !banner ? h('div', { class: 'warn' }, h('b', null, `Held at ${next}`), ' · Waiting for an even gap behind the train ahead') : '',
      h('div', { class: 'hw-muted', style: 'margin-bottom:8px' }, `Towards ${terminal}`),
      h(
        'div',
        { class: 'stat-grid' },
        statCard('On board', fmtCount(people), lf > 1.4 ? 'red' : lf > 1 ? 'amber' : undefined),
        statCard('Load', `${Math.round(lf * 100)}%`, lf > 1.4 ? 'red' : lf > 1 ? 'amber' : undefined),
        statCard(held ? 'Held at' : dwelling ? 'At' : 'Next stop', next, held ? 'amber' : undefined),
        statCard('Lateness', t.late > 30 ? `${Math.round(t.late / 60)} min late` : 'On time', t.late > 180 ? 'red' : t.late > 60 ? 'amber' : 'green'),
      ),
      section('Train'),
      kv([
        ['Speed', held ? 'Held by the dispatcher' : dwelling ? 'Dwelling' : fmtSpeed(t.v)],
        ['Cars', String(r.cars)],
        ['Capacity', `${fmtCount(r.capComfort)} comfortable · ${fmtCount(r.capCrush)} crush`],
        ['Top speed', fmtSpeed(TRAINS[r.cls].topSpeed)],
      ]),
    );
  };
  render();
  app.trains.selected = id;
  return {
    el: sh.el,
    update: render,
    destroy: () => {
      app.trains.selected = null;
    },
  };
}

interface TractDetail {
  commuters: number;
  share: number[];
  avgCommute: number;
  unserved: number;
}

export function tractPanel(app: App, index: number): Panel {
  const t = app.world.tracts[index];
  // London MSOAs carry names ("Camden 028"); NYC tracts are numbered within the borough. The
  // name the toasts and the month report use (a map label or "around <station>", §2.4) is the
  // title when there is one, with the formal name below it.
  const head = tractPanelTitle(app.tractName(index), formalTractName(t), t.name ? 'Neighbourhood area' : 'Census tract', t.id, t.borough);
  const sh = shell(head.sub, head.title, () => app.game.select(null));
  const body = sh.body;
  const stats = h('div', { class: 'stat-grid' });
  const shares = h('div');
  const growthWrap = h('div');
  body.append(stats, section('How residents commute'), shares, section(`Growth since ${startMonth()}`), growthWrap);
  let d: TractDetail | null = null;
  let tg: TractGrowth | null = null;
  let loaded = false;
  let chart: { destroy(): void } | null = null;
  const renderStats = () => {
    stats.replaceChildren(
      // Residents and jobs as they are now (the start until the growth query answers).
      statCard('Residents', fmtCount(tg ? tg.residents : t.residents)),
      statCard('Jobs', fmtCount(tg ? tg.jobs : t.jobs)),
      statCard('Avg commute', d ? `${d.avgCommute.toFixed(1)} min` : '—'),
      statCard('No good transit', d ? fmtCount(d.unserved) : '—', d && d.unserved > 0 ? 'amber' : undefined),
    );
  };
  const render = () => {
    renderStats();
    shares.replaceChildren(
      d
        ? shareBar([
            { label: 'Transit', value: d.share[2], color: SHARE_COLORS.transit },
            { label: 'Drive', value: d.share[1], color: SHARE_COLORS.drive },
            { label: 'Walk', value: d.share[0], color: SHARE_COLORS.walk },
          ])
        : h('div', { class: 'hw-muted' }, 'Loading…'),
      h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:8px' }, `Density ${fmtDensity(t.density)} (residents + jobs). Residents and jobs count commuters who live and work in ${city().name}.`),
    );
  };
  const tone = (u: number) => (u > 0.0005 ? 'green' : u < -0.0005 ? 'red' : undefined);
  const renderGrowth = () => {
    chart?.destroy();
    chart = null;
    growthWrap.replaceChildren();
    if (!tg) {
      growthWrap.append(h('div', { class: 'hw-muted' }, loaded ? 'No growth data for this area.' : 'Loading…'));
      return;
    }
    const g = tg;
    const dRes = g.residents0 > 0 ? g.residents / g.residents0 - 1 : 0;
    const dJobs = g.jobs0 > 0 ? g.jobs / g.jobs0 - 1 : 0;
    growthWrap.append(
      h(
        'div',
        { class: 'stat-grid' },
        statCard('Residents', g.residents0 > 0 ? fmtSignedPct(dRes) : '—', tone(dRes)),
        statCard('Jobs', g.jobs0 > 0 ? fmtSignedPct(dJobs) : '—', tone(dJobs)),
        statCard('Transit benefit', `${Math.round(g.residents0 >= g.jobs0 ? g.benefitHome : g.benefitWork)} min`),
        statCard('Land value', fmtSignedPct(g.premium), g.premium > 0.0005 ? 'green' : undefined),
      ),
    );
    // The next month close: midnight after the month's last weekday.
    let last = app.game.day;
    while (!isNewMonth(last + 1)) last++;
    if (g.history.length) {
      // Index chart: the start (= 100), then each stored month close.
      const sr = indexSeries(g);
      const wrap = h('div', { class: 'chart', style: 'margin-top:8px' });
      growthWrap.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:8px' }, `Index: ${startDateText()} = 100, then each month end`), wrap);
      chart = indexChart(wrap, sr.xs, sr.label, sr.res, sr.jobs);
    } else {
      growthWrap.append(h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:8px' }, app.game.growthPace === 'off' ? 'City growth is off: the city stays as it is.' : `The city grows at each month end. The next one closes after ${fmtDate(last)}.`));
    }
    const near = g.nearestStation !== null ? app.game.network.stations.get(g.nearestStation) : undefined;
    growthWrap.append(
      h('div', { style: 'font-size:12.5px;line-height:1.45;margin-top:8px' }, tractGrowthSentence(g, app.game.growthPace)),
      h('div', { class: g.inDistrict ? 'fin-line' : 'hw-muted', style: 'font-size:12.5px;margin-top:6px' }, tractValueCaptureLine(g, app.game.growthPace, monthLabel(last)), near && g.inDistrict && app.game.growthPace !== 'off' ? h('span', { class: 'hw-muted' }, ` · via ${near.name}`) : ''),
    );
  };
  render();
  renderGrowth();
  const fetch = () => {
    app.sim.query<TractDetail>({ kind: 'tract', tract: index }).then((x) => {
      d = x;
      render();
    });
    app.sim.query<TractGrowth | null>({ kind: 'tractGrowth', tract: index }).then((x) => {
      tg = x;
      loaded = true;
      renderStats();
      renderGrowth();
    });
  };
  fetch();
  app.setTractHighlight(index);
  return {
    el: sh.el,
    dayEnd: fetch,
    destroy: () => {
      chart?.destroy();
      app.setTractHighlight(null);
    },
  };
}

export function edgePanel(app: App, id: number): Panel {
  const sh = shell('Track', 'Track segment', () => app.game.select(null));
  const info = h('div', { class: 'hw-tip', style: 'position:static;box-shadow:none;max-width:none;border:0;padding:0;background:transparent' });
  const render = () => {
    info.innerHTML = edgeTooltip(app.game, id);
  };
  render();
  const users = app.game.routesUsingEdge(id);
  sh.body.append(
    info,
    users.length ? h('div', { class: 'hw-muted', style: 'margin-top:8px' }, `Used by ${users.join(', ')}`) : '',
    h('div', { style: 'display:flex;gap:6px;margin-top:12px' }, h('button', { class: 'hw-btn small', onclick: () => app.setTool('bulldoze') }, 'Bulldoze tool')),
  );
  return { el: sh.el, update: render };
}
