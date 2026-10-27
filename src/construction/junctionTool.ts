/**
 * Junction tool (J): place a premade junction (construction/junctions.ts). Hover the main line
 * (branch, wye) or a track end (fork) to see it laid out with its price and any problem; click to
 * plan it as blueprint. J again cycles the kind, F flips the side, D the direction, [ ] the angle.
 */
import { PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { TRACK, type TrackClass } from '../balance';
import { toLonLat } from '../core/geo';
import { trackClassName } from '../core/trackNames';
import { fmtDistance, fmtMoney } from '../core/units';
import type { AppContext } from '../ui/context';
import { h } from '../ui/dom';
import type { Pointer, Tool } from '../ui/toolTypes';
import { JUNCTION_ANGLES, JUNCTION_KINDS, JUNCTION_STUB, junctionRadius, placeJunction, type JunctionAt, type JunctionKind, type JunctionSpec } from './junctions';
import type { Network } from './network';
import { pickEdge, pickNode } from './pick';
import { edgeReport, type EdgeReport } from './validate';

const GREEN: [number, number, number, number] = [72, 209, 120, 255];
const RED: [number, number, number, number] = [255, 93, 93, 255];
const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;

interface Preview {
  key: string;
  at: JunctionAt;
  cls: TrackClass;
  net: Network | null;
  edges: number[];
  reports: EdgeReport[];
  reason?: string;
}

export class JunctionTool implements Tool {
  readonly id = 'junction' as const;
  readonly xray = true;
  spec: JunctionSpec = { kind: 'branch', angle: 45, side: 1, facing: 1 };
  private preview: Preview | null = null;
  private pointer: Pointer | null = null;

  constructor(private ctx: AppContext) {}

  deactivate(): void {
    this.preview = null;
    this.ctx.tip(null);
    this.ctx.redraw();
  }

  private target(p: Pointer): { at: JunctionAt; cls: TrackClass } | null {
    const net = this.ctx.game.network;
    if (this.spec.kind === 'fork') {
      const n = pickNode(net, p.x, p.y, this.ctx.tol(14), (id) => net.degree(id) === 1 && net.nodes.get(id)!.leadOf === null);
      if (n === null) return null;
      const e = net.edges.get(net.incident(n)[0])!;
      return { at: { kind: 'end', node: n }, cls: e.cls };
    }
    const hit = pickEdge(net, p.x, p.y, this.ctx.tol(TRACK.snapPx + 4));
    if (!hit) return null;
    return { at: { kind: 'edge', edge: hit.edge, u: hit.u }, cls: net.edges.get(hit.edge)!.cls };
  }

  move(p: Pointer): void {
    this.pointer = p;
    const game = this.ctx.game;
    const t = this.target(p);
    const kind = JUNCTION_KINDS.find((k) => k.id === this.spec.kind)!;
    if (!t) {
      this.preview = null;
      this.ctx.tip(`<div class="title">${kind.name}</div><div class="hw-muted">${this.spec.kind === 'fork' ? 'Hover a track end to split it in two' : 'Hover track to place the junction on it'}</div>`, p.px);
      this.ctx.redraw();
      return;
    }
    const at = t.at;
    const key = `${game.network.version}|${JSON.stringify(at.kind === 'edge' ? { ...at, u: Math.round(at.u / 5) * 5 } : at)}|${JSON.stringify(this.spec)}`;
    if (this.preview?.key !== key) {
      const clone = game.network.clone();
      const plan = placeJunction(clone, at.kind === 'edge' ? { ...at, u: Math.round(at.u / 5) * 5 } : at, t.cls, this.spec);
      this.preview = plan.ok
        ? { key, at, cls: t.cls, net: clone, edges: plan.edges, reports: plan.edges.map((id) => edgeReport(clone, id, game.terrain)) }
        : { key, at, cls: t.cls, net: null, edges: [], reports: [], reason: plan.reason };
    }
    const pv = this.preview;
    const angle = this.spec.kind === 'fork' ? this.spec.angle / 2 : this.spec.angle;
    const head = `<div class="title">${kind.name} · ${this.spec.angle}° · ${trackClassName(t.cls)}</div>`;
    if (!pv.net) this.ctx.tip(`${head}<div class="reason hw-red">${pv.reason ?? "Can't place it here"}</div>`, p.px);
    else {
      const cost = pv.reports.reduce((s, r) => s + r.cost, 0);
      const err = pv.reports.find((r) => !r.ok)?.errors[0];
      this.ctx.tip(
        `${head}<div class="hw-muted">${kind.blurb}. Curves ${fmtDistance(junctionRadius(t.cls, angle), true)} radius, a ${fmtDistance(JUNCTION_STUB[t.cls], true)} stub to carry on from · ${fmtMoney(cost)}</div>` +
          (err ? `<div class="reason hw-red">${err}</div>` : `<div class="hw-green" style="margin-top:3px">Click to plan it · <span class="kbd">F</span> side · <span class="kbd">D</span> direction · <span class="kbd">[</span> <span class="kbd">]</span> angle · <span class="kbd">J</span> kind</div>`),
        p.px,
      );
    }
    this.ctx.redraw();
  }

  click(p: Pointer): void {
    this.move(p);
    const pv = this.preview;
    if (!pv) return;
    const kind = JUNCTION_KINDS.find((k) => k.id === this.spec.kind)!;
    if (!pv.net || pv.reports.some((r) => !r.ok)) {
      this.ctx.toast(`Can't place a ${kind.name.toLowerCase()} here`, pv.reason ?? pv.reports.find((r) => !r.ok)?.errors[0], 'red');
      return;
    }
    const game = this.ctx.game;
    const at = pv.at.kind === 'edge' ? { ...pv.at, u: Math.round(pv.at.u / 5) * 5 } : pv.at;
    const res = game.editBlueprint(() => placeJunction(game.network, at, pv.cls, this.spec));
    if (!res.ok) this.ctx.toast(`Can't place a ${kind.name.toLowerCase()} here`, res.reason, 'red');
    else this.ctx.toast(`${kind.name} planned`, `Carry on from its free end with the Track tool (T) · Build to start construction`, 'green');
    this.preview = null;
    this.move(p);
  }

  private set(patch: Partial<JunctionSpec>): void {
    this.spec = { ...this.spec, ...patch };
    // A wye is a right-angled triangle (its far curve turns 180° − the angle, too sharp below 90°).
    if (this.spec.kind === 'wye') this.spec.angle = 90;
    this.preview = null;
    this.ctx.refreshOptions();
    if (this.pointer) this.move(this.pointer);
  }

  /** J (while active) cycles the kind. */
  cycleKind(): void {
    const i = JUNCTION_KINDS.findIndex((k) => k.id === this.spec.kind);
    const kind = JUNCTION_KINDS[(i + 1) % JUNCTION_KINDS.length].id;
    this.set({ kind, angle: kind === 'wye' ? 90 : kind === 'fork' ? 30 : 45 });
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'f') this.set({ side: (-this.spec.side) as 1 | -1 });
    else if (k === 'd') this.set({ facing: (-this.spec.facing) as 1 | -1 });
    else if (k === '[' || k === ']') {
      const i = JUNCTION_ANGLES.indexOf(this.spec.angle);
      const j = Math.max(0, Math.min(JUNCTION_ANGLES.length - 1, (i < 0 ? 1 : i) + (k === ']' ? 1 : -1)));
      this.set({ angle: JUNCTION_ANGLES[j] });
    } else if (k === 'j') this.cycleKind();
    else return false;
    return true;
  }

  layers(): Layer[] {
    const pv = this.preview;
    if (!pv?.net) return [];
    const net = pv.net;
    const data = pv.edges.map((id, i) => {
      const g = net.geom(id);
      const path: [number, number][] = [];
      for (let k = 0; k < g.xs.length; k++) path.push(toLonLat(g.xs[k], g.ys[k]));
      return { path, ok: pv.reports[i]?.ok ?? false };
    });
    return [
      new PathLayer({ id: 'junction-casing', data, getPath: (d) => d.path, getColor: [22, 27, 33, 200], getWidth: 7, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH }),
      new PathLayer({ id: 'junction', data, getPath: (d) => d.path, getColor: (d) => (d.ok ? GREEN : RED), getWidth: 3.5, widthUnits: 'pixels', capRounded: true, jointRounded: true, parameters: DEPTH }),
    ];
  }

  options(): HTMLElement {
    const s = this.spec;
    const seg = <T,>(items: { v: T; label: string; title?: string }[], cur: T, pick: (v: T) => void) =>
      h('div', { class: 'seg' }, ...items.map((it) => h('button', { class: it.v === cur ? 'on' : '', title: it.title ?? '', onclick: () => pick(it.v) }, it.label)));
    const angles = JUNCTION_ANGLES.filter((a) => s.kind !== 'wye' || a === 90);
    return h(
      'div',
      null,
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Junction'), seg(JUNCTION_KINDS.map((k) => ({ v: k.id as JunctionKind, label: k.name, title: k.blurb })), s.kind, (kind) => this.set({ kind, angle: kind === 'wye' ? 90 : kind === 'fork' ? 30 : s.angle }))),
      h('div', { class: 'opt-row', style: 'margin-top:6px' }, h('span', { class: 'opt-label' }, 'Angle'), seg(angles.map((a) => ({ v: a, label: `${a}°` })), s.angle, (angle) => this.set({ angle }))),
      s.kind !== 'fork'
        ? h(
            'div',
            { class: 'opt-row', style: 'margin-top:6px' },
            h('span', { class: 'opt-label' }, 'Flip'),
            h('div', { class: 'seg' }, h('button', { onclick: () => this.set({ side: (-s.side) as 1 | -1 }), title: 'F' }, 'Side (F)'), h('button', { onclick: () => this.set({ facing: (-s.facing) as 1 | -1 }), title: 'D' }, 'Direction (D)')),
          )
        : null,
      h(
        'div',
        { class: 'opt-hint', style: 'margin-top:8px' },
        `${JUNCTION_KINDS.find((k) => k.id === s.kind)!.blurb}. Laid at the track's level with curves of at least ${fmtDistance(junctionRadius('heavy', 90), true)} (metro), ${fmtDistance(junctionRadius('highspeed', 90), true)} on high-speed line, ending in a stub to extend. `,
        h('span', { class: 'kbd' }, 'J'),
        ' kind · ',
        h('span', { class: 'kbd' }, '['),
        h('span', { class: 'kbd' }, ']'),
        ' angle',
      ),
    );
  }
}
