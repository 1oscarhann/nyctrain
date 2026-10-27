/**
 * Research effects (balance.ts RESEARCH, TRAIN_MARKS, TECH_EFFECTS). Like applyCity, this sets the
 * shared tunables on the thread it runs on: the main thread applies the game's finished research
 * (new game, load, each project finishing), the sim worker the list carried by every compiled
 * network. applyCity resets the city's own numbers and calls resetTech, so the tech base is always
 * the city's values; applyTech([]) puts everything back exactly.
 *
 * Trains are not global: each route runs one mark (Route.mark), read through stockSpec().
 */
import {
  CHAOS,
  ECONOMY,
  OPERATIONS,
  RESEARCH,
  STATION,
  STATION_CROWD,
  TECH_EFFECTS,
  TRACK,
  TRAIN_MARKS,
  TRAINS,
  type ResearchId,
  type StockId,
  type TrackLevel,
  type TrainSpec,
} from '../balance';

const RESEARCH_IDS = new Set<string>(RESEARCH.map((r) => r.id));

/** City-independent tunables research touches, as written in balance.ts (captured once). */
const FIXED_BASE = {
  safetyMargin: OPERATIONS.safetyMargin,
  dwellBase: OPERATIONS.dwellBase,
  scheduledDwell: OPERATIONS.scheduledDwell,
  dwellPerPassenger: OPERATIONS.dwellPerPassenger,
  headwayChoices: [...OPERATIONS.headwayChoices],
  peoplePerMetre: STATION_CROWD.peoplePerMetre,
  signalRate: CHAOS.signal.perTrackKmDay,
  policeRate: CHAOS.police.perStationDay,
};

/** The city's own values of what research changes (taken when a city is applied). */
interface CityBase {
  lineSpeed: Record<string, number>;
  costPerM: Record<TrackLevel, number>;
  daysPerKm: Record<TrackLevel, number>;
  stationCost: Record<TrackLevel, number>;
  stationDays: Record<TrackLevel, number>;
  operatingPerCarKm: number;
}

let cityBase: CityBase | null = null;
let done = new Set<ResearchId>();

function takeCityBase(): CityBase {
  return {
    lineSpeed: { ...TRACK.lineSpeed },
    costPerM: { ...TRACK.costPerM },
    daysPerKm: { ...TRACK.daysPerKm },
    stationCost: { ...STATION.costByLevel },
    stationDays: { ...STATION.buildDays },
    operatingPerCarKm: ECONOMY.operatingPerCarKm,
  };
}

/** A city was just applied (its numbers are fresh): they are the new base, with no research. */
export function resetTech(): void {
  cityBase = takeCityBase();
  done = new Set();
  writeGlobals();
}

/** Finished research in force on this thread (unknown ids are ignored). */
export function applyTech(list: readonly string[]): void {
  cityBase ??= takeCityBase();
  done = new Set(list.filter((id): id is ResearchId => RESEARCH_IDS.has(id)));
  writeGlobals();
}

export const hasTech = (id: ResearchId): boolean => done.has(id);
export const techList = (): ResearchId[] => RESEARCH.map((r) => r.id).filter((id) => done.has(id));

function writeGlobals(): void {
  const b = cityBase!;
  const e = TECH_EFFECTS;
  // Track: line speeds and construction.
  Object.assign(TRACK.lineSpeed, b.lineSpeed);
  if (done.has('mainline-230')) TRACK.lineSpeed.heavy = Math.max(TRACK.lineSpeed.heavy, e.mainlineSpeed);
  if (done.has('hs-360')) TRACK.lineSpeed.highspeed = Math.max(TRACK.lineSpeed.highspeed, e.hsLineSpeed);
  const deep = (l: TrackLevel) => l === 'deep' || l === 'cut-and-cover';
  for (const l of Object.keys(b.costPerM) as TrackLevel[]) {
    const tbm = done.has('tbm') && deep(l), via = done.has('viaducts') && l === 'elevated';
    TRACK.costPerM[l] = Math.round(b.costPerM[l] * (tbm ? e.tbmCost : via ? e.viaductCost : 1));
    TRACK.daysPerKm[l] = b.daysPerKm[l] * (tbm ? e.tbmDays : via ? e.viaductDays : 1);
    STATION.costByLevel[l] = Math.round(b.stationCost[l] * (tbm ? e.tbmStationCost : via ? e.viaductStationCost : 1));
    STATION.buildDays[l] = Math.max(1, Math.round(b.stationDays[l] * (tbm ? e.tbmDays : via ? e.viaductDays : 1)));
  }
  // Operations.
  ECONOMY.operatingPerCarKm =
    b.operatingPerCarKm * (done.has('regen') ? e.regenOperating : 1) * (done.has('lightweight') ? e.lightweightOperating : 1) * (done.has('driverless') ? e.driverlessOperating : 1);
  OPERATIONS.safetyMargin = done.has('cbtc') ? e.cbtcSafetyMargin : FIXED_BASE.safetyMargin;
  OPERATIONS.headwayChoices = done.has('cbtc') ? [...new Set([e.cbtcHeadway, ...FIXED_BASE.headwayChoices])].sort((x, y) => x - y) : [...FIXED_BASE.headwayChoices];
  OPERATIONS.dwellBase = FIXED_BASE.dwellBase - (done.has('ato') ? e.atoDwellCut : 0);
  OPERATIONS.scheduledDwell = FIXED_BASE.scheduledDwell - (done.has('ato') ? e.atoDwellCut : 0);
  OPERATIONS.dwellPerPassenger = FIXED_BASE.dwellPerPassenger * (done.has('psd') ? e.psdBoarding : 1);
  // Stations and incidents.
  STATION_CROWD.peoplePerMetre = FIXED_BASE.peoplePerMetre * (done.has('gates') ? e.gatesCapacity : 1);
  CHAOS.signal.perTrackKmDay = FIXED_BASE.signalRate * (done.has('cbtc') ? e.cbtcSignalFailures : 1);
  CHAOS.police.perStationDay = FIXED_BASE.policeRate * (done.has('psd') ? e.psdPolice : 1);
}

// ------------------------------------------------------------------------------------ trains

/** Marks of a train type unlocked so far (1 = Mk I). */
export function bestMark(stock: StockId): number {
  const marks = TRAIN_MARKS[stock];
  let m = 1;
  for (let i = 1; i < marks.length; i++) if (marks[i].research && done.has(marks[i].research!)) m = i + 1;
  return m;
}

/** A mark number made valid for a train type (absent or bad: Mk I). */
export function validMark(stock: StockId, mark: unknown): number {
  const n = Math.floor(Number(mark));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, TRAIN_MARKS[stock].length) : 1;
}

/** The train a route runs: its type at its mark, with lightweight bodies when researched. */
export function stockSpec(stock: StockId, mark = 1): TrainSpec {
  const base = TRAINS[stock];
  const m = TRAIN_MARKS[stock][validMark(stock, mark) - 1];
  const light = done.has('lightweight') ? TECH_EFFECTS.lightweightAccel : 1;
  return {
    ...base,
    topSpeed: m.topSpeed,
    accel: m.accel * light,
    brake: m.brake,
    capacityComfort: Math.round(base.capacityComfort * m.capacity),
    capacityCrush: Math.round(base.capacityCrush * m.capacity),
    costPerCar: Math.round(base.costPerCar * m.costMult),
  };
}

/** "Metro Mk II" (Mk I is just the type's name). */
export function stockName(stock: StockId, mark = 1): string {
  const m = validMark(stock, mark);
  return m > 1 ? `${TRAINS[stock].name} ${TRAIN_MARKS[stock][m - 1].name}` : TRAINS[stock].name;
}

/** Curve speed factor for a train type (tilting trains lean into curves). */
export function curveFactor(stock: StockId): number {
  return done.has('tilting') && TECH_EFFECTS.tiltStocks.includes(stock) ? TECH_EFFECTS.tiltCurve : 1;
}
