/**
 * Goals: no hard win, just milestones with checkmarks and a toast when each completes.
 */
import { GOALS, TIME } from '../balance';
import { city, regionCode } from '../cities';
import type { CityGoal } from '../cities/types';
import type { DayReport } from '../sim/protocol';
import type { Game } from './game';
import { fmtCount, fmtMoney, fmtPct } from './units';
import { ratingIndex } from '../economy/credit';
import { computeInterchanges } from '../routes/interchange';

export interface GoalDef {
  id: string;
  title: string;
  detail: string;
  stretch?: boolean;
}

/** The current city's goals: generic milestones around the city's own crossing, reach and trip goals. */
export function goalDefs(): GoalDef[] {
  const c = city();
  const place = c.goals.filter((g) => g.kind !== 'trip');
  const trips = c.goals.filter((g) => g.kind === 'trip');
  return [
    { id: 'first-line', title: 'Open your first line', detail: 'Run trains on a route with every station built.' },
    ...place,
    ...GOALS.riderMilestones.map((n) => ({ id: `riders-${n}`, title: `${fmtCount(n)} daily riders`, detail: `Carry ${n.toLocaleString()} trips in a day.` })),
    { id: 'share-50', title: 'Transit mode share above 50%', detail: `More than half of commuters choose your trains.` },
    { id: 'commute-10', title: 'Commute 10 minutes faster', detail: 'Average commute (all modes) 10 minutes below the no-transit baseline.' },
    ...trips,
    { id: 'monthly-profit', title: 'Make a monthly profit', detail: 'Fares beat operating costs and bond interest for a month.' },
    { id: 'rating-a', title: 'Investment grade', detail: `Hold an ${GOALS.ratingGoal} rating or better while owing at least ${fmtMoney(GOALS.ratingGoalMinDebt)}.` },
    {
      id: 'clockwork',
      title: 'Clockwork service',
      detail: `Under ${fmtPct(GOALS.clockworkBunched, 0)} of headways bunched across ${GOALS.clockworkMinRoutes}+ routes on a day with ${fmtCount(GOALS.clockworkMinRiders)}+ riders.`,
    },
    // Living City (v2).
    { id: 'boomtown', title: 'Boomtown', detail: `Grow a neighbourhood ${fmtPct(GOALS.boomtownGrowth, 0)} since ${TIME.startDate.year} (residents and jobs).` },
    { id: 'value-capture', title: 'Land value pays', detail: `Collect ${fmtMoney(GOALS.valueCaptureMonth)} of value capture in one month.` },
  ];
}

export type GoalState = Record<string, number | null>;

export function emptyGoals(): GoalState {
  return Object.fromEntries(goalDefs().map((g) => [g.id, null]));
}

/** Region (land-mask code) that each running station is in, and the connected components of the network. */
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
  const comp = new Map<number, Set<number>>();
  for (const [sid, b] of stationBorough) {
    const root = find(sid);
    (comp.get(root) ?? comp.set(root, new Set()).get(root)!).add(b);
  }
  const codes = (names: string[]) => names.map(regionCode).filter((c) => c > 0);
  for (const g of city().goals as CityGoal[]) {
    if (g.kind === 'crossing') {
      const a = new Set(codes(g.a)), b = new Set(codes(g.b));
      mark(g.id, running.some((r) => {
        const bs = r.stops.map((s) => stationBorough.get(s) ?? 0);
        return bs.some((x) => a.has(x)) && bs.some((x) => b.has(x));
      }));
    } else if (g.kind === 'connect') {
      const need = codes(g.regions);
      mark(g.id, [...comp.values()].some((s) => need.every((c) => s.has(c))));
    } else if (report) {
      mark(g.id, report.goalTrip != null && report.goalTrip < GOALS.tripMinutes);
    }
  }
  if (report) {
    for (const n of GOALS.riderMilestones) mark(`riders-${n}`, report.riders >= n);
    mark('share-50', report.transitShare > GOALS.modeShareTarget);
    mark('commute-10', report.baselineCommute - report.avgCommute >= GOALS.commuteSavingMinutes);
  }
  const lastMonth = game.finance.months[game.finance.months.length - 1];
  mark('monthly-profit', !!lastMonth && lastMonth.profit > 0 && !game.sandbox);
  // Money market and operations control (v2).
  // Only a rating set by a month-end review counts: a new career starts at AAA as a placeholder
  // (month 1 borrows at the market rate), and a migrated save is rated on load until its first review.
  const market = game.finance.market;
  const rating = market.history.length > 0 ? market.rating : null;
  mark('rating-a', !game.sandbox && rating !== null && ratingIndex(rating) <= ratingIndex(GOALS.ratingGoal) && game.finance.debt() >= GOALS.ratingGoalMinDebt);
  // Living City: on the day a growth month closed. Value capture counts outside the sandbox only.
  mark('boomtown', (report?.growth?.maxTractGrowth ?? 0) >= GOALS.boomtownGrowth);
  mark('value-capture', !game.sandbox && (report?.growth?.valueCapture ?? 0) >= GOALS.valueCaptureMonth);
  const reg = report?.regularity;
  mark(
    'clockwork',
    !!report && !!reg && reg.samples > 0 && reg.bunched < GOALS.clockworkBunched && Object.keys(report.routeRegularity ?? {}).length >= GOALS.clockworkMinRoutes && report.riders >= GOALS.clockworkMinRiders,
  );
  return done;
}

export function goalTitle(id: string): string {
  return goalDefs().find((g) => g.id === id)?.title ?? id;
}
