/**
 * Living City agent regeneration (docs/v2/living-city.md §12, tests 10–12, with amendment 3's
 * placement rule): group rounding with common random numbers, the starting city exactly as before
 * Living City, regeneration equal to a from-scratch build (groups, agents, key) in both cities,
 * carry-over of shares and observations, CRN monotonicity, and the Map fallback of the merge-join
 * for unsorted data.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { COMMUTERS, EVENTS, FARES } from '../src/balance';
import { applyCity } from '../src/cities';
import { pointInDisc, Rng } from '../src/core/rng';
import { toLonLat } from '../src/core/geo';
import { encodeOD } from '../src/data/odFormat';
import type { TractsFile } from '../src/data/types';
import { buildWorld, type World } from '../src/data/world';
import { defaultFares, isPeakTod } from '../src/economy/fares';
import { buildGroups, Commuters, groupKeys, makeKey, matchGroups } from '../src/sim/commuters';
import type { OdFactors } from '../src/sim/growth';
import { originCdf } from '../src/sim/eventTrips';
import { loadWorldFromDisk } from '../scripts/nodeData';

afterAll(() => {
  applyCity('nyc');
});

const SEED = 1885;

/**
 * Agent generation exactly as before Living City (commuters.ts at the pre-living tag): one
 * rounding draw per non-zero cell, then every agent's place and times from the same stream.
 */
function v1Generation(world: World, scale: number, seed: number) {
  const od = world.od;
  const tr = world.tracts;
  const gen = new Rng(seed * 7919 + 13);
  const gh: number[] = [], gw: number[] = [], gb: number[] = [], gc: number[] = [];
  for (let i = 0; i < od.pairCount; i++) {
    for (let b = 0; b < 3; b++) {
      const c = od.counts[b][i];
      if (!c) continue;
      const exact = c / scale;
      let n = Math.floor(exact);
      if (gen.next() < exact - n) n++;
      if (n === 0) continue;
      gh.push(od.home[i]);
      gw.push(od.work[i]);
      gb.push(b);
      gc.push(n);
    }
  }
  const G = gh.length;
  const start = new Int32Array(G + 1);
  for (let g = 0; g < G; g++) start[g + 1] = start[g] + gc[g];
  const A = start[G];
  const aHx = new Float32Array(A), aHy = new Float32Array(A), aWx = new Float32Array(A), aWy = new Float32Array(A);
  const aDepart = new Float32Array(A), aReturn = new Float32Array(A), aPeak = new Uint8Array(A);
  for (let g = 0; g < G; g++) {
    const h = tr[gh[g]], w = tr[gw[g]];
    for (let a = start[g]; a < start[g + 1]; a++) {
      const [hx, hy] = pointInDisc(gen, h.x, h.y, h.radius);
      const [wx, wy] = pointInDisc(gen, w.x, w.y, w.radius);
      aHx[a] = hx;
      aHy[a] = hy;
      aWx[a] = wx;
      aWy[a] = wy;
      const dep = COMMUTERS.departMean + gen.normal() * COMMUTERS.departSd;
      aDepart[a] = Math.max(COMMUTERS.departMin, Math.min(COMMUTERS.departMax, dep));
      aReturn[a] = COMMUTERS.workDuration + (gen.next() * 2 - 1) * COMMUTERS.returnJitter;
      aPeak[a] = (isPeakTod(aDepart[a]) ? 1 : 0) | (isPeakTod(aDepart[a] + FARES.amTripEstimate + aReturn[a]) ? 2 : 0);
    }
  }
  return { G, A, home: Int32Array.from(gh), work: Int32Array.from(gw), band: Uint8Array.from(gb), count: Int32Array.from(gc), aHx, aHy, aWx, aWy, aDepart, aReturn, aPeak };
}

const AGENT_FIELDS = ['aHx', 'aHy', 'aWx', 'aWy', 'aDepart', 'aReturn', 'aGroup', 'aBand', 'aPeak'] as const;
const GROUP_FIELDS = ['gHome', 'gWork', 'gBand', 'gCount', 'gStart', 'gWalk', 'gDrive', 'gDriveHome', 'gPeakFrac'] as const;
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/** Factors as Growth stores them (Float32): 1.03 on 50 tracts, 0.98 on 50 others (test 10's f1). */
function testFactors(T: number, tag: string, salt = 0): OdFactors {
  const home = new Float32Array(T).fill(1), work = new Float32Array(T).fill(1);
  for (let i = 0; i < 50; i++) home[(i * 37 + salt) % T] = Math.fround(1.03);
  for (let i = 0; i < 50; i++) work[(i * 53 + 11 + salt) % T] = Math.fround(0.98);
  return { home, work, tag };
}

/** Every new group's agents and every group array equal the from-scratch build's, byte for byte. */
function expectSameGeneration(a: Commuters, b: Commuters) {
  expect(a.G).toBe(b.G);
  expect(a.A).toBe(b.A);
  expect(a.key).toBe(b.key);
  for (const f of GROUP_FIELDS) expect(bytes(a[f]).equals(bytes(b[f])), f).toBe(true);
  for (const f of AGENT_FIELDS) expect(bytes(a[f]).equals(bytes(b[f])), f).toBe(true);
  expect(a.baseline).toBe(b.baseline);
}

describe('11. the starting city is exactly the city before Living City', () => {
  it('New York: groups, agents (v1’s sequential stream) and the key match the pre-living generation', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const c = new Commuters(world, { agentScale: 10, seed: SEED, fares: defaultFares(), factors: null });
    const v1 = v1Generation(world, 10, SEED);
    expect(c.G).toBe(v1.G);
    expect(c.A).toBe(v1.A);
    expect(c.key).toBe(`${world.meta.source}|${world.tracts.length}|${world.od.pairCount}|10|${SEED}|${v1.A}|${v1.G}`);
    expect(c.key).toBe(makeKey(world, 10, SEED, v1.A, v1.G));
    expect(bytes(c.gHome).equals(bytes(v1.home))).toBe(true);
    expect(bytes(c.gWork).equals(bytes(v1.work))).toBe(true);
    expect(bytes(c.gBand).equals(bytes(v1.band))).toBe(true);
    expect(bytes(c.gCount).equals(bytes(v1.count))).toBe(true);
    for (const f of ['aHx', 'aHy', 'aWx', 'aWy', 'aDepart', 'aReturn', 'aPeak'] as const) expect(bytes(c[f].subarray(0, c.A)).equals(bytes(v1[f])), f).toBe(true);
    // buildGroups with no factors is the same table.
    const tbl = buildGroups(world.od, world.tracts.length, 10, SEED, null);
    expect(tbl.G).toBe(v1.G);
    expect(tbl.A).toBe(v1.A);
    expect(tbl.sorted).toBe(true);
    expect(bytes(tbl.count).equals(bytes(v1.count))).toBe(true);
    // The event pool sits after the commuters in every agent array.
    expect(c.aHx.length).toBe(c.A + c.poolCap);
    expect(c.aState.length).toBeGreaterThanOrEqual(c.A + c.poolCap);
  });
});

describe('10. regeneration equals a from-scratch build (real data, scale 10)', () => {
  for (const id of ['nyc', 'london'] as const) {
    it(`${id === 'nyc' ? 'New York' : 'London'}: identity → f1 (all agents re-placed once) → f2 (kept agents copied) equals new Commuters(f2)`, () => {
      applyCity(id);
      const world = loadWorldFromDisk();
      const T = world.tracts.length;
      const f1 = testFactors(T, 'g1:test');
      const f2 = testFactors(T, 'g2:test', 7);
      for (let i = 0; i < 80; i++) f2.home[(i * 29 + 5) % T] = Math.fround(1.05);
      const a = new Commuters(world, { agentScale: 10, seed: SEED, fares: defaultFares() });
      const s1 = a.regenerate(f1, 0);
      expect(s1.replaced).toBe(true);
      expectSameGeneration(a, new Commuters(world, { agentScale: 10, seed: SEED, fares: defaultFares(), factors: f1 }));
      const s2 = a.regenerate(f2, 0);
      expect(s2.replaced).toBe(false);
      expect(s2.kept).toBeGreaterThan(0.95 * s2.groups);
      const b = new Commuters(world, { agentScale: 10, seed: SEED, fares: defaultFares(), factors: f2 });
      expectSameGeneration(a, b);
      expect(a.key.endsWith('|g2:test')).toBe(true);
      // Agent arrays hold the commuters plus the event pool (trip state may keep room for growth).
      for (const f of ['aHx', 'aHy', 'aWx', 'aWy', 'aDepart', 'aReturn', 'aGroup', 'aBand', 'aPeak'] as const) expect(a[f].length).toBe(a.A + a.poolCap);
      for (const f of ['aState', 'aPlat', 'aMode', 'aBoarded', 'aTripStart'] as const) expect(a[f].length).toBeGreaterThanOrEqual(a.A + a.poolCap);
      expect(a.aLegs.length).toBeGreaterThanOrEqual((a.A + a.poolCap) * 15);
    });
  }
});

describe('event-goers follow the grown city', () => {
  it('originCdf weighs tracts by the given current residents (tracts.json’s without them)', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const tr = world.tracts;
    const [vx, vy] = [tr[100].x, tr[100].y];
    const plain = originCdf(tr, vx, vy);
    expect(Array.from(originCdf(tr, vx, vy, EVENTS.originDecay, Float64Array.from(tr, (t) => t.residents)))).toEqual(Array.from(plain));
    // Doubling one tract's residents doubles its weight in the CDF.
    const w = Float64Array.from(tr, (t) => t.residents);
    w[100] *= 2;
    const grown = originCdf(tr, vx, vy, EVENTS.originDecay, w);
    const step = (c: Float64Array, i: number) => c[i] - (i ? c[i - 1] : 0);
    expect(step(grown, 100)).toBeCloseTo(2 * step(plain, 100), 6);
    expect(step(grown, 50)).toBeCloseTo(step(plain, 50), 9);
  });
});

describe('12. carry-over', () => {
  it('kept groups keep their shares and observations, every group’s shares sum to 1; CRN counts are monotone; A ≈ Σ OD′/scale', () => {
    applyCity('nyc');
    const world = loadWorldFromDisk();
    const T = world.tracts.length;
    const a = new Commuters(world, { agentScale: 10, seed: SEED, fares: defaultFares() });
    // Give the groups distinctive state to carry.
    const rng = new Rng(3);
    for (let g = 0; g < a.G; g++) {
      const p = [rng.next(), rng.next(), rng.next()];
      const s = p[0] + p[1] + p[2];
      for (let m = 0; m < 3; m++) a.shares[g * 3 + m] = p[m] / s;
      a.obsTime[g] = rng.next() * 3000;
      a.obsCrowd[g] = rng.next() * 5;
    }
    const oldKeys = groupKeys(a.gHome, a.gWork, a.gBand, a.G, T);
    const oldShares = a.shares.slice(), oldObs = a.obsTime.slice(), oldCrowd = a.obsCrowd.slice(), oldCount = a.gCount.slice();
    // f1 ≥ f0 = 1 everywhere: no group loses agents.
    const f1: OdFactors = { home: new Float32Array(T).fill(1), work: new Float32Array(T).fill(1), tag: 'g1:up' };
    for (let i = 0; i < T; i += 7) f1.home[i] = Math.fround(1.04);
    for (let i = 3; i < T; i += 11) f1.work[i] = Math.fround(1.02);
    a.regenerate(f1, 0);
    const m = matchGroups(oldKeys, groupKeys(a.gHome, a.gWork, a.gBand, a.G, T), true);
    // (Counted, then checked once: an expect per group would take minutes.)
    let matched = 0, badSum = 0, badShare = 0, badObs = 0, fewer = 0;
    for (let g = 0; g < a.G; g++) {
      const o = m.exact[g];
      const s = a.shares[g * 3] + a.shares[g * 3 + 1] + a.shares[g * 3 + 2];
      if (!(Math.abs(s - 1) < 1e-5)) badSum++;
      if (o < 0) continue;
      matched++;
      for (let k = 0; k < 3; k++) if (a.shares[g * 3 + k] !== oldShares[o * 3 + k]) badShare++;
      if (a.obsTime[g] !== oldObs[o] || a.obsCrowd[g] !== oldCrowd[o]) badObs++;
      if (a.gCount[g] < oldCount[o]) fewer++;
    }
    expect({ badSum, badShare, badObs, fewer }).toEqual({ badSum: 0, badShare: 0, badObs: 0, fewer: 0 });
    // Every old group is still there (counts only rise), and some new ones joined.
    expect(matched).toBe(oldCount.length);
    expect(a.G).toBeGreaterThan(matched);
    // A is the rounding of Σ OD′ / scale.
    let exact = 0;
    const od = world.od;
    for (let p = 0; p < od.pairCount; p++) exact += ((od.counts[0][p] + od.counts[1][p] + od.counts[2][p]) * f1.home[od.home[p]] * f1.work[od.work[p]]) / 10;
    expect(Math.abs(a.A - exact)).toBeLessThan(4 * Math.sqrt(a.A));
  });

  it('unsorted data falls back to a Map join with the same result', () => {
    // A small synthetic city whose OD rows are shuffled (custom data).
    const n = 6;
    const rows: { h: number; w: number; se: [number, number, number] }[] = [];
    const r = new Rng(11);
    for (let h = 0; h < n; h++) for (let w = 0; w < n; w++) rows.push({ h, w, se: [r.int(60), r.int(60), r.int(60)] });
    const shuffled = rows.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const res = new Array(n).fill(0), jobs = new Array(n).fill(0);
    for (const x of rows) {
      res[x.h] += x.se[0] + x.se[1] + x.se[2];
      jobs[x.w] += x.se[0] + x.se[1] + x.se[2];
    }
    const file: TractsFile = {
      version: 1,
      synthetic: true,
      year: 2023,
      source: 'shuffled test',
      bands: ['a', 'b', 'c'],
      tracts: Array.from({ length: n }, (_, i) => {
        const [lon, lat] = toLonLat(i * 900, 0);
        return { id: `T${i}`, borough: 'Manhattan', lat, lon, radius: 250, residents: res[i], jobs: jobs[i] };
      }),
    };
    const bin = encodeOD(n, shuffled);
    const world = buildWorld(file, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
    expect(buildGroups(world.od, n, 1, SEED, null).sorted).toBe(false);
    const f: OdFactors = { home: Float32Array.from([1.2, 1, 0.9, 1.1, 1, 1.3].map(Math.fround)), work: Float32Array.from([1, 1.1, 1, 0.8, 1, 1].map(Math.fround)), tag: 'g1:x' };
    const a = new Commuters(world, { agentScale: 1, seed: SEED, fares: defaultFares() });
    a.shares.fill(1 / 3);
    a.regenerate(f, 0);
    expectSameGeneration(a, new Commuters(world, { agentScale: 1, seed: SEED, fares: defaultFares(), factors: f }));
    // The Map join finds the same matches as a sorted merge-join would.
    const ka = Float64Array.from([3, 5, 9, 10, 11, 20]);
    const kb = Float64Array.from([5, 6, 9, 11, 21]);
    const sortedM = matchGroups(ka, kb, true), mapM = matchGroups(ka, kb, false);
    expect(Array.from(sortedM.exact)).toEqual([1, -1, 2, 4, -1]);
    expect(Array.from(mapM.exact)).toEqual(Array.from(sortedM.exact));
    // Same pair (key ÷ 3), another band: 6 ↔ 6..8 has none; 21 ↔ 20 (pair 7 → none: 20 is pair 6); 10 and 11 are pair 3 with 9.
    expect(sortedM.pair[1]).toBe(-1);
    expect(matchGroups(Float64Array.from([9, 10]), Float64Array.from([11]), true).pair[0]).toBeGreaterThanOrEqual(0);
    expect(matchGroups(Float64Array.from([9, 10]), Float64Array.from([11]), false).pair[0]).toBe(0);
  });
});
