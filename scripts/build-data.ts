/**
 * Headway: New York — real data pipeline.
 *
 *   npm run data              download (cached) + process real data
 *   npm run data -- --synthetic   generate the labelled synthetic fallback instead
 *
 * Inputs
 *   LEHD LODES8 OD "main" file for New York, JT01, latest year available
 *   2020 Census Gazetteer tracts file for New York (internal points + land area)
 *   NYC borough boundaries clipped to the shoreline (NYC Open Data)
 *
 * Outputs (committed to the repo) in public/data/
 *   tracts.json   id, borough, lat, lon, radius, residents, jobs
 *   od.bin        compact typed arrays (see src/data/odFormat.ts)
 *   land.geojson  simplified borough land polygons
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { area, booleanPointInPolygon, centroid, pointOnFeature, polygon as turfPolygon, simplify, truncate } from '@turf/turf';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { encodeOD, OD_BANDS } from '../src/data/odFormat';
import { BOROUGH_BY_COUNTY, type BoroughName, type TractRecord, type TractsFile } from '../src/data/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data');

const LODES_INDEX = 'https://lehd.ces.census.gov/data/lodes/LODES8/ny/od/';
const GAZETTEER_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_gaz_tracts_36.txt';
const GAZETTEER_ZIP_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_tracts_36.txt';
// "Borough Boundaries" (clipped to shoreline). The older export endpoint (tqmj-j8zm) has moved.
const LAND_URLS = [
  'https://data.cityofnewyork.us/resource/gthc-hcne.geojson',
  'https://data.cityofnewyork.us/api/views/gthc-hcne/rows.geojson',
  'https://data.cityofnewyork.us/api/geospatial/tqmj-j8zm?method=export&format=GeoJSON',
];

// 2020 census tracts clipped to the shoreline. Only used to move Gazetteer internal points that fall
// in the water (tracts that include river area) back onto the tract's land.
const NYC_TRACT_URLS = [
  'https://data.cityofnewyork.us/resource/63ge-mke6.geojson?$limit=5000',
  'https://data.cityofnewyork.us/api/views/63ge-mke6/rows.geojson',
];

const NYC_COUNTIES = Object.keys(BOROUGH_BY_COUNTY);

/** A few well-known points so the sanity report can say where the top job tracts are. */
const LANDMARKS: [string, number, number][] = [
  ['Times Square', 40.758, -73.9855],
  ['Grand Central', 40.7527, -73.9772],
  ['Rockefeller Center', 40.7587, -73.9787],
  ['Penn Station', 40.7506, -73.9935],
  ['Bryant Park', 40.7536, -73.9832],
  ['Hudson Yards', 40.7539, -74.0021],
  ['Midtown East (Lexington Av & 53rd St)', 40.7577, -73.9695],
  ['Columbus Circle', 40.7681, -73.9819],
  ['Flatiron', 40.741, -73.9897],
  ['Union Square', 40.7359, -73.9911],
  ['Wall Street', 40.7069, -74.0113],
  ['World Trade Center', 40.7127, -74.0134],
  ['Brookfield Place / Battery Park City', 40.7128, -74.0157],
  ['City Hall / Civic Center', 40.7128, -74.006],
  ['Downtown Brooklyn', 40.6928, -73.9903],
  ['Long Island City', 40.7447, -73.9485],
  ['JFK Airport', 40.6413, -73.7781],
  ['LaGuardia Airport', 40.7769, -73.874],
  ['Upper East Side hospitals', 40.7644, -73.9547],
  ['Washington Heights (Columbia Medical)', 40.8405, -73.9419],
  ['Jamaica', 40.7027, -73.7889],
  ['Fordham / Bronx', 40.8615, -73.89],
  ['Staten Island (St. George)', 40.6437, -74.0736],
];

// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stdout.write(msg + '\n');
}

async function download(url: string, dest: string, minBytes = 1000): Promise<boolean> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    log(`  cached  ${dest.replace(ROOT + '/', '')}`);
    return true;
  }
  log(`  fetch   ${url}`);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log(`  ! HTTP ${res.status} for ${url}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < minBytes) {
      log(`  ! response too small (${buf.length} bytes) for ${url}`);
      return false;
    }
    writeFileSync(dest, buf);
    log(`  saved   ${(buf.length / 1e6).toFixed(1)} MB`);
    return true;
  } catch (err) {
    log(`  ! fetch failed for ${url}: ${(err as Error).message}`);
    return false;
  }
}

async function latestLodesYear(): Promise<number | null> {
  try {
    const res = await fetch(LODES_INDEX);
    if (!res.ok) return null;
    const html = await res.text();
    const years = [...html.matchAll(/ny_od_main_JT01_(\d{4})\.csv\.gz/g)].map((m) => Number(m[1]));
    return years.length ? Math.max(...years) : null;
  } catch {
    return null;
  }
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestLandmark(lat: number, lon: number): string {
  let best = '';
  let bestD = Infinity;
  for (const [name, la, lo] of LANDMARKS) {
    const d = haversine(lat, lon, la, lo);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return `${best} (${(bestD / 1000).toFixed(1)} km)`;
}

// ---------------------------------------------------------------------------
// Gazetteer

interface GazTract {
  lat: number;
  lon: number;
  aland: number;
}

function parseGazetteer(path: string): Map<string, GazTract> {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0].split('\t').map((h) => h.trim());
  const iId = header.indexOf('GEOID');
  const iLand = header.indexOf('ALAND');
  const iLat = header.indexOf('INTPTLAT');
  const iLon = header.indexOf('INTPTLONG');
  if (iId < 0 || iLand < 0 || iLat < 0 || iLon < 0) throw new Error('Unexpected Gazetteer header: ' + header);
  const out = new Map<string, GazTract>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length <= iLon) continue;
    const id = cols[iId].trim();
    if (!NYC_COUNTIES.includes(id.slice(0, 5))) continue;
    out.set(id, { lat: Number(cols[iLat]), lon: Number(cols[iLon]), aland: Number(cols[iLand]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LODES aggregation

interface PairAgg {
  se: [number, number, number];
}

async function aggregateLodes(path: string) {
  const pairs = new Map<string, PairAgg>(); // key `${home}|${work}` (tract ids)
  let rows = 0;
  let kept = 0;
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let header: string[] | null = null;
  let iW = 0, iH = 0, iS = 0, i1 = 0, i2 = 0, i3 = 0;
  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      iW = header.indexOf('w_geocode');
      iH = header.indexOf('h_geocode');
      iS = header.indexOf('S000');
      i1 = header.indexOf('SE01');
      i2 = header.indexOf('SE02');
      i3 = header.indexOf('SE03');
      if ([iW, iH, iS, i1, i2, i3].some((x) => x < 0)) throw new Error('Unexpected LODES header: ' + line);
      continue;
    }
    rows++;
    // Fast reject on county before splitting the full row.
    const w5 = line.slice(0, 5);
    if (!NYC_COUNTIES.includes(w5)) continue;
    const cols = line.split(',');
    const h = cols[iH];
    if (!NYC_COUNTIES.includes(h.slice(0, 5))) continue;
    const w = cols[iW];
    const key = h.slice(0, 11) + '|' + w.slice(0, 11);
    let agg = pairs.get(key);
    if (!agg) {
      agg = { se: [0, 0, 0] };
      pairs.set(key, agg);
    }
    agg.se[0] += Number(cols[i1]);
    agg.se[1] += Number(cols[i2]);
    agg.se[2] += Number(cols[i3]);
    kept++;
    if (rows % 1_000_000 === 0) log(`  ... ${(rows / 1e6).toFixed(0)}M rows read, ${kept.toLocaleString()} NYC-internal`);
  }
  log(`  ${rows.toLocaleString()} rows read, ${kept.toLocaleString()} NYC-internal block pairs, ${pairs.size.toLocaleString()} tract pairs`);
  return pairs;
}

// ---------------------------------------------------------------------------
// Land polygons

function processLand(path: string): FeatureCollection<Polygon | MultiPolygon> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection<Polygon | MultiPolygon>;
  const features = raw.features.map((f) => {
    const p = f.properties as Record<string, string>;
    const code = Number(p.borocode ?? p.BoroCode ?? p.boro_code);
    const name = String(p.boroname ?? p.BoroName ?? p.boro_name);
    return { type: 'Feature' as const, properties: { code, borough: name }, geometry: f.geometry };
  });
  let fc: FeatureCollection<Polygon | MultiPolygon> = { type: 'FeatureCollection', features };
  // ~6 m tolerance keeps piers and the shoreline readable while staying far under 2 MB.
  fc = simplify(fc, { tolerance: 0.00006, highQuality: true, mutate: true });
  fc = truncate(fc, { precision: 5, coordinates: 2, mutate: true });
  // Drop slivers that simplification collapsed.
  for (const f of fc.features) {
    if (f.geometry.type === 'MultiPolygon') {
      f.geometry.coordinates = f.geometry.coordinates.filter((poly) => poly[0] && poly[0].length >= 4);
    }
  }
  return fc;
}

// ---------------------------------------------------------------------------
// Move internal points that sit in the water onto land

function fixWaterPoints(
  tracts: TractRecord[],
  land: FeatureCollection<Polygon | MultiPolygon> | null,
  tractPolysPath: string | null,
): number {
  if (!land) return 0;
  // On land *in the tract's own borough* — a Manhattan point that lands on a Brooklyn pier is still wrong.
  const onLand = (lon: number, lat: number, borough: BoroughName) =>
    land.features.some(
      (f) => (f.properties as { borough: string }).borough === borough && booleanPointInPolygon([lon, lat], f),
    );
  let polys: Map<string, GeoJSON.Feature<Polygon | MultiPolygon>> | null = null;
  if (tractPolysPath && existsSync(tractPolysPath)) {
    const fc = JSON.parse(readFileSync(tractPolysPath, 'utf8')) as FeatureCollection<Polygon | MultiPolygon>;
    polys = new Map();
    for (const f of fc.features) {
      const id = String((f.properties as Record<string, string>).geoid ?? '');
      if (id) polys.set(id, f);
    }
  }
  let moved = 0;
  for (const t of tracts) {
    const poly = polys?.get(t.id);
    // The Gazetteer point can sit in the river, or on a tiny islet/pier that belongs to the tract
    // (e.g. FiDi's tract 9 lands on a 0.02 km² islet in the East River). Require the point to be on
    // land in the tract's own borough AND inside the tract's largest land part.
    let main: GeoJSON.Feature<Polygon> | null = null;
    if (poly) {
      const parts =
        poly.geometry.type === 'Polygon' ? [poly.geometry.coordinates] : poly.geometry.coordinates;
      let bestA = -1;
      for (const coords of parts) {
        const p = turfPolygon(coords);
        const a = area(p);
        if (a > bestA) {
          bestA = a;
          main = p;
        }
      }
    }
    const inMain = !main || booleanPointInPolygon([t.lon, t.lat], main);
    if (onLand(t.lon, t.lat, t.borough) && inMain) continue;
    if (!main) continue;
    let pt = centroid(main).geometry.coordinates;
    if (!booleanPointInPolygon(pt, main) || !onLand(pt[0], pt[1], t.borough)) pt = pointOnFeature(main).geometry.coordinates;
    const before = [t.lat, t.lon];
    t.lon = +pt[0].toFixed(6);
    t.lat = +pt[1].toFixed(6);
    moved++;
    if (t.jobs > 5000 || t.residents > 5000)
      log(`  moved ${t.id} (${t.jobs.toLocaleString()} jobs) from ${before[0]},${before[1]} to ${t.lat},${t.lon}`);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Synthetic fallback (clearly labelled)

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSynthetic(): { tracts: TractRecord[]; pairs: Map<string, PairAgg> } {
  log('  generating SYNTHETIC dataset (real data unreachable)');
  const rand = mulberry32(20200401);
  // Rough borough boxes [latMin, latMax, lonMin, lonMax, tracts, residents]
  const boxes: [BoroughName, string, number, number, number, number, number, number][] = [
    ['Manhattan', '36061', 40.70, 40.87, -74.02, -73.93, 300, 700_000],
    ['Bronx', '36005', 40.80, 40.90, -73.93, -73.79, 330, 500_000],
    ['Brooklyn', '36047', 40.58, 40.70, -74.03, -73.86, 780, 1_000_000],
    ['Queens', '36081', 40.55, 40.78, -73.95, -73.71, 700, 950_000],
    ['Staten Island', '36085', 40.50, 40.64, -74.25, -74.06, 120, 180_000],
  ];
  const centres: [number, number, number][] = [
    [40.7549, -73.984, 1.0], // Midtown
    [40.7075, -74.0113, 0.7], // Lower Manhattan
    [40.6928, -73.9903, 0.25], // Downtown Brooklyn
    [40.7447, -73.9485, 0.2], // Long Island City
  ];
  const tracts: TractRecord[] = [];
  for (const [borough, county, la0, la1, lo0, lo1, n, res] of boxes) {
    for (let i = 0; i < n; i++) {
      const lat = la0 + rand() * (la1 - la0);
      const lon = lo0 + rand() * (lo1 - lo0);
      let jobsW = 0.05;
      for (const [cl, co, w] of centres) {
        const d = haversine(lat, lon, cl, co) / 1000;
        jobsW += w * 40 * Math.exp(-d / 1.2);
      }
      tracts.push({
        id: county + String(100 + i).padStart(6, '0'),
        borough,
        lat: +lat.toFixed(6),
        lon: +lon.toFixed(6),
        radius: 350,
        residents: Math.round((res / n) * (0.5 + rand())),
        jobs: Math.round(jobsW * 400),
      });
    }
  }
  const totalJobs = tracts.reduce((s, t) => s + t.jobs, 0);
  const pairs = new Map<string, PairAgg>();
  for (const h of tracts) {
    // Each home tract sends residents to 40 random job tracts weighted by jobs and distance.
    const weights = tracts.map((w) => w.jobs / totalJobs / (1 + haversine(h.lat, h.lon, w.lat, w.lon) / 8000));
    const sumW = weights.reduce((a, b) => a + b, 0);
    let left = h.residents;
    for (let k = 0; k < 40 && left > 0; k++) {
      let r = rand() * sumW;
      let j = 0;
      while (j < tracts.length - 1 && r > weights[j]) r -= weights[j++];
      const n = k === 39 ? left : Math.min(left, Math.round(h.residents / 40 * (0.5 + rand())));
      left -= n;
      const key = h.id + '|' + tracts[j].id;
      const agg = pairs.get(key) ?? { se: [0, 0, 0] as [number, number, number] };
      agg.se[0] += Math.round(n * 0.2);
      agg.se[1] += Math.round(n * 0.35);
      agg.se[2] += n - Math.round(n * 0.2) - Math.round(n * 0.35);
      pairs.set(key, agg);
    }
  }
  return { tracts, pairs };
}

// ---------------------------------------------------------------------------

async function main() {
  const forceSynthetic = process.argv.includes('--synthetic');
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  let synthetic = forceSynthetic;
  let year = 0;
  let tracts: TractRecord[] = [];
  let pairs = new Map<string, PairAgg>();
  let sourceNote = '';

  if (!synthetic) {
    log('1/4 Locating latest LODES8 year…');
    year = (await latestLodesYear()) ?? 2022;
    log(`  latest year: ${year}`);
    const lodesPath = join(CACHE, `ny_od_main_JT01_${year}.csv.gz`);
    const okLodes = await download(`${LODES_INDEX}ny_od_main_JT01_${year}.csv.gz`, lodesPath, 1_000_000);
    const gazPath = join(CACHE, '2020_gaz_tracts_36.txt');
    const okGaz =
      (await download(GAZETTEER_URL, gazPath, 100_000)) || (await download(GAZETTEER_ZIP_URL, gazPath, 100_000));
    if (!okLodes || !okGaz) {
      log('  ! real data unreachable — falling back to synthetic');
      synthetic = true;
    } else {
      log('2/4 Aggregating NYC-internal commutes to census tracts…');
      pairs = await aggregateLodes(lodesPath);
      const gaz = parseGazetteer(gazPath);
      const res = new Map<string, number>();
      const jobs = new Map<string, number>();
      for (const [key, agg] of pairs) {
        const [h, w] = key.split('|');
        const n = agg.se[0] + agg.se[1] + agg.se[2];
        res.set(h, (res.get(h) ?? 0) + n);
        jobs.set(w, (jobs.get(w) ?? 0) + n);
      }
      const ids = [...new Set([...res.keys(), ...jobs.keys()])].sort();
      let missing = 0;
      for (const id of ids) {
        const g = gaz.get(id);
        if (!g) {
          missing++;
          continue;
        }
        const area = Math.max(g.aland, 20_000); // a few tracts are almost all water
        tracts.push({
          id,
          borough: BOROUGH_BY_COUNTY[id.slice(0, 5)],
          lat: +g.lat.toFixed(6),
          lon: +g.lon.toFixed(6),
          radius: Math.round(Math.sqrt(area / Math.PI)),
          residents: res.get(id) ?? 0,
          jobs: jobs.get(id) ?? 0,
        });
      }
      if (missing) log(`  ! ${missing} tracts missing from the Gazetteer were dropped`);
      sourceNote = `LEHD LODES8 NY od main JT01 ${year} (NYC-internal), 2020 Census Gazetteer tracts`;
    }
  }

  if (synthetic) {
    const s = buildSynthetic();
    tracts = s.tracts;
    pairs = s.pairs;
    year = 0;
    sourceNote = 'SYNTHETIC — generated because real LODES/Gazetteer data was unreachable';
  }

  log('3/4 Land polygons…');
  let landOk = false;
  const landPath = join(CACHE, 'borough_boundaries.geojson');
  for (const url of LAND_URLS) {
    if (await download(url, landPath, 100_000)) {
      landOk = true;
      break;
    }
  }
  let land: FeatureCollection<Polygon | MultiPolygon> | null = null;
  if (landOk) {
    land = processLand(landPath);
    writeFileSync(join(OUT, 'land.geojson'), JSON.stringify(land));
  } else if (existsSync(join(OUT, 'land.geojson'))) {
    land = JSON.parse(readFileSync(join(OUT, 'land.geojson'), 'utf8'));
  } else {
    log('  ! land polygons unreachable — keeping existing public/data/land.geojson if present');
  }

  let movedPoints = 0;
  if (!synthetic) {
    const tractPolysPath = join(CACHE, 'nyc_tracts_2020.geojson');
    let ok = false;
    for (const url of NYC_TRACT_URLS) if ((ok = await download(url, tractPolysPath, 100_000))) break;
    movedPoints = fixWaterPoints(tracts, land, ok ? tractPolysPath : null);
    log(`  ${movedPoints} tract internal points were in the water or off the tract's main land area and were moved`);
  }

  log('4/4 Writing tracts.json and od.bin…');
  const index = new Map(tracts.map((t, i) => [t.id, i]));
  const rows: { h: number; w: number; se: [number, number, number] }[] = [];
  for (const [key, agg] of pairs) {
    const [h, w] = key.split('|');
    const hi = index.get(h);
    const wi = index.get(w);
    if (hi === undefined || wi === undefined) continue;
    rows.push({ h: hi, w: wi, se: agg.se });
  }
  rows.sort((a, b) => a.h - b.h || a.w - b.w);
  const od = encodeOD(tracts.length, rows);
  writeFileSync(join(OUT, 'od.bin'), od);
  const tractsFile: TractsFile = {
    version: 1,
    synthetic,
    year,
    source: sourceNote,
    bands: OD_BANDS,
    tracts,
  };
  writeFileSync(join(OUT, 'tracts.json'), JSON.stringify(tractsFile));

  // ------------------------------------------------------------------ report
  const total = rows.reduce((s, r) => s + r.se[0] + r.se[1] + r.se[2], 0);
  const bandTotals = [0, 1, 2].map((b) => rows.reduce((s, r) => s + r.se[b], 0));
  log('');
  log('================ SANITY REPORT ================');
  log(`Source: ${sourceNote}`);
  if (synthetic) log('*** WARNING: SYNTHETIC DATA — not real commuting patterns ***');
  log(`Tracts: ${tracts.length.toLocaleString()}   OD tract pairs: ${rows.length.toLocaleString()}`);
  log(`Total NYC-internal commuters: ${total.toLocaleString()}`);
  log(
    `  by earnings: ≤$1,250/mo ${bandTotals[0].toLocaleString()} · $1,251–3,333 ${bandTotals[1].toLocaleString()} · >$3,333 ${bandTotals[2].toLocaleString()}`,
  );
  log('');
  log('Borough          Residents     Jobs    Tracts');
  for (const b of ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as BoroughName[]) {
    const ts = tracts.filter((t) => t.borough === b);
    const r = ts.reduce((s, t) => s + t.residents, 0);
    const j = ts.reduce((s, t) => s + t.jobs, 0);
    log(`${b.padEnd(15)} ${r.toLocaleString().padStart(10)} ${j.toLocaleString().padStart(10)} ${String(ts.length).padStart(7)}`);
  }
  log('');
  log('Top 10 job tracts:');
  const top = [...tracts].sort((a, b) => b.jobs - a.jobs).slice(0, 10);
  for (const t of top) {
    log(`  ${t.id}  ${t.borough.padEnd(13)} ${t.jobs.toLocaleString().padStart(8)} jobs  near ${nearestLandmark(t.lat, t.lon)}`);
  }
  const sizes = ['tracts.json', 'od.bin', 'land.geojson']
    .filter((f) => existsSync(join(OUT, f)))
    .map((f) => `${f} ${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`);
  log('');
  log('Output: ' + sizes.join(' · '));
  log('===============================================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
