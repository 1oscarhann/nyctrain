/** Load the committed game data from disk (Node: tests and scripts). */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { city } from '../src/cities';
import { buildWorld, type LandCollection, type World } from '../src/data/world';
import type { TractsFile } from '../src/data/types';
import { decodeReliefSync } from '../src/data/relief';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The current city's data directory (call applyCity() first for anything but New York). */
function dataDir(): string {
  return join(PUBLIC, city().dataPath);
}

export function loadWorldFromDisk(): World {
  const tracts = JSON.parse(readFileSync(join(dataDir(), 'tracts.json'), 'utf8')) as TractsFile;
  const buf = readFileSync(join(dataDir(), 'od.bin'));
  const world = buildWorld(tracts, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const reliefPath = join(dataDir(), 'relief.bin');
  if (city().relief && existsSync(reliefPath)) {
    const r = readFileSync(reliefPath);
    world.relief = decodeReliefSync(r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength), (b) => inflateRawSync(b));
  }
  return world;
}

export function loadLandFromDisk(): LandCollection {
  return JSON.parse(readFileSync(join(dataDir(), 'land.geojson'), 'utf8')) as LandCollection;
}

/** The current city's schools (schools.json), for the school run. */
export function loadSchoolsFromDisk(): { lon: number; lat: number; s: number; n: string; k: string; p: number }[] {
  return (JSON.parse(readFileSync(join(dataDir(), 'schools.json'), 'utf8')) as { schools: { lon: number; lat: number; s: number; n: string; k: string; p: number }[] }).schools;
}
