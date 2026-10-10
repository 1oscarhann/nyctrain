import type { TrackClass, TrackLevel } from '../balance';

export type Status = 'blueprint' | 'construction' | 'built';

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
