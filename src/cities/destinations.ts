/**
 * Special destinations beyond the commute (shared by every thread): airports and universities.
 *
 * Airports: passengers a day from annual totals (2023/24 published figures, both directions), of
 * which `local` is the share starting or ending their journey on the map by land (not changing
 * planes). Universities: main campuses with approximate published student enrolments (rounded; a
 * university's students are counted at its main campus).
 */
import type { CityId, TrackLevel } from '../balance';

export interface Airport {
  name: string;
  lon: number;
  lat: number;
  /** Passengers a day, both directions. */
  perDay: number;
  /**
   * The airport's station, built from the start (free, like the Victoria hub): a straight stub of
   * track from a to b with the platform in the middle. Connect a line to it.
   */
  stub?: { a: [number, number]; b: [number, number]; level: TrackLevel; station: string };
}

export interface Campus {
  name: string;
  lon: number;
  lat: number;
  students: number;
}

const HEATHROW: Airport = { name: 'Heathrow Airport', lon: -0.4543, lat: 51.47, perDay: 230_000, stub: { a: [-0.4585, 51.4712], b: [-0.4465, 51.4714], level: 'deep', station: 'Heathrow Airport' } };
const CITY_AIRPORT: Airport = { name: 'London City Airport', lon: 0.0495, lat: 51.5048, perDay: 9_500, stub: { a: [0.0425, 51.5034], b: [0.0545, 51.5038], level: 'elevated', station: 'London City Airport' } };

const LONDON_UNIS: Campus[] = [
  { name: 'UCL', lon: -0.134, lat: 51.5246, students: 51_000 },
  { name: "King's College London", lon: -0.116, lat: 51.5115, students: 37_000 },
  { name: 'Imperial College London', lon: -0.1749, lat: 51.4988, students: 22_000 },
  { name: 'LSE', lon: -0.1165, lat: 51.5144, students: 12_000 },
  { name: 'Queen Mary University of London', lon: -0.0403, lat: 51.524, students: 32_000 },
  { name: 'City St George’s, University of London', lon: -0.1027, lat: 51.5279, students: 20_000 },
  { name: 'University of Westminster', lon: -0.143, lat: 51.5216, students: 19_000 },
  { name: 'University of Greenwich', lon: -0.0066, lat: 51.4826, students: 23_000 },
  { name: 'University of East London', lon: 0.0656, lat: 51.5077, students: 25_000 },
  { name: 'Kingston University', lon: -0.3036, lat: 51.4029, students: 17_000 },
  { name: 'Brunel University of London', lon: -0.473, lat: 51.5326, students: 15_000 },
  { name: 'Middlesex University', lon: -0.2284, lat: 51.5893, students: 19_000 },
  { name: 'Goldsmiths', lon: -0.0354, lat: 51.4743, students: 9_000 },
  { name: 'London South Bank University', lon: -0.1018, lat: 51.4985, students: 18_000 },
  { name: 'University of Roehampton', lon: -0.242, lat: 51.4567, students: 12_000 },
];

/**
 * Japan: the main islands' airports, passengers a day from 2023 totals (rounded). Each has a
 * 16-car high-speed station under or beside the terminal, built from the start.
 */
const jp = (name: string, lon: number, lat: number, perDay: number, a: [number, number], b: [number, number], level: TrackLevel = 'elevated'): Airport => ({ name, lon, lat, perDay, stub: { a, b, level, station: name } });
const JAPAN_AIRPORTS: Airport[] = [
  jp('Haneda Airport', 139.784, 35.5505, 216_000, [139.784, 35.5465], [139.7826, 35.554], 'deep'),
  jp('Narita Airport', 140.386, 35.769, 91_000, [140.3858, 35.765], [140.386, 35.7725], 'deep'),
  jp('Kansai Airport', 135.243, 34.432, 71_000, [135.238, 34.429], [135.244, 34.4345]),
  jp('Fukuoka Airport', 130.4485, 33.586, 62_000, [130.4475, 33.582], [130.4455, 33.5893], 'deep'),
  jp('New Chitose Airport', 141.6865, 42.774, 59_000, [141.686, 42.77], [141.687, 42.7775], 'deep'),
  jp('Itami Airport', 135.4405, 34.7855, 41_000, [135.441, 34.782], [135.4405, 34.7895]),
  jp('Chubu Airport', 136.813, 34.8585, 28_000, [136.809, 34.8575], [136.817, 34.86]),
  jp('Kagoshima Airport', 130.7175, 31.803, 14_000, [130.717, 31.7995], [130.718, 31.807]),
  jp('Kobe Airport', 135.225, 34.6365, 9_000, [135.221, 34.6365], [135.229, 34.6365]),
  jp('Sendai Airport', 140.9185, 38.1385, 8_000, [140.918, 38.135], [140.9195, 38.1425]),
  jp('Kumamoto Airport', 130.8555, 32.8375, 8_000, [130.854, 32.834], [130.8565, 32.841]),
  jp('Nagasaki Airport', 129.9138, 32.916, 8_000, [129.9125, 32.9125], [129.915, 32.9195]),
  jp('Miyazaki Airport', 131.447, 31.8775, 8_000, [131.446, 31.874], [131.4475, 31.881]),
  jp('Matsuyama Airport', 132.703, 33.8285, 8_000, [132.702, 33.825], [132.7035, 33.832]),
  jp('Hiroshima Airport', 132.92, 34.4365, 7_000, [132.918, 34.433], [132.922, 34.4395]),
  jp('Hakodate Airport', 140.821, 41.7715, 4_000, [140.82, 41.768], [140.8215, 41.7755]),
];

export const AIRPORTS: Record<CityId, Airport[]> = {
  nyc: [
    { name: 'JFK Airport', lon: -73.7781, lat: 40.6413, perDay: 170_000, stub: { a: [-73.7855, 40.6455], b: [-73.7765, 40.6423], level: 'elevated', station: 'JFK Airport' } },
    { name: 'LaGuardia Airport', lon: -73.874, lat: 40.7769, perDay: 90_000, stub: { a: [-73.8800, 40.7738], b: [-73.8700, 40.7752], level: 'elevated', station: 'LaGuardia Airport' } },
  ],
  london: [HEATHROW, CITY_AIRPORT],
  manchester: [{ name: 'Manchester Airport', lon: -2.2727, lat: 53.365, perDay: 77_000, stub: { a: [-2.2778, 53.3656], b: [-2.2688, 53.3649], level: 'elevated', station: 'Manchester Airport' } }],
  birmingham: [{ name: 'Birmingham Airport', lon: -1.748, lat: 52.4539, perDay: 31_000, stub: { a: [-1.7528, 52.4532], b: [-1.7438, 52.4541], level: 'elevated', station: 'Birmingham Airport' } }],
  leeds: [{ name: 'Leeds Bradford Airport', lon: -1.6606, lat: 53.8659, perDay: 11_000, stub: { a: [-1.6652, 53.8668], b: [-1.6562, 53.8656], level: 'at-grade', station: 'Leeds Bradford Airport' } }],
  bristol: [{ name: 'Bristol Airport', lon: -2.7191, lat: 51.3827, perDay: 27_000, stub: { a: [-2.7237, 51.3832], b: [-2.7148, 51.3824], level: 'at-grade', station: 'Bristol Airport' } }],
  japan: JAPAN_AIRPORTS,
  southeast: [HEATHROW, CITY_AIRPORT, { name: 'Gatwick Airport', lon: -0.1821, lat: 51.1537, perDay: 118_000, stub: { a: [-0.1606, 51.1615], b: [-0.1616, 51.1515], level: 'at-grade', station: 'Gatwick Airport' } }, { name: 'Southampton Airport', lon: -1.3568, lat: 50.9503, perDay: 2_000, stub: { a: [-1.3628, 50.9555], b: [-1.3602, 50.9457], level: 'at-grade', station: 'Southampton Airport Parkway' } }],
};

export const CAMPUSES: Record<CityId, Campus[]> = {
  /** No students on the high-speed map: they don't commute by Shinkansen. */
  japan: [],
  nyc: [
    { name: 'New York University', lon: -73.9965, lat: 40.7295, students: 59_000 },
    { name: 'Columbia University', lon: -73.9626, lat: 40.8075, students: 36_000 },
    { name: 'Borough of Manhattan CC', lon: -74.0119, lat: 40.7187, students: 25_000 },
    { name: 'Hunter College', lon: -73.9646, lat: 40.7685, students: 23_000 },
    { name: 'Baruch College', lon: -73.9834, lat: 40.7402, students: 20_000 },
    { name: "St. John's University", lon: -73.7949, lat: 40.7223, students: 20_000 },
    { name: 'Queens College', lon: -73.8201, lat: 40.7366, students: 19_000 },
    { name: 'Brooklyn College', lon: -73.9524, lat: 40.6311, students: 17_000 },
    { name: 'Fordham University', lon: -73.8856, lat: 40.861, students: 17_000 },
    { name: 'City College of New York', lon: -73.9493, lat: 40.82, students: 16_000 },
    { name: 'LaGuardia Community College', lon: -73.935, lat: 40.744, students: 15_000 },
    { name: 'Lehman College', lon: -73.8945, lat: 40.873, students: 15_000 },
    { name: 'New York City College of Technology', lon: -73.9874, lat: 40.6955, students: 15_000 },
    { name: 'Kingsborough CC', lon: -73.9345, lat: 40.5785, students: 14_000 },
    { name: 'John Jay College', lon: -73.9885, lat: 40.7705, students: 13_000 },
    { name: 'College of Staten Island', lon: -74.1485, lat: 40.6023, students: 11_000 },
    { name: 'The New School', lon: -73.9971, lat: 40.7355, students: 10_000 },
    { name: 'Pace University', lon: -74.0049, lat: 40.7111, students: 8_000 },
  ],
  london: LONDON_UNIS,
  manchester: [
    { name: 'University of Manchester', lon: -2.2339, lat: 53.4668, students: 44_000 },
    { name: 'Manchester Metropolitan University', lon: -2.2405, lat: 53.4705, students: 40_000 },
    { name: 'University of Salford', lon: -2.2705, lat: 53.4862, students: 25_000 },
    { name: 'University of Bolton', lon: -2.4372, lat: 53.5732, students: 8_000 },
  ],
  birmingham: [
    { name: 'University of Birmingham', lon: -1.93, lat: 52.4508, students: 38_000 },
    { name: 'Birmingham City University', lon: -1.8835, lat: 52.4835, students: 30_000 },
    { name: 'Aston University', lon: -1.888, lat: 52.4865, students: 17_000 },
    { name: 'Coventry University', lon: -1.4997, lat: 52.4053, students: 38_000 },
    { name: 'University of Warwick', lon: -1.5615, lat: 52.3793, students: 29_000 },
    { name: 'University of Wolverhampton', lon: -2.1276, lat: 52.588, students: 22_000 },
  ],
  leeds: [
    { name: 'University of Leeds', lon: -1.5551, lat: 53.8067, students: 38_000 },
    { name: 'Leeds Beckett University', lon: -1.5492, lat: 53.803, students: 24_000 },
    { name: 'University of Huddersfield', lon: -1.778, lat: 53.643, students: 19_000 },
    { name: 'University of Bradford', lon: -1.764, lat: 53.792, students: 10_000 },
    { name: 'Leeds Trinity University', lon: -1.648, lat: 53.846, students: 9_000 },
  ],
  bristol: [
    { name: 'University of Bristol', lon: -2.6029, lat: 51.4584, students: 30_000 },
    { name: 'UWE Bristol', lon: -2.548, lat: 51.5, students: 30_000 },
    { name: 'University of Bath', lon: -2.328, lat: 51.378, students: 20_000 },
    { name: 'Bath Spa University', lon: -2.44, lat: 51.373, students: 9_000 },
  ],
  southeast: [
    ...LONDON_UNIS,
    { name: 'University of Oxford', lon: -1.2544, lat: 51.7548, students: 26_000 },
    { name: 'Oxford Brookes University', lon: -1.224, lat: 51.755, students: 18_000 },
    { name: 'University of Reading', lon: -0.9418, lat: 51.4414, students: 19_000 },
    { name: 'University of Southampton', lon: -1.396, lat: 50.9346, students: 24_000 },
    { name: 'Solent University', lon: -1.4, lat: 50.908, students: 10_000 },
    { name: 'University of Portsmouth', lon: -1.0937, lat: 50.7955, students: 28_000 },
    { name: 'University of Sussex', lon: -0.0876, lat: 50.8671, students: 18_000 },
    { name: 'University of Brighton', lon: -0.1189, lat: 50.8429, students: 15_000 },
    { name: 'University of Surrey', lon: -0.5895, lat: 51.243, students: 16_000 },
    { name: 'Royal Holloway', lon: -0.5631, lat: 51.4256, students: 12_000 },
    { name: 'University of Kent', lon: 1.07, lat: 51.2967, students: 18_000 },
    { name: 'Canterbury Christ Church University', lon: 1.088, lat: 51.2798, students: 15_000 },
    { name: 'Buckinghamshire New University', lon: -0.752, lat: 51.6283, students: 10_000 },
    { name: 'University of Chichester', lon: -0.7845, lat: 50.8433, students: 5_000 },
  ],
};
