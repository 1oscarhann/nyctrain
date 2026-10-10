/**
 * Messages between the main thread and the simulation worker, and the compiled network format.
 * Everything here is plain data (structured-clone friendly).
 */
import type { TrackClass } from '../balance';

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
  | { type: 'init'; dataBase: string; agentScale: number; seed: number; time: number; fare: number; modeState?: ModeState }
  | { type: 'network'; net: CompiledNetwork }
  | { type: 'speed'; speed: number }
  | { type: 'skipTo'; time: number }
  | { type: 'fare'; fare: number }
  | { type: 'query'; id: number; q: Query };

export type Query =
  | { kind: 'modeState' }
  | { kind: 'station'; station: number }
  | { kind: 'route'; route: number }
  | { kind: 'tract'; tract: number }
  | { kind: 'unserved' }
  | { kind: 'flows'; limit: number }
  | { kind: 'segmentLoads' };

export type FromWorker =
  | { type: 'ready'; agents: number; groups: number; baseline: number }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'dayEnd'; report: DayReport }
  | { type: 'busy'; label: string | null }
  | { type: 'reply'; id: number; data: unknown }
  | { type: 'event'; title: string; body?: string; tone?: 'green' | 'amber' | 'red' }
  | { type: 'error'; message: string };

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
  /** Transit door-to-door minutes Midtown → JFK (scheduled), or null. */
  midtownJfk: number | null;
  boroughsServed: number[];
}
