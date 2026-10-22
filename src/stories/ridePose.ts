/**
 * Commuter stories (v2): where a traced rider is at a game time, from the trace alone (pure). The
 * story card's status and the camera both read it; on a train the caller supplies the train's
 * drawn pose (Cinematic's trainPose).
 */
import type { StoryPlan, TraceData, TraceEvent } from '../sim/protocol';

export type RideKind = 'home' | 'work' | 'walk' | 'wait' | 'ride' | 'car' | 'ended';

export interface RideState {
  kind: RideKind;
  /** The event the state comes from (null: none yet). */
  event: TraceEvent | null;
  /** Local metres, when known without the train (walking, waiting, at home or work, by car). */
  x: number;
  y: number;
  /** Walking or by car: heading (degrees clockwise from north) and the share of the leg done. */
  heading: number;
  progress: number;
  /** Riding: the train id; waiting or walking to: the station id (−1: none). */
  train: number;
  station: number;
  /** Morning or evening trip. */
  pm: boolean;
  /** When the current step started and is due to end (game s; NaN: open-ended). */
  since: number;
  until: number;
}

const DEG = 180 / Math.PI;

/** Heading from a to b (degrees clockwise from north; 0 for a zero-length leg). */
export function headingOf(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  return ((Math.atan2(dx, dy) * DEG) % 360 + 360) % 360;
}

/** Linear walk position: from → to over [t0, t1], clamped. */
export function walkAt(from: readonly [number, number], to: readonly [number, number], t0: number, t1: number, t: number): { x: number; y: number; f: number } {
  const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 1;
  return { x: from[0] + (to[0] - from[0]) * f, y: from[1] + (to[1] - from[1]) * f, f };
}

/** The last event at or before t (events are chronological), with its index (−1: none). */
export function lastEventAt(events: readonly TraceEvent[], t: number): number {
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (events[m].t <= t) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

/**
 * Where the rider is at game time t. `stationXY` gives a station's local position (null if gone).
 * The state follows the last event at or before t; a walk or a car ride in progress moves along
 * its straight line.
 */
export function rideState(tr: TraceData, t: number, stationXY: (id: number) => [number, number] | null): RideState {
  const plan = tr.plan;
  const base = (kind: RideKind, e: TraceEvent | null, x: number, y: number, extra: Partial<RideState> = {}): RideState => ({
    kind,
    event: e,
    x,
    y,
    heading: 0,
    progress: 0,
    train: -1,
    station: -1,
    pm: false,
    since: e?.t ?? NaN,
    until: NaN,
    ...extra,
  });
  const home = (e: TraceEvent | null) => base('home', e, plan.home[0], plan.home[1]);
  const work = (e: TraceEvent | null, pm = false) => base('work', e, plan.work[0], plan.work[1], { pm });
  const i = lastEventAt(tr.events, t);
  const e = i >= 0 ? tr.events[i] : null;
  if (tr.ended && (!e || e.t <= t)) {
    const p = e ? positionAfter(tr.events, i, plan, stationXY) : plan.home;
    return base('ended', e, p[0], p[1]);
  }
  if (!e) return home(null);
  const at = (id: number, kind: RideKind, extra: Partial<RideState> = {}) => {
    const p = stationXY(id) ?? positionAfter(tr.events, i, plan, stationXY);
    return base(kind, e, p[0], p[1], { station: id, ...extra });
  };
  switch (e.k) {
    case 'day':
    case 'stuck':
    case 'regen':
      return home(e);
    case 'walk': {
      const w = walkAt(e.from, e.to, e.t, e.t1, t);
      if (w.f >= 1 && e.why === 'egress') return e.pm ? home(e) : work(e);
      return base('walk', e, w.x, w.y, { heading: headingOf(e.from[0], e.from[1], e.to[0], e.to[1]), progress: w.f, station: e.station, pm: e.pm, until: e.t1 });
    }
    case 'wait':
    case 'left':
    case 'giveup':
      return at(e.station, 'wait', { pm: tripIsPm(tr.events, i) });
    case 'closed':
      return at(e.station, 'wait', { until: e.until, pm: tripIsPm(tr.events, i) });
    case 'board':
    case 'switch':
    case 'held':
    case 'incident':
    case 'past': {
      const train = trainAt(tr.events, i);
      return at(e.station, 'ride', { train, pm: tripIsPm(tr.events, i) });
    }
    case 'alight':
    case 'across':
      return at(e.station, 'wait', { pm: tripIsPm(tr.events, i) });
    case 'drive':
    case 'cab': {
      const pm = e.k === 'drive' ? e.pm : tripIsPm(tr.events, i);
      const from = e.k === 'cab' ? positionAfter(tr.events, i - 1, plan, stationXY) : pm ? plan.work : plan.home;
      const to = pm ? plan.home : plan.work;
      const w = walkAt(from, to, e.t, e.t1, t);
      if (w.f >= 1) return pm ? home(e) : work(e);
      return base('car', e, w.x, w.y, { heading: headingOf(from[0], from[1], to[0], to[1]), progress: w.f, pm, until: e.t1 });
    }
    case 'arrive':
      return e.pm ? home(e) : work(e, false);
  }
}

/** The train ridden at event i: the last board or switch since the last alight (−1: none). */
function trainAt(events: readonly TraceEvent[], i: number): number {
  for (let j = i; j >= 0; j--) {
    const e = events[j];
    if (e.k === 'board' || e.k === 'switch') return e.train;
    if (e.k === 'alight' || e.k === 'arrive' || e.k === 'cab' || e.k === 'day') return -1;
  }
  return -1;
}

/** Is the trip in progress at event i the evening one? (From the last walk or drive that says.) */
function tripIsPm(events: readonly TraceEvent[], i: number): boolean {
  for (let j = i; j >= 0; j--) {
    const e = events[j];
    if (e.k === 'walk' || e.k === 'drive') return e.pm;
    if (e.k === 'arrive') return !e.pm;
    if (e.k === 'day') return false;
  }
  return false;
}

/** Where the rider was right after event i (for a cab's start, an ended story, an unknown station). */
function positionAfter(events: readonly TraceEvent[], i: number, plan: StoryPlan, stationXY: (id: number) => [number, number] | null): [number, number] {
  for (let j = i; j >= 0; j--) {
    const e = events[j];
    switch (e.k) {
      case 'walk':
        return [e.to[0], e.to[1]];
      case 'wait':
      case 'left':
      case 'giveup':
      case 'closed':
      case 'board':
      case 'switch':
      case 'alight':
      case 'across':
      case 'past':
      case 'held':
      case 'incident': {
        const p = stationXY(e.station);
        if (p) return p;
        break;
      }
      case 'arrive':
        return e.pm ? [plan.home[0], plan.home[1]] : [plan.work[0], plan.work[1]];
      case 'drive':
        return e.pm ? [plan.home[0], plan.home[1]] : [plan.work[0], plan.work[1]];
      case 'day':
      case 'stuck':
      case 'regen':
        return [plan.home[0], plan.home[1]];
      case 'cab':
        break;
    }
  }
  return [plan.home[0], plan.home[1]];
}

/** Today's events: everything since the last 'day' marker at or before t. */
export function todaysEvents(events: readonly TraceEvent[], t: number): TraceEvent[] {
  const i = lastEventAt(events, t);
  let s = 0;
  for (let j = Math.max(0, i); j >= 0; j--) {
    if (events[j]?.k === 'day') {
      s = j;
      break;
    }
  }
  return events.slice(s, Math.max(s, i + 1));
}
