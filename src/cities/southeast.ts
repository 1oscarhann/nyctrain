import type { CityConfig } from './types';
import { SE_AREAS, SE_LONDON, SE_REGIONS } from './southeastRegions';

/** Coastal districts (the "reach the sea" goal). */
const COAST = ['Brighton and Hove', 'Adur', 'Worthing', 'Arun', 'Chichester', 'Portsmouth', 'Havant', 'Southampton', 'Eastbourne', 'Hastings', 'Thanet', 'Dover', 'Shepway', 'Isle of Wight', 'Lewes', 'Rother', 'Gosport', 'Fareham', 'New Forest', 'Canterbury', 'Swale', 'Medway'];

/** The big places: one connected network reaching all of them is the stretch goal. */
const TOWNS = ['Westminster', 'Brighton and Hove', 'Portsmouth', 'Southampton', 'Reading', 'Oxford', 'Milton Keynes', 'Canterbury', 'Crawley', 'Guildford', 'Maidstone', 'Arun'];

/**
 * The South East intertown map: London and the 67 districts of the ONS South East region, one
 * commuting market of 6.35 million people (2011 census). A railway builder at regional scale:
 * main lines, commuter and intercity trains, high-speed line. Every game starts with one terminal,
 * Victoria; the rest is the player's.
 */
export const SOUTHEAST: CityConfig = {
  id: 'southeast',
  theme: 'tfl',
  intertown: true,
  defaultHeavyStock: 'commuter',
  name: 'South East',
  dataPath: 'data/southeast/',
  currency: '£',
  regionWord: 'district',
  zoneWord: 'neighbourhood areas (MSOAs)',
  regions: SE_REGIONS.map((r, i) => ({ name: r.name, code: i + 1, area: r.area })),
  areas: SE_AREAS,
  areaColors: ['#DC241F', '#00A4A7', '#F3A9BB', '#84B817', '#9B0056'],
  naming: 'place',
  blurb:
    'London and the whole South East, but the railway was never built. You get one terminal at Victoria, real 2011 census commuting for 6.35 million people from Oxford to Dover and Brighton to Milton Keynes, and £15 billion. Lay main lines, run commuter, intercity and high-speed trains, and win people out of their cars.',
  people: 'commuters',
  transitWord: 'railway',
  lowIncomeBand: 'commuters in the lowest of three earnings bands (modelled from area income, about 30%)',
  valueCaptureTax: 'business rates and council tax',
  defaultUnits: 'metric',
  timeZone: { utcOffset: 0, dst: 'eu' },
  valueCaptureDistrict: 'business rate supplement district',
  goals: [
    { id: 'london-sea', title: 'London to the sea', detail: 'A running route linking a London borough with a coastal district.', kind: 'crossing', a: SE_LONDON, b: COAST },
    { id: 'all-towns', title: 'Reach the big towns', detail: `One connected network with a station in ${TOWNS.slice(1).join(', ')} and central London.`, stretch: true, kind: 'connect', regions: TOWNS },
    { id: 'brighton-60', title: 'Victoria to Brighton in under an hour', detail: 'Door to door by rail, from Victoria to Brighton station.', kind: 'trip' },
  ],
  tutorial: {
    jobs: 'Open Overlays (the layers button on the left) and choose Jobs density. Central London dwarfs everything, but Brighton, Southampton, Portsmouth, Reading, Oxford and Crawley glow too.',
    track: 'Press T for the track tool and pick Main line. Start from the end of the elevated track south of Victoria, keep it elevated over the river (a bridge), then click points south towards Croydon and Gatwick. Double-click to finish; switch to At-grade beyond the river to save money.',
  },
  attribution: 'Commuting data: ONS / Nomis, Open Government Licence v3.0',
};
