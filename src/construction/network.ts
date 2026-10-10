/**
 * The track network: nodes, edges and stations, plus the editing operations used by the tools.
 * Pure data + geometry — no rendering, no DOM — so it runs in tests and in the headless sim.
 */
import { STATION, TRACK, type TrackClass, type TrackLevel } from '../balance';
import {
  computeEdgeGeom,
  deflection,
  otherEnd,
  radiusForTangent,
  sampleAt,
  type EdgeGeom,
  type GraphView,
} from './geometry';
import type { NetworkData, Snap, Station, Status, StrokePoint, TrackEdge, TrackNode } from './types';

export class Network implements GraphView {
  nodes = new Map<number, TrackNode>();
  edges = new Map<number, TrackEdge>();
  stations = new Map<number, Station>();
  private inc = new Map<number, number[]>();
  private geomCache = new Map<number, EdgeGeom>();
  nextId = 1;
  /** Bumped on every change; renderers and route paths key off it. */
  version = 0;

  // ------------------------------------------------------------------ graph view
  node(id: number): TrackNode | undefined {
    return this.nodes.get(id);
  }
  edge(id: number): TrackEdge | undefined {
    return this.edges.get(id);
  }
  incident(nodeId: number): readonly number[] {
    return this.inc.get(nodeId) ?? EMPTY;
  }
  degree(nodeId: number): number {
    return this.incident(nodeId).length;
  }

  geom(edgeId: number): EdgeGeom {
    let g = this.geomCache.get(edgeId);
    if (!g) {
      const e = this.edges.get(edgeId);
      if (!e) throw new Error('no edge ' + edgeId);
      g = computeEdgeGeom(this, e);
      this.geomCache.set(edgeId, g);
    }
    return g;
  }

  touch(): void {
    this.version++;
    this.geomCache.clear();
  }

  // ------------------------------------------------------------------ serialisation
  toData(): NetworkData {
    return {
      nodes: [...this.nodes.values()].map((n) => ({ ...n })),
      edges: [...this.edges.values()].map((e) => ({ ...e })),
      stations: [...this.stations.values()].map((s) => ({ ...s })),
      nextId: this.nextId,
    };
  }

  static fromData(d: NetworkData): Network {
    const n = new Network();
    n.load(d);
    return n;
  }

  load(d: NetworkData): void {
    this.nodes.clear();
    this.edges.clear();
    this.stations.clear();
    this.inc.clear();
    for (const nd of d.nodes) this.nodes.set(nd.id, { ...nd });
    for (const e of d.edges) this.addEdgeRaw({ ...e });
    for (const s of d.stations) this.stations.set(s.id, { ...s });
    this.nextId = d.nextId;
    this.touch();
  }

  clone(): Network {
    const n = Network.fromData(this.toData());
    n.version = this.version;
    return n;
  }

  // ------------------------------------------------------------------ low-level edits
  private newNode(x: number, y: number, level: TrackLevel, cls: TrackClass): TrackNode {
    const n: TrackNode = { id: this.nextId++, x, y, level, cls, r: 0, anchor: false, hx: 1, hy: 0, leadOf: null };
    this.nodes.set(n.id, n);
    return n;
  }

  private addEdgeRaw(e: TrackEdge): void {
    this.edges.set(e.id, e);
    for (const nid of [e.a, e.b]) {
      let l = this.inc.get(nid);
      if (!l) this.inc.set(nid, (l = []));
      l.push(e.id);
    }
  }

  private newEdge(a: number, b: number, cls: TrackClass, status: Status = 'blueprint'): TrackEdge {
    const e: TrackEdge = { id: this.nextId++, a, b, cls, status, buildStart: 0, buildEnd: 0, cost: 0 };
    this.addEdgeRaw(e);
    return e;
  }

  private removeEdgeRaw(id: number): void {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    for (const nid of [e.a, e.b]) {
      const l = this.inc.get(nid);
      if (l) {
        const i = l.indexOf(id);
        if (i >= 0) l.splice(i, 1);
        if (l.length === 0) this.inc.delete(nid);
      }
    }
  }

  // ------------------------------------------------------------------ queries
  /** Edge level at distance u: the level of the nearer end node (ramps change level half way). */
  levelAt(edgeId: number, u: number): TrackLevel {
    const e = this.edges.get(edgeId)!;
    const g = this.geom(edgeId);
    return u < g.length / 2 ? this.nodes.get(e.a)!.level : this.nodes.get(e.b)!.level;
  }

  /** Track height (metres relative to ground) at distance u along an edge. */
  heightAt(edgeId: number, u: number): number {
    const e = this.edges.get(edgeId)!;
    const g = this.geom(edgeId);
    const ha = TRACK.height[this.nodes.get(e.a)!.level];
    const hb = TRACK.height[this.nodes.get(e.b)!.level];
    const f = g.length > 0 ? Math.max(0, Math.min(1, u / g.length)) : 0;
    return ha + (hb - ha) * f;
  }

  isRamp(edgeId: number): boolean {
    const e = this.edges.get(edgeId)!;
    return this.nodes.get(e.a)!.level !== this.nodes.get(e.b)!.level;
  }

  /** Can every incident edge of this node be edited freely (all blueprint)? */
  nodeEditable(id: number): boolean {
    return this.incident(id).every((eid) => this.edges.get(eid)!.status === 'blueprint');
  }

  /**
   * Can a new stroke attach at this node? Free track ends, straight vertices and junctions
   * with spare capacity can be extended from; curved vertices cannot.
   */
  canAttachAtNode(id: number, cls: TrackClass): { ok: boolean; reason?: string } {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: 'No track here' };
    if (n.cls !== cls) return { ok: false, reason: `Heavy and light metro track can't connect` };
    const deg = this.degree(id);
    if (deg >= TRACK.maxJunctionDegree) return { ok: false, reason: 'This junction is full' };
    if (deg <= 1 || n.anchor) return { ok: true };
    if (deg === 2) {
      const [p, q] = this.incident(id).map((eid) => this.nodes.get(otherEnd(this.edges.get(eid)!, id))!);
      const d1x = n.x - p.x, d1y = n.y - p.y, d2x = q.x - n.x, d2y = q.y - n.y;
      const th = deflection(d1x / Math.hypot(d1x, d1y), d1y / Math.hypot(d1x, d1y), d2x / Math.hypot(d2x, d2y), d2y / Math.hypot(d2x, d2y));
      if (th < TRACK.straightEpsilon * 2) return { ok: true };
    }
    return { ok: false, reason: 'Branch from a straight section, not a curve' };
  }

  /** Can track branch off this edge at distance u (must be straight, level track, not in a platform)? */
  canSplitAt(edgeId: number, u: number, cls: TrackClass): { ok: boolean; reason?: string } {
    const e = this.edges.get(edgeId);
    if (!e) return { ok: false, reason: 'No track here' };
    if (e.cls !== cls) return { ok: false, reason: `Heavy and light metro track can't connect` };
    const g = this.geom(edgeId);
    if (u < 15 || u > g.length - 15) return { ok: false, reason: 'Too close to a node' };
    if (this.isRamp(edgeId)) return { ok: false, reason: `Can't branch from a ramp` };
    const piece = g.pieces.find((p) => u >= p.s0 && u <= p.s1);
    if (!piece || isFinite(piece.r)) return { ok: false, reason: 'Branch from a straight section, not a curve' };
    if (u - piece.s0 < 5 || piece.s1 - u < 5) return { ok: false, reason: 'Branch from a straight section, not a curve' };
    for (const s of this.stations.values()) {
      if (s.edge !== edgeId) continue;
      const half = platformLength(s.cars, e.cls) / 2 + 10;
      if (Math.abs(s.u - u) < half) return { ok: false, reason: `Can't branch inside a platform` };
    }
    return { ok: true };
  }

  /** Heading of an edge as it leaves node `nodeId` (unit vector), at the node itself. */
  departHeading(edgeId: number, nodeId: number): [number, number] {
    const e = this.edges.get(edgeId)!;
    const g = this.geom(edgeId);
    if (e.a === nodeId) {
      const p = sampleAt(g.xs, g.ys, g.cum, 0);
      return [p.hx, p.hy];
    }
    const p = sampleAt(g.xs, g.ys, g.cum, g.length);
    return [-p.hx, -p.hy];
  }

  // ------------------------------------------------------------------ editing ops

  /** Turn a node into an anchor whose through heading follows its existing track. */
  private makeAnchor(id: number): void {
    const n = this.nodes.get(id)!;
    // A junction keeps its axis; a plain track end re-derives it from the track it ends.
    if (n.anchor && this.degree(id) >= 2) return;
    const inc = this.incident(id);
    if (inc.length > 0) {
      const [hx, hy] = this.departHeading(inc[0], id);
      n.hx = hx;
      n.hy = hy;
    }
    n.anchor = true;
    n.r = 0;
  }

  /**
   * Split an edge at distance u, inserting an anchor node on the straight. Statuses, build
   * progress and spent cost carry over; stations move to whichever half holds them.
   */
  splitEdge(edgeId: number, u: number): number {
    const e = this.edges.get(edgeId)!;
    const g = this.geom(edgeId);
    const p = sampleAt(g.xs, g.ys, g.cum, u);
    const a = this.nodes.get(e.a)!;
    const J = this.newNode(p.x, p.y, a.level, e.cls);
    J.anchor = true;
    J.hx = p.hx;
    J.hy = p.hy;
    const L = g.length;
    this.removeEdgeRaw(edgeId);
    const e1 = this.newEdge(e.a, J.id, e.cls, e.status);
    const e2 = this.newEdge(J.id, e.b, e.cls, e.status);
    for (const ne of [e1, e2]) {
      ne.buildStart = e.buildStart;
      ne.buildEnd = e.buildEnd;
    }
    e1.cost = (e.cost * u) / L;
    e2.cost = e.cost - e1.cost;
    for (const s of this.stations.values()) {
      if (s.edge !== edgeId) continue;
      if (s.u < u) s.edge = e1.id;
      else {
        s.edge = e2.id;
        s.u -= u;
      }
    }
    this.touch();
    this.splitMap.set(edgeId, { u, e1: e1.id, e2: e2.id });
    return J.id;
  }
  /** Most recent split of each edge (lets a stroke resolve two snaps on the same edge). */
  splitMap = new Map<number, { u: number; e1: number; e2: number }>();

  /**
   * Commit a drawn stroke as blueprint track. Returns the new edge ids.
   * points[0] / points[last] are where the user clicked; snaps say whether they attach to track.
   */
  addStroke(points: StrokePoint[], cls: TrackClass, startSnap: Snap, endSnap: Snap): number[] {
    if (points.length < 2) return [];
    this.splitMap.clear();
    const lead = TRACK.leadPreferredRadius[cls];
    const newFillet = new Set<number>();
    const chain: number[] = [];

    // ---- start
    let startNode: number;
    let startAnchorSign = 0;
    // Extending a plain track end must continue away from the existing track, never double back.
    let startWasEnd = false;
    if (startSnap.kind === 'node') {
      startNode = startSnap.node;
      startWasEnd = this.degree(startNode) === 1;
      if (this.degree(startNode) >= 1) this.makeAnchor(startNode);
    } else if (startSnap.kind === 'edge') {
      startNode = this.splitEdge(startSnap.edge, startSnap.u);
    } else {
      startNode = this.newNode(points[0].x, points[0].y, points[0].level, cls).id;
    }
    chain.push(startNode);
    const S = this.nodes.get(startNode)!;
    const isStartAnchor = S.anchor && this.degree(startNode) >= 1;

    // ---- resolve end (may refer to an edge we just split)
    let resolvedEnd = endSnap;
    if (endSnap.kind === 'edge' && this.splitMap.has(endSnap.edge)) {
      const sp = this.splitMap.get(endSnap.edge)!;
      resolvedEnd = endSnap.u < sp.u ? { kind: 'edge', edge: sp.e1, u: endSnap.u } : { kind: 'edge', edge: sp.e2, u: endSnap.u - sp.u };
    }
    let endNode: number | null = null;
    let endWasEnd = false;
    if (resolvedEnd.kind === 'node') {
      endNode = resolvedEnd.node;
      endWasEnd = this.degree(endNode) === 1 && endNode !== startNode;
      if (this.degree(endNode) >= 1) this.makeAnchor(endNode);
    } else if (resolvedEnd.kind === 'edge') {
      endNode = this.splitEdge(resolvedEnd.edge, resolvedEnd.u);
    }

    // Interior user points (exclude snapped endpoints).
    const inner = points.slice(1, endNode !== null ? -1 : undefined);

    // ---- lead after the start anchor
    if (isStartAnchor) {
      const target = inner[0] ?? (endNode !== null ? this.nodes.get(endNode)! : points[points.length - 1]);
      // h points into the existing track at a plain end, so continuing means going along −h.
      const sign = startWasEnd ? -1 : Math.sign((target.x - S.x) * S.hx + (target.y - S.y) * S.hy) || 1;
      startAnchorSign = sign;
      const L = leadLength(S, sign, target.x, target.y, lead);
      const ln = this.newNode(S.x + S.hx * sign * L, S.y + S.hy * sign * L, S.level, cls);
      ln.leadOf = S.id;
      chain.push(ln.id);
      newFillet.add(ln.id);
    }
    void startAnchorSign;

    for (const p of inner) {
      const n = this.newNode(p.x, p.y, p.level, cls);
      chain.push(n.id);
      newFillet.add(n.id);
    }

    // ---- lead before the end anchor
    if (endNode !== null) {
      const E = this.nodes.get(endNode)!;
      const prev = this.nodes.get(chain[chain.length - 1])!;
      if (E.anchor && this.degree(endNode) >= 1) {
        const sign = endWasEnd ? -1 : Math.sign((prev.x - E.x) * E.hx + (prev.y - E.y) * E.hy) || 1;
        const L = leadLength(E, sign, prev.x, prev.y, lead);
        const ln = this.newNode(E.x + E.hx * sign * L, E.y + E.hy * sign * L, E.level, cls);
        ln.leadOf = E.id;
        chain.push(ln.id);
        newFillet.add(ln.id);
      }
      chain.push(endNode);
    }

    const created: number[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      created.push(this.newEdge(chain[i], chain[i + 1], cls).id);
    }
    // A free start node that later gets more edges is still a plain end — nothing to do.
    this.touch();
    this.autoFillet(newFillet);
    this.touch();
    return created;
  }

  /**
   * Choose fillet radii for the given vertices: the largest curve that fits, sharing each edge
   * between its two curved ends in proportion to how sharply each turns.
   */
  autoFillet(ids: Set<number>): void {
    const theta = new Map<number, number>();
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const inc = this.incident(id);
      if (n.anchor || inc.length !== 2) {
        n.r = 0;
        continue;
      }
      const [p, q] = inc.map((eid) => this.nodes.get(otherEnd(this.edges.get(eid)!, id))!);
      theta.set(id, vertexDeflection(p, n, q));
    }
    const w = (id: number) => Math.tan((theta.get(id) ?? 0) / 2);
    for (const [id, th] of theta) {
      const n = this.nodes.get(id)!;
      if (th < TRACK.straightEpsilon) {
        n.r = 0;
        continue;
      }
      let t = n.leadOf !== null ? Infinity : TRACK.filletMaxTangent;
      for (const eid of this.incident(id)) {
        const e = this.edges.get(eid)!;
        const o = this.nodes.get(otherEnd(e, id))!;
        const L = Math.hypot(o.x - n.x, o.y - n.y);
        let avail: number;
        if (theta.has(o.id)) {
          const wo = w(o.id);
          avail = (L * w(id)) / (w(id) + wo);
        } else {
          avail = L - fixedTangent(this, o);
        }
        t = Math.min(t, avail);
      }
      n.r = radiusForTangent(Math.max(0, t), th);
    }
  }

  /** Drag a blueprint node. Lead nodes slide along their anchor's axis. */
  moveNode(id: number, x: number, y: number): boolean {
    const n = this.nodes.get(id);
    if (!n || !this.nodeEditable(id) || (n.anchor && this.degree(id) > 1)) return false;
    // Leads, and any vertex next to a junction, slide along the junction's axis so track always
    // leaves junctions straight.
    let axis: TrackNode | undefined = n.leadOf !== null ? this.nodes.get(n.leadOf) : undefined;
    if (!axis) {
      for (const eid of this.incident(id)) {
        const o = this.nodes.get(otherEnd(this.edges.get(eid)!, id))!;
        if (o.anchor && this.degree(o.id) >= 2) axis = o;
      }
    }
    if (axis) {
      const A = axis;
      const sign = Math.sign((n.x - A.x) * A.hx + (n.y - A.y) * A.hy) || 1;
      const proj = Math.max(TRACK.leadMinLength, ((x - A.x) * A.hx + (y - A.y) * A.hy) * sign);
      x = A.x + A.hx * sign * proj;
      y = A.y + A.hy * sign * proj;
    }
    n.x = x;
    n.y = y;
    const refit = new Set<number>([id]);
    for (const eid of this.incident(id)) {
      const o = otherEnd(this.edges.get(eid)!, id);
      if (this.nodeEditable(o)) refit.add(o);
    }
    this.touch();
    this.autoFillet(refit);
    this.touch();
    return true;
  }

  setNodeLevel(id: number, level: TrackLevel): void {
    const n = this.nodes.get(id);
    if (!n || !this.nodeEditable(id)) return;
    n.level = level;
    this.touch();
  }

  /** Remove an edge and any nodes left orphaned. Stations on it are removed too. */
  /**
   * Remove an edge and any nodes left orphaned (stations on it go too). A branch's lead stub left
   * dangling along the trunk is removed with it. Returns every edge id removed.
   */
  removeEdge(id: number): number[] {
    const e = this.edges.get(id);
    if (!e) return [];
    const removed = [id];
    const drop = (eid: number) => {
      for (const [sid, s] of this.stations) if (s.edge === eid) this.stations.delete(sid);
      this.removeEdgeRaw(eid);
    };
    drop(id);
    for (const nid of [e.a, e.b]) {
      const n = this.nodes.get(nid);
      if (!n || n.leadOf === null) continue;
      const other = otherEnd(e, nid);
      if (other === n.leadOf) {
        // The lead lost its link to the junction: it's an ordinary vertex now.
        n.leadOf = null;
      } else if (this.degree(nid) === 1) {
        // The lead lost the track it led to: drop the stub lying along the trunk.
        const stub = this.incident(nid)[0];
        removed.push(stub);
        const se = this.edges.get(stub)!;
        drop(stub);
        for (const k of [se.a, se.b]) if (this.degree(k) === 0) this.nodes.delete(k);
      }
    }
    for (const nid of [e.a, e.b]) if (this.nodes.has(nid) && this.degree(nid) === 0) this.nodes.delete(nid);
    for (const n of this.nodes.values()) if (n.leadOf !== null && !this.nodes.has(n.leadOf)) n.leadOf = null;
    for (const n of this.nodes.values()) {
      const deg = this.degree(n.id);
      // Vertices that lost a neighbour lose their fillet; ends stop being anchors.
      if (deg < 2) {
        n.r = 0;
        n.anchor = false;
      }
    }
    this.touch();
    return removed;
  }

  addStation(edgeId: number, u: number, cars: number, name: string, status: Status = 'blueprint'): Station {
    const s: Station = {
      id: this.nextId++,
      edge: edgeId,
      u,
      cars,
      name,
      nameAuto: true,
      status,
      buildStart: 0,
      buildEnd: 0,
      cost: 0,
    };
    this.stations.set(s.id, s);
    this.touch();
    return s;
  }

  removeStation(id: number): void {
    this.stations.delete(id);
    this.touch();
  }

  /** Station centre position and heading. */
  stationPos(s: Station): { x: number; y: number; hx: number; hy: number } {
    const g = this.geom(s.edge);
    return sampleAt(g.xs, g.ys, g.cum, Math.min(s.u, g.length));
  }

  stationLevel(s: Station): TrackLevel {
    return this.levelAt(s.edge, s.u);
  }

  /** Blueprint items present? */
  hasBlueprint(): boolean {
    for (const e of this.edges.values()) if (e.status === 'blueprint') return true;
    for (const s of this.stations.values()) if (s.status === 'blueprint') return true;
    return false;
  }
}

const EMPTY: readonly number[] = [];

export function platformLength(cars: number, cls: TrackClass): number {
  const carLen = cls === 'heavy' ? 18 : 20;
  return cars * carLen + STATION.platformMargin;
}

function vertexDeflection(p: TrackNode, n: TrackNode, q: TrackNode): number {
  const l1 = Math.hypot(n.x - p.x, n.y - p.y) || 1;
  const l2 = Math.hypot(q.x - n.x, q.y - n.y) || 1;
  return deflection((n.x - p.x) / l1, (n.y - p.y) / l1, (q.x - n.x) / l2, (q.y - n.y) / l2);
}

/** Tangent length used by a vertex's existing (fixed) fillet. */
function fixedTangent(net: Network, n: TrackNode): number {
  if (n.anchor || n.r <= 0) return 0;
  const inc = net.incident(n.id);
  if (inc.length !== 2) return 0;
  const [p, q] = inc.map((eid) => net.nodes.get(otherEnd(net.edges.get(eid)!, n.id))!);
  return n.r * Math.tan(vertexDeflection(p, n, q) / 2);
}

/**
 * Distance from an anchor to its lead vertex: long enough that the branch can curve away at the
 * preferred radius, starting right at the junction.
 */
function leadLength(A: TrackNode, sign: number, tx: number, ty: number, prefRadius: number): number {
  const dist = Math.hypot(tx - A.x, ty - A.y);
  let L = Math.min(dist * 0.45, 200);
  for (let i = 0; i < 3; i++) {
    const lx = A.x + A.hx * sign * L, ly = A.y + A.hy * sign * L;
    const dx = tx - lx, dy = ty - ly;
    const dl = Math.hypot(dx, dy) || 1;
    const th = deflection(A.hx * sign, A.hy * sign, dx / dl, dy / dl);
    const want = prefRadius * Math.tan(th / 2);
    L = Math.max(TRACK.leadMinLength, Math.min(want, dist * 0.45));
  }
  return L;
}
