/**
 * The balance scenarios' networks (scripts/balance.ts and the express experiments): each city's
 * ~40-station core, the low-density sprawl, and the core with a four-track express trunk. Built in
 * code from lon/lat waypoints with the headless helpers. `cars=` and `peak=` on the command line
 * set the train length and the peak headway, as before.
 */
import { drawLine, nodeSnapNear, pairNear, quadLine, stationNear } from '../src/sim/headless';
import { expressPattern } from '../src/routes/express';
import type { Game } from '../src/core/game';
import type { TrackLevel } from '../src/balance';

export type LL = [number, number];

export const CARS = Number(Object.fromEntries(process.argv.slice(2).map((a) => a.split('='))).cars ?? 10);
export const PEAK = Number(Object.fromEntries(process.argv.slice(2).map((a) => a.split('='))).peak ?? 2.5);

function line(game: Game, pts: LL[], levels: TrackLevel | TrackLevel[], stations: [LL, string][], cars = CARS) {
  drawLine(game, pts, levels);
  return stations.map(([p, n]) => stationNear(game, p, n, cars));
}

export function fund(_game: Game, _extra = 0) {
  /* sandbox: nothing to borrow */
}

/**
 * ~40 stations: a compact core — two Manhattan trunks with local-ish spacing, a Queens line
 * under the East River to Jackson Heights, and a Brooklyn line under the river to Bushwick.
 */
export function buildCoreNetwork(game: Game) {
  // Lexington: Bowling Green → 125 St
  const A = line(
    game,
    [
      [-74.0134, 40.7046],
      [-74.0045, 40.714],
      [-73.993, 40.7285],
      [-73.9775, 40.75],
      [-73.9378, 40.805],
    ],
    'deep',
    [
      [[-74.0125, 40.7062], 'Bowling Green'],
      [[-74.0068, 40.7112], 'Fulton St'],
      [[-74.0000, 40.7195], 'Canal St'],
      [[-73.9930, 40.7290], 'Astor Pl'],
      [[-73.9870, 40.7375], '18 St'],
      [[-73.9818, 40.7448], '28 St'],
      [[-73.9765, 40.7520], 'Grand Central'],
      [[-73.9705, 40.7600], '53 St'],
      [[-73.9645, 40.7683], '68 St'],
      [[-73.9585, 40.7765], '79 St'],
      [[-73.9525, 40.7847], '92 St'],
      [[-73.9465, 40.7930], '106 St'],
      [[-73.9408, 40.8010], '120 St'],
    ],
  );
  return { A, ...buildCoreTrunks(game) };
}

/** The core's three other lines (8th Av / CPW, Queens, 14 St), drawn after Lexington. */
export function buildCoreTrunks(game: Game) {
  // 8th Av / CPW: Atlantic Av (Brooklyn) → under the East River → West Side → 110 St
  const B = line(
    game,
    [
      [-73.978, 40.6838],
      [-73.9905, 40.6935],
      [-74.006, 40.709],
      [-74.008, 40.72],
      [-74.003, 40.7385],
      [-73.9819, 40.768],
      [-73.958, 40.801],
    ],
    'deep',
    [
      [[-73.9790, 40.6848], 'Atlantic Av'],
      [[-73.9895, 40.6928], 'Borough Hall'],
      [[-74.0075, 40.7140], 'Chambers St'],
      [[-74.0068, 40.7255], 'Spring St'],
      [[-74.0035, 40.7360], 'W 4 St'],
      [[-73.9990, 40.7445], '23 St'],
      [[-73.9930, 40.7525], '34 St'],
      [[-73.9875, 40.7600], '45 St'],
      [[-73.9810, 40.7695], 'Columbus Circle'],
      [[-73.9745, 40.7785], '79 St–CPW'],
      [[-73.9685, 40.7870], '91 St'],
      [[-73.9620, 40.7955], '103 St'],
    ],
  );
  // Queens: Times Sq → Grand Central → under the river → Queens Blvd → Jackson Heights
  const C = line(
    game,
    [
      [-73.9885, 40.7565],
      [-73.9705, 40.7485],
      [-73.951, 40.7445],
      [-73.938, 40.7487],
      [-73.917, 40.7438],
      [-73.886, 40.747],
    ],
    'deep',
    [
      [[-73.9850, 40.7550], 'Times Sq'],
      [[-73.9760, 40.7508], 'Grand Central–42 St'],
      [[-73.9560, 40.7455], 'Vernon Blvd'],
      [[-73.9420, 40.7472], 'Queens Plaza'],
      [[-73.9280, 40.7458], '36 St'],
      [[-73.9120, 40.7442], '52 St'],
      [[-73.8960, 40.7458], '69 St'],
      [[-73.8880, 40.7466], 'Jackson Heights'],
    ],
  );
  // 14 St / Williamsburg: 8 Av → under the East River → Bushwick
  const D = line(
    game,
    [
      [-74.004, 40.74],
      [-73.9795, 40.7298],
      [-73.957, 40.717],
      [-73.931, 40.705],
      [-73.912, 40.6995],
    ],
    'deep',
    [
      [[-73.9985, 40.7378], '6 Av'],
      [[-73.9875, 40.7333], '3 Av'],
      [[-73.9805, 40.7302], '1 Av'],
      [[-73.9560, 40.7163], 'Bedford Av'],
      [[-73.9400, 40.7092], 'Graham Av'],
      [[-73.9255, 40.7030], 'Jefferson St'],
      [[-73.9135, 40.6998], 'Myrtle–Wyckoff'],
    ],
  );
  return { B, C, D };
}

/** A point a fraction f of the way from a to b. */
const lerpLL = (a: LL, b: LL, f: number): LL => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** The New York express scenario's local-only trunk stations (the express skips them). */
export const NYC_EXPRESS_SKIPS = ['Astor Pl', '18 St', '28 St', '53 St', '68 St', '79 St', '106 St'];

/**
 * Express service (v2, docs/v2/express-quad.md §12): the core with Lexington from past Canal St
 * to past 106 St as a four-track trunk (double track Bowling Green → Canal and 106 → 120 St, the
 * quad fanning at both ends). The express calls at the trunk's hubs only: cross-platform stations
 * at Grand Central (the Queens line) and 92 St; the other seven trunk stations (Astor Pl, 18, 28,
 * 53, 68, 79 and 106 St) are local-only, so the express skips three or four stops between pairs
 * and the local's riders change across the platform. The same thirteen stations as the core,
 * whose Lexington is this network's all-stops twin. A is the all-stops local, X the express (its
 * Express pattern); both run at twice the core's headways, so the shared stations see the core's
 * service (riders there take the first train that gets them there about as soon).
 */
export function buildCoreExpressNetwork(game: Game) {
  const lex: LL[] = [[-74.0134, 40.7046], [-74.0045, 40.714], [-73.993, 40.7285], [-73.9775, 40.75], [-73.9378, 40.805]];
  const south = lerpLL(lex[1], lex[2], 0.586);
  const north = lerpLL(lex[3], lex[4], 0.845);
  drawLine(game, [lex[0], lex[1], south], 'deep');
  drawLine(game, [north, lex[4]], 'deep');
  quadLine(game, [south, lex[2], lex[3], north], 'deep', nodeSnapNear(game, south), nodeSnapNear(game, north), 1);
  const s = (p: LL, n: string) => stationNear(game, p, n, CARS);
  const loc = (p: LL, n: string) => stationNear(game, p, n, CARS, { role: 'local' });
  const pr = (p: LL, n: string) => pairNear(game, p, n, CARS)[0];
  const A = [
    s([-74.0125, 40.7062], 'Bowling Green'),
    s([-74.0068, 40.7112], 'Fulton St'),
    s([-74.0000, 40.7195], 'Canal St'),
    loc([-73.9930, 40.7290], 'Astor Pl'),
    loc([-73.9870, 40.7375], '18 St'),
    loc([-73.9818, 40.7448], '28 St'),
    pr([-73.9765, 40.7520], 'Grand Central'),
    loc([-73.9705, 40.7600], '53 St'),
    loc([-73.9645, 40.7683], '68 St'),
    loc([-73.9585, 40.7765], '79 St'),
    pr([-73.9525, 40.7847], '92 St'),
    loc([-73.9465, 40.7930], '106 St'),
    s([-73.9408, 40.8010], '120 St'),
  ];
  return { A, X: expressPattern(game.network, A), ...buildCoreTrunks(game) };
}

/** The express network's all-stops twin: the same stations on double track (New York: the core itself). */
export function buildCoreExpressTwin(game: Game) {
  return buildCoreNetwork(game);
}

/** Low-density sprawl: long elevated lines through eastern Queens and Staten Island. */
export function buildSprawlNetwork(game: Game) {
  const E = line(
    game,
    [
      [-73.81, 40.7],
      [-73.76, 40.725],
      [-73.725, 40.745],
    ],
    'elevated',
    [
      [[-73.8050, 40.7025], 'Jamaica'],
      [[-73.7900, 40.7100], 'Hillside'],
      [[-73.7750, 40.7175], 'Hollis'],
      [[-73.7580, 40.7262], 'Bellerose Jct'],
      [[-73.7420, 40.7350], 'Little Neck Pkwy'],
      [[-73.7280, 40.7430], 'Glen Oaks'],
    ],
  );
  const F = line(
    game,
    [
      [-74.077, 40.642],
      [-74.11, 40.6],
      [-74.16, 40.56],
      [-74.2, 40.525],
    ],
    'elevated',
    [
      [[-74.0790, 40.6385], 'St George'],
      [[-74.0920, 40.6215], 'Tompkinsville'],
      [[-74.1060, 40.6040], 'Grymes Hill'],
      [[-74.1250, 40.5900], 'New Springville'],
      [[-74.1450, 40.5735], 'Richmondtown'],
      [[-74.1650, 40.5560], 'Eltingville'],
      [[-74.1850, 40.5385], 'Huguenot'],
    ],
  );
  return { E, F };
}

/**
 * London core, ~43 stations on four deep lines: an east–west crosstown (Paddington–Bank–Stratford),
 * a north–south line under the Thames (Kentish Town–King's Cross–Elephant–Brixton), a West End to
 * Canary Wharf line along the South Bank, and Hammersmith–West End–City–Shadwell.
 */
export function buildLondonCoreNetwork(game: Game) {
  return { ...buildLondonCoreNetworkA(game), ...buildLondonCoreTrunks(game) };
}

/** London's line A, Paddington–Bank–Stratford (the core's first line). */
function buildLondonCoreNetworkA(game: Game) {
  const A = line(
    game,
    [[-0.1780, 51.5168], [-0.1585, 51.5136], [-0.1300, 51.5166], [-0.0975, 51.5146], [-0.0886, 51.5133], [-0.0600, 51.5195], [-0.0333, 51.5252], [-0.0030, 51.5420]],
    'deep',
    [
      [[-0.1755, 51.5162], 'Paddington'],
      [[-0.1585, 51.5136], 'Marble Arch'],
      [[-0.1415, 51.5152], 'Oxford Circus'],
      [[-0.1308, 51.5165], 'Tottenham Court Road'],
      [[-0.1200, 51.5163], 'Holborn'],
      [[-0.0975, 51.5146], "St Paul's"],
      [[-0.0886, 51.5133], 'Bank'],
      [[-0.0726, 51.5165], 'Aldgate East'],
      [[-0.0597, 51.5194], 'Whitechapel'],
      [[-0.0333, 51.5252], 'Mile End'],
      [[-0.0040, 51.5415], 'Stratford'],
    ],
  );
  return { A };
}

/** London's core: the three lines drawn after Paddington–Stratford. */
export function buildLondonCoreTrunks(game: Game, leaveOut: readonly string[] = []) {
  const B = line(
    game,
    [[-0.1405, 51.5502], [-0.1430, 51.5390], [-0.1240, 51.5300], [-0.1050, 51.5200], [-0.1040, 51.5040], [-0.1000, 51.4945], [-0.1130, 51.4815], [-0.1145, 51.4627]],
    'deep',
    [
      [[-0.1408, 51.5495], 'Kentish Town'],
      [[-0.1428, 51.5395], 'Camden Town'],
      [[-0.1335, 51.5345], 'Mornington Crescent'],
      [[-0.1240, 51.5300], "King's Cross"],
      [[-0.1150, 51.5248], 'Exmouth Market'],
      [[-0.1050, 51.5200], 'Farringdon'],
      [[-0.1045, 51.5118], 'Blackfriars'],
      [[-0.1041, 51.5045], 'Southwark Street'],
      [[-0.1000, 51.4948], 'Elephant & Castle'],
      [[-0.1060, 51.4882], 'Kennington'],
      [[-0.1128, 51.4818], 'Oval'],
      [[-0.1142, 51.4640], 'Brixton'],
    ],
  );
  const C = line(
    game,
    [[-0.1450, 51.4960], [-0.1250, 51.5005], [-0.1130, 51.5032], [-0.0865, 51.5050], [-0.0638, 51.4980], [-0.0497, 51.4982], [-0.0195, 51.5035], [0.0050, 51.5005]],
    'deep',
    [
      [[-0.1440, 51.4962], 'Victoria'],
      [[-0.1340, 51.4985], "St James's Park"],
      [[-0.1252, 51.5004], 'Westminster'],
      [[-0.1132, 51.5032], 'Waterloo'],
      [[-0.0865, 51.5050], 'London Bridge'],
      [[-0.0638, 51.4980], 'Bermondsey'],
      [[-0.0497, 51.4982], 'Canada Water'],
      [[-0.0195, 51.5035], 'Canary Wharf'],
      [[0.0045, 51.5007], 'North Greenwich'],
    ],
  );
  const D = line(
    game,
    [[-0.2246, 51.4936], [-0.1947, 51.4920], [-0.1738, 51.4941], [-0.1527, 51.5027], [-0.1340, 51.5100], [-0.1243, 51.5129], [-0.1143, 51.5111], [-0.0906, 51.5113], [-0.0763, 51.5098], [-0.0569, 51.5112]],
    'deep',
    [
      [[-0.2240, 51.4936], 'Hammersmith'],
      [[-0.1947, 51.4920], "Earl's Court"],
      [[-0.1738, 51.4941], 'South Kensington'],
      [[-0.1607, 51.4990], 'Knightsbridge'],
      [[-0.1527, 51.5027], 'Hyde Park Corner'],
      [[-0.1340, 51.5100], 'Piccadilly Circus'],
      [[-0.1243, 51.5129], 'Covent Garden'],
      [[-0.1143, 51.5111], 'Temple'],
      [[-0.0906, 51.5113], 'Cannon Street'],
      [[-0.0763, 51.5098], 'Tower Hill'],
      [[-0.0575, 51.5112], 'Shadwell'],
    ].filter(([, n]) => !leaveOut.includes(n as string)) as [LL, string][],
  );
  return { B, C, D };
}

/** Line D's least-used central stations, left out of London's express network to stay within the bond cap. */
export const LONDON_EXPRESS_LEAVE_OUT = ['Covent Garden', 'Temple', 'Tower Hill'];

type TrunkStop = [LL, string, 'shared' | 'pair' | 'local'];

/**
 * London's express line A (the express network and its all-stops twin): the core's line A with the
 * Central line's Chancery Lane added. On the four-track trunk Oxford Circus and Bank are
 * cross-platform hubs and the five stations around them are local-only, so a trip through the City
 * passes four or five stations the express skips. (Bond Street as well would leave no margin under
 * the bond cap: £19.998B of £20B.)
 */
const LONDON_EXPRESS_A: TrunkStop[] = [
  [[-0.1755, 51.5162], 'Paddington', 'shared'],
  [[-0.1585, 51.5136], 'Marble Arch', 'local'],
  [[-0.1415, 51.5152], 'Oxford Circus', 'pair'],
  [[-0.1308, 51.5165], 'Tottenham Court Road', 'local'],
  [[-0.1200, 51.5163], 'Holborn', 'local'],
  [[-0.1115, 51.5185], 'Chancery Lane', 'local'],
  [[-0.0975, 51.5146], "St Paul's", 'local'],
  [[-0.0886, 51.5133], 'Bank', 'pair'],
  [[-0.0726, 51.5165], 'Aldgate East', 'shared'],
  [[-0.0597, 51.5194], 'Whitechapel', 'shared'],
  [[-0.0333, 51.5252], 'Mile End', 'shared'],
  [[-0.0040, 51.5415], 'Stratford', 'shared'],
];

/** The London express scenario's local-only trunk stations (the express skips them). */
export const LONDON_EXPRESS_SKIPS = LONDON_EXPRESS_A.filter(([, , k]) => k === 'local').map(([, n]) => n);

/** London's line A waypoints (the core's). */
const LONDON_A_WAYPOINTS: LL[] = [[-0.1780, 51.5168], [-0.1585, 51.5136], [-0.1300, 51.5166], [-0.0975, 51.5146], [-0.0886, 51.5133], [-0.0600, 51.5195], [-0.0333, 51.5252], [-0.0030, 51.5420]];

/**
 * London express service (v2): the core with a deep four-track trunk along a Central-line-like
 * corridor, from just west of Marble Arch along Oxford Street and through the City to east of
 * Bank (fanning at both ends). The express calls at the hubs (cross-platform stations at Oxford
 * Circus and Bank) and skips the five local-only stations of LONDON_EXPRESS_A. London's core
 * already needs £19.3B of the £20B of bonds a career game may hold, so this network leaves out line
 * D's three least-used central stations (Covent Garden, Temple and Tower Hill, each 500–800 m from
 * another station: about 16k boardings a day between them) to stay under the cap. `allstops=1`
 * builds its all-stops twin (the same stations, double track). A is the all-stops local, X the
 * express; both at twice the core's headways.
 */
export function buildLondonCoreExpressNetwork(game: Game) {
  const cen = LONDON_A_WAYPOINTS;
  const west = lerpLL(cen[0], cen[1], 0.75);
  const east = lerpLL(cen[4], cen[5], 0.35);
  drawLine(game, [cen[0], west], 'deep');
  drawLine(game, [east, ...cen.slice(5)], 'deep');
  quadLine(game, [west, ...cen.slice(1, 5), east], 'deep', nodeSnapNear(game, west), nodeSnapNear(game, east), 1);
  const A = LONDON_EXPRESS_A.map(([p, n, k]) =>
    k === 'pair' ? pairNear(game, p, n, CARS)[0] : stationNear(game, p, n, CARS, k === 'local' ? { role: 'local' } : undefined),
  );
  return { A, X: expressPattern(game.network, A), ...buildLondonCoreTrunks(game, LONDON_EXPRESS_LEAVE_OUT) };
}

/** London's express network's all-stops twin: the same stations on double track. */
export function buildLondonCoreExpressTwin(game: Game) {
  const A = line(game, LONDON_A_WAYPOINTS, 'deep', LONDON_EXPRESS_A.map(([p, n]) => [p, n] as [LL, string]));
  return { A, ...buildLondonCoreTrunks(game, LONDON_EXPRESS_LEAVE_OUT) };
}

/** London sprawl: elevated lines through low-density Havering and Bexley. */
export function buildLondonSprawlNetwork(game: Game) {
  const E = line(
    game,
    [[0.1450, 51.5430], [0.2000, 51.5490], [0.2520, 51.5590]],
    'elevated',
    [
      [[0.1480, 51.5433], 'Dagenham Heathway'],
      [[0.1700, 51.5452], 'Dagenham East'],
      [[0.1980, 51.5488], 'Elm Park'],
      [[0.2190, 51.5530], 'Hornchurch'],
      [[0.2500, 51.5585], 'Upminster'],
    ],
  );
  const F = line(
    game,
    [[0.0500, 51.4560], [0.1050, 51.4650], [0.1500, 51.4630], [0.1850, 51.4530]],
    'elevated',
    [
      [[0.0530, 51.4562], 'Eltham'],
      [[0.0790, 51.4600], 'Falconwood'],
      [[0.1060, 51.4650], 'Welling'],
      [[0.1300, 51.4645], 'Upper Bexleyheath'],
      [[0.1490, 51.4630], 'Bexleyheath'],
      [[0.1820, 51.4540], 'Crayford Road'],
    ],
  );
  return { E, F };
}

