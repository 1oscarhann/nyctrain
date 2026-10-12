/**
 * Messages between the main thread and the simulation worker, and the compiled network format.
 * Everything here is plain data (structured-clone friendly).
 */
import type { ChaosLevel, CityId, IncidentKind, TrackClass, WeatherKind } from '../balance';
import type { DayWeather } from '../core/cityCalendar';

export type { ChaosLevel, DayWeather, IncidentKind, WeatherKind };

export interface CStation {
  id: number;
  x: number;
  y: number;
  name: string;
  /** Interchange group index. */
  group: number;
}

export interface CElement {
  /** Dense directed-track index (edge × direction). */
  track: number;
  edge: number;
  /** Direction along the edge: 0 = a→b. */
  edgeDir: 0 | 1;
  /** Track coordinate where the path enters this element. */
  u0: number;
  s0: number;
  s1: number;
  /** Junction merge lock at the element start (−1 = none). */
  lock: number;
}

export interface CRouteDir {
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  cum: Float64Array;
  length: number;
  /** Station index (into CompiledNetwork.stations) of each stop. */
  stopStation: Int32Array;
  /** Path distance of each stop (platform centre). */
  stopS: Float64Array;
  limS0: Float64Array;
  limS1: Float64Array;
  limV: Float64Array;
  elems: CElement[];
  /** Scheduled arrival / departure offsets from leaving the first stop. */
  schedArrive: Float64Array;
  schedDepart: Float64Array;
  runTime: number;
  /** Outdoor stretches (elevated, at-grade, the exposed half of a ramp) in path s, sorted and merged.
   * Optional so hand-made test networks stay valid; missing means all underground. */
  outS0?: Float64Array;
  outS1?: Float64Array;
}

export interface CRoute {
  id: number;
  name: string;
  bullet: string;
  color: string;
  cls: TrackClass;
  cars: number;
  trainLength: number;
  capComfort: number;
  capCrush: number;
  accel: number;
  brake: number;
  vmax: number;
  /** Headway per period in seconds (night, am, midday, pm, evening); 0 = no service. */
  headways: number[];
  fleet: number;
  dirs: [CRouteDir, CRouteDir];
}

export interface CompiledNetwork {
  version: number;
  stations: CStation[];
  routes: CRoute[];
  trackCount: number;
  lockCount: number;
}

// ---------------------------------------------------------------------------

export interface TrainSnap {
  id: number;
  route: number;
  dir: number;
  s: number;
  v: number;
  load: number;
  /** Seconds late against the timetable. */
  late: number;
  state: number;
  nextStop: number;
}

export interface Snapshot {
  time: number;
  /** Version of the compiled network the train indices refer to. */
  netVersion: number;
  /** Packed train records, see TRAIN_STRIDE. */
  trains: Float64Array;
  /** Waiting people (agents) per compiled station index. */
  waiting: Float64Array;
  /** Today so far. */
  live: LiveStats;
  simRate: number;
}

export const TRAIN_STRIDE = 9; // id, route, dir, s, v, load, late, state, nextStop

export interface LiveStats {
  ridersToday: number;
  tripsInProgress: number;
  inSystem: number;
}

export interface ModeState {
  /** Fingerprint of agent generation (scale + seed + data) so saved shares match the groups. */
  key: string;
  shares: Float32Array;
  obsTime: Float32Array;
  obsCrowd: Float32Array;
}

export type ToWorker =
  | {
      type: 'init';
      city: CityId;
      dataBase: string;
      agentScale: number;
      seed: number;
      time: number;
      fare: number;
      modeState?: ModeState;
      /** City chaos level and seed (calendar, weather and incidents all derive from the seed). */
      chaos: { level: ChaosLevel; seed: number };
      /** Planned event service. */
      service: ServiceOverride[];
    }
  | { type: 'network'; net: CompiledNetwork }
  | { type: 'speed'; speed: number }
  | { type: 'skipTo'; time: number }
  | { type: 'fare'; fare: number }
  | { type: 'query'; id: number; q: Query }
  /** Applies from the next 3 am. */
  | { type: 'chaosLevel'; level: ChaosLevel }
  /** The full list of event service overrides (replaces the previous list). */
  | { type: 'service'; overrides: ServiceOverride[] };

export type Query =
  | { kind: 'modeState' }
  | { kind: 'station'; station: number }
  | { kind: 'route'; route: number }
  | { kind: 'tract'; tract: number }
  | { kind: 'unserved' }
  | { kind: 'flows'; limit: number }
  | { kind: 'segmentLoads' }
  /** Reply: ChaosState (resync after a load or when a panel opens). */
  | { kind: 'chaos' };

export type FromWorker =
  | { type: 'ready'; agents: number; groups: number; baseline: number }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'dayEnd'; report: DayReport }
  | { type: 'busy'; label: string | null }
  | { type: 'reply'; id: number; data: unknown }
  | { type: 'event'; title: string; body?: string; tone?: 'green' | 'amber' | 'red' }
  | { type: 'error'; message: string }
  /** An incident started or cleared, today's weather (3 am), or an event wrap-up. */
  | { type: 'alert'; alert: Alert }
  /** 3 am (or on start after 3 am): today's level, weather and events with their expected mode split. */
  | { type: 'dayChaos'; info: DayChaosInfo };

export interface DayReport {
  day: number;
  /** Real-people counts (agents × scale). Riders are boardings (unlinked trips), like
   * transit agencies report; each linked journey pays one fare (transfers are free). */
  riders: number;
  /** Linked, fare-paying journeys. */
  fareTrips: number;
  /** Fares collected, each journey at the fare in force when it boarded. */
  fareRevenue: number;
  commuters: number;
  transitShare: number;
  walkShare: number;
  driveShare: number;
  /** Average door-to-door commute, minutes, all modes. */
  avgCommute: number;
  baselineCommute: number;
  carKm: number;
  stationsOpen: number;
  avgLateness: number;
  leftBehind: number;
  gaveUp: number;
  deadlocks: number;
  /** Per route id. */
  routeRiders: Record<number, number>;
  routeLateness: Record<number, number>;
  /** Per station id: daily boardings. */
  stationBoardings: Record<number, number>;
  /** Transit door-to-door minutes for the timed-trip goal (GOALS.tripFrom → tripTo), or null. */
  goalTrip: number | null;
  boroughsServed: number[];
  /** City chaos summary (optional: reports saved before chaos existed don't have it). */
  chaos?: DayChaos;
}

// ---------------------------------------------------------------------------
// City chaos (events, disruptions and weather)

export interface ServiceOverride {
  id: number;
  routeId: number;
  /** Absolute game times [from, to). */
  from: number;
  to: number;
  /** Headway while active; it never lengthens the route's own headway, and adds service where it has none. */
  headwayMin: number;
  /** City event it was planned for, or 0. */
  eventId: number;
}

export interface Alert {
  /** day·1000 + seq (0 = weather, 1–899 incidents, 900 + i event wrap-ups). */
  id: number;
  kind: IncidentKind | 'weather' | 'event';
  status: 'active' | 'cleared' | 'info';
  day: number;
  /** Game time it started (or was posted). */
  start: number;
  /** Expected clear time (or when it actually cleared, on a cleared alert). */
  until: number;
  /** signal 2, breakdown 3, sick 1, police 3, weather/event 1. */
  severity: 1 | 2 | 3;
  /** "34 St", "between Marcy Av and Flushing Av", "Midtown arena" (names only, no units). */
  place: string;
  /** Terminal the affected trains are heading for. */
  towards?: string;
  /** Affected route ids. */
  routes: number[];
  stationId?: number;
  trainId?: number;
  eventId?: number;
  /** Signal crawl speed, m/s. */
  crawl?: number;
  /** Local metres. */
  pos?: [number, number];
  /** Signal problem segment, local metres. */
  path?: [number, number][];
  weather?: DayWeather;
  outcome?: EventOutcome;
  /** Why a cleared alert ended early ("track removed", "train withdrawn"). */
  reason?: string;
}

/** Real people. */
export interface EventDayInfo {
  id: number;
  label: string;
  venue: number;
  attendance: number;
  /** Seconds of day. */
  start: number;
  end: number;
  byTransit: number;
  byDrive: number;
  byWalk: number;
  /** Transit fans beyond the agent pool (counted as driving). */
  overflow: number;
}

export interface DayChaosInfo {
  day: number;
  level: ChaosLevel;
  weather: DayWeather;
  /** Weather factors in force (walk/drive/outdoor speeds, dwell, crowding, incident rates). */
  mods: { walkSpeed: number; walkPenalty: number; driveSpeed: number; outdoorSpeed: number; dwell: number; crowd: number };
  events: EventDayInfo[];
}

/** Real people. */
export interface EventOutcome {
  id: number;
  label: string;
  attendance: number;
  byTransit: number;
  /** Fans who reached the venue (by transit, or by cab after giving up). */
  arrived: number;
  /** …after the start. */
  late: number;
  gaveUp: number;
  /** Average trip to the venue, minutes. */
  avgTripMin: number;
}

export interface DayChaos {
  weather: DayWeather;
  incidents: Record<IncidentKind, number>;
  incidentMinutes: number;
  /** People sent away from closed stations (by cab). */
  diverted: number;
  /** People carried past a closed station. */
  carriedPast: number;
  /** Event fans' boardings. */
  eventRiders: number;
  events: EventOutcome[];
}

/** Reply to the 'chaos' query. */
export interface ChaosState {
  level: ChaosLevel;
  /** Level from the next 3 am. */
  nextLevel: ChaosLevel;
  seed: number;
  /** Today's info as posted at 3 am (null before the first 3 am of a session started before it). */
  today: DayChaosInfo | null;
  /** Active incidents and today's weather alert. */
  active: Alert[];
  /** Today's event outcomes so far. */
  outcomes: EventOutcome[];
  service: ServiceOverride[];
}
