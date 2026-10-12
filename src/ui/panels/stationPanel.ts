/**
 * Station panel: daily boardings, boardings by hour, routes served, where riders come from and
 * go to (also drawn as flow lines on the map), crowding and left-behind counts.
 */
import { city } from '../../cities';
import { cap } from '../../construction/describe';
import { LEVEL_NAMES } from '../../construction/validate';
import { progress } from '../../construction/blueprint';
import { fmtClock, fmtCount, fmtMoney } from '../../core/units';
import type { App } from '../app';
import { barChart } from '../charts';
import { bullet, h } from '../dom';
import { kv, section, shareBar, shell, statCard, type Panel } from './common';

interface StationDetail {
  hourlyToday: number[];
  hourlyYesterday: number[];
  leftToday: number;
  leftYesterday: number;
  waiting: number;
  from: { tract: number; count: number }[];
  to: { tract: number; count: number }[];
}


export function stationPanel(app: App, id: number): Panel {
  const game = app.game;
  const net = game.network;
  const s = net.stations.get(id);
  if (!s) return { el: document.createElement('div') };
  const level = net.stationLevel(s);
  const cls = net.edges.get(s.edge)?.cls ?? 'heavy';
  const routes = game.routes.list().filter((r) => r.stops.includes(id));
  const lead = null;
  const sh = shell(`Station · ${cap(LEVEL_NAMES[level])} · ${s.cars}-car platforms`, s.name, () => game.select(null), lead);
  const nameBtn = h('button', { class: 'hw-btn ghost small', onclick: () => rename() }, 'Rename');
  sh.titleEl.append(' ', nameBtn);
  const rename = () => {
    const input = h('input', { type: 'text', value: s.name, style: 'width:100%' }) as HTMLInputElement;
    sh.titleEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = () => {
      const v = input.value.trim();
      if (v) {
        s.name = v;
        s.nameAuto = false;
        game.network.touch();
        game.afterNetworkChange();
      }
      game.select({ kind: 'station', id });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done();
      if (e.key === 'Escape') game.select({ kind: 'station', id });
    });
    input.addEventListener('blur', done);
  };
  const body = sh.body;
  const statusLine =
    s.status === 'blueprint'
      ? h('div', { class: 'warn' }, 'Blueprint — press Build to start construction')
      : s.status === 'construction'
        ? h('div', { class: 'warn' }, `Under construction · ${Math.floor(progress(s, game.time) * 100)}%`)
        : null;
  const routeChips = h(
    'div',
    { class: 'chip-list', style: 'margin:4px 0 2px' },
    ...(routes.length
      ? routes.map((r) => h('span', { style: 'display:inline-flex;align-items:center;gap:6px;cursor:pointer', onclick: () => game.select({ kind: 'route', id: r.id }) }, bullet(r.color, r.bullet, 20), r.name))
      : [h('span', { class: 'hw-muted' }, 'No routes serve this station yet')]),
  );
  // City chaos: closed by police activity.
  const closedBanner = h('div');
  const stats = h('div', { class: 'stat-grid', style: 'margin-top:8px' });
  const chartWrap = h('div', { class: 'chart' });
  if (s.status !== 'built') chartWrap.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'Ridership appears once the station opens.'));
  const flowsWrap = h('div');
  body.append(statusLine ?? '', closedBanner, routeChips, stats, section('Boardings by hour'), chartWrap, flowsWrap, section('Station'), kv([
    ['Level', cap(LEVEL_NAMES[level])],
    ['Class', `${cap(cls)} metro`],
    ['Platform', `${s.cars} cars`],
    [s.status === 'blueprint' ? 'Estimated cost' : 'Cost', fmtMoney(s.cost || 0)],
  ]));
  const actions = h(
    'div',
    { style: 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap' },
    h('button', { class: 'hw-btn small', onclick: () => app.startRouteFrom(id) }, 'Start a route here'),
  );
  body.append(actions);

  let detail: StationDetail | null = null;
  let chart: { destroy(): void } | null = null;
  let closedId = -1;
  const render = () => {
    const closed = app.feed.activeFor({ stationId: id });
    if ((closed?.id ?? 0) !== closedId) {
      closedId = closed?.id ?? 0;
      closedBanner.replaceChildren(
        closed
          ? h('div', { class: 'err', style: 'cursor:pointer', onclick: () => game.select({ kind: 'alerts', focus: closed.id }) }, h('b', null, `Closed: police activity until ${fmtClock(closed.until)}. `), 'Trains run through; riders are sent to nearby stations.')
          : '',
      );
    }
    const boardY = app.report?.stationBoardings[id];
    const left = detail ? (detail.leftYesterday || detail.leftToday) : 0;
    const waiting = app.waitingAt(id);
    const crowd = app.stationCrowding(id);
    stats.replaceChildren(
      statCard('Boardings yesterday', boardY !== undefined ? fmtCount(boardY) : '—'),
      statCard('Waiting now', fmtCount(waiting), crowd > 1 ? 'red' : crowd > 0.6 ? 'amber' : undefined),
      statCard('Left behind', fmtCount(left), left > 0 ? 'amber' : undefined),
      statCard('Today so far', detail ? fmtCount(detail.hourlyToday.reduce((a, b) => a + b, 0)) : '—'),
    );
  };
  const renderDetail = () => {
    if (!detail) return;
    chart?.destroy();
    chartWrap.replaceChildren();
    const useY = detail.hourlyYesterday.some((v) => v > 0);
    const ys = useY ? detail.hourlyYesterday : detail.hourlyToday;
    chartWrap.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px' }, useY ? 'Yesterday' : 'Today so far'));
    chart = barChart(chartWrap, ys.map((_, i) => i), ys, '#00A3B0', (x) => `${String(x).padStart(2, '0')}h`, 'Boardings');
    // Where riders come from / go to, by borough; flow lines on the map.
    const byBorough = (list: { tract: number; count: number }[]) => {
      const c = city();
      const sums = c.areas.map(() => 0);
      for (const f of list) {
        const a = app.world.tracts[f.tract].areaIndex;
        if (a >= 0) sums[a] += f.count;
      }
      return c.areas.map((b, i) => ({ label: b, value: sums[i], color: c.areaColors[i] })).filter((p) => p.value > 0);
    };
    flowsWrap.replaceChildren();
    if (detail.from.length) {
      flowsWrap.append(section('Riders come from'), shareBar(byBorough(detail.from)), section('Riders are going to'), shareBar(byBorough(detail.to)));
      flowsWrap.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:6px' }, 'Flow lines on the map show the biggest origins (teal) and destinations (orange).'));
    }
    app.setStationFlows(id, detail.from, detail.to);
    render();
  };
  const fetch = () => {
    if (s.status !== 'built') return;
    app.sim.query<StationDetail>({ kind: 'station', station: id }).then((d) => {
      detail = d;
      renderDetail();
    });
  };
  render();
  fetch();
  let tick = 0;
  return {
    el: sh.el,
    update: () => {
      render();
      if (++tick % 20 === 0) fetch();
    },
    dayEnd: fetch,
    destroy: () => {
      chart?.destroy();
      app.setStationFlows(null, [], []);
    },
  };
}
