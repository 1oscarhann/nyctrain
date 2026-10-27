/**
 * Line tool (L): build a whole line by placing its stations. Click where each station goes (start on
 * an existing station or track end to extend from it); the tool lays straight platform sections at
 * each stop, curves between them, and on Enter (or a double-click) plans the track and stations as
 * blueprints and creates a route serving them. Esc cancels, Backspace removes the last stop.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { gaugeOf, LEVELS, STATION, TRAINS, type TrackClass, type TrackLevel } from '../balance';
import { PLATFORM_CLEAR, stationStroke } from './lineStroke';
import { city, trackClasses } from '../cities';
import { toLonLat } from '../core/geo';
import { trackClassName } from '../core/trackNames';
import { fmtDistance, fmtMoney } from '../core/units';
import { carsFitting, validStock } from '../routes/routeSet';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import type { Pointer, Tool } from '../ui/toolTypes';
import { cap } from './describe';
import { projectOnPolyline } from './geometry';
import { platformLength, type Network } from './network';
import { pickNode } from './pick';
import type { Snap, StrokePoint } from './types';
import { edgeReport, LEVEL_NAMES, stationReport } from './validate';

/** Clearance beyond each end of a platform before the track may curve, m. */

interface Stop {
  x: number;
  y: number;
  /** An existing station the line starts from (first stop only). */
  existing?: number;
}

interface Plan {
  net: Network;
  edges: number[];
  /** New stations: id in `net`, position, ok. */
  stations: { id: number; x: number; y: number; ok: boolean; reason?: string }[];
  errors: string[];
  cost: number;
  length: number;
}

/** What the App gives the line tool beyond the tool context (station names, platform length, routes). */
interface LineHost extends AppContext {
  stationTool: { cars: Record<TrackClass, number> };
  routeTool: { newDraft(): void; draft: object | null; recompute(): void; save(): boolean; problems(): string[] };
}

export class LineTool implements Tool {
  readonly id = 'line' as const;
  readonly xray = true;
  level: TrackLevel;
  cls: TrackClass = trackClasses()[0];
  makeRoute = true;
  private stops: Stop[] = [];
  private startSnap: Snap = { kind: 'none' };
  private startPt: { x: number; y: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private plan: Plan | null = null;
  private pointer: Pointer | null = null;

  constructor(private ctx: LineHost) {
    this.level = city().defaultLevel ?? (city().intertown ? 'at-grade' : 'deep');
  }

  activate(): void {
    this.ctx.refreshOptions();
  }

  deactivate(): void {
    this.ctx.tip(null);
  }

  private cars(): number {
    return this.ctx.stationTool.cars[this.cls];
  }

  /** Where a click starts the line: an existing station (and the track end it's on), or a free track end. */
  private startAt(x: number, y: number): { snap: Snap; pt: { x: number; y: number }; station?: number } | null {
    const net = this.ctx.game.network;
    const tol = this.ctx.tol(14);
    const sid = this.ctx.stations.pick(x, y, tol);
    const freeEnd = (id: number) => net.degree(id) === 1 && net.nodes.get(id)!.leadOf === null && gaugeOf(net.nodes.get(id)!.cls) === gaugeOf(this.cls);
    if (sid !== null) {
      const s = net.stations.get(sid)!;
      const e = net.edges.get(s.edge)!;
      // The nearer free end of the station's track (Victoria's stub, the end of a line).
      const ends = [e.a, e.b].filter(freeEnd).map((id) => net.nodes.get(id)!);
      const p = net.stationPos(s);
      ends.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
      if (ends.length) return { snap: { kind: 'node', node: ends[0].id }, pt: { x: ends[0].x, y: ends[0].y }, station: sid };
      return null;
    }
    const nid = pickNode(net, x, y, tol, freeEnd);
    if (nid !== null) {
      const n = net.nodes.get(nid)!;
      return { snap: { kind: 'node', node: nid }, pt: { x: n.x, y: n.y } };
    }
    return null;
  }

  /** The line on a copy of the network: straight platform sections at each new stop, curves between. */
  private build(stops: Stop[]): Plan | null {
    const game = this.ctx.game;
    const net = game.network.clone();
    const errors: string[] = [];
    const newStops = stops.filter((s) => s.existing === undefined);
    const first = this.startPt;
    const all: { x: number; y: number; isNew: boolean }[] = [...(first ? [{ ...first, isNew: false }] : []), ...newStops.map((s) => ({ x: s.x, y: s.y, isNew: true }))];
    if (all.length < 2) return null;
    const cars = this.cars();
    const half = platformLength(cars, this.cls) / 2 + PLATFORM_CLEAR;
    const lv = this.level;
    for (let i = 1; i < all.length; i++) {
      const p = all[i], prev = all[i - 1];
      if (!p.isNew) continue;
      const gap = Math.hypot(p.x - prev.x, p.y - prev.y);
      const need = (prev.isNew ? half : 0) + half + 80;
      if (gap < Math.max(STATION.minSpacing, need)) errors.push(`Stations ${fmtDistance(gap, true)} apart: these platforms need at least ${fmtDistance(Math.max(STATION.minSpacing, need), true)}`);
    }
    const startLevel = this.startSnap.kind === 'node' ? net.nodes.get(this.startSnap.node)?.level : undefined;
    const pts = stationStroke(all, this.cls, cars, lv, startLevel);
    let edges: number[] = [];
    try {
      edges = net.addStroke(pts, this.cls, this.startSnap, { kind: 'none' });
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (!edges.length) return { net, edges, stations: [], errors: errors.length ? errors : ['This line can’t be laid here'], cost: 0, length: 0 };
    const stations: Plan['stations'] = [];
    for (const p of all.filter((q) => q.isNew)) {
      let best: { edge: number; u: number; d: number } | null = null;
      for (const id of edges) {
        const g = net.geom(id);
        const pr = projectOnPolyline(g.xs, g.ys, g.cum, p.x, p.y);
        if (!best || pr.d < best.d) best = { edge: id, u: pr.s, d: pr.d };
      }
      if (!best) continue;
      const rep = stationReport(net, best.edge, best.u, cars, game.terrain);
      const st = net.addStation(best.edge, best.u, cars, '');
      stations.push({ id: st.id, x: p.x, y: p.y, ok: rep.ok, reason: rep.errors[0] });
    }
    let cost = 0, length = 0;
    for (const id of edges) {
      const r = edgeReport(net, id, game.terrain);
      cost += r.cost;
      length += r.length;
      if (!r.ok && r.errors[0]) errors.push(r.errors[0]);
    }
    for (const s of stations) {
      const st = net.stations.get(s.id)!;
      cost += stationReport(net, st.edge, st.u, cars, game.terrain, st.id).cost;
      if (!s.ok && s.reason) errors.push(s.reason);
    }
    return { net, edges, stations, errors: [...new Set(errors)], cost, length };
  }

  move(p: Pointer): void {
    this.pointer = p;
    if (!this.stops.length) {
      const st = this.startAt(p.x, p.y);
      this.hover = null;
      this.plan = null;
      this.ctx.tip(
        st
          ? `<div class="hw-green">Click to start the line here${st.station !== undefined ? ` (from ${this.ctx.game.network.stations.get(st.station)!.name})` : ' (extending this track)'}</div>`
          : `<div class="title">${cap(LEVEL_NAMES[this.level])} · ${trackClassName(this.cls)}</div><div class="hw-muted">Click where the first station goes</div>`,
        p.px,
      );
      this.ctx.redraw();
      return;
    }
    this.hover = { x: p.x, y: p.y };
    this.plan = this.build([...this.stops, { x: p.x, y: p.y }]);
    const n = this.stops.filter((s) => s.existing === undefined).length + 1;
    const pl = this.plan;
    const err = pl?.errors[0];
    this.ctx.tip(
      `<div class="title">Station ${n}</div>` +
        (pl ? `<div class="row"><span class="hw-muted">Line so far</span><span class="num">${fmtDistance(pl.length)} · ${fmtMoney(pl.cost)}</span></div>` : '') +
        (err ? `<div class="reason hw-red">${err}</div>` : `<div class="hw-green">Click to place · Enter or double-click to finish</div>`),
      p.px,
    );
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    if (!this.stops.length) {
      const st = this.startAt(p.x, p.y);
      if (st) {
        this.startSnap = st.snap;
        this.startPt = st.pt;
        this.stops.push(st.station !== undefined ? { x: st.pt.x, y: st.pt.y, existing: st.station } : { x: st.pt.x, y: st.pt.y, existing: -1 });
      } else {
        this.startSnap = { kind: 'none' };
        this.startPt = null;
        this.stops.push({ x: p.x, y: p.y });
      }
      this.move(p);
      return;
    }
    const last = this.stops[this.stops.length - 1];
    if (Math.hypot(last.x - p.x, last.y - p.y) < 30) return;
    this.stops.push({ x: p.x, y: p.y });
    this.move(p);
  }

  dblclick(): void {
    this.finish();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    if (e.key === 'Backspace' && this.stops.length) {
      this.stops.pop();
      if (!this.stops.length) this.reset();
      if (this.pointer) this.move(this.pointer);
      return true;
    }
    if (e.key === 'Escape' && this.stops.length) {
      this.reset();
      this.ctx.redraw();
      return true;
    }
    return false;
  }

  private reset(): void {
    this.stops = [];
    this.startSnap = { kind: 'none' };
    this.startPt = null;
    this.plan = null;
    this.hover = null;
  }

  /** Plan the line for real (blueprints), name its stations and make its route. */
  private finish(): void {
    const ctx = this.ctx;
    const game = ctx.game;
    // A double-click adds its point twice: the last click is the end.
    const plan = this.build(this.stops);
    if (!plan || plan.stations.length + (this.stops[0]?.existing !== undefined && this.stops[0].existing >= 0 ? 1 : 0) < 2) {
      ctx.toast('A line needs two stations', 'Click at least two places for stations, then press Enter.', 'amber');
      return;
    }
    if (plan.errors.length) {
      ctx.toast("Can't plan this line", plan.errors[0], 'red');
      return;
    }
    const stops = [...this.stops];
    const startSnap = this.startSnap;
    const cars = this.cars();
    const ids = game.editBlueprint(() => {
      const net = game.network;
      const pts = this.strokeFor(stops, cars);
      const edges = net.addStroke(pts, this.cls, startSnap, { kind: 'none' });
      const out: number[] = [];
      for (const s of stops.filter((q) => q.existing === undefined)) {
        let best: { edge: number; u: number; d: number } | null = null;
        for (const id of edges) {
          const g = net.geom(id);
          const pr = projectOnPolyline(g.xs, g.ys, g.cum, s.x, s.y);
          if (!best || pr.d < best.d) best = { edge: id, u: pr.s, d: pr.d };
        }
        if (best) out.push(net.addStation(best.edge, best.u, cars, ctx.nameStation(s.x, s.y)).id);
      }
      return out;
    });
    const existing = stops[0]?.existing;
    const routeStops = [...(existing !== undefined && existing >= 0 ? [existing] : []), ...ids];
    this.reset();
    ctx.redraw();
    if (this.makeRoute && routeStops.length >= 2) {
      const rt = ctx.routeTool;
      rt.newDraft();
      const d = rt.draft!;
      const net = game.network;
      const gauge = gaugeOf(this.cls);
      const stock = validStock(city().defaultHeavyStock ?? 'heavy', gauge);
      const fit = Math.min(...routeStops.map((id) => carsFitting(net, net.stations.get(id)!, stock)));
      const first = net.stations.get(routeStops[0])!.name, lastN = net.stations.get(routeStops[routeStops.length - 1])!.name;
      // A metro starts at 8 cars; a map with its own platform length (Japan: 16) runs full-length trains.
      const want = city().platformCars?.[this.cls] ?? 8;
      Object.assign(d, { cls: gauge, stock, stops: routeStops, cars: Math.max(TRAINS[stock].minCars, Math.min(fit, TRAINS[stock].maxCars, want)), name: `${first.split(' – ')[0]} – ${lastN.split(' – ')[0]}` });
      rt.recompute();
      ctx.setTool('route');
      ctx.toast('Line planned', `${routeStops.length} stations. Press Build at the bottom to start construction; the route runs once it opens.`, 'green');
    } else ctx.toast('Line planned', `${ids.length} stations. Press Build at the bottom to start construction.`, 'green');
  }

  /** The stroke for the real network (the same geometry as build()). */
  private strokeFor(stops: Stop[], cars: number): StrokePoint[] {
    const newStops = stops.filter((s) => s.existing === undefined);
    const first = this.startPt;
    const all = [...(first ? [{ ...first, isNew: false }] : []), ...newStops.map((s) => ({ x: s.x, y: s.y, isNew: true }))];
    const startLevel = this.startSnap.kind === 'node' ? this.ctx.game.network.nodes.get(this.startSnap.node)?.level : undefined;
    return stationStroke(all, this.cls, cars, this.level, startLevel);
  }

  layers(): Layer[] {
    const plan = this.plan;
    const out: Layer[] = [];
    if (plan) {
      const ok = plan.errors.length === 0;
      const paths = plan.edges.map((id) => {
        const g = plan.net.geom(id);
        const path: [number, number][] = [];
        for (let i = 0; i < g.xs.length; i++) path.push(toLonLat(g.xs[i], g.ys[i]));
        return path;
      });
      out.push(
        new PathLayer<[number, number][]>({
          id: 'line-tool-track',
          data: paths,
          getPath: (d) => d,
          getColor: ok ? [255, 255, 255, 220] : [255, 93, 93, 230],
          getWidth: 4,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
      );
    }
    const pts = [...this.stops.filter((s) => s.existing === undefined || s.existing === -1), ...(this.hover ? [{ ...this.hover }] : [])];
    out.push(
      new ScatterplotLayer<{ x: number; y: number }>({
        id: 'line-tool-stops',
        data: pts,
        getPosition: (d) => toLonLat(d.x, d.y),
        getRadius: 6,
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: [255, 255, 255, 255],
        getLineColor: [10, 10, 12, 255],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
      new TextLayer<{ x: number; y: number; i: number }>({
        id: 'line-tool-numbers',
        data: pts.map((p, i) => ({ ...p, i })),
        getPosition: (d) => toLonLat(d.x, d.y),
        getText: (d) => String(d.i + 1),
        getSize: 12,
        getColor: [255, 255, 255, 255],
        getPixelOffset: [0, -16],
        fontWeight: 700,
        outlineWidth: 3,
        outlineColor: [10, 10, 12, 230],
        fontSettings: { sdf: true, fontSize: 40, buffer: 6 },
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    );
    return out;
  }

  options(): HTMLElement {
    const lv = (l: TrackLevel) => h('button', { class: this.level === l ? 'on' : '', onclick: () => { this.level = l; this.ctx.refreshOptions(); if (this.pointer) this.move(this.pointer); } }, cap(LEVEL_NAMES[l]));
    const cl = (c: TrackClass) => h('button', { class: this.cls === c ? 'on' : '', onclick: () => { this.cls = c; this.reset(); this.ctx.refreshOptions(); this.ctx.redraw(); } }, trackClassName(c));
    const cars = this.cars();
    return h(
      'div',
      null,
      trackClasses().length > 1 ? h('div', { class: 'opt-row', style: 'margin-bottom:8px' }, h('span', { class: 'opt-label' }, 'Class'), h('div', { class: 'seg' }, ...trackClasses().map(cl))) : null,
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Level'), h('div', { class: 'seg' }, ...LEVELS.map(lv))),
      h(
        'label',
        { class: 'opt-row', style: 'margin-top:8px;gap:8px;cursor:pointer' },
        h('input', { type: 'checkbox', checked: this.makeRoute, onchange: (e: Event) => { this.makeRoute = (e.target as HTMLInputElement).checked; } }),
        'Make a route along it',
      ),
      h('div', { class: 'opt-hint', style: 'margin-top:8px' }, `Click where each station goes; the track follows with curves between them. Start on an existing station or track end to extend it. ${cars}-car platforms (set in the Station tool). Enter or double-click finishes, Backspace removes the last stop, Esc cancels.`),
    );
  }
}
