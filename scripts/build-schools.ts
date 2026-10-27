/**
 * Headway — real schools for every map.
 *
 *   npm run data:schools
 *
 * England (London, the South East, Manchester, Birmingham, Leeds, Bristol): the DfE school census, "Schools, pupils and their characteristics"
 * 2025/26, school-level data (Explore Education Statistics): every state-funded and independent
 * school with its name, type, phase, postcode and pupils by age. Postcodes are placed with the ONS
 * Postcode Directory (latest, ONS ArcGIS), the same geography service the commuting pipeline uses.
 * New York: NYC DOE 2019–20 School Locations (NYC Open Data wg9x-4ke6) joined to the 2021–22
 * Demographic Snapshot (c7ru-d68s) for enrolment by grade.
 *
 * Output: public/data/<city>/schools.json (src/data/schools.ts SchoolsFile). Downloads are cached in
 * scripts/.cache/schools/ and parsed as untrusted data.
 *
 * Attribution: Contains public sector information licensed under the Open Government Licence v3.0
 * (DfE); Contains OS data © Crown copyright and database right; Source: Office for National
 * Statistics licensed under the Open Government Licence v3.0. NYC Open Data (NYC DOE).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SchoolKind, SchoolRecord, SchoolsFile } from '../src/data/schools';
import { UK_METRO_IDS, UK_METROS } from '../src/cities/ukMetroRegions';
import { CITY_BALANCE, type CityId } from '../src/balance';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache', 'schools');
const SPC_URL = 'https://content.explore-education-statistics.service.gov.uk/api/data-set-files/7e8c04bd-24eb-49ca-b403-76e829ac3b9e/download';
const ONSPD = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/ONSPD_Online_latest_Postcode_Centroids/FeatureServer/0/query';
const NYC_LOC = 'https://data.cityofnewyork.us/resource/wg9x-4ke6.json?$limit=5000';
const NYC_DEMO = "https://data.cityofnewyork.us/resource/c7ru-d68s.json?$limit=5000&year=2021-22";

const ENGLAND_ATTR =
  'Schools: DfE school census 2025/26 (Open Government Licence v3.0); locations: ONS Postcode Directory, contains OS data © Crown copyright and database right';
const NYC_ATTR = 'Schools: NYC DOE school locations 2019–20 and Demographic Snapshot 2021–22 (NYC Open Data)';

function log(m: string) {
  console.log(m);
}
function fail(m: string): never {
  console.error('ERROR: ' + m);
  process.exit(1);
}

async function download(url: string, dest: string, minBytes: number): Promise<void> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) return log(`  cached  ${dest.replace(ROOT + '/', '')}`);
  log(`  fetch   ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  if (statSync(dest).size < minBytes) fail(`${url}: only ${statSync(dest).size} bytes`);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const num = (s: string) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

// ---------------------------------------------------------------------------------------- England

interface EngSchool {
  laestab: string;
  urn: string;
  name: string;
  phase: string;
  type: string;
  allThrough: boolean;
  region: string;
  la: string;
  postcode: string;
  pupils: number;
  secondary: number;
  ages: number[];
}

/** One school's kind from the census phase grouping (independent schools keep their own kind). */
function engKind(s: EngSchool): SchoolKind {
  const p = s.phase.toLowerCase();
  if (p.includes('independent')) return 'independent';
  if (p.includes('special') || p.includes('ap school')) return 'special';
  if (p.includes('nursery')) return 'nursery';
  if (s.allThrough) return 'allthrough';
  if (p.includes('secondary')) return 'secondary';
  return 'primary';
}

/** England's regions (as the census names them) that hold a map. */
const REGIONS = ['London', 'South East', 'North West', 'West Midlands', 'Yorkshire and The Humber', 'South West'];

async function readCensus(path: string): Promise<Map<string, EngSchool>> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] | null = null;
  const ix: Record<string, number> = {};
  const schools = new Map<string, EngSchool>();
  let rows = 0;
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      header.forEach((h, i) => (ix[h] = i));
      for (const need of ['geographic_level', 'region_name', 'school_laestab', 'school_urn', 'school_name', 'phase_type_grouping', 'establishment_type', 'all_through', 'la_name', 'school_postcode', 'sex', 'attendance_pattern', 'breakdown_topic', 'breakdown', 'pupil_count'])
        if (ix[need] === undefined) fail(`census CSV: missing column ${need}`);
      continue;
    }
    rows++;
    if (rows % 2_000_000 === 0) log(`  … ${(rows / 1e6).toFixed(0)}M rows, ${schools.size} schools`);
    // Cheap pre-filter before the full parse: only the regions with a map.
    if (!REGIONS.some((r) => line.includes(`"${r}"`) || line.includes(`,${r},`))) continue;
    const c = parseCsvLine(line);
    if (c.length !== header.length || c[ix.geographic_level] !== 'School') continue;
    const region = c[ix.region_name];
    if (!REGIONS.includes(region)) continue;
    const topic = c[ix.breakdown_topic];
    const isTotal = topic === 'Total' && c[ix.sex] === 'Total' && c[ix.attendance_pattern] === 'Total';
    const isAge = topic === 'Age' && (c[ix.sex] === 'Female' || c[ix.sex] === 'Male') && (c[ix.attendance_pattern] === 'Full-time' || c[ix.attendance_pattern] === 'Part-time');
    if (!isTotal && !isAge) continue;
    const id = c[ix.school_laestab];
    let s = schools.get(id);
    if (!s) {
      s = {
        laestab: id,
        urn: c[ix.school_urn],
        name: clean(c[ix.school_name]),
        phase: c[ix.phase_type_grouping],
        type: clean(c[ix.establishment_type]),
        allThrough: c[ix.all_through] === 'Yes',
        region,
        la: c[ix.la_name],
        postcode: clean(c[ix.school_postcode]).toUpperCase(),
        pupils: 0,
        secondary: 0,
        ages: new Array(20).fill(0),
      };
      schools.set(id, s);
    }
    const n = num(c[ix.pupil_count]);
    if (isTotal) s.pupils = n;
    else {
      const m = /Aged (\d+)/.exec(c[ix.breakdown]);
      if (m) {
        const a = Math.min(19, Number(m[1]));
        s.ages[a] += n;
        if (a >= 11 && a <= 18) s.secondary += n;
      }
    }
  }
  log(`  ${rows.toLocaleString('en-GB')} census rows, ${schools.size} schools in ${REGIONS.join(', ')}`);
  return schools;
}

async function geocode(postcodes: string[]): Promise<Map<string, { lon: number; lat: number; msoa: string }>> {
  const path = join(CACHE, 'postcodes.json');
  const have: Record<string, { lon: number; lat: number; msoa: string } | null> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const todo = postcodes.filter((p) => !(p in have));
  log(`  postcodes: ${postcodes.length} (${todo.length} to look up)`);
  for (let i = 0; i < todo.length; i += 150) {
    const batch = todo.slice(i, i + 150);
    const where = `PCDS IN (${batch.map((p) => `'${p.replace(/'/g, '')}'`).join(',')})`;
    const body = new URLSearchParams({ where, outFields: 'PCDS,LAT,LONG,MSOA11CD', returnGeometry: 'false', f: 'json' });
    let json: { features?: { attributes: Record<string, unknown> }[]; error?: unknown } | null = null;
    for (let attempt = 0; attempt < 4 && !json?.features; attempt++) {
      try {
        const res = await fetch(ONSPD, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(60_000) });
        json = res.ok ? await res.json() : null;
      } catch (e) {
        log(`  ! ONSPD request failed (${(e as Error).message}); retrying`);
        json = null;
      }
    }
    if (!json?.features) fail(`ONSPD query failed: ${JSON.stringify(json?.error ?? null)}`);
    for (const p of batch) have[p] = null;
    for (const f of json.features) {
      const a = f.attributes;
      const lat = Number(a.LAT), lon = Number(a.LONG);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat > 49 && lat < 61) have[String(a.PCDS)] = { lon, lat, msoa: String(a.MSOA11CD ?? '') };
    }
    if ((i / 150) % 10 === 0) {
      log(`  … ${Math.min(todo.length, i + 150)} / ${todo.length}`);
      writeFileSync(path, JSON.stringify(have));
    }
  }
  writeFileSync(path, JSON.stringify(have));
  return new Map(Object.entries(have).filter((e): e is [string, { lon: number; lat: number; msoa: string }] => e[1] !== null));
}

// ------------------------------------------------------------------------------------------ NYC

function nycKind(cat: string): SchoolKind {
  const c = cat.toLowerCase();
  if (c.includes('early childhood')) return 'nursery';
  if (c.includes('elementary')) return 'primary';
  if (c.includes('k-8') || c.includes('k-12')) return 'allthrough';
  if (c.includes('ungraded') || c.includes('collaborative')) return 'special';
  return 'secondary';
}

async function nycSchools(): Promise<SchoolRecord[]> {
  const locPath = join(CACHE, 'nyc_locations_2019_20.json');
  const demoPath = join(CACHE, 'nyc_demographics_2021_22.json');
  await download(NYC_LOC, locPath, 100_000);
  await download(NYC_DEMO, demoPath, 100_000);
  const locs = JSON.parse(readFileSync(locPath, 'utf8')) as Record<string, string>[];
  const demo = JSON.parse(readFileSync(demoPath, 'utf8')) as Record<string, string>[];
  const enr = new Map(demo.map((d) => [d.dbn, d]));
  const out: SchoolRecord[] = [];
  let noEnrol = 0;
  for (const l of locs) {
    if (l.status_descriptions && l.status_descriptions !== 'Open') continue;
    const lat = Number(l.latitude), lon = Number(l.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40.4 || lat > 41) continue;
    const d = enr.get(l.system_code);
    if (!d) noEnrol++;
    const g = (k: string) => num(d?.[k] ?? '0');
    const pupils = d ? num(d.total_enrollment) : 0;
    const secondary = d ? ['grade_6', 'grade_7', 'grade_8', 'grade_9', 'grade_10', 'grade_11', 'grade_12'].reduce((s, k) => s + g(k), 0) : 0;
    out.push({ n: clean(l.location_name ?? ''), lon: +lon.toFixed(5), lat: +lat.toFixed(5), k: nycKind(l.location_category_description ?? ''), p: pupils, s: secondary, t: clean(l.location_category_description ?? '') });
  }
  log(`  NYC: ${out.length} open school buildings (${noEnrol} without a 2021–22 enrolment match)`);
  return out;
}

// ----------------------------------------------------------------------------------------- main

function write(city: string, file: SchoolsFile) {
  const path = join(ROOT, 'public', 'data', city === 'nyc' ? '' : city, 'schools.json');
  writeFileSync(path, JSON.stringify(file));
  const by: Record<string, number> = {};
  for (const s of file.schools) by[s.k] = (by[s.k] ?? 0) + 1;
  log(`  wrote ${path.replace(ROOT + '/', '')}: ${file.schools.length} schools, ${file.schools.reduce((t, s) => t + s.p, 0).toLocaleString('en-GB')} pupils, ${(statSync(path).size / 1e6).toFixed(2)} MB · ${JSON.stringify(by)}`);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  log('1/3 New York…');
  write('nyc', { version: 1, year: '2019–20 locations, 2021–22 enrolment', source: NYC_ATTR, schools: await nycSchools() });

  log('2/3 England: school census 2025/26 (≈1 GB, cached)…');
  const csv = join(CACHE, 'spc_school_level_2025_26.csv');
  await download(SPC_URL, csv, 500_000_000);
  const schools = await readCensus(csv);
  const pcs = [...new Set([...schools.values()].map((s) => s.postcode).filter(Boolean))];
  log('3/3 Placing schools by postcode (ONS Postcode Directory)…');
  const geo = await geocode(pcs);
  const recs: (SchoolRecord & { region: string; la: string })[] = [];
  let missing = 0;
  for (const s of schools.values()) {
    const g = geo.get(s.postcode);
    if (!g) {
      missing++;
      continue;
    }
    // Age range from the pupils by age (for the tooltip: "ages 4–11").
    const ages = s.ages.map((n, a) => (n > 0 ? a : -1)).filter((a) => a >= 0);
    const range = ages.length ? `${Math.max(2, ages[0])}–${ages[ages.length - 1]}` : '';
    recs.push({ n: s.name, lon: +g.lon.toFixed(5), lat: +g.lat.toFixed(5), k: engKind(s), p: s.pupils, s: s.secondary, t: s.type, a: range, region: s.region, la: s.la });
  }
  log(`  ${recs.length} schools placed, ${missing} postcodes not found`);
  const strip = ({ region: _r, la: _l, ...rest }: SchoolRecord & { region: string; la: string }): SchoolRecord => rest;
  // A few schools are counted under an authority but sit far away (a placement school on the
  // coast): keep each map's schools inside its bounds.
  const inMap = (id: CityId) => {
    const [w, so, e, n] = CITY_BALANCE[id].map.bounds;
    return (r: SchoolRecord) => r.lon > w && r.lon < e && r.lat > so && r.lat < n;
  };
  write('london', { version: 1, year: '2025/26', source: ENGLAND_ATTR, schools: recs.filter((r) => r.region === 'London').filter(inMap('london')).map(strip) });
  write('southeast', { version: 1, year: '2025/26', source: ENGLAND_ATTR, schools: recs.filter((r) => r.region === 'London' || r.region === 'South East').map(strip) });
  // The city-region maps: their local authorities (by the census's LA names).
  for (const id of UK_METRO_IDS) {
    const las = new Set(UK_METROS[id].regions.flatMap((r) => [r.name, r.onsName ?? r.name]));
    const mine = recs.filter((r) => las.has(r.la));
    const found = new Set(mine.map((r) => r.la));
    const missingLa = UK_METROS[id].regions.filter((r) => !found.has(r.name) && !found.has(r.onsName ?? r.name)).map((r) => r.name);
    if (missingLa.length) fail(`${id}: no schools found for ${missingLa.join(', ')} (LA names changed?)`);
    write(id, { version: 1, year: '2025/26', source: ENGLAND_ATTR, schools: mine.filter(inMap(id)).map(strip) });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
