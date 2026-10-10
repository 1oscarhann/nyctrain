/** Load the committed game data from disk (Node: tests and scripts). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, type LandCollection, type World } from '../src/data/world';
import type { TractsFile } from '../src/data/types';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

export function loadWorldFromDisk(): World {
  const tracts = JSON.parse(readFileSync(join(DATA, 'tracts.json'), 'utf8')) as TractsFile;
  const buf = readFileSync(join(DATA, 'od.bin'));
  return buildWorld(tracts, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function loadLandFromDisk(): LandCollection {
  return JSON.parse(readFileSync(join(DATA, 'land.geojson'), 'utf8')) as LandCollection;
}
