import type { CityConfig } from './types';
import { JP_AREAS, JP_PREFECTURES } from './japanRegions';

const KYUSHU = ['Fukuoka', 'Saga', 'Nagasaki', 'Kumamoto', 'Oita', 'Miyazaki', 'Kagoshima'];
const SHIKOKU = ['Tokushima', 'Kagawa', 'Ehime', 'Kochi'];
const HONSHU = JP_PREFECTURES.map((p) => p.name).filter((n) => n !== 'Hokkaido' && !KYUSHU.includes(n) && !SHIKOKU.includes(n));

/**
 * Japan, the high-speed map: the four main islands, 124 million people and 2 million journeys a
 * weekday between them (MLIT's 2015 inter-regional passenger survey), but the Shinkansen was never
 * built. One terminal at Tokyo, ¥5 trillion, mountains everywhere. Airports are already there,
 * and enormous: a station under the terminal brings their passengers to your trains.
 */
export const JAPAN: CityConfig = {
  id: 'japan',
  theme: 'hsr',
  intertown: true,
  defaultHeavyStock: 'highspeed',
  trackClasses: ['highspeed'],
  defaultLevel: 'elevated',
  platformCars: { highspeed: 16 },
  stocks: ['highspeed'],
  stockNames: { highspeed: 'Shinkansen' },
  research: ['hs-2', 'hs-3', 'hs-360', 'tilting', 'lightweight', 'regen', 'cbtc', 'ato', 'driverless', 'eew', 'snowproof', 'psd', 'gates', 'tbm', 'viaducts', 'labs-2'],
  currencyScale: 100,
  relief: true,
  tractWords: { residents: 'Travellers from here', jobs: 'Visitors' },
  overlayDensity: { residents: [2, 300], jobs: [2, 300], min: 0.5 },
  name: 'Japan',
  dataPath: 'data/japan/',
  currency: '¥',
  regionWord: 'prefecture',
  zoneWord: 'municipalities',
  regions: JP_PREFECTURES.map((p) => ({ name: p.name, code: p.code, area: p.area })),
  areas: JP_AREAS,
  areaColors: ['#4FA3E0', '#E8452C', '#3FB68B', '#F2B035', '#A77BDB'],
  naming: 'place',
  blurb:
    'Japan, but the Shinkansen was never built. You get one terminal at Tokyo, ¥5 trillion and 2 million real journeys a weekday between 1,657 towns and cities, from Kagoshima to Wakkanai. Bore through the mountains, bridge the straits, and connect the airports, where hundreds of thousands come and go every day.',
  people: 'travellers',
  transitWord: 'shinkansen',
  lowIncomeBand: 'travellers on private trips (visiting family, shopping, other: the lowest value of time, about a third of journeys)',
  valueCaptureTax: 'fixed asset tax',
  defaultUnits: 'metric',
  timeZone: { utcOffset: 9, dst: 'none' },
  valueCaptureDistrict: 'station-area development district',
  goals: [
    { id: 'tokaido', title: 'Tokyo to Osaka', detail: 'A running route linking Tokyo with Osaka.', kind: 'crossing', a: ['Tokyo'], b: ['Osaka'] },
    { id: 'seikan', title: 'Under the strait to Hokkaido', detail: 'A running route linking Hokkaido with Honshu (the Tsugaru Strait is 20 km of sea: a deep tunnel or a very long bridge).', kind: 'crossing', a: ['Hokkaido'], b: HONSHU },
    { id: 'four-islands', title: 'All four islands', detail: 'One connected network with stations in Hokkaido, Tokyo, Osaka, Shikoku and Kyushu.', stretch: true, kind: 'connect', regions: ['Hokkaido', 'Tokyo', 'Osaka', 'Kagawa', 'Fukuoka'] },
    { id: 'tokyo-osaka-150', title: 'Tokyo to Osaka in under 2½ hours', detail: 'Door to door, from Tokyo station to Umeda.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Terrain: mountains (brown) make surface track several times dearer, so tunnel through them or follow the coast. Then try Visitors: Osaka, Kyoto, Nagoya and Fukuoka are where people are going.',
    line: 'Press L for the Line tool. Start on the end of the Tokyo terminal, then click where each station goes, west towards Nagoya and Osaka, tens of kilometres apart. Elevated is the usual high-speed level; switch to deep tunnel (the level buttons) through the mountains. Press Enter to finish: the track, stations and route are planned together.',
  },
  attribution: 'Travel data: MLIT 全国幹線旅客純流動調査 (2015). Boundaries, elevation: 国土数値情報 (MLIT). Population: 2020 Census mesh statistics (e-Stat)',
};
