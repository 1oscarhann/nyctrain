import type { CityConfig } from './types';

/** London boroughs in ONS code order (E09000001–33); the code is the land.geojson code. */
const BOROUGHS = [
  'City of London', 'Barking and Dagenham', 'Barnet', 'Bexley', 'Brent', 'Bromley', 'Camden', 'Croydon', 'Ealing', 'Enfield',
  'Greenwich', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Harrow', 'Havering', 'Hillingdon', 'Hounslow', 'Islington',
  'Kensington and Chelsea', 'Kingston upon Thames', 'Lambeth', 'Lewisham', 'Merton', 'Newham', 'Redbridge',
  'Richmond upon Thames', 'Southwark', 'Sutton', 'Tower Hamlets', 'Waltham Forest', 'Wandsworth', 'Westminster',
];

/** London Plan sub-regions, used to group the 33 boroughs in charts. */
const AREAS: Record<string, string[]> = {
  Central: ['Camden', 'City of London', 'Islington', 'Kensington and Chelsea', 'Lambeth', 'Southwark', 'Westminster'],
  East: ['Barking and Dagenham', 'Bexley', 'Greenwich', 'Hackney', 'Havering', 'Lewisham', 'Newham', 'Redbridge', 'Tower Hamlets', 'Waltham Forest'],
  North: ['Barnet', 'Enfield', 'Haringey'],
  South: ['Bromley', 'Croydon', 'Kingston upon Thames', 'Merton', 'Richmond upon Thames', 'Sutton', 'Wandsworth'],
  West: ['Brent', 'Ealing', 'Hammersmith and Fulham', 'Harrow', 'Hillingdon', 'Hounslow'],
};
const AREA_NAMES = Object.keys(AREAS);

/** Boroughs wholly north / south of the Thames (Richmond straddles it, so it counts for neither). */
const NORTH = [
  'City of London', 'Westminster', 'Camden', 'Islington', 'Hackney', 'Tower Hamlets', 'Newham', 'Barking and Dagenham', 'Havering',
  'Redbridge', 'Waltham Forest', 'Haringey', 'Enfield', 'Barnet', 'Harrow', 'Brent', 'Ealing', 'Hillingdon', 'Hounslow',
  'Hammersmith and Fulham', 'Kensington and Chelsea',
];
const SOUTH = ['Lambeth', 'Southwark', 'Wandsworth', 'Lewisham', 'Greenwich', 'Bexley', 'Bromley', 'Croydon', 'Sutton', 'Merton', 'Kingston upon Thames'];

export const LONDON: CityConfig = {
  id: 'london',
  name: 'London',
  dataPath: 'data/london/',
  currency: '£',
  regionWord: 'borough',
  zoneWord: 'neighbourhood areas (MSOAs)',
  regions: BOROUGHS.map((name, i) => ({ name, code: i + 1, area: AREA_NAMES.findIndex((a) => AREAS[a].includes(name)) })),
  areas: AREA_NAMES,
  areaColors: ['#00A3B0', '#D8731C', '#8E99A5', '#B04FCF', '#A3D14B'],
  naming: 'place',
  blurb:
    'London, but nobody ever dug the Tube — or ran a single train across town. You get the real city, real 2011 census commuting for all 33 boroughs and a few billion pounds. Draw the lines — millions of Londoners decide whether they’re worth taking.',
  people: 'Londoners',
  goals: [
    { id: 'cross-thames', title: 'Cross the Thames', detail: 'A running route linking boroughs north and south of the river.', kind: 'crossing', a: NORTH, b: SOUTH },
    { id: 'all-boroughs', title: 'Reach every borough', detail: 'One connected network with a station in the City and all 32 boroughs.', stretch: true, kind: 'connect', regions: BOROUGHS },
    { id: 'heathrow-45', title: 'Bank to Heathrow in under 45 minutes', detail: 'Door to door by transit, from the City to the airport.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. The City, the West End and Canary Wharf light up — that’s where your trains need to go.',
    track: 'Press T for the track tool. Deep tunnel is the sensible level under central London. Click points from the City towards the West End, then double-click to finish.',
  },
  attribution: 'Commuting data: ONS / Nomis, Open Government Licence v3.0',
};
