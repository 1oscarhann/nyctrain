/**
 * City chaos in the sim worker: today's weather and events, and the incidents that fire and clear
 * during the day. Every effect goes through existing mechanics (train speeds and dwell, boarding,
 * walk and drive times), so it shows up in observed times and crowding and in tomorrow's choices.
 * With the level Off nothing here draws a random number or changes a value: the sim is v1.
 */
import { CHAOS, EVENTS, OPERATIONS, TECH_EFFECTS, type ChaosLevel, type IncidentKind } from '../balance';
import { cityBalance } from '../cities';
import { toLocal } from '../core/geo';
import { hashSeed, Rng } from '../core/rng';
import { hasTech } from '../core/tech';
import { dayIndex, SECONDS_PER_DAY } from '../core/calendar';
import { CLEAR, CLEAR_MODS, eventsForDay, SALT_QUAKE, venueOf, venueXY, weatherForDay, weatherMods, type CityEvent, type DayWeather, type FullWeatherMods } from '../core/cityCalendar';
import type { Commuters } from './commuters';
import { cdfIndex, measureExposure, planIncidents, trackSpans, type Exposure, type PlannedIncident, type TrackSpan } from './incidents';
import type { Alert, ChaosInit, ChaosState, CompiledNetwork, CRouteDir, DayChaos, DayChaosInfo, DayExposure, EventDayInfo, EventOutcome, ServiceOverride } from './protocol';
import { TState, type TrackRestriction, type Train, type TrainSim } from './trainSim';

export interface ChaosCallbacks {
  /** An incident started or cleared, today's weather, or an event wrap-up. */
  alert?(a: Alert): void;
  /** Today's level, weather and events (3 am, or on start after 3 am). */
  dayChaos?(info: DayChaosInfo): void;
}

/** An incident fired on demand (tests, scripts): the target is given instead of drawn. */
export type ForcedIncident =
  /** r1 picks the directed track (weighted by length), r2 the place along it. */
  | { kind: 'signal'; duration: number; r1?: number; r2?: number }
  /** train is a train id. */
  | { kind: 'breakdown' | 'sick'; train: number; duration: number }
  /** station is a station id. */
  | { kind: 'police'; station: number; duration: number };

interface Active {
  alert: Alert;
  kind: IncidentKind | 'quake';
  until: number;
  restr?: TrackRestriction;
  /** An earthquake restricts every line near it. */
  restrs?: TrackRestriction[];
  trainId?: number;
}

/** A day's earthquake (CityChaos.quakes): when, where (local metres), how far it reaches and for how long. */
export interface QuakePlan {
  t: number;
  x: number;
  y: number;
  lon: number;
  lat: number;
  r: number;
  dur: number;
}

/**
 * The day's earthquake, if any: a pure function of (seed, day, level), drawn whether or not it is
 * in the past so a mid-day load sees the same day. Early warning (research 'eew') shortens it.
 */
export function planQuake(seed: number, day: number, level: ChaosLevel, after: number): QuakePlan | null {
  const q = cityBalance().chaos.quakes;
  const mult = CHAOS.rate[level];
  if (!q || !(mult > 0)) return null;
  const rng = new Rng(hashSeed(seed, day, 0, SALT_QUAKE));
  const hit = rng.next() < Math.min(0.5, q.chance * mult);
  const tod = CHAOS.serviceStart + rng.next() * (CHAOS.serviceEnd - CHAOS.serviceStart);
  let u = rng.next() * q.zones.reduce((a, z) => a + z[2], 0);
  const z = q.zones.find((zz) => (u -= zz[2]) < 0) ?? q.zones[q.zones.length - 1];
  const lon = z[0] + (rng.next() * 2 - 1) * q.scatter, lat = z[1] + (rng.next() * 2 - 1) * q.scatter;
  const r = q.radius[0] + rng.next() * (q.radius[1] - q.radius[0]);
  const dur = (q.duration[0] + rng.next() * (q.duration[1] - q.duration[0])) * (hasTech('eew') ? TECH_EFFECTS.eewDuration : 1);
  const t = day * SECONDS_PER_DAY + tod;
  if (!hit || t < after) return null;
  const [x, y] = toLocal(lon, lat);
  return { t, x, y, lon, lat, r, dur };
}

const SEVERITY: Record<IncidentKind, 1 | 2 | 3> = { signal: 2, breakdown: 3, sick: 1, police: 3 };
const zeroCounts = (): Record<IncidentKind, number> => ({ signal: 0, breakdown: 0, sick: 0, police: 0 });
const DAY = SECONDS_PER_DAY;

export class ChaosController {
  /** Level in force today. */
  level: ChaosLevel;
  /** Level from the next 3 am. */
  private nextLevel: ChaosLevel;
  readonly seed: number;
  private net: CompiledNetwork | null = null;
  private exposure: Exposure = { trainKmByPeriod: [0, 0, 0, 0, 0], trainKm: 0, trackKm: 0, stations: 0 };
  /** What today's incidents were planned from (the network at 3 am). */
  private planExposure: Exposure = this.exposure;
  /** A load's saved plan basis, used once by a start after 3 am on its day. */
  private savedExposure: DayExposure | null;
  private spans: TrackSpan[] = [];
  private spanCdf = new Float64Array(0);
  /** Closed stations by compiled index (shared with the train sim and commuters). */
  private closedUntil: Float64Array = new Float64Array(0);
  private plan: PlannedIncident[] = [];
  private planIdx = 0;
  private active: Active[] = [];
  private restrs: TrackRestriction[] = [];
  private seqDay = -1;
  private seq = 0;
  private day = -1;
  private weather: DayWeather = { ...CLEAR };
  private mods: FullWeatherMods = CLEAR_MODS;
  private weatherAlert: Alert | null = null;
  private info: DayChaosInfo | null = null;
  private wrapups: { at: number; day: number; idx: number; ev: CityEvent }[] = [];
  private counts = zeroCounts();
  private minutes = 0;
  private forcedWeather = new Map<number, DayWeather>();
  private forcedEvents = new Map<number, CityEvent[]>();
  private service: ServiceOverride[] = [];
  private now = 0;
  private quake: QuakePlan | null = null;

  constructor(
    opts: ChaosInit,
    private trains: TrainSim,
    private commuters: Commuters | null,
    private cb: ChaosCallbacks = {},
  ) {
    this.level = opts.level;
    this.nextLevel = opts.nextLevel ?? opts.level;
    this.seed = opts.seed >>> 0;
    this.savedExposure = opts.dayExposure ?? null;
    trains.onHold = (tr, si, t) => this.onHold(tr, si, t);
  }

  // ------------------------------------------------------------------ settings
  /** Takes effect at the next 3 am. */
  setLevel(level: ChaosLevel): void {
    this.nextLevel = level;
  }

  /** Event service overrides (the full list). */
  setService(list: readonly ServiceOverride[]): void {
    this.service = list.map((o) => ({ ...o }));
    this.trains.setOverrides(this.service);
  }

  serviceList(): readonly ServiceOverride[] {
    return this.service;
  }

  /** Tests and scripts: use this weather on `day` instead of the calendar's (applies now if it is today). */
  forceWeather(day: number, w: DayWeather): void {
    this.forcedWeather.set(day, { ...w });
    if (day === this.day) {
      this.weather = { ...w };
      this.applyWeather();
    }
  }

  /** Tests and scripts: use these events on `day` instead of the calendar's (from that day's 3 am). */
  forceEvents(day: number, events: CityEvent[]): void {
    this.forcedEvents.set(day, events.map((e) => ({ ...e })));
  }

  // ------------------------------------------------------------------ daily cycle
  /**
   * 3 am (fresh: the next level takes over), or a start after 3 am (a load: today's level and,
   * if saved, the 3 am exposure, so the rest of the day replans as it was). The day's weather,
   * events and incident plan. Returns the events.
   */
  beginDay(day: number, now: number, fresh = true): CityEvent[] {
    this.day = day;
    if (fresh) this.level = this.nextLevel;
    this.weather = this.forcedWeather.get(day) ?? weatherForDay(this.seed, day, this.level);
    this.applyWeather();
    const events = this.forcedEvents.get(day) ?? eventsForDay(this.seed, day, this.level);
    const saved = this.savedExposure;
    this.savedExposure = null;
    this.planExposure = !fresh && saved && saved.day === day ? saved.exposure : this.exposure;
    this.plan = planIncidents(this.seed, day, this.planExposure, CHAOS.rate[this.level], this.mods.rates, now);
    this.planIdx = 0;
    this.quake = planQuake(this.seed, day, this.level, now);
    this.weatherAlert = null;
    if (this.weather.kind !== 'clear') {
      this.weatherAlert = { id: day * 1000, kind: 'weather', status: 'info', day, start: now, until: (day + 1) * DAY, severity: 1, place: '', routes: [], weather: { ...this.weather } };
      this.post(this.weatherAlert);
    }
    return events;
  }

  private applyWeather(): void {
    this.mods = weatherMods(this.weather);
    // Snow sprinklers and heated points (research): the weather slows the trains less.
    const outdoor = hasTech('snowproof') ? 1 - (1 - this.mods.outdoorSpeed) * TECH_EFFECTS.snowproofSlowdown : this.mods.outdoorSpeed;
    this.trains.setWeather(outdoor, this.mods.dwell);
    this.commuters?.setWeather(this.weather);
  }

  /**
   * After injection: post today's info and schedule the event wrap-ups. On a load (`postedBy` =
   * the start time) wrap-ups due by then already went out before the save, so they are skipped.
   */
  setEventInfo(day: number, events: CityEvent[], info: EventDayInfo[], postedBy = -Infinity): void {
    const m = this.mods;
    const ex = this.planExposure;
    this.info = {
      day,
      level: this.level,
      weather: { ...this.weather },
      mods: { walkSpeed: m.walkSpeed, walkPenalty: m.walkPenalty, driveSpeed: m.driveSpeed, outdoorSpeed: m.outdoorSpeed, dwell: m.dwell, crowd: m.crowd },
      events: info,
      exposure: { trainKmByPeriod: ex.trainKmByPeriod.slice(), trainKm: ex.trainKm, trackKm: ex.trackKm, stations: ex.stations },
    };
    this.cb.dayChaos?.(this.info);
    [...events].sort((a, b) => a.id - b.id).forEach((ev, idx) => {
      const at = day * DAY + ev.end + EVENTS.wrapUpAfter;
      if (at > postedBy) this.wrapups.push({ at, day, idx, ev });
    });
    this.wrapups.sort((a, b) => a.at - b.at || a.idx - b.idx);
  }

  /** Before the 3 am pool reset: post any wrap-ups still pending (late events, or a load). */
  flushWrapups(): void {
    while (this.wrapups.length) this.postWrapup(this.wrapups.shift()!, this.now);
  }

  /** Midnight: the closing day's summary (call before endDay). */
  daySummary(outcomes: EventOutcome[], stats: { eventRiders: number; diverted: number; carriedPast: number }): DayChaos {
    return {
      weather: { ...this.weather },
      incidents: { ...this.counts },
      incidentMinutes: this.minutes,
      diverted: stats.diverted,
      carriedPast: stats.carriedPast,
      eventRiders: stats.eventRiders,
      events: outcomes,
    };
  }

  endDay(): void {
    this.counts = zeroCounts();
    this.minutes = 0;
  }

  // ------------------------------------------------------------------ stepping
  /** Every step, before the trains move: fire due incidents, clear expired ones, post wrap-ups. */
  step(t: number): void {
    this.now = t;
    while (this.planIdx < this.plan.length && this.plan[this.planIdx].t <= t) this.fire(this.plan[this.planIdx++], t);
    if (this.quake && this.quake.t <= t) {
      const q = this.quake;
      this.quake = null;
      this.fireQuake(q, t);
    }
    if (this.active.length) this.clearExpired(t);
    while (this.wrapups.length && this.wrapups[0].at <= t) this.postWrapup(this.wrapups.shift()!, t);
  }

  private fire(p: PlannedIncident, t: number): void {
    const net = this.net;
    if (!net) return;
    switch (p.kind) {
      case 'signal':
        this.fireSignal(p.r1, p.r2, p.dur, t);
        break;
      case 'breakdown':
      case 'sick': {
        const cands = this.trains.trains.filter((tr) => {
          if (tr.state !== TState.Running || tr.holdUntil > t || tr.holdNext > 0 || tr.incident !== 0) return false;
          return p.kind === 'breakdown' || tr.stop < net.routes[tr.route].dirs[tr.dir].stopS.length - 1;
        });
        if (!cands.length) return; // nothing running: dropped
        const tr = cands[Math.min(cands.length - 1, Math.floor(p.r1 * cands.length))];
        if (p.kind === 'breakdown') this.fireBreakdown(tr, p.dur, t);
        else this.fireSick(tr, p.dur, t);
        break;
      }
      case 'police': {
        // Busy stations are likelier: weight 1 + yesterday's boardings / busyWeight.
        const served = this.servedStations();
        if (!served.length) return;
        const last = this.commuters?.last;
        const hourly = last && last.netVersion === net.version && last.stationHourly.length === net.stations.length * 24 ? last.stationHourly : null;
        const cdf = new Float64Array(served.length);
        let acc = 0;
        served.forEach((si, i) => {
          let b = 0;
          const pj = net.stations[si].pair;
          if (hourly) for (let h = 0; h < 24; h++) b += hourly[si * 24 + h] + (pj !== undefined && pj >= 0 ? hourly[pj * 24 + h] : 0);
          acc += 1 + b / CHAOS.police.busyWeight;
          cdf[i] = acc;
        });
        this.firePolice(served[cdfIndex(cdf, p.r1)], p.dur, t);
        break;
      }
    }
  }

  /** Fire an incident on a given target now (or at t). Returns its alert id, or −1 if there was no target. */
  force(f: ForcedIncident, t = this.now): number {
    const net = this.net;
    if (!net) return -1;
    switch (f.kind) {
      case 'signal':
        return this.fireSignal(f.r1 ?? 0.5, f.r2 ?? 0.5, f.duration, t);
      case 'breakdown':
      case 'sick': {
        const tr = this.trains.trains.find((x) => x.id === f.train);
        if (!tr) return -1;
        return f.kind === 'breakdown' ? this.fireBreakdown(tr, f.duration, t) : this.fireSick(tr, f.duration, t);
      }
      case 'police': {
        const si = net.stations.findIndex((s) => s.id === f.station);
        return si < 0 ? -1 : this.firePolice(si, f.duration, t);
      }
    }
  }

  private newId(t: number): number {
    const d = dayIndex(t);
    if (d !== this.seqDay) {
      this.seqDay = d;
      this.seq = 0;
    }
    this.seq = Math.min(899, this.seq + 1);
    return d * 1000 + this.seq;
  }

  /** Signal problem: a crawl on part of a directed track (weighted by length). */
  private fireSignal(r1: number, r2: number, dur: number, t: number): number {
    const net = this.net!;
    if (!this.spans.length) return -1;
    const sp = this.spans[cdfIndex(this.spanCdf, r1)];
    const half = CHAOS.signal.segment / 2;
    const mid = sp.u0 + r2 * (sp.u1 - sp.u0);
    const u0 = Math.max(sp.u0, mid - half), u1 = Math.min(sp.u1, mid + half);
    const id = this.newId(t);
    const until = t + dur;
    const restr: TrackRestriction = { id, edge: sp.edge, edgeDir: sp.edgeDir, u0, u1, v: CHAOS.signal.crawl, until, track: sp.track };
    this.restrs.push(restr);
    this.trains.setRestrictions(this.restrs.slice());
    // Where it is: sampled points of the segment, the routes using it, the nearest station.
    const path: [number, number][] = [];
    const routes = new Set<number>();
    let towards: string | undefined;
    const n = CHAOS.signalPathPoints;
    for (let i = 0; i < n; i++) {
      const u = u0 + ((u1 - u0) * i) / (n - 1);
      let pt: [number, number] | null = null;
      for (const r of net.routes) {
        for (const dir of r.dirs) {
          const el = dir.elems.find((e) => e.track === sp.track && u >= e.u0 - 0.01 && u <= e.u0 + (e.s1 - e.s0) + 0.01);
          if (!el) continue;
          routes.add(r.id);
          towards ??= this.terminalName(dir);
          pt ??= pointAt(dir, el.s0 + (u - el.u0));
        }
      }
      if (pt) path.push(pt);
    }
    const pos = path[Math.floor(path.length / 2)] ?? [0, 0];
    const alert: Alert = {
      id,
      kind: 'signal',
      status: 'active',
      day: dayIndex(t),
      start: t,
      until,
      severity: SEVERITY.signal,
      place: this.nearestStationName(pos[0], pos[1]),
      towards,
      routes: [...routes],
      crawl: CHAOS.signal.crawl,
      pos,
      path,
    };
    // Every route on the restricted track (the sampled points may miss one using another part of it).
    const onTrack = net.routes.filter((r) => r.dirs.some((d) => d.elems.some((e) => e.track === sp.track))).map((r) => r.id);
    this.started({ alert, kind: 'signal', until, restr }, dur, [...new Set([...alert.routes, ...onTrack])]);
    return id;
  }

  /** Tests and scripts: an earthquake at a lon/lat now (radius m, duration s). Returns its alert id, or −1 if no line is near. */
  forceQuake(lon: number, lat: number, radius: number, duration: number, t = this.now): number {
    const [x, y] = toLocal(lon, lat);
    return this.fireQuake({ t, x, y, lon, lat, r: radius, dur: duration * (hasTech('eew') ? TECH_EFFECTS.eewDuration : 1) }, t);
  }

  /** Earthquake: every line within reach of the epicentre crawls while it is inspected. */
  private fireQuake(q: QuakePlan, t: number): number {
    const net = this.net;
    if (!net) return -1;
    const id = this.newId(t);
    const until = t + q.dur;
    const step = CHAOS.quake.sampleStep;
    // The stretch of each directed track (in its own coordinates) within the radius, and the routes on it.
    const reach = new Map<number, { lo: number; hi: number }>();
    const routes = new Set<number>();
    for (const r of net.routes)
      for (const dir of r.dirs)
        for (const el of dir.elems) {
          const len = el.s1 - el.s0;
          const n = Math.max(1, Math.ceil(len / step));
          for (let i = 0; i <= n; i++) {
            const ds = (len * i) / n;
            const [px, py] = pointAt(dir, el.s0 + ds);
            if (Math.hypot(px - q.x, py - q.y) > q.r) continue;
            const cur = reach.get(el.track) ?? { lo: Infinity, hi: -Infinity };
            cur.lo = Math.min(cur.lo, el.u0 + ds);
            cur.hi = Math.max(cur.hi, el.u0 + ds);
            reach.set(el.track, cur);
            routes.add(r.id);
          }
        }
    if (!reach.size) return -1;
    const restrs: TrackRestriction[] = [];
    for (const sp of this.spans) {
      const m = reach.get(sp.track);
      if (!m) continue;
      restrs.push({ id, edge: sp.edge, edgeDir: sp.edgeDir, u0: Math.max(sp.u0, m.lo - step), u1: Math.min(sp.u1, m.hi + step), v: CHAOS.quake.crawl, until, track: sp.track });
    }
    this.restrs.push(...restrs);
    this.trains.setRestrictions(this.restrs.slice());
    const near = this.commuters?.tractNear(q.x, q.y);
    const alert: Alert = {
      id,
      kind: 'quake',
      status: 'active',
      day: dayIndex(t),
      start: t,
      until,
      severity: 3,
      place: near ? near.region : this.nearestStationName(q.x, q.y),
      routes: [...routes],
      crawl: CHAOS.quake.crawl,
      pos: [q.x, q.y],
      radius: q.r,
    };
    this.started({ alert, kind: 'quake', until, restrs }, q.dur);
    return id;
  }

  /** Train breakdown: it brakes hard and stalls where it stops. */
  private fireBreakdown(tr: Train, dur: number, t: number): number {
    const net = this.net!;
    const r = net.routes[tr.route];
    const dir = r.dirs[tr.dir];
    const id = this.newId(t);
    const until = t + dur;
    tr.holdUntil = until;
    tr.incident = id;
    const sRest = Math.min(dir.length, tr.s + (tr.v * tr.v) / (2 * OPERATIONS.emergencyBrake));
    const alert: Alert = {
      id,
      kind: 'breakdown',
      status: 'active',
      day: dayIndex(t),
      start: t,
      until,
      severity: SEVERITY.breakdown,
      place: this.between(dir, tr.stop),
      towards: this.terminalName(dir),
      routes: [r.id],
      trainId: tr.id,
      pos: pointAt(dir, sRest),
    };
    this.started({ alert, kind: 'breakdown', until, trainId: tr.id }, dur);
    return id;
  }

  /** Sick passenger: the train will be held at its next open, non-terminal stop (alert posted then). */
  private fireSick(tr: Train, dur: number, t: number): number {
    const id = this.newId(t);
    tr.holdNext = dur;
    tr.incident = id;
    return id;
  }

  private onHold(tr: Train, si: number, t: number): void {
    const net = this.net;
    if (!net) return;
    const r = net.routes[tr.route];
    const st = net.stations[si];
    const id = tr.incident || this.newId(t);
    tr.incident = id;
    const dur = tr.holdNext;
    const until = tr.until;
    const alert: Alert = {
      id,
      kind: 'sick',
      status: 'active',
      day: dayIndex(t),
      start: t,
      until,
      severity: SEVERITY.sick,
      place: st?.name ?? '',
      towards: this.terminalName(r.dirs[tr.dir]),
      routes: [r.id],
      stationId: st?.id,
      trainId: tr.id,
      pos: st ? [st.x, st.y] : undefined,
    };
    this.started({ alert, kind: 'sick', until, trainId: tr.id }, dur);
  }

  /**
   * Police activity: the station closes; trains run through. A cross-platform pair (v2) is one
   * station complex with shared entrances, so both of its platforms close.
   */
  private firePolice(si: number, dur: number, t: number): number {
    const net = this.net!;
    const st = net.stations[si];
    if (!st) return -1;
    const id = this.newId(t);
    const until = t + dur;
    const pj = st.pair !== undefined && st.pair >= 0 && net.stations[st.pair] ? st.pair : -1;
    const closed = pj >= 0 ? [si, pj] : [si];
    for (const k of closed) {
      this.closedUntil[k] = Math.max(this.closedUntil[k], until);
      this.commuters?.evictStation(k, this.closedUntil[k], t);
    }
    const routes = net.routes.filter((r) => r.dirs.some((d) => closed.some((k) => d.stopStation.includes(k)))).map((r) => r.id);
    const alert: Alert = {
      id,
      kind: 'police',
      status: 'active',
      day: dayIndex(t),
      start: t,
      until,
      severity: SEVERITY.police,
      place: st.name,
      routes,
      stationId: st.id,
      ...(pj >= 0 ? { partnerStationId: net.stations[pj].id } : {}),
      pos: [st.x, st.y],
    };
    this.started({ alert, kind: 'police', until }, dur);
    return id;
  }

  private started(a: Active, dur: number, graceRoutes: readonly number[] = a.alert.routes): void {
    // Trains queued behind an incident aren't deadlocked: on its routes and those sharing their track.
    this.trains.extendGrace(graceRoutes, a.until);
    if (a.kind !== 'quake') this.counts[a.kind]++;
    this.minutes += dur / 60;
    this.active.push(a);
    this.post(a.alert);
  }

  private clearExpired(t: number): void {
    const due = this.active.filter((a) => a.until <= t);
    if (!due.length) return;
    this.active = this.active.filter((a) => a.until > t);
    for (const a of due) this.finish(a, t);
  }

  /** End an incident (expired, or its target vanished) and post the cleared alert. */
  private finish(a: Active, t: number, reason?: string): void {
    if (a.restr || a.restrs) {
      const gone = new Set<TrackRestriction>(a.restrs ?? []);
      if (a.restr) gone.add(a.restr);
      this.restrs = this.restrs.filter((q) => !gone.has(q));
      this.trains.setRestrictions(this.restrs.slice());
    }
    if (a.trainId !== undefined) {
      const tr = this.trains.trains.find((x) => x.id === a.trainId);
      if (tr && tr.incident === a.alert.id) {
        tr.incident = 0;
        if (reason) tr.holdUntil = 0;
      }
    }
    this.post({ ...a.alert, status: 'cleared', until: t, ...(reason ? { reason } : {}) });
  }

  private postWrapup(w: { day: number; idx: number; ev: CityEvent }, t: number): void {
    const outcome: EventOutcome = this.commuters?.eventOutcomes().find((o) => o.id === w.ev.id) ?? {
      id: w.ev.id,
      label: w.ev.label,
      attendance: w.ev.attendance,
      byTransit: 0,
      arrived: 0,
      late: 0,
      gaveUp: 0,
      avgTripMin: 0,
    };
    this.post({
      id: w.day * 1000 + 900 + w.idx,
      kind: 'event',
      status: 'info',
      day: w.day,
      start: t,
      until: t,
      severity: 1,
      place: venueOf(w.ev).name,
      routes: [],
      eventId: w.ev.id,
      pos: venueXY(w.ev),
      outcome,
    });
  }

  private post(a: Alert): void {
    this.cb.alert?.(a);
  }

  // ------------------------------------------------------------------ network
  /** Called after the trains and commuters took the new network: remap closures and targets. */
  setNetwork(net: CompiledNetwork, t: number): void {
    const old = this.net;
    this.net = net;
    const cu = new Float64Array(net.stations.length);
    if (old) {
      const idx = new Map(net.stations.map((s, i) => [s.id, i]));
      old.stations.forEach((s, i) => {
        const until = this.closedUntil[i];
        const ni = idx.get(s.id);
        if (until > t && ni !== undefined) cu[ni] = until;
      });
    }
    this.closedUntil = cu;
    this.trains.closedUntil = cu;
    this.commuters?.setClosures(cu);
    this.exposure = measureExposure(net);
    this.spans = trackSpans(net);
    this.spanCdf = new Float64Array(this.spans.length);
    let acc = 0;
    this.spans.forEach((sp, i) => (this.spanCdf[i] = acc += Math.max(0, sp.u1 - sp.u0)));
    if (this.active.length) {
      const byId = new Map(this.trains.trains.map((tr) => [tr.id, tr]));
      const stationIds = new Set(net.stations.map((s) => s.id));
      const gone: [Active, string][] = [];
      this.active = this.active.filter((a) => {
        let why: string | null = null;
        if (a.restr && a.restr.track < 0) why = 'track removed';
        else if (a.restrs && a.restrs.every((q) => q.track < 0)) why = 'track removed';
        else if (a.trainId !== undefined && byId.get(a.trainId)?.incident !== a.alert.id) why = 'train withdrawn';
        else if (a.kind === 'police' && !stationIds.has(a.alert.stationId ?? -1)) why = 'station removed';
        if (why) gone.push([a, why]);
        return !why;
      });
      for (const [a, why] of gone) this.finish(a, t, why);
    }
    // Waiters re-queued by the network change leave closed stations again.
    cu.forEach((until, si) => {
      if (until > t) this.commuters?.evictStation(si, until, t);
    });
  }

  // ------------------------------------------------------------------ queries
  /** Active incidents, plus today's weather alert. */
  activeAlerts(): Alert[] {
    const out = this.active.map((a) => a.alert);
    if (this.weatherAlert) out.unshift(this.weatherAlert);
    return out;
  }

  state(): ChaosState {
    return {
      level: this.level,
      nextLevel: this.nextLevel,
      seed: this.seed,
      today: this.info,
      active: this.activeAlerts(),
      outcomes: this.commuters?.eventOutcomes() ?? [],
      service: this.service.map((o) => ({ ...o })),
    };
  }

  /** Today's weather and its effects. */
  todayWeather(): { weather: DayWeather; mods: FullWeatherMods } {
    return { weather: { ...this.weather }, mods: this.mods };
  }

  exposureNow(): Exposure {
    return this.exposure;
  }

  /** Remaining planned incidents today (for scripts). */
  remainingPlan(): readonly PlannedIncident[] {
    return this.plan.slice(this.planIdx);
  }

  // ------------------------------------------------------------------ helpers
  /**
   * Stations a police incident can close: those routes call at, a cross-platform pair once (under
   * its lower index; closing either closes both), its weight from both platforms' boardings.
   */
  private servedStations(): number[] {
    const net = this.net!;
    const s = new Set<number>();
    for (const r of net.routes) for (const d of r.dirs) for (const si of d.stopStation) s.add(pairRoot(net, si));
    return [...s].sort((a, b) => a - b);
  }

  private nearestStationName(x: number, y: number): string {
    let best = Infinity;
    let name = '';
    for (const s of this.net?.stations ?? []) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < best) {
        best = d;
        name = s.name;
      }
    }
    return name;
  }

  private terminalName(dir: CRouteDir): string | undefined {
    return this.net?.stations[dir.stopStation[dir.stopStation.length - 1]]?.name;
  }

  /** "between Marcy Av and Flushing Av" for a train heading to stop `next`. */
  private between(dir: CRouteDir, next: number): string {
    const st = this.net!.stations;
    const a = st[dir.stopStation[Math.max(0, next - 1)]]?.name ?? '';
    const b = st[dir.stopStation[Math.min(dir.stopStation.length - 1, next)]]?.name ?? '';
    return a === b ? b : `between ${a} and ${b}`;
  }
}

/** A station's pair key (v2): the lower compiled index of its cross-platform pair, else itself. */
function pairRoot(net: CompiledNetwork, si: number): number {
  const p = net.stations[si]?.pair;
  return p !== undefined && p >= 0 && p < si ? p : si;
}

/** Point (local metres) at path distance s along a route direction. */
export function pointAt(dir: CRouteDir, s: number): [number, number] {
  const cum = dir.cum;
  const n = cum.length;
  if (n === 0) return [0, 0];
  if (s <= 0 || n === 1) return [dir.xs[0], dir.ys[0]];
  if (s >= cum[n - 1]) return [dir.xs[n - 1], dir.ys[n - 1]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const f = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
  return [dir.xs[lo] + (dir.xs[hi] - dir.xs[lo]) * f, dir.ys[lo] + (dir.ys[hi] - dir.ys[lo]) * f];
}
