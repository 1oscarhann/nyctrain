import type { StockId, TrackClass } from '../balance';

/** Bullet shapes the player can pick for a route. */
export type BulletShape = 'circle' | 'square' | 'diamond' | 'bar';
export const BULLET_SHAPES: BulletShape[] = ['circle', 'square', 'diamond', 'bar'];
export const isBulletShape = (v: unknown): v is BulletShape => BULLET_SHAPES.includes(v as BulletShape);

export type PeriodId = 'night' | 'am' | 'midday' | 'pm' | 'evening';
export const PERIOD_IDS: PeriodId[] = ['night', 'am', 'midday', 'pm', 'evening'];

/** Operations control (v2): headway holding, timepoints, recovery time and short turnarounds. */
export interface RouteControl {
  /** Hold departures whose gap to the train ahead is below holdFraction × the scheduled headway. */
  hold: boolean;
  /** One of OPS_CONTROL.holdFractionChoices. */
  holdFraction: number;
  /** Station ids where trains may be held mid-route (the first stop always counts when hold is on). */
  timepoints: number[];
  /** Recovery added to each terminal layover, as a share of the one-way run time (OPS_CONTROL.recoveryChoices). */
  recoveryPct: number;
  /**
   * Crews turn a train in OPS_CONTROL.turnaroundMin instead of OPERATIONS.turnaround when its next
   * departure is already due. On for every new and migrated route; off only in the all-off
   * configuration (offControl), which reproduces the code before operations control.
   */
  shortTurn: boolean;
}

export interface Route {
  id: number;
  name: string;
  /** Letter or number shown in the bullet. */
  bullet: string;
  color: string;
  /** Bullet shape (absent = the theme's default: a disc, or London's line bar). */
  shape?: BulletShape;
  /** Track family the route runs on: 'heavy' (heavy and high-speed track) or 'light'. */
  cls: TrackClass;
  /** Train type (balance.ts TRAINS). Routes from before train types load as their track's metro trains. */
  stock: StockId;
  /** Station ids in order (direction 0 runs first → last). */
  stops: number[];
  cars: number;
  /** Minutes between trains per period; 0 = no service. */
  headways: Record<PeriodId, number>;
  /** Cars owned by this route (idle ones can be sold, routes/fleet.ts). */
  ownedCars: number;
  /** Operations control (v2). */
  control: RouteControl;
  /** Express service (v2, four-track trunks): drawn with the lozenge bullet. Absent = local. */
  express?: boolean;
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

/** London-style line colours (the player's lines, in the spirit of a London transport map). */
export const ROUTE_COLORS_TFL = [
  '#DC241F', // red
  '#0098D4', // sky blue
  '#FFD329', // yellow
  '#00782A', // green
  '#9B0056', // magenta
  '#F3A9BB', // pink
  '#B36305', // brown
  '#6950A1', // violet
  '#EE7C0E', // orange
  '#00A4A7', // teal
  '#A0A5A9', // grey
  '#95CDBA', // pale aqua
  '#1C3F94', // navy
  '#84B817', // lime
  '#000000', // black
  '#7156A5', // plum
  '#E21836', // bright red
  '#0019A8', // deep blue
];

/** The palette for a theme ('tfl' London style; anything else New York style). */
export function routePalette(theme: string): string[] {
  return theme === 'tfl' ? ROUTE_COLORS_TFL : ROUTE_COLORS;
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
  '#0039A6',
  '#00933C',
  '#FCCC0A',
  '#B933AD',
  '#808183',
  '#1A1A1A',
];
