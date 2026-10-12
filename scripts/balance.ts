/**
 * Balance tuning: build scenario networks in code, run them to near-equilibrium and report
 * ridership and daily money.  npm run balance [-- city=nyc|london scenario=core|sprawl|test days=8 scale=10
 * chaos=off|calm|normal|wild seed=2030 money=1]
 * (scenario=test is New York only; chaos defaults to off, which reproduces v1 exactly; with chaos on,
 * or money=1, each day also shows its operating result)
 */
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { buildTestNetwork, createHeadlessGame, drawLine, makeRoute, runDays, stationNear } from '../src/sim/headless';
import type { Game } from '../src/core/game';
import { CHAOS, COMMUTERS, ECONOMY, type ChaosLevel, type TrackLevel } from '../src/balance';
import { weatherLabel } from '../src/core/cityCalendar';
import { annuityPayment } from '../src/economy/finance';
import { edgeReport } from '../src/construction/validate';
import { fmtMoney } from '../src/core/units';
import { applyCity, isCityId } from '../src/cities';

type LL = [number, number];

const CARS = Number(Object.fromEntries(process.argv.slice(2).map((a) => a.split('='))).cars ?? 10);
const PEAK = Number(Object.fromEntries(process.argv.slice(2).map((a) => a.split('='))).peak ?? 2.5);

function line(game: Game, pts: LL[], levels: TrackLevel | TrackLevel[], stations: [LL, string][], cars = CARS) {
  drawLine(game, pts, levels);
  return stations.map(([p, n]) => stationNear(game, p, n, cars));
}

function fund(_game: Game, _extra = 0) {
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
  return { A, B, C, D };
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
    ],
  );
  return { A, B, C, D };
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

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const cityId = args.city ?? 'nyc';
if (!isCityId(cityId)) throw new Error(`Unknown city ${cityId}`);
// First: the city's balance values and projection, before any data loads or overrides.
applyCity(cityId);
// Optional overrides for parameter sweeps (these are the balance.ts COMMUTERS values).
if (args.ascDrive) COMMUTERS.modeConstant.drive = Number(args.ascDrive);
if (args.ascTransit) COMMUTERS.modeConstant.transit = Number(args.ascTransit);
if (args.access) COMMUTERS.maxAccessWalk = Number(args.access);
if (args.theta) COMMUTERS.logitScale = Number(args.theta);
const scenario = (args.scenario ?? 'core') as string;
const days = Number(args.days ?? 8);
const scale = Number(args.scale ?? 10);
const chaos = (args.chaos ?? 'off') as ChaosLevel;
if (!CHAOS.levels.includes(chaos)) throw new Error(`Unknown chaos level ${chaos}`);
const chaosSeed = Number(args.seed ?? CHAOS.defaultSeed);

// Built in sandbox so the scenario never runs out of money; the ledger still records every cost.
const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true, chaos, chaosSeed });
let stopsets: Record<string, number[]> = {};
if (scenario === 'test' && cityId !== 'nyc') throw new Error('scenario=test is the New York test network; use core or sprawl for London');
if (scenario === 'test') {
  buildTestNetwork(game);
} else {
  stopsets =
    cityId === 'london'
      ? scenario === 'sprawl' ? buildLondonSprawlNetwork(game) : buildLondonCoreNetwork(game)
      : scenario === 'sprawl' ? buildSprawlNetwork(game) : buildCoreNetwork(game);
  const bad = [...game.network.edges.values()].map((e) => edgeReport(game.network, e.id, game.terrain)).filter((r) => !r.ok);
  if (bad.length) console.log('INVALID EDGES:', bad.map((b) => b.errors[0]));
  fund(game, 3e9);
  const b = game.build(true);
  if (!b.ok) console.log('build failed:', b.reason);
  const colors = ['#2F7FE0', '#E8443A', '#B04FCF', '#9BA4AE', '#F28C28', '#3FAE5A'];
  Object.entries(stopsets).forEach(([k, stops], i) => {
    fund(game, 2e9);
    makeRoute(game, `Line ${k}`, k, colors[i % colors.length], stops, CARS, { am: PEAK, pm: PEAK, midday: PEAK * 2, evening: Math.max(6, PEAK * 3), night: 20 });
  });
}
// Cost breakdown by edge level.
{
  const byLevel = new Map<string, { km: number; cost: number }>();
  for (const e of game.network.edges.values()) {
    const a = game.network.nodes.get(e.a)!.level, b = game.network.nodes.get(e.b)!.level;
    const k = a === b ? a : `${a}→${b}`;
    const g = game.network.geom(e.id);
    const v = byLevel.get(k) ?? { km: 0, cost: 0 };
    v.km += g.length / 1000;
    v.cost += e.cost;
    byLevel.set(k, v);
  }
  console.log('track by level: ' + [...byLevel.entries()].map(([k, v]) => `${k} ${v.km.toFixed(1)} km ${fmtMoney(v.cost)} (${fmtMoney(v.cost / v.km)}/km)`).join(' · '));
}
const built = game.finance.assetValue;
const stationsN = game.network.stations.size;
const trackCost = [...game.network.edges.values()].reduce((s, e) => s + e.cost, 0);
const stationCost = [...game.network.stations.values()].reduce((s, st) => s + st.cost, 0);
// Debt a real player would need: everything above the starting cash, at bond terms.
const debtNeeded = Math.max(0, built - ECONOMY.startingCash);
console.log(`${cityId} ${scenario}: ${stationsN} stations, ${game.routes.list().length} routes · capital ${fmtMoney(built)} (track ${fmtMoney(trackCost)}, stations ${fmtMoney(stationCost)}, trains ${fmtMoney(built - trackCost - stationCost)}) · debt needed ${fmtMoney(debtNeeded)}${debtNeeded > ECONOMY.bondMax ? ' (over the bond cap!)' : ''}`);
const run = runDays(game, days, { agentScale: scale });
const last = run.reports[run.reports.length - 1];
const f = game.finance.history[game.finance.history.length - 1];
const debtService = (annuityPayment(debtNeeded, ECONOMY.bondRate, ECONOMY.bondYears) * 12) / ECONOMY.daysPerYear;
const interest = (debtNeeded * ECONOMY.bondRate) / ECONOMY.daysPerYear;
// With chaos on, each day also shows the weather, incidents and event fans by transit.
const chaosLine = (r: (typeof run.reports)[number]) => {
  if (chaos === 'off' || !r.chaos) return '';
  const inc = Object.values(r.chaos.incidents).reduce((a, b) => a + b, 0);
  const fans = r.chaos.events.reduce((a, e) => a + e.byTransit, 0);
  return ` · ${weatherLabel(r.chaos.weather)} · inc ${inc} · events ${r.chaos.events.length} (${Math.round(fans).toLocaleString()} by transit)`;
};
const finByDay = new Map(game.finance.history.map((h) => [h.day, h]));
const moneyLine = (day: number) => {
  const h = finByDay.get(day);
  return (chaos === 'off' && !args.money) || !h ? '' : ` · op ${fmtMoney(h.revenue - h.operating - h.staffing - h.maintenance, { sign: true })}`;
};
for (const r of run.reports) console.log(`  day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · share ${(r.transitShare * 100).toFixed(1)}% · commute ${r.avgCommute.toFixed(1)} (base ${r.baselineCommute.toFixed(1)}) · late ${r.avgLateness.toFixed(0)}s · left ${Math.round(r.leftBehind).toLocaleString()} · gaveup ${Math.round(r.gaveUp).toLocaleString()} · dl ${r.deadlocks}${chaosLine(r)}${moneyLine(r.day)}`);
const opCost = f.operating + f.staffing + f.maintenance;
console.log(`last day: revenue ${fmtMoney(f.revenue)} · operating ${fmtMoney(f.operating)} (${Math.round(f.carKm).toLocaleString()} car-km) · staffing ${fmtMoney(f.staffing)} · maintenance ${fmtMoney(f.maintenance)}`);
console.log(`  operating result ${fmtMoney(f.revenue - opCost, { sign: true })}/day · after bond interest ${fmtMoney(f.revenue - opCost - interest, { sign: true })}/day · after full debt service ${fmtMoney(f.revenue - opCost - debtService, { sign: true })}/day`);
console.log(`  route riders ${JSON.stringify(last.routeRiders)} · goal trip ${last.goalTrip?.toFixed(0) ?? '—'} · ${run.ms} ms`);

// ---- demand diagnostics: coverage vs choice
{
  const c = run.engine.commuters!;
  let served = 0, servedTransit = 0, all = 0;
  const shareHist = [0, 0, 0, 0, 0];
  let schedSum = 0, driveSum = 0;
  for (let g = 0; g < c.G; g++) {
    const n = c.gCount[g];
    all += n;
    if (c.pathAM[g] && c.pathPM[g]) {
      served += n;
      const sh = c.shares[g * 3 + 2];
      servedTransit += n * sh;
      shareHist[Math.min(4, Math.floor(sh * 5))] += n;
      schedSum += n * c.pathAM[g]!.time;
      driveSum += n * c.gDrive[g];
    }
  }
  console.log(`coverage: ${(served / all * 100).toFixed(1)}% of commuters have a transit path; transit share among them ${(servedTransit / served * 100).toFixed(1)}%`);
  console.log(`  share histogram (0-20,..,80-100%): ${shareHist.map((v) => (v / served * 100).toFixed(0) + '%').join(' ')}`);
  console.log(`  avg scheduled transit ${(schedSum / served / 60).toFixed(1)} min vs drive ${(driveSum / served / 60).toFixed(1)} min`);
}

// ---- who isn't choosing transit (served groups with transit share < 30%)?
{
  const c = run.engine.commuters!;
  const cat = new Map<string, { n: number; share: number }>();
  for (let g = 0; g < c.G; g++) {
    if (!c.pathAM[g] || !c.pathPM[g]) continue;
    const n = c.gCount[g];
    const geo = c.gGeom[g];
    const walk = isFinite(c.gWalk[g]);
    const key = `${walk ? 'walkable' : 'long'} · ${geo.workCbd ? 'CBD job' : 'non-CBD'} · band ${c.gBand[g]}`;
    const v = cat.get(key) ?? { n: 0, share: 0 };
    v.n += n;
    v.share += n * c.shares[g * 3 + 2];
    cat.set(key, v);
  }
  console.log('served groups by type (agents, transit share):');
  for (const [k, v] of [...cat.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k}: ${v.n.toLocaleString()} agents · ${(v.share / v.n * 100).toFixed(0)}% transit`);
}
