/**
 * Balance tuning: build scenario networks in code, run them to near-equilibrium and report
 * ridership and daily money.  npm run balance [-- scenario=core|sprawl|test days=8 scale=10]
 */
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { buildTestNetwork, createHeadlessGame, drawLine, makeRoute, runDays, stationNear } from '../src/sim/headless';
import type { Game } from '../src/core/game';
import { COMMUTERS, ECONOMY, type TrackLevel } from '../src/balance';
import { annuityPayment } from '../src/economy/finance';
import { edgeReport } from '../src/construction/validate';
import { fmtMoney } from '../src/core/units';

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

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
// Optional overrides for parameter sweeps (these are the balance.ts COMMUTERS values).
if (args.ascDrive) COMMUTERS.modeConstant.drive = Number(args.ascDrive);
if (args.ascTransit) COMMUTERS.modeConstant.transit = Number(args.ascTransit);
if (args.access) COMMUTERS.maxAccessWalk = Number(args.access);
if (args.theta) COMMUTERS.logitScale = Number(args.theta);
const scenario = (args.scenario ?? 'core') as string;
const days = Number(args.days ?? 8);
const scale = Number(args.scale ?? 10);

// Built in sandbox so the scenario never runs out of money; the ledger still records every cost.
const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
let stopsets: Record<string, number[]> = {};
if (scenario === 'test') {
  buildTestNetwork(game);
} else {
  stopsets = scenario === 'sprawl' ? buildSprawlNetwork(game) : buildCoreNetwork(game);
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
console.log(`${scenario}: ${stationsN} stations, ${game.routes.list().length} routes · capital ${fmtMoney(built)} (track ${fmtMoney(trackCost)}, stations ${fmtMoney(stationCost)}, trains ${fmtMoney(built - trackCost - stationCost)}) · debt needed ${fmtMoney(debtNeeded)}${debtNeeded > ECONOMY.bondMax ? ' (over the bond cap!)' : ''}`);
const run = runDays(game, days, { agentScale: scale });
const last = run.reports[run.reports.length - 1];
const f = game.finance.history[game.finance.history.length - 1];
const debtService = (annuityPayment(debtNeeded, ECONOMY.bondRate, ECONOMY.bondYears) * 12) / ECONOMY.daysPerYear;
const interest = (debtNeeded * ECONOMY.bondRate) / ECONOMY.daysPerYear;
for (const r of run.reports) console.log(`  day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · share ${(r.transitShare * 100).toFixed(1)}% · commute ${r.avgCommute.toFixed(1)} (base ${r.baselineCommute.toFixed(1)}) · late ${r.avgLateness.toFixed(0)}s · left ${Math.round(r.leftBehind).toLocaleString()} · gaveup ${Math.round(r.gaveUp).toLocaleString()} · dl ${r.deadlocks}`);
const opCost = f.operating + f.staffing + f.maintenance;
console.log(`last day: revenue ${fmtMoney(f.revenue)} · operating ${fmtMoney(f.operating)} (${Math.round(f.carKm).toLocaleString()} car-km) · staffing ${fmtMoney(f.staffing)} · maintenance ${fmtMoney(f.maintenance)}`);
console.log(`  operating result ${fmtMoney(f.revenue - opCost, { sign: true })}/day · after bond interest ${fmtMoney(f.revenue - opCost - interest, { sign: true })}/day · after full debt service ${fmtMoney(f.revenue - opCost - debtService, { sign: true })}/day`);
console.log(`  route riders ${JSON.stringify(last.routeRiders)} · Midtown→JFK ${last.midtownJfk?.toFixed(0) ?? '—'} · ${run.ms} ms`);

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
