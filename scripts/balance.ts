/**
 * Balance tuning: build scenario networks in code, run them to near-equilibrium and report
 * ridership and daily money.  npm run balance [-- city=nyc|london scenario=core|sprawl|test days=8 scale=10
 * chaos=off|calm|normal|wild seed=2030 money=1 ops=off control=default|legacy|tp|off farePeak= fareOff= low=1|0.5|0
 * pace=off|steady|boom months=N monthDays=5 dump=file.json]
 * (scenario=test is New York only; chaos defaults to off; with chaos on, or money=1, each day also
 * shows its operating result. Operations control and fares default to a new game's: control=legacy
 * is a migrated route (no holding or recovery), tp adds suggested timepoints, and ops=off turns
 * every v2 mechanic off, which reproduces the code before operations control exactly. farePeak /
 * fareOff / low set the fare policy; peak= is still the peak headway in minutes.)
 * scenario=express (v2): the core with a four-track trunk (New York: Lexington through Midtown and
 * the Upper East Side; London: Oxford Street and the City, without line D's three least-used
 * central stations, to stay within the bond cap), an all-stops local A and an express X calling at
 * the trunk's hubs, each at twice the core's headway by default (localPeak= / expressPeak= set
 * their peak minutes); it prints both routes' run times, trains, riders, lateness and overtakes,
 * the transfers across the platform and the long trips on the trunk. allstops=1 builds its
 * all-stops twin instead: the same stations on double track, one route A at the core's headways
 * (New York: exactly the core). long=1 prints the long-trip line for any scenario.
 * Living City: pace= sets the growth pace (default Steady, as a new game; pace=off is the code
 * before Living City). A growth month closes at each calendar month end (from day 18, 31 Jan
 * 2030). months=N instead runs N growth months of monthDays=K days each (default 5: shares
 * re-equilibrate between closes), a tuning loop that ignores the calendar; it prints one line per
 * growth month (riders, value capture, city ×, top boomtown, agents) and the month-12 summary.
 */
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { buildTestNetwork, createHeadlessGame, makeRoute, runDays } from '../src/sim/headless';
import { routeTimetable } from '../src/routes/compile';
import { BONDS, CHAOS, COMMUTERS, ECONOMY, GROWTH, type ChaosLevel, type GrowthPace } from '../src/balance';
import {
  buildCoreExpressNetwork,
  buildCoreExpressTwin,
  buildCoreNetwork,
  buildLondonCoreExpressNetwork,
  buildLondonCoreExpressTwin,
  buildLondonCoreNetwork,
  buildLondonSprawlNetwork,
  buildSprawlNetwork,
  CARS,
  fund,
  PEAK,
} from './scenarios';
import { weatherLabel } from '../src/core/cityCalendar';
import { annuityMonthly, annuityPayment } from '../src/economy/finance';
import { creditScore, spreadOf } from '../src/economy/credit';
import { fareSummary } from '../src/economy/fares';
import { defaultControl, legacyControl, offControl, suggestTimepoints } from '../src/routes/control';
import type { RouteControl } from '../src/routes/types';
import { dumpRun } from './dump';
import { edgeReport } from '../src/construction/validate';
import { fmtMoney } from '../src/core/units';
import { TIME } from '../src/balance';
import { weekdaysInMonth } from '../src/core/calendar';
import type { DayReport } from '../src/sim/protocol';
import { applyCity, isCityId } from '../src/cities';

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
const opsOff = args.ops === 'off';
const pace = (args.pace ?? GROWTH.defaultPace) as GrowthPace;
if (!GROWTH.paces.includes(pace)) throw new Error(`Unknown pace ${pace} (off|steady|boom)`);
const months = args.months !== undefined ? Number(args.months) : 0;
const monthDays = Number(args.monthDays ?? 5);
const controlArg = (args.control ?? (opsOff ? 'off' : 'default')) as string;
const controls: Record<string, () => RouteControl> = { default: defaultControl, tp: defaultControl, legacy: legacyControl, off: offControl };
if (!controls[controlArg]) throw new Error(`Unknown control ${controlArg} (default|legacy|tp|off)`);

// Built in sandbox so the scenario never runs out of money; the ledger still records every cost.
const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true, chaos, chaosSeed, ops: opsOff ? 'off' : 'default', growthPace: pace });
game.routes.newControl = controls[controlArg];
if (args.farePeak !== undefined || args.fareOff !== undefined || args.low !== undefined) {
  const peak = args.farePeak !== undefined ? Number(args.farePeak) : game.fares.peak;
  game.setFares({ peak, offPeak: args.fareOff !== undefined ? Number(args.fareOff) : Math.min(peak, game.fares.offPeak), lowIncome: args.low !== undefined ? Number(args.low) : game.fares.lowIncome });
}
let stopsets: Record<string, number[]> = {};
if (scenario === 'test' && cityId !== 'nyc') throw new Error('scenario=test is the New York test network; use core or sprawl for London');
if (scenario === 'test') {
  buildTestNetwork(game);
} else {
  if (!['core', 'sprawl', 'express'].includes(scenario)) throw new Error(`Unknown scenario ${scenario} (core|sprawl|express|test)`);
  const twin = scenario === 'express' && args.allstops === '1';
  stopsets =
    cityId === 'london'
      ? scenario === 'sprawl' ? buildLondonSprawlNetwork(game) : scenario === 'express' ? (twin ? buildLondonCoreExpressTwin(game) : buildLondonCoreExpressNetwork(game)) : buildLondonCoreNetwork(game)
      : scenario === 'sprawl' ? buildSprawlNetwork(game) : scenario === 'express' ? (twin ? buildCoreExpressTwin(game) : buildCoreExpressNetwork(game)) : buildCoreNetwork(game);
  const bad = [...game.network.edges.values()].map((e) => edgeReport(game.network, e.id, game.terrain)).filter((r) => !r.ok);
  if (bad.length) console.log('INVALID EDGES:', bad.map((b) => b.errors[0]));
  fund(game, 3e9);
  const b = game.build(true);
  if (!b.ok) console.log('build failed:', b.reason);
  const colors = ['#2F7FE0', '#E8443A', '#B04FCF', '#9BA4AE', '#F28C28', '#3FAE5A'];
  Object.entries(stopsets).forEach(([k, stops], i) => {
    fund(game, 2e9);
    // scenario=express: the trunk's local (A) and express (X) each run at twice the core's headways
    // (the express not at night), so the shared ends get the core's service.
    // localPeak= / expressPeak= (minutes) override their peak headways (the off-peak scales with them).
    const pair = scenario === 'express' && !twin && (k === 'A' || k === 'X');
    const pk = pair ? Number((k === 'X' ? args.expressPeak : args.localPeak) ?? PEAK * 2) : PEAK;
    const hw = pair
      ? { am: pk, pm: pk, midday: pk * 2, evening: Math.max(6, (pk / 2) * 3) * 2, night: k === 'X' ? 0 : 20 }
      : { am: PEAK, pm: PEAK, midday: PEAK * 2, evening: Math.max(6, PEAK * 3), night: 20 };
    makeRoute(game, k === 'X' ? 'Line A Express' : `Line ${k}`, k, colors[(k === 'X' ? 0 : i) % colors.length], stops, CARS, hw, 'heavy', undefined, k === 'X');
  });
}
if (controlArg === 'tp') for (const r of game.routes.list()) game.routes.update(r.id, { control: { ...r.control, timepoints: suggestTimepoints(r, game.routes.list()) } });
if (!opsOff) {
  const trains = game.routes.list().map((r) => `${r.bullet} ${Math.floor(r.ownedCars / r.cars)}`).join(', ');
  console.log(`operations control: ${controlArg} · trains ${trains} · fares ${fareSummary(game.fares)}`);
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
// Living City: one line per growth month (riders that day, value capture, the city, the top boomtown, agents).
const growthLine = (r: DayReport) => {
  const gm = r.growth!;
  const top = gm.boomtowns[0];
  const city0 = total0;
  return `  growth ${gm.label} (day ${r.day}): riders ${Math.round(r.riders).toLocaleString()} · value capture ${fmtMoney(gm.valueCapture)} (${fmtMoney(gm.valueCapture / monthWeekdays(r.day))}/day) · ${gm.districtTracts} district tracts` +
    ` · city ×${((gm.residents) / city0).toFixed(4)} · top ${top ? `tract ${top.tract} +${(top.rate * 100).toFixed(2)}%/mo (+${(top.sinceStart * 100).toFixed(1)}% since ${TIME.startDate.year})` : '—'} · benefit ${gm.benefitMean.toFixed(1)} min · agents ${gm.agents.toLocaleString()}`;
};
// Value capture per day: a month's payment over its weekdays (with months=, an average month's, 261 / 12).
const monthWeekdays = (day: number) => (months > 0 ? ECONOMY.daysPerYear / 12 : weekdaysInMonth(day));
const total0 = game.world.tracts.reduce((a, t) => a + t.residents, 0);
const growthReports: DayReport[] = [];
const run = runDays(game, months > 0 ? months * monthDays : days, {
  agentScale: scale,
  ...(months > 0 ? { monthEvery: monthDays } : {}),
  onDay: (r) => {
    if (!r.growth) return;
    growthReports.push(r);
    console.log(growthLine(r));
  },
});
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
// Operations control: the day's headway regularity (not printed with ops=off, so the output matches the code before it).
const regLine = (r: (typeof run.reports)[number]) =>
  opsOff || !r.regularity ? '' : ` · CV ${r.regularity.cv.toFixed(2)} bunched ${(r.regularity.bunched * 100).toFixed(1)}% ewt ${r.regularity.ewt.toFixed(0)}s holds ${r.regularity.holds}`;
for (const r of months > 0 ? [] : run.reports) console.log(`  day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · share ${(r.transitShare * 100).toFixed(1)}% · commute ${r.avgCommute.toFixed(1)} (base ${r.baselineCommute.toFixed(1)}) · late ${r.avgLateness.toFixed(0)}s · left ${Math.round(r.leftBehind).toLocaleString()} · gaveup ${Math.round(r.gaveUp).toLocaleString()} · dl ${r.deadlocks}${regLine(r)}${chaosLine(r)}${moneyLine(r.day)}`);
const opCost = f.operating + f.staffing + f.maintenance;
console.log(`last day: revenue ${fmtMoney(f.revenue)} · operating ${fmtMoney(f.operating)} (${Math.round(f.carKm).toLocaleString()} car-km) · staffing ${fmtMoney(f.staffing)} · maintenance ${fmtMoney(f.maintenance)}`);
console.log(`  operating result ${fmtMoney(f.revenue - opCost, { sign: true })}/day · after bond interest ${fmtMoney(f.revenue - opCost - interest, { sign: true })}/day · after full debt service ${fmtMoney(f.revenue - opCost - debtService, { sign: true })}/day`);
// Living City: the last growth month's value capture per day, on top of the last day's result.
const lastGm = growthReports[growthReports.length - 1];
const vcPerDay = lastGm ? lastGm.growth!.valueCapture / monthWeekdays(lastGm.day) : 0;
if (lastGm) console.log(`  with value capture (${lastGm.growth!.label}: ${fmtMoney(vcPerDay)}/day): operating ${fmtMoney(f.revenue + vcPerDay - opCost, { sign: true })}/day · after bond interest ${fmtMoney(f.revenue + vcPerDay - opCost - interest, { sign: true })}/day`);
console.log(`  route riders ${JSON.stringify(last.routeRiders)} · goal trip ${last.goalTrip?.toFixed(0) ?? '—'} · ${run.ms} ms`);
if (scenario === 'express') {
  // Express service (v2): run times, lateness, riders and overtakes of the trunk's local and express,
  // and transfers across the platform (the last day; overtakes and transfers averaged over days 1+).
  const days1 = run.reports.filter((r) => r.day >= 1);
  const mean = (f: (r: DayReport) => number) => (days1.length ? days1.reduce((a, r) => a + f(r), 0) / days1.length : 0);
  const sum = (o: Record<number, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  for (const r of game.routes.list().filter((x) => x.bullet === 'A' || x.bullet === 'X')) {
    const tt = routeTimetable(game, r);
    console.log(
      `  ${r.express ? 'express' : 'local  '} ${r.bullet}: ${r.stops.length} stops · run ${tt ? (tt.runTimes[0] / 60).toFixed(1) : '—'} / ${tt ? (tt.runTimes[1] / 60).toFixed(1) : '—'} min · ${Math.floor(r.ownedCars / r.cars)} trains` +
        ` · riders ${Math.round(last.routeRiders[r.id] ?? 0).toLocaleString()} · late ${(last.routeLateness[r.id] ?? 0).toFixed(0)} s · overtakes ${mean((x) => x.routeOvertakes?.[r.id] ?? 0).toFixed(0)}/day`,
    );
  }
  const pairs = [...game.network.stations.values()].filter((st) => st.pair !== undefined && st.id < st.pair).length;
  console.log(`  four-track: ${pairs} cross-platform stations · ${Math.round(mean((x) => sum(x.crossTransfers))).toLocaleString()} cross-platform transfers/day · last day ${JSON.stringify(last.crossTransfers ?? {})}`);
}
if (scenario === 'express' || args.long === '1') {
  // Long trips on the trunk: commuters whose morning journey rides line A (or its express) for at
  // least 5 km, by planned path; their door-to-door time as observed (as mode choice sees it), and
  // the fare-paying journeys of the whole network.
  const c = run.engine.commuters!;
  const trunk = new Set(game.routes.list().filter((r) => r.bullet === 'A' || r.bullet === 'X').map((r) => r.id));
  const pos = new Map([...game.network.stations.values()].map((st) => [st.id, game.network.stationPos(st)]));
  let n = 0, tSum = 0, all = 0;
  for (let g = 0; g < c.G; g++) {
    const p = c.pathAM[g];
    if (!p) continue;
    let long = false;
    for (let i = 0; i < p.legs.length / 3; i++) {
      const a = pos.get(p.legs[i * 3 + 1]), b = pos.get(p.legs[i * 3 + 2]);
      if (trunk.has(p.legs[i * 3]) && a && b && Math.hypot(a.x - b.x, a.y - b.y) >= 5000) long = true;
    }
    if (!long) continue;
    const w = c.gCount[g] * c.shares[g * 3 + 2];
    const obs = c.obsTime[g];
    all += c.gCount[g];
    n += w;
    tSum += w * (obs > 0 ? obs : (p.time + c.pathPM[g]!.time) / 2);
  }
  const journeys = last.fares.trips.reduce((a, b) => a + b, 0);
  console.log(`  long trips on line A (≥ 5 km on it): ${Math.round(all * scale).toLocaleString()} commuters, ${Math.round(n * scale).toLocaleString()} by transit · door to door ${(tSum / Math.max(1, n) / 60).toFixed(1)} min · network journeys ${Math.round(journeys).toLocaleString()}/day`);
}
if (!opsOff) {
  // Fares by band and period on the last day, and the credit rating a player with this network
  // would get: the debt needed, an assumed 0.5B cash buffer, the last 4 days' revenue and costs.
  const fb = last.fares;
  const trips = fb.trips.reduce((a, b) => a + b, 0);
  const peakTrips = fb.trips[1] + fb.trips[3] + fb.trips[5];
  console.log(
    `  fares: ${trips ? ((peakTrips / trips) * 100).toFixed(1) : 0}% of fare trips at peak · average fare ${(fb.revenue.reduce((a, b) => a + b, 0) / Math.max(1, trips)).toFixed(3)}` +
      ` · transit share by band ${last.bandShare.map((x) => (x * 100).toFixed(1) + '%').join(' / ')}`,
  );
  const tail = game.finance.history.slice(-4);
  const rev = tail.reduce((s, h) => s + h.revenue, 0) / tail.length;
  const op = tail.reduce((s, h) => s + h.operating + h.staffing + h.maintenance, 0) / tail.length;
  const inputs = (newRate: number) => ({
    revenuePerDay: rev,
    // Living City: value capture counts in interest coverage (the last growth month's, per day).
    valueCapturePerDay: vcPerDay,
    opCostPerDay: op,
    serviceDays: 60,
    debt: debtNeeded,
    annualInterest: debtNeeded * BONDS.start,
    monthlyDebtService: annuityMonthly(debtNeeded, BONDS.start, BONDS.termMonths),
    assets: built,
    cash: 0.5e9,
    newRate,
  });
  const first = creditScore(inputs(BONDS.start));
  const res = creditScore(inputs(BONDS.start + spreadOf(first.rating)));
  console.log(`  credit: ${res.metrics.map((m) => `${m.label} ${m.display}`).join(' · ')} → score ${res.score.toFixed(1)} → ${res.rating} (new bonds ${((BONDS.start + spreadOf(res.rating)) * 100).toFixed(2)}%)`);
}
if (args.dump) dumpRun(args.dump, run.reports, game, run.engine);
if (growthReports.length) {
  // Living City summary: value capture per day of each growth month, the riders' trend, the city.
  const vcDay = (r: DayReport) => r.growth!.valueCapture / monthWeekdays(r.day);
  const g = run.engine.growth!;
  const m12 = growthReports[Math.min(11, growthReports.length - 1)];
  const first = run.reports[0];
  console.log(
    `living city (${pace}): ${growthReports.length} growth months · month ${Math.min(12, growthReports.length)} value capture ${fmtMoney(vcDay(m12))}/day · riders day ${first.day} ${Math.round(first.riders).toLocaleString()} → day ${last.day} ${Math.round(last.riders).toLocaleString()}` +
      ` · city ×${(g.city[g.city.length - 1].residents / g.total0).toFixed(4)} · agents ${run.engine.commuters!.A.toLocaleString()} · last regeneration ${JSON.stringify(run.engine.lastRegen)}`,
  );
}

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
