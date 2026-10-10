/**
 * Bulldoze: blueprints are deleted for free; built or in-progress track and stations
 * are demolished for a 20% refund. Track or stations used by a route are protected.
 */
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { TRACK } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtMoney } from '../core/units';
import type { AppContext } from '../ui/context';
import type { Pointer, Tool } from '../ui/toolTypes';
import { pickEdge } from './pick';

type Target = { kind: 'station'; id: number } | { kind: 'edge'; id: number };

export class BulldozeTool implements Tool {
  readonly id = 'bulldoze' as const;
  readonly xray = true;
  private target: Target | null = null;
  private blocked: string | null = null;

  constructor(private ctx: AppContext) {}

  deactivate(): void {
    this.target = null;
    this.ctx.tip(null);
    this.ctx.redraw();
  }

  private find(p: Pointer): Target | null {
    const sid = this.ctx.stations.pick(p.x, p.y, this.ctx.tol(10));
    if (sid !== null) return { kind: 'station', id: sid };
    const hit = pickEdge(this.ctx.game.network, p.x, p.y, this.ctx.tol(TRACK.snapPx));
    return hit ? { kind: 'edge', id: hit.edge } : null;
  }

  move(p: Pointer): void {
    const game = this.ctx.game;
    const net = game.network;
    this.target = this.find(p);
    this.blocked = null;
    if (!this.target) {
      this.ctx.tip(`<div class="hw-muted">Hover over track or a station</div>`, p.px);
    } else if (this.target.kind === 'station') {
      const s = net.stations.get(this.target.id)!;
      const users = game.routesUsingStation(s.id);
      if (users.length) this.blocked = `Served by ${users.join(', ')}`;
      this.ctx.tip(
        `<div class="title">${s.name}</div>` +
          (this.blocked
            ? `<div class="reason hw-red">${this.blocked} — remove it from the route first</div>`
            : s.status === 'blueprint'
              ? `<div class="hw-green">Click to remove (free)</div>`
              : `<div class="hw-amber">Click to demolish · refund ${fmtMoney(s.cost * TRACK.bulldozeRefund)}</div>`),
        p.px,
      );
    } else {
      const e = net.edges.get(this.target.id)!;
      const users = game.routesUsingEdge(e.id);
      if (users.length) this.blocked = `Used by ${users.join(', ')}`;
      const stationsOn = [...net.stations.values()].filter((s) => s.edge === e.id);
      const refund = e.cost * TRACK.bulldozeRefund + stationsOn.reduce((t, s) => t + s.cost * TRACK.bulldozeRefund, 0);
      this.ctx.tip(
        (this.blocked
          ? `<div class="reason hw-red">${this.blocked} — edit the route off this track first</div>`
          : e.status === 'blueprint'
            ? `<div class="hw-green">Click to remove blueprint (free)</div>`
            : `<div class="hw-amber">Click to demolish · refund ${fmtMoney(refund)}</div>`) +
          (stationsOn.length ? `<div class="hw-muted">Also removes ${stationsOn.length} station${stationsOn.length > 1 ? 's' : ''}</div>` : ''),
        p.px,
      );
    }
    this.ctx.redraw();
  }

  async click(p: Pointer): Promise<void> {
    const t = this.find(p);
    if (!t) return;
    const game = this.ctx.game;
    const net = game.network;
    if (t.kind === 'station') {
      const s = net.stations.get(t.id)!;
      if (s.status !== 'blueprint') {
        const ok = await this.ctx.confirm(`Demolish ${s.name}?`, `You get back ${fmtMoney(s.cost * TRACK.bulldozeRefund)} (20% of what it cost).`, 'Demolish', true);
        if (!ok) return;
      }
      const r = game.bulldozeStation(t.id);
      if (!r.ok) this.ctx.toast("Can't demolish", r.reason, 'red');
    } else {
      const e = net.edges.get(t.id)!;
      if (e.status !== 'blueprint') {
        const ok = await this.ctx.confirm('Demolish this track?', `You get back 20% of what it cost. Stations on it are demolished too.`, 'Demolish', true);
        if (!ok) return;
      }
      const r = game.bulldozeEdge(t.id);
      if (!r.ok) this.ctx.toast("Can't demolish", r.reason, 'red');
      else if (r.refund) this.ctx.toast('Demolished', `Refund ${fmtMoney(r.refund)}`, 'amber');
    }
    this.target = null;
    this.ctx.redraw();
  }

  leave(): void {
    this.ctx.tip(null);
  }

  layers(): Layer[] {
    const t = this.target;
    if (!t) return [];
    const net = this.ctx.game.network;
    const col: [number, number, number, number] = this.blocked ? [255, 194, 74, 230] : [255, 93, 93, 230];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    if (t.kind === 'station') {
      const s = net.stations.get(t.id);
      if (!s) return [];
      const p = net.stationPos(s);
      return [
        new ScatterplotLayer({ id: 'bulldoze-station', data: [toLonLat(p.x, p.y)], getPosition: (d) => d, getRadius: 12, radiusUnits: 'pixels', filled: false, stroked: true, getLineColor: col, getLineWidth: 3, lineWidthUnits: 'pixels', parameters: DEPTH }),
      ];
    }
    if (!net.edges.has(t.id)) return [];
    const g = net.geom(t.id);
    const path: [number, number][] = [];
    for (let i = 0; i < g.xs.length; i++) path.push(toLonLat(g.xs[i], g.ys[i]));
    return [new PathLayer({ id: 'bulldoze-edge', data: [path], getPath: (d) => d, getColor: col, getWidth: 9, widthUnits: 'pixels', capRounded: true, parameters: DEPTH })];
  }
}
