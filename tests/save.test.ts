/**
 * Save v5 (Living City, docs/v2/living-city.md §12 tests 17–18): the v4 → v5 migration (and v1 all
 * the way), the growth state's encoding, the pace in a round trip, and malformed growth reaching
 * the worker's reset path.
 */
import { describe, expect, it } from 'vitest';
import { GROWTH } from '../src/balance';
import { Game } from '../src/core/game';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { toLonLat } from '../src/core/geo';
import { encodeOD } from '../src/data/odFormat';
import type { TractsFile } from '../src/data/types';
import { buildWorld } from '../src/data/world';
import { SAVE_VERSION, b64ToU16, bytesToB64 } from '../src/save/format';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave, decodeGrowth, encodeGrowth } from '../src/save/serialize';
import { Growth } from '../src/sim/growth';
import type { GrowthData } from '../src/sim/protocol';

const settings = { units: 'metric' as const, agentScale: 10, seed: 1885 };
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/** A v4 save as the code before Living City wrote it, from a real game. */
function v4Save() {
  const game = new Game({} as World, {} as Terrain, { sandbox: false, chaos: 'normal', chaosSeed: 9 });
  game.finance.settleDay({ day: 0, riders: 1000, revenue: 3000, carKm: 10, stationsOpen: 2 });
  const save = JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: { 'first-line': 3 } as never, lastReport: null, tutorialDone: true, settings, modeState: null })));
  save.version = 4;
  delete save.game.growthPace;
  delete save.growth;
  for (const h of [...save.game.finance.history, save.game.finance.today]) delete h.valueCapture;
  save.game.finance.months = [{ key: '2030-01', label: 'Jan 2030', days: 19, revenue: 50e6, operatingCosts: 30e6, capital: 0, bondPayments: 0, profit: 20e6, riders: 1e6, cashEnd: 5e9, interest: 0, fees: 0, prepaid: 0, debtEnd: 0 }];
  return save;
}

/** A six-tract growth state with every field non-trivial. */
function sampleGrowth(): GrowthData {
  const T = 6;
  const f = (k: number) => Float32Array.from({ length: T }, (_, i) => Math.fround(1 + 0.01 * (i + k) + 1e-7 * i));
  return {
    version: 1,
    appliedThroughDay: 40,
    months: 2,
    mRes: f(1),
    mJobs: f(2),
    fHome: f(3),
    fWork: f(4),
    premium: Float32Array.from({ length: T }, (_, i) => Math.fround(0.001 * i)),
    sbar: [0.12345678901, 0.0456],
    history: [
      { day: 18, q: Uint16Array.from({ length: 2 * T }, (_, i) => 10000 + i) },
      { day: 40, q: Uint16Array.from({ length: 2 * T }, (_, i) => 10050 + 3 * i) },
    ],
    city: [
      { day: 18, residents: 2853194.25, jobs: 2853194.25, valueCapture: 885123.5 },
      { day: 40, residents: 2856000.5, jobs: 2856000.5, valueCapture: 1.75e6 },
    ],
  };
}

describe('17. migration v4 → v5', () => {
  it('a v4 save joins Living City on Steady with zero value capture and no growth; idempotent', () => {
    const m = migrate(v4Save());
    // (v6 since express service: its step runs on the way.)
    expect(SAVE_VERSION).toBe(6);
    expect(m.version).toBe(6);
    expect(m.migratedFrom).toBe(4);
    expect(m.growth).toBeNull();
    expect(m.game.growthPace).toBe('steady');
    const fin = m.game.finance;
    expect(fin.history.map((h) => h.valueCapture)).toEqual([0]);
    expect(fin.months.map((x) => x.valueCapture)).toEqual([0]);
    expect(fin.today.valueCapture).toBe(0);
    expect(m.game.goals).toMatchObject({ 'first-line': 3, boomtown: null, 'value-capture': null });
    const again = migrate(JSON.parse(JSON.stringify({ ...m, migratedFrom: undefined })));
    expect(again.game).toEqual(m.game);
    expect(again.growth).toBeNull();
    // A player who turned growth off keeps it off.
    const off = v4Save();
    off.game.growthPace = 'off';
    expect(migrate(off).game.growthPace).toBe('off');
  });

  it('a v1 save still migrates all the way', () => {
    const m = migrate({ format: 'headway-ny', goals: { a: 1 }, game: { network: {}, routes: {}, finance: { history: [{ day: 0 }], months: [] } } });
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.growth).toBeNull();
    expect(m.game.growthPace).toBe('steady');
    expect(m.game.finance.history[0].valueCapture).toBe(0);
    expect(m.game.chaos.level).toBe('normal');
  });
});

describe('18. growth encoding', () => {
  it('decodeGrowth(encodeGrowth(d)) reproduces every typed array and the city rows; a round trip keeps growth and pace', () => {
    const d = sampleGrowth();
    const s = JSON.parse(JSON.stringify(encodeGrowth(d)));
    const back = decodeGrowth(s);
    for (const k of ['mRes', 'mJobs', 'fHome', 'fWork', 'premium'] as const) {
      expect(back[k]).toBeInstanceOf(Float32Array);
      expect(bytes(back[k]).equals(bytes(d[k]))).toBe(true);
    }
    expect(back.history.map((h) => h.day)).toEqual([18, 40]);
    back.history.forEach((h, i) => {
      expect(h.q).toBeInstanceOf(Uint16Array);
      expect(bytes(h.q).equals(bytes(d.history[i].q))).toBe(true);
    });
    expect(back.city).toEqual(d.city);
    expect(back.sbar).toEqual(d.sbar);
    expect([back.months, back.appliedThroughDay, back.version]).toEqual([2, 40, 1]);
    expect(bytes(b64ToU16(bytesToB64(d.history[1].q))).equals(bytes(d.history[1].q))).toBe(true);
    // applySave(buildSave(…)) returns the same growth and pace.
    const game = new Game({} as World, {} as Terrain, { sandbox: false });
    game.growthPace = 'boom';
    const file = migrate(JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: null, growth: d }))));
    expect(file.game.growthPace).toBe('boom');
    const loaded = new Game({} as World, {} as Terrain, { sandbox: false });
    expect(loaded.growthPace).toBe(GROWTH.defaultPace);
    const r = applySave(loaded, file);
    expect(loaded.growthPace).toBe('boom');
    expect(r.growth).not.toBeNull();
    expect(bytes(r.growth!.fHome).equals(bytes(d.fHome))).toBe(true);
    expect(r.growth!.city).toEqual(d.city);
    // The starting city saves no growth.
    const plain = buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: null });
    expect(plain.growth).toBeNull();
    expect(applySave(new Game({} as World, {} as Terrain, { sandbox: false }), migrate(JSON.parse(JSON.stringify(plain)))).growth).toBeNull();
  });

  it('malformed or mismatched growth decodes without throwing and is dropped by the worker (the reset toast)', () => {
    const s = JSON.parse(JSON.stringify(encodeGrowth(sampleGrowth())));
    s.fHome = 'abc'; // 2 bytes: not a Float32Array
    s.history[0].q = 42;
    const d = decodeGrowth(s);
    expect(d.fHome.length).toBe(0);
    expect(d.history[0].q.length).toBe(0);
    // A six-tract world accepts the sample and rejects the broken copy.
    const n = 6;
    const rows: { h: number; w: number; se: [number, number, number] }[] = [];
    for (let h = 0; h < n; h++) for (let w = 0; w < n; w++) rows.push({ h, w, se: [10, 20, 30] });
    const file: TractsFile = {
      version: 1,
      synthetic: true,
      year: 2023,
      source: 'save test',
      bands: ['a', 'b', 'c'],
      tracts: Array.from({ length: n }, (_, i) => {
        const [lon, lat] = toLonLat(i * 1000, 0);
        return { id: `T${i}`, borough: 'Manhattan', lat, lon, radius: 200, residents: 360, jobs: 360 };
      }),
    };
    const bin = encodeOD(n, rows);
    const world = buildWorld(file, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
    const ok = Growth.fromData(world, decodeGrowth(JSON.parse(JSON.stringify(encodeGrowth(sampleGrowth())))));
    expect(ok.dropped).toBe(false);
    expect(ok.months).toBe(2);
    const bad = Growth.fromData(world, d);
    expect(bad.dropped).toBe(true);
    expect(bad.isIdentity()).toBe(true);
  });
});
