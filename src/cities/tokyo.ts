import type { CityConfig } from './types';
import { TK_AREAS, TK_WARDS } from './tokyoRegions';

const WEST_OF_SUMIDA = ['Chiyoda', 'Minato', 'Shinjuku', 'Shibuya', 'Bunkyo', 'Taito', 'Toshima'];
const EAST_OF_SUMIDA = ['Sumida', 'Koto', 'Edogawa', 'Katsushika'];

/**
 * Tokyo, the subway map: the 23 special wards, real 2020 Census commuting between their 925 towns,
 * and 2.8 million suburban commuters a day arriving at the railway terminals on the edge of the
 * centre. The suburban railways were built; nothing crosses the city. Separate from the high-speed
 * Japan map: no Shinkansen here, a metro with a metro's money.
 */
export const TOKYO: CityConfig = {
  id: 'tokyo',
  theme: 'tokyo',
  name: 'Tokyo',
  dataPath: 'data/tokyo/',
  currency: '¥',
  currencyScale: 100,
  minAgentScale: 20,
  regionWord: 'ward',
  zoneWord: 'towns',
  regions: TK_WARDS.map((w) => ({ name: w.name, code: w.code, area: w.area })),
  areas: TK_AREAS,
  areaColors: ['#F39700', '#00A7DB', '#6CBB5A', '#9B7CB6', '#E85298'],
  naming: 'town',
  ownTractNames: true,
  /** Tokyo's subway trains are ten 20 m cars. */
  platformCars: { heavy: 10 },
  blurb:
    'Tokyo, but nobody built the subway. The suburban railways stop at eight terminals on the edge of the centre — Shinjuku, Shibuya, Ikebukuro, Ueno and the rest — and 2.8 million commuters pour out of them every morning, on top of 3 million more travelling between the 23 wards. Nothing crosses the city: no Yamanote loop, no through-running. ¥700 billion. Get them to work.',
  people: 'Tokyoites',
  transitWord: 'subway',
  lowIncomeBand: 'commuters in the lowest of three income bands (modelled from ward income, about 30%)',
  valueCaptureTax: 'fixed asset tax',
  defaultUnits: 'metric',
  timeZone: { utcOffset: 9, dst: 'none' },
  valueCaptureDistrict: 'station-area development district',
  goals: [
    { id: 'cross-sumida', title: 'Cross the Sumida', detail: 'A running route linking the centre with the wards east of the Sumida river.', kind: 'crossing', a: WEST_OF_SUMIDA, b: EAST_OF_SUMIDA },
    { id: 'all-wards', title: 'Reach all 23 wards', detail: 'One connected network with a station in every ward.', stretch: true, kind: 'connect', regions: TK_WARDS.map((w) => w.name) },
    { id: 'shinjuku-otemachi-20', title: 'Shinjuku to Otemachi in under 20 minutes', detail: 'Door to door by subway, from Shinjuku station to the Otemachi offices.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'The teal rings on the edge of the centre are the railway terminals: 2.8 million suburban commuters get off there every morning. Open Overlays (the layers button on the left) and choose Jobs density: Marunouchi, Otemachi, Ginza and Nishi-Shinjuku light up — that’s where they are going.',
    line: 'Press L for the Line tool and click where each station goes: start next to a terminal (Shinjuku is the biggest) and head for Otemachi and Marunouchi, keeping stops at least 400 m apart. Inside the Yamanote loop it has to be tunnel. Press Enter to finish: the track, stations and route are planned together.',
  },
  attribution: 'Commuting: 2020 Census via Tokyo Metropolitan Government (東京都の昼間人口). Boundaries: e-Stat. Land use: 国土数値情報 (MLIT). Romaji: Japan Post',
};
