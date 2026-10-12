/** Train, tract and track panels. */
import { city } from '../../cities';
import { TRAINS } from '../../balance';
import { edgeTooltip } from '../../construction/describe';
import { fmtClock, fmtCount, fmtDensity, fmtSpeed } from '../../core/units';
import type { App } from '../app';
import { bullet, h } from '../dom';
import { kv, section, shareBar, shell, SHARE_COLORS, statCard, type Panel } from './common';

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
    body.replaceChildren(
      banner ?? '',
      h('div', { class: 'hw-muted', style: 'margin-bottom:8px' }, `Towards ${terminal}`),
      h(
        'div',
        { class: 'stat-grid' },
        statCard('On board', fmtCount(people), lf > 1.4 ? 'red' : lf > 1 ? 'amber' : undefined),
        statCard('Load', `${Math.round(lf * 100)}%`, lf > 1.4 ? 'red' : lf > 1 ? 'amber' : undefined),
        statCard(t.state === 2 ? 'At' : 'Next stop', next),
        statCard('Lateness', t.late > 30 ? `${Math.round(t.late / 60)} min late` : 'On time', t.late > 180 ? 'red' : t.late > 60 ? 'amber' : 'green'),
      ),
      section('Train'),
      kv([
        ['Speed', t.state === 2 ? 'Dwelling' : fmtSpeed(t.v)],
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
  // London MSOAs carry names ("Camden 028"); NYC tracts are numbered within the borough.
  const title = t.name ?? `${t.borough} tract ${String(Number(t.id.slice(5)) / 100).replace(/\.0+$/, '')}`;
  const sh = shell(`${t.name ? 'Neighbourhood area' : 'Census tract'} ${t.id} · ${t.borough}`, title, () => app.game.select(null));
  const body = sh.body;
  const stats = h('div', { class: 'stat-grid' });
  const shares = h('div');
  body.append(stats, section('How residents commute'), shares);
  const render = (d: TractDetail | null) => {
    stats.replaceChildren(
      statCard('Residents', fmtCount(t.residents)),
      statCard('Jobs', fmtCount(t.jobs)),
      statCard('Avg commute', d ? `${d.avgCommute.toFixed(1)} min` : '—'),
      statCard('No good transit', d ? fmtCount(d.unserved) : '—', d && d.unserved > 0 ? 'amber' : undefined),
    );
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
  render(null);
  const fetch = () => app.sim.query<TractDetail>({ kind: 'tract', tract: index }).then(render);
  fetch();
  app.setTractHighlight(index);
  return { el: sh.el, dayEnd: fetch, destroy: () => app.setTractHighlight(null) };
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
