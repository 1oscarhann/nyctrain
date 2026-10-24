/**
 * The South East intertown map: London's 33 boroughs plus the 67 local authority districts of the
 * ONS South East region (2011 boundaries). Codes 1–33 are London (E09000001–33, same order as the
 * London map), 34–100 the South East in ONS code order. Shared by the data pipeline
 * (scripts/build-data-southeast.ts) and the city config (src/cities/southeast.ts).
 */
export interface SeRegion {
  /** ONS 2011 LAD code. */
  id: string;
  name: string;
  /** Chart area index into SE_AREAS. */
  area: number;
}

export const SE_AREAS = ['London', 'Kent', 'Sussex', 'Surrey & Hampshire', 'Thames Valley'];

const LONDON_NAMES = [
  'City of London', 'Barking and Dagenham', 'Barnet', 'Bexley', 'Brent', 'Bromley', 'Camden', 'Croydon', 'Ealing', 'Enfield',
  'Greenwich', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Harrow', 'Havering', 'Hillingdon', 'Hounslow', 'Islington',
  'Kensington and Chelsea', 'Kingston upon Thames', 'Lambeth', 'Lewisham', 'Merton', 'Newham', 'Redbridge',
  'Richmond upon Thames', 'Southwark', 'Sutton', 'Tower Hamlets', 'Waltham Forest', 'Wandsworth', 'Westminster',
];

const K = 1, S = 2, H = 3, T = 4;
const SOUTH_EAST: [string, string, number][] = [
  ['E06000035', 'Medway', K],
  ['E06000036', 'Bracknell Forest', T],
  ['E06000037', 'West Berkshire', T],
  ['E06000038', 'Reading', T],
  ['E06000039', 'Slough', T],
  ['E06000040', 'Windsor and Maidenhead', T],
  ['E06000041', 'Wokingham', T],
  ['E06000042', 'Milton Keynes', T],
  ['E06000043', 'Brighton and Hove', S],
  ['E06000044', 'Portsmouth', H],
  ['E06000045', 'Southampton', H],
  ['E06000046', 'Isle of Wight', H],
  ['E07000004', 'Aylesbury Vale', T],
  ['E07000005', 'Chiltern', T],
  ['E07000006', 'South Bucks', T],
  ['E07000007', 'Wycombe', T],
  ['E07000061', 'Eastbourne', S],
  ['E07000062', 'Hastings', S],
  ['E07000063', 'Lewes', S],
  ['E07000064', 'Rother', S],
  ['E07000065', 'Wealden', S],
  ['E07000084', 'Basingstoke and Deane', H],
  ['E07000085', 'East Hampshire', H],
  ['E07000086', 'Eastleigh', H],
  ['E07000087', 'Fareham', H],
  ['E07000088', 'Gosport', H],
  ['E07000089', 'Hart', H],
  ['E07000090', 'Havant', H],
  ['E07000091', 'New Forest', H],
  ['E07000092', 'Rushmoor', H],
  ['E07000093', 'Test Valley', H],
  ['E07000094', 'Winchester', H],
  ['E07000105', 'Ashford', K],
  ['E07000106', 'Canterbury', K],
  ['E07000107', 'Dartford', K],
  ['E07000108', 'Dover', K],
  ['E07000109', 'Gravesham', K],
  ['E07000110', 'Maidstone', K],
  ['E07000111', 'Sevenoaks', K],
  ['E07000112', 'Shepway', K],
  ['E07000113', 'Swale', K],
  ['E07000114', 'Thanet', K],
  ['E07000115', 'Tonbridge and Malling', K],
  ['E07000116', 'Tunbridge Wells', K],
  ['E07000177', 'Cherwell', T],
  ['E07000178', 'Oxford', T],
  ['E07000179', 'South Oxfordshire', T],
  ['E07000180', 'Vale of White Horse', T],
  ['E07000181', 'West Oxfordshire', T],
  ['E07000207', 'Elmbridge', H],
  ['E07000208', 'Epsom and Ewell', H],
  ['E07000209', 'Guildford', H],
  ['E07000210', 'Mole Valley', H],
  ['E07000211', 'Reigate and Banstead', H],
  ['E07000212', 'Runnymede', H],
  ['E07000213', 'Spelthorne', H],
  ['E07000214', 'Surrey Heath', H],
  ['E07000215', 'Tandridge', H],
  ['E07000216', 'Waverley', H],
  ['E07000217', 'Woking', H],
  ['E07000223', 'Adur', S],
  ['E07000224', 'Arun', S],
  ['E07000225', 'Chichester', S],
  ['E07000226', 'Crawley', S],
  ['E07000227', 'Horsham', S],
  ['E07000228', 'Mid Sussex', S],
  ['E07000229', 'Worthing', S],
];

export const SE_REGIONS: SeRegion[] = [
  ...LONDON_NAMES.map((name, i) => ({ id: `E090000${String(i + 1).padStart(2, '0')}`, name, area: 0 })),
  ...SOUTH_EAST.map(([id, name, area]) => ({ id, name, area })),
];

export const SE_LONDON = LONDON_NAMES;
