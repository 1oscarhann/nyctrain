/**
 * Every tunable number in the game lives here.
 * Internal units are SI: metres, seconds, metres per second, and money in the city's currency.
 *
 * The sections below hold New York's values. Each city's differences are in CITY_BALANCE at
 * the bottom; src/cities/index.ts applyCity() restores these defaults and applies them.
 */

import type { Projection } from './core/geo';

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
  /** City bbox plus margin [w, s, e, n]. */
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
  /**
   * Living City 3D growth columns: height = growthColumnMetresPerSqrtPerson × √(residents + jobs
   * added), from growthColumnMinPeople, capped at growthColumnMaxMetres. The square root makes a
   * typical Steady boomtown visible within 2–3 months (+20 people ≈ 27 m, +150 ≈ 73 m) without
   * absurd towers near a tract's ×2 bound (+2,500 ≈ 300 m; the City of London's jobs hit the cap).
   * One scale for both cities: London's larger zones add more people, so stand a little taller.
   */
  growthColumnMetresPerSqrtPerson: 6,
  growthColumnMinPeople: 10,
  growthColumnMaxMetres: 500,
  /** Land mask cell, m (the regional intertown map uses coarser cells). */
  landCell: 20,
  /** Fill hairline gaps between region outlines in the land mask (coarse national maps). */
  landClose: false,
};

// ---------------------------------------------------------------------------
// Cinematic (v2, docs/v2/cinematic.md): main thread only; nothing here reaches the sim.
export const CINEMATIC = {
  /** The day/night palette is re-evaluated at most this often (App's 250 ms interval). */
  tickMs: 250,
  /** A palette colour is pushed to MapLibre only when a channel moved at least this much (of 255). */
  minColourDelta: 2,
  /** …and the light only when its direction moved at least this many degrees. */
  minLightDegrees: 2,
  /** Glow layers' opacity steps (the view is redrawn only when the night factor moves this much). */
  glowStep: 0.02,
  /** The title screen's fixed light: just after sunset (blue hour, the windows lit), the sun west-southwest. */
  titleSunAltitude: -6,
  titleSunAzimuth: 250,
  /** Follow-cam: chase pitch (degrees), default distance behind the train (m), its wheel range, easing (s). */
  chasePitch: 72,
  chaseDistance: 260,
  chaseDistanceMin: 90,
  chaseDistanceMax: 2500,
  chaseLookAhead: 40,
  chaseBearingTau: 0.7,
  chasePitchTau: 0.45,
  /** maxPitch while following (the horizon and the sky show at the chase pitch). */
  chaseMaxPitch: 76,
  /** maxZoom while following (the chase distance needs it at large windows). */
  chaseMaxZoom: 20,
  /** A followed train that leaves the snapshot (a turnaround, a recompile) is waited for this long (game s). */
  followLostGameSec: 600,
  /** Timelapse: at most this many frames, a save budget (characters), and the simplification tolerance (m). */
  timelapseMaxFrames: 120,
  timelapseMaxBytes: 600_000,
  timelapseToleranceM: 1,
  /** Player: real seconds per month at 1×, and the speeds offered. */
  timelapseSecondsPerMonth: 1.1,
  timelapseSpeeds: [1, 2, 4] as const,
};

// ---------------------------------------------------------------------------
// Commuter stories (v2, docs/v2/commuter-stories.md): one traced agent, crowd dots, the commuter
// of the day. The worker only records; nothing here changes the simulation.
export const STORIES = {
  /** A trace keeps at most this many events (the oldest go first). */
  maxEvents: 160,
  /** Crowd dots from this zoom: one per agent waiting, at most dotsMax per platform. */
  dotsMinZoom: 14.5,
  dotsMax: 160,
  /** The platform box the dots fill: half its length along the track (m, at most half the platform) and half its width across (px). */
  dotsHalfLength: 75,
  dotsHalfWidthPx: 7,
  dotRadiusPx: 1.8,
  /** Train fill bars (riders against crush capacity) from this zoom. */
  fillMinZoom: 14,
  /** The commuter of the day is toasted only when its day was notable (s). */
  dailyMinSaved: 8 * MIN,
  dailyMinWait: 6 * MIN,
  dailyMinFanTrip: 15 * MIN,
};

// ---------------------------------------------------------------------------
// Track
export type TrackLevel = 'elevated' | 'at-grade' | 'cut-and-cover' | 'deep';
export type TrackClass = 'heavy' | 'light' | 'highspeed';
export const TRACK_CLASSES: TrackClass[] = ['heavy', 'light', 'highspeed'];
/**
 * Track families. Trains run on any track of their family and junctions join any two classes of a
 * family: high-speed line is heavy-rail track built straight and fast, so high-speed trains can
 * run onto ordinary track to reach a city terminal (at its line speed).
 */
export type Gauge = 'heavy' | 'light';
export const gaugeOf = (c: TrackClass): Gauge => (c === 'light' ? 'light' : 'heavy');

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
  maxGrade: { heavy: 0.04, light: 0.06, highspeed: 0.035 } as Record<TrackClass, number>,
  minRadius: { heavy: 150, light: 100, highspeed: 1500 } as Record<TrackClass, number>,
  /** Lateral acceleration used for curve speed limits: v = √(a·r). */
  lateralAccel: 1.0,
  /** High-speed line is canted for speed: curves allow more (300 km/h needs r ≈ 5 km, not 7). */
  lateralAccelHighSpeed: 1.4,
  /**
   * Line speed by track class: the most any train may run there (curves can lower it). The metro
   * trains top out below heavy and light track's limits, so metro play is unchanged.
   */
  lineSpeed: { heavy: 200 * KMH, light: 100 * KMH, highspeed: 320 * KMH } as Record<TrackClass, number>,
  /**
   * Fillet tangent length cap at ordinary vertices (bounds how far a curve cuts the corner), by
   * class: high-speed line sweeps in wide curves (a 20° bend at 3 km tangents is r ≈ 17 km).
   */
  filletMaxTangent: { heavy: 250, light: 250, highspeed: 3000 } as Record<TrackClass, number>,
  /** Preferred radius for auto-placed lead curves where a branch leaves existing track. */
  leadPreferredRadius: { heavy: 350, light: 220, highspeed: 1500 } as Record<TrackClass, number>,
  /**
   * The Line tool leaves room at each station for the curves on either side to turn at least this
   * sharply (a longer straight through the platform where the line bends there). High-speed lines
   * bend gently: 4 km is ≈ 270 km/h through the curve.
   */
  lineStationRadius: { heavy: 350, light: 220, highspeed: 4000 } as Record<TrackClass, number>,
  leadMinLength: 40,
  /** Deflections below this (radians) need no curve. */
  straightEpsilon: 0.0035,
  /** Light metro structures are smaller. */
  lightCostMultiplier: 0.7,
  /** High-speed line: heavier formation, overhead power for 300+ km/h, gentle alignments. */
  highSpeedCostMultiplier: 1.8,
  /** Snap distance in screen pixels for track tools. */
  snapPx: 14,
  /** Bulldozing built track refunds this fraction of its cost. */
  bulldozeRefund: 0.2,
  /** Max edges at one junction node. */
  maxJunctionDegree: 4,
  /** Sampling interval for water / cost integration along track, metres. */
  sampleStep: 20,
  /**
   * Mountains (maps with relief data: Japan). A square's steepness m runs from 0 at a mean slope of
   * mountainSlope[0]° to 1 at mountainSlope[1]° and steeper; building there costs ×(1 + k·m) by
   * level, and takes ×(1 + k·m / 2) as long. Surface track in the mountains is all cuttings,
   * embankments and tall viaducts, so it costs several times a tunnel's premium: the real lines
   * tunnel through (half of the Tohoku Shinkansen north of Morioka is in tunnel).
   */
  mountainSlope: [2, 15] as [number, number],
  mountainK: { elevated: 2, 'at-grade': 5, 'cut-and-cover': 5, deep: 0.4 } as Record<TrackLevel, number>,
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
  /** Platform length in cars of PLATFORM_CAR_M[gauge] (long platforms for main-line trains). */
  cars: { heavy: { min: 2, max: 14, default: 8 }, light: { min: 2, max: 4, default: 4 }, highspeed: { min: 4, max: 16, default: 12 } } as Record<
    TrackClass,
    { min: number; max: number; default: number }
  >,
  /** Extra platform length beyond the cars, metres. */
  platformMargin: 10,
  /** Street-name search radius for auto-naming, metres. */
  nameSearchRadius: 220,
  /** London-style names use a neighbourhood label this close to the station. */
  placeNameRadius: 450,
};

// ---------------------------------------------------------------------------
// Station upgrades: how many people a station's platforms hold comfortably, and five levels of
// rebuild that multiply it (and speed boarding and changes). Tier 0 is the station as built.
export interface StationTier {
  name: string;
  /** One line on what the works are. */
  blurb: string;
  /** Comfortable waiting capacity, × the basic station's. */
  capacity: number;
  /** Boarding/alighting time per passenger, × the basic station's (dwell). */
  boarding: number;
  /** Seconds off every change of trains here. */
  transferSave: number;
  /** Extra staffing, in basic stations' worth per day. */
  staff: number;
  /** Cost, × the station's own build cost by level (STATION.costByLevel). */
  costMult: number;
  /** Works, in days (instant in Sandbox). */
  days: number;
}

export const STATION_TIERS: StationTier[] = [
  { name: 'Basic station', blurb: 'Narrow platforms, one entrance, stairs', capacity: 1, boarding: 1, transferSave: 0, staff: 0, costMult: 0, days: 0 },
  { name: 'Wider platforms', blurb: 'Platforms widened, a second staircase, more gates', capacity: 1.8, boarding: 0.88, transferSave: 10, staff: 0.2, costMult: 0.35, days: 20 },
  { name: 'Entrances & escalators', blurb: 'New entrances on both sides of the street, escalator banks', capacity: 2.8, boarding: 0.78, transferSave: 20, staff: 0.45, costMult: 0.7, days: 40 },
  { name: 'New concourse', blurb: 'Big ticket hall, platform screen doors, step-free lifts', capacity: 4.2, boarding: 0.66, transferSave: 30, staff: 0.75, costMult: 1.2, days: 60 },
  { name: 'Grand interchange', blurb: 'Rebuilt as a hub: extra platform faces, wide passages, shops', capacity: 6.5, boarding: 0.55, transferSave: 45, staff: 1.2, costMult: 2, days: 90 },
];

export const STATION_CROWD = {
  /** Basic station: comfortable waiting people per metre of platform (both directions together). */
  peoplePerMetre: 12,
  /** While works are on, the platforms hold this share of their capacity. */
  worksCapacity: 0.85,
  /** Discomfort (minutes of generalised cost) per minute waited, per 100% over capacity. */
  overWeight: 2,
  /** Overfill is counted up to this multiple of capacity. */
  maxOver: 3,
  /** Dwell grows by this share per 100% over capacity (crowded platforms board slowly). */
  dwellPerOver: 0.4,
  /** Past this multiple of capacity a station shuts its gates: people arriving from the street are turned away. */
  closeAt: 2,
  /** Yesterday's peak crowding above this nudges you to upgrade (once a day, the worst station). */
  warnAt: 1.25,
};

// ---------------------------------------------------------------------------
// Four-track trunks and express service (v2, docs/v2/express-quad.md §9). Shared by every city:
// construction costs, levels and the water rule come from TRACK and STATION as for any track.
export const QUAD = {
  /** Centre to centre of the two double-track pairs, metres (four tracks at about 4.5 m). */
  spacing: 9,
  /**
   * Turnout from the drawn pair to the express pair at a fan end, by track class. Metro: 40 m leads
   * + 70 m diagonal, r ≈ 551 m. High-speed: 400 m (40 m leads + 320 m diagonal, r ≈ 2.85 km, about
   * 225 km/h through the diverging road), since its curves must be at least TRACK.minRadius.
   */
  turnoutLength: { heavy: 150, light: 150, highspeed: 400 } as Record<TrackClass, number>,
  /** Each half of a scissors crossover (same geometry and speed as a turnout), by track class. */
  crossoverLength: { heavy: 150, light: 150, highspeed: 400 } as Record<TrackClass, number>,
  /** Clearance from the end of a straight piece to a turnout or crossover junction. */
  connectorMargin: 20,
  /** How far along the stroke a fan's turnout may start before the stroke is refused. */
  connectorSearch: 1500,
  /** Shortest express pair (between its two ends or turnouts), about a 10-car train. */
  minLength: 200,
  /** Scissors crossovers near free ends, out of the box. */
  autoCrossovers: true,
  /** Tolerance for matching partner points and partner ends. */
  partnerTolerance: 3,
  /** An existing platform on the other pair this close pairs up with a new one. */
  pairLinkDistance: 40,
  /**
   * The express pair shares excavation, structure, shafts, ventilation, power and the right of way
   * (cost × this): a four-track section costs 1.5× a double track, as historic four-track subways
   * did, against 2× for a second line. Tuned (express review, docs/v2/express-quad.md): at 0.75 the
   * pair's capital was the whole of the express scenarios' gap to their all-stops twins.
   */
  secondPairCostFactor: 0.5,
  /** Turnouts and crossovers sit inside the four-track box (cost × this). */
  linkCostFactor: 0.5,
  /**
   * Each platform of a cross-platform pair costs this share of a lone platform (shared box,
   * entrances and concourse: a pair is 1.4× a station). The design's own lever (§12), applied
   * because the express scenario lost more than $0.3M/day against the core.
   */
  pairPlatformCostShare: 0.7,
  /** Staff of a cross-platform pair, in stations. */
  pairStaffing: 1.4,
  /** Seconds to step across an island platform. */
  crossPlatformTransfer: 15,
  /** Share of the transfer penalty felt across a platform. */
  crossPlatformPenaltyFactor: 0.4,
  /**
   * A rider on board steps across a cross-platform station to another route's train dwelling
   * there when it reaches their stop this many seconds sooner, beyond the step across (the train
   * is already in: no wait). About one skipped stop's worth.
   */
  switchGain: 45,
  /** Longest a rider on a local steps across to wait for an express due at the other platform, s. */
  crossPlatformWaitMax: 300,
  /** Route pathfinding: metres added for running through a platform the route does not serve. */
  passPenalty: 600,
  /** Route pathfinding: metres added for each turnout or crossover used. */
  linkPenalty: 250,
  /** Map: gap between the local and express route bundles, px. */
  pairGapPx: 3,
  /** Map: rails of unrouted four-track sections, px. */
  railWidthPx: 1.3,
  railGapPx: 1.8,
};

// ---------------------------------------------------------------------------
// Trains
/**
 * Rolling stock. 'heavy' and 'light' are the metro trains every save has (the ids are the old track
 * classes, so old routes and spare pools load as they were); the rest came with train types.
 */
export type StockId = 'heavy' | 'light' | 'commuter' | 'intercity' | 'highspeed';
export const STOCK_IDS: StockId[] = ['heavy', 'light', 'commuter', 'intercity', 'highspeed'];

export interface TrainSpec {
  /** "Metro", "Commuter EMU"… */
  name: string;
  /** One line for the picker. */
  blurb: string;
  /** The track family it runs on. */
  gauge: Gauge;
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

export const TRAINS: Record<StockId, TrainSpec> = {
  heavy: {
    name: 'Metro',
    blurb: 'Packed standing room, quick to start and stop, 90 km/h',
    gauge: 'heavy',
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
    name: 'Light metro',
    blurb: 'Short trains on light track, 100 km/h',
    gauge: 'light',
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
  commuter: {
    name: 'Commuter EMU',
    blurb: 'The suburban workhorse: seats and standing, 160 km/h',
    gauge: 'heavy',
    carLength: 20,
    minCars: 4,
    maxCars: 12,
    capacityComfort: 80,
    capacityCrush: 140,
    accel: 0.8,
    brake: 0.9,
    topSpeed: 160 * KMH,
    costPerCar: 2.2e6,
  },
  intercity: {
    name: 'Intercity',
    blurb: 'Mostly seats, slow to get going, 200 km/h',
    gauge: 'heavy',
    carLength: 24,
    minCars: 4,
    maxCars: 11,
    capacityComfort: 70,
    capacityCrush: 95,
    accel: 0.5,
    brake: 0.7,
    topSpeed: 200 * KMH,
    costPerCar: 3.0e6,
  },
  highspeed: {
    name: 'High-speed',
    blurb: '300 km/h on high-speed line (200 on ordinary track); all seats, pricey',
    gauge: 'heavy',
    carLength: 26,
    minCars: 4,
    maxCars: 16,
    capacityComfort: 60,
    capacityCrush: 75,
    accel: 0.45,
    brake: 0.65,
    topSpeed: 300 * KMH,
    costPerCar: 4.5e6,
  },
};

/** Metro trains for routes from before train types (and the default on each track family). */
export const defaultStock = (g: Gauge): StockId => (g === 'light' ? 'light' : 'heavy');
/** The stock a family can run. */
export const stocksFor = (g: Gauge): StockId[] => STOCK_IDS.filter((s) => TRAINS[s].gauge === g);
/** Platform car length by track class: platform lengths are counted in these (high-speed platforms in high-speed cars). */
export const PLATFORM_CAR_M: Record<TrackClass, number> = { heavy: 18, light: 20, highspeed: 26 };

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
  defaultHeadways: { night: 20, am: 4, midday: 8, pm: 4, evening: 10 } as Record<'night' | 'am' | 'midday' | 'pm' | 'evening', number>,
  headwayChoices: [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30] as number[],
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
  /** Driving speed when either end is in the city's core regions (CITY_BALANCE.coreRegions). */
  driveSpeedCore: 14 * KMH,
  driveSpeedOther: 24 * KMH,
  /**
   * Long trips (intertown): road distance beyond driveLongAfter runs at driveSpeedLong (A roads and
   * motorways). Infinity = off: every metro-city trip is driven at street speeds, as in v1.
   */
  driveLongAfter: Infinity,
  driveSpeedLong: 70 * KMH,
  /** Parking time and cost for jobs in the CBD (CITY_BALANCE.cbd). */
  parkingCbdTime: 20 * MIN,
  parkingCbdCost: 20,
  parkingOtherTime: 5 * MIN,
  /** Value of time by earnings band, money per hour. */
  valueOfTime: [10, 20, 40],
  /** Logit scale parameter (per minute of generalised cost). */
  logitScale: 0.085,
  /** Alternative-specific constants in minutes (positive = less attractive). */
  /** Driving's constant reflects NYC car ownership, tolls and congestion beyond the drive time. */
  modeConstant: { walk: 0, drive: 25, transit: 0 },
  /** Driving running cost per km (fuel, tolls, wear). */
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
  dailySmoothing: 0.45,
  /** An agent waiting on a platform longer than this gives up and takes a cab. */
  maxPlatformWait: 45 * MIN,
  /** Trips with transit cost more than this × drive cost count as unserved. */
  unservedRatio: 1.6,
};

// ---------------------------------------------------------------------------
// Park & ride: a station's car park lets people drive from home to the train (home end only).
export const PARK_RIDE = {
  /** Furthest straight-line drive from a neighbourhood's centre to a station car park, m. */
  maxDrive: 15_000,
  /** Nobody drives to a station closer than this (they walk). */
  minDrive: 900,
  /** Parking and walking from the car to the platform (and back to the car), s. */
  parkTime: 4 * MIN,
  /** Daily charge per car (city currency), plus driving costs (COMMUTERS.driveCostPerKm). */
  fee: 4,
  /** Hassle of a car-plus-train journey, generalised minutes. */
  constant: 4,
  /** Building a car park, per space (surface and decked parking averaged). */
  costPerSpace: 12_000,
  /** Spaces added by one click in the station panel. */
  buildChoices: [250, 500, 1000],
  /** Largest car park at one station. */
  maxSpaces: 5000,
  /** Minutes added to mode choice when a group's drivers found the car park full yesterday. */
  fullPenalty: 25,
};

// ---------------------------------------------------------------------------
// The school run: secondary-age pupils (11–18) travel to their real school each school day.
export const SCHOOLS = {
  /** Pupils come from nearby: origin weight = residents · exp(−d / originDecay). */
  originDecay: 2500,
  /** Share of pupils at school on a given day. */
  attendance: 0.94,
  /** Arrival at school (triangular, s of day) and the end of the school day. */
  arrive: [8 * HOUR + 10 * MIN, 8 * HOUR + 50 * MIN] as [number, number],
  leave: [15 * HOUR + 5 * MIN, 16 * HOUR + 40 * MIN] as [number, number],
  /** Stations within this walk of a school serve it. */
  access: 1500,
  /** Pupils' fare as a share of the adult fare (London: child fares; New York: free student cards). */
  childFare: 0.5,
  /** A lift from a parent (or the school bus) costs this hassle, generalised minutes. */
  liftConstant: 12,
  /** At most this many pupils by train in a day (real people; the agent pool). */
  maxRidersPerDay: 300_000,
  /** Time spent per minute is valued like the lowest earnings band. */
  band: 0,
};

// ---------------------------------------------------------------------------
// Airport passengers and university students (src/cities/destinations.ts): daily trips beyond the commute.
export const SPECIAL = {
  /** Share of an airport's passengers who start or end their journey on the map by land (not changing planes). */
  airportLocal: 0.6,
  /** Travellers come from the whole map, weighted to where people live and work. */
  airportDecay: 25_000,
  /** At the airport between these times (s of day); the trip back (arrivals) 2–9 hours later. */
  airportFrom: 5 * HOUR,
  airportTo: 19 * HOUR,
  airportStay: [2 * HOUR, 9 * HOUR] as [number, number],
  /** Airport parking or a taxi, with luggage: generalised minutes added to driving. */
  airportParking: 35,
  /** Students on campus on a given weekday. */
  studentAttendance: 0.5,
  studentDecay: 6000,
  studentArrive: [9 * HOUR, 11 * HOUR + 30 * MIN] as [number, number],
  studentLeave: [13 * HOUR, 18 * HOUR + 30 * MIN] as [number, number],
  /** Students pay this share of the adult fare (London: the 18+ student discount). */
  studentFare: 0.7,
  /** Campus parking is scarce: generalised minutes added to driving. */
  studentParking: 15,
  /** Stations within this walk of an airport terminal or a campus serve it. */
  access: 1500,
  /** At most this many airport and student riders a day (real people; the agent pool). */
  maxRidersPerDay: 300_000,
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
   * v1's fixed rate; v2's market mean (BONDS.mean) and the coupon of bonds from older saves.
   * Tuned from the spec's starting 4%: at 4% the interest on the ~$17B a 40-station core needs
   * exceeds what ~1.5M daily riders pay at a $3 fare. At 2.5% such a core breaks even (fares ≈
   * operations + staffing + maintenance + interest) around 1.5M riders. See README → Balance.
   */
  bondRate: 0.025,
  bondYears: 30,
  bankruptcyDays: 30,
  /**
   * Distance fares (intertown): a journey's fare is the fare × (1 + km beyond fareFreeKm ÷
   * fareDistanceKm), km being the straight line from home to work. Infinity = one fare for any
   * distance (the metro cities, exactly v1).
   */
  fareDistanceKm: Infinity,
  fareFreeKm: 0,
};

// ---------------------------------------------------------------------------
// Operations control (v2): holding, timepoints, recovery, short turnarounds
export const OPS_CONTROL = {
  /** New routes hold departures at their first stop (routes from older saves start with it off). */
  defaultHold: true,
  /** Hold while the gap to the train ahead is under this × the scheduled headway; 0.6–0.8 performed best in the prototype. */
  holdFraction: 0.7,
  holdFractionChoices: [0.5, 0.6, 0.7, 0.8, 0.9],
  /** Longest hold at one timepoint, seconds: long enough to fix a bunch, short enough not to block a trunk. */
  maxHoldPerStop: 90,
  /** A held train leaves at once if another route's train is queued this close behind it, metres (≈ 2½ train lengths). */
  yieldLookback: 400,
  /** Default recovery for new routes: 10% of run time gave +1 train per core route and halved bunching. */
  defaultRecovery: 0.1,
  recoveryChoices: [0, 0.05, 0.1, 0.15, 0.2],
  /** Crews turn a train this fast, seconds, when the next departure is already due (v1 always took 3 min). */
  turnaroundMin: 120,
  /** Headways under this × scheduled count as bunched (the transit-industry "bunch" threshold). */
  bunchFactor: 0.5,
  /** Headways over this × scheduled count as gaps. */
  gapFactor: 1.5,
  /** Headways over this × scheduled are clamped in the statistics, so one service gap doesn't dominate. */
  maxHeadwayFactor: 4,
  /** Regularity grades for the route panel: CV under 0.25 "even", under 0.45 "uneven" (v1 core is 0.52). */
  cvGood: 0.25,
  cvFair: 0.45,
  /** Suggested recovery covers this multiple of the mean terminal lateness (headroom for spread). */
  recoverySuggestFactor: 1.5,
  /** Suggested timepoints: stops nearest these fractions along the route. */
  suggestTimepointsAt: [1 / 3, 2 / 3],
  /** Routes with fewer stops than this get one suggested timepoint, at the midpoint. */
  suggestOneBelow: 6,
};

// ---------------------------------------------------------------------------
// Fleet sales (v2)
export const FLEET = {
  /** Used cars sell for 40% of new: a cash lever, not free money (maintenance saved is only 1%/yr). */
  resaleFraction: 0.4,
};

// ---------------------------------------------------------------------------
// Research (src/core/tech.ts): projects bought with cash that take weekdays to finish, then
// upgrade trains (new marks you refit routes to), track, signalling, stations or costs. Costs are a
// share of the city's starting cash, so every map's tree costs the same in proportion.
export type ResearchId =
  | 'metro-2' | 'metro-3' | 'light-2' | 'commuter-2' | 'intercity-2' | 'hs-2' | 'hs-3'
  | 'tilting' | 'lightweight'
  | 'mainline-230' | 'hs-360'
  | 'cbtc' | 'ato' | 'driverless'
  | 'psd' | 'gates'
  | 'regen' | 'tbm' | 'viaducts'
  | 'labs-2'
  | 'eew' | 'snowproof';

export type ResearchBranch = 'trains' | 'track' | 'stations' | 'costs';

export interface ResearchDef {
  id: ResearchId;
  name: string;
  /** What it does, one line (the numbers are in the effects below and in tech.ts). */
  blurb: string;
  branch: ResearchBranch;
  /** Cost as a share of ECONOMY.startingCash (London £5B: 0.03 = £150M). */
  cost: number;
  /** Weekdays of work. */
  days: number;
  requires?: ResearchId[];
  /** Only on these maps (earthquake warning is Japan's). */
  only?: CityId[];
}

export const RESEARCH_BRANCHES: { id: ResearchBranch; name: string }[] = [
  { id: 'trains', name: 'Trains' },
  { id: 'track', name: 'Track & signalling' },
  { id: 'stations', name: 'Stations' },
  { id: 'costs', name: 'Costs & the lab' },
];

export const RESEARCH: ResearchDef[] = [
  { id: 'metro-2', branch: 'trains', name: 'Metro Mk II', blurb: 'Metro trains reach 110 km/h, pull away faster and carry 5% more', cost: 0.03, days: 30 },
  { id: 'metro-3', branch: 'trains', name: 'Metro Mk III', blurb: 'Metro trains reach 130 km/h with the fastest starts of any train, and carry 10% more', cost: 0.05, days: 60, requires: ['metro-2'] },
  { id: 'light-2', branch: 'trains', name: 'Light metro Mk II', blurb: 'Light metro reaches 120 km/h and carries 15% more in articulated cars', cost: 0.025, days: 30 },
  { id: 'commuter-2', branch: 'trains', name: 'Commuter Mk II', blurb: 'Commuter trains reach 200 km/h and accelerate harder', cost: 0.03, days: 40 },
  { id: 'intercity-2', branch: 'trains', name: 'Intercity Mk II', blurb: 'Intercity trains reach 250 km/h (on high-speed line) and get going quicker', cost: 0.04, days: 50 },
  { id: 'hs-2', branch: 'trains', name: 'High-speed Mk II', blurb: 'High-speed trains reach 320 km/h and accelerate harder', cost: 0.04, days: 50 },
  { id: 'hs-3', branch: 'trains', name: 'High-speed Mk III', blurb: '360 km/h high-speed trains (on 360 km/h line), the fastest wheels can go', cost: 0.06, days: 80, requires: ['hs-2', 'hs-360'] },
  { id: 'tilting', branch: 'trains', name: 'Tilting trains', blurb: 'Commuter, intercity and high-speed trains take curves 20% faster', cost: 0.035, days: 45 },
  { id: 'lightweight', branch: 'trains', name: 'Lightweight carbodies', blurb: 'Every train accelerates 8% harder and costs 10% less to run per car-km', cost: 0.03, days: 40, requires: ['regen'] },
  { id: 'mainline-230', branch: 'track', name: 'Upgraded main lines', blurb: 'Ordinary heavy track runs at up to 230 km/h (was 200)', cost: 0.04, days: 50 },
  { id: 'hs-360', branch: 'track', name: '360 km/h high-speed line', blurb: 'High-speed track runs at up to 360 km/h (was 320)', cost: 0.06, days: 70 },
  { id: 'cbtc', branch: 'track', name: 'Moving-block signalling', blurb: 'Trains run closer together: 90-second headways and 40% fewer signal failures', cost: 0.05, days: 60 },
  { id: 'ato', branch: 'track', name: 'Automatic train operation', blurb: 'Computer-driven trains: dwells 5 s shorter and tighter timetables', cost: 0.04, days: 45, requires: ['cbtc'] },
  { id: 'driverless', branch: 'track', name: 'Driverless trains', blurb: 'No cab crew: train operations cost 15% less', cost: 0.06, days: 70, requires: ['ato'] },
  { id: 'psd', branch: 'stations', name: 'Platform screen doors', blurb: 'Boarding 15% faster and 40% fewer police incidents on the tracks', cost: 0.03, days: 40 },
  { id: 'gates', branch: 'stations', name: 'Contactless gates', blurb: 'Every station holds 20% more people before it gets crowded', cost: 0.02, days: 25 },
  { id: 'regen', branch: 'costs', name: 'Regenerative braking', blurb: 'Braking trains feed power back: operations 20% cheaper per car-km', cost: 0.03, days: 40 },
  { id: 'tbm', branch: 'costs', name: 'Better tunnel boring', blurb: 'Deep and cut-and-cover track 20% cheaper, their stations 15% cheaper, 25% quicker to dig', cost: 0.04, days: 50 },
  { id: 'viaducts', branch: 'costs', name: 'Precast viaducts', blurb: 'Elevated track 20% cheaper, its stations 15% cheaper, 30% quicker to build', cost: 0.03, days: 40 },
  { id: 'labs-2', branch: 'costs', name: 'Second design team', blurb: 'Run two research projects at once', cost: 0.02, days: 20 },
  { id: 'eew', branch: 'track', name: 'Earthquake early warning', blurb: 'Seismometers along the coast cut the power before the shaking arrives: earthquake stops are half as long', cost: 0.03, days: 40, only: ['japan'] },
  { id: 'snowproof', branch: 'track', name: 'Snow sprinklers and heated points', blurb: 'Snow and storms slow your trains half as much', cost: 0.03, days: 40, only: ['japan'] },
];

export const RESEARCH_TUNING = {
  /** Projects at once, and with the second design team. */
  slots: 1,
  slotsWithLabs: 2,
  /** Cancelling a project refunds this share of what it cost. */
  cancelRefund: 0.5,
  /** Refitting a route's trains to a newer mark costs this share of the new cars' price. */
  refitShare: 0.35,
};

/**
 * Train marks: Mk I is TRAINS as written; each later mark (unlocked by its research) replaces the
 * speed and acceleration, scales capacity and the price of new cars. A route runs one mark;
 * refit it in the route panel or Routes & stations.
 */
export interface TrainMark {
  name: string;
  research?: ResearchId;
  topSpeed: number;
  accel: number;
  brake: number;
  capacity: number;
  costMult: number;
}

export const TRAIN_MARKS: Record<StockId, TrainMark[]> = {
  heavy: [
    { name: 'Mk I', topSpeed: 90 * KMH, accel: 1.1, brake: 1.2, capacity: 1, costMult: 1 },
    { name: 'Mk II', research: 'metro-2', topSpeed: 110 * KMH, accel: 1.25, brake: 1.3, capacity: 1.05, costMult: 1.1 },
    { name: 'Mk III', research: 'metro-3', topSpeed: 130 * KMH, accel: 1.35, brake: 1.4, capacity: 1.1, costMult: 1.2 },
  ],
  light: [
    { name: 'Mk I', topSpeed: 100 * KMH, accel: 1.3, brake: 1.3, capacity: 1, costMult: 1 },
    { name: 'Mk II', research: 'light-2', topSpeed: 120 * KMH, accel: 1.35, brake: 1.35, capacity: 1.15, costMult: 1.1 },
  ],
  commuter: [
    { name: 'Mk I', topSpeed: 160 * KMH, accel: 0.8, brake: 0.9, capacity: 1, costMult: 1 },
    { name: 'Mk II', research: 'commuter-2', topSpeed: 200 * KMH, accel: 0.95, brake: 1.0, capacity: 1, costMult: 1.12 },
  ],
  intercity: [
    { name: 'Mk I', topSpeed: 200 * KMH, accel: 0.5, brake: 0.7, capacity: 1, costMult: 1 },
    { name: 'Mk II', research: 'intercity-2', topSpeed: 250 * KMH, accel: 0.6, brake: 0.75, capacity: 1, costMult: 1.15 },
  ],
  highspeed: [
    { name: 'Mk I', topSpeed: 300 * KMH, accel: 0.45, brake: 0.65, capacity: 1, costMult: 1 },
    { name: 'Mk II', research: 'hs-2', topSpeed: 320 * KMH, accel: 0.55, brake: 0.7, capacity: 1, costMult: 1.1 },
    { name: 'Mk III', research: 'hs-3', topSpeed: 360 * KMH, accel: 0.6, brake: 0.75, capacity: 1, costMult: 1.25 },
  ],
};

/** The size of each research effect (tech.ts applies them). */
export const TECH_EFFECTS = {
  tiltCurve: 1.2,
  tiltStocks: ['commuter', 'intercity', 'highspeed'] as StockId[],
  lightweightAccel: 1.08,
  lightweightOperating: 0.9,
  mainlineSpeed: 230 * KMH,
  hsLineSpeed: 360 * KMH,
  cbtcSafetyMargin: 40,
  cbtcHeadway: 1.5,
  cbtcSignalFailures: 0.6,
  atoDwellCut: 5,
  driverlessOperating: 0.85,
  psdBoarding: 0.85,
  psdPolice: 0.6,
  gatesCapacity: 1.2,
  regenOperating: 0.8,
  tbmCost: 0.8,
  tbmStationCost: 0.85,
  tbmDays: 0.75,
  viaductCost: 0.8,
  viaductStationCost: 0.85,
  viaductDays: 0.7,
  /** Earthquake early warning: quake restrictions last this share as long. */
  eewDuration: 0.5,
  /** Snow sprinklers: weather slows trains this share as much. */
  snowproofSlowdown: 0.5,
};

// ---------------------------------------------------------------------------
// Fares (v2). Each city's default policy for new games is CITY_BALANCE[city].fares; the range and
// step are ECONOMY.fareMin / fareMax / fareStep (per city).
export const FARES = {
  /** Periods (OPERATIONS.periods ids) billed at the peak fare: 96% of commuter trips start in these. */
  peakPeriods: ['am', 'pm'] as readonly string[],
  /** Low-income fare multipliers offered for the lowest earnings band: full, half, free. */
  lowIncomeChoices: [1, 0.5, 0],
  /** Earnings band that gets the low-income fare (New York SE01, ≤ $1,250/month; London's lowest modelled band). */
  lowIncomeBand: 0,
  /** For classifying the trip home as peak or off-peak: the morning trip length assumed (as the mid-day-load rule in commuters.ts). */
  amTripEstimate: 30 * MIN,
};

// ---------------------------------------------------------------------------
// Bond market (v2)
export const BONDS = {
  /** Long-run mean of the base rate: v1's tuned fixed rate, so the economy is centred where it was. */
  mean: 0.025,
  /** Base rate in the first month (month 1 borrowing is exactly v1). */
  start: 0.025,
  /** Share of the gap to the mean closed each month (half-life ≈ 5.4 months). */
  reversion: 0.12,
  /** Monthly σ of the base rate; stationary sd ≈ 0.42%, so most months are between 1.7% and 3.3%. */
  volatility: 0.002,
  /** Hard bounds on the base rate. */
  minRate: 0.01,
  maxRate: 0.06,
  /** About one shock every two years, of 0.75%, three in five upward. */
  shockChance: 0.04,
  shockSize: 0.0075,
  shockUpShare: 0.6,
  /** Market seed for headless games without a chaos seed and for tests (games derive theirs from the game seed). */
  defaultSeed: 20300107,
  /** Bond term in months (= ECONOMY.bondYears × 12). */
  termMonths: 360,
  /** Prepayment penalty on the amount prepaid: small enough to use idle cash, big enough to think about. */
  prepayPenalty: 0.01,
  /** Refinancing fee on the balance: a 0.5% rate cut pays it back in about 2 years. */
  refinanceFee: 0.01,
  /** Refinance only when the new rate is at least this much lower (avoids pointless churn). */
  refinanceMinGain: 0.0005,
  /** Prepayment amounts offered (plus "all"). */
  prepayChoices: [250e6, 500e6],
  /** Months of market history kept for charts and reviews. */
  historyMonths: 360,
};

// ---------------------------------------------------------------------------
// Credit rating (v2). Scores are 0–100 per metric, piecewise-linear between anchors. Every metric is a
// ratio or a number of months, so the same anchors work in any currency.
export const CREDIT = {
  ratings: ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC'] as const,
  /** Minimum score per notch (AAA … B); below the last is CCC. The README core lands at BBB. */
  thresholds: [85, 75, 65, 52, 40, 28],
  /** Spread over the base rate per notch: AAA borrows at the market rate, CCC at +4.5%. */
  spreads: [0, 0.001, 0.0025, 0.006, 0.0125, 0.025, 0.045],
  /** Score margin needed to move a notch (stops month-to-month flapping). */
  hysteresis: 2,
  /** Settled days used for the review (about 3 months). */
  windowDays: 60,
  /** Fewer service days than this and farebox and coverage are "not rated" (construction phase). */
  minServiceDays: 10,
  /** Points for a metric that is not rated yet: new authorities are trusted until fares flow. */
  notRatedPoints: 80,
  weights: { farebox: 0.3, coverage: 0.3, leverage: 0.25, liquidity: 0.15 },
  /** Fare revenue ÷ operating costs (v1 core: 1.59). */
  farebox: { x: [0.5, 1.0, 1.5, 2.0], y: [0, 50, 80, 100] },
  /** Net operating income ÷ (interest + one new bond's interest) (v1 core: 0.75). */
  coverage: { x: [0, 0.5, 1.0, 1.5, 3.0], y: [0, 30, 55, 75, 100] },
  /** Debt ÷ (assets + cash) (v1 core: 0.72). */
  leverage: { x: [0, 0.3, 0.6, 0.8, 1.0], y: [100, 85, 55, 30, 0] },
  /** Months of operating costs + debt service covered by cash. */
  liquidity: { x: [0, 3, 12], y: [0, 50, 100] },
  /** Weekdays per month for the liquidity denominator. */
  daysPerMonth: 21.75,
};

// ---------------------------------------------------------------------------
// Goals
export const GOALS = {
  riderMilestones: [500_000, 1_000_000, 2_000_000, 3_000_000],
  modeShareTarget: 0.5,
  commuteSavingMinutes: 10,
  /** The timed-trip goal: door to door by transit from tripFrom to tripTo in under tripMinutes. */
  tripMinutes: 45,
  /** New York: Midtown (Bryant Park) to the JFK terminal area. */
  tripFrom: [-73.9832, 40.7536] as [number, number],
  tripTo: [-73.7781, 40.6413] as [number, number],
  /** 'rating-a' goal: this rating or better while owing at least this much. */
  ratingGoal: 'A' as (typeof CREDIT.ratings)[number],
  ratingGoalMinDebt: 5e9,
  /** 'clockwork' goal: network bunched share under this, with this many routes and riders. */
  clockworkBunched: 0.05,
  clockworkMinRoutes: 3,
  clockworkMinRiders: 500_000,
  /** Living City 'boomtown' goal: one tract (≥ GROWTH.minTractPeople) grows this much since the start. */
  boomtownGrowth: 0.25,
  /** Living City 'value-capture' goal: one month's value-capture payment (city currency). */
  valueCaptureMonth: 10e6,
};

// ---------------------------------------------------------------------------
// Living City (v2): transit-oriented growth and value capture (docs/v2/living-city.md). New York's
// values; each city's differences are CITY_BALANCE[city].growth / .valueCapture.
export type GrowthPace = 'off' | 'steady' | 'boom';

/** Residents or jobs: how one side of a tract responds to its attractiveness. */
export interface GrowthSide {
  /** Extra growth per month at attractiveness 1 (before the pace multiplier). */
  boostPerMonth: number;
  /** Share of the boost drained uniformly from the whole city (relocation); the rest is in-migration. */
  relocationShare: number;
  /** Hard monthly limits before the pace multiplier (building takes time). */
  maxGrowthPerMonth: number;
  maxDeclinePerMonth: number;
  /** Long-run bounds against the start; the boost fades smoothly toward them. */
  maxMultiple: number;
  minMultiple: number;
}

export const GROWTH = {
  /** How fast the city reacts (menu → City growth). 'off' = frozen city, no value capture (v1 rules). */
  paceMultiplier: { off: 0, steady: 1, boom: 3 } as Record<GrowthPace, number>,
  paces: ['off', 'steady', 'boom'] as GrowthPace[],
  defaultPace: 'steady' as GrowthPace,
  /** Natural growth of the city's commuters per year, residents and jobs alike (New York ≈ +0.8%/yr over the 2010s, Census 2010→2020 +7.7%). */
  cityGrowthPerYear: 0.008,
  /** The city as a whole stays below this multiple of its starting commuters (caps New York's agents at ≈ 428k). */
  cityMaxMultiple: 1.5,
  /** Commute benefit (generalised minutes saved per commute vs no network) at which attractiveness is 0.5. */
  halfBenefit: 20,
  residents: {
    /** A typical well-served tract (s ≈ 0.55) grows ≈ 4–5% a year on Steady. */
    boostPerMonth: 0.006,
    relocationShare: 0.6,
    maxGrowthPerMonth: 0.012,
    maxDeclinePerMonth: 0.004,
    maxMultiple: 2,
    minMultiple: 0.7,
  } as GrowthSide,
  jobs: {
    /** Employers follow labour-market access more slowly than homes follow commutes, and mostly move within the city. */
    boostPerMonth: 0.004,
    relocationShare: 0.7,
    maxGrowthPerMonth: 0.01,
    maxDeclinePerMonth: 0.003,
    maxMultiple: 2,
    minMultiple: 0.7,
  } as GrowthSide,
  /** Furness (IPF) passes per month, warm-started from last month's factors. */
  balanceIterations: 2,
  /** Tract snapshots kept for the tract panel's history chart; older months are thinned to fit. */
  historyMax: 60,
  /** City rows kept (one per month close). */
  cityMax: 600,
  /** Reports, toasts and goals ignore tracts smaller than this (residents + jobs at the start). */
  minTractPeople: 1000,
  /** Boomtowns listed in the month report. */
  boomtownsInReport: 5,
  /**
   * A tract is a boomtown only when it grew at least this multiple of the city's natural rate at
   * the pace that month (Steady: New York 0.13%/month, London 0.18%), so a city growing at its
   * natural rate alone (no network, or a sprawl one) lists none.
   */
  boomtownMinNaturalMultiple: 2,
  /** Toast the month's top boomtown when it grew at least this much that month (Steady's best is ≈ 0.35–0.45%)… */
  boomToastMonthlyRate: 0.003,
  /** …by at least this many residents and jobs (real people), and it was not the last tract toasted (no news). */
  boomToastMinPeople: 25,
  /** Since-start thresholds that trigger milestone toasts (up to milestonesInReport a month). */
  milestonesUp: [0.1, 0.25, 0.5, 1],
  milestonesDown: [-0.05, -0.1, -0.2],
  milestonesInReport: 3,
};

export const VALUE_CAPTURE = {
  /**
   * Transit Improvement District: the part of each tract within this distance of a served station
   * (½ mile, the walk catchment). Membership is the share of the tract's area inside it (sampled),
   * so London's larger MSOAs count only their station-side part.
   */
  districtRadius: 800,
  /**
   * Market value per commuter living / working in a tract (start-year money). New York, DOF FY2025
   * tentative roll: $1.11T of homes (class 1 $739B + class 2 $370B) over 2.85M resident commuters,
   * $330B of offices and shops (class 4) over 2.85M jobs.
   */
  valuePerResident: 390_000,
  valuePerJob: 115_000,
  /**
   * Effective annual property tax on market value. New York: the ≈ $34B levy split by class shares
   * (class 1 14%, class 2 39%, class 4 38%) gives homes ≈ $18B on $1.11T ≈ 1.6% and commercial
   * ≈ $13B on $330B ≈ 3.9%.
   */
  taxRateHomes: 0.016,
  taxRateJobs: 0.039,
  /** Land-value premium at attractiveness 1 (studies find +5–25% near rail stations). */
  premiumMax: 0.12,
  /** Share of the gap to the target premium that capitalises each month (≈ 10-month lag). */
  premiumLagPerMonth: 0.1,
  /**
   * Share of the district's tax increment pledged to the authority (tax-increment financing; Hudson
   * Yards' bonds for the 7 line were backed by the district's PILOTs and tax increment). Tuned: the
   * README core earns ≈ $0.35M/day by month 12 on Steady (docs/v2/living-city.md, implementation notes).
   */
  captureShare: 0.12,
};

// ---------------------------------------------------------------------------
// City chaos: events, disruptions and weather (v2). These are shared by every city; each city's
// venues, event kinds and climate are in CHAOS_BY_CITY below (CITY_BALANCE[city].chaos).
export type ChaosLevel = 'off' | 'calm' | 'normal' | 'wild';
export type WeatherKind = 'clear' | 'rain' | 'snow' | 'heat';
export type IncidentKind = 'signal' | 'breakdown' | 'sick' | 'police';

export interface VenueDef {
  key: string;
  /** Generic place name ("Midtown arena"): no team, league or venue trademarks. */
  name: string;
  lon: number;
  lat: number;
  /** The region (borough) the venue is in: driving there is slow if it is a core region. */
  region: string;
  /** Extra drive time and money for event parking (traffic, queues, the walk from the car park). */
  parkingTime: number;
  parkingCost: number;
}

export interface EventKindDef {
  venue: string;
  label: string;
  /** Months it can happen in (0 = Jan). */
  months: number[];
  /** Chance per weekday in season (Σ over a venue's kinds × CHAOS.eventChance.wild ≤ 1). */
  chance: number;
  attendance: [number, number];
  /** Start hour options as [hour, weight]. */
  starts: [number, number][];
  duration: number;
  /** Fans' target arrival, offset from the start (triangular), seconds. */
  arrive: [number, number];
  /** Fans' departure, offset from the end (triangular), seconds. */
  leave: [number, number];
  /** Only between these dates (inclusive): [month0, day0, month1, day1]. */
  window?: [number, number, number, number];
  /** Only on these days of the week (1 = Mon … 5 = Fri). */
  weekdays?: number[];
  /** Days of notice (default EVENTS.announceDays). */
  announce?: number;
  /** How far people come from: origin weight ∝ exp(−d / originDecay) (default EVENTS.originDecay). */
  originDecay?: number;
}

/** Chance of each weather kind per weekday, by month (Jan…Dec). */
export interface ClimateDef {
  snow: number[];
  rain: number[];
  heat: number[];
  /** Share of the map a weather day touches, scaling its effects (national maps: well under 1). */
  reach?: number;
}

/**
 * Earthquakes (Japan): on a strong enough tremor every train within reach of the epicentre stops,
 * then runs at a crawl while the line is inspected.
 */
export interface QuakeDef {
  /** Chance per weekday at the Normal level (the level's incident rate scales it). */
  chance: number;
  /** Where they strike: [lon, lat, weight]. */
  zones: [number, number, number][];
  /** Epicentres scatter this far (degrees) around a zone's point. */
  scatter: number;
  /** Trains within this radius of the epicentre stop (uniform in the range), m. */
  radius: [number, number];
  /** How long the lines are restricted, s. */
  duration: [number, number];
}

export interface CityChaos {
  venues: VenueDef[];
  kinds: EventKindDef[];
  climate: ClimateDef;
  quakes?: QuakeDef;
}

export const CHAOS = {
  levels: ['off', 'calm', 'normal', 'wild'] as ChaosLevel[],
  /** New games; saves from before chaos existed migrate to this. */
  defaultLevel: 'normal' as ChaosLevel,
  /** Headless runs and migrated saves; new games draw their own seed on the main thread. */
  defaultSeed: 2030,
  /** Incident rate multiplier: Calm halves, Wild is the "make it crazy" setting. */
  rate: { off: 0, calm: 0.5, normal: 1, wild: 2.5 } as Record<ChaosLevel, number>,
  /** Weather chance multiplier (snow/rain/heat probabilities, scaled down so Σ ≤ weatherChanceMax). */
  weatherChance: { off: 0, calm: 1, normal: 1, wild: 1.5 } as Record<ChaosLevel, number>,
  weatherChanceMax: 0.9,
  /** Event chance multiplier per venue-day. */
  eventChance: { off: 0, calm: 1, normal: 1, wild: 1.25 } as Record<ChaosLevel, number>,
  /** Incidents happen between these times of day (trains run; people notice). */
  serviceStart: 5.5 * HOUR,
  serviceEnd: 23.5 * HOUR,
  /** Hard cap per kind per day (perf network at Wild ≈ 43 breakdowns → 40). */
  maxPerKindPerDay: 40,
  /** Core ≈ 1.8/day on 88 directed-track km; perf ≈ 11/day on 560 km. */
  signal: { perTrackKmDay: 1 / 50, segment: 800, crawl: 15 * KMH, duration: [15 * MIN, 60 * MIN] as [number, number] },
  /** Core ≈ 2.8/day on 27.6k planned train-km; perf ≈ 17/day on 171k. A stall stays under the 30-min watchdog. */
  breakdown: { perTrainKm: 1 / 10_000, duration: [5 * MIN, 20 * MIN] as [number, number] },
  /** Core ≈ 2.3/day; holds stay short so they nudge, not block. */
  sick: { perTrainKm: 1 / 12_000, duration: [3 * MIN, 8 * MIN] as [number, number] },
  /** Core ≈ 0.8/day (40 stations); busy stations are likelier (weight 1 + yesterday's boardings / busyWeight). */
  police: { perStationDay: 0.02, duration: [10 * MIN, 40 * MIN] as [number, number], waitOutside: 15 * MIN, busyWeight: 20_000 },
  /** Points sampled along a signal problem's segment for the map. */
  signalPathPoints: 17,
  /** Earthquakes (maps with CityChaos.quakes): the crawl while the line is inspected, and the sampling along track. */
  quake: { crawl: 30 * KMH, sampleStep: 1000 },
  /** Incident toasts only at 1×/5× (TIME.speeds index ≤ 1) unless severity 3; ticker always. */
  toastMaxSpeedIndex: 1,
  toastMinGapMs: 20_000,
};

export const WEATHER = {
  /** A snow or heat day continues into a clear-drawn next day with this chance (at carrySeverity × severity). */
  persist: 0.4,
  carrySeverity: 0.8,
  /** Forecasts are right this often; misses show lower confidence (50–70%). */
  forecastAccuracy: 0.8,
  /** Severity is uniform in [minSeverity, 1]; effects scale linearly; ≥ heavyAt is "Heavy …"/"Heat wave". */
  minSeverity: 0.5,
  heavyAt: 0.85,
  /** Full-severity effects. walkPenalty is minutes added to the walk mode's generalised cost. */
  effects: {
    // Wet rails, umbrellas, nobody walks 2 km.
    rain: { walkSpeed: 0.92, walkPenalty: 8, driveSpeed: 0.85, outdoorSpeed: 1, dwell: 1.05, crowd: 1.1, rates: { signal: 1.5, breakdown: 1.1, sick: 1, police: 0.8 } },
    // Elevated and at-grade track capped at 55% of top speed (90 km/h → ~50 km/h).
    snow: { walkSpeed: 0.75, walkPenalty: 15, driveSpeed: 0.6, outdoorSpeed: 0.55, dwell: 1.15, crowd: 1.1, rates: { signal: 2, breakdown: 1.5, sick: 1, police: 0.7 } },
    // AC failures, heat slow orders, hot crowded cars.
    heat: { walkSpeed: 0.9, walkPenalty: 6, driveSpeed: 0.95, outdoorSpeed: 0.85, dwell: 1.05, crowd: 1.35, rates: { signal: 1.3, breakdown: 2, sick: 2.5, police: 1.2 } },
  } as Record<Exclude<WeatherKind, 'clear'>, { walkSpeed: number; walkPenalty: number; driveSpeed: number; outdoorSpeed: number; dwell: number; crowd: number; rates: Record<IncidentKind, number> }>,
};

export const EVENTS = {
  /** Days of notice (a kind can override, e.g. parades 5). */
  announceDays: 3,
  /** Agent pool: at most this many event-goers by transit per day (poolCap = ceil(/ agentScale)). */
  maxPeoplePerDay: 200_000,
  /** Origin weight = residents · exp(−d / originDecay): city-wide draw, mild pull to nearby areas. */
  originDecay: 12_000,
  /** Stations within this walk of the venue serve it (crowds won't walk as far as commuters). */
  venueAccess: 1500,
  /** Fans' destination points scatter this far around the venue. */
  venueScatter: 150,
  /** Expected crowding minutes added to event transit costs (packed trains). */
  crowdMinutes: 4,
  /** Fans leave home path.time × this before their target arrival. */
  tripBuffer: 1.15,
  /** Wrap-up alert this long after the event ends. */
  wrapUpAfter: 2 * HOUR,
  /** Event service: routes stopping within this of the venue are pre-selected. */
  serviceRadius: 1200,
  serviceHeadway: 3,
  serviceBefore: [-2 * HOUR, 15 * MIN] as [number, number],
  serviceAfter: [-15 * MIN, 90 * MIN] as [number, number],
};

export const UNITS = { KMH, MIN, HOUR };

const ALL_MONTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** Midweek football season (Aug–May) and nights (Tue–Thu). */
const FOOTBALL_MONTHS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const MIDWEEK = [2, 3, 4];

/**
 * New York: venues, event kinds and climate. Weather chances are rounded NYC climatology for
 * commute-disrupting days: ≈ 12 snow, 21 rain and 10 heat days a year (with carry-over).
 */
const NYC_CHAOS: CityChaos = {
  venues: [
    { key: 'bronx-ballpark', name: 'Bronx ballpark', lon: -73.9262, lat: 40.8296, region: 'Bronx', parkingTime: 25 * MIN, parkingCost: 35 },
    { key: 'queens-ballpark', name: 'Queens ballpark', lon: -73.8456, lat: 40.7571, region: 'Queens', parkingTime: 20 * MIN, parkingCost: 30 },
    { key: 'midtown-arena', name: 'Midtown arena', lon: -73.9934, lat: 40.7505, region: 'Manhattan', parkingTime: 30 * MIN, parkingCost: 50 },
    { key: 'brooklyn-arena', name: 'Brooklyn arena', lon: -73.9754, lat: 40.6826, region: 'Brooklyn', parkingTime: 25 * MIN, parkingCost: 40 },
    { key: 'flushing-tennis', name: 'Flushing tennis centre', lon: -73.8467, lat: 40.7499, region: 'Queens', parkingTime: 25 * MIN, parkingCost: 40 },
    { key: 'downtown-parade', name: 'Lower Broadway', lon: -74.0105, lat: 40.709, region: 'Manhattan', parkingTime: 45 * MIN, parkingCost: 50 },
    { key: 'central-park', name: 'Central Park Great Lawn', lon: -73.9665, lat: 40.7812, region: 'Manhattan', parkingTime: 30 * MIN, parkingCost: 45 },
    { key: 'coney-island', name: 'Coney Island boardwalk', lon: -73.9787, lat: 40.5743, region: 'Brooklyn', parkingTime: 20 * MIN, parkingCost: 25 },
  ],
  kinds: [
    { venue: 'bronx-ballpark', label: 'Bronx ballpark game', months: [3, 4, 5, 6, 7, 8], chance: 0.42, attendance: [28_000, 46_000],
      starts: [[19.08, 0.7], [13.08, 0.3]], duration: 3 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-20 * MIN, 40 * MIN] },
    { venue: 'queens-ballpark', label: 'Queens ballpark game', months: [3, 4, 5, 6, 7, 8], chance: 0.42, attendance: [24_000, 42_000],
      starts: [[19.17, 0.7], [13.17, 0.3]], duration: 3 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-20 * MIN, 40 * MIN] },
    { venue: 'midtown-arena', label: 'Midtown arena game', months: [0, 1, 2, 3, 9, 10, 11], chance: 0.25, attendance: [17_000, 19_800],
      starts: [[19.5, 1]], duration: 2.5 * HOUR, arrive: [-75 * MIN, 5 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'midtown-arena', label: 'Midtown arena concert', months: ALL_MONTHS, chance: 0.2, attendance: [15_000, 19_500],
      starts: [[20, 1]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'brooklyn-arena', label: 'Brooklyn arena game', months: [0, 1, 2, 3, 9, 10, 11], chance: 0.25, attendance: [14_000, 17_700],
      starts: [[19.5, 1]], duration: 2.5 * HOUR, arrive: [-75 * MIN, 5 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'brooklyn-arena', label: 'Brooklyn arena concert', months: ALL_MONTHS, chance: 0.12, attendance: [13_000, 18_000],
      starts: [[20, 1]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'flushing-tennis', label: 'Flushing tennis open', months: [7, 8], window: [7, 26, 8, 8], chance: 1, attendance: [35_000, 50_000],
      starts: [[11, 1]], duration: 11 * HOUR, arrive: [-60 * MIN, 5 * HOUR], leave: [-6 * HOUR, 30 * MIN] },
    { venue: 'downtown-parade', label: 'Downtown parade', months: ALL_MONTHS, chance: 0.012, attendance: [80_000, 150_000],
      starts: [[11, 1]], duration: 2.5 * HOUR, arrive: [-2 * HOUR, 0], leave: [-30 * MIN, 40 * MIN], announce: 5 },
    { venue: 'central-park', label: 'Central Park summer concert', months: [5, 6, 7], chance: 0.08, attendance: [30_000, 60_000],
      starts: [[19, 1]], duration: 3 * HOUR, arrive: [-2 * HOUR, 30 * MIN], leave: [-20 * MIN, 30 * MIN] },
    { venue: 'coney-island', label: 'Coney Island fireworks', months: [5, 6, 7], weekdays: [5], chance: 0.8, attendance: [8_000, 20_000],
      starts: [[21.5, 1]], duration: 0.75 * HOUR, arrive: [-2 * HOUR, 0], leave: [0, 30 * MIN] },
  ],
  climate: {
    snow: [0.14, 0.13, 0.07, 0.01, 0, 0, 0, 0, 0, 0, 0.01, 0.07],
    rain: [0.06, 0.06, 0.08, 0.09, 0.09, 0.09, 0.1, 0.1, 0.08, 0.08, 0.08, 0.07],
    heat: [0, 0, 0, 0, 0.01, 0.07, 0.14, 0.11, 0.03, 0, 0, 0],
  },
};

/**
 * London: venues, event kinds and climate. Football is midweek evenings (Tue–Thu) in season;
 * the tennis fortnight and the Oval test match are fixed windows. The climate has far fewer snow
 * days than New York (≈ 2–3 a year), more wet commutes (≈ 32) and only a couple of heat days.
 */
const LONDON_CHAOS: CityChaos = {
  venues: [
    { key: 'wembley', name: 'Wembley stadium', lon: -0.2796, lat: 51.556, region: 'Brent', parkingTime: 40 * MIN, parkingCost: 35 },
    { key: 'stratford', name: 'Stratford stadium', lon: -0.0166, lat: 51.5387, region: 'Newham', parkingTime: 35 * MIN, parkingCost: 30 },
    { key: 'holloway', name: 'Holloway stadium', lon: -0.1084, lat: 51.5549, region: 'Islington', parkingTime: 40 * MIN, parkingCost: 35 },
    { key: 'tottenham', name: 'Tottenham stadium', lon: -0.0664, lat: 51.6043, region: 'Haringey', parkingTime: 40 * MIN, parkingCost: 35 },
    { key: 'greenwich-arena', name: 'Greenwich peninsula arena', lon: 0.0032, lat: 51.503, region: 'Greenwich', parkingTime: 25 * MIN, parkingCost: 30 },
    { key: 'twickenham', name: 'Twickenham stadium', lon: -0.3415, lat: 51.456, region: 'Richmond upon Thames', parkingTime: 35 * MIN, parkingCost: 40 },
    { key: 'wimbledon', name: 'Wimbledon tennis grounds', lon: -0.2143, lat: 51.434, region: 'Merton', parkingTime: 30 * MIN, parkingCost: 35 },
    { key: 'oval', name: 'Kennington Oval', lon: -0.115, lat: 51.4837, region: 'Lambeth', parkingTime: 35 * MIN, parkingCost: 30 },
    { key: 'hyde-park', name: 'Hyde Park', lon: -0.1605, lat: 51.5073, region: 'Westminster', parkingTime: 35 * MIN, parkingCost: 40 },
    { key: 'whitehall', name: 'Whitehall', lon: -0.1265, lat: 51.5045, region: 'Westminster', parkingTime: 45 * MIN, parkingCost: 45 },
  ],
  kinds: [
    { venue: 'wembley', label: 'Wembley stadium match', months: [2, 5, 8, 9, 10], weekdays: [1, 2, 3, 4], chance: 0.07, attendance: [60_000, 90_000],
      starts: [[19.75, 1]], duration: 2 * HOUR, arrive: [-2 * HOUR, 5 * MIN], leave: [-10 * MIN, 40 * MIN] },
    { venue: 'wembley', label: 'Wembley stadium concert', months: [5, 6, 7], chance: 0.12, attendance: [75_000, 90_000],
      starts: [[19.5, 1]], duration: 3 * HOUR, arrive: [-2.5 * HOUR, 30 * MIN], leave: [-15 * MIN, 40 * MIN] },
    { venue: 'stratford', label: 'Stratford stadium match', months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance: 0.08, attendance: [50_000, 62_500],
      starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN] },
    { venue: 'holloway', label: 'North London football', months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance: 0.1, attendance: [55_000, 60_700],
      starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN] },
    { venue: 'tottenham', label: 'Tottenham football', months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance: 0.09, attendance: [52_000, 62_800],
      starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN] },
    { venue: 'greenwich-arena', label: 'Greenwich arena concert', months: ALL_MONTHS, chance: 0.3, attendance: [14_000, 20_000],
      starts: [[20, 0.7], [19.5, 0.3]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'twickenham', label: 'Twickenham rugby', months: [1, 2, 10], weekdays: [5], chance: 0.25, attendance: [60_000, 82_000],
      starts: [[20, 1]], duration: 2 * HOUR, arrive: [-2 * HOUR, 5 * MIN], leave: [-10 * MIN, 40 * MIN] },
    { venue: 'wimbledon', label: 'Wimbledon tennis fortnight', months: [5, 6], window: [5, 24, 6, 7], chance: 1, attendance: [38_000, 42_000],
      starts: [[11, 1]], duration: 9.5 * HOUR, arrive: [-60 * MIN, 4 * HOUR], leave: [-6 * HOUR, 30 * MIN] },
    { venue: 'oval', label: 'Oval cricket test match', months: [7], window: [7, 22, 7, 26], chance: 1, attendance: [20_000, 27_500],
      starts: [[11, 1]], duration: 7.5 * HOUR, arrive: [-60 * MIN, 2 * HOUR], leave: [-3 * HOUR, 30 * MIN] },
    { venue: 'hyde-park', label: 'Hyde Park summer concert', months: [5, 6], chance: 0.1, attendance: [50_000, 65_000],
      starts: [[18, 1]], duration: 4.5 * HOUR, arrive: [-3 * HOUR, 60 * MIN], leave: [-30 * MIN, 40 * MIN] },
    { venue: 'whitehall', label: 'Whitehall parade', months: ALL_MONTHS, chance: 0.008, attendance: [60_000, 120_000],
      starts: [[11, 1]], duration: 2.5 * HOUR, arrive: [-2 * HOUR, 0], leave: [-30 * MIN, 40 * MIN], announce: 5 },
  ],
  climate: {
    snow: [0.03, 0.03, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0.02],
    rain: [0.15, 0.12, 0.12, 0.11, 0.11, 0.1, 0.1, 0.11, 0.11, 0.15, 0.16, 0.15],
    heat: [0, 0, 0, 0, 0, 0.01, 0.04, 0.03, 0.005, 0, 0, 0],
  },
};

// ---------------------------------------------------------------------------
// Cities
export type CityId = 'nyc' | 'london' | 'southeast' | 'manchester' | 'birmingham' | 'leeds' | 'bristol' | 'japan';
type LL = [number, number];

/** Where a job counts as being in the CBD (parking penalty). */
export type ZoneRule =
  | { kind: 'region-south-of'; region: string; lat: number }
  | { kind: 'polygon'; ring: LL[] };

export interface CityBalance {
  /** Local projection origin (lon, lat). */
  origin: LL;
  /** The local plane (core/geo.ts): equirectangular unless set (Japan: Lambert conformal conic). */
  projection?: Projection;
  map: { startCenter: LL; startZoom: number; bounds: [number, number, number, number]; minZoom?: number; landCell?: number; landClose?: boolean; trainMinZoom?: number };
  /** Camera behind the title screen (slow 3D orbit). */
  titleCamera: { center: LL; zoom: number; bearing: number };
  /** Regions (boroughs) with slow, congested driving. */
  coreRegions: string[];
  cbd: ZoneRule;
  commuters: Partial<
    Pick<
      typeof COMMUTERS,
      | 'driveSpeedCore' | 'driveSpeedOther' | 'driveLongAfter' | 'driveSpeedLong' | 'maxAccessWalk' | 'parkingCbdTime' | 'parkingCbdCost' | 'parkingOtherTime' | 'valueOfTime' | 'driveCostPerKm' | 'modeConstant'
      | 'walkSpeed' | 'walkDetour' | 'walkMaxDistance' | 'accessRadiusTractShare' | 'departMean' | 'departSd' | 'departMin' | 'departMax' | 'workDuration' | 'returnJitter' | 'logitScale' | 'waitCap' | 'transferPenalty'
    >
  >;
  economy: Partial<Pick<typeof ECONOMY, 'startingCash' | 'fareDefault' | 'fareMin' | 'fareMax' | 'fareStep' | 'fareDistanceKm' | 'fareFreeKm' | 'staffingPerStationDay' | 'operatingPerCarKm' | 'bondChunk' | 'bondMax'>>;
  /**
   * The fare policy of a new game (v2): peak (FARES.peakPeriods) and off-peak fares, and the
   * low-income multiplier for FARES.lowIncomeBand (1 = full fare). `ECONOMY.fareDefault` stays the
   * flat fare of older saves and of the all-off configuration.
   */
  fares: { peak: number; offPeak: number; lowIncome: number };
  /**
   * Credit scorecard anchors that differ from CREDIT's (v2). The metrics are ratios, so currency
   * doesn't enter; ridership does: a city whose network carries fewer riders per unit of cost is
   * judged against its own benchmark, so its benchmark core rates like New York's.
   */
  credit: Partial<Pick<typeof CREDIT, 'farebox' | 'coverage'>>;
  goals: Partial<typeof GOALS>;
  /** Event venues and kinds, and the climate (CHAOS_BY_CITY). */
  chaos: CityChaos;
  /** Track numbers that differ from TRACK (intertown: wider main-line curves). */
  track?: Partial<Pick<typeof TRACK, 'filletMaxTangent' | 'costPerM' | 'daysPerKm' | 'densityK' | 'densityAffects' | 'mountainK' | 'bridgeMultiplier'>>;
  /** Station numbers that differ from STATION (cheaper building outside London). */
  station?: Partial<Pick<typeof STATION, 'costByLevel' | 'buildDays' | 'costPerCar'>>;
  /** A new route's headways and the choices offered, where they differ from OPERATIONS (Japan: every 15–60 min). */
  operations?: { defaultHeadways?: Partial<typeof OPERATIONS.defaultHeadways>; headwayChoices?: number[] };
  /** Airport and university numbers that differ from SPECIAL (Japan: passengers come from further). */
  special?: Partial<typeof SPECIAL>;
  /** Event numbers that differ from EVENTS. */
  events?: Partial<Pick<typeof EVENTS, 'originDecay' | 'venueAccess' | 'maxPeoplePerDay'>>;
  /** Incident rates that differ from CHAOS (per track-km, train-km or station a day). */
  incidents?: { signal?: number; breakdown?: number; sick?: number; police?: number };
  /** The school run: values that differ from SCHOOLS, and the term calendar ('uk' or 'us'). */
  schools?: Partial<Pick<typeof SCHOOLS, 'originDecay' | 'childFare'>> & { terms?: 'uk' | 'us' };
  /**
   * Stations every new game starts with, built and free (intertown: the London terminal). Each is
   * a straight stub of track (lon/lat ends) with a platform at `at` metres from the first end.
   */
  hubs?: HubDef[];
  /** Tunnel-only zone (lon, lat polygon): track and stations inside must be underground. */
  tunnelZone?: { name: string; poly: LL[] };
  /** Living City (v2): growth numbers that differ from GROWTH (nested sides are replaced whole). */
  growth: Partial<typeof GROWTH>;
  /** Living City (v2): value-capture numbers that differ from VALUE_CAPTURE (money in the city's currency). */
  valueCapture: Partial<typeof VALUE_CAPTURE>;
}

export interface HubDef {
  name: string;
  from: LL;
  to: LL;
  level: TrackLevel;
  cls: TrackClass;
  /** Platform length in platform cars, and the platform centre's distance from `from`, m. */
  cars: number;
  at: number;
}

/**
 * South East (intertown): London's venues plus the region's big days out. Weekday-only calendar, so
 * the race meetings and festivals are their weekday days.
 */
const SOUTHEAST_CHAOS: CityChaos = {
  venues: [
    ...LONDON_CHAOS.venues.filter((v) => ['wembley', 'twickenham', 'wimbledon', 'greenwich-arena', 'hyde-park'].includes(v.key)),
    { key: 'falmer', name: 'Falmer stadium', lon: -0.0835, lat: 50.8616, region: 'Brighton and Hove', parkingTime: 30 * MIN, parkingCost: 20 },
    { key: 'st-marys', name: 'Southampton stadium', lon: -1.391, lat: 50.9058, region: 'Southampton', parkingTime: 30 * MIN, parkingCost: 15 },
    { key: 'goodwood', name: 'Goodwood', lon: -0.7598, lat: 50.8592, region: 'Chichester', parkingTime: 45 * MIN, parkingCost: 25 },
    { key: 'ascot', name: 'Ascot racecourse', lon: -0.6743, lat: 51.4116, region: 'Windsor and Maidenhead', parkingTime: 40 * MIN, parkingCost: 30 },
    { key: 'epsom', name: 'Epsom Downs', lon: -0.2559, lat: 51.3123, region: 'Epsom and Ewell', parkingTime: 40 * MIN, parkingCost: 25 },
  ],
  kinds: [
    ...LONDON_CHAOS.kinds.filter((k) => ['wembley', 'twickenham', 'wimbledon', 'greenwich-arena', 'hyde-park'].includes(k.venue)),
    { venue: 'falmer', label: 'Brighton football', months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance: 0.08, attendance: [28_000, 31_800],
      starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN] },
    { venue: 'st-marys', label: 'Southampton football', months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance: 0.08, attendance: [25_000, 32_000],
      starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN] },
    { venue: 'goodwood', label: 'Goodwood motor festival', months: [6], window: [6, 9, 6, 11], chance: 1, attendance: [40_000, 60_000],
      starts: [[9, 1]], duration: 9 * HOUR, arrive: [-60 * MIN, 4 * HOUR], leave: [-5 * HOUR, 30 * MIN], announce: 7 },
    { venue: 'goodwood', label: 'Goodwood summer race week', months: [6, 7], window: [6, 28, 7, 1], chance: 1, attendance: [18_000, 30_000],
      starts: [[13, 1]], duration: 5 * HOUR, arrive: [-2 * HOUR, 30 * MIN], leave: [-60 * MIN, 30 * MIN] },
    { venue: 'ascot', label: 'Ascot summer race week', months: [5], window: [5, 16, 5, 20], chance: 1, attendance: [50_000, 70_000],
      starts: [[14.5, 1]], duration: 4 * HOUR, arrive: [-2.5 * HOUR, 0], leave: [-30 * MIN, 45 * MIN], announce: 7 },
    { venue: 'epsom', label: 'Epsom race day', months: [5], window: [5, 3, 5, 6], weekdays: [5], chance: 1, attendance: [30_000, 45_000],
      starts: [[13.5, 1]], duration: 5 * HOUR, arrive: [-2 * HOUR, 30 * MIN], leave: [-60 * MIN, 40 * MIN], announce: 5 },
  ],
  climate: LONDON_CHAOS.climate,
};


// The English city regions (src/cities/ukMetros.ts): their stadiums and arenas, named by place.
const FOOTBALL = (venue: string, label: string, att: [number, number], chance = 0.08): EventKindDef => ({
  venue, label, months: FOOTBALL_MONTHS, weekdays: MIDWEEK, chance, attendance: att,
  starts: [[19.75, 0.6], [20, 0.4]], duration: 1.9 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-5 * MIN, 40 * MIN],
});
const ARENA = (venue: string, label: string, att: [number, number], chance = 0.25): EventKindDef => ({
  venue, label, months: ALL_MONTHS, chance, attendance: att,
  starts: [[20, 0.7], [19.5, 0.3]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN],
});
const NORTH_CLIMATE: ClimateDef = {
  snow: [0.05, 0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.03],
  rain: [0.19, 0.16, 0.16, 0.13, 0.13, 0.12, 0.13, 0.14, 0.14, 0.18, 0.2, 0.19],
  heat: [0, 0, 0, 0, 0, 0.005, 0.02, 0.015, 0, 0, 0, 0],
};

const MANCHESTER_CHAOS: CityChaos = {
  venues: [
    { key: 'old-trafford', name: 'Old Trafford stadium', lon: -2.2913, lat: 53.4631, region: 'Trafford', parkingTime: 35 * MIN, parkingCost: 15 },
    { key: 'east-manchester', name: 'East Manchester stadium', lon: -2.2004, lat: 53.4831, region: 'Manchester', parkingTime: 35 * MIN, parkingCost: 15 },
    { key: 'victoria-arena', name: 'Victoria arena', lon: -2.2441, lat: 53.4879, region: 'Manchester', parkingTime: 25 * MIN, parkingCost: 15 },
    { key: 'ot-cricket', name: 'Old Trafford cricket ground', lon: -2.2868, lat: 53.4566, region: 'Trafford', parkingTime: 30 * MIN, parkingCost: 15 },
  ],
  kinds: [
    FOOTBALL('old-trafford', 'Old Trafford football', [60_000, 74_000], 0.1),
    FOOTBALL('east-manchester', 'East Manchester football', [45_000, 53_000], 0.1),
    ARENA('victoria-arena', 'Victoria arena concert', [14_000, 21_000], 0.3),
    { venue: 'ot-cricket', label: 'Old Trafford test match', months: [6], window: [6, 23, 6, 27], chance: 1, attendance: [18_000, 26_000],
      starts: [[11, 1]], duration: 7.5 * HOUR, arrive: [-60 * MIN, 2 * HOUR], leave: [-3 * HOUR, 30 * MIN] },
  ],
  climate: NORTH_CLIMATE,
};

const BIRMINGHAM_CHAOS: CityChaos = {
  venues: [
    { key: 'aston', name: 'Aston stadium', lon: -1.8848, lat: 52.5092, region: 'Birmingham', parkingTime: 35 * MIN, parkingCost: 12 },
    { key: 'bordesley', name: 'Bordesley stadium', lon: -1.8682, lat: 52.4757, region: 'Birmingham', parkingTime: 30 * MIN, parkingCost: 12 },
    { key: 'edgbaston', name: 'Edgbaston cricket ground', lon: -1.9026, lat: 52.4559, region: 'Birmingham', parkingTime: 30 * MIN, parkingCost: 15 },
    { key: 'broad-street-arena', name: 'Broad Street arena', lon: -1.9147, lat: 52.4794, region: 'Birmingham', parkingTime: 25 * MIN, parkingCost: 15 },
    { key: 'bickenhill-arena', name: 'Bickenhill exhibition arena', lon: -1.7238, lat: 52.4532, region: 'Solihull', parkingTime: 30 * MIN, parkingCost: 18 },
    { key: 'molineux', name: 'Molineux stadium', lon: -2.1304, lat: 52.5903, region: 'Wolverhampton', parkingTime: 30 * MIN, parkingCost: 10 },
  ],
  kinds: [
    FOOTBALL('aston', 'Aston football', [36_000, 42_600], 0.1),
    FOOTBALL('bordesley', 'Bordesley football', [20_000, 29_400]),
    FOOTBALL('molineux', 'Wolverhampton football', [28_000, 31_700]),
    ARENA('broad-street-arena', 'Broad Street arena concert', [10_000, 15_800], 0.2),
    ARENA('bickenhill-arena', 'Bickenhill arena concert', [12_000, 15_600], 0.25),
    { venue: 'edgbaston', label: 'Edgbaston test match', months: [6], window: [6, 2, 6, 6], chance: 1, attendance: [20_000, 25_000],
      starts: [[11, 1]], duration: 7.5 * HOUR, arrive: [-60 * MIN, 2 * HOUR], leave: [-3 * HOUR, 30 * MIN] },
  ],
  climate: NORTH_CLIMATE,
};

const LEEDS_CHAOS: CityChaos = {
  venues: [
    { key: 'elland-road', name: 'Elland Road stadium', lon: -1.5721, lat: 53.7778, region: 'Leeds', parkingTime: 35 * MIN, parkingCost: 12 },
    { key: 'headingley', name: 'Headingley stadium', lon: -1.5822, lat: 53.8175, region: 'Leeds', parkingTime: 30 * MIN, parkingCost: 12 },
    { key: 'headingley-cricket', name: 'Headingley cricket ground', lon: -1.5818, lat: 53.8167, region: 'Leeds', parkingTime: 30 * MIN, parkingCost: 12 },
    { key: 'leeds-arena', name: 'Leeds city arena', lon: -1.5434, lat: 53.8034, region: 'Leeds', parkingTime: 25 * MIN, parkingCost: 12 },
    { key: 'huddersfield', name: 'Huddersfield stadium', lon: -1.768, lat: 53.6543, region: 'Kirklees', parkingTime: 25 * MIN, parkingCost: 8 },
    { key: 'valley-parade', name: 'Valley Parade stadium', lon: -1.7589, lat: 53.804, region: 'Bradford', parkingTime: 25 * MIN, parkingCost: 8 },
  ],
  kinds: [
    FOOTBALL('elland-road', 'Elland Road football', [33_000, 37_600], 0.1),
    FOOTBALL('huddersfield', 'Huddersfield football', [15_000, 24_000]),
    FOOTBALL('valley-parade', 'Bradford football', [16_000, 25_000]),
    ARENA('leeds-arena', 'Leeds arena concert', [10_000, 13_800], 0.3),
    { venue: 'headingley', label: 'Headingley rugby', months: [1, 2, 3, 4, 5, 6, 7, 8], weekdays: [4, 5], chance: 0.1, attendance: [14_000, 21_000],
      starts: [[19.75, 1]], duration: 2 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-10 * MIN, 35 * MIN] },
    { venue: 'headingley-cricket', label: 'Headingley test match', months: [6], window: [6, 7, 6, 11], chance: 1, attendance: [15_000, 18_350],
      starts: [[11, 1]], duration: 7.5 * HOUR, arrive: [-60 * MIN, 2 * HOUR], leave: [-3 * HOUR, 30 * MIN] },
  ],
  climate: NORTH_CLIMATE,
};

const BRISTOL_CHAOS: CityChaos = {
  venues: [
    { key: 'ashton-gate', name: 'Ashton Gate stadium', lon: -2.6205, lat: 51.4401, region: 'Bristol', parkingTime: 30 * MIN, parkingCost: 12 },
    { key: 'horfield', name: 'Horfield stadium', lon: -2.5832, lat: 51.4862, region: 'Bristol', parkingTime: 25 * MIN, parkingCost: 10 },
    { key: 'bath-rec', name: 'Bath riverside rugby ground', lon: -2.3553, lat: 51.3822, region: 'Bath and North East Somerset', parkingTime: 35 * MIN, parkingCost: 15 },
    { key: 'clifton-downs', name: 'Clifton Downs', lon: -2.6206, lat: 51.4728, region: 'Bristol', parkingTime: 30 * MIN, parkingCost: 15 },
  ],
  kinds: [
    FOOTBALL('ashton-gate', 'Ashton Gate football', [18_000, 27_000], 0.1),
    FOOTBALL('horfield', 'Horfield football', [8_000, 10_000]),
    { venue: 'ashton-gate', label: 'Ashton Gate rugby', months: [0, 1, 2, 3, 8, 9, 10, 11], weekdays: [5], chance: 0.15, attendance: [15_000, 27_000],
      starts: [[19.75, 1]], duration: 2 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-10 * MIN, 35 * MIN] },
    { venue: 'bath-rec', label: 'Bath rugby', months: [0, 1, 2, 3, 8, 9, 10, 11], weekdays: [5], chance: 0.15, attendance: [12_000, 14_500],
      starts: [[19.75, 1]], duration: 2 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-10 * MIN, 35 * MIN] },
    { venue: 'clifton-downs', label: 'Downs summer concert', months: [5, 6], chance: 0.08, attendance: [20_000, 30_000],
      starts: [[18, 1]], duration: 4.5 * HOUR, arrive: [-3 * HOUR, 60 * MIN], leave: [-30 * MIN, 40 * MIN] },
  ],
  climate: { ...LONDON_CHAOS.climate, rain: [0.17, 0.14, 0.14, 0.12, 0.12, 0.11, 0.11, 0.13, 0.13, 0.17, 0.18, 0.17] },
};

/**
 * Japan (the high-speed map): weekday crowds that cross the country. The grand sumo tournaments
 * (Tokyo in January, May and September; Osaka, Nagoya and Fukuoka once a year), the summer
 * high-school baseball tournament, the great summer festivals of Tohoku and Shikoku, the Sapporo
 * snow festival and the trade fairs on Tokyo Bay draw people from hundreds of kilometres away.
 * Weather is one forecast for the whole map: the rainy season in June and July, September's
 * typhoons, deep-winter snow in the north and on the Sea of Japan coast, and summer heat.
 */
const JAPAN_CHAOS: CityChaos = {
  venues: [
    { key: 'suidobashi-dome', name: 'Suidobashi dome', lon: 139.7519, lat: 35.7056, region: 'Tokyo', parkingTime: 30 * MIN, parkingCost: 30 },
    { key: 'ryogoku', name: 'Ryogoku sumo hall', lon: 139.7933, lat: 35.6969, region: 'Tokyo', parkingTime: 30 * MIN, parkingCost: 30 },
    { key: 'ariake', name: 'Ariake exhibition centre', lon: 139.7946, lat: 35.6299, region: 'Tokyo', parkingTime: 25 * MIN, parkingCost: 25 },
    { key: 'koshien', name: 'Koshien ballpark', lon: 135.3616, lat: 34.7212, region: 'Hyogo', parkingTime: 35 * MIN, parkingCost: 20 },
    { key: 'namba-sumo', name: 'Namba sumo arena', lon: 135.4995, lat: 34.6618, region: 'Osaka', parkingTime: 30 * MIN, parkingCost: 25 },
    { key: 'nagoya-sumo', name: 'Meijo sumo arena', lon: 136.8997, lat: 35.1878, region: 'Aichi', parkingTime: 25 * MIN, parkingCost: 20 },
    { key: 'hakata-sumo', name: 'Hakata sumo arena', lon: 130.404, lat: 33.6034, region: 'Fukuoka', parkingTime: 25 * MIN, parkingCost: 20 },
    { key: 'nebuta', name: 'Aomori waterfront', lon: 140.7466, lat: 40.8296, region: 'Aomori', parkingTime: 45 * MIN, parkingCost: 20 },
    { key: 'tanabata', name: 'Sendai city centre', lon: 140.881, lat: 38.2603, region: 'Miyagi', parkingTime: 40 * MIN, parkingCost: 20 },
    { key: 'gion', name: 'Kyoto old town', lon: 135.7631, lat: 35.0036, region: 'Kyoto', parkingTime: 45 * MIN, parkingCost: 25 },
    { key: 'awa-odori', name: 'Tokushima city centre', lon: 134.5509, lat: 34.0703, region: 'Tokushima', parkingTime: 40 * MIN, parkingCost: 15 },
    { key: 'snow-festival', name: 'Odori park, Sapporo', lon: 141.3518, lat: 43.0577, region: 'Hokkaido', parkingTime: 40 * MIN, parkingCost: 20 },
  ],
  kinds: [
    { venue: 'suidobashi-dome', label: 'Suidobashi night baseball', months: [2, 3, 4, 5, 6, 7, 8], weekdays: [2, 3, 4, 5], chance: 0.45, attendance: [36_000, 43_000],
      starts: [[18, 1]], duration: 3.25 * HOUR, arrive: [-80 * MIN, 0], leave: [-10 * MIN, 30 * MIN], originDecay: 40_000 },
    { venue: 'ryogoku', label: 'Grand sumo tournament', months: [0, 4, 8], chance: 0.7, attendance: [8_000, 11_000],
      starts: [[13, 1]], duration: 5 * HOUR, arrive: [-60 * MIN, 120 * MIN], leave: [-15 * MIN, 30 * MIN], originDecay: 150_000 },
    { venue: 'ariake', label: 'Trade fair', months: [1, 2, 3, 4, 5, 6, 8, 9, 10, 11], chance: 0.3, attendance: [30_000, 60_000],
      starts: [[10, 1]], duration: 7 * HOUR, arrive: [-30 * MIN, 150 * MIN], leave: [-150 * MIN, 30 * MIN], originDecay: 250_000 },
    { venue: 'koshien', label: 'Summer high-school baseball', months: [7], window: [7, 6, 7, 23], chance: 0.6, attendance: [30_000, 45_000],
      starts: [[8, 1]], duration: 9 * HOUR, arrive: [-60 * MIN, 180 * MIN], leave: [-180 * MIN, 30 * MIN], originDecay: 200_000 },
    { venue: 'koshien', label: 'Spring high-school baseball', months: [2], window: [2, 18, 2, 31], chance: 0.2, attendance: [15_000, 30_000],
      starts: [[9, 1]], duration: 8 * HOUR, arrive: [-60 * MIN, 180 * MIN], leave: [-180 * MIN, 30 * MIN], originDecay: 200_000 },
    { venue: 'namba-sumo', label: 'Osaka sumo tournament', months: [2], chance: 0.7, attendance: [6_000, 7_500],
      starts: [[13, 1]], duration: 5 * HOUR, arrive: [-60 * MIN, 120 * MIN], leave: [-15 * MIN, 30 * MIN], originDecay: 150_000 },
    { venue: 'nagoya-sumo', label: 'Nagoya sumo tournament', months: [6], chance: 0.7, attendance: [6_000, 7_500],
      starts: [[13, 1]], duration: 5 * HOUR, arrive: [-60 * MIN, 120 * MIN], leave: [-15 * MIN, 30 * MIN], originDecay: 150_000 },
    { venue: 'hakata-sumo', label: 'Kyushu sumo tournament', months: [10], chance: 0.7, attendance: [5_000, 7_000],
      starts: [[13, 1]], duration: 5 * HOUR, arrive: [-60 * MIN, 120 * MIN], leave: [-15 * MIN, 30 * MIN], originDecay: 150_000 },
    { venue: 'nebuta', label: 'Aomori lantern festival', months: [7], window: [7, 2, 7, 7], chance: 0.8, attendance: [150_000, 250_000],
      starts: [[19, 1]], duration: 2 * HOUR, arrive: [-4 * HOUR, 0], leave: [0, 40 * MIN], originDecay: 300_000, announce: 30 },
    { venue: 'tanabata', label: 'Sendai star festival', months: [7], window: [7, 6, 7, 8], chance: 0.8, attendance: [150_000, 250_000],
      starts: [[10, 1]], duration: 10 * HOUR, arrive: [-60 * MIN, 5 * HOUR], leave: [-5 * HOUR, 0], originDecay: 250_000, announce: 30 },
    { venue: 'gion', label: 'Kyoto summer festival', months: [6], window: [6, 14, 6, 17], chance: 0.8, attendance: [100_000, 200_000],
      starts: [[18, 0.75], [9, 0.25]], duration: 4 * HOUR, arrive: [-2 * HOUR, 30 * MIN], leave: [-30 * MIN, 40 * MIN], originDecay: 250_000, announce: 30 },
    { venue: 'awa-odori', label: 'Tokushima dance festival', months: [7], window: [7, 12, 7, 15], chance: 0.8, attendance: [150_000, 250_000],
      starts: [[18, 1]], duration: 4.5 * HOUR, arrive: [-3 * HOUR, 30 * MIN], leave: [-30 * MIN, 40 * MIN], originDecay: 250_000, announce: 30 },
    { venue: 'snow-festival', label: 'Sapporo snow festival', months: [1], window: [1, 4, 1, 11], chance: 0.8, attendance: [150_000, 250_000],
      starts: [[11, 1]], duration: 10 * HOUR, arrive: [-60 * MIN, 6 * HOUR], leave: [-6 * HOUR, 0], originDecay: 300_000, announce: 30 },
  ],
  climate: {
    snow: [0.06, 0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.04],
    rain: [0.03, 0.03, 0.04, 0.04, 0.05, 0.12, 0.1, 0.06, 0.1, 0.05, 0.03, 0.02],
    heat: [0, 0, 0, 0, 0.01, 0.03, 0.08, 0.1, 0.04, 0, 0, 0],
    /** A snow day buries the north and the Sea of Japan coast, not Kyushu: a third of the effect. */
    reach: 0.35,
  },
  /**
   * About eight tremors a year strong enough to stop the trains near them, mostly off the Pacific
   * coast of Tohoku and Kanto, under the Tokai and Nankai coasts, in Kyushu and eastern Hokkaido.
   */
  quakes: {
    chance: 0.03,
    zones: [
      [141.9, 38.4, 4], [141.5, 36.9, 2], [140.1, 35.7, 3], [138.6, 34.8, 2], [136.4, 33.9, 2], [135.4, 34.7, 1],
      [130.8, 32.8, 2], [131.6, 31.9, 1], [144.2, 42.7, 2], [137.2, 37.2, 1], [138.9, 37.4, 1], [133.3, 35.3, 1],
    ],
    scatter: 0.4,
    radius: [60_000, 160_000],
    duration: [15 * MIN, 50 * MIN],
  },
};

/** Each city's events and weather (the shared chaos tunables are CHAOS, WEATHER and EVENTS above). */
export const CHAOS_BY_CITY: Record<CityId, CityChaos> = {
  nyc: NYC_CHAOS,
  london: LONDON_CHAOS,
  southeast: SOUTHEAST_CHAOS,
  manchester: MANCHESTER_CHAOS,
  birmingham: BIRMINGHAM_CHAOS,
  leeds: LEEDS_CHAOS,
  bristol: BRISTOL_CHAOS,
  japan: JAPAN_CHAOS,
};

/** Central London: roughly the congestion-charge zone, inside the inner ring road (London and the South East). */
const CITY_BALANCE_LONDON_CBD: ZoneRule = {
  kind: 'polygon',
  ring: [
        [-0.1627, 51.5185], [-0.159, 51.5225], [-0.146, 51.524], [-0.134, 51.5265], [-0.123, 51.531], [-0.105, 51.532],
        [-0.0876, 51.526], [-0.0745, 51.5225], [-0.0715, 51.5105], [-0.076, 51.504], [-0.088, 51.4985], [-0.1003, 51.4946],
        [-0.114, 51.49], [-0.127, 51.4875], [-0.144, 51.496], [-0.153, 51.501], [-0.1525, 51.507], [-0.1586, 51.5131],
  ],
};

/**
 * The English city regions (Manchester, Birmingham, Leeds, Bristol): metro maps like London's, with
 * UK fares, values of time and taxes, but cheaper central parking, faster roads, more car owners
 * (a smaller pull away from driving) and a smaller budget for a smaller city.
 */
const UK_BUILD_COST = 0.6;
function scaleLevels(v: Record<TrackLevel, number>, k: number): Record<TrackLevel, number> {
  return Object.fromEntries(Object.entries(v).map(([l, c]) => [l, Math.round(c * k)])) as Record<TrackLevel, number>;
}

function ukMetroBalance(o: Pick<CityBalance, 'origin' | 'map' | 'titleCamera' | 'coreRegions' | 'cbd' | 'goals' | 'chaos'> & { valuePerResident: number; startingCash?: number; small?: boolean }): CityBalance {
  return {
    origin: o.origin,
    map: o.map,
    titleCamera: o.titleCamera,
    coreRegions: o.coreRegions,
    cbd: o.cbd,
    commuters: {
      driveSpeedCore: 16 * KMH,
      driveSpeedOther: 25 * KMH,
      /** Beyond 10 km of road, the motorways and A roads at about 45 km/h door to door (peak). */
      driveLongAfter: 10_000,
      driveSpeedLong: 45 * KMH,
      parkingCbdTime: 15 * MIN,
      /** A day's city-centre parking (no congestion charge outside London). */
      parkingCbdCost: 10,
      parkingOtherTime: 4 * MIN,
      valueOfTime: [8, 13, 22],
      driveCostPerKm: 0.25,
      /** Car ownership is higher than in London: a smaller pull away from driving. */
      modeConstant: { walk: 0, drive: 20, transit: 0 },
    },
    /**
     * Zonal fares (like the regional trams): +1 fare per 12 km beyond the first 4, so a 16 km trip
     * pays two. Unstaffed-style stations cost half London's to run.
     */
    economy: { startingCash: o.startingCash ?? 3.5e9, fareDefault: 2.5, fareMin: 0, fareMax: 5, fareStep: 0.1, fareDistanceKm: 12, fareFreeKm: 4, staffingPerStationDay: 4000 },
    /** Building is cheaper outside London (land, utilities, contractors): track and stations at 60%. */
    track: { costPerM: scaleLevels(TRACK.costPerM, UK_BUILD_COST) },
    station: { costByLevel: scaleLevels(STATION.costByLevel, UK_BUILD_COST) },
    fares: { peak: 2.5, offPeak: 2.2, lowIncome: 1 },
    /** London's anchors: these networks carry fewer riders per pound than New York's, as London's do. */
    credit: {
      farebox: { x: [0.3, 0.6, 0.9, 1.2], y: [0, 50, 80, 100] },
      coverage: { x: [-0.5, 0, 0.5, 1.0, 2.5], y: [0, 30, 55, 75, 100] },
    },
    /** Rider goals in proportion: these maps have a third of London's commuters (Bristol an eighth). */
    goals: {
      riderMilestones: o.small ? [50_000, 100_000, 200_000, 300_000] : [100_000, 200_000, 400_000, 600_000],
      clockworkMinRiders: o.small ? 50_000 : 100_000,
      ratingGoalMinDebt: o.small ? 1e9 : 1.5e9,
      ...o.goals,
    },
    chaos: o.chaos,
    schools: { childFare: 0.5, terms: 'uk', originDecay: 3500 },
    /** 2010s growth outside London: residents ≈ +0.6%/yr, jobs a little faster in the core cities. */
    growth: { cityGrowthPerYear: 0.008 },
    valueCapture: {
      valuePerResident: o.valuePerResident,
      valuePerJob: 75_000,
      /** Council tax bands are lower than London's but so are home values: a higher effective rate. */
      taxRateHomes: 0.004,
      taxRateJobs: 0.025,
      captureShare: 0.14,
    },
  };
}

export const CITY_BALANCE: Record<CityId, CityBalance> = {
  nyc: {
    origin: [-74.006, 40.7128], // City Hall
    map: { startCenter: MAP.startCenter, startZoom: MAP.startZoom, bounds: MAP.bounds },
    titleCamera: { center: [-73.985, 40.752], zoom: 14.2, bearing: 20 }, // Midtown
    coreRegions: ['Manhattan'],
    cbd: { kind: 'region-south-of', region: 'Manhattan', lat: 40.7644 }, // below 60th St
    commuters: {},
    economy: {},
    /** New York: one fare all day (the subway has no peak pricing); the low-income discount is the player's lever. */
    fares: { peak: 3.0, offPeak: 3.0, lowIncome: 1 },
    credit: {},
    goals: {},
    chaos: CHAOS_BY_CITY.nyc,
    /** Students ride free on student OMNY cards; the school year runs September to late June. */
    schools: { childFare: 0, terms: 'us' },
    growth: {},
    valueCapture: {},
  },
  london: {
    /** Inner London (about fare zones 1–2): too dense for new surface railway. */
    tunnelZone: {
      name: 'Inner London',
      poly: [
        [-0.2300, 51.5120], [-0.2250, 51.5300], [-0.1900, 51.5450], [-0.1450, 51.5530], [-0.1000, 51.5560],
        [-0.0550, 51.5480], [-0.0150, 51.5300], [-0.0020, 51.5100], [-0.0050, 51.4850], [-0.0450, 51.4700],
        [-0.1000, 51.4600], [-0.1500, 51.4600], [-0.1950, 51.4700], [-0.2250, 51.4900],
      ],
    },
    origin: [-0.1276, 51.5073], // Charing Cross, the traditional centre of London
    map: { startCenter: [-0.1, 51.512], startZoom: 12, bounds: [-0.62, 51.2, 0.42, 51.76] },
    titleCamera: { center: [-0.083, 51.5135], zoom: 14.6, bearing: -25 }, // the City's towers
    /** Inner London (ONS statistical definition): congested streets, slow driving. */
    coreRegions: ['City of London', 'Camden', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Islington', 'Kensington and Chelsea', 'Lambeth', 'Lewisham', 'Newham', 'Southwark', 'Tower Hamlets', 'Wandsworth', 'Westminster'],
    /** Roughly the central congestion-charge zone, inside the inner ring road. */
    cbd: {
      kind: 'polygon',
      ring: [
        [-0.1627, 51.5185], [-0.159, 51.5225], [-0.146, 51.524], [-0.134, 51.5265], [-0.123, 51.531], [-0.105, 51.532],
        [-0.0876, 51.526], [-0.0745, 51.5225], [-0.0715, 51.5105], [-0.076, 51.504], [-0.088, 51.4985], [-0.1003, 51.4946],
        [-0.114, 51.49], [-0.127, 51.4875], [-0.144, 51.496], [-0.153, 51.501], [-0.1525, 51.507], [-0.1586, 51.5131],
      ],
    },
    commuters: {
      driveSpeedCore: 13 * KMH,
      driveSpeedOther: 24 * KMH,
      parkingCbdTime: 20 * MIN,
      /** £15 daily congestion charge plus about £10 of central parking. */
      parkingCbdCost: 25,
      parkingOtherTime: 5 * MIN,
      /** £/hour by modelled income band (UK commuting values of time, low/middle/high). */
      valueOfTime: [8, 14, 26],
      driveCostPerKm: 0.25,
      /** Fewer London households own a car (inner London ~40%), so driving carries a bigger penalty. */
      modeConstant: { walk: 0, drive: 35, transit: 0 },
    },
    economy: {
      startingCash: 5e9,
      fareDefault: 2.8,
      fareMin: 0,
      fareMax: 5,
      fareStep: 0.1,
    },
    /** London-style pay-as-you-go: a small peak premium (06–10, 16–20), full fare for all bands until the player adds a discount. */
    fares: { peak: 2.8, offPeak: 2.7, lowIncome: 1 },
    /**
     * London's jobs are far less concentrated, so the same ~40 central stations carry about 58% of
     * New York's riders: its benchmark core recovers 0.89 of its operating costs (New York's 1.59)
     * and loses a little before interest. New York's anchors rate that CCC; these (farebox × 0.6,
     * coverage 0.5 lower) rate it BB, a London network covering its costs by a quarter BBB, and
     * debt-free sprawl BB as in New York.
     */
    credit: {
      farebox: { x: [0.3, 0.6, 0.9, 1.2], y: [0, 50, 80, 100] },
      coverage: { x: [-0.5, 0, 0.5, 1.0, 2.5], y: [0, 30, 55, 75, 100] },
    },
    goals: {
      tripMinutes: 45,
      /** Bank junction to the Heathrow central terminal area. */
      tripFrom: [-0.0886, 51.5133],
      tripTo: [-0.4543, 51.47],
      /** Living City: one month's value capture, in proportion to New York's $10M (London's core earns ≈ 58% as much). */
      valueCaptureMonth: 6e6,
    },
    chaos: CHAOS_BY_CITY.london,
    schools: { childFare: 0.5, terms: 'uk' },
    growth: {
      /**
       * London's 2010s: residents +7.7% (Census 2011 → 2021, ≈ 0.75%/yr) and workforce jobs ≈ +1.6%/yr
       * (ONS); commuters in between.
       */
      cityGrowthPerYear: 0.011,
    },
    valueCapture: {
      /**
       * Market value per commuter (£, 2011 census commuters): London's ≈ £2T of homes over 2.93M
       * resident commuters is ≈ £680k; offices and shops ≈ £0.4T (≈ £20B of rateable value at ≈ 5%
       * yields, VOA) over 2.93M jobs ≈ £140k.
       */
      valuePerResident: 680_000,
      valuePerJob: 140_000,
      /**
       * The UK has no ad valorem property tax, so these are effective rates on market value. Homes pay
       * council tax: ≈ £5B a year across London on ≈ £2T of homes ≈ 0.25% (Band D ≈ £2,000 on a
       * ≈ £520k average home is 0.38%; bands are capped, so the stock-wide rate is lower).
       * Workplaces pay business rates: ≈ 51p per £ of rateable value (≈ a year's rent) at ≈ 5% yields
       * is ≈ 2.5% of capital value. So most of London's value capture comes from workplaces, as in
       * the real precedents: the Crossrail business rate supplement (2p per £ of rateable value above
       * £70k, £4.1B towards Crossrail) and the Nine Elms enterprise zone, whose business-rate growth
       * repays the Northern line extension.
       */
      taxRateHomes: 0.0025,
      taxRateJobs: 0.025,
      /** A slightly larger pledge (business-rate growth, as at Nine Elms) lands the London core in proportion to New York's: ≈ 11% of its fares by month 12. */
      captureShare: 0.14,
    },
  },
  southeast: {
    origin: [-0.1276, 51.5073], // Charing Cross, as London (the region's lines run to London)
    map: { startCenter: [-0.42, 51.22], startZoom: 8.4, bounds: [-2.3, 50.35, 1.8, 52.35], minZoom: 7.2, landCell: 60 },
    titleCamera: { center: [-0.1385, 50.8185], zoom: 14.4, bearing: 35 }, // Brighton seafront
    /** Inner London and the big town centres: congested streets, slow driving. */
    coreRegions: ['City of London', 'Camden', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Islington', 'Kensington and Chelsea', 'Lambeth', 'Lewisham', 'Newham', 'Southwark', 'Tower Hamlets', 'Wandsworth', 'Westminster', 'Brighton and Hove', 'Portsmouth', 'Southampton', 'Oxford', 'Reading'],
    /** Central London (the congestion-charge zone, as the London map). */
    cbd: CITY_BALANCE_LONDON_CBD,
    commuters: {
      driveSpeedCore: 13 * KMH,
      driveSpeedOther: 26 * KMH,
      /** Beyond 12 km of road, A roads and motorways at about 70 km/h door to door (M23, M3, A3, M20…). */
      driveLongAfter: 12_000,
      driveSpeedLong: 70 * KMH,
      /** Out of town people will walk (or be dropped off) further to a station. */
      maxAccessWalk: 3500,
      parkingCbdTime: 20 * MIN,
      parkingCbdCost: 25,
      parkingOtherTime: 5 * MIN,
      valueOfTime: [8, 14, 26],
      driveCostPerKm: 0.25,
      /** Car ownership outside London is high: driving carries a smaller penalty than in the London map. */
      modeConstant: { walk: 0, drive: 18, transit: 0 },
    },
    economy: {
      /** Regional rail is long: ~£3B is one Victoria–Brighton line at grade. */
      startingCash: 15e9,
      fareDefault: 2.8,
      fareMin: 0,
      fareMax: 8,
      fareStep: 0.1,
      /** Distance fares: +1 fare per 20 km beyond the first 3 (Victoria–Brighton, 75 km, ≈ 4.6 fares). */
      fareDistanceKm: 20,
      fareFreeKm: 3,
    },
    fares: { peak: 2.8, offPeak: 2.3, lowIncome: 1 },
    credit: {
      farebox: { x: [0.3, 0.6, 0.9, 1.2], y: [0, 50, 80, 100] },
      coverage: { x: [-0.5, 0, 0.5, 1.0, 2.5], y: [0, 30, 55, 75, 100] },
    },
    goals: {
      /** Victoria to Brighton in under an hour, door to door. */
      tripMinutes: 60,
      tripFrom: [-0.1441, 51.4952],
      tripTo: [-0.141, 50.829],
      valueCaptureMonth: 6e6,
    },
    chaos: CHAOS_BY_CITY.southeast,
    /** Outside London secondary schools draw from further away (fewer, bigger catchments). */
    schools: { childFare: 0.5, terms: 'uk', originDecay: 4500 },
    growth: { cityGrowthPerYear: 0.009 },
    valueCapture: {
      /** Homes outside London are cheaper: ≈ £480k per resident commuter across the map. */
      valuePerResident: 480_000,
      valuePerJob: 110_000,
      taxRateHomes: 0.003,
      taxRateJobs: 0.025,
      captureShare: 0.14,
    },
    /** Main lines sweep wider: a 20° bend with 1.2 km tangents is r ≈ 6.8 km (fine for 200 km/h). */
    track: { filletMaxTangent: { heavy: 1200, light: 250, highspeed: 3000 } },
    /** Victoria: a 14-car terminal platform, elevated so a new line can cross the river straight away (and ramp down beyond). */
    hubs: [{ name: 'Victoria', from: [-0.1441, 51.4955], to: [-0.1466, 51.4905], level: 'elevated', cls: 'heavy', cars: 14, at: 190 }],
  },
  manchester: ukMetroBalance({
    origin: [-2.2446, 53.4794], // Albert Square, by the Town Hall
    map: { startCenter: [-2.245, 53.478], startZoom: 12, bounds: [-2.95, 53.25, -1.75, 53.75] },
    titleCamera: { center: [-2.2475, 53.4775], zoom: 14.6, bearing: -20 }, // Deansgate and the city centre
    coreRegions: ['Manchester', 'Salford'],
    /** Inside the inner relief road (Mancunian Way, Trinity Way, Great Ancoats Street). */
    cbd: { kind: 'polygon', ring: [[-2.2605, 53.4855], [-2.2475, 53.4895], [-2.2345, 53.4875], [-2.2275, 53.4835], [-2.2265, 53.4755], [-2.233, 53.4705], [-2.2455, 53.4695], [-2.2565, 53.4725], [-2.2625, 53.4795]] },
    goals: { tripMinutes: 30, tripFrom: [-2.2309, 53.4774], tripTo: [-2.2727, 53.365], valueCaptureMonth: 2e6 },
    chaos: CHAOS_BY_CITY.manchester,
    valuePerResident: 230_000,
  }),
  birmingham: ukMetroBalance({
    origin: [-1.9035, 52.4797], // Victoria Square
    map: { startCenter: [-1.9, 52.48], startZoom: 12, bounds: [-2.4, 52.25, -1.3, 52.72] },
    titleCamera: { center: [-1.8975, 52.4785], zoom: 14.6, bearing: 25 }, // New Street and the Bullring
    coreRegions: ['Birmingham'],
    /** Inside the Middleway ring road. */
    cbd: { kind: 'polygon', ring: [[-1.918, 52.488], [-1.905, 52.4925], [-1.89, 52.49], [-1.879, 52.484], [-1.877, 52.476], [-1.884, 52.469], [-1.899, 52.466], [-1.912, 52.47], [-1.92, 52.478]] },
    goals: { tripMinutes: 25, tripFrom: [-1.8985, 52.4777], tripTo: [-1.748, 52.4539], valueCaptureMonth: 2e6 },
    chaos: CHAOS_BY_CITY.birmingham,
    valuePerResident: 230_000,
  }),
  leeds: ukMetroBalance({
    origin: [-1.547, 53.7958], // City Square
    map: { startCenter: [-1.55, 53.796], startZoom: 12, bounds: [-2.35, 53.45, -1.05, 54.02] },
    titleCamera: { center: [-1.546, 53.7975], zoom: 14.6, bearing: 15 }, // the station and the city centre
    coreRegions: ['Leeds', 'Bradford'],
    /** Inside the inner ring road. */
    cbd: { kind: 'polygon', ring: [[-1.5605, 53.803], [-1.548, 53.806], [-1.533, 53.803], [-1.528, 53.796], [-1.535, 53.79], [-1.548, 53.788], [-1.56, 53.792], [-1.564, 53.798]] },
    goals: { tripMinutes: 30, tripFrom: [-1.547, 53.7958], tripTo: [-1.6606, 53.8659], valueCaptureMonth: 2e6 },
    chaos: CHAOS_BY_CITY.leeds,
    valuePerResident: 210_000,
  }),
  bristol: ukMetroBalance({
    origin: [-2.597, 51.4545], // The Centre
    map: { startCenter: [-2.59, 51.455], startZoom: 12, bounds: [-3.25, 51.2, -2.1, 51.72] },
    titleCamera: { center: [-2.5955, 51.4505], zoom: 14.8, bearing: -30 }, // the harbour and the centre
    coreRegions: ['Bristol'],
    /** The centre, Broadmead, the harbourside and Temple Quarter. */
    cbd: { kind: 'polygon', ring: [[-2.605, 51.458], [-2.596, 51.461], [-2.584, 51.46], [-2.58, 51.453], [-2.585, 51.448], [-2.598, 51.4475], [-2.607, 51.451]] },
    goals: { tripMinutes: 30, tripFrom: [-2.5813, 51.4491], tripTo: [-2.7191, 51.3827], valueCaptureMonth: 1.5e6 },
    chaos: CHAOS_BY_CITY.bristol,
    valuePerResident: 330_000,
    startingCash: 2.5e9,
    small: true,
  }),
  /**
   * Japan, the high-speed map: the four main islands, 2,000 km of them. Money is counted in hundreds
   * of yen (src/cities/japan.ts currencyScale), so the game's metro-scale numbers stay meaningful:
   * a high-speed car is 4.5M units (¥450M), and the defaults below are in those units too.
   */
  japan: {
    origin: [137.5, 37.5],
    projection: { kind: 'lcc', lat1: 33, lat2: 44 },
    map: { startCenter: [138.6, 35.7], startZoom: 6.7, bounds: [126.5, 29.0, 149.0, 46.8], minZoom: 4.4, landCell: 500, landClose: true, trainMinZoom: 6 },
    titleCamera: { center: [139.7671, 35.6812], zoom: 14.3, bearing: 15 }, // Tokyo station and Marunouchi
    /** Slow, congested driving at either end of the trip in the two great cities. */
    coreRegions: ['Tokyo', 'Osaka'],
    /** Inside the Yamanote loop: parking is dear and slow. */
    cbd: {
      kind: 'polygon',
      ring: [[139.7, 35.658], [139.715, 35.629], [139.739, 35.628], [139.762, 35.645], [139.778, 35.672], [139.78, 35.7], [139.775, 35.727], [139.746, 35.736], [139.708, 35.731], [139.69, 35.705], [139.693, 35.678]],
    },
    commuters: {
      /**
       * Getting to the station is a local train, a bus or a lift (no city transit is modelled here):
       * door to platform at ≈ 25 km/h over 1.3× the straight line, up to 40 km. Nobody walks between
       * cities, so the walk mode is off.
       */
      walkSpeed: 7,
      walkDetour: 1.3,
      walkMaxDistance: 0,
      maxAccessWalk: 40_000,
      accessRadiusTractShare: 0.5,
      /** Expressways: ≈ 75 km/h door to door beyond the first 15 km, with tolls (Japan's are steep). */
      driveSpeedCore: 18 * KMH,
      driveSpeedOther: 35 * KMH,
      driveLongAfter: 15_000,
      driveSpeedLong: 75 * KMH,
      parkingCbdTime: 20 * MIN,
      parkingCbdCost: 30,
      parkingOtherTime: 5 * MIN,
      /** Hundreds of yen an hour by purpose: private trips ¥1,500, sightseeing ¥2,200, business ¥4,500. */
      valueOfTime: [15, 22, 45],
      /** Tolls (≈ ¥25/km) and fuel per traveller (≈ 1.6 to a car): ¥22 a kilometre. */
      driveCostPerKm: 0.22,
      modeConstant: { walk: 0, drive: 10, transit: 0 },
      /** Trips there and back in a day: out from 6 am, mostly mid-morning; back about six hours after arriving. */
      departMean: 9.5 * HOUR,
      departSd: 2.5 * HOUR,
      departMin: 6 * HOUR,
      departMax: 16 * HOUR,
      workDuration: 6 * HOUR,
      returnJitter: 2.5 * HOUR,
      /** Long trips: people weigh a few minutes less sharply than on a commute. */
      logitScale: 0.025,
      waitCap: 30 * MIN,
      transferPenalty: 10 * MIN,
    },
    economy: {
      /** ¥5 trillion: about one Tokaido-length line through the mountains, with trains. */
      startingCash: 50e9,
      /**
       * Base fare ¥700, +1 fare per 20 km (straight line), about the real fare plus limited-express
       * charge: Tokyo–Odawara ≈ ¥3,300, Tokyo–Osaka ≈ ¥14,700, an airport hop of 15 km ≈ ¥1,200.
       */
      fareDefault: 7,
      fareMin: 0,
      fareMax: 25,
      fareStep: 0.5,
      fareDistanceKm: 20,
      fareFreeKm: 0,
      /** A big high-speed station's staff, ≈ ¥2M a day. */
      staffingPerStationDay: 20_000,
      /** Bonds in ¥500 billion lots, up to ¥10 trillion. */
      bondChunk: 5e9,
      bondMax: 100e9,
    },
    /** One fare all day (no peak pricing on Japan's high-speed lines). */
    fares: { peak: 7, offPeak: 7, lowIncome: 1 },
    credit: {
      farebox: { x: [0.8, 1.4, 2.0, 2.8], y: [0, 50, 80, 100] },
      coverage: { x: [0, 0.5, 1.0, 1.5, 3.0], y: [0, 30, 55, 75, 100] },
    },
    goals: {
      riderMilestones: [100_000, 250_000, 500_000, 1_000_000],
      clockworkMinRiders: 100_000,
      ratingGoalMinDebt: 20e9,
      /** Tokyo station to Umeda, Osaka, door to door, in under 2½ hours. */
      tripMinutes: 150,
      tripFrom: [139.7671, 35.6812],
      tripTo: [135.4959, 34.7025],
      valueCaptureMonth: 50e6,
    },
    chaos: CHAOS_BY_CITY.japan,
    /**
     * High-speed line (base costs; ×1.8 for high-speed): viaduct ≈ ¥5B/km, embankment ¥2.5B/km,
     * mountain tunnel ¥6.5B/km, cut-and-cover ¥12B/km, all dearer through towns (deep tunnels too:
     * under Tokyo they cost several times a mountain bore) and in the mountains (TRACK.mountainK).
     * Long lines are built by many contractors at once: days per km are a tenth of a metro's.
     */
    track: {
      costPerM: { elevated: 27_800, 'at-grade': 13_900, 'cut-and-cover': 66_700, deep: 36_100 },
      daysPerKm: { elevated: 0.6, 'at-grade': 0.4, 'cut-and-cover': 1.5, deep: 1.0 },
      densityAffects: { elevated: true, 'at-grade': true, 'cut-and-cover': true, deep: true },
      filletMaxTangent: { heavy: 1200, light: 250, highspeed: 4000 },
    },
    /** High-speed stations (×1.8): at grade ≈ ¥8B, viaduct ¥15B, cut-and-cover ¥40B, deep ¥60B. */
    station: {
      costByLevel: { 'at-grade': 44e6, elevated: 83e6, 'cut-and-cover': 220e6, deep: 330e6 },
      buildDays: { 'at-grade': 20, elevated: 30, 'cut-and-cover': 40, deep: 60 },
    },
    /** Long-distance timetables: a new route runs every 15 min at the peaks, 20 at midday, none at night. */
    operations: { defaultHeadways: { night: 0, am: 15, midday: 20, pm: 15, evening: 30 }, headwayChoices: [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60] },
    /** Airport passengers come from a whole region; the station is under the terminal. */
    special: { airportDecay: 60_000, access: 3000 },
    /** Festival-goers reach the venue from a station up to 15 km away (local trains, buses). */
    events: { venueAccess: 15_000, originDecay: 100_000, maxPeoplePerDay: 300_000 },
    /** Dedicated high-speed lines with no level crossings: a fraction of a metro's incidents. */
    incidents: { signal: 1 / 1000, breakdown: 1 / 150_000, sick: 1 / 60_000, police: 0.01 },
    /** Tokyo: a 16-car terminal on a viaduct beside the old station, pointing south-west and north. */
    hubs: [{ name: 'Tokyo', from: [139.7655, 35.6768], to: [139.7686, 35.6858], level: 'elevated', cls: 'highspeed', cars: 16, at: 500 }],
    /** Japan's population is shrinking; travel is about level. */
    growth: { cityGrowthPerYear: 0.002 },
    valueCapture: {
      /** The station-area district: Japan's big municipalities count only their station side. */
      districtRadius: 3000,
      /** Hundreds of yen of property per daily traveller (≈ 60 residents each, ¥30M of homes and land a head). */
      valuePerResident: 20e6,
      valuePerJob: 10e6,
      /** Fixed asset (1.4%) and city planning (0.3%) taxes on assessed values (≈ 70–80% of market). */
      taxRateHomes: 0.014,
      taxRateJobs: 0.014,
      /** Station-area development: a quarter of the tax increment (the Tsukuba Express precedent). */
      captureShare: 0.25,
    },
  },
};
