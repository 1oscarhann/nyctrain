import type { TrackClass, TrackLevel } from '../balance';

export type Status = 'blueprint' | 'construction' | 'built';

/** Which pair of a four-track section an edge belongs to (v2, docs/v2/express-quad.md §3). */
export type QuadRole = 'local' | 'express' | 'link';

export interface QuadTag {
  /** Quad group id (allocated from Network.nextId; shared by both pairs and their connectors). */
  g: number;
  role: QuadRole;
  /**
   * Side, relative to this edge's own a→b direction, that its route lines are pushed to on the
   * map (+1 right, −1 left): away from the partner pair. 0 for links. The partner lies at −away.
   */
  away: -1 | 0 | 1;
}

export interface TrackNode {
  id: number;
  x: number;
  y: number;
  level: TrackLevel;
  cls: TrackClass;
  /** Fillet radius at this vertex (0 = none). Used only for degree-2, non-anchor nodes. */
  r: number;
  /**
   * Anchor nodes (junctions, extended track ends) have a fixed through heading (hx, hy).
   * Every edge leaves an anchor straight, along +h or −h, with no fillet.
   */
  anchor: boolean;
  hx: number;
  hy: number;
  /** Lead nodes sit on the axis of an anchor and can only slide along it. */
  leadOf: number | null;
  /**
   * Four-track sections: the matching vertex on the other pair (symmetric). Set only on degree-2,
   * non-anchor vertices made by a quad stroke; a blueprint twin follows this vertex when dragged.
   */
  twin?: number;
}

export interface TrackEdge {
  id: number;
  a: number;
  b: number;
  cls: TrackClass;
  status: Status;
  /** Game time construction started / finishes. */
  buildStart: number;
  buildEnd: number;
  /** Money spent building it (0 for blueprints). */
  cost: number;
  /** Four-track sections: which pair this edge is (absent: ordinary double track). Never mutated in place. */
  quad?: QuadTag;
}

export interface Station {
  id: number;
  edge: number;
  /** Distance along the edge path from node a to the platform centre. */
  u: number;
  cars: number;
  name: string;
  nameAuto: boolean;
  status: Status;
  buildStart: number;
  buildEnd: number;
  cost: number;
  /** Cross-platform partner station id on the other pair of a four-track section (symmetric). */
  pair?: number;
}

export interface NetworkData {
  nodes: TrackNode[];
  edges: TrackEdge[];
  stations: Station[];
  nextId: number;
}

/** Where a stroke attaches to existing track. */
export type Snap =
  | { kind: 'none' }
  | { kind: 'node'; node: number }
  | { kind: 'edge'; edge: number; u: number };

export interface StrokePoint {
  x: number;
  y: number;
  level: TrackLevel;
}

/**
 * One vertex of a chain built by Network.addChain (the express pair of a quad). Either an
 * existing node (`existing`, made an anchor if it has track) or a new vertex with an explicit
 * fillet radius.
 */
export interface ChainVertex {
  x: number;
  y: number;
  level: TrackLevel;
  r: number;
  /** Use this existing node instead of creating one (chain ends only). */
  existing?: number;
  /** Index (into the same vertex list) of the anchor this vertex is a lead of. */
  leadOf?: number;
  /** Existing node to link as twins (both ways). */
  twin?: number;
}
