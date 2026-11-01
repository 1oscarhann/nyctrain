/**
 * Tokyo (the subway map): the 23 special wards, grouped into five areas for charts, and the
 * suburban railway terminals where commuters from outside the wards arrive. A ward's land-mask code
 * is its JIS municipality code less 13100, so Chiyoda (13101) is 1 and Edogawa (13123) is 23.
 */

export const TK_AREAS = ['Central', 'South', 'West', 'North', 'East'];

export interface TkWard {
  /** JIS municipality code less 13100 (the land-mask code). */
  code: number;
  /** Name in the source data (kanji). */
  ja: string;
  name: string;
  /** Index into TK_AREAS. */
  area: number;
}

export const TK_WARDS: TkWard[] = [
  { code: 1, ja: '千代田区', name: 'Chiyoda', area: 0 },
  { code: 2, ja: '中央区', name: 'Chuo', area: 0 },
  { code: 3, ja: '港区', name: 'Minato', area: 0 },
  { code: 4, ja: '新宿区', name: 'Shinjuku', area: 0 },
  { code: 5, ja: '文京区', name: 'Bunkyo', area: 0 },
  { code: 6, ja: '台東区', name: 'Taito', area: 4 },
  { code: 7, ja: '墨田区', name: 'Sumida', area: 4 },
  { code: 8, ja: '江東区', name: 'Koto', area: 4 },
  { code: 9, ja: '品川区', name: 'Shinagawa', area: 1 },
  { code: 10, ja: '目黒区', name: 'Meguro', area: 1 },
  { code: 11, ja: '大田区', name: 'Ota', area: 1 },
  { code: 12, ja: '世田谷区', name: 'Setagaya', area: 1 },
  { code: 13, ja: '渋谷区', name: 'Shibuya', area: 0 },
  { code: 14, ja: '中野区', name: 'Nakano', area: 2 },
  { code: 15, ja: '杉並区', name: 'Suginami', area: 2 },
  { code: 16, ja: '豊島区', name: 'Toshima', area: 2 },
  { code: 17, ja: '北区', name: 'Kita', area: 3 },
  { code: 18, ja: '荒川区', name: 'Arakawa', area: 3 },
  { code: 19, ja: '板橋区', name: 'Itabashi', area: 3 },
  { code: 20, ja: '練馬区', name: 'Nerima', area: 2 },
  { code: 21, ja: '足立区', name: 'Adachi', area: 3 },
  { code: 22, ja: '葛飾区', name: 'Katsushika', area: 4 },
  { code: 23, ja: '江戸川区', name: 'Edogawa', area: 4 },
];

/** Where commuters from outside the 23 wards come from (TK_TERMINALS shares). */
export type TkDirection = 'kanagawa' | 'saitama' | 'chiba' | 'north' | 'tama' | 'other';

export interface TkTerminal {
  /** Tract id in tracts.json ("T-shinjuku"). */
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** Ward (TK_WARDS code) it stands in. */
  ward: number;
  /** The railways that end here, for copy. */
  lines: string;
  /**
   * Share of each direction's commuters this terminal would take if every job were equally far
   * from every terminal: the pipeline then favours the terminal nearest each commuter's office.
   */
  from: Partial<Record<TkDirection, number>>;
}

/**
 * The suburban railways' termini. The premise: the main lines and private railways were built
 * out to the suburbs, as they really were by the 1930s, but they stop here, at the edge of the old
 * city, and nothing crosses it: no subway, no Yamanote loop, no through-running. (Several of these
 * were real termini: the Sobu line ended at Ryogoku until 1932, the Tobu line at Asakusa, the
 * Tohoku and Joban lines at Ueno until 2015, the Keiyo line at Shin-Kiba until 1990.)
 */
export const TK_TERMINALS: TkTerminal[] = [
  { id: 'T-shinagawa', name: 'Shinagawa', lon: 139.7387, lat: 35.6285, ward: 3, lines: 'the Tokaido, Yokosuka and Keikyu lines', from: { kanagawa: 0.4, other: 0.5 } },
  { id: 'T-shibuya', name: 'Shibuya', lon: 139.7016, lat: 35.658, ward: 13, lines: 'the Toyoko, Den-en-toshi and Inokashira lines', from: { kanagawa: 0.38, tama: 0.15 } },
  { id: 'T-shinjuku', name: 'Shinjuku', lon: 139.7006, lat: 35.69, ward: 4, lines: 'the Chuo, Odakyu and Keio lines', from: { kanagawa: 0.22, tama: 0.7 } },
  { id: 'T-ikebukuro', name: 'Ikebukuro', lon: 139.7109, lat: 35.7295, ward: 16, lines: 'the Tojo, Seibu and Saikyo lines', from: { saitama: 0.45, tama: 0.15 } },
  { id: 'T-ueno', name: 'Ueno', lon: 139.7774, lat: 35.7134, ward: 6, lines: 'the Tohoku, Takasaki, Joban and Keisei lines', from: { saitama: 0.4, chiba: 0.3, north: 0.85, other: 0.5 } },
  { id: 'T-asakusa', name: 'Asakusa', lon: 139.7983, lat: 35.7115, ward: 6, lines: 'the Tobu Skytree line', from: { saitama: 0.15, north: 0.15 } },
  { id: 'T-ryogoku', name: 'Ryogoku', lon: 139.7932, lat: 35.6966, ward: 7, lines: 'the Sobu line', from: { chiba: 0.45 } },
  { id: 'T-shinkiba', name: 'Shin-Kiba', lon: 139.827, lat: 35.6458, ward: 8, lines: 'the Keiyo line', from: { chiba: 0.25 } },
];
