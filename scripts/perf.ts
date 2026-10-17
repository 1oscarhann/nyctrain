/**
 * Performance check for the spec's target (300 stations, 25 routes, ~400 trains):
 *   npm run perf [-- city=nyc|london scale=10 ns=17 ew=8 stations=12 chaos=off|calm|normal|wild weather=clear|rain|snow|heat outdoor=1 ops=on|off month=0 quads=N]
 * quads=N (express service, v2) turns N of the north–south lines into four-track lines with
 * cross-platform stations, each with an all-stops local and an express (docs/v2/express-quad.md §10).
 * ops= (operations control): by default every route holds at 70% with suggested timepoints and no
 * recovery (so the fleet stays at 431 trains while the holding code runs); ops=off is the code
 * before operations control (no holding, standard turnarounds, one flat fare).
 * chaos= turns city chaos on (incidents, events), weather= forces day 1's weather at full
 * severity, and outdoor=1 marks every route fully outdoor (the worst case for snow and heat).
 * Builds a large synthetic network (a grid of deep-tunnel lines across Brooklyn, Manhattan and
 * Queens), runs the sim to the morning peak and times one game-hour. At the top speed (60×) the
 * worker must simulate one game-hour per real second, so the budget is 1000 ms.
 * Then (Living City, unless month=0) it runs on through two growth month closes, at the
 * midnights after day 1 and day 3 (the engine closes a growth month every 2 days here, so the
 * timed peak hour is the same as without it), and times each: the first switches every agent
 * to its per-agent placement (computed a few thousand agents per step beforehand, so the close
 * copies them), the second is a typical month. The budget is 600 ms; the worst is printed too.
 */
import { CHAOS, TIME, type ChaosLevel, type WeatherKind } from '../src/balance';
import { GROWTH_LABEL } from '../src/sim/protocol';
import { compileNetwork } from '../src/routes/compile';
import { suggestTimepoints } from '../src/routes/control';
import { buildPerfNetwork, createHeadlessGame, PERF_AREA_LONDON } from '../src/sim/headless';
import { applyCity, isCityId } from '../src/cities';
import { Engine } from '../src/sim/engine';
import { TState } from '../src/sim/trainSim';
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
// city=london runs a grid of the same size around Charing Cross (default New York).
const cityId = args.city ?? 'nyc';
if (!isCityId(cityId)) throw new Error(`Unknown city ${cityId}`);
applyCity(cityId);
const scale = Number(args.scale ?? 10);
const NS = Number(args.ns ?? 17);
const EW = Number(args.ew ?? 8);
const PER_LINE = Number(args.stations ?? 12);
const chaos = (args.chaos ?? 'off') as ChaosLevel;
const weather = args.weather as WeatherKind | undefined;
const outdoor = args.outdoor === '1';
const chaosArgs = chaos !== 'off' || weather !== undefined || outdoor;
const opsOff = args.ops === 'off';
const monthClose = args.month !== '0';
const quads = Number(args.quads ?? 0);

const world = loadWorldFromDisk();
const game = createHeadlessGame(world, loadLandFromDisk(), { sandbox: true, ops: opsOff ? 'off' : 'default' });
let t0 = Date.now();
const { routes, fleet } = buildPerfNetwork(game, { ns: NS, ew: EW, perLine: PER_LINE, ...(opsOff ? {} : { control: { hold: true, recoveryPct: 0 } }), ...(cityId === 'london' ? { area: PERF_AREA_LONDON } : {}), ...(quads > 0 ? { quads } : {}) });
if (!opsOff) for (const r of routes) game.routes.update(r.id, { control: { ...r.control, timepoints: suggestTimepoints(r, routes) } });
const net = game.network;
console.log(`network: ${net.stations.size} stations, ${routes.length} routes, ${fleet} trains, ${net.edges.size} edges · built in ${Date.now() - t0} ms`);

t0 = Date.now();
let incidents = 0;
// Living City: growth month closes are timed from the engine's busy label (on, then off).
const closes: number[] = [];
let closeStart = 0;
const engine = new Engine(world, { agentScale: scale, seed: 1885, time: game.time, fares: game.fares, chaos: { level: chaos, seed: CHAOS.defaultSeed }, ...(monthClose ? { monthEvery: 2 } : {}) }, {
  alert: (a) => {
    if (a.status === 'active') incidents++;
  },
  busy: (label) => {
    if (label === GROWTH_LABEL) closeStart = performance.now();
    else if (label === null && closeStart) {
      closes.push(performance.now() - closeStart);
      closeStart = 0;
    }
  },
});
const compiled = compileNetwork(game).net;
if (outdoor) for (const r of compiled.routes) for (const d of r.dirs) {
  d.outS0 = new Float64Array([0]);
  d.outS1 = new Float64Array([d.length]);
}
if (weather) engine.chaos.forceWeather(1, { kind: weather, severity: weather === 'clear' ? 0 : 1, carried: false });
engine.setNetwork(compiled);
console.log(`engine init ${Date.now() - t0} ms (${engine.commuters!.A.toLocaleString()} agents)`);

// Run through the first night's 3 am mode choice to 7 am on day 1.
t0 = Date.now();
const peakStart = 86400 + 7 * 3600;
while (engine.time < peakStart) engine.step(TIME.simStep);
console.log(`warm-up to day 1 07:00: ${Date.now() - t0} ms (pathfinding ${engine.commuters!.lastPathMs} ms)`);

const steps = 3600 / TIME.simStep;
incidents = 0;
const reg0 = engine.trains.regularityToday();
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
const reg1 = engine.trains.regularityToday();
console.log(
  `07:00–08:00 peak hour: ${ms.toFixed(0)} ms (budget at 60× is 1000 ms → ${(1000 / ms).toFixed(1)}× headroom) · worst step ${worst.toFixed(1)} ms` +
    ` · up to ${maxRunning} trains running · ${Math.round(live.ridersToday).toLocaleString()} boardings so far · ${Math.round(live.inSystem).toLocaleString()} waiting`,
);
console.log(
  `operations control ${opsOff ? 'off' : 'on (holding 70%, suggested timepoints, no recovery)'}: ${reg1.holds - reg0.holds} holds in the timed hour` +
    ` (${reg1.holds ? ((reg1.holdSec - reg0.holdSec) / Math.max(1, reg1.holds - reg0.holds)).toFixed(0) : 0} s each) · ${engine.trains.day.shortTurns} short turnarounds today · headway CV so far ${reg1.cv.toFixed(2)}, bunched ${(reg1.bunched * 100).toFixed(1)}%`,
);
if (quads > 0) {
  const ov = [...engine.trains.day.overtakes.values()].reduce((a, b) => a + b, 0);
  const pairs = compiled.stations.filter((s, i) => s.pair !== undefined && s.pair > i).length;
  console.log(`four-track: ${quads} quad lines · ${pairs} cross-platform stations · ${compiled.routes.filter((r) => r.express).length} express routes · ${ov} overtakes so far today · ${compiled.lockCount} merge locks`);
}
if (chaosArgs) {
  const w = engine.chaos.todayWeather();
  console.log(`chaos ${chaos} · day 1 weather ${w.weather.kind} (${w.weather.severity.toFixed(2)}) · outdoor ${outdoor ? 'all track' : 'as built'} · ${incidents} incidents started in the timed hour · ${engine.commuters!.eventAgentCount().toLocaleString()} event agents today`);
}

if (monthClose) {
  // On through the midnights after day 1 and day 3 (growth month closes) to day 4.
  t0 = Date.now();
  const end = 4 * 86400 + 60;
  while (engine.time < end) engine.step(TIME.simStep);
  const g = engine.growth!;
  const st = engine.lastRegen;
  console.log(
    `month close: ${closes.map((ms) => `${ms.toFixed(0)} ms`).join(', then ')} · worst ${Math.max(0, ...closes).toFixed(0)} ms (budget 600 ms; the first gives every agent its per-agent placement, pre-placed during the month) · ${g.months} growth months` +
      ` · ${engine.commuters!.A.toLocaleString()} agents · last regeneration kept ${st?.kept.toLocaleString()} groups, ${st?.newBands} new bands, ${st?.newPairs} new pairs · ran days 1–3 in ${Date.now() - t0} ms`,
  );
}
