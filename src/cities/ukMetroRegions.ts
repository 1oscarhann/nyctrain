/**
 * The four English city-region maps beyond London: their local authority districts (ONS 2011
 * codes, in land-code order), how charts group them, and what the data pipeline checks. Shared by
 * scripts/build-data-ukmetro.ts and the city configs (src/cities/ukMetros.ts).
 *
 *   Manchester  Greater Manchester (10 metropolitan boroughs)
 *   Birmingham  the West Midlands county (7 metropolitan boroughs, Wolverhampton to Coventry)
 *   Leeds       West Yorkshire (5 metropolitan districts: Leeds, Bradford, Calderdale, Kirklees, Wakefield)
 *   Bristol     the West of England (Bristol, Bath and North East Somerset, North Somerset, South Gloucestershire)
 */
export type UkMetroId = 'manchester' | 'birmingham' | 'leeds' | 'bristol';

type LL = [number, number];

export interface UkRegion {
  /** ONS 2011 LAD code. */
  id: string;
  /** Name in the game. */
  name: string;
  /** Name in the ONS 2011 boundaries when it differs ("Bristol, City of"). */
  onsName?: string;
  /** Chart area index into UkMetroSpec.areas. */
  area: number;
}

export interface UkMetroSpec {
  id: UkMetroId;
  name: string;
  /** What the map covers, for copy ("Greater Manchester"). */
  region: string;
  /** Local projection origin (lon, lat): the traditional centre. */
  origin: LL;
  regions: UkRegion[];
  areas: string[];
  /** Pipeline report: places to name the busiest job areas by. [name, lat, lon]. */
  landmarks: [string, number, number][];
  /** Pipeline land-mask checks: [label, lon, lat, region name or null for water]. */
  probes: [string, number, number, string | null][];
}

export const UK_METROS: Record<UkMetroId, UkMetroSpec> = {
  manchester: {
    id: 'manchester',
    name: 'Manchester',
    region: 'Greater Manchester',
    origin: [-2.2446, 53.4794], // Albert Square, by the Town Hall
    areas: ['Regional centre', 'North', 'South', 'East', 'West'],
    regions: [
      { id: 'E08000001', name: 'Bolton', area: 4 },
      { id: 'E08000002', name: 'Bury', area: 1 },
      { id: 'E08000003', name: 'Manchester', area: 0 },
      { id: 'E08000004', name: 'Oldham', area: 3 },
      { id: 'E08000005', name: 'Rochdale', area: 1 },
      { id: 'E08000006', name: 'Salford', area: 0 },
      { id: 'E08000007', name: 'Stockport', area: 2 },
      { id: 'E08000008', name: 'Tameside', area: 3 },
      { id: 'E08000009', name: 'Trafford', area: 2 },
      { id: 'E08000010', name: 'Wigan', area: 4 },
    ],
    landmarks: [
      ['St Peter’s Square / Oxford Road', 53.4782, -2.2433],
      ['Piccadilly', 53.4774, -2.2309],
      ['Spinningfields / Deansgate', 53.4805, -2.2525],
      ['Salford Quays / MediaCity', 53.4723, -2.2985],
      ['Trafford Park', 53.465, -2.315],
      ['Manchester Airport', 53.365, -2.2727],
      ['University / Oxford Road corridor', 53.4668, -2.2339],
      ['Stockport', 53.4084, -2.1494],
      ['Bolton', 53.5769, -2.4282],
      ['Wigan', 53.5451, -2.6325],
      ['Oldham', 53.5409, -2.1114],
      ['Rochdale', 53.6097, -2.1561],
      ['Bury', 53.5933, -2.2966],
      ['Ashton-under-Lyne', 53.4886, -2.0952],
      ['Altrincham', 53.3871, -2.3496],
      ['Wythenshawe', 53.3926, -2.2645],
      ['Trafford Centre', 53.4669, -2.3473],
    ],
    probes: [
      ['Manchester Town Hall', -2.2446, 53.4794, 'Manchester'],
      ['Salford Central', -2.2552, 53.4831, 'Salford'],
      ['MediaCity', -2.2985, 53.4723, 'Salford'],
      ['Manchester Airport terminals', -2.2727, 53.365, 'Manchester'],
      ['Stockport station', -2.1626, 53.4054, 'Stockport'],
      ['Bolton Town Hall', -2.4297, 53.5779, 'Bolton'],
      ['Wigan Wallgate', -2.6331, 53.5449, 'Wigan'],
      ['Old Trafford', -2.2913, 53.4631, 'Trafford'],
    ],
  },
  birmingham: {
    id: 'birmingham',
    name: 'Birmingham',
    region: 'the West Midlands',
    origin: [-1.9035, 52.4797], // Victoria Square
    areas: ['Birmingham', 'Black Country', 'Coventry', 'Solihull'],
    regions: [
      { id: 'E08000025', name: 'Birmingham', area: 0 },
      { id: 'E08000026', name: 'Coventry', area: 2 },
      { id: 'E08000027', name: 'Dudley', area: 1 },
      { id: 'E08000028', name: 'Sandwell', area: 1 },
      { id: 'E08000029', name: 'Solihull', area: 3 },
      { id: 'E08000030', name: 'Walsall', area: 1 },
      { id: 'E08000031', name: 'Wolverhampton', area: 1 },
    ],
    landmarks: [
      ['Colmore Row / Snow Hill', 52.4825, -1.8995],
      ['New Street / Bullring', 52.4777, -1.8985],
      ['Brindleyplace / Broad Street', 52.4785, -1.9125],
      ['Digbeth / Curzon Street', 52.4785, -1.8835],
      ['Queen Elizabeth Hospital / University', 52.4508, -1.9406],
      ['Birmingham Airport / NEC', 52.4524, -1.7319],
      ['Solihull', 52.4128, -1.7781],
      ['Coventry city centre', 52.4081, -1.5106],
      ['Wolverhampton', 52.5862, -2.1288],
      ['Walsall', 52.586, -1.9829],
      ['West Bromwich', 52.5187, -1.9945],
      ['Dudley', 52.5123, -2.0811],
      ['Merry Hill', 52.4815, -2.1124],
      ['Sutton Coldfield', 52.5631, -1.8226],
      ['Longbridge', 52.3962, -1.9808],
    ],
    probes: [
      ['Victoria Square', -1.9035, 52.4797, 'Birmingham'],
      ['Birmingham Airport', -1.748, 52.4539, 'Solihull'],
      ['Coventry Cathedral', -1.5072, 52.4083, 'Coventry'],
      ['Wolverhampton station', -2.1197, 52.5876, 'Wolverhampton'],
      ['West Bromwich', -1.9945, 52.5187, 'Sandwell'],
      ['Dudley Castle', -2.0822, 52.5126, 'Dudley'],
      ['Walsall station', -1.9851, 52.5845, 'Walsall'],
    ],
  },
  leeds: {
    id: 'leeds',
    name: 'Leeds',
    region: 'West Yorkshire',
    origin: [-1.547, 53.7958], // City Square
    areas: ['Leeds', 'Bradford', 'Calderdale', 'Kirklees', 'Wakefield'],
    regions: [
      { id: 'E08000032', name: 'Bradford', area: 1 },
      { id: 'E08000033', name: 'Calderdale', area: 2 },
      { id: 'E08000034', name: 'Kirklees', area: 3 },
      { id: 'E08000035', name: 'Leeds', area: 0 },
      { id: 'E08000036', name: 'Wakefield', area: 4 },
    ],
    landmarks: [
      ['Leeds city centre / Park Row', 53.798, -1.546],
      ['Leeds station / South Bank', 53.7948, -1.5478],
      ['Leeds University / LGI', 53.8067, -1.5551],
      ['White Rose / Thorpe Park', 53.7578, -1.5735],
      ['Leeds Bradford Airport', 53.8659, -1.6606],
      ['Bradford city centre', 53.7938, -1.7521],
      ['Halifax', 53.7248, -1.8638],
      ['Huddersfield', 53.6458, -1.785],
      ['Wakefield', 53.6833, -1.4977],
      ['Dewsbury', 53.691, -1.6292],
      ['Keighley', 53.8679, -1.9064],
      ['Pontefract / Castleford', 53.7234, -1.3484],
      ['Headingley', 53.8195, -1.5761],
    ],
    probes: [
      ['City Square', -1.547, 53.7958, 'Leeds'],
      ['Bradford City Hall', -1.7539, 53.7925, 'Bradford'],
      ['Halifax Piece Hall', -1.8601, 53.7213, 'Calderdale'],
      ['Huddersfield station', -1.7848, 53.6485, 'Kirklees'],
      ['Wakefield Westgate', -1.5052, 53.6831, 'Wakefield'],
      ['Leeds Bradford Airport', -1.6606, 53.8659, 'Leeds'],
    ],
  },
  bristol: {
    id: 'bristol',
    name: 'Bristol',
    region: 'the West of England',
    origin: [-2.597, 51.4545], // The Centre
    areas: ['Bristol', 'Bath', 'North Somerset', 'South Gloucestershire'],
    regions: [
      { id: 'E06000022', name: 'Bath and North East Somerset', area: 1 },
      { id: 'E06000023', name: 'Bristol', onsName: 'Bristol, City of', area: 0 },
      { id: 'E06000024', name: 'North Somerset', area: 2 },
      { id: 'E06000025', name: 'South Gloucestershire', area: 3 },
    ],
    landmarks: [
      ['The Centre / Broadmead', 51.4568, -2.5915],
      ['Temple Meads / Temple Quarter', 51.4491, -2.5813],
      ['Harbourside', 51.4507, -2.6006],
      ['University / Clifton', 51.4584, -2.6029],
      ['Southmead Hospital', 51.4958, -2.5917],
      ['Filton / Aztec West', 51.5203, -2.5752],
      ['Cribbs Causeway', 51.5246, -2.5948],
      ['Bath city centre', 51.3811, -2.359],
      ['Weston-super-Mare', 51.3463, -2.9771],
      ['Bristol Airport', 51.3827, -2.7191],
      ['Yate', 51.5404, -2.4118],
      ['Clevedon / Portishead', 51.4846, -2.7672],
    ],
    probes: [
      ['The Centre', -2.597, 51.4545, 'Bristol'],
      ['Temple Meads', -2.5813, 51.4491, 'Bristol'],
      ['Bath Abbey', -2.3586, 51.3815, 'Bath and North East Somerset'],
      ['Weston-super-Mare station', -2.9717, 51.3445, 'North Somerset'],
      ['Bristol Airport', -2.7191, 51.3827, 'North Somerset'],
      ['Filton', -2.5752, 51.5203, 'South Gloucestershire'],
      ['Severn estuary off Portishead', -2.8, 51.5, null],
    ],
  },
};

export const UK_METRO_IDS = Object.keys(UK_METROS) as UkMetroId[];
