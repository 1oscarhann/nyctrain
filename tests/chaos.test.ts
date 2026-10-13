/**
 * City chaos (events, disruptions, weather), unit level: seeded streams, the event calendar and
 * weather for both cities, mode choice under weather, incident planning, the train-sim hooks on a
 * hand-built line, event trips, and save v3. No world data.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CHAOS, CHAOS_BY_CITY, CITY_BALANCE, ECONOMY, EVENTS, OPERATIONS, WEATHER, type IncidentKind } from '../src/balance';
import { applyCity, CITIES } from '../src/cities';
import { dateOfDay } from '../src/core/calendar';
import {
  announcedEvents,
  CLEAR,
  CLEAR_MODS,
  eventsForDay,
  forecastFor,
  weatherForDay,
  weatherLabel,
  weatherMods,
} from '../src/core/cityCalendar';
import { Game } from '../src/core/game';
import { hashSeed, pickWeighted, poisson, Rng, stochasticRound, triangular } from '../src/core/rng';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { defaultWindows, routesNearVenue, serviceEstimate } from '../src/routes/eventService';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave, sanitizeChaos } from '../src/save/serialize';
import { SAVE_VERSION } from '../src/save/format';
import type { GroupPath } from '../src/sim/commuters';
import { checkKinds, eventCosts, reverseLegs, sampleCdf } from '../src/sim/eventTrips';
import { INCIDENT_KINDS, planIncidents, type Exposure } from '../src/sim/incidents';
import { CLEAR_WX, driveTripTime, generalisedCosts, logitShares, moneyToMinutes, walkTime, type PairGeometry } from '../src/sim/modeChoice';
import type { CompiledNetwork, CRoute, CRouteDir } from '../src/sim/protocol';
import { TrainSim, TState, type PassengerHooks, type Train } from '../src/sim/trainSim';
import { runProfile } from '../src/trains/kinematics';

const NYC = CHAOS_BY_CITY.nyc;
const LONDON = CHAOS_BY_CITY.london;
const month = (d: number) => dateOfDay(d).getUTCMonth();
const dom = (d: number) => dateOfDay(d).getUTCDate();
const dow = (d: number) => dateOfDay(d).getUTCDay();

afterAll(() => {
  applyCity('nyc');
});

// ---------------------------------------------------------------------------
describe('seeded streams', () => {
  it('hashSeed is stable and never 0; poisson, triangular and stochasticRound have the right means', () => {
    expect(hashSeed(1, 2, 3)).toBe(hashSeed(1, 2, 3));
    expect(hashSeed(1, 2, 3)).not.toBe(hashSeed(1, 2, 4));
    const r = new Rng(99);
    for (let i = 0; i < 10_000; i++) expect(hashSeed(r.int(1e9), r.int(1e9) - 5e8, r.int(1000), r.int(4))).not.toBe(0);
    const mean = (f: () => number, n: number) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += f();
      return s / n;
    };
    const rng = new Rng(7);
    expect(Math.abs(mean(() => poisson(rng, 3.7), 20_000) / 3.7 - 1)).toBeLessThan(0.03);
    expect(Math.abs(mean(() => poisson(rng, 60), 20_000) / 60 - 1)).toBeLessThan(0.02);
    expect(poisson(rng, 0)).toBe(0);
    let lo = Infinity, hi = -Infinity;
    const tri = mean(() => {
      const x = triangular(rng, -90, 30);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      return x;
    }, 20_000);
    expect(lo).toBeGreaterThanOrEqual(-90);
    expect(hi).toBeLessThanOrEqual(30);
    expect(Math.abs(tri - -30)).toBeLessThan(1);
    expect(Math.abs(mean(() => stochasticRound(rng, 2.3), 20_000) - 2.3)).toBeLessThan(0.02);
    expect(pickWeighted([[19, 0.7], [13, 0.3]], 0.69)).toBe(19);
    expect(pickWeighted([[19, 0.7], [13, 0.3]], 0.71)).toBe(13);
  });
});

// ---------------------------------------------------------------------------
describe('event calendar (New York)', () => {
  const kindOf = (label: string) => NYC.kinds.find((k) => k.label === label)!;

  it('is deterministic, unique by id and at most one event per venue per day', () => {
    expect(eventsForDay(7, 120, 'normal', NYC)).toEqual(eventsForDay(7, 120, 'normal', NYC));
    let differs = false;
    for (let d = 0; d < 30; d++) if (JSON.stringify(eventsForDay(7, d, 'normal', NYC)) !== JSON.stringify(eventsForDay(8, d, 'normal', NYC))) differs = true;
    expect(differs).toBe(true);
    for (let d = 0; d < 300; d++) {
      const evs = eventsForDay(7, d, 'normal', NYC);
      expect(new Set(evs.map((e) => e.venue)).size).toBe(evs.length);
      for (const e of evs) expect(e.id).toBe(d * 16 + e.venue);
    }
  });

  it('is the same across separate module instances (main thread and worker)', async () => {
    vi.resetModules();
    const fresh = await import('../src/core/cityCalendar');
    for (let d = 0; d < 60; d++) expect(fresh.eventsForDay(31, d, 'wild', NYC)).toEqual(eventsForDay(31, d, 'wild', NYC));
    expect(fresh.weatherForDay(31, 10, 'wild', NYC)).toEqual(weatherForDay(31, 10, 'wild', NYC));
  });

  it('keeps seasons, windows and notice', () => {
    for (let d = 0; d <= 520; d++) {
      for (const e of eventsForDay(11, d, 'wild', NYC)) {
        const k = NYC.kinds[e.kind];
        expect(e.label).toBe(k.label);
        if (e.label.includes('ballpark')) expect([3, 4, 5, 6, 7, 8]).toContain(month(d));
        if (e.label === 'Flushing tennis open') {
          const x = month(d) * 100 + dom(d);
          expect(x).toBeGreaterThanOrEqual(7 * 100 + 26);
          expect(x).toBeLessThanOrEqual(8 * 100 + 8);
        }
        if (e.label === 'Coney Island fireworks') {
          expect(dow(d)).toBe(5);
          expect([5, 6, 7]).toContain(month(d));
        }
        expect(e.announced).toBe(d - (e.label === 'Downtown parade' ? 5 : 3));
        expect(e.attendance % 100).toBe(0);
        expect(e.attendance).toBeGreaterThanOrEqual(Math.floor(k.attendance[0] / 100) * 100);
        expect(e.attendance).toBeLessThanOrEqual(Math.ceil(k.attendance[1] / 100) * 100);
        expect(e.end - e.start).toBe(k.duration);
      }
    }
    expect(kindOf('Downtown parade').announce).toBe(5);
  });

  it('gives about one event per weekday; Calm equals Normal, Off is empty, Normal ⊆ Wild', () => {
    let n = 0;
    for (let d = 0; d < 2000; d++) {
      const normal = eventsForDay(5, d, 'normal', NYC);
      n += normal.length;
      expect(eventsForDay(5, d, 'calm', NYC)).toEqual(normal);
      expect(eventsForDay(5, d, 'off', NYC)).toEqual([]);
      const wild = new Set(eventsForDay(5, d, 'wild', NYC).map((e) => e.id));
      for (const e of normal) expect(wild.has(e.id)).toBe(true);
    }
    expect(n / 2000).toBeGreaterThan(0.9);
    expect(n / 2000).toBeLessThan(1.4);
  });

  it('announces events inside the notice window', () => {
    const today = 300;
    const known = announcedEvents(5, today, 'normal', NYC);
    for (const e of known) {
      expect(e.day).toBeGreaterThanOrEqual(today);
      expect(e.announced).toBeLessThanOrEqual(today);
    }
    expect(known.filter((e) => e.day === today)).toEqual(eventsForDay(5, today, 'normal', NYC));
  });
});

describe('event tables fit the day (both cities)', () => {
  it('passes checkKinds, with venues in the city and in known regions', () => {
    for (const id of ['nyc', 'london'] as const) {
      const cc = CHAOS_BY_CITY[id];
      expect(checkKinds(cc)).toEqual([]);
      expect(CITY_BALANCE[id].chaos).toBe(cc);
      const regions = new Set(CITIES[id].regions.map((r) => r.name));
      const [w, s, e, n] = CITY_BALANCE[id].map.bounds;
      for (const v of cc.venues) {
        expect(regions.has(v.region)).toBe(true);
        expect(v.lon).toBeGreaterThan(w);
        expect(v.lon).toBeLessThan(e);
        expect(v.lat).toBeGreaterThan(s);
        expect(v.lat).toBeLessThan(n);
      }
      // Every kind ends by 23:30 and its fans are gone within 40 minutes.
      for (const k of cc.kinds) for (const [h] of k.starts) expect(h * 3600 + k.duration + k.leave[1]).toBeLessThanOrEqual(24 * 3600 + 10 * 60);
    }
  });
});

// ---------------------------------------------------------------------------
describe('London events and climate', () => {
  it('holds London events at London venues, in season, on the right weekdays', () => {
    const labels = new Set<string>();
    for (let d = 0; d <= 1044; d++) {
      for (const e of eventsForDay(3, d, 'normal', LONDON)) {
        labels.add(e.label);
        expect(LONDON.venues[e.venue].key).toBe(LONDON.kinds[e.kind].venue);
        const m = month(d), x = m * 100 + dom(d);
        if (['North London football', 'Tottenham football', 'Stratford stadium match'].includes(e.label)) {
          expect([2, 3, 4]).toContain(dow(d));
          expect([5, 6]).not.toContain(m);
          expect(e.start).toBeGreaterThanOrEqual(19.75 * 3600);
        }
        if (e.label === 'Twickenham rugby') {
          expect(dow(d)).toBe(5);
          expect([1, 2, 10]).toContain(m);
        }
        if (e.label === 'Wimbledon tennis fortnight') {
          expect(x).toBeGreaterThanOrEqual(5 * 100 + 24);
          expect(x).toBeLessThanOrEqual(6 * 100 + 7);
        }
        if (e.label === 'Oval cricket test match') {
          expect(x).toBeGreaterThanOrEqual(7 * 100 + 22);
          expect(x).toBeLessThanOrEqual(7 * 100 + 26);
        }
      }
      // The tennis fortnight is on every weekday of its window.
      const x = month(d) * 100 + dom(d);
      if (x >= 524 && x <= 607) expect(eventsForDay(3, d, 'normal', LONDON).some((e) => e.label === 'Wimbledon tennis fortnight')).toBe(true);
    }
    for (const l of ['Wembley stadium match', 'Stratford stadium match', 'North London football', 'Tottenham football', 'Greenwich arena concert', 'Twickenham rugby', 'Wimbledon tennis fortnight', 'Oval cricket test match'])
      expect(labels.has(l)).toBe(true);
    // No New York venue names leak into London.
    for (const l of labels) expect(NYC.kinds.some((k) => k.label === l)).toBe(false);
  });

  it('uses the current city by default', () => {
    applyCity('london');
    const evs = Array.from({ length: 40 }, (_, d) => eventsForDay(3, 100 + d, 'normal')).flat();
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) expect(LONDON.kinds[e.kind].label).toBe(e.label);
    applyCity('nyc');
    expect(eventsForDay(3, 130, 'normal')).toEqual(eventsForDay(3, 130, 'normal', NYC));
  });

  it('has far fewer snow days and more rain days than New York', () => {
    const count = (cc: typeof NYC) => {
      const c: Record<string, number> = { snow: 0, rain: 0, heat: 0, clear: 0 };
      for (let d = 0; d < 5220; d++) c[weatherForDay(17, d, 'normal', cc).kind]++;
      return c;
    };
    const ny = count(NYC), ld = count(LONDON);
    expect(ld.snow * 3).toBeLessThan(ny.snow);
    expect(ld.rain).toBeGreaterThan(ny.rain * 1.3);
    expect(ld.heat).toBeLessThan(ny.heat);
    for (let d = 0; d < 2610; d++) {
      const m = month(d);
      if (m >= 3 && m <= 10) expect(weatherForDay(17, d, 'normal', LONDON).kind).not.toBe('snow');
    }
  });
});

// ---------------------------------------------------------------------------
describe('weather', () => {
  it('is pure and seasonal; Off is always clear', () => {
    expect(weatherForDay(9, 40, 'normal', NYC)).toEqual(weatherForDay(9, 40, 'normal', NYC));
    let jan = 0, janSnow = 0;
    for (let d = 0; d < 26_100; d++) {
      const w = weatherForDay(9, d, 'normal', NYC);
      const m = month(d);
      if (m >= 5 && m <= 8) expect(w.kind).not.toBe('snow');
      if (m >= 10 || m <= 2) expect(w.kind).not.toBe('heat');
      if (m === 0) {
        jan++;
        if (w.kind === 'snow') janSnow++;
      }
      if (w.carried) {
        const prev = weatherForDay(9, d - 1, 'normal', NYC);
        expect(prev.kind).toBe(w.kind);
        expect(w.severity).toBeLessThanOrEqual(prev.severity * WEATHER.carrySeverity + 1e-12);
      }
      if (w.kind === 'clear') expect(w.severity).toBe(0);
      else {
        expect(w.severity).toBeGreaterThanOrEqual(WEATHER.minSeverity * WEATHER.carrySeverity);
        expect(w.severity).toBeLessThanOrEqual(1);
      }
    }
    // 100 years of weekdays: about 2,200 January days.
    expect(jan).toBeGreaterThan(2000);
    expect(janSnow / jan).toBeGreaterThan(0.12);
    expect(janSnow / jan).toBeLessThan(0.3);
    for (let d = 0; d < 300; d++) expect(weatherForDay(9, d, 'off', NYC)).toEqual(CLEAR);
  });

  it('forecasts are right about 80% of the time; misses are less confident', () => {
    let hit = 0;
    for (let d = 0; d < 3000; d++) {
      const f = forecastFor(4, d, 'normal', NYC);
      if (f.kind === weatherForDay(4, d, 'normal', NYC).kind) hit++;
      else expect(f.confidence).toBeLessThanOrEqual(0.7);
      expect(Math.round(f.confidence * 20)).toBeCloseTo(f.confidence * 20, 9);
    }
    expect(hit / 3000).toBeGreaterThan(0.75);
    expect(hit / 3000).toBeLessThan(0.85);
  });

  it('turns weather into linear effects; clear is exactly neutral', () => {
    expect(weatherMods(CLEAR)).toBe(CLEAR_MODS);
    expect(CLEAR_MODS).toMatchObject({ walkSpeed: 1, walkPenalty: 0, driveSpeed: 1, outdoorSpeed: 1, dwell: 1, crowd: 1 });
    const snow = weatherMods({ kind: 'snow', severity: 1, carried: false });
    const e = WEATHER.effects.snow;
    expect(snow).toEqual({ walkSpeed: e.walkSpeed, walkPenalty: e.walkPenalty, driveSpeed: e.driveSpeed, outdoorSpeed: e.outdoorSpeed, dwell: e.dwell, crowd: e.crowd, rates: e.rates });
    expect(weatherMods({ kind: 'snow', severity: 0.5, carried: false }).outdoorSpeed).toBeCloseTo(0.775, 12);
    expect(weatherLabel({ kind: 'snow', severity: 0.9, carried: false })).toBe('Heavy snow');
    expect(weatherLabel({ kind: 'heat', severity: 0.6, carried: false })).toBe('Hot');
  });

  it('leaves mode choice bit-exact when clear, and snow tips a CBD commute to transit', () => {
    const g: PairGeometry = { distance: 6000, homeCore: false, workCore: true, workCbd: true, homeCbd: false };
    const t = { time: 35 * 60, transfers: 1, crowdMinutes: 2, fare: 3 };
    for (const band of [0, 1, 2]) {
      expect(generalisedCosts(g, band, t, CLEAR_WX)).toEqual(generalisedCosts(g, band, t));
      expect(generalisedCosts(g, band, t, CLEAR_MODS)).toEqual(generalisedCosts(g, band, t));
    }
    expect(walkTime(1800, CLEAR_WX)).toBe(walkTime(1800));
    expect(driveTripTime(g, CLEAR_WX)).toBe(driveTripTime(g));
    const snow = weatherMods({ kind: 'snow', severity: 1, carried: false });
    const near: PairGeometry = { ...g, distance: 2000 };
    const [w0, d0] = generalisedCosts(near, 1, t);
    const [w1, d1] = generalisedCosts(near, 1, t, snow);
    expect(w1).toBeGreaterThan(w0 + WEATHER.effects.snow.walkPenalty);
    expect(d1).toBeGreaterThan(d0);
    expect(logitShares(generalisedCosts(g, 1, t, snow))[2]).toBeGreaterThan(logitShares(generalisedCosts(g, 1, t))[2]);
  });
});

// ---------------------------------------------------------------------------
describe('incident plan', () => {
  // The README core network: 27.6k planned train-km a day on 88 directed-track km, 40 stations.
  const per = [2_400, 7_500, 7_400, 7_500, 2_800];
  const ex: Exposure = { trainKmByPeriod: per, trainKm: per.reduce((a, b) => a + b, 0), trackKm: 88, stations: 40 };
  const ones = { signal: 1, breakdown: 1, sick: 1, police: 1 };

  it('averages the planned rates per kind', () => {
    const lambda: Record<IncidentKind, number> = {
      signal: ex.trackKm * CHAOS.signal.perTrackKmDay,
      breakdown: ex.trainKm * CHAOS.breakdown.perTrainKm,
      sick: ex.trainKm * CHAOS.sick.perTrainKm,
      police: ex.stations * CHAOS.police.perStationDay,
    };
    const sum: Record<IncidentKind, number> = { signal: 0, breakdown: 0, sick: 0, police: 0 };
    for (let d = 0; d < 500; d++) for (const p of planIncidents(3, d, ex, 1, ones, 0)) sum[p.kind]++;
    // Police is rare (0.8 a day), so it gets a wider band than the 10% of the others.
    for (const k of INCIDENT_KINDS) expect(Math.abs(sum[k] / 500 / lambda[k] - 1)).toBeLessThan(k === 'police' ? 0.15 : 0.1);
  });

  it('is empty when Off, inside service hours, sorted, and a mid-day plan is an exact suffix', () => {
    expect(planIncidents(3, 5, ex, CHAOS.rate.off, ones, 0)).toEqual([]);
    for (let d = 0; d < 100; d++) {
      const full = planIncidents(3, d, ex, CHAOS.rate.wild, ones, 0);
      for (let i = 0; i < full.length; i++) {
        const tod = full[i].t - d * 86400;
        expect(tod).toBeGreaterThanOrEqual(CHAOS.serviceStart);
        expect(tod).toBeLessThanOrEqual(CHAOS.serviceEnd);
        if (i) expect(full[i].t).toBeGreaterThanOrEqual(full[i - 1].t);
        const [d0, d1] = CHAOS[full[i].kind].duration;
        expect(full[i].dur).toBeGreaterThanOrEqual(d0);
        expect(full[i].dur).toBeLessThanOrEqual(d1);
      }
      const after = d * 86400 + 13.4 * 3600;
      const rest = planIncidents(3, d, ex, CHAOS.rate.wild, ones, after);
      expect(rest).toEqual(full.filter((p) => p.t >= after));
    }
  });

  it('scales with the weather and the level', () => {
    let calm = 0, wild = 0, heat = 0;
    const hot = weatherMods({ kind: 'heat', severity: 1, carried: false }).rates;
    for (let d = 0; d < 300; d++) {
      calm += planIncidents(3, d, ex, CHAOS.rate.calm, ones, 0).length;
      wild += planIncidents(3, d, ex, CHAOS.rate.wild, ones, 0).length;
      heat += planIncidents(3, d, ex, 1, hot, 0).filter((p) => p.kind === 'sick').length;
    }
    expect(wild / calm).toBeGreaterThan(4);
    expect(heat / 300).toBeGreaterThan(ex.trainKm * CHAOS.sick.perTrainKm * 2);
  });
});

// ---------------------------------------------------------------------------
// A hand-built line for the train sim: one route, 4 km straight, stops at 40 / 2,000 / 3,960 m,
// one directed track per direction.
const L = 4000;
const STOPS = [40, 2000, 3960];

function lineDir(d: 0 | 1, outdoor: boolean): CRouteDir {
  const prof = runProfile(L, [], STOPS, 1.1, 1.2, 25, 30);
  return {
    xs: new Float64Array(d === 0 ? [0, L] : [L, 0]),
    ys: new Float64Array(2),
    zs: new Float64Array(2),
    cum: new Float64Array([0, L]),
    length: L,
    stopStation: Int32Array.from(d === 0 ? [0, 1, 2] : [2, 1, 0]),
    stopS: Float64Array.from(STOPS),
    limS0: new Float64Array(0),
    limS1: new Float64Array(0),
    limV: new Float64Array(0),
    elems: [{ track: d, edge: 1, edgeDir: d, u0: 0, s0: 0, s1: L, lock: -1 }],
    schedArrive: new Float64Array(prof.arrive),
    schedDepart: new Float64Array(prof.depart),
    runTime: prof.total,
    ...(outdoor ? { outS0: new Float64Array([0]), outS1: new Float64Array([L]) } : {}),
  };
}

function lineNet(opts: { outdoor?: boolean; headways?: number[]; fleet?: number } = {}): CompiledNetwork {
  const route: CRoute = {
    id: 1,
    name: 'Test',
    bullet: 'T',
    color: '#fff',
    cls: 'heavy',
    cars: 4,
    trainLength: 72,
    capComfort: 440,
    capCrush: 800,
    accel: 1.1,
    brake: 1.2,
    vmax: 25,
    headways: opts.headways ?? [600, 600, 600, 600, 600],
    fleet: opts.fleet ?? 8,
    dirs: [lineDir(0, !!opts.outdoor), lineDir(1, !!opts.outdoor)],
  };
  return {
    version: 1,
    stations: [0, 1, 2].map((i) => ({ id: 101 + i, x: STOPS[i], y: 0, name: `S${i}`, group: i })),
    routes: [route],
    trackCount: 2,
    lockCount: 0,
  };
}

/** Three copies of the line: A (id 1) and C (id 3) on tracks 0/1, B (id 2) on tracks 2/3. */
function threeLines(): CompiledNetwork {
  const base = lineNet({ headways: [900, 900, 900, 900, 900], fleet: 4 });
  const r0 = base.routes[0];
  const on = (dir: CRouteDir, track: number, sb: number): CRouteDir => ({
    ...dir,
    elems: dir.elems.map((e) => ({ ...e, track, edge: 1 + (track >> 1) })),
    stopStation: dir.stopStation.map((s) => s + sb),
  });
  const mk = (id: number, t0: number, sb: number): CRoute => ({ ...r0, id, name: `R${id}`, dirs: [on(r0.dirs[0], t0, sb), on(r0.dirs[1], t0 + 1, sb)] });
  return {
    ...base,
    stations: [0, 1, 2, 3, 4, 5].map((i) => ({ id: 101 + i, x: STOPS[i % 3], y: i < 3 ? 0 : 500, name: `S${i}`, group: i })),
    routes: [mk(1, 0, 0), mk(2, 2, 3), mk(3, 0, 0)],
    trackCount: 4,
  };
}

function stubHooks() {
  const calls = { pass: [] as { train: number; k: number }[], dispatch: [] as { t: number; dir: number }[] };
  const hooks: PassengerHooks = {
    arrive: (tr, _r, k, t) => {
      if (k === 0) calls.dispatch.push({ t, dir: tr.dir });
      return { alight: 0, board: 0 };
    },
    depart: () => {},
    evacuate: () => {},
    pass: (tr, _r, k) => calls.pass.push({ train: tr.id, k }),
  };
  return { hooks, calls };
}

/** Step until fn returns true (or the time limit). */
function run(sim: TrainSim, t0: number, t1: number, each: (t: number) => boolean | void): number {
  for (let t = t0; t <= t1; t += 2) {
    sim.step(t, 2);
    if (each(t)) return t;
  }
  return Infinity;
}

/** Run the first dir-0 train from dispatch to its arrival at the last stop; returns the trip time and top speed. */
function firstTrip(sim: TrainSim, onStep?: (tr: Train, t: number) => void): { time: number; vmax: number; train: Train } {
  let tr: Train | undefined;
  let start = 0, vmax = 0;
  const end = run(sim, 0, 3000, (t) => {
    if (!tr) {
      tr = sim.trains.find((x) => x.dir === 0 && x.state !== TState.Ready);
      start = t;
    }
    if (!tr) return;
    vmax = Math.max(vmax, tr.v);
    onStep?.(tr, t);
    return (tr.state === TState.Dwelling && tr.stop === 2) || tr.state === TState.Turnaround;
  });
  return { time: end - start, vmax, train: tr! };
}

describe('train sim chaos hooks (hand-built line)', () => {
  it('snow caps speed on outdoor track only', () => {
    const plain = new TrainSim(stubHooks().hooks);
    plain.setNetwork(lineNet({ outdoor: true }), 0);
    const base = firstTrip(plain);
    const snowy = new TrainSim(stubHooks().hooks);
    snowy.setNetwork(lineNet({ outdoor: true }), 0);
    snowy.setWeather(0.55, 1);
    const snow = firstTrip(snowy);
    expect(snow.time).toBeGreaterThanOrEqual(base.time * 1.25);
    expect(snow.vmax).toBeLessThanOrEqual(0.55 * 25 + 0.01);
    // Underground: identical.
    const deep = new TrainSim(stubHooks().hooks);
    deep.setNetwork(lineNet({ outdoor: false }), 0);
    deep.setWeather(0.55, 1);
    expect(firstTrip(deep).time).toBe(base.time);
  });

  it('a signal problem makes trains crawl through its segment, and clears', () => {
    const base = firstTrip(withNet(new TrainSim(stubHooks().hooks))).time;
    const sim = withNet(new TrainSim(stubHooks().hooks));
    const crawl = 15 / 3.6;
    sim.setRestrictions([{ id: 1, edge: 1, edgeDir: 0, u0: 800, u1: 1600, v: crawl, until: Infinity, track: -1 }]);
    expect(sim.restrictions()[0].track).toBe(0);
    let inside = 0;
    const slow = firstTrip(sim, (tr) => {
      if (tr.s >= 800 + 40 && tr.s - 72 <= 1600) inside = Math.max(inside, tr.v);
    });
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThanOrEqual(crawl + 0.01);
    expect(slow.time).toBeGreaterThanOrEqual(base + 150);
    // Lifted: the next train runs normally.
    sim.setRestrictions([]);
    let second: Train | undefined;
    let t0 = 0;
    const tEnd = run(sim, 3002, 6000, (t) => {
      if (!second) {
        second = sim.trains.find((x) => x.dir === 0 && x.state !== TState.Ready && x.id !== slow.train.id);
        t0 = t;
      }
      return !!second && ((second.state === TState.Dwelling && second.stop === 2) || second.state === TState.Turnaround);
    });
    expect(tEnd - t0).toBeLessThanOrEqual(base + 2);
  });

  it('a breakdown stalls the train; followers queue behind it; nobody deadlocks', () => {
    const sim = new TrainSim(stubHooks().hooks);
    sim.setNetwork(lineNet({ headways: [120, 120, 120, 120, 120], fleet: 3 }), 0);
    let leader: Train | undefined, follower: Train | undefined;
    let held = -1, lastS = 0;
    let minGap = Infinity, movedWhileHeld = 0, followerStopped = false, leaderOn = false, followerOn = false;
    run(sim, 0, 1500, (t) => {
      // The first dir-0 train to run is the leader; the next one dispatched behind it (120 s) follows.
      leader ??= sim.trains.find((x) => x.dir === 0 && x.state === TState.Running);
      if (leader) follower ??= sim.trains.find((x) => x !== leader && x.dir === 0 && x.state !== TState.Ready);
      if (leader && held < 0 && leader.s > 1200) {
        held = t;
        leader.holdUntil = t + 600;
        sim.extendGrace([leader.routeId], t + 600);
      }
      if (held >= 0 && t > held + 60 && t < held + 590) {
        movedWhileHeld = Math.max(movedWhileHeld, Math.abs(leader!.s - lastS));
        if (follower && follower.dir === 0 && follower.state === TState.Running) {
          minGap = Math.min(minGap, leader!.s - 72 - follower.s);
          if (follower.v === 0) followerStopped = true;
        }
      }
      // After the hold both reach the far end of the line.
      if (held >= 0 && t > held + 600) {
        if (leader!.state === TState.Turnaround) leaderOn = true;
        if (follower!.state === TState.Turnaround) followerOn = true;
      }
      if (leader) lastS = leader.s;
    });
    expect(held).toBeGreaterThan(0);
    expect(movedWhileHeld).toBeLessThan(1);
    expect(followerStopped).toBe(true);
    // The moving block holds the follower back by the 100 m margin (v1's 2 s steps can creep ~10 m into it).
    expect(minGap).toBeGreaterThan(OPERATIONS.safetyMargin * 0.85);
    // Both moved on after the hold.
    expect(leaderOn).toBe(true);
    expect(followerOn).toBe(true);
    expect(sim.day.deadlocks).toBe(0);
  });

  it("scopes the watchdog's incident grace to the incident's routes and those sharing their track", () => {
    // A (1) and C (3) share tracks 0/1; B (2) runs alone on tracks 2/3.
    const go = (graceFor: number[]) => {
      const sim = new TrainSim(stubHooks().hooks);
      sim.setNetwork(threeLines(), 0);
      let held = false;
      run(sim, 0, 7200, (t) => {
        if (held) return;
        const b = sim.trains.find((x) => x.routeId === 2 && x.state === TState.Running && x.s > 500);
        const c = sim.trains.find((x) => x.routeId === 3 && x.state === TState.Running && x.s > 500);
        if (!b || !c) return;
        held = true;
        // Both stall 35 min; the incident is on A only, until both are free.
        b.holdUntil = c.holdUntil = t + 2100;
        sim.extendGrace(graceFor, t + 2100);
      });
      expect(held).toBe(true);
      return sim.day.deadlocks;
    };
    // An incident on A covers C (shared track) but not B: B's stall is caught after 30 min.
    expect(go([1])).toBe(1);
    expect(go([1, 2])).toBe(0);
  });

  it('a sick passenger holds the train at its next stop, never at the terminal', () => {
    const sim = withNet(new TrainSim(stubHooks().hooks));
    const holds: [number, number][] = [];
    sim.onHold = (tr, si) => holds.push([tr.id, si]);
    let dwellStart = -1, dwellEnd = -1;
    let set = false;
    firstTrip(sim, (tr, t) => {
      if (!set && tr.state === TState.Running && tr.stop === 1) {
        tr.holdNext = 300;
        set = true;
      }
      if (tr.state === TState.Dwelling && tr.stop === 1 && dwellStart < 0) dwellStart = t;
      if (dwellStart >= 0 && dwellEnd < 0 && tr.state === TState.Running) dwellEnd = t;
    });
    expect(dwellEnd - dwellStart).toBeGreaterThanOrEqual(320);
    expect(holds).toHaveLength(1);
    expect(holds[0][1]).toBe(1);
    // Next stop is the terminal: dropped silently.
    const sim2 = withNet(new TrainSim(stubHooks().hooks));
    let n = 0;
    sim2.onHold = () => n++;
    let set2 = false;
    const plainTime = firstTrip(withNet(new TrainSim(stubHooks().hooks))).time;
    const t2 = firstTrip(sim2, (tr) => {
      if (!set2 && tr.state === TState.Running && tr.stop === 2) {
        tr.holdNext = 300;
        set2 = true;
      }
    });
    expect(set2).toBe(true);
    expect(n).toBe(0);
    expect(t2.time).toBe(plainTime);
    expect(t2.train.holdNext).toBe(0);
  });

  it('trains run through a closed station and its riders ride on', () => {
    const { hooks, calls } = stubHooks();
    const sim = withNet(new TrainSim(hooks));
    sim.closedUntil = new Float64Array([0, Infinity, 0]);
    let dwelledAt1 = false;
    const trip = firstTrip(sim, (tr) => {
      if (tr.state === TState.Dwelling && tr.stop === 1) dwelledAt1 = true;
    });
    expect(dwelledAt1).toBe(false);
    expect(calls.pass.filter((c) => c.train === trip.train.id)).toEqual([{ train: trip.train.id, k: 1 }]);
    expect(trip.train.stop).toBe(2);
  });

  it('event service adds departures, even where the route has no service', () => {
    const count = (overrides: boolean, headways = [600, 600, 600, 600, 600], from = 3600, to = 7200, hw = 3) => {
      const { hooks, calls } = stubHooks();
      const sim = new TrainSim(hooks);
      sim.setNetwork(lineNet({ headways }), 0);
      if (overrides) sim.setOverrides([{ id: 1, routeId: 1, from, to, headwayMin: hw, eventId: 0 }]);
      run(sim, 0, to + 60, () => {});
      return calls.dispatch.filter((d) => d.dir === 0 && d.t >= from && d.t < to).length;
    };
    const base = count(false);
    expect(base).toBeGreaterThan(0);
    expect(count(true)).toBeGreaterThanOrEqual(base * 2.5);
    // Night with no service: the override alone runs trains.
    expect(count(false, [0, 600, 600, 600, 600], 3600, 7200, 5)).toBe(0);
    expect(count(true, [0, 600, 600, 600, 600], 3600, 7200, 5)).toBeGreaterThan(5);
    // headwayAt never lengthens a headway.
    const sim = new TrainSim(stubHooks().hooks);
    const net = lineNet({ headways: [600, 120, 600, 600, 600] });
    sim.setNetwork(net, 0);
    sim.setOverrides([{ id: 1, routeId: 1, from: 0, to: 86400, headwayMin: 3, eventId: 0 }]);
    expect(sim.headwayAt(0, net.routes[0], 7 * 3600)).toBe(120);
    expect(sim.headwayAt(0, net.routes[0], 12 * 3600)).toBe(180);
  });
});

function withNet(sim: TrainSim): TrainSim {
  sim.setNetwork(lineNet(), 0);
  return sim;
}

// ---------------------------------------------------------------------------
describe('event trips', () => {
  it('samples origins by weight', () => {
    const cdf = new Float64Array([1, 3, 10]);
    const n = [0, 0, 0];
    const r = new Rng(5);
    for (let i = 0; i < 30_000; i++) n[sampleCdf(cdf, r.next())]++;
    expect(Math.abs(n[0] / 30_000 - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(n[1] / 30_000 - 0.2)).toBeLessThan(0.02);
    expect(Math.abs(n[2] / 30_000 - 0.7)).toBeLessThan(0.02);
    expect(sampleCdf(new Float64Array([0, 0, 5]), 0)).toBe(2);
  });

  it('reverses legs and adds venue parking to driving only', () => {
    const p: GroupPath = { legs: Int32Array.from([1, 10, 11, 2, 12, 13]), time: 1800, transfers: 1 };
    expect(Array.from(reverseLegs(p).legs)).toEqual([2, 13, 12, 1, 11, 10]);
    expect(reverseLegs(reverseLegs(p)).legs).toEqual(p.legs);
    const g: PairGeometry = { distance: 7000, homeCore: false, workCore: true, workCbd: false, homeCbd: false };
    const venue = NYC.venues[2];
    for (const band of [0, 2]) {
      const c = eventCosts(g, band, p, venue, CLEAR_WX, 3);
      const plain = generalisedCosts(g, band, { time: p.time, transfers: p.transfers, crowdMinutes: EVENTS.crowdMinutes, fare: 3 }, CLEAR_WX);
      expect(c[0]).toBe(plain[0]);
      expect(c[2]).toBe(plain[2]);
      expect(c[1]).toBeCloseTo(plain[1] + venue.parkingTime / 60 + moneyToMinutes(venue.parkingCost, band), 9);
    }
    expect(eventCosts(g, 1, null, venue, CLEAR_WX, 3)[2]).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
describe('event service', () => {
  // A 2 × 12 km route with 10-car trains every 450 s all day.
  const route = (fleet: number): CRoute => {
    const dir = (d: 0 | 1): CRouteDir => ({ ...lineDir(d, false), length: 12_000, runTime: 1500 });
    return { ...lineNet().routes[0], cars: 10, headways: [450, 450, 450, 450, 450], fleet, dirs: [dir(0), dir(1)] };
  };
  const from = 3 * 86400 + 12 * 3600;

  it('estimates the extra car-km and cost of a 3-minute service for 2 hours', () => {
    const e = serviceEstimate(route(40), from, from + 7200, 3);
    expect(e.extraCarKm).toBeCloseTo((7200 / 180 - 7200 / 450) * 24 * 10, 6);
    expect(e.cost).toBeCloseTo(e.extraCarKm * ECONOMY.operatingPerCarKm, 6);
    const roundTrip = 1500 * 2 + 2 * OPERATIONS.turnaround;
    expect(e.trainsNeeded).toBe(Math.ceil(roundTrip / 180) + OPERATIONS.spareTrains);
    expect(e.trainsOwned).toBe(40);
    expect(e.effectiveHeadway).toBe(180);
    // A small fleet caps the frequency: roundTrip / fleet, and fewer extra trips.
    const small = serviceEstimate(route(5), from, from + 7200, 3);
    expect(small.effectiveHeadway).toBeCloseTo(roundTrip / 5, 9);
    expect(small.extraCarKm).toBeLessThan(e.extraCarKm);
    // Never longer than the route's own headway: a 10-minute "override" adds nothing.
    expect(serviceEstimate(route(40), from, from + 7200, 10).extraCarKm).toBe(0);
    // Where the route has no service (night), every train is extra.
    const night = { ...route(40), headways: [0, 450, 450, 450, 450] };
    expect(serviceEstimate(night, 3 * 86400 + 3600, 3 * 86400 + 3600 + 3600, 5).extraCarKm).toBeCloseTo((3600 / 300) * 24 * 10, 6);
  });

  it('picks routes near the venue and windows around the event', () => {
    const net = lineNet();
    expect(routesNearVenue(net, 2000, 300, 1200)).toEqual([{ routeId: 1, dist: 300, station: 'S1' }]);
    expect(routesNearVenue(net, 2000, 5000, 1200)).toEqual([]);
    const [before, after] = defaultWindows({ start: 20 * 3600, end: 23 * 3600 });
    expect(before).toEqual([18 * 3600, 20.25 * 3600]);
    expect(after).toEqual([22.75 * 3600, 24.5 * 3600]);
    // Starts off the quarter hour snap to 15-minute steps.
    expect(defaultWindows({ start: 19.08 * 3600, end: 22.08 * 3600 })[0][0] % 900).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('save v3', () => {
  const v2 = () => ({
    format: 'headway-ny',
    version: 2,
    city: 'london',
    meta: { day: 3 },
    game: { time: 3 * 86400 + 3600, network: {}, routes: {}, finance: {}, goals: {}, tutorialDone: true, lastReport: { day: 2, riders: 5 } },
    settings: {},
    modeState: null,
  });

  it('migrates v2 and v1 saves with chaos defaults, idempotently', () => {
    const m = migrate(v2());
    // (v4 since operations control and the money market: the chaos step still runs on the way.)
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.city).toBe('london');
    expect(m.migratedFrom).toBe(2);
    expect(m.game.chaos).toEqual({ level: CHAOS.defaultLevel, seed: CHAOS.defaultSeed, service: [], nextServiceId: 1 });
    const v1 = migrate({ format: 'headway-ny', goals: { a: 1 }, game: { network: {}, routes: {}, finance: {} } });
    expect(v1.version).toBe(SAVE_VERSION);
    expect(v1.game.tutorialDone).toBe(true);
    expect(v1.game.chaos.level).toBe('normal');
    expect(v1.city).toBe('nyc');
    // A v3 save passes through untouched, and running the step again changes nothing.
    const again = migrate(JSON.parse(JSON.stringify({ ...m, migratedFrom: undefined })));
    expect(again.game.chaos).toEqual(m.game.chaos);
    expect(again.migratedFrom).toBeUndefined();
    const custom = { ...v2(), game: { ...v2().game, chaos: { level: 'wild', seed: 5, service: [], nextServiceId: 4 } } };
    expect(migrate(custom).game.chaos.level).toBe('wild');
  });

  it('round-trips level, seed and event service; drops finished service and bad values', () => {
    const game = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3, chaos: 'wild', chaosSeed: 4242 });
    game.time = 10 * 86400 + 12 * 3600;
    for (const b of ['A', 'B', 'C']) game.routes.create({ name: b, bullet: b, color: '#fff', cls: 'heavy', stops: [], cars: 4, headways: { night: 0, am: 4, midday: 8, pm: 4, evening: 10 } });
    game.addService({ routeId: 3, from: game.time - 7200, to: game.time - 60, headwayMin: 3, eventId: 160 });
    const live = game.addService({ routeId: 3, from: game.time + 3600, to: game.time + 7200, headwayMin: 2.5, eventId: 161 });
    const save = buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1885 }, modeState: null });
    expect(save.version).toBe(SAVE_VERSION);
    expect(save.game.chaos.service).toEqual([live]);
    const loaded = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 });
    applySave(loaded, migrate(JSON.parse(JSON.stringify(save))));
    expect(loaded.chaos).toEqual({ level: 'wild', levelToday: 'wild', seed: 4242, service: [live], nextServiceId: live.id + 1 });
    // Bad values.
    const bad = sanitizeChaos({ level: 'chaotic', seed: 'x', service: [{ id: 2, routeId: 1, from: 0, to: 'later', headwayMin: 3 }, { id: 7, routeId: 1, from: 0, to: 50, headwayMin: 3 }] }, 100);
    expect(bad).toEqual({ level: 'normal', levelToday: 'normal', seed: CHAOS.defaultSeed, service: [], nextServiceId: 1 });
    expect(sanitizeChaos({ level: 'calm', seed: -1, service: [] }, 0).seed).toBe(4294967295);
    expect(sanitizeChaos(undefined, 0).level).toBe('normal');
  });

  it("keeps today's level and plan basis apart from the next 3 am's level, and drops service on deleted routes", () => {
    const game = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3, chaos: 'normal', chaosSeed: 7 });
    game.time = 4 * 86400 + 10 * 3600;
    const exposure: Exposure = { trainKmByPeriod: [0, 4000, 5000, 4000, 996], trainKm: 13_996, trackKm: 31.5, stations: 16 };
    // The worker planned today at Normal from this exposure; the player then picked Wild (from 3 am).
    game.setChaosToday({ day: 4, level: 'normal', exposure });
    game.setChaosLevel('wild');
    expect(game.chaos.level).toBe('wild');
    expect(game.chaos.levelToday).toBe('normal');
    expect(game.chaosInit()).toEqual({ level: 'normal', nextLevel: 'wild', seed: 7, dayExposure: { day: 4, exposure } });
    const r = game.routes.create({ name: 'A', bullet: 'A', color: '#fff', cls: 'heavy', stops: [], cars: 4, headways: { night: 0, am: 4, midday: 8, pm: 4, evening: 10 } });
    const keep = game.addService({ routeId: r.id, from: game.time + 3600, to: game.time + 7200, headwayMin: 3, eventId: 80 });
    game.addService({ routeId: 99, from: game.time + 3600, to: game.time + 7200, headwayMin: 3, eventId: 80 });
    const save = migrate(JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings: { units: 'metric', agentScale: 10, seed: 1885 }, modeState: null }))));
    expect(save.game.chaos.levelToday).toBe('normal');
    const loaded = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 });
    applySave(loaded, save);
    // Today stays Normal (planned from the 3 am exposure); Wild from the next 3 am. Route 99 is gone.
    expect(loaded.chaosInit()).toEqual({ level: 'normal', nextLevel: 'wild', seed: 7, dayExposure: { day: 4, exposure } });
    expect(loaded.chaos.service).toEqual([keep]);
    // Deleting a route drops its event service.
    loaded.routes.remove(r.id);
    expect(loaded.pruneServiceRoutes()).toEqual([keep]);
    expect(loaded.chaos.service).toEqual([]);
    // Saves without the new fields (or with bad ones): today's level is the level, no plan basis.
    expect(sanitizeChaos({ level: 'calm', seed: 1, service: [] }, 0)).toEqual({ level: 'calm', levelToday: 'calm', seed: 1, service: [], nextServiceId: 1 });
    expect(sanitizeChaos({ level: 'calm', levelToday: 'mad', seed: 1, service: [], dayExposure: { day: 2, exposure: { trainKmByPeriod: ['x'] } } }, 0)).toEqual({ level: 'calm', levelToday: 'calm', seed: 1, service: [], nextServiceId: 1 });
  });

  it('loads a v2 report without chaos', () => {
    const game = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 });
    const m = migrate(v2());
    m.game.network = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 }).network.toData();
    m.game.routes = game.routes.toData();
    m.game.finance = game.finance.toData();
    const r = applySave(game, m);
    expect(r.lastReport).toEqual({ day: 2, riders: 5 });
    expect(r.lastReport?.chaos).toBeUndefined();
    expect(game.chaos.level).toBe('normal');
  });
});

describe('game chaos settings', () => {
  it('defaults new games to Normal and keeps event service in order', () => {
    const game = new Game({} as World, {} as Terrain, { sandbox: true, fare: 3 });
    expect(game.chaos.level).toBe(CHAOS.defaultLevel);
    expect(game.chaos.seed).toBe(CHAOS.defaultSeed);
    let n = 0;
    game.events.on('chaos', () => n++);
    const a = game.addService({ routeId: 1, from: 100, to: 200, headwayMin: 3, eventId: 0 });
    const b = game.addService({ routeId: 2, from: 100, to: 900, headwayMin: 3, eventId: 0 });
    expect(b.id).toBe(a.id + 1);
    expect(game.pruneService(500)).toBe(1);
    expect(game.chaos.service).toEqual([b]);
    expect(game.removeService(b.id)).toBe(true);
    expect(game.removeService(b.id)).toBe(false);
    game.setChaosLevel('calm');
    expect(game.chaos.level).toBe('calm');
    expect(game.chaos.levelToday).toBe(CHAOS.defaultLevel);
    expect(n).toBe(5);
  });
});
