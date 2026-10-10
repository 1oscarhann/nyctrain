import type { TrackClass } from '../balance';

export type PeriodId = 'night' | 'am' | 'midday' | 'pm' | 'evening';
export const PERIOD_IDS: PeriodId[] = ['night', 'am', 'midday', 'pm', 'evening'];

export interface Route {
  id: number;
  name: string;
  /** Letter or number shown in the bullet. */
  bullet: string;
  color: string;
  cls: TrackClass;
  /** Station ids in order (direction 0 runs first → last). */
  stops: number[];
  cars: number;
  /** Minutes between trains per period; 0 = no service. */
  headways: Record<PeriodId, number>;
  /** Cars purchased for this route (never sold). */
  ownedCars: number;
}

/** One piece of a route path: traverse `edge` from u0 to u1 (edge coordinates from node a). */
export interface PathLeg {
  edge: number;
  /** 0 = a→b, 1 = b→a */
  dir: 0 | 1;
  u0: number;
  u1: number;
}

export interface RoutePath {
  ok: boolean;
  error?: string;
  /** Direction 0 legs, first stop centre to last stop centre. */
  legs: PathLeg[];
  /** Distance along the direction-0 path to each stop. */
  stopS: number[];
  length: number;
}

export const ROUTE_COLORS = [
  '#E8443A',
  '#F28C28',
  '#F6C445',
  '#3FAE5A',
  '#1FA3A3',
  '#2F7FE0',
  '#6A5ACD',
  '#B04FCF',
  '#E05A9B',
  '#8C6E4E',
  '#9BA4AE',
  '#A3D14B',
];
