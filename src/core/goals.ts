/**
 * Goals: no hard win, just milestones with checkmarks and a toast when each completes.
 */
import { GOALS } from '../balance';
import { BOROUGHS } from '../data/types';
import type { DayReport } from '../sim/protocol';
import type { Game } from './game';
import { fmtCount } from './units';
import { computeInterchanges } from '../routes/interchange';

export interface GoalDef {
  id: string;
  title: string;
  detail: string;
  stretch?: boolean;
}

export const GOAL_DEFS: GoalDef[] = [
  { id: 'first-line', title: 'Open your first line', detail: 'Run trains on a route with every station built.' },
  { id: 'east-river', title: 'Cross the East River', detail: 'A running route linking Manhattan with Brooklyn or Queens.' },
  { id: 'five-boroughs', title: 'Connect all five boroughs', detail: 'One connected network reaching all five. Staten Island needs a long tunnel.', stretch: true },
  ...GOALS.riderMilestones.map((n) => ({ id: `riders-${n}`, title: `${fmtCount(n)} daily riders`, detail: `Carry ${n.toLocaleString()} trips in a day.` })),
  { id: 'share-50', title: 'Transit mode share above 50%', detail: 'More than half of commuters choose the subway.' },
  { id: 'commute-10', title: 'Commute 10 minutes faster', detail: 'Average commute (all modes) 10 minutes below the no-subway baseline.' },
  { id: 'jfk-45', title: 'Midtown to JFK in under 45 minutes', detail: 'Door to door by transit, Bryant Park to the airport.' },
  { id: 'monthly-profit', title: 'Make a monthly profit', detail: 'Fares beat operating costs and bond interest for a month.' },
];

export type GoalState = Record<string, number | null>;

export function emptyGoals(): GoalState {
  return Object.fromEntries(GOAL_DEFS.map((g) => [g.id, null]));
}

/** Boroughs (1–5) that each running station is in, and the connected components of the network. */
function networkBoroughs(game: Game, borough: (x: number, y: number) => number) {
  const net = game.network;
  const running = game.routes.list().filter((r) => game.routes.operational(net, r).ok);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  const stationBorough = new Map<number, number>();
  for (const r of running)
    for (const sid of r.stops) {
      if (!parent.has(sid)) parent.set(sid, sid);
      const p = net.stationPos(net.stations.get(sid)!);
      stationBorough.set(sid, borough(p.x, p.y));
    }
  for (const r of running) for (let i = 1; i < r.stops.length; i++) union(r.stops[i - 1], r.stops[i]);
  const ic = computeInterchanges(net, (id) => parent.has(id));
  for (const g of ic.groups) for (let i = 1; i < g.length; i++) union(g[0], g[i]);
  return { running, stationBorough, find };
}

/** Check goals after a day closes (or a network change). Returns newly completed goal ids. */
export function checkGoals(game: Game, state: GoalState, report: DayReport | null, borough: (x: number, y: number) => number): string[] {
  const done: string[] = [];
  const mark = (id: string, cond: boolean) => {
    if (cond && state[id] === null) {
      state[id] = game.day;
      done.push(id);
    }
  };
  const { running, stationBorough, find } = networkBoroughs(game, borough);
  mark('first-line', running.length > 0);
  const MN = 1, BK = 3, QN = 4;
  mark(
    'east-river',
    running.some((r) => {
      const bs = new Set(r.stops.map((s) => stationBorough.get(s)));
      return bs.has(MN) && (bs.has(BK) || bs.has(QN));
    }),
  );
  const comp = new Map<number, Set<number>>();
  for (const [sid, b] of stationBorough) {
    const root = find(sid);
    (comp.get(root) ?? comp.set(root, new Set()).get(root)!).add(b);
  }
  mark('five-boroughs', [...comp.values()].some((s) => [1, 2, 3, 4, 5].every((b) => s.has(b))));
  if (report) {
    for (const n of GOALS.riderMilestones) mark(`riders-${n}`, report.riders >= n);
    mark('share-50', report.transitShare > GOALS.modeShareTarget);
    mark('commute-10', report.baselineCommute - report.avgCommute >= GOALS.commuteSavingMinutes);
    mark('jfk-45', report.midtownJfk !== null && report.midtownJfk < GOALS.jfkMinutes);
  }
  const lastMonth = game.finance.months[game.finance.months.length - 1];
  mark('monthly-profit', !!lastMonth && lastMonth.profit > 0 && !game.sandbox);
  return done;
}

export function goalTitle(id: string): string {
  return GOAL_DEFS.find((g) => g.id === id)?.title ?? id;
}

export { BOROUGHS };
