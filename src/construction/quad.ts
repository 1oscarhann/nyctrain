/**
 * Four-track ("quad") sections (v2, docs/v2/express-quad.md §4): two parallel double-track edges
 * QUAD.spacing apart. The drawn stroke is laid with the ordinary `addStroke`; the other pair is its
 * exact parallel (mitred vertices, concentric fillets) added with `Network.addChain`; every
 * connector (fan turnouts, scissors crossovers) is another ordinary `addStroke` between edge
 * snaps, so junctions, leads, merge locks and validation work unchanged.
 *
 * Edge ids change as connectors split track, so everything is located by path position (on the
 * ordered lists kept in step with `Network.splitMap`) or by position with tag filters
 * (`locateTagged`); tags are inherited through `splitEdge`. No randomness: repeated runs from the
 * same edits give identical networks.
 */
import { QUAD, type TrackClass } from '../balance';
import { fmtDistance } from '../core/units';
import { concentric, mitre, sampleAt, turnSign, type XY } from './geometry';
import type { Network } from './network';
import { pickEdge } from './pick';
import type { ChainVertex, QuadRole, QuadTag, Snap, StrokePoint } from './types';

export { concentric, mitre, turnSign } from './geometry';

export interface QuadOptions {
  /** Side of the drawn line the other (express) pair runs on: +1 right, −1 left. A continued quad dictates it. */
  side: 1 | -1;
  /** Scissors crossovers near free ends (default QUAD.autoCrossovers). */
  autoCrossovers?: boolean;
}

export interface QuadResult {
  ok: boolean;
  /** Why the stroke was refused (ok false); the network is then exactly as before the call. */
  fatal?: string;
  /** Quad group id (−1 when refused). */
  group: number;
  /** New local-role and express-role edges of this stroke, in travel order. */
  local: number[];
  express: number[];
  /** Turnouts and crossovers (role 'link'). */
  links: number[];
  /** Drawn edges that stay ordinary double track: between a fan's attachment and its turnout. */
  double: number[];
  /** Every edge this stroke created (all of the above). */
  edges: number[];
  /** Non-fatal problems (e.g. no room for a crossover near a free end). */
  problems: string[];
}

/** How one end of a four-track stroke attaches (§2.1). */
export type EndMode =
  | { kind: 'free' }
  | { kind: 'fan' }
  | { kind: 'continue'; partner: number; tag: QuadTag; side: 1 | -1 };

/** One piece of a path in travel order (a PathLeg is one): traverse `edge` a→b (dir 0) or b→a. */
export interface QuadLeg {
  edge: number;
  dir: 0 | 1;
}

/** A straight span found by `findStraight`: on legs[leg], junction at uJ, far end at uX (edge coordinates). */
export interface StraightSpan {
  leg: number;
  edge: number;
  uJ: number;
  uX: number;
}

export function otherRole(role: QuadRole): QuadRole {
  return role === 'local' ? 'express' : role === 'express' ? 'local' : 'link';
}

// ---------------------------------------------------------------------------------- lookups

/** Point and unit heading (edge a→b) at distance u along an edge. */
export function pointAt(net: Network, edge: number, u: number): { x: number; y: number; hx: number; hy: number } {
  const g = net.geom(edge);
  return sampleAt(g.xs, g.ys, g.cum, Math.max(0, Math.min(g.length, u)));
}

/**
 * Point on the other pair opposite (edge, u): the partner side is −away in the edge's own a→b
 * frame. Null for links, untagged track, or where no partner edge lies within QUAD.partnerTolerance.
 */
export function partnerPoint(net: Network, edge: number, u: number): { edge: number; u: number; x: number; y: number } | null {
  const t = net.edges.get(edge)?.quad;
  if (!t || t.role === 'link' || t.away === 0) return null;
  const p = pointAt(net, edge, u);
  const s = -t.away;
  const x = p.x + s * QUAD.spacing * p.hy;
  const y = p.y - s * QUAD.spacing * p.hx;
  const hit = pickEdge(net, x, y, QUAD.partnerTolerance, (id) => {
    const q = net.edges.get(id)!.quad;
    return !!q && q.g === t.g && q.role !== t.role && q.role !== 'link';
  });
  return hit ? { edge: hit.edge, u: hit.u, x: hit.x, y: hit.y } : null;
}

/** The edge of group g and role `role` through a point (within `tol` metres), or null. */
export function locateTagged(net: Network, g: number, role: QuadRole, pt: XY, tol = 1.0): { edge: number; u: number; x: number; y: number } | null {
  const hit = pickEdge(net, pt.x, pt.y, tol, (id) => {
    const q = net.edges.get(id)!.quad;
    return !!q && q.g === g && q.role === role;
  });
  return hit ? { edge: hit.edge, u: hit.u, x: hit.x, y: hit.y } : null;
}

/**
 * A free end of a quad pair whose partner pair also ends freely beside it (QUAD.spacing apart,
 * within QUAD.partnerTolerance): a four-track stroke from here continues the section. O(nodes);
 * only called on snap and finish.
 */
export function quadEndPartner(net: Network, nodeId: number): { partner: number; tag: QuadTag } | null {
  const n = net.nodes.get(nodeId);
  if (!n || net.degree(nodeId) !== 1) return null;
  const tag = net.edges.get(net.incident(nodeId)[0])!.quad;
  if (!tag || tag.role === 'link') return null;
  let best: { partner: number; tag: QuadTag } | null = null;
  let bestErr = Infinity;
  for (const m of net.nodes.values()) {
    if (m.id === nodeId || net.degree(m.id) !== 1) continue;
    const err = Math.abs(Math.hypot(m.x - n.x, m.y - n.y) - QUAD.spacing);
    if (err > QUAD.partnerTolerance || err >= bestErr) continue;
    const t = net.edges.get(net.incident(m.id)[0])!.quad;
    if (t && t.g === tag.g && t.role !== tag.role && t.role !== 'link') {
      best = { partner: m.id, tag: { ...tag } };
      bestErr = err;
    }
  }
  return best;
}

/**
 * Which side of the stroke's travel direction the partner end lies on (+1 right, −1 left). At the
 * start of a stroke the travel direction is away from the end's own track; at the end, into it.
 */
export function sideOfPartner(net: Network, nodeId: number, partner: number, at: 'start' | 'end'): 1 | -1 {
  const [hx, hy] = net.departHeading(net.incident(nodeId)[0], nodeId);
  const dx = at === 'start' ? -hx : hx, dy = at === 'start' ? -hy : hy;
  const n = net.nodes.get(nodeId)!, p = net.nodes.get(partner)!;
  return dy * (p.x - n.x) - dx * (p.y - n.y) >= 0 ? 1 : -1;
}

/** How a four-track stroke's end attaches, from its snap (§2.1): free, fan or continue. */
export function endModeOf(net: Network, snap: Snap, at: 'start' | 'end'): EndMode {
  if (snap.kind === 'none') return { kind: 'free' };
  if (snap.kind === 'node') {
    const p = quadEndPartner(net, snap.node);
    if (p) return { kind: 'continue', partner: p.partner, tag: p.tag, side: sideOfPartner(net, snap.node, p.partner, at) };
  }
  return { kind: 'fan' };
}

/**
 * The first straight, level, splittable span of length `len` along a path, searching from one end
 * (`from`) and at most QUAD.connectorSearch from it. Each span keeps QUAD.connectorMargin from its
 * straight piece's ends, and both its ends pass `canSplitAt` (so it is clear of nodes, curves,
 * ramps and platforms); within a piece it slides away from `from` in 10 m steps.
 */
export function findStraight(net: Network, legs: readonly QuadLeg[], from: 'start' | 'end', len: number, cls: TrackClass): StraightSpan | null {
  const m = QUAD.connectorMargin;
  let walked = 0;
  for (let k = 0; k < legs.length; k++) {
    if (walked > QUAD.connectorSearch) break;
    const i = from === 'start' ? k : legs.length - 1 - k;
    const leg = legs[i];
    const g = net.geom(leg.edge);
    const L = g.length;
    // Which end of the edge faces `from`: the low end (node a) when searching forward on an a→b leg.
    const nearLow = (from === 'start') === (leg.dir === 0);
    if (!net.isRamp(leg.edge)) {
      const pieces = g.pieces.filter((p) => !isFinite(p.r) && p.s1 - p.s0 >= len + 2 * m);
      if (!nearLow) pieces.reverse();
      for (const p of pieces) {
        for (let j = 0; ; j++) {
          const uJ = nearLow ? p.s0 + m + j * 10 : p.s1 - m - j * 10;
          const uX = nearLow ? uJ + len : uJ - len;
          if (nearLow ? uX > p.s1 - m + 1e-6 : uX < p.s0 + m - 1e-6) break;
          if (walked + (nearLow ? uJ : L - uJ) > QUAD.connectorSearch) break;
          if (net.canSplitAt(leg.edge, uJ, cls).ok && net.canSplitAt(leg.edge, uX, cls).ok) return { leg: i, edge: leg.edge, uJ, uX };
        }
      }
    }
    walked += L;
  }
  return null;
}

// ---------------------------------------------------------------------------------- paths

/** Nodes along a path: the start of leg 0, then the end of every leg. */
function pathNodes(net: Network, legs: readonly QuadLeg[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < legs.length; i++) {
    const e = net.edges.get(legs[i].edge)!;
    if (i === 0) out.push(legs[i].dir === 0 ? e.a : e.b);
    out.push(legs[i].dir === 0 ? e.b : e.a);
  }
  return out;
}

/** Path distance of edge coordinate u on legs[i]. */
function pathPos(net: Network, legs: readonly QuadLeg[], i: number, u: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) s += net.geom(legs[k].edge).length;
  const L = net.geom(legs[i].edge).length;
  return s + (legs[i].dir === 0 ? u : L - u);
}

/** Edge coordinate of a path distance. */
function pathLocate(net: Network, legs: readonly QuadLeg[], pos: number): { i: number; edge: number; u: number } {
  let s = 0;
  for (let i = 0; i < legs.length; i++) {
    const L = net.geom(legs[i].edge).length;
    if (pos <= s + L || i === legs.length - 1) {
      const d = Math.max(0, Math.min(L, pos - s));
      return { i, edge: legs[i].edge, u: legs[i].dir === 0 ? d : L - d };
    }
    s += L;
  }
  throw new Error('empty path');
}

/**
 * Keeps ordered paths in step with edge splits: after each `addStroke`, every edge it split
 * (Network.splitMap, in split order) is replaced in place by its two halves in travel order.
 */
class PathTracker {
  constructor(private net: Network, readonly paths: QuadLeg[][]) {}
  sync = (): void => {
    for (const [old, sp] of this.net.splitMap) {
      for (const list of this.paths) {
        const i = list.findIndex((l) => l.edge === old);
        if (i < 0) continue;
        const d = list[i].dir;
        list.splice(i, 1, ...(d === 0 ? [{ edge: sp.e1, dir: d }, { edge: sp.e2, dir: d }] : [{ edge: sp.e2, dir: d }, { edge: sp.e1, dir: d }]));
      }
    }
  };
}

/** Right-hand offset (sw metres, travel frame) of the point at edge coordinate u on a leg. */
function offsetOnLeg(net: Network, leg: QuadLeg, u: number, sw: number): XY {
  const p = pointAt(net, leg.edge, u);
  const tx = leg.dir === 0 ? p.hx : -p.hx, ty = leg.dir === 0 ? p.hy : -p.hy;
  return { x: p.x + sw * ty, y: p.y - sw * tx };
}

function setTag(net: Network, ids: Iterable<number>, tag: QuadTag): void {
  for (const id of ids) {
    const e = net.edges.get(id);
    if (e) e.quad = { ...tag };
  }
}

/** Move every edge of quad group `from` into group `to` (two quads joined by one stroke). */
export function relabel(net: Network, from: number, to: number): void {
  for (const e of net.edges.values()) if (e.quad && e.quad.g === from) e.quad = { ...e.quad, g: to };
}

function refused(fatal: string): QuadResult {
  return { ok: false, fatal, group: -1, local: [], express: [], links: [], double: [], edges: [], problems: [] };
}

// ---------------------------------------------------------------------------------- strokes

/**
 * Lay a four-track stroke (§4.2): the drawn line through `points` is one pair (the local pair,
 * unless it continues an express pair), the other runs alongside on `opt.side`. Ends are free
 * (scissors crossover near the end), fan (the drawn line attaches like any stroke; the other pair
 * splits off through a turnout within QUAD.connectorSearch) or continue (a quad's free end pair).
 * One call is one edit: refused strokes leave the network exactly as it was.
 */
export function addQuadStroke(net: Network, points: StrokePoint[], cls: TrackClass, startSnap: Snap, endSnap: Snap, opt: QuadOptions): QuadResult {
  if (points.length < 2) return refused('Too short for four tracks');
  const sm = endModeOf(net, startSnap, 'start');
  const em = endModeOf(net, endSnap, 'end');
  if (sm.kind === 'continue' && endSnap.kind === 'node' && endSnap.node === sm.partner) return refused("A pair can't join its own partner");
  if (em.kind === 'continue' && startSnap.kind === 'node' && startSnap.node === em.partner) return refused("A pair can't join its own partner");
  let side: 1 | -1 = opt.side;
  if (sm.kind === 'continue') side = sm.side;
  if (em.kind === 'continue') {
    if (sm.kind === 'continue' && em.side !== side) return refused('The two four-track ends are on opposite sides');
    if (sm.kind === 'continue' && em.tag.role !== sm.tag.role) return refused('The two four-track ends are on different pairs');
    side = em.side;
  }
  const roleDrawn: QuadRole = sm.kind === 'continue' ? sm.tag.role : em.kind === 'continue' ? em.tag.role : 'local';

  const snapshot = net.toData();
  const g = sm.kind === 'continue' ? sm.tag.g : em.kind === 'continue' ? em.tag.g : net.nextId++;
  const drawn = net.addStroke(points, cls, startSnap, endSnap);
  if (!drawn.length) {
    net.load(snapshot);
    return refused('Too short for four tracks');
  }
  const legs: QuadLeg[] = drawn.map((edge) => ({ edge, dir: 0 }));
  const r = buildTwin(net, legs, cls, { side, g, roleDrawn, start: sm, end: em, autoCrossovers: opt.autoCrossovers });
  if (!r.ok) {
    net.load(snapshot);
    return r;
  }
  if (sm.kind === 'continue' && em.kind === 'continue' && em.tag.g !== g) relabel(net, em.tag.g, g);
  return r;
}

export interface TwinSpec {
  side: 1 | -1;
  g: number;
  roleDrawn: QuadRole;
  start: EndMode;
  end: EndMode;
  autoCrossovers?: boolean;
}

/**
 * Build the other pair alongside a path (given in travel order), its turnouts, tags and free-end
 * crossovers (§4.2). Every refusal happens before anything is changed. The drawn path is tagged
 * `roleDrawn` between its turnouts (or ends); outside them it stays ordinary double track.
 */
export function buildTwin(net: Network, legsIn: readonly QuadLeg[], cls: TrackClass, spec: TwinSpec): QuadResult {
  const list: QuadLeg[] = legsIn.map((l) => ({ edge: l.edge, dir: l.dir }));
  const nodes = pathNodes(net, list);
  const K = list.length;
  const sw = spec.side * QUAD.spacing;
  const span = fmtDistance(QUAD.turnoutLength + 2 * QUAD.connectorMargin, true);
  const reach = fmtDistance(QUAD.connectorSearch, true);

  // 1. Where the other pair starts and ends along the path.
  const sCut = spec.start.kind === 'fan' ? findStraight(net, list, 'start', QUAD.turnoutLength, cls) : null;
  const eCut = spec.end.kind === 'fan' ? findStraight(net, list, 'end', QUAD.turnoutLength, cls) : null;
  if (spec.start.kind === 'fan' && !sCut) return refused(`Needs a straight, level ${span} stretch within ${reach} of the start to split into four tracks`);
  if (spec.end.kind === 'fan' && !eCut) return refused(`Needs a straight, level ${span} stretch within ${reach} of the end to split into four tracks`);
  const total = pathPos(net, list, K - 1, list[K - 1].dir === 0 ? net.geom(list[K - 1].edge).length : 0);
  const twinFrom = sCut ? pathPos(net, list, sCut.leg, sCut.uX) : 0;
  const twinTo = eCut ? pathPos(net, list, eCut.leg, eCut.uX) : total;
  if (twinTo - twinFrom < QUAD.minLength) return refused('Too short for four tracks');

  // 2. The other pair's vertices in travel order: mitred, concentric, linked as twins.
  const node = (id: number) => net.nodes.get(id)!;
  const v: ChainVertex[] = [];
  if (spec.start.kind === 'continue') {
    const P = node(spec.start.partner);
    v.push({ x: P.x, y: P.y, level: P.level, r: 0, existing: P.id });
  } else if (sCut) {
    const o = offsetOnLeg(net, list[sCut.leg], sCut.uX, sw);
    v.push({ ...o, level: net.levelAt(sCut.edge, sCut.uX), r: 0 });
  } else {
    const o = mitre(null, node(nodes[0]), node(nodes[1]), sw);
    if (!o) return refused('Too short for four tracks');
    v.push({ ...o, level: node(nodes[0]).level, r: 0, twin: nodes[0] });
  }
  const first = sCut ? sCut.leg + 1 : 1;
  const last = eCut ? eCut.leg : K - 1;
  let endLead = -1;
  for (let i = first; i <= last; i++) {
    const p = node(nodes[i - 1]), n = node(nodes[i]), q = node(nodes[i + 1]);
    let m = mitre(p, n, q, sw);
    if (!m) return refused('Too sharp a turn for four tracks');
    // The lead of a continued end is a lead of the partner end, on its axis (any drag error is
    // projected out, so the joint leaves the old track straight).
    let leadOf: number | undefined;
    let anchorEnd: number | null = null;
    if (spec.start.kind === 'continue' && n.leadOf === nodes[0]) {
      anchorEnd = spec.start.partner;
      leadOf = 0;
    } else if (spec.end.kind === 'continue' && n.leadOf === nodes[K]) {
      anchorEnd = spec.end.partner;
      endLead = v.length;
    }
    if (anchorEnd !== null) {
      const A = node(anchorEnd);
      const [hx, hy] = net.departHeading(net.incident(anchorEnd)[0], anchorEnd);
      const t = (m.x - A.x) * hx + (m.y - A.y) * hy;
      m = { x: A.x + hx * t, y: A.y + hy * t };
    }
    v.push({ ...m, level: n.level, r: concentric(n.r, turnSign(p, n, q), sw), twin: n.id, leadOf });
  }
  if (spec.end.kind === 'continue') {
    const P = node(spec.end.partner);
    v.push({ x: P.x, y: P.y, level: P.level, r: 0, existing: P.id });
  } else if (eCut) {
    const o = offsetOnLeg(net, list[eCut.leg], eCut.uX, sw);
    v.push({ ...o, level: net.levelAt(eCut.edge, eCut.uX), r: 0 });
  } else {
    const o = mitre(node(nodes[K - 1]), node(nodes[K]), null, sw);
    if (!o) return refused('Too short for four tracks');
    v.push({ ...o, level: node(nodes[K]).level, r: 0, twin: nodes[K] });
  }
  if (endLead >= 0) v[endLead].leadOf = v.length - 1;
  // Path position of the end turnout's junction, taken before any split moves the edge ids.
  const eJpos = eCut ? pathPos(net, list, eCut.leg, eCut.uJ) : 0;

  // ---- Nothing has changed so far; from here on the stroke always succeeds.
  const twin: QuadLeg[] = net.addChain(v, cls).map((edge) => ({ edge, dir: 0 as const }));
  const tracker = new PathTracker(net, [list, twin]);
  const roleTwin = otherRole(spec.roleDrawn);
  for (const l of list) {
    const away = (l.dir === 0 ? -spec.side : spec.side) as -1 | 1;
    setTag(net, [l.edge], { g: spec.g, role: spec.roleDrawn, away });
  }
  setTag(net, twin.map((l) => l.edge), { g: spec.g, role: roleTwin, away: spec.side });

  // 3. Turnouts: ordinary strokes from an edge snap on the drawn pair to the other pair's free end.
  const links: number[] = [];
  let jS = nodes[0];
  let jE = nodes[K];
  if (sCut) {
    const J = pointAt(net, sCut.edge, sCut.uJ);
    const X0 = node(net.edges.get(twin[0].edge)!.a);
    const lv = net.levelAt(sCut.edge, sCut.uJ);
    const c = net.addStroke([{ x: J.x, y: J.y, level: lv }, { x: X0.x, y: X0.y, level: X0.level }], cls, { kind: 'edge', edge: sCut.edge, u: sCut.uJ }, { kind: 'node', node: X0.id });
    tracker.sync();
    links.push(...c);
    jS = net.edges.get(c[0])!.a;
  }
  if (eCut) {
    const at = pathLocate(net, list, eJpos);
    const J = pointAt(net, at.edge, at.u);
    const Xe = node(net.edges.get(twin[twin.length - 1].edge)!.b);
    const lv = net.levelAt(at.edge, at.u);
    const c = net.addStroke([{ x: Xe.x, y: Xe.y, level: Xe.level }, { x: J.x, y: J.y, level: lv }], cls, { kind: 'node', node: Xe.id }, { kind: 'edge', edge: at.edge, u: at.u });
    tracker.sync();
    links.push(...c);
    jE = net.edges.get(c[c.length - 1])!.b;
  }
  setTag(net, links, { g: spec.g, role: 'link', away: 0 });

  // 4. The drawn path outside its turnouts stays ordinary double track.
  const section = (): { from: number; to: number } => {
    const ns = pathNodes(net, list);
    return { from: sCut ? ns.indexOf(jS) : 0, to: eCut ? ns.indexOf(jE) : list.length };
  };
  {
    const { from, to } = section();
    for (let i = 0; i < list.length; i++) if (i < from || i >= to) delete net.edges.get(list[i].edge)!.quad;
  }

  // 5. Scissors crossovers near free ends (non-fatal). Both spans are chosen before either is
  //    built; the second is re-located by position (tags survive the first one's splits).
  const problems: string[] = [];
  if (spec.autoCrossovers ?? QUAD.autoCrossovers) {
    const { from, to } = section();
    const quadPath = list.slice(from, to);
    const want: { end: 'start' | 'end'; a: XY; len: number; lo: number; hi: number }[] = [];
    for (const end of ['start', 'end'] as const) {
      if (spec[end].kind !== 'free') continue;
      const cut = findStraight(net, quadPath, end, QUAD.crossoverLength, cls);
      if (!cut) {
        problems.push(`No straight ${fmtDistance(QUAD.crossoverLength + 2 * QUAD.connectorMargin, true)} near the ${end} for a crossover — add one with X`);
        continue;
      }
      const pa = pathPos(net, quadPath, cut.leg, cut.uJ), pb = pathPos(net, quadPath, cut.leg, cut.uX);
      want.push({ end, a: pointAt(net, cut.edge, cut.uJ), len: cut.uX - cut.uJ, lo: Math.min(pa, pb), hi: Math.max(pa, pb) });
    }
    if (want.length === 2 && want[1].lo < want[0].hi + QUAD.connectorMargin) {
      problems.push(`No room for a second crossover — add one with X`);
      want.pop();
    }
    for (const w of want) {
      const at = locateTagged(net, spec.g, spec.roleDrawn, w.a);
      const res = at ? addScissors(net, spec.g, at.edge, at.u, at.u + w.len, cls, tracker.sync) : null;
      if (res?.ok) links.push(...res.links);
      else problems.push(`No straight ${fmtDistance(QUAD.crossoverLength + 2 * QUAD.connectorMargin, true)} near the ${w.end} for a crossover — add one with X`);
    }
  }

  const { from, to } = section();
  const drawnQuad = list.slice(from, to).map((l) => l.edge);
  const double = list.filter((_, i) => i < from || i >= to).map((l) => l.edge);
  const twinIds = twin.map((l) => l.edge);
  const local = spec.roleDrawn === 'local' ? drawnQuad : twinIds;
  const express = spec.roleDrawn === 'local' ? twinIds : drawnQuad;
  return { ok: true, group: spec.g, local, express, links, double, edges: [...double, ...drawnQuad, ...twinIds, ...links], problems };
}

// ---------------------------------------------------------------------------------- crossovers

/**
 * A scissors crossover (§4.3) between (edge, uA) … (edge, uB) and the partner pair opposite:
 * one crossing from this pair at uA to the other at uB, one from the other at uA to this pair at
 * uB. They cross with no node between them (a flying crossing, like every junction). Refused, with
 * nothing changed, unless all four junctions are on straight, level track clear of platforms.
 * `onStroke` runs after each connector stroke (path trackers).
 */
export function addScissors(net: Network, g: number, edge: number, uA: number, uB: number, cls: TrackClass, onStroke?: () => void): { ok: boolean; links: number[]; reason?: string } {
  const t = net.edges.get(edge)?.quad;
  if (!t || t.role === 'link' || t.g !== g) return { ok: false, links: [], reason: 'Crossovers go on a four-track section' };
  const xA = partnerPoint(net, edge, uA);
  const xB = partnerPoint(net, edge, uB);
  if (!xA || !xB) return { ok: false, links: [], reason: 'No parallel pair here' };
  const checks: [number, number][] = [[edge, uA], [edge, uB], [xA.edge, xA.u], [xB.edge, xB.u]];
  for (const [e, u] of checks) {
    if (!net.canSplitAt(e, u, cls).ok) return { ok: false, links: [], reason: 'Crossovers need straight, level track clear of platforms' };
  }
  const pA = pointAt(net, edge, uA), pB = pointAt(net, edge, uB);
  const lv = net.levelAt(edge, uA);
  const c1 = net.addStroke([{ x: pA.x, y: pA.y, level: lv }, { x: xB.x, y: xB.y, level: lv }], cls, { kind: 'edge', edge, u: uA }, { kind: 'edge', edge: xB.edge, u: xB.u });
  onStroke?.();
  const a2 = locateTagged(net, g, otherRole(t.role), xA);
  const b2 = locateTagged(net, g, t.role, pB);
  if (!a2 || !b2) throw new Error('addScissors: lost the track after a split');
  const c2 = net.addStroke([{ x: a2.x, y: a2.y, level: lv }, { x: b2.x, y: b2.y, level: lv }], cls, { kind: 'edge', edge: a2.edge, u: a2.u }, { kind: 'edge', edge: b2.edge, u: b2.u });
  onStroke?.();
  const links = [...c1, ...c2];
  setTag(net, links, { g, role: 'link', away: 0 });
  return { ok: true, links };
}

/** Does a scissors fit between (edge, uA) and (edge, uB)? (Read-only.) */
function scissorsFits(net: Network, edge: number, uA: number, uB: number, cls: TrackClass): boolean {
  if (!net.canSplitAt(edge, uA, cls).ok || !net.canSplitAt(edge, uB, cls).ok) return false;
  const xA = partnerPoint(net, edge, uA), xB = partnerPoint(net, edge, uB);
  return !!xA && !!xB && net.canSplitAt(xA.edge, xA.u, cls).ok && net.canSplitAt(xB.edge, xB.u, cls).ok;
}

/**
 * Crossover placement (the X tool): the QUAD.crossoverLength span centred nearest `u` on a quad
 * edge where a scissors fits, sliding up to 300 m either way (read-only; build it with addScissors).
 */
export function scissorsCandidate(net: Network, edge: number, u: number, cls: TrackClass): { ok: true; g: number; edge: number; uA: number; uB: number } | { ok: false; reason: string } {
  const t = net.edges.get(edge)?.quad;
  if (!t || t.role === 'link') return { ok: false, reason: 'Crossovers go on a four-track section' };
  const L = net.geom(edge).length;
  const half = QUAD.crossoverLength / 2;
  for (let k = 0; k <= 30; k++) {
    for (const sgn of k === 0 ? [1] : [1, -1]) {
      const c = u + sgn * k * 10;
      const uA = c - half, uB = c + half;
      if (uA < 0 || uB > L) continue;
      if (scissorsFits(net, edge, uA, uB, cls)) return { ok: true, g: t.g, edge, uA, uB };
    }
  }
  return { ok: false, reason: 'Crossovers need straight, level track clear of platforms' };
}
