/**
 * Every tunable number in the game lives here.
 * Internal units are SI: metres, seconds, metres per second, and money in the city's currency.
 *
 * The sections below hold New York's values. Each city's differences are in CITY_BALANCE at
 * the bottom; src/cities/index.ts applyCity() restores these defaults and applies them.
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
  /** London-style names use a neighbourhood label this close to the station. */
  placeNameRadius: 450,
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
  /** Driving speed when either end is in the city's core regions (CITY_BALANCE.coreRegions). */
  driveSpeedCore: 14 * KMH,
  driveSpeedOther: 24 * KMH,
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
   * v1's fixed rate; v2's market mean (BONDS.mean) and the coupon of bonds from older saves.
   * Tuned from the spec's starting 4%: at 4% the interest on the ~$17B a 40-station core needs
   * exceeds what ~1.5M daily riders pay at a $3 fare. At 2.5% such a core breaks even (fares ≈
   * operations + staffing + maintenance + interest) around 1.5M riders. See README → Balance.
   */
  bondRate: 0.025,
  bondYears: 30,
  bankruptcyDays: 30,
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
}

/** Chance of each weather kind per weekday, by month (Jan…Dec). */
export interface ClimateDef {
  snow: number[];
  rain: number[];
  heat: number[];
}

export interface CityChaos {
  venues: VenueDef[];
  kinds: EventKindDef[];
  climate: ClimateDef;
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
export type CityId = 'nyc' | 'london';
type LL = [number, number];

/** Where a job counts as being in the CBD (parking penalty). */
export type ZoneRule =
  | { kind: 'region-south-of'; region: string; lat: number }
  | { kind: 'polygon'; ring: LL[] };

export interface CityBalance {
  /** Local projection origin (lon, lat). */
  origin: LL;
  map: { startCenter: LL; startZoom: number; bounds: [number, number, number, number] };
  /** Camera behind the title screen (slow 3D orbit). */
  titleCamera: { center: LL; zoom: number; bearing: number };
  /** Regions (boroughs) with slow, congested driving. */
  coreRegions: string[];
  cbd: ZoneRule;
  commuters: Partial<Pick<typeof COMMUTERS, 'driveSpeedCore' | 'driveSpeedOther' | 'parkingCbdTime' | 'parkingCbdCost' | 'parkingOtherTime' | 'valueOfTime' | 'driveCostPerKm' | 'modeConstant'>>;
  economy: Partial<Pick<typeof ECONOMY, 'startingCash' | 'fareDefault' | 'fareMin' | 'fareMax' | 'fareStep'>>;
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
}

/** Each city's events and weather (the shared chaos tunables are CHAOS, WEATHER and EVENTS above). */
export const CHAOS_BY_CITY: Record<CityId, CityChaos> = { nyc: NYC_CHAOS, london: LONDON_CHAOS };

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
  },
  london: {
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
    },
    chaos: CHAOS_BY_CITY.london,
  },
};
