/**
 * Track tool: click to place points, double-click or Enter to finish. Snaps to track ends and
 * branches off straight track. Segments preview live in green (valid) or red (with the reason).
 * Blueprint vertices can be dragged.
 */
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { LEVELS, TRACK, type TrackClass, type TrackLevel } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtDistance, fmtMoney, fmtPerDistance, fmtSpeed } from '../core/units';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import type { Pointer, Tool } from '../ui/toolTypes';
import { cap, edgeTooltip } from './describe';
import type { Network } from './network';
import { pickEdge, pickNode, snapForTrack, type SnapResult } from './pick';
import type { Snap, StrokePoint } from './types';
import { edgeReport, LEVEL_NAMES, type EdgeReport } from './validate';

const GREEN: [number, number, number, number] = [76, 208, 138, 255];
const RED: [number, number, number, number] = [255, 93, 93, 255];
const AMBER: [number, number, number, number] = [255, 194, 74, 255];

export const LEVEL_SWATCH: Record<TrackLevel, string> = {
  elevated: 'background:#C9D1D9',
  'at-grade': 'background:#8E99A5',
  'cut-and-cover': 'background:repeating-linear-gradient(90deg,#8E99A5 0 6px,transparent 6px 9px)',
  deep: 'background:repeating-linear-gradient(90deg,rgba(142,153,165,.7) 0 2px,transparent 2px 5px)',
};

interface Preview {
  net: Network;
  edges: number[];
  reports: EdgeReport[];
}

export class TrackTool implements Tool {
  readonly id = 'track' as const;
  readonly xray = true;
  cls: TrackClass = 'heavy';
  level: TrackLevel = 'deep';
  private pts: StrokePoint[] = [];
  private startSnap: Snap = { kind: 'none' };
  private hover: SnapResult | null = null;
  private preview: Preview | null = null;
  private dragNode: number | null = null;
  /** Press on a blueprint vertex: it only becomes a drag once the pointer moves. */
  private press: { id: number; px: [number, number]; dragging: boolean } | null = null;
  private hoverNode: number | null = null;
  private lastPointer: Pointer | null = null;

  constructor(private ctx: AppContext) {}

  get drawing(): boolean {
    return this.pts.length > 0;
  }

  deactivate(): void {
    this.cancel();
    this.ctx.tip(null);
  }

  private cancel(): void {
    this.pts = [];
    this.startSnap = { kind: 'none' };
    this.preview = null;
    this.ctx.redraw();
  }

  setLevel(l: TrackLevel): void {
    this.level = l;
    if (this.lastPointer) this.move(this.lastPointer);
    this.ctx.refreshOptions();
  }

  setClass(c: TrackClass): void {
    if (this.drawing) this.cancel();
    this.cls = c;
    this.ctx.refreshOptions();
  }

  // ------------------------------------------------------------------ events
  move(p: Pointer): void {
    this.lastPointer = p;
    const net = this.ctx.game.network;
    const tol = this.ctx.tol(TRACK.snapPx);
    this.hover = snapForTrack(net, p.x, p.y, tol, this.cls);
    if (!this.drawing) {
      this.hoverNode = pickNode(net, p.x, p.y, tol, (id) => net.nodeEditable(id) && net.degree(id) > 0 && !(net.nodes.get(id)!.anchor && net.degree(id) > 1));
      if (this.hover.snap.kind !== 'none' && !this.hover.ok) {
        this.ctx.tip(`<div class="reason hw-red">${this.hover.reason}</div>`, p.px);
      } else if (this.hover.snap.kind === 'edge') {
        this.ctx.tip(edgeTooltip(this.ctx.game, this.hover.snap.edge) + `<div class="hw-muted" style="margin-top:4px">Click to branch off here</div>`, p.px);
      } else if (this.hover.snap.kind === 'node') {
        this.ctx.tip(`<div class="hw-green">Click to extend from here</div>`, p.px);
      } else {
        this.ctx.tip(`<div class="hw-muted">Click to start ${LEVEL_NAMES[this.level]} track</div>`, p.px);
      }
      this.ctx.redraw();
      return;
    }
    this.buildPreview(p);
    this.ctx.redraw();
  }

  private buildPreview(p: Pointer): void {
    const net = this.ctx.game.network.clone();
    const endSnap = this.hover && this.hover.snap.kind !== 'none' && this.hover.ok ? this.hover.snap : ({ kind: 'none' } as Snap);
    const pt: StrokePoint = { x: this.hover?.x ?? p.x, y: this.hover?.y ?? p.y, level: endSnap.kind === 'none' ? this.level : this.levelOfSnap(endSnap) };
    // Hovering on the last placed point: preview what's committed so far.
    const prevPt = this.pts[this.pts.length - 1];
    const points = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) < 3 ? [...this.pts] : [...this.pts, pt];
    if (points.length < 2) {
      this.preview = null;
      this.ctx.tip(`<div class="hw-muted">Click the next point</div>`, p.px);
      return;
    }
    let edges: number[] = [];
    try {
      edges = net.addStroke(points, this.cls, this.startSnap, endSnap);
    } catch {
      edges = [];
    }
    const reports = edges.map((id) => edgeReport(net, id, this.ctx.game.terrain));
    this.preview = { net, edges, reports };
    const total = reports.reduce((s, r) => s + r.cost, 0);
    const len = reports.reduce((s, r) => s + r.length, 0);
    const last = reports[reports.length - 1];
    const firstErr = reports.find((r) => !r.ok)?.errors[0];
    const lines = [
      `<div class="title">${cap(LEVEL_NAMES[this.level])} · ${cap(this.cls)} metro</div>`,
      last ? `<div class="row"><span class="hw-muted">This segment</span><span class="num">${fmtDistance(last.length)} · ${fmtMoney(last.cost)}</span></div>` : '',
      last && isFinite(last.minRadius) ? `<div class="row"><span class="hw-muted">Tightest curve</span><span class="num">${fmtDistance(last.minRadius, true)} · ${fmtSpeed(last.speedLimit)}</span></div>` : '',
      `<div class="row"><span class="hw-muted">Line so far</span><span class="num">${fmtDistance(len)} · ${fmtMoney(total)}</span></div>`,
      firstErr ? `<div class="reason hw-red">${firstErr}</div>` : `<div class="hw-muted" style="margin-top:3px">Double-click or <span class="kbd">Enter</span> to finish</div>`,
    ];
    if (this.hover && this.hover.snap.kind !== 'none' && !this.hover.ok) lines.push(`<div class="reason hw-red">${this.hover.reason}</div>`);
    this.ctx.tip(lines.join(''), p.px);
  }

  private levelOfSnap(s: Snap): TrackLevel {
    const net = this.ctx.game.network;
    if (s.kind === 'node') return net.nodes.get(s.node)!.level;
    if (s.kind === 'edge') return net.levelAt(s.edge, s.u);
    return this.level;
  }

  click(p: Pointer): void {
    const snap = this.hover ?? snapForTrack(this.ctx.game.network, p.x, p.y, this.ctx.tol(TRACK.snapPx), this.cls);
    if (!this.drawing) {
      if (snap.snap.kind !== 'none' && !snap.ok) {
        this.ctx.toast("Can't start here", snap.reason, 'red');
        return;
      }
      this.startSnap = snap.snap;
      this.pts = [{ x: snap.x, y: snap.y, level: snap.snap.kind === 'none' ? this.level : this.levelOfSnap(snap.snap) }];
      this.ctx.redraw();
      return;
    }
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(snap.x - last.x, snap.y - last.y) < 3) return; // double-click duplicate
    if (snap.snap.kind !== 'none') {
      if (!snap.ok) {
        this.ctx.toast("Can't connect here", snap.reason, 'red');
        return;
      }
      this.pts.push({ x: snap.x, y: snap.y, level: this.levelOfSnap(snap.snap) });
      this.finish(snap.snap);
      return;
    }
    this.pts.push({ x: p.x, y: p.y, level: this.level });
    this.move(p);
  }

  dblclick(): void {
    if (this.drawing) this.finish({ kind: 'none' });
  }

  private finish(endSnap: Snap): void {
    const pts = this.pts;
    if (pts.length < 2) {
      this.cancel();
      return;
    }
    const game = this.ctx.game;
    const start = this.startSnap;
    game.editBlueprint(() => game.network.addStroke(pts, this.cls, start, endSnap));
    this.cancel();
    const sum = game.blueprintSummary();
    if (sum.invalid.length) this.ctx.toast('Some segments need fixing', sum.invalid[0].reason, 'amber');
  }

  down(p: Pointer): boolean {
    if (this.drawing) return false;
    const net = this.ctx.game.network;
    const id = pickNode(net, p.x, p.y, this.ctx.tol(TRACK.snapPx), (nid) => net.nodeEditable(nid) && !(net.nodes.get(nid)!.anchor && net.degree(nid) > 1));
    if (id === null) return false;
    // Capture the press (so the map doesn't pan), but don't record history until it's a real drag.
    this.press = { id, px: p.px, dragging: false };
    return true;
  }

  drag(p: Pointer): void {
    const pr = this.press;
    if (!pr) return;
    if (!pr.dragging) {
      if (Math.hypot(p.px[0] - pr.px[0], p.px[1] - pr.px[1]) < 4) return;
      pr.dragging = true;
      this.dragNode = pr.id;
      this.ctx.game.history.record(this.ctx.game.network);
    }
    const game = this.ctx.game;
    game.network.moveNode(pr.id, p.x, p.y);
    game.afterNetworkChange();
    const eid = game.network.incident(pr.id)[0];
    if (eid !== undefined) this.ctx.tip(edgeTooltip(game, eid), p.px);
  }

  up(p?: Pointer): void {
    const pr = this.press;
    this.press = null;
    this.dragNode = null;
    // A press that never moved is a click (e.g. extending from a blueprint track end); the tool
    // manager suppresses the native click after a captured press, so deliver it here.
    if (pr && !pr.dragging && p) this.click(p);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.drawing) {
      this.cancel();
      return true;
    }
    if (e.key === 'Enter' && this.drawing) {
      this.finish({ kind: 'none' });
      return true;
    }
    if (e.key === 'Backspace' && this.drawing) {
      this.pts.pop();
      if (!this.pts.length) this.cancel();
      else if (this.lastPointer) this.move(this.lastPointer);
      return true;
    }
    return false;
  }

  leave(): void {
    this.ctx.tip(null);
  }

  // ------------------------------------------------------------------ rendering
  layers(): (Layer | null)[] {
    const out: (Layer | null)[] = [];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    if (this.preview && this.drawing) {
      const { net, edges, reports } = this.preview;
      const data = edges.map((id, i) => {
        const g = net.geom(id);
        const path: [number, number][] = [];
        for (let k = 0; k < g.xs.length; k++) path.push(toLonLat(g.xs[k], g.ys[k]));
        return { path, ok: reports[i].ok };
      });
      out.push(
        new PathLayer({
          id: 'track-preview-casing',
          data,
          getPath: (d) => d.path,
          getColor: [22, 27, 33, 200],
          getWidth: 7,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          parameters: DEPTH,
        }),
        new PathLayer({
          id: 'track-preview',
          data,
          getPath: (d) => d.path,
          getColor: (d) => (d.ok ? GREEN : RED),
          getWidth: 4,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          parameters: DEPTH,
        }),
      );
      const ctrl = [...this.pts.map((p) => toLonLat(p.x, p.y))];
      const leads = [...net.nodes.values()].filter((n) => n.leadOf !== null && edges.some((e) => net.incident(n.id).includes(e))).map((n) => toLonLat(n.x, n.y));
      out.push(
        new ScatterplotLayer({
          id: 'track-preview-points',
          data: [...ctrl.map((p) => ({ p, lead: false })), ...leads.map((p) => ({ p, lead: true }))],
          getPosition: (d) => d.p,
          getRadius: (d) => (d.lead ? 3 : 4.5),
          radiusUnits: 'pixels',
          getFillColor: (d) => (d.lead ? [142, 153, 165, 255] : [255, 255, 255, 255]),
          stroked: true,
          getLineColor: [22, 27, 33, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          parameters: DEPTH,
        }),
      );
    }
    // Snap indicator
    if (this.hover && this.hover.snap.kind !== 'none') {
      out.push(
        new ScatterplotLayer({
          id: 'track-snap',
          data: [{ p: toLonLat(this.hover.x, this.hover.y), ok: this.hover.ok }],
          getPosition: (d) => d.p,
          getRadius: 8,
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: (d) => (d.ok ? GREEN : RED),
          getLineWidth: 2.5,
          lineWidthUnits: 'pixels',
          parameters: DEPTH,
        }),
      );
    }
    // Draggable vertices of blueprint track
    if (!this.drawing) {
      const net = this.ctx.game.network;
      const verts = [...net.nodes.values()].filter((n) => net.nodeEditable(n.id) && net.degree(n.id) > 0 && !(n.anchor && net.degree(n.id) > 1));
      out.push(
        new ScatterplotLayer({
          id: 'track-vertices',
          data: verts.map((n) => ({ p: toLonLat(n.x, n.y), hot: n.id === this.hoverNode || n.id === this.dragNode, lead: n.leadOf !== null })),
          getPosition: (d) => d.p,
          getRadius: (d) => (d.hot ? 6 : d.lead ? 3 : 4),
          radiusUnits: 'pixels',
          getFillColor: (d) => (d.hot ? AMBER : d.lead ? [142, 153, 165, 255] : [255, 255, 255, 220]),
          stroked: true,
          getLineColor: [22, 27, 33, 255],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          parameters: DEPTH,
          updateTriggers: { getRadius: [this.hoverNode, this.dragNode], getFillColor: [this.hoverNode, this.dragNode] },
        }),
      );
    }
    return out;
  }

  options(): HTMLElement {
    const levelBtn = (l: TrackLevel) =>
      h(
        'button',
        { class: this.level === l ? 'on' : '', onclick: () => this.setLevel(l), title: levelHint(l) },
        h('span', { class: 'level-swatch', style: LEVEL_SWATCH[l] }),
        cap(LEVEL_NAMES[l]),
      );
    const clsBtn = (c: TrackClass) => h('button', { class: this.cls === c ? 'on' : '', onclick: () => this.setClass(c) }, c === 'heavy' ? 'Heavy metro' : 'Light metro');
    return h(
      'div',
      null,
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Class'), h('div', { class: 'seg' }, clsBtn('heavy'), clsBtn('light'))),
      h('div', { class: 'opt-row', style: 'margin-top:8px' }, h('span', { class: 'opt-label' }, 'Level'), h('div', { class: 'seg' }, ...LEVELS.map(levelBtn))),
      h(
        'div',
        { class: 'opt-hint', style: 'margin-top:8px' },
        `Click to place points · double-click or Enter to finish · Backspace removes the last point · drag white points to edit · `,
        h('span', { class: 'kbd' }, 'Ctrl+Z'),
        ' undo',
      ),
    );
  }

  /** Edge under the cursor (for tooltips when not drawing). */
  hoverEdge(p: Pointer): number | null {
    return pickEdge(this.ctx.game.network, p.x, p.y, this.ctx.tol(TRACK.snapPx))?.edge ?? null;
  }
}

function levelHint(l: TrackLevel): string {
  const h = TRACK.height[l];
  const cost = fmtPerDistance(TRACK.costPerM[l]);
  const rule =
    l === 'elevated'
      ? `can bridge water (×${TRACK.bridgeMultiplier})`
      : l === 'deep'
        ? `goes anywhere (×${TRACK.underwaterTunnelMultiplier} under water), ignores density`
        : `can't cross water`;
  return `${h > 0 ? '+' : ''}${h} m · ${cost} · ${rule}`;
}
