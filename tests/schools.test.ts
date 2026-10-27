/**
 * Real schools: the committed schools.json files (scripts/build-schools.ts) for every map, and the
 * spatial index the station panel and hover use.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CITY_BALANCE } from '../src/balance';
import { applyCity, CITY_IDS, city } from '../src/cities';
import { toLocal } from '../src/core/geo';
import { SCHOOL_KINDS, SchoolIndex, type SchoolsFile } from '../src/data/schools';

afterAll(() => {
  applyCity('nyc');
});

const load = (): SchoolsFile => JSON.parse(readFileSync(join(__dirname, '..', 'public', city().dataPath, 'schools.json'), 'utf8')) as SchoolsFile;

/** Fewest schools each map should have (England's census, NYC DOE buildings). */
const MIN: Record<string, number> = { nyc: 1500, london: 2500, southeast: 6000, manchester: 900, birmingham: 900, leeds: 800, bristol: 350 };

describe('schools data', () => {
  for (const id of CITY_IDS) {
    it(`${id}: real, named schools inside the map, with pupils`, () => {
      applyCity(id);
      const f = load();
      expect(f.schools.length).toBeGreaterThan(MIN[id]);
      const [w, s, e, n] = (city().id === 'nyc' ? [-74.3, 40.45, -73.65, 40.95] : CITY_BALANCE[id].map.bounds) as number[];
      let withPupils = 0;
      for (const sc of f.schools) {
        expect(sc.n.trim().length).toBeGreaterThan(2);
        expect(SCHOOL_KINDS).toContain(sc.k);
        expect(sc.lon).toBeGreaterThan(w);
        expect(sc.lon).toBeLessThan(e);
        expect(sc.lat).toBeGreaterThan(s);
        expect(sc.lat).toBeLessThan(n);
        expect(sc.s).toBeLessThanOrEqual(sc.p + 1);
        if (sc.p > 0) withPupils++;
      }
      expect(withPupils / f.schools.length).toBeGreaterThan(0.9);
      expect(f.source.length).toBeGreaterThan(10);
    });
  }

  it('London has its well-known schools', () => {
    applyCity('london');
    const names = new Set(load().schools.map((s) => s.n));
    expect(names.has('The Aldgate School')).toBe(true);
    const secondaries = load().schools.filter((s) => s.k === 'secondary');
    expect(secondaries.length).toBeGreaterThan(400);
  });
});

describe('school index', () => {
  it('finds schools near a point, nearest first, within the radius', () => {
    applyCity('london');
    const all = load().schools.map((s, i) => {
      const [x, y] = toLocal(s.lon, s.lat);
      return { ...s, x, y, i };
    });
    const idx = new SchoolIndex(all);
    // Around Bank: several schools within 1.5 km, sorted by distance, none beyond.
    const [bx, by] = toLocal(-0.0886, 51.5133);
    const hits = idx.near(bx, by, 1500);
    expect(hits.length).toBeGreaterThan(3);
    for (let i = 1; i < hits.length; i++) expect(hits[i].d).toBeGreaterThanOrEqual(hits[i - 1].d);
    expect(hits[hits.length - 1].d).toBeLessThanOrEqual(1500);
    // Brute force agrees.
    const brute = all.filter((s) => Math.hypot(s.x - bx, s.y - by) <= 1500).length;
    expect(hits.length).toBe(brute);
  });
});
