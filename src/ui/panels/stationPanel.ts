/**
 * Station panel: daily boardings, boardings by hour, routes served, where riders come from and
 * go to (also drawn as flow lines on the map), crowding and left-behind counts. A cross-platform
 * station (v2) shows as one: both platforms' figures together, its cross-platform transfers, and
 * Rename renames both.
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
import { stationValueCaptureText, stationValueCaptureTip } from '../livingCity';
import { attachTip } from '../widgets';
import { pairKeyId, partnerOf, quadRole } from '../../routes/express';
import { mergeDetails, type StationDetail } from '../express';
import type { Station } from '../../construction/types';


export function stationPanel(app: App, id: number): Panel {
  const game = app.game;
  const net = game.network;
  const s = net.stations.get(id);
  if (!s) return { el: document.createElement('div') };
  const level = net.stationLevel(s);
  const cls = net.edges.get(s.edge)?.cls ?? 'heavy';
  // A cross-platform pair (v2): both platforms, shown as one station.
  const pid = partnerOf(net, id);
  const partner: Station | null = pid !== null ? net.stations.get(pid)! : null;
  const plats = partner ? [s, partner] : [s];
  const ids = plats.map((x) => x.id);
  const routes = game.routes.list().filter((r) => r.stops.some((x) => ids.includes(x)));
  const lead = null;
  const sh = shell(`Station · ${cap(LEVEL_NAMES[level])} · ${s.cars}-car platforms${partner ? ' · cross-platform' : ''}`, s.name, () => game.select(null), lead);
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
        // Both platforms of a cross-platform station carry its name.
        for (const x of plats) {
          x.name = v;
          x.nameAuto = false;
        }
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
  // The least-built platform says what the station is (a pair opens when both platforms are built).
  const least = plats.find((x) => x.status === 'blueprint') ?? plats.find((x) => x.status === 'construction') ?? s;
  const statusLine =
    least.status === 'blueprint'
      ? h('div', { class: 'warn' }, partner && s.status !== 'blueprint' ? `The ${quadRole(net, least.id) ?? 'other'} platform is a blueprint — press Build to start construction` : 'Blueprint — press Build to start construction')
      : least.status === 'construction'
        ? h('div', { class: 'warn' }, `Under construction · ${Math.floor(progress(least, game.time) * 100)}%`)
        : null;
  const platformOf = (r: { stops: number[] }) => (partner ? (r.stops.includes(s.id) ? quadRole(net, s.id) : quadRole(net, partner.id)) : null);
  const routeChips = h(
    'div',
    { class: 'chip-list', style: 'margin:4px 0 2px' },
    ...(routes.length
      ? routes.map((r) => {
          const pl = platformOf(r);
          return h('span', { style: 'display:inline-flex;align-items:center;gap:6px;cursor:pointer', onclick: () => game.select({ kind: 'route', id: r.id }) }, bullet(r.color, r.bullet, 20, r.express), r.name, pl ? h('span', { class: 'hw-muted', style: 'font-size:11px' }, pl) : null);
        })
      : [h('span', { class: 'hw-muted' }, 'No routes serve this station yet')]),
  );
  // City chaos: closed by police activity.
  const closedBanner = h('div');
  const stats = h('div', { class: 'stat-grid', style: 'margin-top:8px' });
  const chartWrap = h('div', { class: 'chart' });
  const allBuilt = plats.every((x) => x.status === 'built');
  if (!allBuilt) chartWrap.append(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, 'Ridership appears once the station opens.'));
  const flowsWrap = h('div');
  // Living City: the value capture paid through this station (its nearest district tracts).
  const vcCell = h('span', { class: 'hw-muted' }, '…');
  attachTip(vcCell, app.tooltip, 'Value capture nearby', undefined, stationValueCaptureTip());
  const renderVc = () => {
    const v = app.growthView;
    if (!v) return;
    // A cross-platform pair (v2) is one station complex: its value capture is listed once, under the pair's key.
    const vk = pairKeyId(game.network, id);
    const served = app.servedList().some((p) => p.id === vk);
    if (!served) {
      vcCell.className = 'hw-muted';
      vcCell.textContent = allBuilt ? 'None: no service stops here' : 'None until it opens with service';
    } else if (game.growthPace === 'off') {
      vcCell.className = 'hw-muted';
      vcCell.textContent = 'None: city growth is off';
    } else {
      vcCell.className = '';
      vcCell.textContent = stationValueCaptureText(v.stationLevy[vk] ?? 0, v.stationTracts?.[vk] ?? 0);
    }
  };
  const roles = plats.map((x) => quadRole(net, x.id)).filter((r): r is 'local' | 'express' => r === 'local' || r === 'express');
  const platformsText = partner ? (roles.length === 2 ? [...roles].sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : 0)).join(' + ') : 'two') + ` · ${Math.max(s.cars, partner.cars)} cars` : roles.length ? `${s.cars} cars · ${roles[0]} pair only` : `${s.cars} cars`;
  const cost = plats.reduce((t, x) => t + (x.cost || 0), 0);
  body.append(statusLine ?? '', closedBanner, routeChips, stats, section('Boardings by hour'), chartWrap, flowsWrap, section('Station'), kv([
    ['Level', cap(LEVEL_NAMES[level])],
    ['Class', `${cap(cls)} metro`],
    [partner ? 'Platforms' : 'Platform', platformsText],
    [least.status === 'blueprint' ? 'Estimated cost' : 'Cost', fmtMoney(cost)],
    ['Value capture nearby', vcCell],
  ]));
  renderVc();
  if (!app.growthView) app.loadGrowthView().then(() => vcCell.isConnected && renderVc());
  const actions = h(
    'div',
    { style: 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap' },
    h('button', { class: 'hw-btn small', onclick: () => app.startRouteFrom(id) }, 'Start a route here'),
  );
  body.append(actions);

  let detail: StationDetail | null = null;
  let chart: { destroy(): void } | null = null;
  let closedId = -1;
  const pairKey = partner ? Math.min(s.id, partner.id) : id;
  const render = () => {
    const closed = app.feed.activeFor({ stationId: id }) ?? (partner ? app.feed.activeFor({ stationId: partner.id }) : undefined);
    if ((closed?.id ?? 0) !== closedId) {
      closedId = closed?.id ?? 0;
      closedBanner.replaceChildren(
        closed
          ? h('div', { class: 'err', style: 'cursor:pointer', onclick: () => game.select({ kind: 'alerts', focus: closed.id }) }, h('b', null, `Closed: police activity until ${fmtClock(closed.until)}. `), 'Trains run through; riders are sent to nearby stations.')
          : '',
      );
    }
    const by = ids.map((x) => app.report?.stationBoardings[x]).filter((v): v is number => v !== undefined);
    const boardY = by.length ? by.reduce((a, b) => a + b, 0) : undefined;
    const left = detail ? (detail.leftYesterday || detail.leftToday) : 0;
    const waiting = ids.reduce((t, x) => t + app.waitingAt(x), 0);
    const crowd = Math.max(...ids.map((x) => app.stationCrowding(x)));
    const cards = [
      statCard('Boardings yesterday', boardY !== undefined ? fmtCount(boardY) : '—'),
      statCard('Waiting now', fmtCount(waiting), crowd > 1 ? 'red' : crowd > 0.6 ? 'amber' : undefined),
      statCard('Left behind', fmtCount(left), left > 0 ? 'amber' : undefined),
      statCard('Today so far', detail ? fmtCount(detail.hourlyToday.reduce((a, b) => a + b, 0)) : '—'),
    ];
    if (partner) {
      const xt = app.report?.crossTransfers?.[pairKey];
      const card = statCard('Cross-platform transfers', xt !== undefined ? fmtCount(xt) : app.report?.crossTransfers ? '0' : '—');
      attachTip(card, app.tooltip, 'Cross-platform transfers (yesterday)', undefined, 'People who changed trains by stepping across the island platform here (15 s, a lighter transfer penalty): usually between a local and an express.');
      cards.push(card);
    }
    stats.replaceChildren(...cards);
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
    const built = plats.filter((x) => x.status === 'built');
    if (!built.length) return;
    // A pair: both platforms' figures together.
    Promise.all(built.map((x) => app.sim.query<StationDetail | null>({ kind: 'station', station: x.id }))).then((list) => {
      const ds = list.filter((d): d is StationDetail => !!d);
      if (!ds.length) return;
      detail = ds.length === 1 ? ds[0] : mergeDetails(ds);
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
    dayEnd: () => {
      fetch();
      app.loadGrowthView().then(() => vcCell.isConnected && renderVc());
    },
    destroy: () => {
      chart?.destroy();
      app.setStationFlows(null, [], []);
    },
  };
}
