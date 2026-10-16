/**
 * Messages between the main thread and the simulation worker, and the compiled network format.
 * Everything here is plain data (structured-clone friendly).
 */
import type { ChaosLevel, CityId, GrowthPace, IncidentKind, TrackClass, WeatherKind } from '../balance';
import type { DayWeather } from '../core/cityCalendar';
import type { FarePolicy } from '../economy/fares';
import type { Exposure } from './incidents';
import type { RegularityStats } from './regularity';

export type { ChaosLevel, DayWeather, FarePolicy, GrowthPace, IncidentKind, RegularityStats, WeatherKind };

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
  /** Operations control (v2): 1 where trains may be held (never the first or last stop). Missing: none. */
  timepoint?: Uint8Array;
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
  /** Operations control (v2): hold fraction of the headway; 0 or missing = holding off. */
  hold?: number;
  /** Short turnaround when the next departure is already due (v2); missing = the standard turnaround. */
  shortTurn?: boolean;
  /** Settings fingerprint for App.recompile (holding, timepoints, short turns). */
  opsKey?: string;
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
/** Snapshot train state (index 7): dwelling, held by the dispatcher at a timepoint (operations control). */
export const SNAP_HELD = 4;
/** Busy label while the worker runs a skip; messages posted until the label clears came from the skipped hours. */
export const SKIP_LABEL = 'Skipping ahead';
/** Busy label while the worker closes a growth month (Living City: about 0.3 s at the month-end midnight). */
export const GROWTH_LABEL = 'The city is growing';

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
      /** Fare policy (v2; replaces the flat `fare`). */
      fares: FarePolicy;
      modeState?: ModeState;
      /** City chaos (calendar, weather and incidents all derive from the seed). */
      chaos: ChaosInit;
      /** Planned event service. */
      service: ServiceOverride[];
      /** Living City state the saved groups were generated from (null or missing: the starting city). */
      growth?: GrowthData | null;
      /** Living City pace (missing: GROWTH.defaultPace). */
      growthPace?: GrowthPace;
    }
  | { type: 'network'; net: CompiledNetwork }
  | { type: 'speed'; speed: number }
  | { type: 'skipTo'; time: number }
  /** Applies from the next boarding (billing) and the next 3 am (mode choice). */
  | { type: 'fares'; fares: FarePolicy }
  | { type: 'query'; id: number; q: Query }
  /** Applies from the next 3 am. */
  | { type: 'chaosLevel'; level: ChaosLevel }
  /** The full list of event service overrides (replaces the previous list). */
  | { type: 'service'; overrides: ServiceOverride[] }
  /** Living City pace; applies from the next month close. */
  | { type: 'growthPace'; pace: GrowthPace };

export type Query =
  /** Reply: SimState (mode shares and the growth they belong to, captured together). */
  | { kind: 'simState' }
  /** Reply: GrowthView (null without a world). */
  | { kind: 'growthView' }
  /** Reply: TractGrowth, with today's commute benefits (null for a bad tract index). */
  | { kind: 'tractGrowth'; tract: number }
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
  /**
   * Midnight: the day's report, and the mode shares and growth state as they are right after it
   * (so a save made at once holds finances and growth of the same day; a month close's new
   * groups and growth arrive in the same message as its value capture).
   */
  | { type: 'dayEnd'; report: DayReport; state: SimState }
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
  // ---- operations control and the money market (v2). Reports saved before v2 lack these.
  /** Fares by earnings band and period, real people and money (index band × 2 + (peak ? 1 : 0)). */
  fares: FareBreakdown;
  /** Transit share of each earnings band's commuters (as drawn today). */
  bandShare: number[];
  /** Service regularity per route id. */
  routeRegularity: Record<number, RegularityStats>;
  /** Service regularity of the whole network (the routes' sums pooled). */
  regularity: RegularityStats;
  /** Living City: present only on the day a growth month closed. */
  growth?: GrowthMonth;
}

export interface FareBreakdown {
  /** Fare-paying journeys (first boardings), real people; length 6, index band × 2 + (peak ? 1 : 0). */
  trips: number[];
  /** Fares collected, length 6, same index. */
  revenue: number[];
}

/** The 'route' query reply's regularity (v2). */
export interface RouteRegularityDetail {
  /** Today so far. */
  today: RegularityStats;
  /** Yesterday's (null before the first midnight on this route's path). */
  yesterday: RegularityStats | null;
  /** Headway CV per stop in direction-0 stop order (yesterday's, or today's so far); −1 = no data. */
  cvByStop: [number[], number[]];
  /** Stop indices (direction-0 order) that are timepoints. */
  timepoints: number[];
  /** Suggested recovery share from the mean terminal lateness (yesterday's, or today's). */
  suggestRecovery: number;
  /** Hold fraction in force (0 = holding off). */
  hold: number;
  /** Short turnarounds today so far on this route. */
  shortTurns: number;
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
  /** The network exposure today's incidents were planned from (saved, so a mid-day load replans the same ones). */
  exposure?: Exposure;
}

/** Today's incident plan basis: the exposure measured at 3 am on `day`. */
export interface DayExposure {
  day: number;
  exposure: Exposure;
}

/**
 * City chaos settings for the worker. `level` is in force today; `nextLevel` (default: the same)
 * applies from the next 3 am. A start after 3 am on `dayExposure.day` plans the rest of the day's
 * incidents from that exposure instead of the loaded network's.
 */
export interface ChaosInit {
  level: ChaosLevel;
  seed: number;
  nextLevel?: ChaosLevel;
  dayExposure?: DayExposure;
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

// ---------------------------------------------------------------------------
// Living City (transit-oriented growth and value capture, docs/v2/living-city.md)

/** One stored tract snapshot: q = round(multiplier × 10000), residents (T values) then jobs (T). */
export interface GrowthSnapshot {
  day: number;
  q: Uint16Array;
}

/** One row per month close. */
export interface GrowthCityPoint {
  day: number;
  /** City residents and jobs (targets, real people) after the month's growth. */
  residents: number;
  jobs: number;
  /** Value capture paid that month (city currency). */
  valueCapture: number;
}

/** Living City state the agent groups were generated from (save v5 `growth`). Structured-clone safe. */
export interface GrowthData {
  version: 1;
  /** Last month-close day applied (−1 = none). */
  appliedThroughDay: number;
  /** Month closes applied (0 = the starting city). */
  months: number;
  /** Target residents and jobs per tract as multiples of the start. */
  mRes: Float32Array;
  mJobs: Float32Array;
  /** Furness balancing factors: OD'[h][w] = OD[h][w] · fHome[h] · fWork[w]. */
  fHome: Float32Array;
  fWork: Float32Array;
  /** Capitalised land-value premium per tract (0 … VALUE_CAPTURE.premiumMax). */
  premium: Float32Array;
  /** Last month's agent-weighted mean attractiveness (residents, jobs), for projected rates. */
  sbar: [number, number];
  history: GrowthSnapshot[];
  city: GrowthCityPoint[];
  /** This month's commute-benefit samples (Growth.accumulateBenefit; missing: none yet). */
  benefit?: { days: number; throughDay: number; meanSum: number; home: Float64Array; work: Float64Array };
}

/** Atomic capture for saving: mode shares and the growth state their groups belong to, in one reply. */
export interface SimState {
  mode: ModeState;
  growth: GrowthData | null;
}

export interface Boomtown {
  tract: number;
  /** Growth of residents + jobs this month (0.004 = +0.4%). */
  rate: number;
  /** Residents and jobs added this month (real people). */
  dRes: number;
  dJobs: number;
  /** Residents + jobs against the start (0.05 = +5% since the start year). */
  sinceStart: number;
}

/** The month report's City section (DayReport.growth on a month-close day). */
export interface GrowthMonth {
  day: number;
  /** "Jan 2030": the month that closed. */
  label: string;
  pace: GrowthPace;
  /** City targets after growth (real people) and the change this month. */
  residents: number;
  jobs: number;
  dResidents: number;
  dJobs: number;
  /** Filled by the engine after regeneration (0 from Growth.step). */
  agents: number;
  commuters: number;
  /** Value capture for the month (city currency), booked on this day's ledger. */
  valueCapture: number;
  /** Tracts with any part in the district, and the assessed increment they pay on (city currency). */
  districtTracts: number;
  districtIncrement: number;
  /** Levy by station id (each district tract pays through its nearest served station). */
  stationLevy: Record<number, number>;
  /** City mean commute benefit this month (minutes per commute, agent-weighted). */
  benefitMean: number;
  boomtowns: Boomtown[];
  /** Since-start thresholds (GROWTH.milestonesUp / milestonesDown) crossed this month. */
  milestones: { tract: number; pct: number }[];
  /** Largest residents + jobs growth since the start among tracts ≥ GROWTH.minTractPeople (goal). */
  maxTractGrowth: number;
}

/** The growth overlay and panels' data (on demand). */
export interface GrowthView {
  months: number;
  mRes: Float32Array;
  mJobs: Float32Array;
  premium: Float32Array;
  /** 1 where any part of the tract is in the value-capture district. */
  district: Uint8Array;
  /** Share of the tract's area in the district (0 … 1). */
  districtShare: Float32Array;
  stationLevy: Record<number, number>;
  /** District tracts paying through each served station (its nearest), by station id. */
  stationTracts: Record<number, number>;
  /** This month's payment at current values (city currency). */
  projectedValueCapture: number;
  city: GrowthCityPoint[];
}

/** One tract's growth (tract panel). */
export interface TractGrowth {
  residents0: number;
  jobs0: number;
  residents: number;
  jobs: number;
  history: { day: number; residents: number; jobs: number }[];
  /** Minutes per commute saved by the network for people living / working here, and the city mean. */
  benefitHome: number;
  benefitWork: number;
  cityBenefit: number;
  /** Monthly growth rates if the benefits held (with last month's city means). */
  projectedRateRes: number;
  projectedRateJobs: number;
  premium: number;
  inDistrict: boolean;
  districtShare: number;
  /** Nearest served station id (null: none served). */
  nearestStation: number | null;
  /** This tract's monthly value-capture levy at current values (city currency). */
  levy: number;
}
