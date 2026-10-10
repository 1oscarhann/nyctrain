/**
 * Blueprint editing: undo/redo history, the blueprint summary (cost, time, validity),
 * committing blueprints to construction, construction progress, and bulldozing.
 */
import { STATION, TRACK } from '../balance';
import type { Network } from './network';
import type { NetworkData } from './types';
import { edgeReport, stationReport, type Terrain } from './validate';

export interface BlueprintSummary {
  edges: number;
  stations: number;
  length: number;
  cost: number;
  /** Longest single item — everything is built in parallel. */
  days: number;
  invalid: { kind: 'edge' | 'station'; id: number; reason: string }[];
}

export function blueprintSummary(net: Network, terrain: Terrain): BlueprintSummary {
  const sum: BlueprintSummary = { edges: 0, stations: 0, length: 0, cost: 0, days: 0, invalid: [] };
  for (const e of net.edges.values()) {
    if (e.status !== 'blueprint') continue;
    const r = edgeReport(net, e.id, terrain);
    sum.edges++;
    sum.length += r.length;
    sum.cost += r.cost;
    sum.days = Math.max(sum.days, r.days);
    if (!r.ok) sum.invalid.push({ kind: 'edge', id: e.id, reason: r.errors[0] });
  }
  for (const s of net.stations.values()) {
    if (s.status !== 'blueprint') continue;
    const r = stationReport(net, s.edge, s.u, s.cars, terrain, s.id);
    sum.stations++;
    sum.cost += r.cost;
    sum.days = Math.max(sum.days, r.days);
    if (!r.ok) sum.invalid.push({ kind: 'station', id: s.id, reason: r.errors[0] });
  }
  return sum;
}

/**
 * Turn every blueprint item into a construction job (or build it instantly in sandbox).
 * Each item gets its own duration; all are built in parallel. Returns money spent.
 */
export function commitBlueprints(net: Network, terrain: Terrain, now: number, instant: boolean): number {
  let spent = 0;
  const DAY = 86400;
  for (const e of net.edges.values()) {
    if (e.status !== 'blueprint') continue;
    const r = edgeReport(net, e.id, terrain);
    e.cost = r.cost;
    spent += r.cost;
    e.buildStart = now;
    e.buildEnd = now + Math.max(1, r.days) * DAY;
    e.status = instant ? 'built' : 'construction';
  }
  for (const s of net.stations.values()) {
    if (s.status !== 'blueprint') continue;
    const r = stationReport(net, s.edge, s.u, s.cars, terrain, s.id);
    s.cost = r.cost;
    spent += r.cost;
    s.buildStart = now;
    s.buildEnd = now + r.days * DAY;
    s.status = instant ? 'built' : 'construction';
  }
  net.touch();
  return spent;
}

/** Finish construction jobs whose time has come. Returns true if anything opened. */
export function advanceConstruction(net: Network, now: number): boolean {
  let changed = false;
  for (const e of net.edges.values()) {
    if (e.status === 'construction' && now >= e.buildEnd) {
      e.status = 'built';
      changed = true;
    }
  }
  for (const s of net.stations.values()) {
    if (s.status === 'construction' && now >= s.buildEnd) {
      s.status = 'built';
      changed = true;
    }
  }
  if (changed) net.touch();
  return changed;
}

export function progress(item: { buildStart: number; buildEnd: number }, now: number): number {
  const span = item.buildEnd - item.buildStart;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (now - item.buildStart) / span));
}

export const BULLDOZE_REFUND = TRACK.bulldozeRefund;
export const STATION_DEFAULT_CARS = STATION.cars;

// ---------------------------------------------------------------------------
// Undo / redo of blueprint edits

export class BlueprintHistory {
  private undoStack: NetworkData[] = [];
  private redoStack: NetworkData[] = [];
  private limit = 100;

  /** Call before a blueprint edit. */
  record(net: Network): void {
    this.undoStack.push(net.toData());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(net: Network): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(net.toData());
    restoreKeepingProgress(net, prev);
    return true;
  }

  redo(net: Network): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(net.toData());
    restoreKeepingProgress(net, next);
    return true;
  }

  /** Building or bulldozing real track ends the undoable blueprint session. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/**
 * Restore a snapshot but keep the live construction status of items that exist in both —
 * finishing construction is not a blueprint edit and must not be undone.
 */
function restoreKeepingProgress(net: Network, snap: NetworkData): void {
  const liveEdges = new Map([...net.edges.values()].map((e) => [e.id, e]));
  const liveStations = new Map([...net.stations.values()].map((s) => [s.id, s]));
  const data: NetworkData = JSON.parse(JSON.stringify(snap));
  for (const e of data.edges) {
    const live = liveEdges.get(e.id);
    if (live && live.status !== 'blueprint') {
      e.status = live.status;
      e.buildStart = live.buildStart;
      e.buildEnd = live.buildEnd;
      e.cost = live.cost;
    }
  }
  for (const s of data.stations) {
    const live = liveStations.get(s.id);
    if (live && live.status !== 'blueprint') Object.assign(s, { status: live.status, buildStart: live.buildStart, buildEnd: live.buildEnd, cost: live.cost, name: live.name });
  }
  data.nextId = Math.max(data.nextId, net.nextId);
  net.load(data);
}
