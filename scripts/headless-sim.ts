/**
 * Headless simulation run for balance tuning:  npm run sim [-- days=3 scale=10 chaos=off|calm|normal|wild seed=2030 ops=off pace=off|steady|boom dump=file.json timelapse=1 timelapseDump=file.json]
 * Builds the spec's test network, runs it at full speed and prints a daily summary. Operations
 * control and the money market play as in a new game; ops=off turns them off (the output then
 * matches the code before them exactly). pace= is the Living City pace (default Steady, as a new
 * game; a growth month first closes after day 18, 31 Jan 2030); pace=off is the code before it.
 */
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { buildTestNetwork, createHeadlessGame, runDays } from '../src/sim/headless';
import { fmtMoney } from '../src/core/units';
import { CHAOS, GROWTH, type ChaosLevel, type GrowthPace } from '../src/balance';
import { weatherLabel } from '../src/core/cityCalendar';
import { dumpRun, timelapseRun } from './dump';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const days = Number(args.days ?? 3);
const scale = Number(args.scale ?? 10);
const chaos = (args.chaos ?? 'off') as ChaosLevel;
if (!CHAOS.levels.includes(chaos)) throw new Error(`Unknown chaos level ${chaos}`);
const pace = (args.pace ?? GROWTH.defaultPace) as GrowthPace;
if (!GROWTH.paces.includes(pace)) throw new Error(`Unknown pace ${pace} (off|steady|boom)`);

const t0 = Date.now();
const world = loadWorldFromDisk();
const opsOff = args.ops === 'off';
const game = createHeadlessGame(world, loadLandFromDisk(), { chaos, chaosSeed: Number(args.seed ?? CHAOS.defaultSeed), ops: opsOff ? 'off' : 'default', growthPace: pace });
const { r1, r2, errors } = buildTestNetwork(game);
console.log(`network: ${game.network.edges.size} edges, ${game.network.stations.size} stations, ${errors.length} invalid`);
for (const e of errors) console.log('  ! ' + e);
console.log(`routes: ${r1.name} (${r1.ownedCars} cars), ${r2.name} (${r2.ownedCars} cars); cash ${fmtMoney(game.finance.cash)}; load ${Date.now() - t0} ms`);
// timelapse=1: record a Cinematic timelapse frame at every day end (the game records one per
// month close), through the game's own path, to show the sim doesn't notice.
const recordTimelapse = args.timelapse === '1';
const run = runDays(game, days, {
  agentScale: scale,
  onDay: (r) => {
    if (recordTimelapse) game.recordTimelapse(r.day);
    const f = game.finance.history[game.finance.history.length - 1];
    console.log(
      `day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · transit ${(r.transitShare * 100).toFixed(1)}% walk ${(r.walkShare * 100).toFixed(1)}% drive ${(r.driveShare * 100).toFixed(1)}%` +
        ` · commute ${r.avgCommute.toFixed(1)} min (baseline ${r.baselineCommute.toFixed(1)})` +
        ` · car-km ${Math.round(r.carKm).toLocaleString()} · late ${r.avgLateness.toFixed(0)} s · left behind ${Math.round(r.leftBehind)} · gave up ${Math.round(r.gaveUp)} · deadlocks ${r.deadlocks}` +
        `\n        revenue ${fmtMoney(f.revenue)} · operating ${fmtMoney(f.operating)} · staffing ${fmtMoney(f.staffing)} · maintenance ${fmtMoney(f.maintenance)} · cash ${fmtMoney(f.cash)}` +
        `\n        route riders ${JSON.stringify(r.routeRiders)} · goal trip ${r.goalTrip?.toFixed(0) ?? '—'}` +
        (opsOff
          ? ''
          : `\n        ops: headway CV ${r.regularity.cv.toFixed(2)} · bunched ${(r.regularity.bunched * 100).toFixed(1)}% · excess wait ${r.regularity.ewt.toFixed(0)} s · ${r.regularity.holds} holds (${r.regularity.holds ? (r.regularity.holdSec / r.regularity.holds).toFixed(0) : 0} s each) · terminal lateness ${r.regularity.termLate.toFixed(0)} s` +
            ` · fares ${fmtMoney(r.fares.revenue.reduce((a, b) => a + b, 0))} from ${Math.round(r.fares.trips.reduce((a, b) => a + b, 0)).toLocaleString()} trips · market ${(game.finance.newBondRate() * 100).toFixed(2)}% (${game.finance.market.rating ?? '—'})`) +
        (chaos !== 'off' && r.chaos
          ? `\n        chaos: ${weatherLabel(r.chaos.weather)} · incidents ${JSON.stringify(r.chaos.incidents)} (${r.chaos.incidentMinutes.toFixed(0)} min) · diverted ${r.chaos.diverted} · carried past ${r.chaos.carriedPast}` +
            ` · event riders ${r.chaos.eventRiders} · ${r.chaos.events.map((e) => `${e.label} ${e.attendance.toLocaleString()} (${e.byTransit.toLocaleString()} by transit, ${e.late} late)`).join(', ') || 'no events'}`
          : '') +
        (r.growth
          ? `\n        city growth (${r.growth.label}): value capture ${fmtMoney(r.growth.valueCapture)} · residents ${Math.round(r.growth.residents).toLocaleString()} (${r.growth.dResidents >= 0 ? '+' : ''}${Math.round(r.growth.dResidents).toLocaleString()}) · ${r.growth.districtTracts} district tracts · agents ${r.growth.agents.toLocaleString()}`
          : ''),
    );
  },
});
const c = run.engine.commuters!;
if (args.dump) dumpRun(args.dump, run.reports, game, run.engine);
if (recordTimelapse) timelapseRun(game, args.timelapseDump);
console.log(`agents ${c.A.toLocaleString()} in ${c.G.toLocaleString()} groups · pathfinding ${c.lastPathMs} ms · sim ${run.ms} ms for ${days} days · in flight now ${c.inFlight()} · stuck ${c.stuckCount()}`);
