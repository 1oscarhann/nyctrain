/**
 * Tokyo balance scenario: a three-line core in deep tunnel (an Ikebukuro–Otemachi–Shinjuku line, a
 * Shibuya–Ginza–Ueno–Asakusa line and a Nakano–Otemachi–Toyocho line) from the terminals into
 * the centre; prints what it costs and carries. npx tsx scripts/tokyo-core.ts [days=3] [through=1]
 * [month=20] [scale=20]
 */
import { applyCity } from '../src/cities';
import { loadLandFromDisk, loadWorldFromDisk } from './nodeData';
import { createHeadlessGame, makeRoute, runDays, stationLine } from '../src/sim/headless';
import { edgeReport } from '../src/construction/validate';
import { fmtMoney, setUnits } from '../src/core/units';
import { applyTech } from '../src/core/tech';
import type { ResearchId } from '../src/balance';

applyCity('tokyo');
setUnits('metric');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const days = Number(args.days ?? 3);
const scale = Number(args.scale ?? 20);
const world = loadWorldFromDisk();
const land = loadLandFromDisk();
const game = createHeadlessGame(world, land, { sandbox: true });
if (args.through) {
  game.research.done.push('through-running' as ResearchId);
  applyTech(game.research.done);
}
type LL = [number, number];
const LINES: { name: string; bullet: string; color: string; stops: [string, LL][] }[] = [
  {
    name: 'Marunouchi-style', bullet: 'M', color: '#E60012', stops: [
      ['Ikebukuro', [139.7125, 35.7285]], ['Shin-Otsuka', [139.7298, 35.7219]], ['Myogadani', [139.7372, 35.7172]], ['Korakuen', [139.7516, 35.7077]],
      ['Otemachi', [139.7633, 35.6866]], ['Ginza', [139.7656, 35.6717]], ['Kasumigaseki', [139.7507, 35.6735]],
      ['Akasaka', [139.7388, 35.6762]], ['Yotsuya', [139.7305, 35.6846]], ['Shinjuku-gyoemmae', [139.7104, 35.6884]], ['Shinjuku', [139.6995, 35.6905]],
    ],
  },
  {
    name: 'Ginza-style', bullet: 'G', color: '#F39700', stops: [
      ['Shibuya', [139.7025, 35.659]], ['Omotesando', [139.712, 35.6654]], ['Aoyama', [139.7243, 35.6727]], ['Toranomon', [139.7455, 35.6702]],
      ['Shimbashi', [139.7583, 35.6663]], ['Kyobashi', [139.7699, 35.6767]], ['Nihombashi', [139.7744, 35.6826]], ['Kanda', [139.7709, 35.6935]],
      ['Suehirocho', [139.7716, 35.7027]], ['Ueno', [139.7766, 35.7115]], ['Asakusa', [139.7975, 35.7112]],
    ],
  },
  {
    name: 'Tozai-style', bullet: 'T', color: '#00A7DB', stops: [
      ['Nakano', [139.6657, 35.7058]], ['Ochiai', [139.6874, 35.7105]], ['Takadanobaba', [139.7038, 35.7128]], ['Waseda', [139.7213, 35.7058]],
      ['Iidabashi', [139.7448, 35.7021]], ['Kudanshita', [139.7514, 35.6955]], ['Takebashi', [139.7581, 35.6904]], ['Otemachi T', [139.7665, 35.6855]],
      ['Kayabacho', [139.7801, 35.6797]], ['Monzen-Nakacho', [139.7963, 35.6718]], ['Toyocho', [139.8172, 35.6696]],
    ],
  },
];
let cost = 0, len = 0;
const routes: number[][] = [];
for (const L of LINES) {
  const st = stationLine(game, L.stops.map(([name, at]) => ({ name, at, level: 'deep' })), 'heavy', 10);
  routes.push(st);
}
for (const id of game.network.edges.keys()) {
  const r = edgeReport(game.network, id, game.terrain);
  cost += r.cost;
  len += r.length;
}
const stCost = [...game.network.stations.values()].reduce((a, s) => a + (s.cost ?? 0), 0);
console.log(`track ${(len / 1000).toFixed(1)} km ${fmtMoney(cost)} (${fmtMoney(cost / (len / 1000))}/km) · ${game.network.stations.size} stations ${fmtMoney(stCost)}`);
game.build(true);
LINES.forEach((L, i) => {
  const r = makeRoute(game, L.name, L.bullet, L.color, routes[i], 10, { night: 0, am: 2.5, midday: 5, pm: 2.5, evening: 6 });
  void r;
});
const run = runDays(game, days, { agentScale: scale, destinations: true });
for (const r of run.reports) {
  const f = game.finance.history.find((h) => h.day === r.day);
  console.log(
    `day ${r.day}: riders ${Math.round(r.riders).toLocaleString()} share ${(r.transitShare * 100).toFixed(1)}% commute ${r.avgCommute.toFixed(1)} (base ${r.baselineCommute.toFixed(1)}) fare ${fmtMoney(r.fareRevenue)}` +
      (f ? ` · operating ${fmtMoney(f.operating)} staffing ${fmtMoney(f.staffing)} maintenance ${fmtMoney(f.maintenance)}` : ''),
  );
}
console.log('ms', run.ms);
{
  const r = run.reports[run.reports.length - 1];
  const turned = Object.values(r.stationTurnedAway ?? {}).reduce((a, b) => a + b, 0);
  const peaks = Object.values(r.routePeakLoad ?? {}).map((x) => x.toFixed(2));
  const names = new Map([...game.network.stations.values()].map((s) => [s.id, s.name]));
  const worst = Object.entries(r.stationPeak ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, v]) => `${names.get(Number(id))} ${v.toFixed(1)}`);
  console.log(`last day: late ${r.avgLateness.toFixed(0)} s, left behind ${Math.round(r.leftBehind)}, gave up ${Math.round(r.gaveUp)}, turned away ${Math.round(turned)}, walk ${(r.walkShare * 100).toFixed(1)}% drive ${(r.driveShare * 100).toFixed(1)}%, route peak loads ${peaks.join(' ')}, fullest stations ${worst.join(', ')}`);
}
// Terminal commuters: transit share of groups from each terminal.
const c = run.engine.commuters!;
const tr = world.tracts;
const term = new Map<number, { n: number; t: number }>();
let townN = 0, townT = 0;
for (let g = 0; g < c.G; g++) {
  const h = c.gHome[g];
  const n = c.gCount[g], t = c.gCount[g] * c.shares[g * 3 + 2];
  if (tr[h].terminal) {
    const x = term.get(h) ?? { n: 0, t: 0 };
    x.n += n;
    x.t += t;
    term.set(h, x);
  } else {
    townN += n;
    townT += t;
  }
}
for (const [h, x] of term) console.log(`  ${tr[h].name}: ${Math.round(x.n * scale).toLocaleString()} commuters, ${((100 * x.t) / x.n).toFixed(1)}% by subway`);
console.log(`  towns: ${Math.round(townN * scale).toLocaleString()} commuters, ${((100 * townT) / townN).toFixed(1)}% by subway`);
if (args.month) {
  const more = runDays(game, Number(args.month), { agentScale: scale, destinations: true, growthPace: 'steady' });
  const last = more.reports[more.reports.length - 1];
  const vc = more.reports.filter((r) => r.growth).map((r) => fmtMoney(r.growth!.valueCapture));
  const f = game.finance.history[game.finance.history.length - 1];
  console.log(`after ${more.reports.length} more days: riders ${Math.round(last.riders).toLocaleString()} share ${(last.transitShare * 100).toFixed(1)}% fare ${fmtMoney(last.fareRevenue)} operating ${fmtMoney(f.operating)} value capture ${vc.join(', ')}`);
}
