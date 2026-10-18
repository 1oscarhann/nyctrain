/**
 * The track network: nodes, edges and stations, plus the editing operations used by the tools.
 * Pure data + geometry — no rendering, no DOM — so it runs in tests and in the headless sim.
 */
import { QUAD, STATION, TRACK, type TrackClass, type TrackLevel } from '../balance';
import {
  computeEdgeGeom,
  concentric,
  deflection,
  mitre,
  otherEnd,
  radiusForTangent,
  sampleAt,
  turnSign,
  type EdgeGeom,
  type GraphView,
} from './geometry';
import type { ChainVertex, NetworkData, QuadTag, Snap, Station, Status, StrokePoint, TrackEdge, TrackNode } from './types';

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
      // Quad tags are nested objects: copy them, so snapshots, clones and the live network never
      // share one (an ordinary edge has no `quad` key, so its copy is exactly as before).
      edges: [...this.edges.values()].map((e) => (e.quad ? { ...e, quad: { ...e.quad } } : { ...e })),
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
    for (const e of d.edges) {
      const c: TrackEdge = { ...e };
      if (c.quad !== undefined) {
        const q = sanitizeQuadTag(c.quad);
        if (q) c.quad = q;
        else delete c.quad;
      }
      this.addEdgeRaw(c);
    }
    for (const s of d.stations) this.stations.set(s.id, { ...s });
    this.nextId = d.nextId;
    this.dropDangling();
    this.dropImplausible();
    this.touch();
  }

  /**
   * Four-track references (node `twin`, station `pair`) must point at something that exists and
   * points back. Clears any that don't (after a load, a removal or an edit that broke one).
   */
  private dropDangling(): void {
    for (const n of this.nodes.values()) {
      if (n.twin === undefined) continue;
      const t = this.nodes.get(n.twin);
      if (!t || t.twin !== n.id || t.id === n.id) delete n.twin;
    }
    for (const s of this.stations.values()) {
      if (s.pair === undefined) continue;
      const p = this.stations.get(s.pair);
      if (!p || p.pair !== s.id || p.id === s.id) delete s.pair;
    }
  }

  /**
   * After a load: four-track references must also make geometric sense (a corrupted or edited
   * save). Twins are at most a mitre's offset apart (QUAD.spacing / cos(θ/2) for the sharpest turn
   * a quad allows, under 60 m); a cross-platform pair is one platform on each pair of one group
   * (opposite roles) and opposite each other, within the distance the station tool links pairs at.
   */
  private dropImplausible(): void {
    for (const n of this.nodes.values()) {
      if (n.twin === undefined) continue;
      const t = this.nodes.get(n.twin);
      if (t && Math.hypot(t.x - n.x, t.y - n.y) > TWIN_MAX) {
        delete n.twin;
        delete t.twin;
      }
    }
    for (const s of this.stations.values()) {
      if (s.pair === undefined) continue;
      const p = this.stations.get(s.pair);
      if (!p) continue;
      const ta = this.edges.get(s.edge)?.quad, tb = this.edges.get(p.edge)?.quad;
      let ok = !!ta && !!tb && ta.g === tb.g && ta.role !== 'link' && tb.role !== 'link' && ta.role !== tb.role;
      if (ok) {
        const a = this.stationPos(s), b = this.stationPos(p);
        ok = Math.hypot(a.x - b.x, a.y - b.y) <= Math.hypot(QUAD.spacing, QUAD.pairLinkDistance) + QUAD.partnerTolerance;
      }
      if (!ok) {
        delete s.pair;
        delete p.pair;
      }
    }
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
      // Both halves stay on the same pair of a four-track section (a→b order is kept, so `away` holds).
      if (e.quad) ne.quad = { ...e.quad };
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

  /**
   * Drag a blueprint node. Lead nodes slide along their anchor's axis. A vertex of a four-track
   * section drags its twin on the other pair along (syncTwins), so the drag is refused while the
   * twin is built or under construction (once one pair is built the other stays put). A twin that
   * has since become a junction no longer follows.
   */
  moveNode(id: number, x: number, y: number): boolean {
    const n = this.nodes.get(id);
    if (!n || !this.nodeEditable(id) || (n.anchor && this.degree(id) > 1)) return false;
    if (n.twin !== undefined && this.nodes.has(n.twin) && !this.nodeEditable(n.twin)) return false;
    // Leads, and any vertex next to a junction, slide along the junction's axis so track always
    // leaves junctions straight.
    let axis: TrackNode | undefined = n.leadOf !== null ? this.nodes.get(n.leadOf) : undefined;
    if (!axis && n.twin !== undefined) {
      // Four tracks: next to a fan, the other pair's turnout end is a fixed anchor further along
      // (not opposite the junction), so only a slide along that junction's axis keeps both pairs
      // straight and parallel there; the other side, if a junction too, is opposite its partner
      // junction (a scissors) and turns the same on both pairs. Between two fans it can't move.
      const fans = this.fanAnchors(id);
      if (fans.length > 1) return false;
      axis = fans[0];
    }
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
    this.syncTwins(refit);
    return true;
  }

  /**
   * Why a four-track vertex can't be dragged (null if it can): its twin is built or under
   * construction, or it sits between two fan junctions (both pairs must leave each straight, and
   * their chords there differ in length, so no position but the current one keeps them parallel).
   */
  quadDragBlock(id: number): 'built' | 'pinned' | null {
    const n = this.nodes.get(id);
    if (!n || n.twin === undefined || !this.nodes.has(n.twin)) return null;
    if (!this.nodeEditable(n.twin)) return 'built';
    return n.leadOf === null && this.fanAnchors(id).length > 1 ? 'pinned' : null;
  }

  /**
   * Junction neighbours of a four-track vertex whose counterpart on the twin's side is a fixed
   * anchor that is not opposite it: a fan's turnout junction, with the other pair's turnout end
   * QUAD.turnoutLength further along. Sliding off such a junction's axis would turn the two pairs'
   * chords by different angles (they have different lengths), kinking the other pair there.
   */
  private fanAnchors(id: number): TrackNode[] {
    const n = this.nodes.get(id)!;
    const t = n.twin !== undefined ? this.nodes.get(n.twin) : undefined;
    if (!t) return [];
    const tn = this.incident(t.id).map((eid) => this.nodes.get(otherEnd(this.edges.get(eid)!, t.id))!);
    const out: TrackNode[] = [];
    for (const eid of this.incident(id)) {
      const A = this.nodes.get(otherEnd(this.edges.get(eid)!, id))!;
      if (!A.anchor || this.degree(A.id) < 2) continue;
      // The twin's neighbour on A's side: the one nearest where A's counterpart would be.
      const ex = A.x + (t.x - n.x), ey = A.y + (t.y - n.y);
      let B: TrackNode | undefined;
      let bd = Infinity;
      for (const m of tn) {
        const d = Math.hypot(m.x - ex, m.y - ey);
        if (d < bd) [B, bd] = [m, d];
      }
      if (B && B.anchor && this.degree(B.id) >= 2 && Math.hypot(B.x - A.x, B.y - A.y) > QUAD.spacing + QUAD.partnerTolerance) out.push(A);
    }
    return out;
  }

  /** A twin vertex can be moved to follow its partner: blueprint, not a junction, ends or degree 2. */
  private twinCanFollow(id: number): boolean {
    const t = this.nodes.get(id);
    if (!t || !this.nodeEditable(id)) return false;
    const deg = this.degree(id);
    return !(t.anchor && deg > 1) && (deg === 1 || deg === 2);
  }

  /**
   * Keep the other pair of a four-track section parallel after the given vertices moved or were
   * refitted: each one's twin goes to the mitre point at QUAD.spacing on the partner side, with the
   * concentric radius. The side comes from the edge tags (−away is the partner side in an edge's
   * own a→b frame), so it holds however far a vertex is dragged. A free end's twin is offset
   * square to its one edge. Twins that are built or junctions are never moved.
   */
  syncTwins(ids: Iterable<number>): void {
    let moved = false;
    /** Twins given a concentric fillet, with what made it (for the fit check below). */
    const curved: { n: TrackNode; t: TrackNode; turn: number; d: number }[] = [];
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n?.twin === undefined || (n.anchor && this.degree(id) > 1)) continue;
      const t = this.nodes.get(n.twin);
      if (!t || !this.twinCanFollow(t.id)) continue;
      const inc = this.incident(id);
      if (inc.length !== 1 && inc.length !== 2) continue;
      // The side comes from a pair edge (not a connector or untagged track).
      const k = inc.findIndex((eid) => !!this.edges.get(eid)!.quad?.away);
      if (k < 0) continue;
      const e = this.edges.get(inc[k])!;
      const p = this.nodes.get(otherEnd(e, id))!;
      const q = inc.length === 2 ? this.nodes.get(otherEnd(this.edges.get(inc[1 - k])!, id))! : null;
      // Partner side relative to the travel direction p → n: −away in e's a→b frame, flipped if e runs n → p.
      const sigma = -e.quad!.away * (e.a === p.id ? 1 : -1);
      const d = sigma * QUAD.spacing;
      const m = mitre(p, n, q, d);
      if (!m) continue;
      t.x = m.x;
      t.y = m.y;
      if (q && !t.anchor) {
        const turn = turnSign(p, n, q);
        t.r = concentric(n.r, turn, d);
        if (t.r > 0) curved.push({ n, t, turn, d });
      }
      moved = true;
    }
    // A twin's fillet must also fit its own chords. Next to a fan the other pair's chord ends at
    // the turnout's far end, QUAD.turnoutLength short of the junction the drawn chord ends at, so a
    // vertex dragged close to a fan could curve the other pair past that anchor: shrink both
    // fillets (concentric still) until the twin's fits.
    for (const { n, t, turn, d } of curved) {
      const inc = this.incident(t.id);
      if (inc.length !== 2) continue;
      const [a, b] = inc.map((eid) => this.nodes.get(otherEnd(this.edges.get(eid)!, t.id))!);
      const th = vertexDeflection(a, t, b);
      if (th < TRACK.straightEpsilon) continue;
      const tan = Math.tan(th / 2);
      const avail = Math.min(Math.hypot(a.x - t.x, a.y - t.y) - fixedTangent(this, a), Math.hypot(b.x - t.x, b.y - t.y) - fixedTangent(this, b));
      if (t.r * tan <= avail + 1e-6) continue;
      n.r = Math.max(1, Math.max(0, avail) / tan - turn * d);
      t.r = concentric(n.r, turn, d);
    }
    if (moved) this.touch();
  }

  /** The edge joining two nodes (the first one, in incidence order), or null. */
  edgeBetween(a: number, b: number): number | null {
    for (const eid of this.incident(a)) {
      const e = this.edges.get(eid)!;
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return eid;
    }
    return null;
  }

  /**
   * Add a chain of new blueprint track through the given vertices (the express pair of a quad, in
   * travel order): `existing` ends are reused (made anchors when they already have track, as a
   * stroke's snapped ends are); every other vertex is a new node with its explicit fillet radius,
   * twin (linked both ways) and lead anchor (an index into `verts`). Edges run a→b along the list.
   * Returns the new edge ids in order. No fillets are recomputed: the radii are the caller's.
   * Existing ends listed in `join` become ordinary vertices of the chain instead (a repaired
   * four-track gap whose end was a curve vertex: the caller sets its fillet).
   */
  addChain(verts: ChainVertex[], cls: TrackClass, status: Status = 'blueprint', join?: ReadonlySet<number>): number[] {
    if (verts.length < 2) return [];
    const ids: number[] = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.existing !== undefined && this.nodes.has(v.existing)) {
        if (this.degree(v.existing) >= 1 && !join?.has(v.existing)) this.makeAnchor(v.existing);
        ids.push(v.existing);
        continue;
      }
      const n = this.newNode(v.x, v.y, v.level, cls);
      n.r = v.r > 0 ? v.r : 0;
      ids.push(n.id);
    }
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.existing !== undefined) continue;
      const n = this.nodes.get(ids[i])!;
      if (v.leadOf !== undefined && ids[v.leadOf] !== undefined) n.leadOf = ids[v.leadOf];
      if (v.twin !== undefined && this.nodes.has(v.twin)) {
        n.twin = v.twin;
        this.nodes.get(v.twin)!.twin = n.id;
      }
    }
    const created: number[] = [];
    for (let i = 0; i + 1 < ids.length; i++) created.push(this.newEdge(ids[i], ids[i + 1], cls, status).id);
    this.touch();
    return created;
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
    // Twins and cross-platform partners of anything removed.
    this.dropDangling();
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

  /** Remove a station; its cross-platform partner (if any) becomes a lone platform. */
  removeStation(id: number): void {
    const s = this.stations.get(id);
    if (s?.pair !== undefined) {
      const p = this.stations.get(s.pair);
      if (p && p.pair === id) delete p.pair;
    }
    this.stations.delete(id);
    this.touch();
  }

  /**
   * A cross-platform station on a four-track section: one platform on each pair, with the same
   * name, linked through `pair`. Returns [the platform on e1, the one on e2].
   */
  addStationPair(e1: number, u1: number, e2: number, u2: number, cars: number, name: string, status: Status = 'blueprint'): [Station, Station] {
    const a = this.addStation(e1, u1, cars, name, status);
    const b = this.addStation(e2, u2, cars, name, status);
    this.linkPair(a.id, b.id);
    return [a, b];
  }

  /** Link two platforms as a cross-platform pair (any previous partners become lone platforms). */
  linkPair(a: number, b: number): void {
    const sa = this.stations.get(a), sb = this.stations.get(b);
    if (!sa || !sb || a === b) return;
    for (const s of [sa, sb]) {
      if (s.pair === undefined) continue;
      const old = this.stations.get(s.pair);
      if (old && old.pair === s.id) delete old.pair;
    }
    sa.pair = b;
    sb.pair = a;
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

const QUAD_ROLES = new Set(['local', 'express', 'link']);
/** Farthest apart two twin vertices can be: the mitre offset at the sharpest turn a quad allows (≈ 57 m). */
const TWIN_MAX = 60;

/** A well-formed copy of a quad tag from saved data, or null if it is not one. */
function sanitizeQuadTag(q: unknown): QuadTag | null {
  if (!q || typeof q !== 'object') return null;
  const t = q as Partial<QuadTag>;
  if (typeof t.g !== 'number' || !Number.isFinite(t.g)) return null;
  if (typeof t.role !== 'string' || !QUAD_ROLES.has(t.role)) return null;
  if (t.away !== -1 && t.away !== 0 && t.away !== 1) return null;
  // A pair edge has a side (its partner lies at −away); one without is not a pair of anything.
  if (t.role !== 'link' && t.away === 0) return null;
  return { g: t.g, role: t.role, away: t.role === 'link' ? 0 : t.away };
}
