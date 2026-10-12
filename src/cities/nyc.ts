import type { CityConfig } from './types';

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
/** NYC BoroCodes, as stored in land.geojson. */
const CODES: Record<string, number> = { Manhattan: 1, Bronx: 2, Brooklyn: 3, Queens: 4, 'Staten Island': 5 };

export const NYC: CityConfig = {
  id: 'nyc',
  name: 'New York',
  dataPath: 'data/',
  currency: '$',
  regionWord: 'borough',
  zoneWord: 'census tracts',
  regions: BOROUGHS.map((name, area) => ({ name, code: CODES[name], area })),
  areas: BOROUGHS,
  areaColors: ['#00A3B0', '#D8731C', '#8E99A5', '#B04FCF', '#A3D14B'],
  naming: 'cross-streets',
  blurb:
    'New York, but nobody ever built the subway. You get the real city, real commuting data for the five boroughs and a few billion dollars. Draw the lines — millions of New Yorkers decide whether they’re worth taking.',
  people: 'New Yorkers',
  transitWord: 'subway',
  goals: [
    { id: 'east-river', title: 'Cross the East River', detail: 'A running route linking Manhattan with Brooklyn or Queens.', kind: 'crossing', a: ['Manhattan'], b: ['Brooklyn', 'Queens'] },
    { id: 'five-boroughs', title: 'Connect all five boroughs', detail: 'One connected network reaching all five. Staten Island needs a long tunnel.', stretch: true, kind: 'connect', regions: BOROUGHS },
    { id: 'jfk-45', title: 'Midtown to JFK in under 45 minutes', detail: 'Door to door by transit, Bryant Park to the airport.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. Midtown and Lower Manhattan light up — that’s where your trains need to go.',
    track: 'Press T for the track tool. Deep tunnel is the sensible level under Manhattan. Click points from Lower Manhattan up towards Midtown, then double-click to finish.',
  },
};
