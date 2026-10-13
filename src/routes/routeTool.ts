/**
 * Route tool: click stations in order (click again to remove, Shift-click to add at the start).
 * The path between them is found along connected track and previewed live. The side panel
 * edits the draft's name, bullet, colour, train length and frequencies.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { STATION, type TrackClass } from '../balance';
import { toLonLat } from '../core/geo';
import { slicePolyline } from '../map/polyline';
import { hexRgb } from '../map/networkLayers';
import type { AppContext } from '../ui/context';
import type { Pointer, Tool } from '../ui/toolTypes';
import { findRoutePath } from './pathfind';
import { defaultHeadways } from './routeSet';
import type { PeriodId, Route, RoutePath } from './types';
import { purchaseFleet, fleetPlan } from './fleet';
import { fmtMoney } from '../core/units';

export interface RouteDraft {
  editing: number | null;
  name: string;
  bullet: string;
  color: string;
  cls: TrackClass | null;
  stops: number[];
  cars: number;
  headways: Record<PeriodId, number>;
}

export class RouteTool implements Tool {
  readonly id = 'route' as const;
  readonly xray = false;
  draft: RouteDraft | null = null;
  path: RoutePath | null = null;
  private hoverStation: number | null = null;
  /** Called whenever the draft changes (the side panel re-renders). */
  onChange: () => void = () => {};

  constructor(private ctx: AppContext) {}

  activate(): void {
    if (!this.draft) this.newDraft();
    this.onChange();
  }

  deactivate(): void {
    this.ctx.tip(null);
    this.hoverStation = null;
  }

  newDraft(): void {
    const routes = this.ctx.game.routes;
    this.draft = {
      editing: null,
      name: '',
      bullet: routes.nextBullet(),
      color: routes.nextColor(),
      cls: null,
      stops: [],
      cars: STATION.cars.heavy.default,
      headways: defaultHeadways(),
    };
    this.path = null;
  }

  editRoute(r: Route): void {
    this.draft = {
      editing: r.id,
      name: r.name,
      bullet: r.bullet,
      color: r.color,
      cls: r.cls,
      stops: [...r.stops],
      cars: r.cars,
      headways: { ...r.headways },
    };
    this.recompute();
  }

  recompute(): void {
    const d = this.draft;
    if (!d || d.stops.length < 2 || !d.cls) {
      this.path = null;
    } else {
      this.path = findRoutePath(this.ctx.game.network, d.cls, d.stops);
    }
    this.onChange();
    this.ctx.redraw();
  }

  /** The draft as a Route object (for fleet sizing previews). */
  asRoute(): Route | null {
    const d = this.draft;
    if (!d || !d.cls) return null;
    const existing = d.editing !== null ? this.ctx.game.routes.get(d.editing) : undefined;
    return {
      id: d.editing ?? -1,
      name: d.name,
      bullet: d.bullet,
      color: d.color,
      cls: d.cls,
      stops: d.stops,
      cars: d.cars,
      headways: d.headways,
      ownedCars: existing?.ownedCars ?? 0,
      // New routes get the defaults (fleet sizing includes their recovery time).
      control: existing?.control ?? this.ctx.game.routes.newControl(),
    };
  }

  /** Problems that block saving. */
  problems(): string[] {
    const d = this.draft;
    const out: string[] = [];
    if (!d) return out;
    if (d.stops.length < 2) out.push('Click at least two stations');
    if (this.path && !this.path.ok) out.push(this.path.error ?? 'No path');
    const net = this.ctx.game.network;
    for (const sid of d.stops) {
      const s = net.stations.get(sid);
      if (s && s.cars < d.cars) {
        out.push(`${s.name}'s platform is only ${s.cars} cars — shorten the trains`);
        break;
      }
    }
    if (!d.name.trim()) out.push('Give the route a name');
    if (!d.bullet.trim()) out.push('Pick a bullet letter or number');
    return out;
  }

  save(): boolean {
    const d = this.draft;
    if (!d || this.problems().length || !d.cls) return false;
    const game = this.ctx.game;
    const data = { name: d.name.trim(), bullet: d.bullet.trim().slice(0, 2).toUpperCase(), color: d.color, cls: d.cls, stops: [...d.stops], cars: d.cars, headways: { ...d.headways } };
    let route: Route;
    let created = false;
    if (d.editing !== null && game.routes.get(d.editing)) {
      route = game.routes.get(d.editing)!;
      const before = { ...route, stops: [...route.stops], headways: { ...route.headways }, control: { ...route.control, timepoints: [...route.control.timepoints] } };
      game.routes.update(route.id, data);
      const res = purchaseFleet(game, route);
      if (!res.ok) {
        game.routes.update(route.id, before);
        this.ctx.toast("Can't afford the extra trains", `${fmtMoney(res.cost)} needed`, 'red');
        return false;
      }
      if (res.cost > 0) this.ctx.toast('Trains bought', `${fmtMoney(res.cost)} for ${route.name}`, 'amber');
    } else {
      route = game.routes.create(data);
      created = true;
      const res = purchaseFleet(game, route);
      if (!res.ok) {
        game.routes.remove(route.id);
        this.ctx.toast("Can't afford the trains", `${fmtMoney(res.cost)} needed — issue a bond or run fewer trains`, 'red');
        return false;
      }
      this.ctx.toast(`Route ${route.bullet} created`, res.cost ? `${fmtMoney(res.cost)} spent on trains` : undefined, 'green');
    }
    game.events.emit('routes', undefined);
    this.draft = null;
    this.path = null;
    if (created) this.ctx.game.select({ kind: 'route', id: route.id });
    else this.ctx.game.select({ kind: 'route', id: route.id });
    this.ctx.setTool('select');
    return true;
  }

  cancel(): void {
    this.draft = null;
    this.path = null;
    this.ctx.redraw();
    this.ctx.setTool('select');
  }

  move(p: Pointer): void {
    const sid = this.ctx.stations.pick(p.x, p.y, this.ctx.tol(14));
    this.hoverStation = sid;
    const net = this.ctx.game.network;
    if (sid === null) {
      this.ctx.tip(this.draft?.stops.length ? null : `<div class="hw-muted">Click stations in order to make a route</div>`, p.px);
    } else {
      const s = net.stations.get(sid)!;
      const cls = net.edges.get(s.edge)!.cls;
      const d = this.draft;
      let msg: string;
      if (d?.cls && d.cls !== cls) msg = `<div class="reason hw-red">${s.name} is on ${cls} metro track</div>`;
      else if (d?.stops.includes(sid)) msg = `<div class="hw-amber">Click to remove ${s.name}</div>`;
      else msg = `<div class="hw-green">Click to add ${s.name}${d?.stops.length ? ` · <span class="hw-muted">Shift-click adds at the start</span>` : ''}</div>`;
      this.ctx.tip(msg, p.px);
    }
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    const sid = this.ctx.stations.pick(p.x, p.y, this.ctx.tol(14));
    if (sid === null) return;
    if (!this.draft) this.newDraft();
    const d = this.draft!;
    const net = this.ctx.game.network;
    const s = net.stations.get(sid)!;
    const cls = net.edges.get(s.edge)!.cls;
    if (d.cls && d.cls !== cls) {
      this.ctx.toast("Can't mix track classes", `${s.name} is on ${cls} metro track`, 'red');
      return;
    }
    if (!d.cls) {
      d.cls = cls;
      d.cars = Math.min(s.cars, STATION.cars[cls].default);
    }
    const i = d.stops.indexOf(sid);
    if (i >= 0) d.stops.splice(i, 1);
    else if (p.shift) d.stops.unshift(sid);
    else d.stops.push(sid);
    if (d.stops.length === 0) d.cls = d.editing !== null ? d.cls : null;
    // Default name from the terminals.
    if (!d.name && d.stops.length >= 2) d.name = `${net.stations.get(d.stops[0])!.name.split(' & ')[0]} – ${net.stations.get(d.stops[d.stops.length - 1])!.name.split(' & ')[0]}`;
    this.recompute();
    this.move(p);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && this.draft) {
      if (!this.save()) this.ctx.toast("Route isn't ready", this.problems()[0], 'amber');
      return true;
    }
    if (e.key === 'Escape' && this.draft && this.draft.stops.length) {
      this.cancel();
      return true;
    }
    return false;
  }

  leave(): void {
    this.ctx.tip(null);
  }

  layers(): Layer[] {
    const d = this.draft;
    if (!d) return [];
    const net = this.ctx.game.network;
    const out: Layer[] = [];
    const rgb = hexRgb(d.color);
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    if (this.path?.ok) {
      const paths = this.path.legs.map((l) => {
        const g = net.geom(l.edge);
        const lo = Math.min(l.u0, l.u1), hi = Math.max(l.u0, l.u1);
        return slicePolyline(g.xs, g.ys, g.cum, lo, hi).map(([x, y]) => toLonLat(x, y));
      });
      out.push(
        new PathLayer({ id: 'route-draft-casing', data: paths, getPath: (p) => p, getColor: [255, 255, 255, 200], getWidth: 10, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH }),
        new PathLayer({ id: 'route-draft', data: paths, getPath: (p) => p, getColor: [rgb[0], rgb[1], rgb[2], 255], getWidth: 6, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH, updateTriggers: { getColor: d.color } }),
      );
    }
    const stops = d.stops
      .map((sid, i) => {
        const s = net.stations.get(sid);
        if (!s) return null;
        const p = net.stationPos(s);
        return { pos: toLonLat(p.x, p.y), n: String(i + 1) };
      })
      .filter(Boolean) as { pos: [number, number]; n: string }[];
    out.push(
      new ScatterplotLayer({ id: 'route-draft-stops', data: stops, getPosition: (s) => s.pos, getRadius: 10, radiusUnits: 'pixels', getFillColor: [rgb[0], rgb[1], rgb[2], 255], stroked: true, getLineColor: [255, 255, 255, 255], getLineWidth: 2, lineWidthUnits: 'pixels', parameters: DEPTH, updateTriggers: { getFillColor: d.color } }),
      new TextLayer({ id: 'route-draft-nums', data: stops, getPosition: (s) => s.pos, getText: (s) => s.n, getSize: 11, getColor: [255, 255, 255, 255], fontFamily: 'Overpass, sans-serif', fontWeight: 800, getTextAnchor: 'middle', getAlignmentBaseline: 'center', parameters: DEPTH }),
    );
    if (this.hoverStation !== null) {
      const s = net.stations.get(this.hoverStation);
      if (s) {
        const p = net.stationPos(s);
        out.push(new ScatterplotLayer({ id: 'route-hover', data: [toLonLat(p.x, p.y)], getPosition: (q) => q, getRadius: 13, radiusUnits: 'pixels', filled: false, stroked: true, getLineColor: [255, 194, 74, 255], getLineWidth: 2.5, lineWidthUnits: 'pixels', parameters: DEPTH }));
      }
    }
    return out;
  }

  plan() {
    const r = this.asRoute();
    if (!r || !this.path?.ok) return null;
    return fleetPlan(this.ctx.game, r);
  }
}
