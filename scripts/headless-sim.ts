/**
 * Headless simulation run for balance tuning:  npm run sim [-- days=3 scale=10 chaos=off|calm|normal|wild seed=2030]
 * Builds the spec's test network, runs it at full speed and prints a daily summary.
 */
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { buildTestNetwork, createHeadlessGame, runDays } from '../src/sim/headless';
import { fmtMoney } from '../src/core/units';
import { CHAOS, type ChaosLevel } from '../src/balance';
import { weatherLabel } from '../src/core/cityCalendar';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const days = Number(args.days ?? 3);
const scale = Number(args.scale ?? 10);
const chaos = (args.chaos ?? 'off') as ChaosLevel;
if (!CHAOS.levels.includes(chaos)) throw new Error(`Unknown chaos level ${chaos}`);

const t0 = Date.now();
const world = loadWorldFromDisk();
const game = createHeadlessGame(world, loadLandFromDisk(), { chaos, chaosSeed: Number(args.seed ?? CHAOS.defaultSeed) });
const { r1, r2, errors } = buildTestNetwork(game);
console.log(`network: ${game.network.edges.size} edges, ${game.network.stations.size} stations, ${errors.length} invalid`);
for (const e of errors) console.log('  ! ' + e);
console.log(`routes: ${r1.name} (${r1.ownedCars} cars), ${r2.name} (${r2.ownedCars} cars); cash ${fmtMoney(game.finance.cash)}; load ${Date.now() - t0} ms`);
const run = runDays(game, days, {
  agentScale: scale,
  onDay: (r) => {
    const f = game.finance.history[game.finance.history.length - 1];
    console.log(
      `day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} · transit ${(r.transitShare * 100).toFixed(1)}% walk ${(r.walkShare * 100).toFixed(1)}% drive ${(r.driveShare * 100).toFixed(1)}%` +
        ` · commute ${r.avgCommute.toFixed(1)} min (baseline ${r.baselineCommute.toFixed(1)})` +
        ` · car-km ${Math.round(r.carKm).toLocaleString()} · late ${r.avgLateness.toFixed(0)} s · left behind ${Math.round(r.leftBehind)} · gave up ${Math.round(r.gaveUp)} · deadlocks ${r.deadlocks}` +
        `\n        revenue ${fmtMoney(f.revenue)} · operating ${fmtMoney(f.operating)} · staffing ${fmtMoney(f.staffing)} · maintenance ${fmtMoney(f.maintenance)} · cash ${fmtMoney(f.cash)}` +
        `\n        route riders ${JSON.stringify(r.routeRiders)} · goal trip ${r.goalTrip?.toFixed(0) ?? '—'}` +
        (chaos !== 'off' && r.chaos
          ? `\n        chaos: ${weatherLabel(r.chaos.weather)} · incidents ${JSON.stringify(r.chaos.incidents)} (${r.chaos.incidentMinutes.toFixed(0)} min) · diverted ${r.chaos.diverted} · carried past ${r.chaos.carriedPast}` +
            ` · event riders ${r.chaos.eventRiders} · ${r.chaos.events.map((e) => `${e.label} ${e.attendance.toLocaleString()} (${e.byTransit.toLocaleString()} by transit, ${e.late} late)`).join(', ') || 'no events'}`
          : ''),
    );
  },
});
const c = run.engine.commuters!;
console.log(`agents ${c.A.toLocaleString()} in ${c.G.toLocaleString()} groups · pathfinding ${c.lastPathMs} ms · sim ${run.ms} ms for ${days} days · in flight now ${c.inFlight()} · stuck ${c.stuckCount()}`);
