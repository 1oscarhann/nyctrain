/**
 * Japan balance scenario: a Tokaido-style line, Tokyo to Shin-Osaka (515 km, 14 stations), with an
 * all-stations service and a fast one; prints what it costs and carries. npx tsx scripts/japan-tokaido.ts [days=3]
 */
import { applyCity } from '../src/cities';
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { createHeadlessGame, makeRoute, runDays, stationLine } from '../src/sim/headless';
import { edgeReport } from '../src/construction/validate';
import { fmtMoney, setUnits } from '../src/core/units';
import type { TrackLevel } from '../src/balance';

applyCity('japan');
setUnits('metric');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const days = Number(args.days ?? 3);
const world = loadWorldFromDisk();
const land = loadLandFromDisk();
const game = createHeadlessGame(world, land, { sandbox: true });
type LL = [number, number];
/** Stations (named) and bends (unnamed): roughly the Tokaido corridor. */
const S: [string, LL, TrackLevel][] = [
  ['Tokyo', [139.767, 35.681], 'elevated'],
  ['Shinagawa', [139.74, 35.628], 'elevated'],
  ['', [139.69, 35.565], 'deep'],
  ['Shin-Yokohama', [139.617, 35.507], 'elevated'],
  ['', [139.40, 35.37], 'elevated'],
  ['Odawara', [139.155, 35.256], 'elevated'],
  ['', [139.10, 35.17], 'deep'],
  ['Atami', [139.078, 35.104], 'deep'],
  ['', [139.0, 35.11], 'deep'],
  ['Mishima', [138.911, 35.127], 'elevated'],
  ['', [138.62, 35.13], 'elevated'],
  ['Shizuoka', [138.389, 34.972], 'elevated'],
  ['', [138.05, 34.83], 'deep'],
  ['Hamamatsu', [137.734, 34.704], 'elevated'],
  ['Toyohashi', [137.382, 34.763], 'elevated'],
  ['', [137.10, 34.98], 'elevated'],
  ['Nagoya', [136.882, 35.171], 'elevated'],
  ['Gifu-Hashima', [136.693, 35.316], 'elevated'],
  ['', [136.45, 35.36], 'deep'],
  ['Maibara', [136.29, 35.315], 'elevated'],
  ['', [136.0, 35.1], 'elevated'],
  ['Kyoto', [135.758, 34.986], 'elevated'],
  ['Shin-Osaka', [135.5, 34.733], 'elevated'],
];
const st = stationLine(game, S.map(([name, at, level]) => ({ name: name || undefined, at, level })), 'highspeed', 16);
let cost = 0, len = 0;
const errs: string[] = [];
for (const id of game.network.edges.keys()) {
  const r = edgeReport(game.network, id, game.terrain);
  cost += r.cost;
  len += r.length;
  if (!r.ok) errs.push(`${id}: ${r.errors.join('; ')}`);
  if (args.v) console.log(`edge ${id} ${(r.length / 1000).toFixed(1)} km ${fmtMoney(r.cost)} density×${r.densityMult.toFixed(2)} mountains×${r.mountainMult.toFixed(2)} ${Math.round(r.days)} d`);
}
console.log(`track: ${(len / 1000).toFixed(0)} km, ${fmtMoney(cost)} (${fmtMoney(cost / (len / 1000))}/km)`, errs.length ? errs : '');
const stCost = [...game.network.stations.values()].reduce((a, s) => a + (s.cost ?? 0), 0);
console.log('stations', st.length, fmtMoney(stCost));
game.build(true);
const fast = ['Tokyo', 'Shinagawa', 'Shin-Yokohama', 'Nagoya', 'Kyoto', 'Shin-Osaka'].map((n) => st[S.filter((x) => x[0]).findIndex((x) => x[0] === n)]);
const all = makeRoute(game, 'Kodama', 'K', '#2F7FE0', st, 16, { night: 0, am: 30, midday: 30, pm: 30, evening: 30 }, 'highspeed');
all.stock = 'highspeed';
const ex = makeRoute(game, 'Nozomi', 'N', '#E8452C', fast, 16, { night: 0, am: 10, midday: 15, pm: 10, evening: 20 }, 'highspeed');
ex.stock = 'highspeed';
const run = runDays(game, days, { agentScale: 20, destinations: args.dest !== '0' });
for (const r of run.reports) {
  console.log(`day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} fare ${fmtMoney(r.fareRevenue)} carKm ${Math.round(r.carKm).toLocaleString()} share ${(r.transitShare ?? 0).toFixed?.(3)}`);
}
const f = game.finance;
console.log('cash', fmtMoney(f.cash), 'ms', run.ms);
console.log(JSON.stringify(f.history.slice(-1)[0], null, 0).slice(0, 600));

// Who rides: transit share of journeys by straight-line distance, among pairs with a station within 30 km of both ends.
const c = run.engine.commuters!;
const tr = world.tracts;
const stPos = [...game.network.stations.values()].map((s) => game.network.stationPos(s));
const near = tr.map((t) => stPos.some((p) => Math.hypot(p.x - t.x, p.y - t.y) < 30_000));
const bands = [50, 100, 200, 300, 400, 600, 2000];
const agg = bands.map(() => ({ n: 0, tr: 0 }));
for (let g = 0; g < c.G; g++) {
  const h = c.gHome[g], w = c.gWork[g];
  if (!near[h] || !near[w]) continue;
  const d = Math.hypot(tr[h].x - tr[w].x, tr[h].y - tr[w].y) / 1000;
  const k = bands.findIndex((b) => d < b);
  agg[k].n += c.gCount[g];
  agg[k].tr += c.gCount[g] * c.shares[g * 3 + 2];
}
console.log('served pairs: journeys (agents×20) and transit share by distance');
agg.forEach((a, i) => console.log(`  < ${bands[i]} km: ${(a.n * 20).toLocaleString()} ${(a.tr / Math.max(1, a.n) * 100).toFixed(1)}%`));

if (args.month) {
  const more = runDays(game, Number(args.month), { agentScale: 20, destinations: args.dest !== '0', growthPace: 'steady' });
  const vc = more.reports.filter((r) => r.growth).map((r) => r.growth!.valueCapture);
  const last = more.reports[more.reports.length - 1];
  console.log('after', more.reports.length, 'more days: riders', Math.round(last.riders), 'fare/day', fmtMoney(last.fareRevenue), 'value capture months', vc.map((v) => fmtMoney(v)));
}
