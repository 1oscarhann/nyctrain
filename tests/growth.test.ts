/**
 * Living City model (docs/v2/living-city.md §12, tests 1–9): logsum and the commute benefit, the
 * monthly growth step (baseline, monotone, bounds, pace), determinism and the state round trip,
 * Furness consistency on the real New York and London data, value capture and history thinning;
 * plus the identity hashes and per-city values.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CITY_BALANCE, COMMUTERS, GROWTH, VALUE_CAPTURE, type GrowthPace } from '../src/balance';
import { applyCity } from '../src/cities';
import { toLonLat } from '../src/core/geo';
import { fnv32, hash32x4, hashSeed, Rng } from '../src/core/rng';
import { encodeOD } from '../src/data/odFormat';
import type { TractsFile } from '../src/data/types';
import { buildWorld, type World } from '../src/data/world';
import { attractiveness, DISTRICT_SAMPLES, fitTotal, Growth, servedStations, type StationPt } from '../src/sim/growth';
import { generalisedCosts, logsum, transitBenefit, transitCost, type PairGeometry } from '../src/sim/modeChoice';
import type { CompiledNetwork, GrowthData } from '../src/sim/protocol';
import { loadWorldFromDisk } from '../scripts/nodeData';

afterAll(() => {
  applyCity('nyc');
});

// ---------------------------------------------------------------------------
// Synthetic worlds

interface SynthTract {
  x: number;
  y: number;
  radius?: number;
}

/** A world from local-metre tract positions and OD rows (h, w, [band counts]); residents and jobs are the OD sums. */
function synthWorld(tracts: SynthTract[], rows: { h: number; w: number; se: [number, number, number] }[]): World {
  const res = new Array(tracts.length).fill(0), jobs = new Array(tracts.length).fill(0);
  for (const r of rows) {
    const c = r.se[0] + r.se[1] + r.se[2];
    res[r.h] += c;
    jobs[r.w] += c;
  }
  const file: TractsFile = {
    version: 1,
    synthetic: true,
    year: 2023,
    source: 'synthetic test',
    bands: ['a', 'b', 'c'],
    tracts: tracts.map((t, i) => {
      const [lon, lat] = toLonLat(t.x, t.y);
      return { id: `T${i}`, borough: 'Manhattan', lat, lon, radius: t.radius ?? 200, residents: res[i], jobs: jobs[i] };
    }),
  };
  const bin = encodeOD(tracts.length, rows);
  return buildWorld(file, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
}

/** n tracts in a row 1 km apart with a full, equal OD (every tract has the same residents and jobs). */
function equalWorld(n: number, c = 40): World {
  const rows: { h: number; w: number; se: [number, number, number] }[] = [];
  for (let h = 0; h < n; h++) for (let w = 0; w < n; w++) rows.push({ h, w, se: [c, c, c] });
  return synthWorld(
    Array.from({ length: n }, (_, i) => ({ x: i * 1000, y: 0 })),
    rows,
  );
}

/** Six tracts; tract 5 has residents but no jobs (like New York's 20 zero-job tracts). */
function sixWorld(): World {
  const rows: { h: number; w: number; se: [number, number, number] }[] = [];
  const rng = new Rng(7);
  for (let h = 0; h < 6; h++)
    for (let w = 0; w < 5; w++) rows.push({ h, w, se: [20 + rng.int(80), 20 + rng.int(80), 20 + rng.int(80)] });
  return synthWorld(
    Array.from({ length: 6 }, (_, i) => ({ x: (i % 3) * 1500, y: Math.floor(i / 3) * 1500 })),
    rows,
  );
}

const zeros = (n: number) => ({ home: new Float64Array(n), work: new Float64Array(n) });
const gBase = () => (1 + GROWTH.cityGrowthPerYear) ** (1 / 12) - 1;
const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);
const totals = (g: Growth) => {
  let r = 0, j = 0;
  for (let i = 0; i < g.T; i++) {
    r += g.residents(i);
    j += g.jobs(i);
  }
  return { r, j };
};
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

// ---------------------------------------------------------------------------

describe('identity hashes (rng)', () => {
  it('hash32x4 is deterministic and spreads a 50k-key sample like a random function', () => {
    expect(hash32x4(1885, 7, 9, 0)).toBe(hash32x4(1885, 7, 9, 0));
    const seen = new Set<number>();
    const buckets = new Array(64).fill(0);
    for (let h = 0; h < 50; h++)
      for (let w = 0; w < 50; w++)
        for (let k = 0; k < 20; k++) {
          const v = hash32x4(1885, h * 3 + (k % 3), w, k);
          seen.add(v);
          buckets[v >>> 26]++;
        }
    // 50k keys into 2^32 values: a random function collides 0.29 times on average (birthday bound).
    expect(50_000 - seen.size).toBeLessThanOrEqual(3);
    // High and low bits are both uniform (64 buckets of ≈ 781).
    const low = new Array(64).fill(0);
    for (const v of seen) low[v & 63]++;
    for (const b of [...buckets, ...low]) {
      expect(b).toBeGreaterThan(650);
      expect(b).toBeLessThan(920);
    }
    // Neighbouring keys give unrelated streams.
    const a = new Rng(1), b = new Rng(1);
    a.reseed(hash32x4(1885, 3, 4, 0));
    b.reseed(hash32x4(1885, 3, 4, 1));
    expect(a.next()).not.toBe(b.next());
  });

  it('reseed restarts the stream exactly as a new Rng would', () => {
    const r = new Rng(5);
    r.next();
    r.reseed(12345);
    const fresh = new Rng(12345);
    for (let i = 0; i < 5; i++) expect(r.next()).toBe(fresh.next());
    r.reseed(0);
    expect(r.next()).toBe(new Rng(1).next());
  });

  it('fnv32 matches FNV-1a and chains', () => {
    expect(fnv32(new Uint8Array(0))).toBe(0x811c9dc5);
    expect(fnv32(new TextEncoder().encode('a'))).toBe(0xe40c292c);
    expect(fnv32(new TextEncoder().encode('foobar'))).toBe(0xbf9cf968);
    const ab = fnv32(new TextEncoder().encode('bar'), fnv32(new TextEncoder().encode('foo')));
    expect(ab).toBe(0xbf9cf968);
    // The existing chaos hash is untouched.
    expect(hashSeed(1, 2)).toBe(hashSeed(1, 2));
  });
});

describe('1. logsum and transitBenefit', () => {
  const theta = COMMUTERS.logitScale;
  it('equals the logsum difference, is ≥ 0, ln 2/θ at equal costs, → 0 and → ls − tr at the extremes', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 500; i++) {
      const w = rng.next() < 0.3 ? Infinity : 10 + rng.next() * 80;
      const d = 10 + rng.next() * 80;
      const tr = 5 + rng.next() * 120;
      const ls = logsum([w, d]);
      const b = transitBenefit(ls, tr);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(Math.abs(b - (ls - logsum([w, d, tr])))).toBeLessThan(1e-9);
    }
    expect(transitBenefit(40, 40)).toBeCloseTo(Math.LN2 / theta, 12);
    expect(transitBenefit(40, 1e6)).toBe(0);
    expect(transitBenefit(40, Infinity)).toBe(0);
    expect(transitBenefit(40, 400)).toBeLessThan(1e-9);
    expect(Math.abs(transitBenefit(400, 10) - 390)).toBeLessThan(1e-9);
    // logsum: a single alternative is its cost; unavailable alternatives drop out; all unavailable → Infinity.
    expect(logsum([25])).toBe(25);
    expect(logsum([25, Infinity])).toBe(25);
    expect(logsum([Infinity, Infinity])).toBe(Infinity);
    expect(logsum([30, 30])).toBeCloseTo(30 - Math.LN2 / theta, 12);
  });

  it('transitCost is exactly the transit entry of generalisedCosts', () => {
    const geom: PairGeometry = { distance: 6000, homeCore: false, workCore: true, workCbd: true, homeCbd: false };
    const t = { time: 1900, transfers: 1, crowdMinutes: 2.5, fare: 2.75 };
    for (let band = 0; band < 3; band++) expect(generalisedCosts(geom, band, t)[2]).toBe(transitCost(t, band));
  });
});

describe('2. baseline growth only', () => {
  it('every tract grows by exactly the natural rate; residents ≡ jobs ≡ T0·(1+g)^(n/12); zero-job tracts stay empty', () => {
    const world = sixWorld();
    const g = new Growth(world, 'steady');
    expect(g.isIdentity()).toBe(true);
    expect(g.factors()).toBeNull();
    expect(g.fingerprint()).toBe('');
    expect(g.J0[5]).toBe(0);
    const T0 = g.total0;
    expect(sum(g.J0)).toBe(T0);
    const r = gBase();
    const z = zeros(g.T);
    g.step(0, z, []);
    for (let i = 0; i < 6; i++) expect(Math.abs(g.mRes[i] - (1 + r))).toBeLessThan(1e-7);
    for (let i = 0; i < 5; i++) expect(Math.abs(g.mJobs[i] - (1 + r))).toBeLessThan(1e-7);
    for (let n = 1; n < 24; n++) g.step(n, z, []);
    const { r: R, j: J } = totals(g);
    const expectTot = T0 * (1 + GROWTH.cityGrowthPerYear) ** 2;
    expect(Math.abs(R - expectTot) / expectTot).toBeLessThan(1e-6);
    expect(Math.abs(J - expectTot) / expectTot).toBeLessThan(1e-6);
    expect(g.jobs(5)).toBe(0);
    expect(g.mJobs[5]).toBe(1);
    expect(g.months).toBe(24);
    expect(g.appliedThroughDay).toBe(23);
  });
});

describe('3. monotone in the benefit', () => {
  it('with equal bases, a better-served tract never grows less; the best is above baseline and an unserved one below', () => {
    const n = 8;
    const g = new Growth(equalWorld(n), 'steady');
    const home = Float64Array.from({ length: n }, (_, i) => i * 6);
    const work = Float64Array.from({ length: n }, (_, i) => i * 3);
    for (let m = 0; m < 12; m++) g.step(m, { home, work }, []);
    for (let i = 0; i < n - 1; i++) {
      expect(g.mRes[i]).toBeLessThanOrEqual(g.mRes[i + 1]);
      expect(g.mJobs[i]).toBeLessThanOrEqual(g.mJobs[i + 1]);
    }
    const base = (1 + gBase()) ** 12;
    expect(g.mRes[n - 1]).toBeGreaterThan(base);
    expect(g.mRes[0]).toBeLessThan(base);
    expect(g.mJobs[n - 1]).toBeGreaterThan(base);
    expect(g.mJobs[0]).toBeLessThan(base);
    // The month report ranks the best-served tract first.
    const rep = g.step(12, { home, work }, [])!;
    expect(rep.boomtowns[0].tract).toBe(n - 1);
    expect(Math.abs(rep.residents - rep.jobs) / rep.residents).toBeLessThan(1e-6);
  });
});

describe('4. bounds', () => {
  for (const pace of ['steady', 'boom'] as GrowthPace[]) {
    it(`hold for 600 months on ${pace}: tract multiples, monthly rates and the city ceiling`, () => {
      const n = 12;
      const world = equalWorld(n);
      const g = new Growth(world, pace);
      const k = GROWTH.paceMultiplier[pace];
      const R = GROWTH.residents, Jb = GROWTH.jobs;
      // One tract with an enormous benefit, a few good ones, the rest unserved.
      const home = Float64Array.from({ length: n }, (_, i) => (i === 0 ? 1e6 : i < 4 ? 60 : 0));
      const work = Float64Array.from({ length: n }, (_, i) => (i === 0 ? 1e6 : i < 3 ? 40 : 0));
      let prevR = Float32Array.from(g.mRes), prevJ = Float32Array.from(g.mJobs);
      for (let m = 0; m < 600; m++) {
        g.step(m, { home, work }, []);
        for (let i = 0; i < n; i++) {
          expect(g.mRes[i]).toBeLessThanOrEqual(R.maxMultiple * (1 + 1e-6));
          expect(g.mRes[i]).toBeGreaterThanOrEqual(R.minMultiple * (1 - 1e-6));
          expect(g.mJobs[i]).toBeLessThanOrEqual(Jb.maxMultiple * (1 + 1e-6));
          expect(g.mJobs[i]).toBeGreaterThanOrEqual(Jb.minMultiple * (1 - 1e-6));
          const rr = g.mRes[i] / prevR[i] - 1, rj = g.mJobs[i] / prevJ[i] - 1;
          expect(rr).toBeLessThanOrEqual(k * R.maxGrowthPerMonth + 1e-6);
          expect(rr).toBeGreaterThanOrEqual(-k * R.maxDeclinePerMonth - 1e-6);
          expect(rj).toBeLessThanOrEqual(k * Jb.maxGrowthPerMonth + 1e-6);
          expect(rj).toBeGreaterThanOrEqual(-k * Jb.maxDeclinePerMonth - 1e-6);
        }
        const t = totals(g);
        expect(t.r).toBeLessThanOrEqual(GROWTH.cityMaxMultiple * g.total0 * (1 + 1e-6));
        expect(Math.abs(t.r - t.j) / t.r).toBeLessThan(1e-6);
        prevR = Float32Array.from(g.mRes);
        prevJ = Float32Array.from(g.mJobs);
      }
      // The best tract reached its long-run bound; on Boom the whole city is at its ceiling.
      expect(g.mRes[0]).toBeGreaterThan(R.maxMultiple * 0.99);
      if (pace === 'boom') expect(totals(g).r).toBeGreaterThan(GROWTH.cityMaxMultiple * g.total0 * 0.999);
      expect(g.history.length).toBeLessThanOrEqual(GROWTH.historyMax);
      expect(g.city.length).toBeLessThanOrEqual(GROWTH.cityMax);
    });
  }

  it('fitTotal water-fills to the total within bounds', () => {
    const next = Float64Array.from([10, 10, 10, 10]);
    const lo = Float64Array.from([9, 9, 9, 9]);
    const hi = Float64Array.from([10.5, 12, 12, 12]);
    fitTotal(next, lo, hi, 45);
    expect(next[0]).toBe(10.5);
    expect(Math.abs(sum(next) - 45)).toBeLessThan(1e-9);
    for (let i = 0; i < 4; i++) expect(next[i]).toBeLessThanOrEqual(hi[i]);
  });
});

describe('5. pace', () => {
  it('Off returns null and leaves the state unchanged; a month is applied once', () => {
    const g = new Growth(sixWorld(), 'off');
    const before = g.toData();
    expect(g.step(3, { home: new Float64Array(6).fill(50), work: new Float64Array(6).fill(50) }, [])).toBeNull();
    expect(g.toData()).toEqual(before);
    g.setPace('steady');
    expect(g.step(3, zeros(6), [])).not.toBeNull();
    expect(g.step(3, zeros(6), [])).toBeNull();
    expect(g.step(2, zeros(6), [])).toBeNull();
    expect(g.months).toBe(1);
  });

  it('Boom grows at least 2.5× Steady over 6 months when the bounds do not bind', () => {
    const run = (pace: GrowthPace) => {
      const g = new Growth(equalWorld(6), pace);
      const home = Float64Array.from([40, 20, 0, 0, 0, 0]);
      const work = Float64Array.from([30, 10, 0, 0, 0, 0]);
      for (let m = 0; m < 6; m++) g.step(m, { home, work }, []);
      return { top: g.mRes[0] - 1, city: totals(g).r / g.total0 - 1, premium: g.premium[0] };
    };
    const s = run('steady'), b = run('boom');
    expect(b.top).toBeGreaterThanOrEqual(2.5 * s.top);
    expect(b.city).toBeGreaterThanOrEqual(2.5 * s.city);
    expect(b.premium).toBeGreaterThan(s.premium);
  });
});

describe('6. determinism and the state round trip', () => {
  const pattern = (T: number, m: number) => ({
    home: Float64Array.from({ length: T }, (_, i) => ((hash32x4(i, m, 1, 0) % 100) / 100) * 40),
    work: Float64Array.from({ length: T }, (_, i) => ((hash32x4(i, m, 2, 0) % 100) / 100) * 30),
  });
  const served: StationPt[] = [
    { id: 7, x: 0, y: 0 },
    { id: 9, x: 3000, y: 0 },
  ];
  const same = (a: GrowthData, b: GrowthData) => {
    for (const k of ['mRes', 'mJobs', 'fHome', 'fWork', 'premium'] as const) expect(bytes(a[k]).equals(bytes(b[k]))).toBe(true);
    expect(a.months).toBe(b.months);
    expect(a.appliedThroughDay).toBe(b.appliedThroughDay);
    expect(a.sbar).toEqual(b.sbar);
    expect(a.city).toEqual(b.city);
    expect(a.history.length).toBe(b.history.length);
    a.history.forEach((h, i) => {
      expect(h.day).toBe(b.history[i].day);
      expect(bytes(h.q).equals(bytes(b.history[i].q))).toBe(true);
    });
  };

  it('identical inputs give byte-identical state and equal fingerprints; 12 straight = 6 + save/load + 6', () => {
    const world = equalWorld(10);
    const a = new Growth(world, 'steady'), b = new Growth(world, 'steady');
    for (let m = 0; m < 12; m++) {
      a.step(m * 21, pattern(10, m), served);
      b.step(m * 21, pattern(10, m), served);
    }
    same(a.toData(), b.toData());
    expect(a.fingerprint()).toBe(b.fingerprint());
    expect(a.fingerprint()).toMatch(/^g12:[0-9a-f]+$/);
    expect(a.factors()!.tag).toBe(a.fingerprint());

    const c = new Growth(world, 'steady');
    for (let m = 0; m < 6; m++) c.step(m * 21, pattern(10, m), served);
    // structuredClone is what crosses the worker boundary; the save codec must preserve the arrays as exactly.
    const d = Growth.fromData(world, structuredClone(c.toData()), 'steady');
    expect(d.dropped).toBe(false);
    for (let m = 6; m < 12; m++) d.step(m * 21, pattern(10, m), served);
    same(a.toData(), d.toData());
    expect(d.fingerprint()).toBe(a.fingerprint());
  });

  it('drops state that does not fit the world', () => {
    const g = new Growth(equalWorld(10), 'steady');
    g.step(0, pattern(10, 0), served);
    const other = Growth.fromData(equalWorld(9), g.toData(), 'steady');
    expect(other.dropped).toBe(true);
    expect(other.isIdentity()).toBe(true);
    expect(Growth.fromData(equalWorld(9), null).dropped).toBe(false);
  });
});

describe('7. Furness consistency on the real data', () => {
  for (const id of ['nyc', 'london'] as const) {
    it(`${id}: OD' row and column sums match the grown targets within 0.5% after 24 months`, () => {
      applyCity(id);
      const world = loadWorldFromDisk();
      const T = world.tracts.length;
      const g = new Growth(world, 'steady');
      // Tract sums equal tracts.json (the OD row and column sums).
      for (let i = 0; i < T; i++) {
        expect(g.R0[i]).toBe(world.tracts[i].residents);
        expect(g.J0[i]).toBe(world.tracts[i].jobs);
      }
      const core = new Set(id === 'nyc' ? ['Manhattan', 'Queens'] : CITY_BALANCE.london.coreRegions);
      const b = Float64Array.from(world.tracts, (t, i) => (core.has(t.borough) ? (40 * (hash32x4(i, 0, 0, 0) % 100)) / 100 : 0));
      for (let m = 0; m < 24; m++) g.step(m, { home: b, work: b }, []);
      const od = g.odSums();
      let worstR = 0, worstJ = 0;
      for (let i = 0; i < T; i++) {
        if (g.R0[i] + g.J0[i] < 100) continue;
        if (g.R0[i] > 0) worstR = Math.max(worstR, Math.abs(od.home[i] / g.residents(i) - 1));
        if (g.J0[i] > 0) worstJ = Math.max(worstJ, Math.abs(od.work[i] / g.jobs(i) - 1));
      }
      expect(worstR).toBeLessThan(0.005);
      expect(worstJ).toBeLessThan(0.005);
      const { r, j } = totals(g);
      expect(Math.abs(sum(od.home) - j) / j).toBeLessThan(1e-6);
      expect(Math.abs(r - j) / r).toBeLessThan(1e-6);
      // The city grew, served tracts more than the rest; zero-job tracts stayed empty.
      expect(r).toBeGreaterThan(g.total0);
      let inS = 0, inN = 0, outS = 0, outN = 0;
      for (let i = 0; i < T; i++) {
        if (b[i] > 20) {
          inS += g.mRes[i];
          inN++;
        } else if (b[i] === 0) {
          outS += g.mRes[i];
          outN++;
        }
        if (g.J0[i] === 0) expect(od.work[i]).toBe(0);
      }
      expect(inS / inN).toBeGreaterThan(outS / outN);
      applyCity('nyc');
    });
  }
});

describe('8. value capture', () => {
  // Tract 0 at the station; tract 1 straddles the district edge; tract 2 well outside; tract 3 at the station but shrinking.
  const world = () =>
    synthWorld(
      [
        { x: 0, y: 0, radius: 300 },
        { x: 800, y: 0, radius: 300 },
        { x: 3000, y: 0, radius: 300 },
        { x: 0, y: 200, radius: 300 },
      ],
      [0, 1, 2, 3].flatMap((h) => [0, 1, 2, 3].map((w) => ({ h, w, se: [50, 50, 50] as [number, number, number] }))),
    );
  const station: StationPt[] = [{ id: 42, x: 0, y: 0 }];

  it('no served station: nothing paid, empty district', () => {
    const g = new Growth(world(), 'steady');
    g.step(0, { home: Float64Array.from([60, 60, 0, 0]), work: Float64Array.from([60, 60, 0, 0]) }, []);
    const vc = g.valueCapture([]);
    expect(vc.total).toBe(0);
    expect(vc.tracts).toBe(0);
    expect(sum(vc.district)).toBe(0);
    expect(g.view([]).projectedValueCapture).toBe(0);
  });

  it('one station: only area within the radius counts, the levy sums by station, and decline pays nothing', () => {
    const g = new Growth(world(), 'steady');
    const home = Float64Array.from([60, 60, 60, 0]), work = Float64Array.from([60, 60, 60, 0]);
    let rep = null;
    for (let m = 0; m < 6; m++) rep = g.step(m, { home, work }, station)!;
    expect(g.mRes[3]).toBeLessThan(1);
    const vc = g.valueCapture(station);
    expect(vc.share[0]).toBe(1);
    expect(vc.share[1]).toBeGreaterThan(0.3);
    expect(vc.share[1]).toBeLessThan(0.7);
    expect(vc.district[2]).toBe(0);
    expect(vc.share[3]).toBe(1);
    expect(vc.levy[3]).toBe(0);
    expect(vc.levy[0]).toBeGreaterThan(0);
    expect(vc.tracts).toBe(3);
    expect(Math.abs(vc.byStation[42] - vc.total)).toBeLessThan(1e-9 * vc.total);
    expect(vc.nearest[0]).toBe(0);
    expect(vc.nearest[2]).toBe(-1);
    expect(g.tract(2, station, { home, work }).nearestStation).toBe(42);
    expect(g.tract(2, station, { home, work }).inDistrict).toBe(false);
    expect(g.tract(1, station, { home, work }).levy).toBeCloseTo(vc.levy[1], 9);
    expect(rep!.valueCapture).toBeCloseTo(vc.total, 6);
    expect(rep!.stationLevy[42]).toBeCloseTo(vc.total, 6);
    // The levy is captureShare of a month of tax on the increment, scaled by the district share.
    const V = VALUE_CAPTURE;
    const p = 1 + g.premium[1];
    const inc = V.taxRateHomes * V.valuePerResident * g.R0[1] * (g.mRes[1] * p - 1) + V.taxRateJobs * V.valuePerJob * g.J0[1] * (g.mJobs[1] * p - 1);
    expect(vc.levy[1]).toBeCloseTo((V.captureShare / 12) * vc.share[1] * inc, 6);
    expect(DISTRICT_SAMPLES * vc.share[1]).toBe(Math.round(DISTRICT_SAMPLES * vc.share[1]));
  });

  it('the premium approaches premiumMax × attractiveness geometrically at premiumLagPerMonth', () => {
    const g = new Growth(world(), 'steady');
    const b = Float64Array.from([20, 20, 20, 20]);
    const s = attractiveness(20);
    expect(s).toBeCloseTo(20 / (20 + GROWTH.halfBenefit), 12);
    for (let n = 1; n <= 10; n++) {
      g.step(n, { home: b, work: b }, station);
      const target = VALUE_CAPTURE.premiumMax * s * (1 - (1 - VALUE_CAPTURE.premiumLagPerMonth) ** n);
      expect(Math.abs(g.premium[0] - target)).toBeLessThan(1e-6);
    }
  });

  it('servedStations keeps stations some running route stops at', () => {
    const dir = (stops: number[]) => ({ stopStation: Int32Array.from(stops) }) as unknown as CompiledNetwork['routes'][number]['dirs'][0];
    const net = {
      version: 1,
      stations: [0, 1, 2, 3].map((i) => ({ id: 10 + i, x: i * 100, y: 0, name: `S${i}`, group: i })),
      routes: [
        { fleet: 3, headways: [0, 300, 600, 300, 600], dirs: [dir([0, 1]), dir([1, 0])] },
        { fleet: 2, headways: [0, 0, 0, 0, 0], dirs: [dir([2, 3]), dir([3, 2])] },
      ],
      trackCount: 0,
      lockCount: 0,
    } as unknown as CompiledNetwork;
    expect(servedStations(net).map((s) => s.id)).toEqual([10, 11]);
    expect(servedStations(null)).toEqual([]);
  });
});

describe('9. history thinning', () => {
  it('keeps at most historyMax snapshots with the first and latest months', () => {
    const g = new Growth(sixWorld(), 'steady');
    const b = { home: Float64Array.from([30, 10, 0, 0, 5, 0]), work: Float64Array.from([20, 0, 0, 5, 0, 0]) };
    for (let m = 0; m < 100; m++) g.step(100 + m * 21, b, []);
    expect(g.history.length).toBeLessThanOrEqual(GROWTH.historyMax);
    expect(g.history.length).toBe(GROWTH.historyMax);
    for (let i = 1; i < g.history.length; i++) expect(g.history[i].day).toBeGreaterThan(g.history[i - 1].day);
    expect(g.history[0].day).toBe(100);
    expect(g.history.at(-1)!.day).toBe(100 + 99 * 21);
    expect(g.city.length).toBe(100);
    // The last snapshot is the current state, quantised.
    const q = g.history.at(-1)!.q;
    expect(q[0]).toBe(Math.round(g.mRes[0] * 10000));
    expect(q[6 + 1]).toBe(Math.round(g.mJobs[1] * 10000));
    const tg = g.tract(0, [], b);
    expect(tg.history.length).toBe(GROWTH.historyMax);
    expect(tg.history.at(-1)!.residents).toBeCloseTo(g.residents(0), 0);
  });
});

describe('Living City per city', () => {
  it('applyCity restores the New York defaults and applies London values', () => {
    applyCity('nyc');
    const nycG = structuredClone(GROWTH), nycV = structuredClone(VALUE_CAPTURE);
    applyCity('london');
    expect(GROWTH.cityGrowthPerYear).toBeGreaterThanOrEqual(0.01);
    expect(GROWTH.cityGrowthPerYear).toBeLessThanOrEqual(0.012);
    expect(VALUE_CAPTURE.districtRadius).toBe(800);
    expect(VALUE_CAPTURE.taxRateJobs).toBeGreaterThan(VALUE_CAPTURE.taxRateHomes);
    GROWTH.residents.boostPerMonth = 99; // a stray mutation must not leak into the next city
    applyCity('nyc');
    expect(GROWTH).toEqual(nycG);
    expect(VALUE_CAPTURE).toEqual(nycV);
    expect(VALUE_CAPTURE.districtRadius).toBe(800);
  });

  it('London: the OD is sorted by home then work (the regeneration merge-join needs it) and every zone has jobs', () => {
    applyCity('london');
    const w = loadWorldFromDisk();
    let viol = 0;
    for (let i = 1; i < w.od.pairCount; i++) {
      const a = w.od.home[i - 1] * 65536 + w.od.work[i - 1], b = w.od.home[i] * 65536 + w.od.work[i];
      if (b <= a) viol++;
    }
    expect(viol).toBe(0);
    expect(w.tracts.filter((t) => t.jobs === 0).length).toBe(0);
    // Every MSOA is big enough for reports and goals.
    expect(Math.min(...w.tracts.map((t) => t.residents + t.jobs))).toBeGreaterThanOrEqual(GROWTH.minTractPeople);
    applyCity('nyc');
  });

  for (const id of ['nyc', 'london'] as const) {
    it(`${id}: a station's district covers about the 800 m disc, whatever the zone size`, () => {
      applyCity(id);
      const world = loadWorldFromDisk();
      const g = new Growth(world, 'steady');
      // Stations at the core's densest point and two others 3 km away (all on land in both cities).
      const c = id === 'nyc' ? [-73.9855, 40.758] : [-0.0886, 51.5133];
      const pts = [c, [c[0] + 0.03, c[1] + 0.01], [c[0] - 0.02, c[1] - 0.02]];
      for (const [lon, lat] of pts) {
        const tr = world.tracts.reduce((best, t) => (Math.hypot(t.lon - lon, t.lat - lat) < Math.hypot(best.lon - lon, best.lat - lat) ? t : best));
        const vc = g.valueCapture([{ id: 1, x: tr.x, y: tr.y }]);
        let area = 0;
        for (let i = 0; i < g.T; i++) area += vc.share[i] * world.tracts[i].areaKm2;
        const disc = (Math.PI * VALUE_CAPTURE.districtRadius ** 2) / 1e6;
        // Tract discs only approximate the real zones (gaps and overlaps), so within a factor of two.
        expect(area).toBeGreaterThan(0.5 * disc);
        expect(area).toBeLessThan(2 * disc);
      }
      applyCity('nyc');
    });
  }
});
