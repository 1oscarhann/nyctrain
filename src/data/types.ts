/** Shared data-file types. Used by the build script, the main thread and the sim worker. */

export type BoroughName = 'Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'Staten Island';

export const BOROUGHS: BoroughName[] = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];

/** County FIPS (state 36) → borough. */
export const BOROUGH_BY_COUNTY: Record<string, BoroughName> = {
  '36005': 'Bronx',
  '36047': 'Brooklyn',
  '36061': 'Manhattan',
  '36081': 'Queens',
  '36085': 'Staten Island',
};

/** Borough code used in land.geojson (NYC BoroCode). */
export const BOROUGH_CODE: Record<BoroughName, number> = {
  Manhattan: 1,
  Bronx: 2,
  Brooklyn: 3,
  Queens: 4,
  'Staten Island': 5,
};

export interface TractRecord {
  id: string;
  borough: BoroughName;
  lat: number;
  lon: number;
  /** Approximate radius in metres: sqrt(land area / π). Used to scatter people inside the tract. */
  radius: number;
  /** Commuters living here who work in NYC. */
  residents: number;
  /** NYC-resident commuters working here. */
  jobs: number;
}

export interface TractsFile {
  version: number;
  synthetic: boolean;
  year: number;
  source: string;
  bands: string[];
  tracts: TractRecord[];
}
