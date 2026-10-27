/**
 * Track tool: click to place points, double-click or Enter to finish. Snaps to track ends and
 * branches off straight track. Segments preview live in green (valid) or red (with the reason).
 * Blueprint vertices can be dragged.
 *
 * Four tracks (v2, docs/v2/express-quad.md §2.1): Q switches between two and four tracks. In four,
 * the drawn line is the local pair and the express pair runs alongside on the side F picks; it
 * fans off through turnouts where the stroke attaches to other track, gets scissors crossovers
 * near free ends, and continues an existing four-track free end. X places scissors crossovers.
 */
import { trackClassName } from '../core/trackNames';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import { LEVELS, QUAD, TRACK, type TrackClass, type TrackLevel } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtDistance, fmtMoney, fmtPerDistance, fmtSpeed } from '../core/units';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import { crossoverTip, PREVIEW_PAIR_PX, QUAD_COLORS, quadHoverTip, quadStrokeTip, SIDE_LABEL, strokeRoles } from '../ui/express';
import type { Pointer, Tool } from '../ui/toolTypes';
import { cap, edgeTooltip } from './describe';
import type { Network } from './network';
import { pickEdge, pickNode, snapForTrack, type SnapResult } from './pick';
import { addQuadStroke, addScissors, gapTag, isGapEnd, rejoinPair, scissorsCandidate, type QuadResult } from './quad';
import type { QuadRole, Snap, StrokePoint } from './types';
import { edgeReport, LEVEL_NAMES, type EdgeReport } from './validate';

const GREEN: [number, number, number, number] = [76, 208, 138, 255];
const offsetExt = new PathStyleExtension({ offset: true });
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
  /** Four tracks: what each edge is (colours the preview); absent for two tracks. */
  roles?: Map<number, QuadRole | 'double'>;
  /** Four tracks refused: the drawn line is shown red. */
  refused?: boolean;
}

/** Crossover mode's hover: a candidate scissors, previewed on a clone. */
interface CrossoverHover {
  key: string;
  ok: boolean;
  reason?: string;
  g: number;
  edge: number;
  uA: number;
  uB: number;
  cls: TrackClass;
  net: Network | null;
  links: number[];
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
  /** Two tracks or four (Q). */
  tracks: 2 | 4 = 2;
  /** Four tracks: the side of the drawn line the express pair runs on (F): +1 right, −1 left. */
  side: 1 | -1 = 1;
  /** Four tracks: placing scissors crossovers (X) instead of drawing. */
  crossing = false;
  private xo: CrossoverHover | null = null;

  constructor(private ctx: AppContext) {}

  get drawing(): boolean {
    return this.pts.length > 0;
  }

  deactivate(): void {
    this.cancel();
    this.xo = null;
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

  /** Two or four tracks (Q). Works mid-stroke: the preview is rebuilt from the same points. */
  setTracks(n: 2 | 4): void {
    this.tracks = n;
    if (n === 2) this.crossing = false;
    this.xo = null;
    this.ctx.refreshOptions();
    if (this.lastPointer) this.move(this.lastPointer);
  }

  /** Flip the express pair's side (F). Works mid-stroke. */
  setSide(side: 1 | -1): void {
    this.side = side;
    this.ctx.refreshOptions();
    if (this.lastPointer) this.move(this.lastPointer);
  }

  /** Crossover placement on or off (X, four tracks only). */
  setCrossing(on: boolean): void {
    if (on && this.tracks !== 4) return;
    if (on && this.drawing) this.cancel();
    this.crossing = on;
    this.xo = null;
    this.ctx.refreshOptions();
    if (this.lastPointer) this.move(this.lastPointer);
    else this.ctx.redraw();
  }

  // ------------------------------------------------------------------ events
  move(p: Pointer): void {
    this.lastPointer = p;
    const net = this.ctx.game.network;
    const tol = this.ctx.tol(TRACK.snapPx);
    if (this.crossing) {
      this.hover = null;
      this.hoverNode = null;
      this.moveCrossover(p);
      return;
    }
    this.hover = snapForTrack(net, p.x, p.y, tol, this.cls);
    if (!this.drawing) {
      this.hoverNode = pickNode(net, p.x, p.y, tol, (id) => net.nodeEditable(id) && net.degree(id) > 0 && !(net.nodes.get(id)!.anchor && net.degree(id) > 1));
      if (this.hover.snap.kind !== 'none' && !this.hover.ok) {
        this.ctx.tip(`<div class="reason hw-red">${this.hover.reason}</div>`, p.px);
      } else if (this.tracks === 4) {
        const snap = this.hover.snap;
        this.ctx.tip((snap.kind === 'edge' ? edgeTooltip(this.ctx.game, snap.edge) + '<div style="margin-top:4px"></div>' : '') + quadHoverTip(net, snap, this.level, this.side), p.px);
      } else if (this.hover.snap.kind === 'edge') {
        this.ctx.tip(edgeTooltip(this.ctx.game, this.hover.snap.edge) + `<div class="hw-muted" style="margin-top:4px">Click to branch off here</div>`, p.px);
      } else if (this.hover.snap.kind === 'node') {
        const gap = isGapEnd(net, this.hover.snap.node) ? gapTag(net, this.hover.snap.node) : null;
        this.ctx.tip(`<div class="hw-green">Click to extend from here</div>${gap ? `<div class="hw-muted">Four tracks (<span class="kbd">Q</span>) from here to the gap's other end restore the ${gap.role} pair exactly</div>` : ''}`, p.px);
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
    if (this.tracks === 4) {
      this.buildQuadPreview(net, points, endSnap, p);
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
      `<div class="title">${cap(LEVEL_NAMES[this.level])} · ${trackClassName(this.cls)}</div>`,
      last ? `<div class="row"><span class="hw-muted">This segment</span><span class="num">${fmtDistance(last.length)} · ${fmtMoney(last.cost)}</span></div>` : '',
      last && isFinite(last.minRadius) ? `<div class="row"><span class="hw-muted">Tightest curve</span><span class="num">${fmtDistance(last.minRadius, true)} · ${fmtSpeed(last.speedLimit)}</span></div>` : '',
      `<div class="row"><span class="hw-muted">Line so far</span><span class="num">${fmtDistance(len)} · ${fmtMoney(total)}</span></div>`,
      firstErr ? `<div class="reason hw-red">${firstErr}</div>` : `<div class="hw-muted" style="margin-top:3px">Double-click or <span class="kbd">Enter</span> to finish</div>`,
    ];
    if (this.hover && this.hover.snap.kind !== 'none' && !this.hover.ok) lines.push(`<div class="reason hw-red">${this.hover.reason}</div>`);
    this.ctx.tip(lines.join(''), p.px);
  }

  /** Four tracks: the whole stroke on a clone (pairs, turnouts, crossovers), coloured by part. */
  private buildQuadPreview(net: Network, points: StrokePoint[], endSnap: Snap, p: Pointer): void {
    let res: QuadResult;
    try {
      res = addQuadStroke(net, points, this.cls, this.startSnap, endSnap, { side: this.side });
    } catch (e) {
      res = { ok: false, fatal: String((e as Error)?.message ?? e), group: -1, local: [], express: [], links: [], double: [], edges: [], problems: [] };
    }
    const terrain = this.ctx.game.terrain;
    const byId = new Map<number, EdgeReport>();
    let edges: number[];
    let roles: Map<number, QuadRole | 'double'> | undefined;
    if (res.ok) {
      edges = res.edges;
      roles = strokeRoles(res);
    } else {
      // Refused (the clone is as it was): show the drawn line in red.
      try {
        edges = net.addStroke(points, this.cls, this.startSnap, endSnap);
      } catch {
        edges = [];
      }
    }
    for (const id of edges) byId.set(id, edgeReport(net, id, terrain));
    this.preview = { net, edges, reports: edges.map((id) => byId.get(id)!), roles, refused: !res.ok };
    let html = quadStrokeTip(net, res, byId, this.level, this.cls);
    if (this.hover && this.hover.snap.kind !== 'none' && !this.hover.ok) html += `<div class="reason hw-red">${this.hover.reason}</div>`;
    this.ctx.tip(html, p.px);
  }

  /** Crossover mode: the nearest valid scissors on the hovered four-track edge, previewed on a clone. */
  private moveCrossover(p: Pointer): void {
    const game = this.ctx.game;
    const net = game.network;
    const hit = pickEdge(net, p.x, p.y, this.ctx.tol(TRACK.snapPx + 4), (id) => {
      const t = net.edges.get(id)!.quad;
      return !!t && t.role !== 'link';
    });
    if (!hit) {
      this.xo = null;
      this.ctx.tip(crossoverTip(null), p.px);
      this.ctx.redraw();
      return;
    }
    const cls = net.edges.get(hit.edge)!.cls;
    const c = scissorsCandidate(net, hit.edge, hit.u, cls);
    if (!c.ok) {
      this.xo = { key: '', ok: false, reason: c.reason, g: -1, edge: hit.edge, uA: hit.u, uB: hit.u, cls, net: null, links: [], reports: [] };
      this.ctx.tip(crossoverTip({ ok: false, reason: c.reason }), p.px);
      this.ctx.redraw();
      return;
    }
    const key = `${net.version}:${c.edge}:${c.uA.toFixed(1)}`;
    if (this.xo?.key !== key) {
      const clone = net.clone();
      const r = addScissors(clone, c.g, c.edge, c.uA, c.uB, cls);
      this.xo = { key, ok: r.ok, reason: r.reason, g: c.g, edge: c.edge, uA: c.uA, uB: c.uB, cls, net: clone, links: r.links, reports: r.links.map((id) => edgeReport(clone, id, game.terrain)) };
    }
    const xo = this.xo;
    if (!xo.ok) this.ctx.tip(crossoverTip({ ok: false, reason: xo.reason ?? 'No room for a crossover here' }), p.px);
    else {
      const cost = xo.reports.reduce((t, r) => t + r.cost, 0);
      this.ctx.tip(crossoverTip({ ok: true, cost, length: QUAD.crossoverLength[xo.cls], error: xo.reports.find((r) => !r.ok)?.errors[0] }), p.px);
    }
    this.ctx.redraw();
  }

  private clickCrossover(p: Pointer): void {
    this.moveCrossover(p);
    const xo = this.xo;
    if (!xo) return;
    if (!xo.ok || xo.reports.some((r) => !r.ok)) {
      this.ctx.toast("Can't place a crossover here", xo.reason ?? xo.reports.find((r) => !r.ok)?.errors[0], 'red');
      return;
    }
    const game = this.ctx.game;
    const res = game.editBlueprint(() => addScissors(game.network, xo.g, xo.edge, xo.uA, xo.uB, xo.cls));
    if (!res.ok) this.ctx.toast("Can't place a crossover here", res.reason, 'red');
    else this.ctx.toast('Crossover planned', `Scissors · ${fmtDistance(QUAD.crossoverLength[xo.cls], true)} · Build to start construction`, 'green');
    this.xo = null;
    this.move(p);
  }

  private levelOfSnap(s: Snap): TrackLevel {
    const net = this.ctx.game.network;
    if (s.kind === 'node') return net.nodes.get(s.node)!.level;
    if (s.kind === 'edge') return net.levelAt(s.edge, s.u);
    return this.level;
  }

  click(p: Pointer): void {
    if (this.crossing) {
      this.clickCrossover(p);
      return;
    }
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
      // A refused four-track stroke keeps drawing, without the end it couldn't attach to.
      if (!this.finish(snap.snap)) {
        this.pts.pop();
        this.move(p);
      }
      return;
    }
    this.pts.push({ x: p.x, y: p.y, level: this.level });
    this.move(p);
  }

  dblclick(): void {
    if (this.drawing) this.finish({ kind: 'none' });
  }

  /** Lay the stroke (one undo step). False when a four-track stroke is refused: it stays drawn. */
  private finish(endSnap: Snap): boolean {
    const pts = this.pts;
    if (pts.length < 2) {
      this.cancel();
      return true;
    }
    const game = this.ctx.game;
    const start = this.startSnap;
    if (this.tracks === 4) {
      // Decide on a clone first: a refused stroke must not leave an empty undo step.
      const side = this.side;
      const test = addQuadStroke(game.network.clone(), pts, this.cls, start, endSnap, { side });
      if (!test.ok) {
        this.ctx.toast("Can't build four tracks here", test.fatal, 'red');
        return false;
      }
      const res = game.editBlueprint(() => addQuadStroke(game.network, pts, this.cls, start, endSnap, { side }));
      this.cancel();
      const sum = game.blueprintSummary();
      if (sum.invalid.length) this.ctx.toast('Some segments need fixing', sum.invalid[0].reason, 'amber');
      else if (res.problems.length) this.ctx.toast('Four tracks planned', res.problems[0], 'amber');
      return true;
    }
    // Two tracks between two ends of one pair of a four-track section (a bulldozed gap) rejoin it.
    const net = game.network;
    const ga = start.kind === 'node' ? gapTag(net, start.node) : null;
    const gb = endSnap.kind === 'node' ? gapTag(net, endSnap.node) : null;
    const rejoin = ga && gb && ga.g === gb.g && ga.role === gb.role ? ga : null;
    game.editBlueprint(() => {
      const ids = net.addStroke(pts, this.cls, start, endSnap);
      if (rejoin) rejoinPair(net, rejoin, ids);
      return ids;
    });
    this.cancel();
    const sum = game.blueprintSummary();
    if (sum.invalid.length) this.ctx.toast('Some segments need fixing', sum.invalid[0].reason, 'amber');
    return true;
  }

  down(p: Pointer): boolean {
    if (this.drawing || this.crossing) return false;
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
    if (!game.network.moveNode(pr.id, p.x, p.y)) {
      const why = game.network.quadDragBlock(pr.id);
      this.ctx.tip(
        why === 'pinned'
          ? `<div class="reason hw-red">This vertex sits between two four-track junctions: both pairs leave each one straight, so it can't move. Redraw the section to change it</div>`
          : `<div class="reason hw-red">The other pair is already built: this vertex can't move</div>`,
        p.px,
      );
      return;
    }
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
    const k = e.key.toLowerCase();
    if (k === 'q' && !e.repeat) {
      this.setTracks(this.tracks === 4 ? 2 : 4);
      return true;
    }
    if (k === 'f' && this.tracks === 4 && !e.repeat) {
      this.setSide(this.side === 1 ? -1 : 1);
      return true;
    }
    if (k === 'x' && this.tracks === 4 && !e.repeat) {
      this.setCrossing(!this.crossing);
      return true;
    }
    if (e.key === 'Escape' && this.crossing) {
      this.setCrossing(false);
      return true;
    }
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
  private pathOf(net: Network, id: number): [number, number][] {
    const g = net.geom(id);
    const path: [number, number][] = [];
    for (let k = 0; k < g.xs.length; k++) path.push(toLonLat(g.xs[k], g.ys[k]));
    return path;
  }

  layers(): (Layer | null)[] {
    const out: (Layer | null)[] = [];
    const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
    if (this.crossing && this.xo?.net && this.xo.ok) {
      const xo = this.xo;
      const net = xo.net!;
      const data = xo.links.map((id, i) => ({ path: this.pathOf(net, id), ok: xo.reports[i].ok }));
      out.push(
        new PathLayer({ id: 'track-xo-casing', data, getPath: (d) => d.path, getColor: [22, 27, 33, 200], getWidth: 6, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH }),
        new PathLayer({ id: 'track-xo', data, getPath: (d) => d.path, getColor: (d) => (d.ok ? QUAD_COLORS.link : RED), getWidth: 3, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH }),
      );
    }
    if (this.preview && this.drawing) {
      const { net, edges, reports, roles, refused } = this.preview;
      const data = edges.map((id, i) => {
        const role = roles?.get(id);
        const ok = reports[i].ok && !refused;
        const color = !ok ? RED : role ? QUAD_COLORS[role] : GREEN;
        // A pair is pushed away from the other one (paths run a→b, deck.gl's offset is to the right).
        const t = role === 'local' || role === 'express' ? net.edges.get(id)?.quad : undefined;
        const off = t ? t.away * PREVIEW_PAIR_PX : 0;
        return { path: this.pathOf(net, id), ok, color, link: role === 'link', off, width: role === 'link' ? 2.5 : 4 };
      });
      type D = (typeof data)[number];
      out.push(
        new PathLayer<D, PathStyleExtensionProps<D>>({
          id: 'track-preview-casing',
          data,
          getPath: (d) => d.path,
          getColor: [22, 27, 33, 200],
          getWidth: 7,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          getOffset: (d) => d.off / 7,
          extensions: [offsetExt],
          parameters: DEPTH,
        }),
        new PathLayer<D, PathStyleExtensionProps<D>>({
          id: 'track-preview',
          data,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          getOffset: (d) => d.off / d.width,
          extensions: [offsetExt],
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
    const clsBtn = (c: TrackClass) => h('button', { class: this.cls === c ? 'on' : '', onclick: () => this.setClass(c), title: classHint(c) }, trackClassName(c));
    const tracksBtn = (n: 2 | 4) => h('button', { class: this.tracks === n ? 'on' : '', onclick: () => this.setTracks(n), title: 'Q — two or four tracks' }, `${n} tracks`);
    const sideBtn = (sd: 1 | -1) => h('button', { class: this.side === sd ? 'on' : '', onclick: () => this.setSide(sd), title: 'F — flip which side the express pair runs on' }, sd < 0 ? '◀ Left' : 'Right ▶');
    const quad = this.tracks === 4;
    return h(
      'div',
      null,
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Class'), h('div', { class: 'seg' }, clsBtn('heavy'), clsBtn('light'), clsBtn('highspeed'))),
      h('div', { class: 'opt-row', style: 'margin-top:8px' }, h('span', { class: 'opt-label' }, 'Tracks'), h('div', { class: 'seg', title: 'Q — two or four tracks' }, tracksBtn(2), tracksBtn(4))),
      quad ? h('div', { class: 'opt-row', style: 'margin-top:8px' }, h('span', { class: 'opt-label' }, 'Express'), h('div', { class: 'seg' }, sideBtn(-1), sideBtn(1))) : null,
      h('div', { class: 'opt-row', style: 'margin-top:8px' }, h('span', { class: 'opt-label' }, 'Level'), h('div', { class: 'seg' }, ...LEVELS.map(levelBtn))),
      quad
        ? h(
            'div',
            { class: 'opt-row', style: 'margin-top:8px' },
            h('span', { class: 'opt-label' }, ''),
            h('div', { class: 'seg' }, h('button', { class: this.crossing ? 'on' : '', onclick: () => this.setCrossing(!this.crossing), title: 'X — place a scissors crossover between the pairs' }, '⨯ Crossover')),
          )
        : null,
      quad
        ? h(
            'div',
            { class: 'opt-hint', style: 'margin-top:8px' },
            this.crossing
              ? `Hover a four-track section and click to place a ${fmtDistance(QUAD.crossoverLength[this.cls], true)} scissors crossover: trains can switch pairs both ways. `
              : `Four tracks: the line you draw is the local pair; the express pair runs alongside on the ${SIDE_LABEL[this.side]} and splits off where you connect to other track. Inner curves need ${fmtDistance(QUAD.spacing, true)} more radius. `,
            h('span', { class: 'kbd' }, 'Q'),
            ' two tracks · ',
            h('span', { class: 'kbd' }, 'F'),
            ' flip · ',
            h('span', { class: 'kbd' }, 'X'),
            ' crossover',
          )
        : h(
            'div',
            { class: 'opt-hint', style: 'margin-top:8px' },
            `Click to place points · double-click or Enter to finish · Backspace removes the last point · drag white points to edit · `,
            h('span', { class: 'kbd' }, 'Ctrl+Z'),
            ' undo · ',
            h('span', { class: 'kbd' }, 'Q'),
            ' four tracks',
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

function classHint(c: TrackClass): string {
  const v = fmtSpeed(TRACK.lineSpeed[c]);
  if (c === 'highspeed') return `Up to ${v} for high-speed trains; curves of ${fmtDistance(TRACK.minRadius.highspeed, true)} or wider; ${TRACK.highSpeedCostMultiplier}× the cost. Joins ordinary heavy track.`;
  if (c === 'light') return `Up to ${v}; tighter curves and steeper grades; ${TRACK.lightCostMultiplier}× the cost. Light trains only.`;
  return `Up to ${v} (metro trains top out at 90 km/h); metro, commuter, intercity and high-speed trains.`;
}
