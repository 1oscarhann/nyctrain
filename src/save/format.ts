/**
 * Versioned save format. Agents are not saved — they regenerate from the data with a seeded RNG;
 * the per-pair mode shares and observed times are saved so ridership picks up where it left off.
 */
import type { NetworkData } from '../construction/types';
import type { FinanceData } from '../economy/finance';
import type { Route } from '../routes/types';
import type { GoalState } from '../core/goals';
import type { UnitSystem } from '../core/units';

export const SAVE_VERSION = 2;

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
  meta: { name: string; savedAt: string; day: number; time: number; sandbox: boolean; cash: number; riders: number };
  game: {
    time: number;
    sandbox: boolean;
    fare: number;
    network: NetworkData;
    routes: { routes: Route[]; nextId: number };
    finance: FinanceData;
    goals: GoalState;
    /** Days of history for the top bar after loading. */
    lastReport: unknown | null;
    tutorialDone: boolean;
  };
  settings: SaveSettings;
  modeState: SavedModeState | null;
}

export function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export function b64ToF32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
