/**
 * Station tool: hover track to preview the platform and its 800 m walking catchment;
 * click to place. Platforms need nearly straight, level track and 400 m spacing.
 */
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { STATION, TRACK, type TrackClass } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtDistance, fmtMoney } from '../core/units';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import type { Pointer, Tool } from '../ui/toolTypes';
import { cap } from './describe';
import { platformLength } from './network';
import { pickEdge } from './pick';
import { slicePolyline } from '../map/polyline';
import { LEVEL_NAMES, stationReport, type StationReport } from './validate';

export class StationTool implements Tool {
  readonly id = 'station' as const;
  readonly xray = true;
  cars: Record<TrackClass, number> = { heavy: STATION.cars.heavy.default, light: STATION.cars.light.default };
  private hover: { edge: number; u: number; report: StationReport; cls: TrackClass; x: number; y: number } | null = null;
  private pointer: Pointer | null = null;

  constructor(private ctx: AppContext) {}

  deactivate(): void {
    this.hover = null;
    this.ctx.tip(null);
    this.ctx.redraw();
  }

  move(p: Pointer): void {
    this.pointer = p;
    const net = this.ctx.game.network;
    const hit = pickEdge(net, p.x, p.y, this.ctx.tol(TRACK.snapPx + 4));
    if (!hit) {
      this.hover = null;
      this.ctx.tip(`<div class="hw-muted">Hover over track to place a station</div>`, p.px);
      this.ctx.redraw();
      return;
    }
    const cls = net.edges.get(hit.edge)!.cls;
    const cars = this.cars[cls];
    const report = stationReport(net, hit.edge, hit.u, cars, this.ctx.game.terrain);
    this.hover = { edge: hit.edge, u: hit.u, report, cls, x: hit.x, y: hit.y };
    const lvl = report.level ? cap(LEVEL_NAMES[report.level]) : '';
    const lines = [
      `<div class="title">${lvl} station · ${cars} cars</div>`,
      `<div class="row"><span class="hw-muted">Platform</span><span class="num">${fmtDistance(platformLength(cars, cls), true)}</span></div>`,
      `<div class="row"><span class="hw-muted">Cost</span><span class="num">${fmtMoney(report.cost)}</span></div>`,
      `<div class="row"><span class="hw-muted">Build time</span><span class="num">${report.days} days</span></div>`,
      report.ok ? `<div class="hw-green" style="margin-top:3px">Click to place</div>` : `<div class="reason hw-red">${report.errors[0]}</div>`,
    ];
    this.ctx.tip(lines.join(''), p.px);
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    this.move(p);
    const hv = this.hover;
    if (!hv) return;
    if (!hv.report.ok) {
      this.ctx.toast("Can't place a station here", hv.report.errors[0], 'red');
      return;
    }
    const game = this.ctx.game;
    const pos = game.network.stationPos({ edge: hv.edge, u: hv.u } as never);
    const name = this.ctx.nameStation(pos.x, pos.y);
    game.editBlueprint(() => game.network.addStation(hv.edge, hv.u, this.cars[hv.cls], name));
    this.ctx.toast('Station planned', `${name} — Build to start construction`, 'green');
    this.move(p);
  }

  leave(): void {
    this.ctx.tip(null);
  }

  layers(): Layer[] {
    const hv = this.hover;
    if (!hv) return [];
    const net = this.ctx.game.network;
    const g = net.geom(hv.edge);
    const P = platformLength(this.cars[hv.cls], hv.cls);
    const pts = slicePolyline(g.xs, g.ys, g.cum, Math.max(0, hv.u - P / 2), Math.min(g.length, hv.u + P / 2)).map(([x, y]) => toLonLat(x, y));
    const centre = net.stationPos({ edge: hv.edge, u: hv.u } as never);
    const col: [number, number, number, number] = hv.report.ok ? [76, 208, 138, 255] : [255, 93, 93, 255];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    return [
      new ScatterplotLayer({
        id: 'station-catchment',
        data: [toLonLat(centre.x, centre.y)],
        getPosition: (d) => d,
        getRadius: STATION.catchment,
        radiusUnits: 'meters',
        getFillColor: [col[0], col[1], col[2], 22],
        stroked: true,
        getLineColor: [col[0], col[1], col[2], 110],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        parameters: DEPTH,
        updateTriggers: { getFillColor: hv.report.ok, getLineColor: hv.report.ok },
      }),
      new PathLayer({
        id: 'station-platform',
        data: [pts],
        getPath: (d) => d,
        getColor: col,
        getWidth: 10,
        widthUnits: 'pixels',
        capRounded: true,
        parameters: DEPTH,
        updateTriggers: { getColor: hv.report.ok },
      }),
    ];
  }

  options(): HTMLElement {
    const row = (cls: TrackClass) => {
      const lim = STATION.cars[cls];
      const btns = [];
      for (let c = lim.min; c <= lim.max; c++)
        btns.push(
          h('button', { class: this.cars[cls] === c ? 'on' : '', onclick: () => { this.cars[cls] = c; this.ctx.refreshOptions(); if (this.pointer) this.move(this.pointer); } }, String(c)),
        );
      return h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, cls === 'heavy' ? 'Heavy' : 'Light'), h('div', { class: 'seg' }, ...btns), h('span', { class: 'hw-muted', style: 'font-size:12px' }, 'cars'));
    };
    return h(
      'div',
      null,
      h('div', { class: 'opt-label', style: 'margin-bottom:6px' }, 'Platform length'),
      row('heavy'),
      h('div', { style: 'height:6px' }),
      row('light'),
      h('div', { class: 'opt-hint', style: 'margin-top:8px' }, `Stations need nearly straight, level track and ${fmtDistance(STATION.minSpacing, true)} between them. Stations within ${fmtDistance(STATION.interchangeRadius, true)} of each other become interchanges. Circle shows the ${fmtDistance(STATION.catchment, true)} walking catchment.`),
    );
  }
}
