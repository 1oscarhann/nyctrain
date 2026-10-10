/** Hit-testing against the track network in local metres. */
import type { TrackClass } from '../balance';
import { projectOnPolyline } from './geometry';
import type { Network } from './network';
import type { Snap } from './types';

export interface EdgeHit {
  edge: number;
  u: number;
  d: number;
  x: number;
  y: number;
}

export function pickEdge(net: Network, x: number, y: number, tol: number, filter?: (edgeId: number) => boolean): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const e of net.edges.values()) {
    if (filter && !filter(e.id)) continue;
    const g = net.geom(e.id);
    // Cheap reject against the centreline's bounding box.
    if (x < g.minX - tol || x > g.maxX + tol || y < g.minY - tol || y > g.maxY + tol) continue;
    const p = projectOnPolyline(g.xs, g.ys, g.cum, x, y);
    if (p.d <= tol && (!best || p.d < best.d)) best = { edge: e.id, u: p.s, d: p.d, x: p.x, y: p.y };
  }
  return best;
}

export function pickNode(net: Network, x: number, y: number, tol: number, filter?: (nodeId: number) => boolean): number | null {
  let best: number | null = null;
  let bestD = tol;
  for (const n of net.nodes.values()) {
    if (filter && !filter(n.id)) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

export interface SnapResult {
  snap: Snap;
  x: number;
  y: number;
  ok: boolean;
  reason?: string;
}

/**
 * Where would a stroke attach if the user clicked here? Prefers track ends and junction nodes,
 * then a point on an edge (which becomes a new junction).
 */
export function snapForTrack(net: Network, x: number, y: number, tol: number, cls: TrackClass): SnapResult {
  const nodeId = pickNode(net, x, y, tol, (id) => net.degree(id) > 0 && net.nodes.get(id)!.leadOf === null);
  if (nodeId !== null) {
    const n = net.nodes.get(nodeId)!;
    const chk = net.canAttachAtNode(nodeId, cls);
    return { snap: { kind: 'node', node: nodeId }, x: n.x, y: n.y, ok: chk.ok, reason: chk.reason };
  }
  const hit = pickEdge(net, x, y, tol);
  if (hit) {
    const chk = net.canSplitAt(hit.edge, hit.u, cls);
    return { snap: { kind: 'edge', edge: hit.edge, u: hit.u }, x: hit.x, y: hit.y, ok: chk.ok, reason: chk.reason };
  }
  return { snap: { kind: 'none' }, x, y, ok: true };
}
