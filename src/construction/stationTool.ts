/**
 * Station tool: hover track to preview the platform and its 800 m walking catchment;
 * click to place. Platforms need nearly straight, level track and 400 m spacing.
 *
 * Four-track sections (v2, docs/v2/express-quad.md §2.2): a click places a cross-platform
 * station (one platform on each pair, linked); next to a lone platform on the other pair it adds
 * the matching platform (link); Shift-click places one platform on the hovered pair only.
 */
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { QUAD, STATION, TRACK, type TrackClass } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtDistance, fmtMoney } from '../core/units';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import { stationQuadTip, type StationHoverMode } from '../ui/express';
import type { Pointer, Tool } from '../ui/toolTypes';
import { cap } from './describe';
import { platformLength } from './network';
import { pickEdge } from './pick';
import { partnerPoint } from './quad';
import { slicePolyline } from '../map/polyline';
import { LEVEL_NAMES, stationReport, type StationReport } from './validate';
import type { Network } from './network';
import type { Station } from './types';

interface Hover {
  edge: number;
  u: number;
  report: StationReport;
  cls: TrackClass;
  x: number;
  y: number;
  /** Four-track sections: pair, link or single (absent on ordinary track). */
  mode?: StationHoverMode;
  /** The other platform (pair mode: a new one; link mode: the existing one's opposite is `edge/u`). */
  other?: { edge: number; u: number; report: StationReport | null };
  ok: boolean;
  error?: string;
}

/**
 * A lone platform on the other pair of the same four-track section whose opposite point on the
 * hovered pair lies within QUAD.pairLinkDistance of (x, y): the new platform pairs up with it,
 * aligned opposite it.
 */
export function linkCandidate(net: Network, edge: number, x: number, y: number): { existing: Station; edge: number; u: number } | null {
  const t = net.edges.get(edge)?.quad;
  if (!t || t.role === 'link') return null;
  let best: { existing: Station; edge: number; u: number; d: number } | null = null;
  for (const s of net.stations.values()) {
    if (s.pair !== undefined) continue;
    const q = net.edges.get(s.edge)?.quad;
    if (!q || q.g !== t.g || q.role === t.role || q.role === 'link') continue;
    const p = net.stationPos(s);
    if (Math.hypot(p.x - x, p.y - y) > QUAD.pairLinkDistance + QUAD.spacing) continue;
    const pp = partnerPoint(net, s.edge, s.u);
    if (!pp) continue;
    const d = Math.hypot(pp.x - x, pp.y - y);
    if (d <= QUAD.pairLinkDistance && (!best || d < best.d)) best = { existing: s, edge: pp.edge, u: pp.u, d };
  }
  return best && { existing: best.existing, edge: best.edge, u: best.u };
}

export class StationTool implements Tool {
  readonly id = 'station' as const;
  readonly xray = true;
  cars: Record<TrackClass, number> = { heavy: STATION.cars.heavy.default, light: STATION.cars.light.default };
  private hover: Hover | null = null;
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
    const t = net.edges.get(hit.edge)!.quad;
    if (t && t.role !== 'link') {
      this.moveQuad(p, hit, cls, cars, t.role);
      return;
    }
    const report = stationReport(net, hit.edge, hit.u, cars, this.ctx.game.terrain);
    this.hover = { edge: hit.edge, u: hit.u, report, cls, x: hit.x, y: hit.y, ok: report.ok, error: report.errors[0] };
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

  /** Hover on a four-track pair: pair, link or (Shift) single platform. */
  private moveQuad(p: Pointer, hit: { edge: number; u: number; x: number; y: number }, cls: TrackClass, cars: number, role: 'local' | 'express'): void {
    const net = this.ctx.game.network;
    const terrain = this.ctx.game.terrain;
    const link = p.shift ? null : linkCandidate(net, hit.edge, hit.x, hit.y);
    const pp = p.shift || link ? null : partnerPoint(net, hit.edge, hit.u);
    let hv: Hover;
    if (link) {
      // Aligned opposite the existing platform; priced as half of a pair.
      const report = stationReport(net, link.edge, link.u, cars, terrain, null, { partner: link.existing.id });
      const q = net.stationPos({ edge: link.edge, u: link.u } as never);
      hv = { edge: link.edge, u: link.u, report, cls, x: q.x, y: q.y, mode: { kind: 'link', existing: link.existing }, ok: report.ok, error: report.errors[0] };
    } else if (pp) {
      const a = stationReport(net, hit.edge, hit.u, cars, terrain, null, { paired: true });
      const b = stationReport(net, pp.edge, pp.u, cars, terrain, null, { paired: true });
      const error = a.errors[0] ?? b.errors[0];
      hv = {
        edge: hit.edge,
        u: hit.u,
        report: { ...a, ok: a.ok && b.ok, cost: a.cost + b.cost, days: Math.max(a.days, b.days), errors: [...a.errors, ...b.errors] },
        cls,
        x: hit.x,
        y: hit.y,
        mode: { kind: 'pair', partnerEdge: pp.edge, partnerU: pp.u },
        other: { edge: pp.edge, u: pp.u, report: b },
        ok: a.ok && b.ok,
        error,
      };
    } else {
      const report = stationReport(net, hit.edge, hit.u, cars, terrain);
      hv = { edge: hit.edge, u: hit.u, report, cls, x: hit.x, y: hit.y, mode: { kind: 'single' }, ok: report.ok, error: report.errors[0] };
    }
    this.hover = hv;
    this.ctx.tip(stationQuadTip({ mode: hv.mode!, role, level: hv.report.level, cars, cost: hv.report.cost, days: hv.report.days, error: hv.error }), p.px);
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    this.move(p);
    const hv = this.hover;
    if (!hv) return;
    if (!hv.ok) {
      this.ctx.toast("Can't place a station here", hv.error, 'red');
      return;
    }
    const game = this.ctx.game;
    const net = game.network;
    const cars = this.cars[hv.cls];
    const mode = hv.mode;
    if (mode?.kind === 'pair') {
      const a = net.stationPos({ edge: hv.edge, u: hv.u } as never);
      const b = net.stationPos({ edge: mode.partnerEdge, u: mode.partnerU } as never);
      const name = this.ctx.nameStation((a.x + b.x) / 2, (a.y + b.y) / 2);
      game.editBlueprint(() => net.addStationPair(hv.edge, hv.u, mode.partnerEdge, mode.partnerU, cars, name));
      this.ctx.toast('Cross-platform station planned', `${name} — local and express platforms · Build to start construction`, 'green');
    } else if (mode?.kind === 'link') {
      const ex = mode.existing;
      game.editBlueprint(() => {
        const s = net.addStation(hv.edge, hv.u, cars, ex.name);
        s.nameAuto = ex.nameAuto;
        net.linkPair(ex.id, s.id);
      });
      this.ctx.toast('Platform added', `${ex.name} is now cross-platform — Build to start construction`, 'green');
    } else {
      const pos = net.stationPos({ edge: hv.edge, u: hv.u } as never);
      const name = this.ctx.nameStation(pos.x, pos.y);
      game.editBlueprint(() => net.addStation(hv.edge, hv.u, cars, name));
      this.ctx.toast('Station planned', `${name} — Build to start construction`, 'green');
    }
    this.move(p);
  }

  leave(): void {
    this.ctx.tip(null);
  }

  layers(): Layer[] {
    const hv = this.hover;
    if (!hv) return [];
    const net = this.ctx.game.network;
    const P = platformLength(this.cars[hv.cls], hv.cls);
    const platform = (edge: number, u: number) => {
      const g = net.geom(edge);
      return slicePolyline(g.xs, g.ys, g.cum, Math.max(0, u - P / 2), Math.min(g.length, u + P / 2)).map(([x, y]) => toLonLat(x, y));
    };
    const plats = [platform(hv.edge, hv.u)];
    let centre = net.stationPos({ edge: hv.edge, u: hv.u } as never) as { x: number; y: number };
    // The other platform of a pair (new, or the existing one in link mode); one catchment at the midpoint.
    const other = hv.mode?.kind === 'pair' ? { edge: hv.mode.partnerEdge, u: hv.mode.partnerU } : hv.mode?.kind === 'link' ? { edge: hv.mode.existing.edge, u: hv.mode.existing.u } : null;
    if (other && net.edges.has(other.edge)) {
      plats.push(platform(other.edge, other.u));
      const q = net.stationPos({ edge: other.edge, u: other.u } as never);
      centre = { x: (centre.x + q.x) / 2, y: (centre.y + q.y) / 2 };
    }
    const col: [number, number, number, number] = hv.ok ? [76, 208, 138, 255] : [255, 93, 93, 255];
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
        updateTriggers: { getFillColor: hv.ok, getLineColor: hv.ok },
      }),
      new PathLayer({
        id: 'station-platform',
        data: plats,
        getPath: (d) => d,
        getColor: col,
        getWidth: plats.length > 1 ? 7 : 10,
        widthUnits: 'pixels',
        capRounded: true,
        parameters: DEPTH,
        updateTriggers: { getColor: hv.ok, getWidth: plats.length },
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
      h('div', { class: 'opt-hint', style: 'margin-top:6px' }, `Four tracks: a click places a cross-platform station (a platform on each pair, ${Math.round(QUAD.pairPlatformCostShare * 100)}% each); Shift-click places one platform on the pair under the cursor (a local-only stop).`),
    );
  }
}
