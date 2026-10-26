/**
 * The title screen's scene data (public/data/title-scenes.json): each map's land, a dot per few
 * hundred residents and jobs, and the imaginary lines the trailer draws (src/ui/titleData.ts), so
 * the title screen needs no city's full data to play. Run after changing a map's data or
 * src/ui/titleLines.ts: npm run build:title
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCity, CITIES, CITY_IDS } from '../src/cities';
import { buildSceneData } from '../src/ui/titleData';
import { TITLE_SCENES } from '../src/ui/titleLines';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const out: Record<string, unknown> = {};
for (const id of CITY_IDS) {
  applyCity(id);
  const dir = join(PUBLIC, CITIES[id].dataPath);
  const file = JSON.parse(readFileSync(join(dir, 'tracts.json'), 'utf8'));
  const land = JSON.parse(readFileSync(join(dir, 'land.geojson'), 'utf8'));
  const d = buildSceneData(TITLE_SCENES[id], land, file.tracts);
  const commuters = file.tracts.reduce((a: number, t: { residents: number }) => a + t.residents, 0);
  out[id] = { ...d, commuters, areas: file.tracts.length, source: file.source, year: file.year };
  console.log(id, 'rings', d.land.length, 'homes', d.homes.length / 2, 'jobs', d.jobs.length / 2);
}
writeFileSync(join(PUBLIC, 'data', 'title-scenes.json'), JSON.stringify(out));
console.log('wrote public/data/title-scenes.json');
