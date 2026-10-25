/**
 * Interchanges: stations within 200 m of each other (on different track) are linked.
 * Transfer walk time is distance ÷ 1.2 m/s + 60 s.
 */
import { COMMUTERS, QUAD, STATION, STATION_TIERS } from '../balance';
import type { Network } from '../construction/network';
import type { CStation } from '../sim/protocol';

export interface Interchanges {
  /** station id → group index */
  groupOf: Map<number, number>;
  /** group index → station ids (groups of one are included) */
  groups: number[][];
}

export function computeInterchanges(net: Network, filter?: (stationId: number) => boolean): Interchanges {
  const ids = [...net.stations.keys()].filter((id) => !filter || filter(id));
  const pos = new Map(ids.map((id) => [id, net.stationPos(net.stations.get(id)!)]));
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  // Grid bucket for neighbour search.
  const cell = STATION.interchangeRadius;
  const grid = new Map<string, number[]>();
  for (const id of ids) {
    const p = pos.get(id)!;
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
  }
  for (const id of ids) {
    const p = pos.get(id)!;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const o of grid.get(`${cx + i},${cy + j}`) ?? []) {
          if (o <= id) continue;
          const q = pos.get(o)!;
          if (Math.hypot(p.x - q.x, p.y - q.y) <= STATION.interchangeRadius) parent.set(find(o), find(id));
        }
  }
  const groupIndex = new Map<number, number>();
  const groups: number[][] = [];
  const groupOf = new Map<number, number>();
  for (const id of ids) {
    const root = find(id);
    let g = groupIndex.get(root);
    if (g === undefined) {
      g = groups.length;
      groupIndex.set(root, g);
      groups.push([]);
    }
    groups[g].push(id);
    groupOf.set(id, g);
  }
  return { groupOf, groups };
}

/** Walk time between two platforms (same station: just the base transfer time). */
export function transferTime(distance: number): number {
  return distance / STATION.walkSpeed + STATION.transferBase;
}

/**
 * Four-track sections (v2): walk time from platform a to platform b (compiled index bIndex). A
 * step across to the cross-platform partner takes QUAD.crossPlatformTransfer; anything else is
 * exactly transferTime of the distance.
 */
export function platformTransfer(a: CStation, b: CStation, bIndex: number): number {
  if (a.pair === bIndex) return QUAD.crossPlatformTransfer;
  // Station upgrades: wider passages and escalators shorten changes (the two ends' average).
  const save = (STATION_TIERS[a.tier ?? 0].transferSave + STATION_TIERS[b.tier ?? 0].transferSave) / 2;
  return Math.max(15, transferTime(Math.hypot(b.x - a.x, b.y - a.y)) - save);
}

/** Transfer penalty (s) from platform a to the platform with compiled index bIndex: reduced across a pair. */
export function transferPenaltyFor(a: CStation, bIndex: number): number {
  return a.pair === bIndex ? COMMUTERS.transferPenalty * QUAD.crossPlatformPenaltyFactor : COMMUTERS.transferPenalty;
}
