/**
 * City chaos on the main thread: the alerts the worker posts (incidents, weather, event wrap-ups),
 * today's info from 3 am, and the announced events from the shared calendar. It turns them into
 * ticker items, alert cards and map markers. No DOM, so it is unit-tested.
 */
import { EVENTS, TIME, TRAINS, type ChaosLevel } from '../balance';
import { city } from '../cities';
import { dateOfDay, SECONDS_PER_DAY, timeOfDay } from '../core/calendar';
import {
  announcedEvents,
  eventsForDay,
  forecastFor,
  MAX_VENUES,
  weatherForDay,
  weatherLabel,
  weatherMods,
  type DayWeather,
  type Forecast,
  type FullWeatherMods,
} from '../core/cityCalendar';
import type { Game } from '../core/game';
import { fmtClock, fmtCount, fmtSpeed } from '../core/units';
import { stationsNear } from '../routes/eventService';
import type { Alert, CompiledNetwork, DayChaos, DayChaosInfo, EventDayInfo, EventOutcome, IncidentKind, ServiceOverride } from '../sim/protocol';

export type Tone = 'red' | 'amber' | 'green' | 'event' | 'info';

export interface TickerItem {
  key: string;
  tone: Tone;
  text: string;
  /** Alert id to focus in Service alerts. */
  focus?: number;
  /** City event id to focus in Service alerts. */
  event?: number;
}

export interface RouteRef {
  id: number;
  bullet: string;
  color: string;
  name: string;
}

export interface AlertText {
  title: string;
  /** Follows the route bullets ("trains crawl at 9 mph towards Atlantic Av"). */
  detail: string;
  /** "until 14:35", "~14:05", "cleared after 14 min". */
  when: string;
  tone: Tone;
  routes: RouteRef[];
}

/** An event card: today's from the worker's 3 am info (with the mode split), the rest from the calendar. */
export interface FeedEvent {
  id: number;
  day: number;
  venue: number;
  label: string;
  attendance: number;
  /** Seconds of day. */
  start: number;
  end: number;
  /** Expected people by mode (today, after 3 am). */
  split: EventDayInfo | null;
}

export const LEVEL_LABEL: Record<ChaosLevel, string> = { off: 'Off', calm: 'Calm', normal: 'Normal', wild: 'Wild' };
export const LEVEL_HINT: Record<ChaosLevel, string> = {
  off: 'No incidents, always clear, no events',
  calm: 'Half the incidents; normal weather and events',
  normal: 'Incidents, weather and events at their usual rates',
  wild: '2.5× the incidents, more bad weather, more events',
};
const INCIDENTS: ReadonlySet<string> = new Set<IncidentKind>(['signal', 'breakdown', 'sick', 'police']);
/** Cleared incidents and wrap-ups stay on the ticker this long (game seconds). */
export const RECENT = 90 * 60;
const MAX_ITEMS = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const isIncident = (a: Alert): boolean => INCIDENTS.has(a.kind);

/** "9.4k", "12k", "850". */
export function fmtK(n: number): string {
  const a = Math.abs(n);
  if (a >= 9950) return `${Math.round(n / 1000)}k`;
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "Thu 11 Jul". */
export function shortDate(day: number): string {
  const d = dateOfDay(day);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The next game day as a word: "Tomorrow", or its weekday when a weekend lies between ("Mon"). */
export function nextDayWord(today: number): string {
  const gap = (dateOfDay(today + 1).getTime() - dateOfDay(today).getTime()) / 86_400_000;
  return gap === 1 ? 'Tomorrow' : DOW[dateOfDay(today + 1).getUTCDay()];
}

/** "Tonight 20:00", "Today 11:00", "Tomorrow 19:30", "Thu 11 Jul 20:00". */
export function eventWhen(ev: { day: number; start: number }, today: number): string {
  const clock = fmtClock(ev.start);
  if (ev.day === today) return `${ev.start >= 17 * 3600 ? 'Tonight' : 'Today'} ${clock}`;
  if (ev.day === today + 1 && nextDayWord(today) === 'Tomorrow') return `Tomorrow ${clock}`;
  return `${shortDate(ev.day)} ${clock}`;
}

const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Today's weather effects in the player's units ("elevated and street-level trains ≤ 31 mph", …). */
export function weatherEffects(w: DayWeather): string[] {
  if (w.kind === 'clear') return [];
  const m: FullWeatherMods = weatherMods(w);
  const out: string[] = [];
  if (m.outdoorSpeed < 0.999) out.push(`elevated and street-level trains ≤ ${fmtSpeed(TRAINS.heavy.topSpeed * m.outdoorSpeed)}`);
  if (m.walkSpeed < 0.999) out.push(`walking ${pct(1 - m.walkSpeed)} slower`);
  if (m.driveSpeed < 0.999) out.push(`driving ${pct(1 - m.driveSpeed)} slower`);
  if (m.dwell > 1.001) out.push(`stops ${pct(m.dwell - 1)} longer`);
  if (m.crowd > 1.2) out.push('crowded trains feel worse');
  if (m.rates.signal > 1.25) out.push('more signal failures');
  if (m.rates.breakdown > 1.25) out.push('more breakdowns');
  if (m.rates.sick > 1.25) out.push('more sick passengers');
  return out;
}

export function forecastText(f: Forecast): string {
  return `${f.kind === 'clear' ? 'clear' : f.kind === 'heat' ? 'hot' : f.kind} ${Math.round(f.confidence * 100)}%`;
}

/** "9,420 came by subway · 610 arrived late · 120 gave up". */
export function outcomeText(o: EventOutcome): string {
  const parts = [o.byTransit > 0 ? `${fmtCount(o.byTransit)} came by ${city().transitWord}` : `No fans came by ${city().transitWord}`];
  if (o.late > 0) parts.push(`${fmtCount(o.late)} arrived late`);
  if (o.gaveUp > 0) parts.push(`${fmtCount(o.gaveUp)} gave up`);
  return parts.join(' · ');
}

/**
 * Does an event wrap-up deserve a toast? Only where fans could come by train: some did, or a
 * station is within the access walk. The rest go to the feed (the player can't act on them).
 */
export function wrapUpToasts(a: Alert, net: CompiledNetwork | null | undefined): boolean {
  if (a.kind !== 'event' || !a.outcome) return false;
  if (a.outcome.byTransit > 0) return true;
  return !!net && !!a.pos && stationsNear(net, a.pos[0], a.pos[1], EVENTS.venueAccess).length > 0;
}

/** Title, detail and timing of an alert, composed here so units follow the player's setting. */
export function describeAlert(a: Alert, routeRef: (id: number) => RouteRef | undefined): AlertText {
  const routes = a.routes.map(routeRef).filter((r): r is RouteRef => !!r);
  const towards = a.towards ? ` towards ${a.towards}` : '';
  let title = '';
  let detail = '';
  let when = '';
  switch (a.kind) {
    case 'signal':
      title = `Signal problem near ${a.place}`;
      detail = `trains crawl at ${fmtSpeed(a.crawl ?? 0)}${towards}`;
      when = `until ${fmtClock(a.until)}`;
      break;
    case 'breakdown':
      title = `Train breakdown ${a.place.startsWith('between') ? a.place : `at ${a.place}`}`;
      detail = `train${towards} stalled; trains behind it wait`;
      when = `~${fmtClock(a.until)}`;
      break;
    case 'sick':
      title = `Sick passenger at ${a.place}`;
      detail = `train${towards} held about ${Math.max(1, Math.round((a.until - a.start) / 60))} min`;
      when = `~${fmtClock(a.until)}`;
      break;
    case 'police':
      title = `Police activity at ${a.place}`;
      detail = 'station closed: trains run through, riders are sent to nearby stations';
      when = `until ${fmtClock(a.until)}`;
      break;
    case 'weather': {
      const w = a.weather ?? { kind: 'clear', severity: 0, carried: false };
      title = weatherLabel(w) + (w.carried ? ' continues' : '');
      detail = weatherEffects(w).join('; ');
      break;
    }
    case 'event':
      title = a.outcome?.label ?? a.place;
      detail = a.outcome ? outcomeText(a.outcome) : '';
      when = fmtClock(a.start);
      break;
  }
  let tone: Tone = a.kind === 'event' ? 'event' : a.kind === 'weather' ? 'info' : a.severity === 3 ? 'red' : 'amber';
  if (a.status === 'cleared') {
    tone = 'green';
    const mins = Math.max(1, Math.round((a.until - a.start) / 60));
    when = a.reason ? `ended: ${a.reason}` : `cleared after ${mins} min`;
  }
  return { title, detail, when, tone, routes };
}

/** "A C trains crawl at 9 mph…" for plain-text places (ticker, toasts). */
export function plainDetail(t: AlertText): string {
  if (!t.detail) return '';
  if (!t.routes.length) return t.detail.charAt(0).toUpperCase() + t.detail.slice(1);
  return `${t.routes.map((r) => r.bullet).join(' ')} ${t.detail}`;
}

export class AlertFeed {
  /** Current game day (rolled from snapshots). */
  day = -1;
  /** The worker's latest 3 am info (today's, or yesterday's before 3 am). */
  info: DayChaosInfo | null = null;
  /** Bumped on every change the UI shows. */
  version = 0;
  /** Yesterday's chaos summary and when the day closed. */
  yesterday: { chaos: DayChaos; at: number } | null = null;
  private alerts = new Map<number, Alert>();
  private seen = new Set<number>();

  constructor(private game: Game) {}

  private get seed(): number {
    return this.game.chaos.seed;
  }

  /** Something the feed shows changed elsewhere (level, event service, network). */
  touch(): void {
    this.version++;
  }

  /** Store an alert (new or a status change). Returns 'new' the first time an id is seen. */
  upsert(a: Alert): 'new' | 'update' {
    const prev = this.alerts.get(a.id);
    this.alerts.set(a.id, a);
    this.version++;
    return prev ? 'update' : 'new';
  }

  setInfo(info: DayChaosInfo): void {
    this.info = info;
    this.version++;
  }

  /**
   * A new game day: drop finished alerts from earlier days (once off the ticker) and return the
   * events newly announced today. The first roll of a session only marks what is already known.
   */
  rollDay(day: number, now: number): FeedEventLike[] {
    const first = this.day < 0;
    this.day = day;
    this.prune(now);
    const fresh = announcedEvents(this.seed, day, this.game.chaos.level).filter((e) => !this.seen.has(e.id));
    for (const e of fresh) this.seen.add(e.id);
    this.version++;
    return first ? [] : fresh.filter((e) => e.day > day);
  }

  /** The level changed: what it newly reveals is not "announced" news. */
  markSeen(): void {
    if (this.day < 0) return;
    for (const e of announcedEvents(this.seed, this.day, this.game.chaos.level)) this.seen.add(e.id);
    this.version++;
  }

  /** Midnight: keep the closing day's summary for the ticker. */
  endDay(chaos: DayChaos | undefined, now: number): void {
    if (chaos) this.yesterday = { chaos, at: now };
    this.version++;
  }

  prune(now: number): void {
    for (const [id, a] of this.alerts) {
      if (a.status === 'active') continue;
      if (a.day < this.day && now - this.endTime(a) > RECENT) this.alerts.delete(id);
    }
  }

  private endTime(a: Alert): number {
    return a.status === 'cleared' ? a.until : a.start;
  }

  get(id: number): Alert | undefined {
    return this.alerts.get(id);
  }

  /** Active incidents, most severe first, then newest. */
  active(): Alert[] {
    return [...this.alerts.values()].filter((a) => a.status === 'active' && isIncident(a)).sort((a, b) => b.severity - a.severity || b.start - a.start || b.id - a.id);
  }

  activeCount(): number {
    let n = 0;
    for (const a of this.alerts.values()) if (a.status === 'active' && isIncident(a)) n++;
    return n;
  }

  /** Cleared incidents and event wrap-ups (today's, and recent ones from before midnight), newest first. */
  earlier(now: number): Alert[] {
    return [...this.alerts.values()]
      .filter((a) => (a.status === 'cleared' && isIncident(a)) || a.kind === 'event')
      .filter((a) => a.day === this.day || now - this.endTime(a) <= RECENT)
      .sort((a, b) => this.endTime(b) - this.endTime(a) || b.id - a.id);
  }

  /** Wrap-up of an event, once posted. */
  outcome(eventId: number): EventOutcome | null {
    for (const a of this.alerts.values()) if (a.kind === 'event' && a.eventId === eventId && a.outcome) return a.outcome;
    return null;
  }

  closedStations(): Set<number> {
    const s = new Set<number>();
    for (const a of this.alerts.values()) if (a.status === 'active' && a.kind === 'police' && a.stationId !== undefined) s.add(a.stationId);
    return s;
  }

  alertedTrains(): Set<number> {
    const s = new Set<number>();
    for (const a of this.alerts.values()) if (a.status === 'active' && (a.kind === 'breakdown' || a.kind === 'sick') && a.trainId !== undefined) s.add(a.trainId);
    return s;
  }

  /** The active alert about a station (police) or a train (breakdown, sick hold). */
  activeFor(target: { stationId?: number; trainId?: number }): Alert | null {
    for (const a of this.alerts.values()) {
      if (a.status !== 'active') continue;
      if (target.stationId !== undefined && a.kind === 'police' && a.stationId === target.stationId) return a;
      if (target.trainId !== undefined && (a.kind === 'breakdown' || a.kind === 'sick') && a.trainId === target.trainId) return a;
    }
    return null;
  }

  /** Active incidents on a route. */
  activeOnRoute(routeId: number): Alert[] {
    return this.active().filter((a) => a.routes.includes(routeId));
  }

  /** The level in force today (the worker's), and the level from the next 3 am (the game's). */
  levels(): { today: ChaosLevel; next: ChaosLevel } {
    return { today: this.info?.level ?? this.game.chaos.levelToday, next: this.game.chaos.level };
  }

  /** True when chaos is off today and stays off. */
  get off(): boolean {
    const l = this.levels();
    return l.today === 'off' && l.next === 'off';
  }

  /** Is the worker's 3 am info for today yet? (False between midnight and 3 am.) */
  get infoIsToday(): boolean {
    return !!this.info && this.info.day === this.day;
  }

  /**
   * The level today's calendar follows until the worker's 3 am info for today is in: after 3 am
   * (just after a mid-day load) today's level, before it the level 3 am will apply.
   */
  private calendarLevelToday(): ChaosLevel {
    return timeOfDay(this.game.time) >= TIME.modeChoiceAt ? this.game.chaos.levelToday : this.game.chaos.level;
  }

  /** The weather in force now: the worker's, else the calendar's. */
  weather(): DayWeather {
    if (this.info) return this.info.weather;
    return weatherForDay(this.seed, Math.max(0, this.day), this.calendarLevelToday());
  }

  /**
   * The next forecast: the next game day's ("Tmrw", or "Mon" on a Friday; long: "Tomorrow",
   * "Monday"), or, before 3 am, today's ("From 3 am").
   */
  forecast(): { label: string; long: string; f: Forecast } {
    if (this.info && this.info.day < this.day) return { label: 'From 3 am', long: 'From 3 am', f: forecastFor(this.seed, this.day, this.game.chaos.level) };
    const today = Math.max(0, this.day);
    const w = nextDayWord(today);
    return { label: w === 'Tomorrow' ? 'Tmrw' : w, long: w === 'Tomorrow' ? w : LONG_DOW[DOW.indexOf(w)], f: forecastFor(this.seed, today + 1, this.game.chaos.level) };
  }

  /** Today's events (with the 3 am split when known), then the announced ones, by day and start. */
  events(): FeedEvent[] {
    const today = Math.max(0, this.day);
    const level = this.game.chaos.level;
    const out: FeedEvent[] = [];
    if (this.infoIsToday) {
      for (const e of this.info!.events) out.push({ id: e.id, day: today, venue: e.venue, label: e.label, attendance: e.attendance, start: e.start, end: e.end, split: e });
    } else {
      for (const e of eventsForDay(this.seed, today, this.calendarLevelToday())) out.push({ ...pick(e), split: null });
    }
    for (const e of announcedEvents(this.seed, today, level)) if (e.day > today) out.push({ ...pick(e), split: null });
    return out.sort((a, b) => a.day - b.day || a.start - b.start || a.id - b.id);
  }

  /**
   * Event service planned for an event that is no longer on the calendar: today's events as the
   * worker planned them, then the announced days at the player's level (a level change redraws them).
   */
  orphanService(service: readonly ServiceOverride[]): ServiceOverride[] {
    if (this.day < 0) return [];
    const ids = new Set(this.events().map((e) => e.id));
    return service.filter((o) => o.eventId > 0 && Math.floor(o.eventId / MAX_VENUES) >= this.day && !ids.has(o.eventId));
  }

  /** Up to ten ticker items, in the doc's order. */
  tickerItems(now: number, routeRef: (id: number) => RouteRef | undefined): TickerItem[] {
    const items: TickerItem[] = [];
    if (this.off) return items;
    const word = city().transitWord;
    // Active incidents.
    for (const a of this.active()) {
      const t = describeAlert(a, routeRef);
      items.push({ key: `a${a.id}`, tone: t.tone, text: `${t.title} · ${t.when}`, focus: a.id });
    }
    // Today's events not yet over.
    const evs = this.events();
    for (const e of evs) {
      if (e.day !== this.day || e.day * SECONDS_PER_DAY + e.end <= now) continue;
      const by = e.split && e.split.byTransit > 0 ? ` · ~${fmtK(e.split.byTransit)} by ${word}` : '';
      items.push({ key: `e${e.id}`, tone: 'event', text: `${eventWhen(e, this.day)} · ${e.label} · ${fmtCount(e.attendance)}${by}`, event: e.id });
    }
    // Today's weather, then the forecast.
    const w = this.weather();
    if (w.kind !== 'clear') {
      const fx = weatherEffects(w);
      items.push({ key: 'w', tone: 'info', text: `${weatherLabel(w)}${fx.length ? `: ${fx[0]}` : ''}`, focus: this.day * 1000 });
    }
    const fc = this.forecast();
    if (fc.f.kind !== 'clear') items.push({ key: 'f', tone: 'info', text: `${fc.long}: ${forecastText(fc.f)}`, focus: this.day * 1000 });
    // Announcements.
    for (const e of evs) {
      if (e.day <= this.day) continue;
      items.push({ key: `n${e.id}`, tone: 'event', text: `Announced: ${shortDate(e.day)} ${fmtClock(e.start)} · ${e.label} · ${fmtCount(e.attendance)}`, event: e.id });
    }
    // Recently cleared incidents and wrap-ups, and yesterday's summary.
    for (const a of this.earlier(now)) {
      if (now - this.endTime(a) > RECENT) continue;
      if (a.kind === 'event') {
        items.push({ key: `a${a.id}`, tone: 'event', text: `${a.outcome?.label ?? a.place}: ${a.outcome ? outcomeText(a.outcome) : 'over'}`, focus: a.id });
      } else {
        const t = describeAlert(a, routeRef);
        items.push({ key: `a${a.id}`, tone: 'green', text: `${t.title} · ${t.when}`, focus: a.id });
      }
    }
    const y = this.yesterday;
    if (y && now - y.at <= RECENT) {
      const n = Object.values(y.chaos.incidents).reduce((s, x) => s + x, 0);
      const parts = [`Yesterday: ${n} incident${n === 1 ? '' : 's'}`];
      const top = [...y.chaos.events].sort((a, b) => b.byTransit - a.byTransit)[0];
      if (top && top.byTransit > 0) parts.push(`${top.label}: ${fmtK(top.byTransit)} came by ${word}`);
      items.push({ key: `y${y.at}`, tone: 'info', text: parts.join(' · ') });
    }
    return items.slice(0, MAX_ITEMS);
  }
}

type FeedEventLike = { id: number; day: number; venue: number; label: string; attendance: number; start: number; end: number };

function pick(e: FeedEventLike): Omit<FeedEvent, 'split'> {
  return { id: e.id, day: e.day, venue: e.venue, label: e.label, attendance: e.attendance, start: e.start, end: e.end };
}
