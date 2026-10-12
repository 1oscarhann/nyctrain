/**
 * City chaos, end to end on real data (headless engine): station closures, event agents, the
 * determinism of a Wild run, snow on elevated track reaching the next day's choice, an incident's
 * life cycle, chaos Off being inert, a London venue event, and the browser's message order (a
 * network edit followed at once by a skip).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAOS_BY_CITY, TRAINS } from '../src/balance';
import { applyCity } from '../src/cities';
import { CLEAR, eventsForDay } from '../src/core/cityCalendar';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave } from '../src/save/serialize';
import type { Game } from '../src/core/game';
import { compileNetwork } from '../src/routes/compile';
import { SimClient } from '../src/sim/client';
import { Engine } from '../src/sim/engine';
import { buildTestNetwork, createHeadlessGame, drawLine, makeRoute, midtownArenaEvent, runDays, startEngine, stationNear, stepUntil, venueEvent } from '../src/sim/headless';
import type { Alert, DayChaosInfo, DayReport, FromWorker, ModeState, ToWorker } from '../src/sim/protocol';
import { TState, type Train } from '../src/sim/trainSim';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';

const H = 3600;
const D = 86400;

applyCity('nyc');
const world = loadWorldFromDisk();
const land = loadLandFromDisk();

afterAll(() => {
  applyCity('nyc');
});

/** Compiled station index a train is heading to or dwelling at. */
const stationOf = (e: Engine, tr: Train) => e.net!.routes[tr.route].dirs[tr.dir].stopStation[tr.stop];

describe('city chaos, headless (New York)', () => {
  beforeEach(() => {
    applyCity('nyc');
  });

  it('a police closure blocks boarding, runs trains through and sends riders on', () => {
    const game = createHeadlessGame(world, land);
    const { r1 } = buildTestNetwork(game);
    const penn = r1.stops[4];
    const alerts: Alert[] = [];
    const reports: DayReport[] = [];
    const engine = startEngine(game, { alert: (a) => alerts.push(a), reports });
    stepUntil(engine, D + 7.5 * H);
    const c = engine.commuters!;
    const si = engine.net!.stations.findIndex((s) => s.id === penn);
    const dwellingBefore = new Set(engine.trains.trains.filter((tr) => tr.state === TState.Dwelling && stationOf(engine, tr) === si).map((tr) => tr.id));
    const boarded = () => c.stationDetail(penn).hourlyToday.reduce((a: number, b: number) => a + b, 0);
    const t0 = engine.time;
    const id = engine.chaos.force({ kind: 'police', station: penn, duration: 1200 });
    expect(id).toBeGreaterThan(0);
    const b0 = boarded();
    expect(b0).toBeGreaterThan(0);
    for (let t = t0 + 60; t < t0 + 1200; t += 60) {
      stepUntil(engine, t);
      expect(boarded()).toBe(b0);
      expect(c.waitingByStation(engine.net!.stations.length)[si]).toBe(0);
      for (const tr of engine.trains.trains) if (tr.state === TState.Dwelling && stationOf(engine, tr) === si) expect(dwellingBefore.has(tr.id)).toBe(true);
    }
    expect(c.chaosStats().carriedPast).toBeGreaterThan(0);
    stepUntil(engine, t0 + 1200 + 20 * 60);
    expect(boarded()).toBeGreaterThan(b0);
    const mine = alerts.filter((a) => a.id === id);
    expect(mine.map((a) => a.status)).toEqual(['active', 'cleared']);
    expect(mine[0]).toMatchObject({ kind: 'police', stationId: penn, until: t0 + 1200, severity: 3 });
    expect(Math.abs(mine[1].until - (t0 + 1200))).toBeLessThanOrEqual(2);
    stepUntil(engine, 2 * D + 60);
    const r = reports.find((x) => x.day === 1)!;
    expect(r.chaos!.diverted + r.chaos!.carriedPast).toBeGreaterThan(0);
    expect(r.chaos!.incidents.police).toBe(1);
    expect(r.deadlocks).toBe(0);
  }, 120_000);

  it('injects event agents for the day and removes them at the next 3 am', () => {
    const setup = (withEvent: boolean) => {
      const game = createHeadlessGame(world, land, { chaos: 'normal' });
      buildTestNetwork(game);
      const infos: DayChaosInfo[] = [];
      const reports: DayReport[] = [];
      const alerts: Alert[] = [];
      const engine = startEngine(game, { dayChaos: (i) => infos.push(i), alert: (a) => alerts.push(a), reports });
      engine.chaos.forceEvents(1, withEvent ? [midtownArenaEvent(1, 18_000, 19.5)] : []);
      engine.chaos.forceEvents(2, []);
      engine.chaos.forceWeather(1, CLEAR);
      return { engine, infos, reports, alerts };
    };
    const a = setup(true);
    const c = a.engine.commuters!;
    stepUntil(a.engine, D + 3 * H + 60);
    expect(c.eventAgentCount()).toBeGreaterThan(300);
    const ev = a.infos.find((i) => i.day === 1)!.events[0];
    expect(ev.label).toBe('Midtown arena concert');
    expect(ev.byTransit).toBeGreaterThan(0);
    expect(Math.abs(ev.byTransit + ev.byDrive + ev.byWalk - 18_000)).toBeLessThanOrEqual(c.scale);
    stepUntil(a.engine, 2 * D - 60);
    const out = c.eventOutcomes()[0];
    expect(out.arrived).toBeGreaterThan(0);
    expect(out.avgTripMin).toBeGreaterThan(5);
    stepUntil(a.engine, 2 * D + 3 * H + 60);
    const day1 = a.reports.find((r) => r.day === 1)!;
    expect(day1.chaos!.eventRiders).toBeGreaterThan(0);
    expect(day1.chaos!.events).toHaveLength(1);
    // The wrap-up went out, with the outcome.
    const wrap = a.alerts.find((x) => x.kind === 'event' && x.eventId === ev.id)!;
    expect(wrap.outcome!.arrived).toBe(day1.chaos!.events[0].arrived);
    // Next day: the pool is empty and nobody was left mid-trip.
    expect(c.eventAgentCount()).toBe(0);
    expect(c.eventInFlight()).toBe(0);
    expect(c.stuckCount()).toBe(0);
    // The fans rode: more riders than the same day without the event.
    const b = setup(false);
    stepUntil(b.engine, 2 * D + 60);
    expect(day1.riders).toBeGreaterThan(b.reports.find((r) => r.day === 1)!.riders);
  }, 180_000);

  it('is deterministic: two Wild runs on the same seed match exactly', () => {
    const go = () => {
      const game = createHeadlessGame(world, land, { chaos: 'wild', chaosSeed: 42 });
      buildTestNetwork(game);
      const alerts: Alert[] = [];
      const run = runDays(game, 2, { alert: (a) => alerts.push(a) });
      return { reports: run.reports, alerts };
    };
    const x = go();
    const y = go();
    expect(JSON.stringify(x.reports)).toBe(JSON.stringify(y.reports));
    expect(x.alerts).toEqual(y.alerts);
    expect(x.alerts.filter((a) => a.status === 'active').length).toBeGreaterThan(5);
    for (const r of x.reports) expect(r.deadlocks).toBe(0);
  }, 180_000);

  it('snow slows elevated trains, and the slower trips reach the next day', () => {
    const build = () => {
      const game = createHeadlessGame(world, land, { sandbox: true });
      drawLine(game, [[-73.81, 40.7], [-73.76, 40.725], [-73.725, 40.745]], 'elevated');
      const el = [
        stationNear(game, [-73.805, 40.7025], 'Jamaica'),
        stationNear(game, [-73.79, 40.71], 'Hillside'),
        stationNear(game, [-73.775, 40.7175], 'Hollis'),
        stationNear(game, [-73.758, 40.7262], 'Bellerose Jct'),
        stationNear(game, [-73.742, 40.735], 'Little Neck Pkwy'),
        stationNear(game, [-73.728, 40.743], 'Glen Oaks'),
      ];
      drawLine(game, [[-74.0134, 40.7046], [-74.0045, 40.714], [-73.993, 40.7285]], 'deep');
      const deep = [stationNear(game, [-74.0125, 40.7062], 'Bowling Green'), stationNear(game, [-74.0068, 40.7112], 'Fulton St'), stationNear(game, [-74.0, 40.7195], 'Canal St')];
      expect(game.build(true).ok).toBe(true);
      const E = makeRoute(game, 'Jamaica El', 'E', '#9BA4AE', el, 8, { am: 2.5, pm: 2.5, midday: 5 });
      const L = makeRoute(game, 'Downtown', 'L', '#2F7FE0', deep, 8, { am: 4, pm: 4 });
      return { game, E, L };
    };
    // Outdoor stretches from the compiler: the elevated line is outdoors, the deep one isn't.
    {
      const { game, E, L } = build();
      const net = compileNetwork(game).net;
      const re = net.routes.find((r) => r.id === E.id)!;
      for (const d of re.dirs) {
        let out = 0;
        for (let i = 0; i < d.outS0!.length; i++) out += d.outS1![i] - d.outS0![i];
        expect(out / d.length).toBeGreaterThanOrEqual(0.95);
      }
      for (const d of net.routes.find((r) => r.id === L.id)!.dirs) expect(d.outS0!.length).toBe(0);
    }
    const sim = (snow: boolean) => {
      const { game, E } = build();
      const reports: DayReport[] = [];
      const engine = startEngine(game, { reports });
      if (snow) engine.chaos.forceWeather(1, { kind: 'snow', severity: 1, carried: false });
      const ri = engine.net!.routes.findIndex((r) => r.id === E.id);
      let vmax = 0;
      stepUntil(engine, D + 5 * H);
      while (engine.time < 2 * D - 2 * H) {
        engine.step();
        for (const tr of engine.trains.trains) if (tr.route === ri && tr.state === TState.Running) vmax = Math.max(vmax, tr.v);
      }
      stepUntil(engine, 2 * D + 60);
      return { day1: reports.find((r) => r.day === 1)!, vmax, obs: engine.commuters!.obsTime.slice(), E };
    };
    const clear = sim(false);
    const snow = sim(true);
    expect(snow.day1.chaos!.weather.kind).toBe('snow');
    expect(snow.day1.routeLateness[snow.E.id]).toBeGreaterThanOrEqual(clear.day1.routeLateness[clear.E.id] + 60);
    expect(snow.vmax).toBeLessThanOrEqual(0.55 * TRAINS.heavy.topSpeed + 0.05);
    expect(clear.vmax).toBeGreaterThan(0.7 * TRAINS.heavy.topSpeed);
    // The snow day's slower door-to-door times are tomorrow's observations.
    let s = 0, k = 0, n = 0;
    for (let g = 0; g < snow.obs.length; g++) {
      if (snow.obs[g] > 0 && clear.obs[g] > 0) {
        s += snow.obs[g];
        k += clear.obs[g];
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(s / n).toBeGreaterThan(k / n);
    // The fair baseline: a snow day's no-subway commute is longer.
    expect(snow.day1.baselineCommute).toBeGreaterThan(clear.day1.baselineCommute);
    expect(snow.day1.deadlocks).toBe(0);
  }, 180_000);

  it('a breakdown stalls one train, clears on time and leaves no deadlock', () => {
    const game = createHeadlessGame(world, land);
    const { r1 } = buildTestNetwork(game);
    const alerts: Alert[] = [];
    const reports: DayReport[] = [];
    const engine = startEngine(game, { alert: (a) => alerts.push(a), reports });
    stepUntil(engine, D + 8 * H);
    const tr = engine.trains.trains.find((x) => x.routeId === r1.id && x.state === TState.Running)!;
    const t0 = engine.time;
    const id = engine.chaos.force({ kind: 'breakdown', train: tr.id, duration: 600 });
    const started = alerts.filter((a) => a.id === id);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ kind: 'breakdown', status: 'active', trainId: tr.id, until: t0 + 600, routes: [r1.id] });
    expect(started[0].place).toMatch(/^between /);
    stepUntil(engine, t0 + 60);
    const s0 = tr.s;
    while (engine.time < t0 + 590) {
      engine.step();
      expect(Math.abs(tr.s - s0)).toBeLessThan(1);
    }
    stepUntil(engine, t0 + 602);
    const cleared = alerts.filter((a) => a.id === id && a.status === 'cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].until).toBeGreaterThanOrEqual(t0 + 600);
    let moved = false;
    while (engine.time < t0 + 720) {
      engine.step();
      if (Math.abs(tr.s - s0) > 1 || tr.state !== TState.Running) moved = true;
    }
    expect(moved).toBe(true);
    stepUntil(engine, 2 * D + 3 * H + 60);
    expect(reports.find((r) => r.day === 1)!.deadlocks).toBe(0);
    expect(reports.find((r) => r.day === 1)!.chaos!.incidents.breakdown).toBe(1);
    expect(engine.commuters!.stuckCount()).toBe(0);
  }, 120_000);

  it('chaos Off is inert: no alerts, no events, clear weather, and the seed does not matter', () => {
    const go = (seed: number) => {
      const game = createHeadlessGame(world, land, { chaos: 'off', chaosSeed: seed });
      buildTestNetwork(game);
      const alerts: Alert[] = [];
      const infos: DayChaosInfo[] = [];
      const run = runDays(game, 2, { alert: (a) => alerts.push(a), dayChaos: (i) => infos.push(i) });
      return { run, alerts, infos };
    };
    const a = go(1);
    const b = go(987_654);
    expect(a.alerts).toEqual([]);
    for (const r of a.run.reports) {
      expect(Object.values(r.chaos!.incidents).every((n) => n === 0)).toBe(true);
      expect(r.chaos!.events).toEqual([]);
      expect(r.chaos!.weather).toEqual(CLEAR);
      expect(r.chaos!.diverted + r.chaos!.carriedPast + r.chaos!.eventRiders).toBe(0);
    }
    for (const i of a.infos) expect(i).toMatchObject({ level: 'off', weather: CLEAR, events: [] });
    expect(a.run.engine.commuters!.eventAgentCount()).toBe(0);
    expect(JSON.stringify(a.run.reports)).toBe(JSON.stringify(b.run.reports));
    expect(a.run.reports[1].riders).toBeGreaterThan(0);
  }, 180_000);

  /** Save the game at the engine's time and load it into a fresh game, through the real save code. */
  const saveAndLoad = (game: Game, engine: Engine) => {
    game.time = engine.time;
    const settings = { units: 'imperial' as const, agentScale: 10, seed: 1885 };
    const file = buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: engine.commuters!.modeState() });
    const loaded = createHeadlessGame(world, land);
    const r = applySave(loaded, migrate(JSON.parse(JSON.stringify(file))));
    return { loaded, modeState: r.modeState };
  };

  it("a mid-day load keeps today as planned at 3 am, after a level change and an edit since then", () => {
    const seed = 2030;
    // A day whose events differ between Normal and Wild, so a load at the wrong level shows.
    const ids = (lv: 'normal' | 'wild', d: number) => eventsForDay(seed, d, lv).map((e) => e.id).join();
    let day = 1;
    while (ids('normal', day) === ids('wild', day)) day++;
    const game = createHeadlessGame(world, land, { chaos: 'normal', chaosSeed: seed });
    const { r1 } = buildTestNetwork(game);
    game.time = day * D + 2 * H;
    const infoA: DayChaosInfo[] = [];
    const a = startEngine(game, { dayChaos: (i) => infoA.push(i) });
    stepUntil(a, day * D + 9 * H);
    // An edit after 3 am (more midday trains: more train-km), then Wild from the next 3 am.
    game.routes.update(r1.id, { headways: { ...game.routes.get(r1.id)!.headways, midday: 4 } });
    a.setNetwork(compileNetwork(game).net);
    stepUntil(a, day * D + 10 * H);
    game.setChaosLevel('wild');
    a.setChaosLevel('wild');
    const { loaded, modeState } = saveAndLoad(game, a);
    expect(loaded.chaos).toMatchObject({ level: 'wild', levelToday: 'normal', dayExposure: { day } });
    const infoB: DayChaosInfo[] = [];
    const b = startEngine(loaded, { modeState, dayChaos: (i) => infoB.push(i) });
    a.step();
    b.step();
    // The rest of today: Normal, the same weather, events, fans and incidents still to come.
    expect(b.chaos.level).toBe('normal');
    expect(b.chaos.state().nextLevel).toBe('wild');
    expect(b.chaos.todayWeather().weather).toEqual(a.chaos.todayWeather().weather);
    expect(infoB.at(-1)!.events.map((e) => e.id)).toEqual(infoA.at(-1)!.events.map((e) => e.id));
    expect(b.commuters!.eventAgentCount()).toBe(a.commuters!.eventAgentCount());
    expect(b.chaos.remainingPlan()).toEqual(a.chaos.remainingPlan());
    // Wild from the next 3 am, in both.
    stepUntil(a, (day + 1) * D + 3 * H + 60);
    stepUntil(b, (day + 1) * D + 3 * H + 60);
    expect([a.chaos.level, b.chaos.level]).toEqual(['wild', 'wild']);
    expect(b.chaos.remainingPlan()).toEqual(a.chaos.remainingPlan());
  }, 180_000);

  it('a load during an event keeps its outcome, and a load after its wrap-up does not post it again', () => {
    const game = createHeadlessGame(world, land, { chaos: 'normal' });
    buildTestNetwork(game);
    // 13:00–16:00 at the Midtown arena (by the test line); the wrap-up goes out at 18:00.
    const ev = midtownArenaEvent(1, 12_000, 13);
    const wrapAt = D + ev.end + 2 * H;
    const run = (from: number, modeState?: ModeState, stops: number[] = []) => {
      game.time = from;
      const alerts: Alert[] = [];
      const reports: DayReport[] = [];
      const e = startEngine(game, { alert: (x) => alerts.push(x), reports, modeState });
      e.chaos.forceEvents(1, [ev]);
      e.chaos.forceWeather(1, CLEAR);
      const states = stops.map((t) => {
        stepUntil(e, t);
        return e.commuters!.modeState();
      });
      stepUntil(e, 2 * D + 60);
      const wraps = alerts.filter((x) => x.kind === 'event' && x.eventId === ev.id);
      return { states, wraps, outcome: reports.find((r) => r.day === 1)!.chaos!.events.find((o) => o.id === ev.id)! };
    };
    const midEvent = D + 14.5 * H, afterWrap = wrapAt + 1800;
    const a = run(D + 2 * H, undefined, [midEvent, afterWrap]);
    expect(a.outcome.arrived).toBeGreaterThan(1000);
    expect(a.wraps).toHaveLength(1);
    // Loaded mid-event: the fans already at the venue count as arrived, with a trip time.
    const b = run(midEvent, a.states[0]);
    expect(b.outcome.byTransit).toBe(a.outcome.byTransit);
    expect(b.outcome.arrived).toBe(a.outcome.arrived);
    expect(b.outcome.avgTripMin).toBeGreaterThan(a.outcome.avgTripMin * 0.6);
    expect(b.wraps).toHaveLength(1);
    expect(b.wraps[0].outcome!.arrived).toBe(a.outcome.arrived);
    // Loaded after the wrap-up went out: it isn't posted again, and the day's report still has the outcome.
    const c = run(afterWrap, a.states[1]);
    expect(c.wraps).toEqual([]);
    expect(c.outcome.arrived).toBe(a.outcome.arrived);
  }, 180_000);
});

describe('city chaos, headless (London)', () => {
  it('fills a Greenwich arena concert from a line to North Greenwich, with London venues on the calendar', () => {
    applyCity('london');
    const lw = loadWorldFromDisk();
    const game: Game = createHeadlessGame(lw, loadLandFromDisk(), { sandbox: true, chaos: 'normal' });
    drawLine(game, [[-0.1132, 51.5032], [-0.0865, 51.505], [-0.0638, 51.498], [-0.0497, 51.4982], [-0.0195, 51.5035], [0.005, 51.5005]], 'deep');
    const stops = [
      stationNear(game, [-0.1132, 51.5032], 'Waterloo'),
      stationNear(game, [-0.0865, 51.505], 'London Bridge'),
      stationNear(game, [-0.0497, 51.4982], 'Canada Water'),
      stationNear(game, [-0.0195, 51.5035], 'Canary Wharf'),
      stationNear(game, [0.0045, 51.5007], 'North Greenwich'),
    ];
    expect(game.build(true).ok).toBe(true);
    makeRoute(game, 'Jubilee', 'J', '#9BA4AE', stops, 8, { am: 3, pm: 3, evening: 4 });
    const infos: DayChaosInfo[] = [];
    const alerts: Alert[] = [];
    const reports: DayReport[] = [];
    const engine = startEngine(game, { dayChaos: (i) => infos.push(i), alert: (a) => alerts.push(a), reports });
    const ev = venueEvent('greenwich-arena', 1, 18_000, 20);
    expect(ev.label).toBe('Greenwich arena concert');
    engine.chaos.forceEvents(1, [ev]);
    engine.chaos.forceEvents(2, []);
    engine.chaos.forceWeather(1, CLEAR);
    const c = engine.commuters!;
    stepUntil(engine, D + 3 * H + 60);
    const info = infos.find((i) => i.day === 1)!.events[0];
    expect(info.label).toBe('Greenwich arena concert');
    expect(info.byTransit).toBeGreaterThan(0);
    expect(Math.abs(info.byTransit + info.byDrive + info.byWalk - 18_000)).toBeLessThanOrEqual(c.scale);
    expect(c.eventAgentCount()).toBeGreaterThan(50);
    stepUntil(engine, 2 * D + 3 * H + 60);
    const day1 = reports.find((r) => r.day === 1)!;
    expect(day1.chaos!.events[0].arrived).toBeGreaterThan(0);
    expect(day1.chaos!.eventRiders).toBeGreaterThan(0);
    const wrap = alerts.find((a) => a.kind === 'event' && a.eventId === ev.id)!;
    expect(wrap.place).toBe('Greenwich peninsula arena');
    expect(c.eventAgentCount()).toBe(0);
    expect(c.eventInFlight()).toBe(0);
    expect(c.stuckCount()).toBe(0);
    for (const r of reports) expect(r.deadlocks).toBe(0);
    // Day 0's events (from the calendar) are London's.
    const londonLabels = new Set(CHAOS_BY_CITY.london.kinds.map((k) => k.label));
    for (const i of infos) for (const e of i.events) expect(londonLabels.has(e.label)).toBe(true);
  }, 180_000);
});

/**
 * The worker, in process: each message is applied to a real Engine in arrival order, as
 * src/sim/worker.ts does (only the messages these tests send).
 */
class InProcessWorker {
  static last: InProcessWorker | null = null;
  onmessage: ((e: { data: FromWorker }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  engine: Engine | null = null;
  readonly received: ToWorker['type'][] = [];
  readonly infos: DayChaosInfo[] = [];
  constructor() {
    InProcessWorker.last = this;
  }
  private post(m: FromWorker) {
    this.onmessage?.({ data: m });
  }
  postMessage(m: ToWorker) {
    this.received.push(m.type);
    switch (m.type) {
      case 'init':
        this.engine = new Engine(world, { agentScale: m.agentScale, seed: m.seed, time: m.time, fare: m.fare, chaos: m.chaos, service: m.service }, {
          alert: (alert) => this.post({ type: 'alert', alert }),
          dayChaos: (info) => {
            this.infos.push(info);
            this.post({ type: 'dayChaos', info });
          },
        });
        break;
      case 'network':
        this.engine!.setNetwork(m.net);
        break;
      case 'skipTo':
        if (!this.engine) break;
        this.post({ type: 'busy', label: 'Skipping ahead' });
        this.engine!.skipTo(m.time);
        this.post({ type: 'busy', label: null });
        this.post({ type: 'snapshot', snap: this.engine!.snapshot(0) });
        break;
      case 'chaosLevel':
        this.engine!.setChaosLevel(m.level);
        break;
      case 'service':
        this.engine!.setService(m.overrides);
        break;
      case 'speed':
      case 'fare':
      case 'query':
        break;
    }
  }
  terminate() {}
}

describe('city chaos, browser message order (New York)', () => {
  beforeEach(() => {
    applyCity('nyc');
  });

  // Regression: in the browser a network edit reached the worker 200 ms after the skip that
  // followed it (the edit debounce), so the night and the 3 am mode choice ran with no network:
  // on day 1 nobody rode, and the Midtown arena game got 0 fans by subway.
  it('a network edit followed at once by a skip reaches the worker first, so day 1 has riders and fans', () => {
    const g = globalThis as unknown as { Worker?: unknown; document?: unknown };
    const saved = { Worker: g.Worker, document: g.document };
    g.Worker = InProcessWorker;
    g.document = { baseURI: 'http://localhost/' };
    try {
      // One of the seeds that failed in the browser: a Midtown arena game on days 0 and 1 at Wild.
      const seed = 4224591899;
      expect(eventsForDay(seed, 1, 'wild').map((e) => e.label)).toEqual(['Midtown arena game']);
      const game = createHeadlessGame(world, land, { sandbox: true, chaos: 'normal', chaosSeed: seed });
      const client = new SimClient();
      const host = InProcessWorker.last!;
      // As the App does: init at 05:00 on day 0, then the player sets Wild and builds a network.
      client.init({ agentScale: 10, seed: 1885, time: game.time, fare: game.fare, chaos: { level: game.chaos.level, seed }, service: [] });
      client.setChaosLevel('wild');
      buildTestNetwork(game, { r1: 3, r2: 4 });
      client.setNetworkSoon(() => client.setNetwork(compileNetwork(game).net));
      // ...and skips straight away (before the debounce fires).
      client.skipTo(D + 17.5 * H);
      expect(host.received.indexOf('network')).toBeGreaterThan(-1);
      expect(host.received.indexOf('network')).toBeLessThan(host.received.indexOf('skipTo'));
      expect(client.latest!.time).toBeGreaterThanOrEqual(D + 17.5 * H - 2);
      expect(client.skipping).toBe(false);
      // Regular commuters rode on day 1, and the game's fans came by subway.
      expect(client.latest!.live.ridersToday).toBeGreaterThan(100_000);
      expect(client.latest!.live.tripsInProgress).toBeGreaterThan(1000);
      const day1 = host.infos.find((i) => i.day === 1)!;
      expect(day1.level).toBe('wild');
      expect(day1.events.map((e) => e.label)).toEqual(['Midtown arena game']);
      expect(day1.events[0].byTransit).toBeGreaterThan(1000);
      // A flushed edit is sent once: nothing is left to fire later.
      client.flushNetwork();
      expect(host.received.filter((t) => t === 'network')).toHaveLength(1);
      client.terminate();
    } finally {
      g.Worker = saved.Worker;
      g.document = saved.document;
    }
  }, 120_000);

  it('coalesces a burst of edits into one compile, sent before a speed change', () => {
    const g = globalThis as unknown as { Worker?: unknown; document?: unknown };
    const saved = g.Worker;
    g.Worker = InProcessWorker;
    try {
      const client = new SimClient();
      const host = InProcessWorker.last!;
      let builds = 0;
      for (let i = 0; i < 5; i++) client.setNetworkSoon(() => builds++);
      client.setSpeed(60);
      expect(builds).toBe(1);
      client.setSpeed(0);
      client.skipTo(D);
      expect(builds).toBe(1);
      expect(host.received).toEqual(['speed', 'speed', 'skipTo']);
      client.terminate();
    } finally {
      g.Worker = saved;
    }
  });
});
