/**
 * Performance check for the spec's target (300 stations, 25 routes, ~400 trains):
 *   npm run perf [-- scale=10 ns=17 ew=8 stations=12]
 * Builds a large synthetic network (a grid of deep-tunnel lines across Brooklyn, Manhattan and
 * Queens), runs the sim to the morning peak and times one game-hour. At the top speed (60×) the
 * worker must simulate one game-hour per real second, so the budget is 1000 ms.
 */
import { TIME } from '../src/balance';
import { compileNetwork } from '../src/routes/compile';
import { buildPerfNetwork, createHeadlessGame } from '../src/sim/headless';
import { Engine } from '../src/sim/engine';
import { TState } from '../src/sim/trainSim';
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const scale = Number(args.scale ?? 10);
const NS = Number(args.ns ?? 17);
const EW = Number(args.ew ?? 8);
const PER_LINE = Number(args.stations ?? 12);

const world = loadWorldFromDisk();
const game = createHeadlessGame(world, loadLandFromDisk(), { sandbox: true });
let t0 = Date.now();
const { routes, fleet } = buildPerfNetwork(game, { ns: NS, ew: EW, perLine: PER_LINE });
const net = game.network;
console.log(`network: ${net.stations.size} stations, ${routes.length} routes, ${fleet} trains, ${net.edges.size} edges · built in ${Date.now() - t0} ms`);

t0 = Date.now();
const engine = new Engine(world, { agentScale: scale, seed: 1885, time: game.time, fare: game.fare }, {});
engine.setNetwork(compileNetwork(game).net);
console.log(`engine init ${Date.now() - t0} ms (${engine.commuters!.A.toLocaleString()} agents)`);

// Run through the first night's 3 am mode choice to 7 am on day 1.
t0 = Date.now();
const peakStart = 86400 + 7 * 3600;
while (engine.time < peakStart) engine.step(TIME.simStep);
console.log(`warm-up to day 1 07:00: ${Date.now() - t0} ms (pathfinding ${engine.commuters!.lastPathMs} ms)`);

const steps = 3600 / TIME.simStep;
let worst = 0;
let maxRunning = 0;
t0 = performance.now();
for (let i = 0; i < steps; i++) {
  const s = performance.now();
  engine.step(TIME.simStep);
  worst = Math.max(worst, performance.now() - s);
  if (i % 60 === 0) maxRunning = Math.max(maxRunning, engine.trains.trains.filter((t) => t.state === TState.Running || t.state === TState.Dwelling).length);
}
const ms = performance.now() - t0;
const live = engine.commuters!.live();
console.log(
  `07:00–08:00 peak hour: ${ms.toFixed(0)} ms (budget at 60× is 1000 ms → ${(1000 / ms).toFixed(1)}× headroom) · worst step ${worst.toFixed(1)} ms` +
    ` · up to ${maxRunning} trains running · ${Math.round(live.ridersToday).toLocaleString()} boardings so far · ${Math.round(live.inSystem).toLocaleString()} waiting`,
);
