/**
 * Every tunable number in the game lives here.
 * Internal units are SI: metres, seconds, metres per second, dollars.
 */

const KMH = 1 / 3.6;
const MIN = 60;
const HOUR = 3600;

// ---------------------------------------------------------------------------
// Time
export const TIME = {
  /** Game seconds per real second at 1× (1 in-game minute per real second). */
  baseRate: 60,
  /** Selectable speed multipliers (keys 1–4). */
  speeds: [1, 5, 20, 60] as const,
  /** Fixed simulation step, game seconds. */
  simStep: 2,
  /** Snapshots posted from the sim worker to the main thread per real second. */
  snapshotHz: 10,
  /** Max real milliseconds the worker spends simulating per loop iteration before yielding. */
  workerSliceMs: 14,
  /** Game time when a new game starts: 05:00 on day 0. */
  startTimeOfDay: 5 * HOUR,
  /** "Skip to 6am" target. */
  skipTo: 6 * HOUR,
  /** Daily mode choice runs at this time of day. */
  modeChoiceAt: 3 * HOUR,
  /** Weekday-only calendar start (Monday). */
  startDate: { year: 2030, month: 0, day: 7 },
};

// ---------------------------------------------------------------------------
// Map / camera
export const MAP = {
  startCenter: [-74.006, 40.7075] as [number, number], // Lower Manhattan
  startZoom: 12,
  /** NYC bbox plus margin [w, s, e, n]. */
  bounds: [-74.42, 40.42, -73.58, 41.0] as [number, number, number, number],
  minZoom: 9.5,
  maxZoom: 18,
  tiltPitch: 60,
  tiltDurationMs: 1000,
  /** Building height growth steps during the tilt animation (each step re-tessellates building tiles). */
  buildingGrowSteps: 7,
  buildingMinZoom: 13,
  /** Building opacity while a construction tool is active or an underground item is selected. */
  xrayOpacity: 0.35,
  trainMinZoom: 11.5,
  /** Height above ground of elevated track in the 3D view. */
  elevatedHeight: 8,
  pillarSpacing: 30,
  /** Pixel spacing between interlined route lines. */
  interlineSpacingPx: 4.5,
  routeLineWidthPx: 4,
};

// ---------------------------------------------------------------------------
// Track
export type TrackLevel = 'elevated' | 'at-grade' | 'cut-and-cover' | 'deep';
export type TrackClass = 'heavy' | 'light';

export const LEVELS: TrackLevel[] = ['elevated', 'at-grade', 'cut-and-cover', 'deep'];

export const TRACK = {
  /** Height of each level relative to ground, metres. */
  height: { elevated: 8, 'at-grade': 0, 'cut-and-cover': -8, deep: -25 } as Record<TrackLevel, number>,
  /** Construction cost per metre of double track (×1000 = per km). */
  costPerM: { elevated: 90_000, 'at-grade': 40_000, 'cut-and-cover': 160_000, deep: 280_000 } as Record<
    TrackLevel,
    number
  >,
  /** Elevated track over water is a bridge. */
  bridgeMultiplier: 3,
  /** Deep bored tunnel under water. */
  underwaterTunnelMultiplier: 1.5,
  /**
   * Density multiplier for surface-disturbing levels: cost × (1 + k × density),
   * density = residents + jobs per km² of the tract underneath.
   */
  densityK: 1 / 6000,
  densityAffects: { elevated: true, 'at-grade': true, 'cut-and-cover': true, deep: false } as Record<
    TrackLevel,
    boolean
  >,
  /** Construction days per km. */
  daysPerKm: { elevated: 5, 'at-grade': 3, 'cut-and-cover': 8, deep: 12 } as Record<TrackLevel, number>,
  maxGrade: { heavy: 0.04, light: 0.06 } as Record<TrackClass, number>,
  minRadius: { heavy: 150, light: 100 } as Record<TrackClass, number>,
  /** Lateral acceleration used for curve speed limits: v = √(a·r). */
  lateralAccel: 1.0,
  /** Fillet tangent length cap at ordinary vertices (bounds how far a curve cuts the corner). */
  filletMaxTangent: 250,
  /** Preferred radius for auto-placed lead curves where a branch leaves existing track. */
  leadPreferredRadius: { heavy: 350, light: 220 } as Record<TrackClass, number>,
  leadMinLength: 40,
  /** Deflections below this (radians) need no curve. */
  straightEpsilon: 0.0035,
  /** Light metro structures are smaller. */
  lightCostMultiplier: 0.7,
  /** Snap distance in screen pixels for track tools. */
  snapPx: 14,
  /** Bulldozing built track refunds this fraction of its cost. */
  bulldozeRefund: 0.2,
  /** Max edges at one junction node. */
  maxJunctionDegree: 4,
  /** Sampling interval for water / cost integration along track, metres. */
  sampleStep: 20,
};

// ---------------------------------------------------------------------------
// Stations
export const STATION = {
  costByLevel: { 'at-grade': 25e6, elevated: 45e6, 'cut-and-cover': 80e6, deep: 200e6 } as Record<TrackLevel, number>,
  costPerCar: 1e6,
  buildDays: { 'at-grade': 10, elevated: 15, 'cut-and-cover': 20, deep: 30 } as Record<TrackLevel, number>,
  minRadius: 1000,
  minSpacing: 400,
  interchangeRadius: 200,
  walkSpeed: 1.2,
  transferBase: 60,
  catchment: 800,
  cars: { heavy: { min: 2, max: 10, default: 8 }, light: { min: 2, max: 4, default: 4 } } as Record<
    TrackClass,
    { min: number; max: number; default: number }
  >,
  /** Extra platform length beyond the cars, metres. */
  platformMargin: 10,
  /** Street-name search radius for auto-naming, metres. */
  nameSearchRadius: 220,
};

// ---------------------------------------------------------------------------
// Trains
export interface TrainSpec {
  carLength: number;
  minCars: number;
  maxCars: number;
  capacityComfort: number;
  capacityCrush: number;
  accel: number;
  brake: number;
  topSpeed: number;
  costPerCar: number;
}

export const TRAINS: Record<TrackClass, TrainSpec> = {
  heavy: {
    carLength: 18,
    minCars: 2,
    maxCars: 10,
    capacityComfort: 110,
    capacityCrush: 200,
    accel: 1.1,
    brake: 1.2,
    topSpeed: 90 * KMH,
    costPerCar: 2.5e6,
  },
  light: {
    carLength: 20,
    minCars: 2,
    maxCars: 4,
    capacityComfort: 90,
    capacityCrush: 160,
    accel: 1.3,
    brake: 1.3,
    topSpeed: 100 * KMH,
    costPerCar: 2.0e6,
  },
};

export const OPERATIONS = {
  turnaround: 3 * MIN,
  dwellBase: 20,
  dwellPerPassenger: 1.0,
  dwellMax: 90,
  dwellCrowdedFactor: 1.5,
  /** Dwell assumed when building timetables. */
  scheduledDwell: 30,
  /** Moving block: keep braking distance plus this behind the train ahead. */
  safetyMargin: 100,
  /** Emergency braking (only used to resolve conflicts the normal brake cannot). */
  emergencyBrake: 2.5,
  /** A train that has not moved for this long while blocked releases junction claims. */
  lockStallRelease: 120,
  /** Watchdog: a train stuck this long is declared deadlocked. */
  deadlockAfter: 30 * MIN,
  /** Time periods [startHour, endHour). */
  periods: [
    { id: 'night', label: 'Night', start: 0, end: 6 },
    { id: 'am', label: 'AM peak', start: 6, end: 10 },
    { id: 'midday', label: 'Midday', start: 10, end: 16 },
    { id: 'pm', label: 'PM peak', start: 16, end: 20 },
    { id: 'evening', label: 'Evening', start: 20, end: 24 },
  ] as const,
  /** Default headways in minutes for a new route (0 = no service). */
  defaultHeadways: { night: 20, am: 4, midday: 8, pm: 4, evening: 10 },
  headwayChoices: [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30],
  spareTrains: 1,
  /** Peak hour used for load profiles. */
  peakHour: 8,
};

// ---------------------------------------------------------------------------
// Commuters
export const COMMUTERS = {
  /** Real commuters represented by one simulated agent. */
  agentScale: 10,
  agentScaleChoices: [5, 10, 20, 50],
  seed: 1885,
  departMean: 8.25 * HOUR,
  departSd: 45 * MIN,
  departMin: 5 * HOUR,
  departMax: 11 * HOUR,
  workDuration: 8.5 * HOUR,
  returnJitter: 30 * MIN,
  walkSpeed: 1.3,
  walkDetour: 1.3,
  walkMaxDistance: 2500,
  driveDetour: 1.35,
  driveSpeedManhattan: 14 * KMH,
  driveSpeedOther: 24 * KMH,
  /** Manhattan below 60th St. */
  cbdLat: 40.7644,
  parkingCbdTime: 20 * MIN,
  parkingCbdCost: 20,
  parkingOtherTime: 5 * MIN,
  /** Value of time by earnings band, $/hour. */
  valueOfTime: [10, 20, 40],
  /** Logit scale parameter (per minute of generalised cost). */
  logitScale: 0.085,
  /** Alternative-specific constants in minutes (positive = less attractive). */
  /** Driving's constant reflects NYC car ownership, tolls and congestion beyond the drive time. */
  modeConstant: { walk: 0, drive: 25, transit: 0 },
  /** Driving running cost, $/km (fuel, tolls, wear). */
  driveCostPerKm: 0.3,
  transferPenalty: 5 * MIN,
  /** Wait time is half the headway, capped at this. */
  waitCap: 15 * MIN,
  /**
   * Longest walk to or from a station that people will consider (from the tract centre, plus a
   * share of the tract radius). The 800 m catchment drawn on the map is the easy 10-minute walk;
   * with no buses in this New York, people will walk further if the train is worth it — the walk
   * time is part of the generalised cost, so the logit decides.
   */
  maxAccessWalk: 2500,
  accessRadiusTractShare: 0.5,
  /** In-vehicle time multiplier per unit of load factor above comfortable capacity. */
  crowdingWeight: 0.6,
  /** Each day mode shares move this far toward the new logit result. */
  dailySmoothing: 0.3,
  /** An agent waiting on a platform longer than this gives up and takes a cab. */
  maxPlatformWait: 45 * MIN,
  /** Trips with transit cost more than this × drive cost count as unserved. */
  unservedRatio: 1.6,
};

// ---------------------------------------------------------------------------
// Economy
export const ECONOMY = {
  startingCash: 6e9,
  fareDefault: 3.0,
  fareMin: 0,
  fareMax: 5,
  fareStep: 0.25,
  operatingPerCarKm: 4,
  staffingPerStationDay: 8000,
  maintenanceRatePerYear: 0.01,
  /** Weekday-only calendar: game days per year for annual rates. */
  daysPerYear: 261,
  bondChunk: 1e9,
  bondMax: 20e9,
  /**
   * Tuned from the spec's starting 4%: at 4% the interest on the ~$17B a 40-station core needs
   * exceeds what ~1.5M daily riders pay at a $3 fare. At 2.5% such a core breaks even (fares ≈
   * operations + staffing + maintenance + interest) around 1.5M riders. See README → Balance.
   */
  bondRate: 0.025,
  bondYears: 30,
  bankruptcyDays: 30,
};

// ---------------------------------------------------------------------------
// Goals
export const GOALS = {
  riderMilestones: [500_000, 1_000_000, 2_000_000, 3_000_000],
  modeShareTarget: 0.5,
  commuteSavingMinutes: 10,
  jfkMinutes: 45,
  /** Midtown (Bryant Park) and JFK terminal area. */
  midtown: [-73.9832, 40.7536] as [number, number],
  jfk: [-73.7781, 40.6413] as [number, number],
};

export const UNITS = { KMH, MIN, HOUR };
