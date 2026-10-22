/**
 * Commuter stories (v2, docs/v2/commuter-stories.md), in the worker: the trace of one agent and
 * the commuter-of-the-day candidates. Both only record: Commuters calls in from guarded hooks
 * (`a === traceA`, `daily !== null`) after the sim has done its work, and nothing here draws a
 * random number, schedules an event or writes a field the sim reads.
 */
import { STORIES } from '../balance';
import type { Commuters } from './commuters';
import type { DayStories, DayStory, StoryLive, StoryPick, StoryPlan, StoryWho, TraceData, TraceEvent } from './protocol';
import type { Train, TrainSim } from './trainSim';

/** What Commuters' hooks call on the traced agent's recorder. */
export interface TraceSink {
  /** A step of the trip; `train` is the train boarded (board, switch). */
  add(e: TraceEvent, train?: Train | null): void;
  /** 3 am: today's mode and plan. */
  newDay(t: number, plan: StoryPlan): void;
  /** The plan changed (a new network, or the agent found again after a regeneration). */
  setPlan(plan: StoryPlan): void;
  /** The agent is gone (moved away at a month close, or an event-goer's day is over). */
  ended(why: 'moved' | 'eventOver'): void;
}

/** One agent's story: picks, the recorded events and the live state for snapshots. */
export class StoryTracer implements TraceSink {
  private seq = 0;
  private data: TraceData | null = null;
  private sent = -1;
  /** The train the agent rides (polled for holds and incidents), and what the last poll saw. */
  private train: Train | null = null;
  private held = false;
  private incident = 0;

  constructor(
    private readonly c: Commuters,
    private readonly trains: TrainSim,
  ) {}

  /** A story is open (an ended one too, until stop). */
  get open(): boolean {
    return this.data !== null;
  }

  /** Someone is being traced right now (hooks fire). */
  get tracing(): boolean {
    return this.c.traceA >= 0 && this.c.tracer === this;
  }

  /** Pick an agent and trace them (the old story ends); null: nobody fits, the old story goes on. */
  pick(pick: StoryPick, t: number): TraceData | null {
    const a = this.c.storyPick(pick, t);
    if (a < 0) return null;
    this.start(a, t);
    return this.copy();
  }

  /** Trace agent `a` from now (where they already are becomes the first event). */
  start(a: number, t: number): void {
    const c = this.c;
    this.detach();
    const join = c.storyJoin(a, t);
    this.data = { id: ++this.seq, version: 0, who: c.storyWho(a), plan: c.storyPlan(a, t), events: [{ k: 'day', t, day: Math.floor(t / 86400) }, ...join.events], ended: null, train: join.train?.id ?? -1 };
    this.train = join.train;
    this.held = join.train ? this.trains.isHeld(join.train) : false;
    this.incident = join.train?.incident ?? 0;
    this.sent = -1;
    c.traceA = a;
    c.tracer = this;
  }

  /** End the story (nobody is traced). */
  stop(): void {
    this.detach();
    this.data = null;
    this.sent = -1;
  }

  private detach(): void {
    if (this.c.tracer === this) {
      this.c.traceA = -1;
      this.c.tracer = null;
    }
    this.train = null;
    this.held = false;
    this.incident = 0;
  }

  // ------------------------------------------------------------------ TraceSink
  add(e: TraceEvent, train?: Train | null): void {
    const d = this.data;
    if (!d) return;
    // Chronological: a cab's arrival is recorded ahead of time, so insert in order.
    const ev = d.events;
    let i = ev.length;
    while (i > 0 && ev[i - 1].t > e.t) i--;
    ev.splice(i, 0, e);
    if (ev.length > STORIES.maxEvents) ev.splice(0, ev.length - STORIES.maxEvents);
    if (e.k === 'board' || e.k === 'switch') {
      this.train = train ?? null;
      this.held = false;
      this.incident = train?.incident ?? 0;
      d.train = train ? train.id : -1;
    } else if (e.k === 'alight' || e.k === 'cab' || e.k === 'arrive' || e.k === 'stuck' || e.k === 'regen') {
      this.train = null;
      d.train = -1;
    }
    d.version++;
  }

  newDay(t: number, plan: StoryPlan): void {
    const d = this.data;
    if (!d) return;
    // Keep yesterday and today: drop everything before the previous day's marker.
    let marks = 0;
    for (let i = d.events.length - 1; i >= 0; i--) {
      if (d.events[i].k !== 'day') continue;
      if (++marks === 1) continue;
      d.events.splice(0, i);
      break;
    }
    d.plan = plan;
    this.add({ k: 'day', t, day: plan.day });
  }

  setPlan(plan: StoryPlan): void {
    const d = this.data;
    if (!d) return;
    d.plan = plan;
    d.version++;
  }

  ended(why: 'moved' | 'eventOver'): void {
    const d = this.data;
    if (!d) return;
    d.ended = why;
    d.train = -1;
    d.version++;
    this.train = null;
  }

  // ------------------------------------------------------------------ per step and snapshots
  /** Once per sim step while someone is traced: their train's timepoint holds and incidents. */
  poll(t: number): void {
    const tr = this.train;
    if (!tr || !this.data || this.c.traceA < 0) return;
    const net = this.trains.net;
    const r = net?.routes[tr.route];
    const dir = r?.dirs[tr.dir];
    const here = () => (net && dir ? net.stations[dir.stopStation[Math.min(tr.stop, dir.stopStation.length - 1)]]?.id ?? -1 : -1);
    const held = this.trains.isHeld(tr);
    if (held && !this.held) this.add({ k: 'held', t, station: here() });
    this.held = held;
    const inc = tr.incident;
    if (inc && inc !== this.incident) {
      const stalled = tr.holdUntil > t;
      this.add({ k: 'incident', t, kind: stalled ? 'stalled' : 'sick', until: stalled ? tr.holdUntil : 0, station: here() });
    }
    this.incident = inc;
  }

  /** For a snapshot: the trace id and version, and the whole trace when it changed (undefined: no story). */
  live(): StoryLive | undefined {
    const d = this.data;
    if (!d) return undefined;
    if (d.version === this.sent) return { id: d.id, version: d.version };
    this.sent = d.version;
    return { id: d.id, version: d.version, data: { ...d, events: d.events.slice() } };
  }

  /** The trace as it is now (a copy: the recorder keeps appending). */
  copy(): TraceData | null {
    const d = this.data;
    return d ? { ...d, events: d.events.slice() } : null;
  }
}

// ---------------------------------------------------------------------------
// Commuter of the day

type Cat = DayStory['cat'];

interface Cand {
  a: number;
  value: number;
  t0: number;
  t1: number;
  pm: boolean;
  legs: number[];
  extra: Partial<DayStory>;
}

/**
 * The day's best candidate per category, kept by Commuters' hooks (one compare against the best
 * value before anything else): saved (against the faster of walking and driving), the longest wait
 * before boarding, the longest trip to an event, and a cross-platform changer's time saved.
 */
export class DailyPicks {
  /** Per agent: changed trains across a platform on this trip (cleared when a trip starts). */
  crossed: Uint8Array;
  savedBest = 0;
  waitBest = 0;
  fanBest = 0;
  crossBest = 0;
  private best: Partial<Record<Cat, Cand>> = {};

  constructor(agents: number) {
    this.crossed = new Uint8Array(agents);
  }

  /** A regeneration renumbers the agents: room for this many, and the day's candidates (old indices) go. */
  resize(agents: number): void {
    this.crossed = new Uint8Array(agents);
    this.best = {};
    this.savedBest = this.waitBest = this.fanBest = this.crossBest = 0;
  }

  offer(cat: Cat, a: number, value: number, t0: number, t1: number, pm: boolean, legs: number[], extra: Partial<DayStory> = {}): void {
    this.best[cat] = { a, value, t0, t1, pm, legs, extra };
    if (cat === 'saved') this.savedBest = value;
    else if (cat === 'fan') this.fanBest = value;
    else if (cat === 'cross') this.crossBest = value;
    else this.waitBest = value;
  }

  offerWait(a: number, waited: number, t: number, station: number, route: number, left: boolean): void {
    this.offer('wait', a, waited, t - waited, t, false, [], { station, route, left });
  }

  /** Midnight: the day's stories (identities resolved now, before any regeneration), then a fresh day. */
  finish(day: number, whoOf: (a: number) => StoryWho): DayStories {
    const stories: DayStory[] = [];
    for (const cat of ['saved', 'wait', 'fan', 'cross'] as const) {
      const c = this.best[cat];
      if (!c) continue;
      stories.push({ cat, who: whoOf(c.a), value: c.value, t0: c.t0, t1: c.t1, pm: c.pm, legs: c.legs, ...c.extra });
    }
    this.best = {};
    this.savedBest = this.waitBest = this.fanBest = this.crossBest = 0;
    return { day, stories };
  }
}
