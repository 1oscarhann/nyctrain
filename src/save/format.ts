/**
 * Versioned save format. Agents are not saved — they regenerate from the data with a seeded RNG;
 * the per-pair mode shares and observed times are saved so ridership picks up where it left off.
 */
import type { NetworkData } from '../construction/types';
import type { FinanceData } from '../economy/finance';
import type { RouteSetData } from '../routes/routeSet';
import type { GoalState } from '../core/goals';
import type { UnitSystem } from '../core/units';
import type { ChaosLevel, CityId, GrowthPace } from '../balance';
import type { DayExposure, ServiceOverride } from '../sim/protocol';
import type { FarePolicy } from '../economy/fares';
import type { SavedTimelapse } from '../cinematic/timelapse';

/**
 * v3: city chaos (events, disruptions, weather). v4: operations control and the money market.
 * v5: Living City. v6: express services and four-track trunks. v7: the Cinematic timelapse.
 */
export const SAVE_VERSION = 7;

/**
 * Living City growth state (v5): what the saved groups (and so the saved mode shares) were
 * generated from. Null for the starting city.
 */
export interface SavedGrowth {
  version: 1;
  appliedThroughDay: number;
  months: number;
  sbar: [number, number];
  /** base64 Float32Array, one value per tract. */
  mRes: string;
  mJobs: string;
  fHome: string;
  fWork: string;
  premium: string;
  /** base64 Uint16Array(2T): round(multiplier × 10000), residents then jobs. */
  history: { day: number; q: string }[];
  city: [day: number, residents: number, jobs: number, valueCapture: number][];
  /** This month's commute-benefit samples (home and work: base64 Float64Array per tract); missing: none. */
  benefit?: { days: number; throughDay: number; meanSum: number; home: string; work: string };
}

/**
 * City chaos: the level, the seed (calendar, weather and the incident plan all derive from it) and
 * the planned event service. Active incidents, alerts and event agents are not saved: a load
 * replans the rest of the day from the same seed, at today's level and from today's 3 am exposure.
 */
export interface SavedChaos {
  /** The player's level, from the next 3 am. */
  level: ChaosLevel;
  /** The level in force today, if it differs from the next 3 am's (missing: `level`). */
  levelToday?: ChaosLevel;
  seed: number;
  service: ServiceOverride[];
  nextServiceId: number;
  /** What today's incidents were planned from at 3 am (missing: the loaded network's exposure). */
  dayExposure?: DayExposure;
}

export interface SaveSettings {
  units: UnitSystem;
  agentScale: number;
  seed: number;
}

export interface SavedModeState {
  key: string;
  /** base64 Float32Array */
  shares: string;
  obsTime: string;
  obsCrowd: string;
}

export interface SaveFile {
  format: 'headway-ny';
  version: number;
  /** Which city this game is in. Saves from before London existed are New York. */
  city: CityId;
  meta: { name: string; savedAt: string; day: number; time: number; sandbox: boolean; cash: number; riders: number; city?: CityId; company?: string };
  game: {
    time: number;
    sandbox: boolean;
    /** Fare policy (v4; v3 had one flat `fare`). */
    fares: FarePolicy;
    network: NetworkData;
    routes: RouteSetData;
    finance: FinanceData;
    goals: GoalState;
    /** Days of history for the top bar after loading. */
    lastReport: unknown | null;
    tutorialDone: boolean;
    chaos: SavedChaos;
    /** Living City pace (v5; older saves join on Steady). */
    growthPace: GrowthPace;
    /** Cinematic (v7): the network at each month close (older saves start empty). */
    timelapse: SavedTimelapse;
    /** Your company: name, logo and start-up grant (absent in older saves). */
    company?: unknown;
    /** Research: finished and in-progress projects (absent in older saves: none). */
    research?: unknown;
  };
  settings: SaveSettings;
  modeState: SavedModeState | null;
  /** Living City (v5): the growth the mode state's groups belong to (null: the starting city). */
  growth: SavedGrowth | null;
  /** Set by migrate() (not stored) when the file was older: the version it had. */
  migratedFrom?: number;
}

/** base64 of any typed array's bytes (little-endian, as the platform stores them). */
export function bytesToB64(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export function f32ToB64(a: Float32Array): string {
  return bytesToB64(a);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function b64ToF32(s: string): Float32Array {
  return new Float32Array(b64ToBytes(s).buffer);
}

export function b64ToU16(s: string): Uint16Array {
  return new Uint16Array(b64ToBytes(s).buffer);
}

export function b64ToF64(s: string): Float64Array {
  return new Float64Array(b64ToBytes(s).buffer);
}
