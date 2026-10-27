/**
 * The English city-region maps beyond London (src/cities/ukMetroRegions.ts has their districts):
 * Greater Manchester, the West Midlands, West Yorkshire and the West of England. Each is a metro
 * map like London's, with real 2011 census commuting and none of the trams, metros or local rail
 * lines that were ever built.
 */
import type { CityConfig, CityGoal } from './types';
import { UK_METROS, type UkMetroId } from './ukMetroRegions';

const UK_COMMON = {
  theme: 'tfl',
  currency: '£',
  regionWord: 'borough',
  zoneWord: 'neighbourhood areas (MSOAs)',
  naming: 'place',
  transitWord: 'metro',
  lowIncomeBand: 'commuters in the lowest of three earnings bands (modelled from area income, about 30%)',
  valueCaptureTax: 'business rates and council tax',
  defaultUnits: 'metric',
  timeZone: { utcOffset: 0, dst: 'eu' },
  valueCaptureDistrict: 'business rate supplement district',
  attribution: 'Commuting data: ONS / Nomis, Open Government Licence v3.0',
} as const satisfies Partial<CityConfig>;

const AREA_COLORS = ['#DC241F', '#0098D4', '#00A4A7', '#F3A9BB', '#84B817'];

function ukCity(id: UkMetroId, more: Pick<CityConfig, 'blurb' | 'people' | 'goals' | 'tutorial'> & Partial<CityConfig>): CityConfig {
  const s = UK_METROS[id];
  return {
    ...UK_COMMON,
    id,
    name: s.name,
    dataPath: `data/${id}/`,
    regions: s.regions.map((r, i) => ({ name: r.name, code: i + 1, area: r.area })),
    areas: s.areas,
    areaColors: AREA_COLORS.slice(0, s.areas.length),
    ...more,
  };
}

const names = (id: UkMetroId) => UK_METROS[id].regions.map((r) => r.name);
const allOf = (id: UkMetroId, title: string): CityGoal => ({
  id: 'all-boroughs',
  title,
  detail: `One connected network with a station in every ${id === 'leeds' ? 'district' : id === 'bristol' ? 'council area' : 'borough'}: ${names(id).join(', ')}.`,
  stretch: true,
  kind: 'connect',
  regions: names(id),
});

export const MANCHESTER = ukCity('manchester', {
  blurb:
    'Greater Manchester, but nobody ever laid a tram line or electrified a single local railway. Real 2011 census commuting for all ten boroughs, from Wigan to Oldham and Bolton to the airport, and £3.5 billion. Draw the lines — 900,000 commuters decide whether they beat the M60.',
  people: 'commuters',
  goals: [
    { id: 'cross-irwell', title: 'Cross the Irwell', detail: 'A running route linking Manchester with Salford or Trafford.', kind: 'crossing', a: ['Manchester'], b: ['Salford', 'Trafford'] },
    allOf('manchester', 'Reach all ten boroughs'),
    { id: 'airport-30', title: 'Piccadilly to the airport in under 30 minutes', detail: 'Door to door by transit, from Piccadilly to the terminals.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. The city centre, Salford Quays, Trafford Park and the airport light up — that’s where your trains need to go.',
    line: 'Press L for the Line tool and click where each station goes, from Piccadilly through the city centre towards Salford Quays (keep stops at least 400 m apart). Press Enter to finish: the track, stations and route are planned together.',
  },
});

export const BIRMINGHAM = ukCity('birmingham', {
  blurb:
    'The West Midlands, but the canals got all the attention and nobody built a metro. Real 2011 census commuting for seven boroughs from Wolverhampton to Coventry, and £3.5 billion. Draw the lines — 840,000 commuters decide whether they beat the ring roads.',
  people: 'commuters',
  goals: [
    { id: 'black-country', title: 'Into the Black Country', detail: 'A running route linking Birmingham with Sandwell, Dudley, Walsall or Wolverhampton.', kind: 'crossing', a: ['Birmingham'], b: ['Sandwell', 'Dudley', 'Walsall', 'Wolverhampton'] },
    allOf('birmingham', 'Reach all seven boroughs'),
    { id: 'airport-25', title: 'New Street to the airport in under 25 minutes', detail: 'Door to door by transit, from New Street to the terminal.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. The city centre inside the Middleway glows brightest, with the hospital and university to the south-west, and Coventry and Wolverhampton at either end.',
    line: 'Press L for the Line tool and click where each station goes, from Snow Hill through New Street towards Edgbaston and the university (keep stops at least 400 m apart). Press Enter to finish: the track, stations and route are planned together.',
  },
});

export const LEEDS = ukCity('leeds', {
  regionWord: 'district',
  blurb:
    'West Yorkshire. Leeds is often called the biggest city in Western Europe without a metro — and here nobody ever ran a local train either. Real 2011 census commuting for Leeds, Bradford, Calderdale, Kirklees and Wakefield, and £3.5 billion. Draw the lines — 780,000 commuters decide whether they beat the M62.',
  people: 'commuters',
  goals: [
    { id: 'leeds-bradford', title: 'Join Leeds and Bradford', detail: 'A running route linking the two cities.', kind: 'crossing', a: ['Leeds'], b: ['Bradford'] },
    allOf('leeds', 'Reach all five districts'),
    { id: 'airport-30', title: 'Leeds to the airport in under 30 minutes', detail: 'Door to door by transit, from City Square to the terminal.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. Leeds city centre glows brightest, with Bradford, Huddersfield, Halifax and Wakefield as their own smaller centres.',
    line: 'Press L for the Line tool and click where each station goes, from Leeds station through the city centre towards Headingley (keep stops at least 400 m apart). Press Enter to finish: the track, stations and route are planned together.',
  },
});

export const BRISTOL = ukCity('bristol', {
  regionWord: 'council area',
  blurb:
    'Bristol, Bath and the West of England, where people have argued about a metro for decades — and here there isn’t a single local train either. Real 2011 census commuting for four council areas and £2.5 billion. Draw the lines — nearly 400,000 commuters decide whether they beat the M32.',
  people: 'commuters',
  goals: [
    { id: 'bristol-bath', title: 'Bristol to Bath', detail: 'A running route linking Bristol with Bath and North East Somerset.', kind: 'crossing', a: ['Bristol'], b: ['Bath and North East Somerset'] },
    allOf('bristol', 'Reach all four council areas'),
    { id: 'airport-30', title: 'Temple Meads to the airport in under 30 minutes', detail: 'Door to door by transit, from Temple Meads to the terminal.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. The centre, Temple Quarter and the harbourside light up, with Filton’s aerospace plants to the north and Bath to the east.',
    line: 'Press L for the Line tool and click where each station goes, from Temple Meads through the centre towards Clifton (keep stops at least 400 m apart). Press Enter to finish: the track, stations and route are planned together.',
  },
});
