/** Load the committed game data from disk (Node: tests and scripts). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { city } from '../src/cities';
import { buildWorld, type LandCollection, type World } from '../src/data/world';
import type { TractsFile } from '../src/data/types';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The current city's data directory (call applyCity() first for anything but New York). */
function dataDir(): string {
  return join(PUBLIC, city().dataPath);
}

export function loadWorldFromDisk(): World {
  const tracts = JSON.parse(readFileSync(join(dataDir(), 'tracts.json'), 'utf8')) as TractsFile;
  const buf = readFileSync(join(dataDir(), 'od.bin'));
  return buildWorld(tracts, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function loadLandFromDisk(): LandCollection {
  return JSON.parse(readFileSync(join(dataDir(), 'land.geojson'), 'utf8')) as LandCollection;
}
