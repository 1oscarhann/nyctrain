/**
 * What makes a city a city: names, regions, copy and goals. Numbers (origin, map view, driving,
 * parking, money) live in src/balance.ts CITY_BALANCE.
 */
import type { CityId, StockId } from '../balance';
import type { UnitSystem } from '../core/units';
import type { TimeZone } from '../cinematic/solar';

export type { CityId };

export interface RegionDef {
  name: string;
  /** Code in the city's land.geojson (the land mask raster stores it). */
  code: number;
  /** Index into CityConfig.areas (chart grouping). */
  area: number;
}

interface GoalBase {
  id: string;
  title: string;
  detail: string;
  stretch?: boolean;
}

/** City-specific goals; the generic ones (first line, riders, share, commute, profit) are in core/goals.ts. */
export type CityGoal =
  /** A running route with stations in both region sets. */
  | (GoalBase & { kind: 'crossing'; a: string[]; b: string[] })
  /** One connected network with a running station in every listed region. */
  | (GoalBase & { kind: 'connect'; regions: string[] })
  /** Transit door to door from GOALS.tripFrom to GOALS.tripTo under GOALS.tripMinutes. */
  | (GoalBase & { kind: 'trip' });

export interface CityConfig {
  id: CityId;
  /** "New York", "London". */
  name: string;
  /** Data files, relative to the site root. */
  dataPath: string;
  currency: string;
  /** What a region is called ("borough"). */
  regionWord: string;
  /** What the data's small areas are called, plural ("census tracts"). */
  zoneWord: string;
  regions: RegionDef[];
  /** Up to five region groups for charts (boroughs in NYC, sub-regions in London). */
  areas: string[];
  areaColors: string[];
  /** Station names: "8th Av & W 42nd St" or a single place/street name ("Camden Road"). */
  naming: 'cross-streets' | 'place';
  /** Title screen and loading copy. */
  blurb: string;
  people: string;
  /** What the player's network is called in copy ("by subway", "by metro"). */
  transitWord: string;
  /** Who the low-income fare is for (finance panel copy): the lowest earnings band (FARES.lowIncomeBand). */
  lowIncomeBand: string;
  /** Living City: the tax whose increment value capture shares ("property tax"; London: council tax and business rates). */
  valueCaptureTax: string;
  /** Units until the player picks some for this city (Settings or the menu): New York miles, London kilometres. */
  defaultUnits: UnitSystem;
  /** Living City: what the value-capture district is called (finance panel heading). */
  valueCaptureDistrict: string;
  goals: CityGoal[];
  tutorial: { jobs: string; line: string };
  /** Extra data attribution shown on the map (licence requirements). */
  attribution?: string;
  /**
   * Cinematic (v2): the game clock is local civil time here; the sun (sunrise, sunset, the
   * day/night palette) follows this zone and the city's CITY_BALANCE origin.
   */
  timeZone: TimeZone;
  /**
   * Look and feel (main thread only): 'mta' is the New York subway style (round letter bullets,
   * white station dots); 'tfl' is London style (line bars, station ticks and interchange rings, a
   * humanist sans, navy panels). Applied as <html data-theme> by applyCity().
   */
  theme: CityTheme;
  /** Intertown map (the South East): main-line wording, commuter trains by default, distance fares. */
  intertown?: boolean;
  /** Trains a new route on heavy track gets ('heavy' metro in the cities, 'commuter' intertown). */
  defaultHeavyStock?: StockId;
}

export type CityTheme = 'mta' | 'tfl';
