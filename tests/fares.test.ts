/**
 * Fare policy (v2): fare functions, peak classification, mode choice by band and period on a
 * synthetic two-tract world, and the per-agent odds adjustment for off-peak travellers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/balance';
import { applyCity } from '../src/cities';
import { toLonLat } from '../src/core/geo';
import { buildWorld, type World } from '../src/data/world';
import { encodeOD } from '../src/data/odFormat';
import { bandFactor, defaultFares, expectedFare, fareAt, fareSummary, flatFares, isFlat, isPeakTime, isPeakTod, normalizeFares, tripFare, type FarePolicy } from '../src/economy/fares';
import { Commuters } from '../src/sim/commuters';
import { fareOddsMultiplier } from '../src/sim/modeChoice';
import type { CompiledNetwork, CRouteDir } from '../src/sim/protocol';

const P = (peak: number, offPeak: number, lowIncome = 1): FarePolicy => ({ peak, offPeak, lowIncome });

beforeAll(() => {
  applyCity('nyc');
});

describe('fare functions', () => {
  it('prices by band and period', () => {
    const p = P(3.5, 2.5);
    expect(fareAt(p, 2, true)).toBe(3.5);
    expect(fareAt(p, 2, false)).toBe(2.5);
    expect(expectedFare(p, 2, 0.964)).toBeCloseTo(3.464, 12);
    expect(expectedFare({ ...p, lowIncome: 0.5 }, 0, 0.964)).toBeCloseTo(1.732, 12);
    expect(tripFare(p, 1, 2)).toBe(3.5);
    expect(tripFare(p, 1, 1)).toBe(3);
    expect(tripFare(p, 1, 0)).toBe(2.5);
    expect(bandFactor({ ...p, lowIncome: 0 }, 0)).toBe(0);
    expect(bandFactor({ ...p, lowIncome: 0 }, 1)).toBe(1);
    // Flat: exactly the fare, whatever the peak share (no float drift).
    const flat = flatFares(3);
    for (const f of [0, 0.3, 0.964, 1]) expect(expectedFare(flat, 1, f)).toBe(3);
    expect(tripFare(flat, 2, 1)).toBe(3);
    expect(isFlat(flat)).toBe(true);
    expect(isFlat({ ...flat, lowIncome: 0.5 })).toBe(false);
    expect(fareSummary(flat)).toBe('$3.00');
    expect(fareSummary(P(3.5, 2.5, 0.5))).toBe('$3.50 peak / $2.50 off-peak · low-income half');
    expect(defaultFares()).toEqual(P(3, 3, 1));
  });

  it('normalizes to the range and step, off-peak at most peak, low-income to a choice', () => {
    expect(normalizeFares(P(7, 1, 0.4))).toEqual(P(5, 1, 0.5));
    expect(normalizeFares(P(3.1, 3.4, 0.9))).toEqual(P(3, 3, 1));
    expect(normalizeFares(P(-1, -1, 0.1))).toEqual(P(0, 0, 0));
    expect(normalizeFares(P(3.38, 2.63, 1))).toEqual(P(3.5, 2.75, 1));
    expect(normalizeFares(undefined)).toEqual(P(ECONOMY.fareDefault, ECONOMY.fareDefault, 1));
    expect(normalizeFares({ peak: 4 })).toEqual(P(4, 4, 1));
  });

  it('classifies peak times at the period edges', () => {
    const h = (x: number) => x * 3600;
    expect(isPeakTod(h(5) + 59 * 60)).toBe(false);
    expect(isPeakTod(h(6))).toBe(true);
    expect(isPeakTod(h(9) + 59 * 60)).toBe(true);
    expect(isPeakTod(h(10))).toBe(false);
    expect(isPeakTod(h(16))).toBe(true);
    expect(isPeakTod(h(19) + 59 * 60)).toBe(true);
    expect(isPeakTod(h(20))).toBe(false);
    // Day offsets are ignored.
    expect(isPeakTime(5 * 86400 + h(8))).toBe(true);
    expect(isPeakTime(5 * 86400 + h(12))).toBe(false);
  });
});

/** Two Queens tracts 6 km apart, 400 commuters per band each way, and a 2-station route between them. */
function syntheticWorld(): { world: World; net: CompiledNetwork } {
  const a = toLonLat(14000, 2000), b = toLonLat(20000, 2000);
  const tract = (id: string, [lon, lat]: [number, number]) => ({ id, borough: 'Queens', lat, lon, radius: 300, residents: 1200, jobs: 1200 });
  const od = encodeOD(2, [
    { h: 0, w: 1, se: [400, 400, 400] },
    { h: 1, w: 0, se: [400, 400, 400] },
  ]);
  const world = buildWorld({ version: 1, synthetic: true, year: 2023, source: 'test', bands: ['low', 'mid', 'high'], tracts: [tract('A', a), tract('B', b)] }, od.buffer.slice(od.byteOffset, od.byteOffset + od.byteLength) as ArrayBuffer);
  const dir = (st: number[]): CRouteDir => ({
    xs: new Float64Array(2),
    ys: new Float64Array(2),
    zs: new Float64Array(2),
    cum: new Float64Array([0, 6000]),
    length: 6000,
    stopStation: Int32Array.from(st),
    stopS: Float64Array.from([0, 6000]),
    limS0: new Float64Array(0),
    limS1: new Float64Array(0),
    limV: new Float64Array(0),
    elems: [],
    schedArrive: Float64Array.from([0, 420]),
    schedDepart: Float64Array.from([0, 420]),
    runTime: 420,
  });
  const net: CompiledNetwork = {
    version: 1,
    stations: [
      { id: 10, x: 14000, y: 2000, name: 'A', group: 0 },
      { id: 11, x: 20000, y: 2000, name: 'B', group: 1 },
    ],
    routes: [{ id: 1, name: 'R', bullet: 'R', color: '#fff', cls: 'heavy', cars: 8, trainLength: 144, capComfort: 880, capCrush: 1600, accel: 1.1, brake: 1.2, vmax: 25, headways: [600, 240, 480, 240, 600], fleet: 6, dirs: [dir([0, 1]), dir([1, 0])] }],
    trackCount: 0,
    lockCount: 0,
  };
  return { world, net };
}

describe('mode choice by band and period', () => {
  const { world, net } = syntheticWorld();
  /** Transit share per band after one day's mode choice under a policy. */
  const run = (fares: FarePolicy) => {
    const c = new Commuters(world, { agentScale: 1, seed: 1885, fares });
    c.setNetwork(net, 0);
    c.dailyModeChoice(3 * 3600);
    const byBand = [0, 0, 0], n = [0, 0, 0];
    for (let g = 0; g < c.G; g++) {
      byBand[c.gBand[g]] += c.shares[g * 3 + 2] * c.gCount[g];
      n[c.gBand[g]] += c.gCount[g];
    }
    return { c, share: byBand.map((x, b) => x / n[b]), report: c.dayReport(0) };
  };

  it('a low-income discount lifts only the lowest band', () => {
    const flat = run(P(3, 3, 1));
    const half = run(P(3, 3, 0.5));
    expect(flat.c.G).toBeGreaterThan(0);
    expect(half.share[0]).toBeGreaterThan(flat.share[0]);
    expect(half.share[1]).toBe(flat.share[1]);
    expect(half.share[2]).toBe(flat.share[2]);
    // Drawn modes by band are reported.
    expect(flat.report.bandShare).toHaveLength(3);
    expect(flat.report.bandShare[0]).toBeGreaterThan(0);
  });

  it('peak pricing: the group fare weighs the peak share, and costs ridership against a cheap flat fare', () => {
    const p = P(4, 2);
    const pk = run(p);
    const cheap = run(P(2, 2));
    for (let g = 0; g < pk.c.G; g++) {
      expect(pk.c.groupFare(g)).toBe(expectedFare(p, pk.c.gBand[g], pk.c.gPeakFrac[g]));
      expect(pk.c.gPeakFrac[g]).toBeGreaterThan(0.9);
      expect(pk.c.gPeakFrac[g]).toBeLessThan(1);
    }
    for (let b = 0; b < 3; b++) expect(pk.share[b]).toBeLessThan(cheap.share[b]);
  });

  it('tilts each agent by its own trips, with no extra random draws', () => {
    expect(fareOddsMultiplier(0.5, 0)).toBeLessThan(1);
    expect(fareOddsMultiplier(-0.5, 0)).toBeGreaterThan(1);
    expect(fareOddsMultiplier(0, 2)).toBe(1);
    const p = P(4, 2);
    const gf = expectedFare(p, 1, 0.96);
    expect(fareOddsMultiplier(tripFare(p, 1, 0) - gf, 1)).toBeGreaterThan(1);
    expect(fareOddsMultiplier(tripFare(p, 1, 2) - gf, 1)).toBeLessThan(1);
    const flat = flatFares(3);
    for (const k of [0, 1, 2]) expect(fareOddsMultiplier(tripFare(flat, 1, k) - expectedFare(flat, 1, 0.96), 1)).toBe(1);
    // Under peak pricing, agents travelling off-peak take transit more often than peak travellers
    // in the same groups (with one fare all day they would draw from the same shares).
    const tilted = run(p).c;
    const rate = (ks: number[]) => {
      let n = 0, tr = 0;
      for (let a = 0; a < tilted.A; a++) {
        const pk = tilted.aPeak[a];
        if (!ks.includes((pk & 1) + (pk >> 1))) continue;
        n++;
        if (tilted.aMode[a] === 2) tr++;
      }
      return { n, share: tr / n };
    };
    const offPeak = rate([0, 1]), peak = rate([2]);
    expect(offPeak.n).toBeGreaterThan(20);
    // (The gap narrows as transit's share grows: shares nearer 50% move less for the same odds.)
    expect(offPeak.share).toBeGreaterThan(peak.share + 0.02);
    // One draw per agent either way: the same seed gives the same draws under the same policy.
    const again = run(p).c;
    expect(Array.from(again.aMode.slice(0, again.A))).toEqual(Array.from(tilted.aMode.slice(0, tilted.A)));
  });
});
