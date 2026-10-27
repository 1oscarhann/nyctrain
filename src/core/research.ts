/**
 * Research projects (balance.ts RESEARCH): the company pays a project's cost when it starts, the
 * design team works on it for its weekdays (each settled day), and when it finishes its effects
 * apply at once (core/tech.ts). One project at a time, two with the second design team; Sandbox
 * finishes them at once and free.
 */
import { ECONOMY, RESEARCH, RESEARCH_TUNING, STOCK_IDS, TRAIN_MARKS, type ResearchDef, type ResearchId, type StockId } from '../balance';
import { applyTech } from './tech';

export interface ActiveResearch {
  id: ResearchId;
  /** Weekdays of work left. */
  daysLeft: number;
  /** What was paid (the refund on cancel is a share of it). */
  paid: number;
}

export interface ResearchState {
  /** Finished projects, in the order they finished. */
  done: ResearchId[];
  active: ActiveResearch[];
}

export const emptyResearch = (): ResearchState => ({ done: [], active: [] });

const BY_ID = new Map(RESEARCH.map((r) => [r.id, r]));
export const researchDef = (id: ResearchId): ResearchDef => BY_ID.get(id)!;

/** Research that unlocks a train mark: the train type and the mark number. */
export const TRAIN_MARKS_BY_RESEARCH = new Map<ResearchId, { stock: StockId; mark: number }>(
  STOCK_IDS.flatMap((stock) => TRAIN_MARKS[stock].flatMap((m, i) => (m.research ? [[m.research, { stock, mark: i + 1 }] as [ResearchId, { stock: StockId; mark: number }]] : []))),
);

/** A project's price in this city (a share of its starting cash), rounded to a tidy figure. */
export function researchCost(id: ResearchId): number {
  const raw = researchDef(id).cost * ECONOMY.startingCash;
  const step = raw >= 1e8 ? 1e7 : 1e6;
  return Math.round(raw / step) * step;
}

export function researchSlots(s: ResearchState): number {
  return s.done.includes('labs-2') ? RESEARCH_TUNING.slotsWithLabs : RESEARCH_TUNING.slots;
}

export type ResearchStatus = 'done' | 'active' | 'ready' | 'locked';

export function researchStatus(s: ResearchState, id: ResearchId): ResearchStatus {
  if (s.done.includes(id)) return 'done';
  if (s.active.some((a) => a.id === id)) return 'active';
  return (researchDef(id).requires ?? []).every((r) => s.done.includes(r)) ? 'ready' : 'locked';
}

/** Why a project can't start now (null: it can). */
export function cantStart(s: ResearchState, id: ResearchId, cash: number, sandbox: boolean): string | null {
  const st = researchStatus(s, id);
  if (st === 'done') return 'Already researched';
  if (st === 'active') return 'Already being researched';
  if (st === 'locked') return `Needs ${(researchDef(id).requires ?? []).filter((r) => !s.done.includes(r)).map((r) => researchDef(r).name).join(' and ')} first`;
  if (!sandbox && s.active.length >= researchSlots(s)) return researchSlots(s) > 1 ? 'Both design teams are busy' : 'The design team is busy (research a second team to run two)';
  if (!sandbox && researchCost(id) > cash) return 'Not enough money';
  return null;
}

/** A sanitized research state from a save (unknown ids, duplicates and nonsense dropped). */
export function sanitizeResearch(raw: unknown): ResearchState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { done?: unknown; active?: unknown };
  const done: ResearchId[] = [];
  for (const id of Array.isArray(r.done) ? r.done : []) if (BY_ID.has(id as ResearchId) && !done.includes(id as ResearchId)) done.push(id as ResearchId);
  const active: ActiveResearch[] = [];
  for (const a of Array.isArray(r.active) ? r.active : []) {
    if (!a || typeof a !== 'object') continue;
    const x = a as Partial<ActiveResearch>;
    if (!BY_ID.has(x.id as ResearchId) || done.includes(x.id!) || active.some((y) => y.id === x.id)) continue;
    const daysLeft = Math.max(1, Math.round(Number(x.daysLeft)) || 1);
    const paid = Math.max(0, Number(x.paid) || 0);
    active.push({ id: x.id!, daysLeft, paid });
  }
  return { done, active };
}

/** One weekday of work on every active project. Returns the ones that finished (effects applied). */
export function advance(s: ResearchState): ResearchId[] {
  const finished: ResearchId[] = [];
  for (const a of s.active) {
    a.daysLeft--;
    if (a.daysLeft <= 0) finished.push(a.id);
  }
  if (!finished.length) return finished;
  s.active = s.active.filter((a) => a.daysLeft > 0);
  s.done.push(...finished);
  applyTech(s.done);
  return finished;
}
