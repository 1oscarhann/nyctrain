/**
 * Route tool: click stations in order (click again to remove, Shift-click to add at the start).
 * The path between them is found along connected track and previewed live. The side panel
 * edits the draft's name, bullet, colour, train length and frequencies.
 *
 * Express service (v2, docs/v2/express-quad.md §2.3): E toggles the draft between local and
 * express; a click on a cross-platform station picks the express platform for an express (the
 * local one for a local; Alt-click the other); a station the draft already runs past is inserted
 * in path order; stations the draft skips get hollow amber rings.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { gaugeOf, STATION, TRAINS, type StockId, type TrackClass } from '../balance';
import { city } from '../cities';
import { toLonLat } from '../core/geo';
import { slicePolyline } from '../map/polyline';
import { hexRgb } from '../map/networkLayers';
import type { AppContext } from '../ui/context';
import type { Pointer, Tool } from '../ui/toolTypes';
import { findRoutePath } from './pathfind';
import { choosePlatform, insertStop, partnerOf, pathErrorHint, quadRole, stationsAlongPath, switchPlatform, type AlongStation } from './express';
import { carsFitting, defaultHeadways, validStock } from './routeSet';
import type { BulletShape, PeriodId, Route, RoutePath } from './types';
import { purchaseFleet, fleetPlan } from './fleet';
import { fmtMoney } from '../core/units';

export interface RouteDraft {
  editing: number | null;
  name: string;
  bullet: string;
  color: string;
  shape?: BulletShape;
  cls: TrackClass | null;
  /** Train type; follows the track family once the first stop is picked. */
  stock: StockId;
  stops: number[];
  cars: number;
  headways: Record<PeriodId, number>;
  /** Express service (v2): picks express platforms of cross-platform pairs, lozenge bullet. */
  express: boolean;
}

export class RouteTool implements Tool {
  readonly id = 'route' as const;
  readonly xray = false;
  draft: RouteDraft | null = null;
  path: RoutePath | null = null;
  /** Every station along the draft's path, served or skipped (v2; empty without a path). */
  along: AlongStation[] = [];
  private hoverStation: number | null = null;
  private lastPointer: Pointer | null = null;
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
      stock: city().defaultHeavyStock ?? 'heavy',
      stops: [],
      cars: STATION.cars.heavy.default,
      headways: defaultHeadways(),
      express: false,
    };
    this.path = null;
    this.along = [];
  }

  editRoute(r: Route): void {
    this.draft = {
      editing: r.id,
      name: r.name,
      bullet: r.bullet,
      color: r.color,
      shape: r.shape,
      cls: r.cls,
      stock: r.stock,
      stops: [...r.stops],
      cars: r.cars,
      headways: { ...r.headways },
      express: !!r.express,
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
    this.along = d && this.path?.ok ? stationsAlongPath(this.ctx.game.network, d.stops, this.path) : [];
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
      shape: d.shape,
      cls: d.cls,
      stock: validStock(d.stock, d.cls),
      stops: d.stops,
      cars: d.cars,
      headways: d.headways,
      ownedCars: existing?.ownedCars ?? 0,
      // New routes get the defaults (fleet sizing includes their recovery time).
      control: existing?.control ?? this.ctx.game.routes.newControl(),
      express: d.express,
    };
  }

  /** Problems that block saving. */
  problems(): string[] {
    const d = this.draft;
    const out: string[] = [];
    if (!d) return out;
    if (d.stops.length < 2) out.push('Click at least two stations');
    if (this.path && !this.path.ok) out.push(pathErrorHint(this.ctx.game.network, d.stops, this.path.error ?? 'No path'));
    const net = this.ctx.game.network;
    for (const sid of d.stops) {
      const s = net.stations.get(sid);
      const fit = s && d.cls ? carsFitting(net, s, validStock(d.stock, d.cls)) : Infinity;
      if (s && fit < d.cars) {
        out.push(`${s.name}'s platform takes ${fit}-car ${TRAINS[validStock(d.stock, d.cls ?? "heavy")].name} trains — shorten the trains or lengthen it`);
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
    const data = { name: d.name.trim(), bullet: d.bullet.trim().slice(0, 2).toUpperCase(), color: d.color, shape: d.shape, cls: d.cls, stock: validStock(d.stock, d.cls), stops: [...d.stops], cars: d.cars, headways: { ...d.headways }, express: d.express };
    let route: Route;
    let created = false;
    if (d.editing !== null && game.routes.get(d.editing)) {
      route = game.routes.get(d.editing)!;
      const before = { ...route, stops: [...route.stops], headways: { ...route.headways }, control: { ...route.control, timepoints: [...route.control.timepoints] } };
      // A new train type: the old trains go to the spare pool (sellable there) and the route buys its new fleet.
      const swapped = route.stock !== data.stock ? { stock: route.stock, cars: route.ownedCars } : null;
      if (swapped) {
        game.routes.spareCars[swapped.stock] += swapped.cars;
        route.ownedCars = 0;
      }
      game.routes.update(route.id, data);
      const res = purchaseFleet(game, route);
      if (!res.ok) {
        if (swapped) game.routes.spareCars[swapped.stock] -= swapped.cars;
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
      this.ctx.toast(`Route ${route.bullet} is open`, `${res.cost ? `${fmtMoney(res.cost)} spent on trains. ` : ''}Riders start today and build up over the next few days as people change their habits.`, 'green');
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
    this.along = [];
    this.ctx.redraw();
    this.ctx.setTool('select');
  }

  /** Local or express draft (E, or the editor's segmented control). */
  setExpress(on: boolean): void {
    if (!this.draft) this.newDraft();
    this.draft!.express = on;
    this.onChange();
    if (this.lastPointer) this.move(this.lastPointer);
    else this.ctx.redraw();
  }

  /** The draft's stop at this station complex (either platform of a pair), or −1. */
  private stopIndexOf(sid: number): number {
    const d = this.draft;
    if (!d) return -1;
    const p = partnerOf(this.ctx.game.network, sid);
    return d.stops.findIndex((x) => x === sid || (p !== null && x === p));
  }

  /** The draft's path runs past this station (or its partner) without stopping. */
  private runsPast(sid: number): AlongStation | null {
    const p = partnerOf(this.ctx.game.network, sid);
    return this.along.find((a) => !a.served && (a.station === sid || a.partner === sid || (p !== null && a.station === p))) ?? null;
  }

  move(p: Pointer): void {
    this.lastPointer = p;
    const raw = this.ctx.stations.pick(p.x, p.y, this.ctx.tol(14));
    const net = this.ctx.game.network;
    const d = this.draft;
    const sid = raw === null ? null : choosePlatform(net, raw, !!d?.express, p.alt);
    this.hoverStation = sid;
    if (sid === null) {
      this.ctx.tip(d?.stops.length ? null : `<div class="hw-muted">Click stations in order to make a route${d?.express ? ' · express' : ''} · <span class="kbd">E</span> local or express</div>`, p.px);
    } else {
      const s = net.stations.get(sid)!;
      const cls = gaugeOf(net.edges.get(s.edge)!.cls);
      const partner = partnerOf(net, sid);
      const role = quadRole(net, sid);
      const plat = partner !== null && (role === 'local' || role === 'express') ? ` (${role} platform)` : '';
      // What an Alt-click would pick, worded from the platform a plain click picks (so it reads the
      // same while Alt is held); not repeated while Alt is down.
      const altRole = raw === null ? null : quadRole(net, choosePlatform(net, raw, !!d?.express, true));
      const altHint = partner !== null && !p.alt && altRole ? ` · <span class="hw-muted">Alt-click: ${altRole} platform</span>` : '';
      let msg: string;
      const at = this.stopIndexOf(sid);
      // A served pair: Alt-click moves the stop to the pair's other platform (each time).
      const other = at >= 0 && d ? partnerOf(net, d.stops[at]) : null;
      const otherRole = other !== null ? quadRole(net, other) : null;
      if (d?.cls && d.cls !== cls) msg = `<div class="reason hw-red">${s.name} is on ${cls} track</div>`;
      else if (at >= 0 && p.alt && other !== null) msg = `<div class="hw-green">Click to use the ${otherRole ?? 'other'} platform at ${s.name}</div>`;
      else if (at >= 0) msg = `<div class="hw-amber">Click to remove ${s.name}</div>${other !== null ? `<div class="hw-muted">Alt-click: use the ${otherRole ?? 'other'} platform</div>` : ''}`;
      else if (!p.shift && this.runsPast(sid)) msg = `<div class="hw-green">Click to stop at ${s.name}${plat} (inserted in order)</div>${altHint ? `<div>${altHint.slice(3)}</div>` : ''}`;
      else msg = `<div class="hw-green">Click to add ${s.name}${plat}${altHint}${d?.stops.length ? ` · <span class="hw-muted">Shift-click adds at the start</span>` : ''}</div>`;
      this.ctx.tip(msg, p.px);
    }
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    const raw = this.ctx.stations.pick(p.x, p.y, this.ctx.tol(14));
    if (raw === null) return;
    if (!this.draft) this.newDraft();
    const d = this.draft!;
    const net = this.ctx.game.network;
    // A cross-platform station: the express platform for an express, the local one for a local (Alt: the other).
    const sid = choosePlatform(net, raw, d.express, p.alt);
    const s = net.stations.get(sid)!;
    const cls = gaugeOf(net.edges.get(s.edge)!.cls);
    if (d.cls && d.cls !== cls) {
      this.ctx.toast("Can't mix light and heavy track", `${s.name} is on ${cls} track`, 'red');
      return;
    }
    if (!d.cls) {
      d.cls = cls;
      d.stock = validStock(d.stock, cls);
      d.cars = Math.max(TRAINS[d.stock].minCars, Math.min(carsFitting(net, s, d.stock), TRAINS[d.stock].maxCars, STATION.cars[cls].default));
    }
    const i = this.stopIndexOf(sid);
    const past = i < 0 && !p.shift && this.path?.ok ? this.runsPast(sid) : null;
    const switched = i >= 0 && p.alt ? switchPlatform(net, d.stops, sid) : null;
    if (switched) d.stops = switched; // Alt-click on a served pair: the other platform (and back)
    else if (i >= 0) d.stops.splice(i, 1);
    else if (past && this.path) {
      // The path already runs past it: stop there in path order.
      const res = insertStop(net, d.cls, d.stops, this.path, sid);
      if ('error' in res) {
        this.ctx.toast(`Can't stop at ${s.name}`, res.error, 'red');
        return;
      }
      d.stops = res.stops;
    } else if (p.shift) d.stops.unshift(sid);
    else d.stops.push(sid);
    if (d.stops.length === 0) d.cls = d.editing !== null ? d.cls : null;
    // A new route's trains shrink to the shortest platform on it (a new stop with a shorter
    // platform no longer blocks saving; lengthen trains again in the panel).
    if (d.editing === null && d.cls) {
      const stock = validStock(d.stock, d.cls);
      const fit = Math.min(...d.stops.map((id) => { const st = net.stations.get(id); return st ? carsFitting(net, st, stock) : Infinity; }));
      if (isFinite(fit)) d.cars = Math.max(TRAINS[stock].minCars, Math.min(d.cars, fit));
    }
    // Default name from the terminals.
    if (!d.name && d.stops.length >= 2) d.name = `${net.stations.get(d.stops[0])!.name.split(' & ')[0]} – ${net.stations.get(d.stops[d.stops.length - 1])!.name.split(' & ')[0]}`;
    this.recompute();
    this.move(p);
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'e' || e.key === 'E') && !e.repeat) {
      this.setExpress(!this.draft?.express);
      return true;
    }
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
    // Stations the draft runs past without stopping: hollow amber rings.
    const skipped = this.along.filter((a) => !a.served).map((a) => {
      const st = net.stations.get(a.station);
      const q = st ? net.stationPos(st) : null;
      return q ? toLonLat(q.x, q.y) : null;
    }).filter((q): q is [number, number] => !!q);
    if (skipped.length)
      out.push(new ScatterplotLayer({ id: 'route-draft-skips', data: skipped, getPosition: (q) => q, getRadius: 8, radiusUnits: 'pixels', filled: false, stroked: true, getLineColor: [255, 194, 74, 230], getLineWidth: 2, lineWidthUnits: 'pixels', parameters: DEPTH }));
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
