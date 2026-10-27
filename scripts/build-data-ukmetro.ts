/**
 * Headway — English city-region data pipeline (2011 Census + ONS geography), for the maps beyond
 * London: Greater Manchester, the West Midlands, West Yorkshire and the West of England
 * (src/cities/ukMetroRegions.ts).
 *
 *   npm run data:uk -- manchester        (or birmingham, leeds, bristol; no argument builds all four)
 *
 * The London pipeline (build-data-london.ts, via the South East one) made generic: every commute
 * that starts and ends inside the city region's local authority districts. MSOAs are selected by
 * the income file's local authority codes (so "Bristol, City of" needs no name matching) and
 * cross-checked against the centroid names. Inland water (rivers, lakes, docks, reservoirs) from
 * OpenStreetMap is cut out of every district; the coast and tidal estuaries are already clipped
 * by the ONS boundaries.
 *
 * Premise (as in London and New York): nobody ever built the trams, the metro or the local rail
 * lines here. The commuters are real; the network is the player's.
 *
 * Inputs (national files shared with London in scripts/.cache/london/, the region's own in
 * scripts/.cache/<city>/; all parsed as untrusted data)
 *   2011 Census WU03EW, MSOA origin–destination by method of travel to work (Nomis)
 *   ONS MSOA (Dec 2011) population-weighted centroids, England & Wales
 *   ONS MSOA (Dec 2011) boundaries, full resolution clipped (BFC V3)
 *   ONS Local Authority Districts (Dec 2011) boundaries, full resolution clipped (FCB)
 *   ONS small area income estimates for MSOAs 2011/12: mean total weekly household income
 *   OpenStreetMap water via the OpenFreeMap vector tiles (z12)
 *
 * Outputs in public/data/<city>/, in exactly the formats the game reads (src/data/types.ts,
 * src/data/odFormat.ts, src/data/world.ts, src/data/landMask.ts): tracts.json, od.bin, land.geojson.
 * Earnings bands: as London (an ordered logit on the home MSOA's household income, 30/40/30).
 *
 * Attribution (Open Government Licence v3.0): Contains National Statistics data © Crown copyright and
 * database right 2011/2013; contains OS data © Crown copyright and database right. Water ©
 * OpenStreetMap contributors (ODbL).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { area, bbox, booleanPointInPolygon, centerOfMass, difference, featureCollection, pointOnFeature, polygon as turfPolygon } from '@turf/turf';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { decodeOD, encodeOD } from '../src/data/odFormat';
import type { TractRecord, TractsFile } from '../src/data/types';
import { LandMask } from '../src/data/landMask';
import type { LandCollection } from '../src/data/world';
import { toLonLat } from '../src/core/geo';
import { UK_METRO_IDS, UK_METROS, type UkMetroId, type UkMetroSpec } from '../src/cities/ukMetroRegions';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** National files (shared with the London pipelines). */
const CACHE = join(ROOT, 'scripts', '.cache', 'london');
// Set per city by build(): the region's own cache and output folders.
let CITY_CACHE = '';
let OUT = '';

const OD_ZIP_URL = 'https://www.nomisweb.co.uk/output/census/2011/wu03ew_msoa.zip';
const OD_ZIP_ENTRY = 'wu03ew_msoa.csv';
const INCOME_URL =
  'https://www.ons.gov.uk/file?uri=/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/smallareaincomeestimatesformiddlelayersuperoutputareasenglandandwales/201112/1totalweeklyincome.csv';
const ARCGIS = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services';
const PWC_LAYER = `${ARCGIS}/MSOA_Dec_2011_PWC_in_England_and_Wales_2022/FeatureServer/0`;
const MSOA_BFC_LAYER = `${ARCGIS}/Middle_layer_Super_Output_Areas_Dec_2011_Boundaries_Full_Clipped_BFC_EW_V3_2022/FeatureServer/0`;
const LAD_FCB_LAYER = `${ARCGIS}/Local_Authority_Districts_December_2011_FCB_EW_2022/FeatureServer/0`;
const LAD_GCB_LAYER = `${ARCGIS}/Local_Authority_Districts_December_2011_GCB_EW_2022/FeatureServer/0`;

const sourceFor = (spec: UkMetroSpec) =>
  `2011 Census WU03EW MSOA travel to work (within ${spec.region}, excl. working mainly at home), ONS MSOA 2011 population-weighted centroids, ONS small area income estimates 2011/12`;
const ATTRIBUTION =
  'Contains National Statistics data © Crown copyright and database right 2011/2013; contains OS data © Crown copyright and database right. Open Government Licence v3.0. Inland water © OpenStreetMap contributors (ODbL).';

// Set per city by build().
let SPEC: UkMetroSpec = UK_METROS.manchester;
let REGION_CODES = new Set<string>();
/** Set once the income file is read (its MSOA → LA codes). */
let EXPECTED_MSOAS = 0;

/**
 * Earnings-band model (pipeline parameters, not game tunables).
 *
 * Latent individual log earnings of a commuter living in MSOA i:  L = ln(Y_i) + ε,  ε ~ Logistic(0, s),
 * where Y_i is the MSOA's mean total weekly household income (ONS 2011/12). Bands are cut at two
 * London-wide thresholds t1 < t2:
 *   P(low)  = σ((t1 − ln Y_i) / s)        P(high) = 1 − σ((t2 − ln Y_i) / s)        P(mid) = rest
 * t1 and t2 are solved (bisection) so the commuter-weighted London-wide shares are 30 / 40 / 30, i.e.
 * the bands are "the lowest-earning ~30%, the middle ~40% and the top ~30% of London-internal
 * commuters" — the same three-way split the game's value-of-time bands need, with the middle band
 * the largest as in the New York LODES bands.
 * s: individual earnings vary far more within an area than area means vary between areas. A typical
 * all-employee UK spread of log earnings is σ ≈ 0.7 (P90/P10 ≈ 6); the logistic with that SD has
 * s = σ·√3/π ≈ 0.39. Area means then shift the shares moderately (a 1-SD richer MSOA has roughly
 * 44% high earners instead of 30%), never to 0% or 100%.
 */
const BAND_MODEL = {
  logSd: 0.7,
  targetLow: 0.3,
  targetHigh: 0.3,
} as const;
const BAND_SCALE = (BAND_MODEL.logSd * Math.sqrt(3)) / Math.PI;
const BANDS = [
  'B1 lower-income ~30% (modelled from home MSOA household income)',
  'B2 middle-income ~40% (modelled)',
  'B3 higher-income ~30% (modelled)',
];

/** Land polygons: Douglas–Peucker tolerance on shared arcs (borders stay coincident), metres. */
const LAND_TOLERANCE_M = 12;
/** Land mask cell for the report's checks (the game uses MAP.landCell for this map). */
const MASK_CELL = 30;
/** MSOAs with more than this many jobs per resident are placed at their area centre, not the residents' centroid. */
const JOB_DOMINATED_RATIO = 3;
/** Local metric frame for checks: the city's own origin (CITY_BALANCE.origin), set by build(). */
let ORIGIN: [number, number] = [0, 0];

// ---------------------------------------------------------------------------- small helpers

const report: string[] = [];
function log(msg: string) {
  process.stdout.write(msg + '\n');
}
/** Sanity-report line: printed now and collected for the final summary. */
function rep(msg = '') {
  report.push(msg);
}

function fail(msg: string): never {
  throw new Error(msg);
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number, d = 1) => (100 * x).toFixed(d) + '%';

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
  for (const [name, la, lo] of SPEC.landmarks) {
    const d = haversine(lat, lon, la, lo);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return `${best} (${(bestD / 1000).toFixed(1)} km)`;
}

// Metres per degree at the origin (same series as src/core/geo.ts), set by build().
let KY = 0;
let KX = 0;
function setFrame(origin: [number, number]): void {
  ORIGIN = origin;
  const phi = (origin[1] * Math.PI) / 180;
  KY = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  KX = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
}
function londonLocal(lon: number, lat: number): [number, number] {
  return [(lon - ORIGIN[0]) * KX, (lat - ORIGIN[1]) * KY];
}

/** Defensive text cleaning for names that come from downloads. */
function cleanName(s: unknown): string {
  const t = String(s ?? '')
    .replace(/[^\p{L}\p{N} '’,.&()-]/gu, '')
    .trim();
  if (!t || t.length > 80) fail(`Unexpected name in source data: ${JSON.stringify(String(s).slice(0, 100))}`);
  return t;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isPosition(p: unknown): p is Position {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function isRingList(x: unknown): x is Position[][] {
  return (
    Array.isArray(x) &&
    x.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every((p) => isPosition(p)))
  );
}

function isPolyGeometry(g: unknown): g is Polygon | MultiPolygon {
  if (!isObj(g)) return false;
  if (g.type === 'Polygon') return isRingList(g.coordinates);
  if (g.type === 'MultiPolygon') return Array.isArray(g.coordinates) && g.coordinates.every((p) => isRingList(p));
  return false;
}

/** CSV line with optional double quotes ("" escapes). */
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
  return out.map((s) => s.trim());
}

// ---------------------------------------------------------------------------- downloads

async function download(url: string, dest: string, minBytes: number): Promise<void> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    log(`  cached  ${dest.replace(ROOT + '/', '')}`);
    return;
  }
  log(`  fetch   ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) fail(`response too small (${buf.length} bytes) for ${url}`);
  writeFileSync(dest, buf);
  log(`  saved   ${(buf.length / 1e6).toFixed(1)} MB → ${dest.replace(ROOT + '/', '')}`);
}

/** All features matching `where`, paged (resultOffset) and validated. Output in WGS84 GeoJSON. */
async function arcgisQuery(layer: string, where: string, outFields: string): Promise<Feature[]> {
  const out: Feature[] = [];
  const page = 1000;
  for (let offset = 0; ; ) {
    const body = new URLSearchParams({
      where,
      outFields,
      returnGeometry: 'true',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(page),
      f: 'geojson',
    });
    const res = await fetch(layer + '/query', { method: 'POST', body, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) fail(`HTTP ${res.status} for ${layer}`);
    const json: unknown = await res.json();
    if (!isObj(json)) fail(`Unexpected response from ${layer}`);
    if ('error' in json) fail(`ArcGIS error from ${layer}: ${JSON.stringify(json.error).slice(0, 300)}`);
    if (json.type !== 'FeatureCollection' || !Array.isArray(json.features)) fail(`Not a FeatureCollection: ${layer}`);
    const feats = json.features as Feature[];
    out.push(...feats);
    const props = isObj(json.properties) ? json.properties : {};
    const exceeded = props.exceededTransferLimit === true || json.exceededTransferLimit === true;
    if (feats.length === 0 || (!exceeded && feats.length < page)) break;
    offset += feats.length;
  }
  return out;
}

async function cachedLayer(
  file: string,
  fetcher: () => Promise<Feature[]>,
  expectAtLeast: number,
  dir = CACHE,
): Promise<Feature[]> {
  const path = join(dir, file);
  if (existsSync(path)) {
    try {
      const fc: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isObj(fc) && Array.isArray(fc.features) && fc.features.length >= expectAtLeast) {
        log(`  cached  ${path.replace(ROOT + '/', '')} (${fc.features.length} features)`);
        return fc.features as Feature[];
      }
    } catch {
      /* refetch */
    }
  }
  const feats = await fetcher();
  if (feats.length < expectAtLeast) fail(`${file}: only ${feats.length} features (expected ≥ ${expectAtLeast})`);
  writeFileSync(path, JSON.stringify({ type: 'FeatureCollection', features: feats }));
  log(`  saved   ${path.replace(ROOT + '/', '')} (${feats.length} features, ${(statSync(path).size / 1e6).toFixed(1)} MB)`);
  return feats;
}

/** Minimal ZIP reader (stored / deflate, no ZIP64): returns one entry's bytes. */
function readZipEntry(zipPath: string, wanted: string): Buffer {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(`${zipPath}: not a zip file`);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) fail(`${zipPath}: bad central directory`);
  let p = cdOff;
  for (let e = 0; e < entries; e++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail(`${zipPath}: bad central directory entry`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nLen = buf.readUInt16LE(p + 28);
    const xLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nLen);
    p += 46 + nLen + xLen + cLen;
    if (name !== wanted) continue;
    if (compSize === 0xffffffff || size === 0xffffffff || lho === 0xffffffff) fail('ZIP64 is not supported');
    if (size > 400 * 1024 * 1024) fail(`${wanted}: unexpectedly large (${size} bytes)`);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) fail(`${zipPath}: bad local header`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + compSize > buf.length) fail(`${zipPath}: truncated entry`);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: size + 1 });
    else fail(`${wanted}: unsupported compression method ${method}`);
    if (data.length !== size) fail(`${wanted}: size mismatch (${data.length} ≠ ${size})`);
    return data;
  }
  fail(`${zipPath}: entry ${wanted} not found`);
}

// ---------------------------------------------------------------------------- geography

interface Lad {
  id: string; // E09000001
  code: number; // 1..33 (land mask code)
  name: string;
  geometry: Polygon | MultiPolygon;
}

interface Msoa {
  id: string;
  name: string;
  lad: Lad;
  pwc: [number, number]; // lon, lat
  geometry: Polygon | MultiPolygon;
  areaM2: number;
  shapeArea: number; // ONS Shape__Area (British National Grid m²), cross-check only
}

function polygonsOf(g: Polygon | MultiPolygon): Position[][][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

/** The largest part of a (multi)polygon. */
function mainPart(g: Polygon | MultiPolygon): Feature<Polygon> {
  let best: Feature<Polygon> | null = null;
  let bestA = -1;
  for (const coords of polygonsOf(g)) {
    const p = turfPolygon(coords);
    const a = area(p);
    if (a > bestA) {
      bestA = a;
      best = p;
    }
  }
  return best ?? fail('empty geometry');
}

// ---------------------------------------------------------------------------- land polygons

type LandFeature = Feature<Polygon | MultiPolygon, { code: number; borough: string; id: string }>;

/** Distance (m) from p to segment ab, all in the local metric frame. */
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(pts: Position[], tol: number): Position[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const xy = pts.map((p) => londonLocal(p[0], p[1]));
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(xy[i], xy[a], xy[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const vkey = (p: Position) => p[0] + ',' + p[1];

/**
 * Topology-preserving simplification. Rings are cut into arcs at junction vertices (where the set
 * of rings sharing a vertex changes); each arc is simplified once in a canonical direction, so the
 * border between two boroughs is simplified identically on both sides. Per-polygon simplification
 * (turf.simplify) would open slivers along the inland borders, which the land mask reads as water.
 */
function simplifyLand(lads: Lad[], tolM: number): LandFeature[] {
  interface RingRef {
    lad: number;
    poly: number;
    ring: number;
    pts: Position[]; // open (closing vertex removed)
  }
  const rings: RingRef[] = [];
  lads.forEach((lad, li) =>
    polygonsOf(lad.geometry).forEach((poly, pi) =>
      poly.forEach((ring, ri) => {
        const pts = ring.map((p) => [p[0], p[1]]);
        if (vkey(pts[0]) === vkey(pts[pts.length - 1])) pts.pop();
        rings.push({ lad: li, poly: pi, ring: ri, pts });
      }),
    ),
  );
  const owners = new Map<string, number[]>();
  rings.forEach((r, id) => {
    for (const p of r.pts) {
      const k = vkey(p);
      const o = owners.get(k);
      if (!o) owners.set(k, [id]);
      else if (o[o.length - 1] !== id) o.push(id);
      else o.push(id); // pinch point in the same ring: count twice so it is a junction
    }
  });
  const sig = (p: Position) => owners.get(vkey(p))!.join('|');
  const simplifiedRings: Position[][] = rings.map((r) => {
    const pts = r.pts;
    const m = pts.length;
    const fixed: number[] = [];
    for (let k = 0; k < m; k++) {
      const s = sig(pts[k]);
      const o = owners.get(vkey(pts[k]))!;
      if (o.length >= 3 || s !== sig(pts[(k - 1 + m) % m]) || s !== sig(pts[(k + 1) % m])) fixed.push(k);
    }
    if (fixed.length === 0) {
      // Not shared with any other ring: split at the vertex farthest from the first one.
      const a = londonLocal(pts[0][0], pts[0][1]);
      let far = 0;
      let farD = -1;
      pts.forEach((p, k) => {
        const b = londonLocal(p[0], p[1]);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (d > farD) {
          farD = d;
          far = k;
        }
      });
      fixed.push(0);
      if (far > 0) fixed.push(far);
    }
    const out: Position[] = [];
    for (let f = 0; f < fixed.length; f++) {
      const i = fixed[f];
      const j = f + 1 < fixed.length ? fixed[f + 1] : fixed[0] + m;
      const arc: Position[] = [];
      for (let k = i; k <= j; k++) arc.push(pts[k % m]);
      // Canonical direction so both rings that share this arc simplify it identically.
      const ka = vkey(arc[0]);
      const kb = vkey(arc[arc.length - 1]);
      const rev =
        ka > kb || (ka === kb && arc.length > 2 && vkey(arc[1]) > vkey(arc[arc.length - 2]));
      const simp = rev ? douglasPeucker(arc.slice().reverse(), tolM).reverse() : douglasPeucker(arc, tolM);
      for (let k = 0; k < simp.length - 1; k++) out.push(simp[k]);
    }
    // Round to 5 decimals (≈1 m; identical on both sides of a border), drop repeats, close.
    const rounded: Position[] = [];
    for (const p of out) {
      const q = [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
      const last = rounded[rounded.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) rounded.push(q);
    }
    while (rounded.length > 1 && vkey(rounded[0]) === vkey(rounded[rounded.length - 1])) rounded.pop();
    if (rounded.length < 3) return [];
    rounded.push([rounded[0][0], rounded[0][1]]);
    return rounded;
  });
  // Reassemble.
  return lads.map((lad, li) => {
    const polys: Position[][][] = [];
    polygonsOf(lad.geometry).forEach((poly, pi) => {
      const outRings: Position[][] = [];
      poly.forEach((_, ri) => {
        const idx = rings.findIndex((r) => r.lad === li && r.poly === pi && r.ring === ri);
        const ring = simplifiedRings[idx];
        if (ring.length < 4) {
          if (ri === 0) outRings.length = 0;
          return;
        }
        if (ri > 0 && outRings.length === 0) return; // exterior collapsed: drop its holes too
        outRings.push(ring);
      });
      if (outRings.length && area(turfPolygon([outRings[0]])) >= 50) polys.push(outRings);
    });
    const geometry: Polygon | MultiPolygon =
      polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    return { type: 'Feature', properties: { code: lad.code, borough: lad.name, id: lad.id }, geometry };
  });
}

/** Land mask in the London-local frame (src/data/landMask.ts projects with the game's geo origin). */
function londonMask(features: LandFeature[], cell = MASK_CELL): LandMask {
  const tx = (p: Position): Position => {
    const [x, y] = londonLocal(p[0], p[1]);
    return toLonLat(x, y);
  };
  const fc: LandCollection = {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: { code: f.properties.code, borough: f.properties.borough },
      geometry:
        f.geometry.type === 'Polygon'
          ? { type: 'Polygon', coordinates: f.geometry.coordinates.map((r) => r.map(tx)) }
          : { type: 'MultiPolygon', coordinates: f.geometry.coordinates.map((p) => p.map((r) => r.map(tx))) },
    })),
  };
  return new LandMask(fc, cell);
}

/** Water cells not connected to the mask edge (holes or inter-borough slivers). */
function enclosedWater(mask: LandMask): { components: number; cells: number; examples: string[] } {
  const { w, h, data } = mask;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const flood = (start: number): number => {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && !seen[j] && data[j] === 0) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    return tail;
  };
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) if (!seen[y * w + x] && data[y * w + x] === 0) flood(y * w + x);
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) if (!seen[y * w + x] && data[y * w + x] === 0) flood(y * w + x);
  }
  let components = 0;
  let cells = 0;
  const examples: string[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] !== 0 || seen[i]) continue;
    const n = flood(i);
    components++;
    cells += n;
    if (examples.length < 6) {
      const x = mask.x0 + ((i % w) + 0.5) * mask.cell;
      const y = mask.y0 + (Math.floor(i / w) + 0.5) * mask.cell;
      const lon = ORIGIN[0] + x / KX;
      const lat = ORIGIN[1] + y / KY;
      examples.push(`${n} cells near ${lat.toFixed(5)},${lon.toFixed(5)}`);
    }
  }
  return { components, cells, examples };
}

// ---------------------------------------------------------------------------- main

// ---------------------------------------------------------------------------
// Inland water from OpenStreetMap (via the OpenFreeMap vector tiles the game already uses). The ONS
// boundaries are clipped at mean high water, which removes the tidal Thames but leaves the docks,
// the Thames above Teddington Lock and the reservoirs as "land".
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const WATER_Z = 12;
const WATER_CLASSES = new Set(['river', 'lake', 'dock', 'reservoir', 'basin']);
/** Ignore tiny ponds and slivers (m²). */
const WATER_MIN_AREA = 5_000;

function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
}

async function fetchWater(lads: Lad[]): Promise<Feature<Polygon | MultiPolygon>[]> {
  const path = join(CITY_CACHE, `water_z${WATER_Z}.geojson`);
  if (existsSync(path)) {
    const fc = JSON.parse(readFileSync(path, 'utf8')) as { features: Feature<Polygon | MultiPolygon>[] };
    return fc.features;
  }
  const tj = (await (await fetch(TILEJSON)).json()) as { tiles?: string[] };
  const tmpl = tj.tiles?.[0];
  if (!tmpl) throw new Error('OpenFreeMap TileJSON has no tile URL');
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const l of lads) {
    const [a, b, c, d] = bbox(l.geometry);
    w = Math.min(w, a); s = Math.min(s, b); e = Math.max(e, c); n = Math.max(n, d);
  }
  const [x0, y0] = lonLatToTile(w, n, WATER_Z);
  const [x1, y1] = lonLatToTile(e, s, WATER_Z);
  const out: Feature<Polygon | MultiPolygon>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const url = tmpl.replace('{z}', String(WATER_Z)).replace('{x}', String(x)).replace('{y}', String(y));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`water tile ${WATER_Z}/${x}/${y}: HTTP ${res.status}`);
      const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
      const layer = vt.layers.water;
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const cls = String(f.properties.class ?? '');
        if (!WATER_CLASSES.has(cls) || f.properties.intermittent === 1) continue;
        const gj = f.toGeoJSON(x, y, WATER_Z) as Feature;
        if (!isPolyGeometry(gj.geometry)) continue;
        out.push({ type: 'Feature', properties: { class: cls }, geometry: gj.geometry });
      }
    }
  writeFileSync(path, JSON.stringify({ type: 'FeatureCollection', features: out }));
  return out;
}

/** Cut inland water out of the borough polygons. Returns m² removed per class. */
function subtractWater(lads: Lad[], water: Feature<Polygon | MultiPolygon>[]): Map<string, number> {
  const removed = new Map<string, number>();
  // Small ponds can't change the map at the mask's resolution: skip them before the (slow) cuts.
  const wb = water.filter((f) => area(f) >= WATER_MIN_AREA).map((f) => ({ f, b: bbox(f) }));
  for (const lad of lads) {
    const [a, b, c, d] = bbox(lad.geometry);
    let g: Polygon | MultiPolygon = lad.geometry;
    for (const { f, b: [p, q, r, t] } of wb) {
      if (r < a || p > c || t < b || q > d) continue;
      try {
        const before = area(g);
        const next = difference(featureCollection([{ type: 'Feature', properties: {}, geometry: g }, f]));
        if (!next || !isPolyGeometry(next.geometry)) continue;
        const cut = before - area(next.geometry);
        if (cut < WATER_MIN_AREA) continue; // skip slivers along the already-clipped tidal river
        g = next.geometry;
        const cls = String(f.properties?.class ?? '');
        removed.set(cls, (removed.get(cls) ?? 0) + cut);
      } catch {
        // Degenerate geometry from tile clipping: leave this piece of water out.
      }
    }
    lad.geometry = g;
  }
  return removed;
}

async function build(id: UkMetroId): Promise<void> {
  SPEC = UK_METROS[id];
  REGION_CODES = new Set(SPEC.regions.map((r) => r.id));
  setFrame(SPEC.origin);
  CITY_CACHE = join(ROOT, 'scripts', '.cache', id);
  OUT = join(ROOT, 'public', 'data', id);
  report.length = 0;
  const SOURCE = sourceFor(SPEC);
  const EXPECTED_LADS = SPEC.regions.length;
  const inRegion = (code: string) => REGION_CODES.has(code);
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(CITY_CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // ------------------------------------------------------------------ 1. downloads
  log(`== ${SPEC.name} (${SPEC.region}) ==`);
  log('1/6 Downloads (national files cached in scripts/.cache/london)…');
  const zipPath = join(CACHE, 'wu03ew_msoa.zip');
  await download(OD_ZIP_URL, zipPath, 5_000_000);
  const incomePath = join(CACHE, 'income_total_weekly_2011-12.csv');
  await download(INCOME_URL, incomePath, 100_000);
  const ladWhere = `lad11cd IN (${SPEC.regions.map((r) => `'${r.id}'`).join(',')})`;
  let ladSource = 'FCB';
  let ladFeats: Feature[];
  try {
    ladFeats = await cachedLayer('lad11_fcb.geojson', () => arcgisQuery(LAD_FCB_LAYER, ladWhere, 'lad11cd,lad11nm'), EXPECTED_LADS, CITY_CACHE);
  } catch (err) {
    log(`  ! full-resolution LAD boundaries failed (${(err as Error).message}); using generalised (GCB)`);
    ladSource = 'GCB';
    ladFeats = await cachedLayer('lad11_gcb.geojson', () => arcgisQuery(LAD_GCB_LAYER, ladWhere, 'lad11cd,lad11nm'), EXPECTED_LADS, CITY_CACHE);
  }
  const pwcFeats = await cachedLayer(
    'msoa11_pwc_ew.geojson',
    () => arcgisQuery(PWC_LAYER, '1=1', 'msoa11cd,msoa11nm'),
    7000,
  );

  // ------------------------------------------------------------------ 2. geography
  log(`2/6 Selecting ${SPEC.region}'s districts and MSOAs…`);
  const lads: Lad[] = [];
  for (const f of ladFeats) {
    const p = isObj(f.properties) ? f.properties : {};
    const code = String(p.lad11cd ?? '');
    if (!inRegion(code)) continue;
    if (!isPolyGeometry(f.geometry)) fail(`LAD ${code}: bad geometry`);
    lads.push({ id: code, code: 0, name: cleanName(p.lad11nm), geometry: f.geometry });
  }
  const order = new Map(SPEC.regions.map((r, i) => [r.id, i]));
  lads.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  if (lads.length !== EXPECTED_LADS || new Set(lads.map((l) => l.id)).size !== EXPECTED_LADS) fail(`Expected ${EXPECTED_LADS} LADs, got ${lads.length}`);
  lads.forEach((l, i) => {
    l.code = i + 1;
    const r = SPEC.regions[i];
    if (l.name !== (r.onsName ?? r.name)) fail(`LAD ${l.id} is called ${JSON.stringify(l.name)} in the boundaries, ${JSON.stringify(r.onsName ?? r.name)} in ukMetroRegions.ts`);
    l.name = r.name;
  });
  const ladById = new Map(lads.map((l) => [l.id, l]));

  // Income first: its MSOA → local authority codes select the MSOAs.
  const incomeText = readFileSync(incomePath, 'latin1');
  const incLines = incomeText.split(/\r?\n/);
  const hi = incLines.findIndex((l) => l.startsWith('MSOA code'));
  if (hi < 0) fail('income CSV: header row not found');
  const ih = parseCsvLine(incLines[hi]);
  const cCode = ih.indexOf('MSOA code');
  const cLad = ih.indexOf('Local authority code');
  const cInc = ih.findIndex((h) => h.startsWith('Total weekly income'));
  if (cCode < 0 || cLad < 0 || cInc < 0) fail('income CSV: unexpected header ' + ih.join(' | '));
  const income = new Map<string, number>();
  const incomeLad = new Map<string, string>();
  for (let i = hi + 1; i < incLines.length; i++) {
    const c = parseCsvLine(incLines[i]);
    if (c.length <= cInc || !/^[EW]02\d{6}$/.test(c[cCode])) continue;
    const v = Number(c[cInc].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 50 && v < 20000) income.set(c[cCode], v);
    incomeLad.set(c[cCode], c[cLad]);
  }
  const selected = new Set([...incomeLad.entries()].filter(([, l]) => inRegion(l)).map(([m]) => m));
  EXPECTED_MSOAS = selected.size;

  // Centroids for those MSOAs; their names ("Bolton 012", "Bristol 001") must match the district.
  const pwc = new Map<string, { name: string; lad: Lad; lon: number; lat: number }>();
  let nameMismatch = 0;
  for (const f of pwcFeats) {
    const p = isObj(f.properties) ? f.properties : {};
    const mid = String(p.msoa11cd ?? '');
    if (!selected.has(mid)) continue;
    const name = String(p.msoa11nm ?? '');
    const lad = ladById.get(incomeLad.get(mid)!)!;
    const m = /^(.+) (\d{3})$/.exec(name);
    const r = SPEC.regions.find((x) => x.id === lad.id)!;
    if (!m || (m[1] !== r.name && m[1] !== r.onsName && !(r.onsName ?? '').startsWith(m[1]))) nameMismatch++;
    const g = f.geometry as Point | null;
    if (!g || g.type !== 'Point' || !isPosition(g.coordinates)) fail(`PWC ${mid}: bad geometry`);
    pwc.set(mid, { name: cleanName(name), lad, lon: g.coordinates[0], lat: g.coordinates[1] });
  }
  const msoaIds = [...pwc.keys()].sort();
  if (msoaIds.length !== EXPECTED_MSOAS) fail(`Expected ${EXPECTED_MSOAS} MSOAs (income file), got ${msoaIds.length} centroids`);
  if (nameMismatch) fail(`MSOA → district cross-check failed: ${nameMismatch} centroid names don't match their district`);

  // MSOA boundaries (full resolution, clipped) for these MSOAs only.
  const bfcFeats = await cachedLayer(
    'msoa11_bfc.geojson',
    async () => {
      const all: Feature[] = [];
      for (let i = 0; i < msoaIds.length; i += 200) {
        const list = msoaIds.slice(i, i + 200).map((x) => `'${x}'`).join(',');
        all.push(...(await arcgisQuery(MSOA_BFC_LAYER, `MSOA11CD IN (${list})`, 'MSOA11CD,MSOA11NM,Shape__Area')));
        log(`  … ${all.length} MSOA boundaries`);
      }
      return all;
    },
    EXPECTED_MSOAS,
    CITY_CACHE,
  );
  const msoas = new Map<string, Msoa>();
  for (const f of bfcFeats) {
    const p = isObj(f.properties) ? f.properties : {};
    const mid = String(p.MSOA11CD ?? '');
    const pw = pwc.get(mid);
    if (!pw) continue;
    if (!isPolyGeometry(f.geometry)) fail(`MSOA ${mid}: bad geometry`);
    msoas.set(mid, {
      id: mid,
      name: pw.name,
      lad: pw.lad,
      pwc: [pw.lon, pw.lat],
      geometry: f.geometry,
      areaM2: area(f as Feature<Polygon | MultiPolygon>),
      shapeArea: Number(p.Shape__Area),
    });
  }
  if (msoas.size !== EXPECTED_MSOAS) fail(`MSOA boundaries: got ${msoas.size} of ${EXPECTED_MSOAS}`);

  // ------------------------------------------------------------------ 3. land polygons
  log('3/6 Land polygons (inland water removed, topology-preserving simplification)…');
  const water = await fetchWater(lads);
  const waterRemoved = subtractWater(lads, water);
  const land = simplifyLand(lads, LAND_TOLERANCE_M);
  const landFc = { type: 'FeatureCollection' as const, features: land };
  writeFileSync(join(OUT, 'land.geojson'), JSON.stringify(landFc));
  const rawLand: LandFeature[] = lads.map((l) => ({
    type: 'Feature',
    properties: { code: l.code, borough: l.name, id: l.id },
    geometry: l.geometry,
  }));
  const countVerts = (fs: LandFeature[]) =>
    fs.reduce((s, f) => s + polygonsOf(f.geometry).reduce((t, p) => t + p.reduce((u, r) => u + r.length, 0), 0), 0);
  const maskRaw = londonMask(rawLand);
  const mask = londonMask(land);
  let landRaw = 0;
  let landDiff = 0;
  let codeDiff = 0;
  for (let i = 0; i < mask.data.length; i++) {
    const a = maskRaw.data[i];
    if (a) landRaw++;
    if (!a !== !mask.data[i]) landDiff++;
    else if (a && a !== mask.data[i]) codeDiff++;
  }
  const encRaw = enclosedWater(maskRaw);
  const enc = enclosedWater(mask);
  const codeAt = (lon: number, lat: number) => {
    const [x, y] = londonLocal(lon, lat);
    return mask.codeAt(x, y);
  };
  const ladName = (code: number) => (code ? lads[code - 1].name : 'water/outside');
  const probeLines: string[] = [];
  for (const [label, lon, lat, want] of SPEC.probes) {
    const got = codeAt(lon, lat);
    const gotName = ladName(got);
    const ok = want === null ? got === 0 : gotName === want;
    probeLines.push(`  ${ok ? 'ok ' : 'BAD'} ${label}: ${gotName}`);
    if (!ok && want !== null) fail(`Land mask: ${label} should be in ${want} but is ${gotName}`);
  }
  probeLines.push(
    `  inland water removed (OSM via OpenFreeMap z${WATER_Z}, ${water.length} polygons): ` +
      [...waterRemoved.entries()].map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)} km²`).join(' · '),
  );

  // ------------------------------------------------------------------ 4. internal points
  log('4/6 Internal points (population-weighted centroids, moved onto land / main part if needed)…');
  const ladFeat = new Map(land.map((f) => [f.properties.code, f]));
  const moved: string[] = [];
  const points = new Map<string, [number, number]>();
  for (const id of msoaIds) {
    const m = msoas.get(id)!;
    const main = mainPart(m.geometry);
    const own = ladFeat.get(m.lad.code)!;
    const valid = (lon: number, lat: number) =>
      booleanPointInPolygon([lon, lat], main) && booleanPointInPolygon([lon, lat], own);
    const [lon0, lat0] = m.pwc;
    if (valid(lon0, lat0)) {
      points.set(id, [lon0, lat0]);
      continue;
    }
    const why = !booleanPointInPolygon([lon0, lat0], own)
      ? codeAt(lon0, lat0) === 0
        ? 'in water'
        : `in ${ladName(codeAt(lon0, lat0))}`
      : 'off the main part';
    // Nearest point (to the original centroid) that is inside the main part, on the borough's land,
    // and at least `inset` metres from either edge.
    const stepM = Math.max(8, Math.min(40, Math.sqrt(area(main)) / 80));
    const inset = Math.min(30, 2 * stepM);
    const [bx0, by0, bx1, by1] = (() => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of main.geometry.coordinates[0]) {
        a = Math.min(a, p[0]);
        b = Math.min(b, p[1]);
        c = Math.max(c, p[0]);
        d = Math.max(d, p[1]);
      }
      return [a, b, c, d];
    })();
    const dLon = stepM / KX;
    const dLat = stepM / KY;
    const cands: [number, number, number][] = [];
    for (let lon = bx0 + dLon / 2; lon < bx1; lon += dLon)
      for (let lat = by0 + dLat / 2; lat < by1; lat += dLat) cands.push([lon, lat, haversine(lat, lon, lat0, lon0)]);
    cands.sort((a, b) => a[2] - b[2]);
    let pick: [number, number] | null = null;
    let fallback: [number, number] | null = null;
    const iLon = inset / KX;
    const iLat = inset / KY;
    for (const [lon, lat] of cands) {
      if (!valid(lon, lat)) continue;
      fallback ??= [lon, lat];
      if (valid(lon + iLon, lat) && valid(lon - iLon, lat) && valid(lon, lat + iLat) && valid(lon, lat - iLat)) {
        pick = [lon, lat];
        break;
      }
    }
    const pt = pick ?? fallback ?? (pointOnFeature(main).geometry.coordinates as [number, number]);
    const np: [number, number] = [+pt[0].toFixed(6), +pt[1].toFixed(6)];
    points.set(id, np);
    moved.push(
      `  ${id} ${m.name.padEnd(26)} ${why}: moved ${fmt(haversine(lat0, lon0, np[1], np[0]))} m to ${np[1]},${np[0]}`,
    );
  }

  // ------------------------------------------------------------------ 5. OD
  log(`5/6 Reading the census flow table (within ${SPEC.region})…`);
  const csv = readZipEntry(zipPath, OD_ZIP_ENTRY).toString('utf8');
  const N = msoaIds.length;
  const index = new Map(msoaIds.map((id, i) => [id, i]));
  let pos = csv.indexOf('\n');
  if (pos < 0) fail('OD CSV: no header');
  const header = parseCsvLine(csv.slice(0, pos).replace(/\r$/, ''));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) fail(`OD CSV: missing column "${name}" (header: ${header.join(' | ')})`);
    return i;
  };
  const cRes = col('Area of residence');
  const cWork = col('Area of workplace');
  const cAll = col('All categories: Method of travel to work');
  const cWfh = col('Work mainly at or from home');
  const modeCols: [string, number[]][] = [
    ['Underground/metro/light rail/tram', [col('Underground, metro, light rail, tram')]],
    ['Train', [col('Train')]],
    ['Bus/coach', [col('Bus, minibus or coach')]],
    ['Car or van (driver + passenger)', [col('Driving a car or van'), col('Passenger in a car or van')]],
    ['Bicycle', [col('Bicycle')]],
    ['On foot', [col('On foot')]],
    ['Taxi/motorcycle/other', [col('Taxi'), col('Motorcycle, scooter or moped'), col('Other method of travel to work')]],
  ];
  const modeSums = new Float64Array(modeCols.length);
  const pairs = new Map<number, number>(); // h * N + w → commuters
  let rows = 0;
  let bad = 0;
  const ctx = { resAll: 0, wfh: 0, noFixed: 0, offshoreAbroad: 0, outside: 0, inFromOutside: 0, internal: 0 };
  const isLondon = (code: string) => index.has(code); // inside the map
  while (pos < csv.length) {
    let end = csv.indexOf('\n', pos + 1);
    if (end < 0) end = csv.length;
    const line = csv.slice(pos + 1, end).replace(/\r$/, '');
    pos = end;
    if (!line) continue;
    rows++;
    const res = line.slice(0, 9);
    const workStart = line.indexOf(',') + 1;
    const work = line.slice(workStart, line.indexOf(',', workStart));
    const resL = isLondon(res);
    if (!resL && !isLondon(work)) continue;
    const c = line.split(',');
    if (c.length !== header.length) {
      bad++;
      continue;
    }
    const all = Number(c[cAll]);
    const wfh = Number(c[cWfh]);
    if (!Number.isInteger(all) || !Number.isInteger(wfh) || all < 0 || wfh < 0 || wfh > all) {
      bad++;
      continue;
    }
    const commuters = all - wfh;
    if (!resL) {
      ctx.inFromOutside += commuters;
      continue;
    }
    if (c[cRes] !== res || c[cWork] !== work) fail('OD CSV: column order changed');
    ctx.resAll += all;
    ctx.wfh += wfh;
    if (work === 'OD0000001') ctx.wfh += commuters; // "Mainly work at or from home" workplace code
    else if (work === 'OD0000003') ctx.noFixed += commuters; // no fixed place
    else if (work === 'OD0000002' || work === 'OD0000004') ctx.offshoreAbroad += commuters; // offshore / outside UK
    else if (!isLondon(work)) ctx.outside += commuters; // rest of E&W, Scotland, N. Ireland
    else if (commuters > 0) {
      const key = index.get(res)! * N + index.get(work)!;
      pairs.set(key, (pairs.get(key) ?? 0) + commuters);
      ctx.internal += commuters;
      // Modes: scale the row's mode counts to exclude the (zero, for MSOA workplaces) WFH column.
      modeCols.forEach(([, cs], k) => {
        for (const ci of cs) modeSums[k] += Number(c[ci]) || 0;
      });
    }
  }
  if (bad > 0) log(`  ! ${bad} malformed rows skipped`);
  log(`  ${fmt(rows)} rows read, ${fmt(pairs.size)} internal MSOA pairs, ${fmt(ctx.internal)} commuters`);

  // ------------------------------------------------------------------ 6. bands, tracts, files
  log('6/6 Earnings bands, tracts.json, od.bin…');
  const homeTotal = new Float64Array(N);
  const workTotal = new Float64Array(N);
  for (const [key, n] of pairs) {
    homeTotal[Math.floor(key / N)] += n;
    workTotal[key % N] += n;
  }
  // Job-dominated MSOAs (the City, the West End): one point serves both ends, and the
  // population-weighted centroid follows the few residents (the City's sits on the Barbican estate,
  // 800 m from Bank). Use the main part's centre of mass there instead, when it is valid land.
  const jobMoved: string[] = [];
  msoaIds.forEach((id, i) => {
    if (workTotal[i] <= JOB_DOMINATED_RATIO * Math.max(1, homeTotal[i])) return;
    const m = msoas.get(id)!;
    const main = mainPart(m.geometry);
    const c = centerOfMass(main).geometry.coordinates as [number, number];
    const own = ladFeat.get(m.lad.code)!;
    if (!booleanPointInPolygon(c, main) || !booleanPointInPolygon(c, own)) return;
    const [lon0, lat0] = points.get(id)!;
    points.set(id, [c[0], c[1]]);
    jobMoved.push(`${id} ${m.name.padEnd(24)} ${fmt(workTotal[i])} jobs / ${fmt(homeTotal[i])} residents: moved ${fmt(haversine(lat0, lon0, c[1], c[0]))} m to the centre of the area`);
  });
  // Income per home MSOA (borough median as a fallback; none are expected to be missing).
  let missingIncome = 0;
  const mu = new Float64Array(N);
  msoaIds.forEach((id, i) => {
    let y = income.get(id);
    if (y === undefined) {
      missingIncome++;
      const same = msoaIds.filter((o) => pwc.get(o)!.lad === pwc.get(id)!.lad && income.has(o)).map((o) => income.get(o)!);
      same.sort((a, b) => a - b);
      y = same[Math.floor(same.length / 2)] ?? 800;
    }
    mu[i] = Math.log(y);
  });
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
  const totalCommuters = homeTotal.reduce((a, b) => a + b, 0);
  const shareBelow = (t: number) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += homeTotal[i] * sigmoid((t - mu[i]) / BAND_SCALE);
    return s / totalCommuters;
  };
  const solve = (target: number) => {
    let lo = Math.log(50);
    let hiT = Math.log(20000);
    for (let k = 0; k < 100; k++) {
      const mid = (lo + hiT) / 2;
      if (shareBelow(mid) < target) lo = mid;
      else hiT = mid;
    }
    return (lo + hiT) / 2;
  };
  const t1 = solve(BAND_MODEL.targetLow);
  const t2 = solve(1 - BAND_MODEL.targetHigh);
  const shares: [number, number, number][] = [];
  for (let i = 0; i < N; i++) {
    const pL = sigmoid((t1 - mu[i]) / BAND_SCALE);
    const pH = 1 - sigmoid((t2 - mu[i]) / BAND_SCALE);
    shares.push([pL, 1 - pL - pH, pH]);
  }
  // Integer split. Within each home MSOA, people are assigned one at a time to the band furthest
  // below its expected count (largest deficit), visiting destinations in a fixed hash order. Each
  // pair keeps its exact total and each home MSOA's band totals are within ±1 of its shares.
  const byHome: number[][] = Array.from({ length: N }, () => []);
  for (const key of pairs.keys()) byHome[Math.floor(key / N)].push(key % N);
  const hashOrder = (h: number, w: number) => (Math.imul(w + 1, 0x9e3779b1) ^ Math.imul(h + 7, 0x85ebca6b)) >>> 0;
  const rowsOut: { h: number; w: number; se: [number, number, number] }[] = [];
  for (let h = 0; h < N; h++) {
    const p = shares[h];
    const assigned = [0, 0, 0];
    let s = 0;
    const ws = byHome[h].sort((a, b) => hashOrder(h, a) - hashOrder(h, b));
    for (const w of ws) {
      const n = pairs.get(h * N + w)!;
      const se: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < n; k++) {
        s++;
        let b = 0;
        let best = -Infinity;
        for (let j = 0; j < 3; j++) {
          const d = p[j] * s - assigned[j];
          if (d > best + 1e-12) {
            best = d;
            b = j;
          }
        }
        assigned[b]++;
        se[b]++;
      }
      rowsOut.push({ h, w, se });
    }
  }
  rowsOut.sort((a, b) => a.h - b.h || a.w - b.w);
  let maxCount = 0;
  for (const r of rowsOut) for (const v of r.se) maxCount = Math.max(maxCount, v);
  if (maxCount > 65535) fail(`A band count of ${maxCount} does not fit od.bin's Uint16`);

  type LondonTract = Omit<TractRecord, 'borough'> & { borough: string; name: string };
  const tracts: LondonTract[] = msoaIds.map((id, i) => {
    const m = msoas.get(id)!;
    const [lon, lat] = points.get(id)!;
    return {
      id,
      name: m.name,
      borough: m.lad.name,
      lat: +lat.toFixed(6),
      lon: +lon.toFixed(6),
      radius: Math.round(Math.sqrt(Math.max(m.areaM2, 20_000) / Math.PI)),
      residents: homeTotal[i],
      jobs: workTotal[i],
    };
  });
  const od = encodeOD(N, rowsOut);
  writeFileSync(join(OUT, 'od.bin'), od);
  const tractsFile: Omit<TractsFile, 'tracts'> & {
    city: string;
    attribution: string;
    boroughs: { code: number; id: string; name: string }[];
    bandModel: Record<string, unknown>;
    tracts: LondonTract[];
  } = {
    version: 1,
    synthetic: false,
    year: 2011,
    source: SOURCE,
    bands: BANDS,
    city: id,
    attribution: ATTRIBUTION,
    boroughs: lads.map((l) => ({ code: l.code, id: l.id, name: l.name })),
    bandModel: {
      method:
        'Ordered logit on ln(home MSOA mean total weekly household income, ONS 2011/12); thresholds calibrated so the map\'s commuters split 30/40/30',
      logisticScale: +BAND_SCALE.toFixed(4),
      thresholdsGbpPerWeek: [Math.round(Math.exp(t1)), Math.round(Math.exp(t2))],
    },
    tracts,
  };
  writeFileSync(join(OUT, 'tracts.json'), JSON.stringify(tractsFile));

  // Round trip through the game's decoder.
  const back = decodeOD(new Uint8Array(od).buffer);
  let backTotal = 0;
  let sortedOk = true;
  for (let i = 0; i < back.pairCount; i++) {
    backTotal += back.counts[0][i] + back.counts[1][i] + back.counts[2][i];
    if (i > 0 && (back.home[i] < back.home[i - 1] || (back.home[i] === back.home[i - 1] && back.work[i] <= back.work[i - 1])))
      sortedOk = false;
  }
  if (backTotal !== ctx.internal || back.tractCount !== N || !sortedOk) fail('od.bin round trip failed');

  // ------------------------------------------------------------------ report
  const bandTotals = [0, 1, 2].map((b) => rowsOut.reduce((s, r) => s + r.se[b], 0));
  let intraBorough = 0;
  let intraMsoa = 0;
  let distSum = 0;
  for (const r of rowsOut) {
    const n = r.se[0] + r.se[1] + r.se[2];
    const a = tracts[r.h];
    const b = tracts[r.w];
    if (a.borough === b.borough) intraBorough += n;
    if (r.h === r.w) intraMsoa += n;
    distSum += n * haversine(a.lat, a.lon, b.lat, b.lon);
  }
  const total = ctx.internal;
  rep(`================ SANITY REPORT — ${SPEC.name.toUpperCase()} (${SPEC.region}) ================`);
  rep(`Source: ${SOURCE}`);
  rep(`Year: 2011 · LAD boundaries: ${ladSource} · MSOA boundaries: BFC V3`);
  rep(`Districts: ${lads.length}   MSOAs: ${N} (by the income file's LA codes; centroid names cross-checked)`);
  rep(`OD MSOA pairs: ${fmt(rowsOut.length)}   Total internal commuters: ${fmt(total)}`);
  rep(`  (commuters = all − work mainly at/from home; ${fmt(rows)} OD rows read; ${bad} malformed)`);
  rep(
    `Context, residents in work: ${fmt(ctx.resAll)} · mainly at/from home ${fmt(ctx.wfh)} · no fixed place ${fmt(ctx.noFixed)} · offshore/abroad ${fmt(ctx.offshoreAbroad)} · work outside the map ${fmt(ctx.outside)}`,
  );
  rep(`  In-commuters from outside the map (excluded, like NYC): ${fmt(ctx.inFromOutside)}`);
  rep(
    `2011 actual modes of these commuters (with the real network): ` +
      modeCols.map(([name], k) => `${name} ${pct(modeSums[k] / total)}`).join(' · '),
  );
  rep(`Mean straight-line commute (centroid to centroid): ${(distSum / total / 1000).toFixed(1)} km`);
  rep(`Intra-borough trips: ${pct(intraBorough / total)} · intra-MSOA trips: ${pct(intraMsoa / total)}`);
  rep('');
  rep(`Bands (${BANDS.join(' / ')}):`);
  rep(
    `  totals ${bandTotals.map((v) => fmt(v)).join(' / ')} = ${bandTotals.map((v) => pct(v / total)).join(' / ')}`,
  );
  rep(
    `  model: logistic scale ${BAND_SCALE.toFixed(3)} (log-earnings SD ${BAND_MODEL.logSd}), thresholds ≈ £${fmt(Math.exp(t1))} and £${fmt(Math.exp(t2))}/wk household-income equivalent; income missing for ${missingIncome} MSOAs`,
  );
  const highShares = shares.map((s) => s[2]).sort((a, b) => a - b);
  const lowShares = shares.map((s) => s[0]).sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
  const incs = msoaIds.map((id) => income.get(id) ?? 0).sort((a, b) => a - b);
  rep(`  MSOA income £/wk: min ${incs[0]} · p10 ${q(incs, 0.1)} · median ${q(incs, 0.5)} · p90 ${q(incs, 0.9)} · max ${incs[incs.length - 1]}`);
  rep(
    `  per-MSOA high-band share: min ${pct(highShares[0])} · p10 ${pct(q(highShares, 0.1))} · median ${pct(q(highShares, 0.5))} · p90 ${pct(q(highShares, 0.9))} · max ${pct(highShares[N - 1])}`,
  );
  rep(
    `  per-MSOA low-band share:  min ${pct(lowShares[0])} · p10 ${pct(q(lowShares, 0.1))} · median ${pct(q(lowShares, 0.5))} · p90 ${pct(q(lowShares, 0.9))} · max ${pct(lowShares[N - 1])}`,
  );
  rep('');
  rep('Borough                   Residents       Jobs  MSOAs  High-band');
  const byBorough = lads.map((l) => {
    const ts = tracts.map((t, i) => [t, i] as const).filter(([t]) => t.borough === l.name);
    const r = ts.reduce((s, [t]) => s + t.residents, 0);
    const j = ts.reduce((s, [t]) => s + t.jobs, 0);
    const hb = ts.reduce((s, [t, i]) => s + t.residents * shares[i][2], 0);
    return { name: l.name, r, j, n: ts.length, hb: r ? hb / r : 0 };
  });
  for (const b of byBorough.sort((a, c) => c.j - a.j))
    rep(`${b.name.padEnd(24)} ${fmt(b.r).padStart(10)} ${fmt(b.j).padStart(10)} ${String(b.n).padStart(6)} ${pct(b.hb).padStart(10)}`);
  rep('');
  rep('Top 10 job MSOAs:');
  const top = tracts
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.jobs - a.t.jobs)
    .slice(0, 10);
  for (const { t } of top)
    rep(`  ${t.id}  ${t.name.padEnd(26)} ${fmt(t.jobs).padStart(8)} jobs  near ${nearestLandmark(t.lat, t.lon)}`);
  rep('Top 5 resident MSOAs:');
  for (const t of [...tracts].sort((a, b) => b.residents - a.residents).slice(0, 5))
    rep(`  ${t.id}  ${t.name.padEnd(26)} ${fmt(t.residents).padStart(8)} commuters`);
  rep('');
  rep(`Internal points: ${moved.length} of ${N} population-weighted centroids were moved onto the main land part:`);
  for (const m of moved) rep(m);
  rep(`Job-dominated areas (jobs > ${JOB_DOMINATED_RATIO}× residents) placed at their centre of area: ${jobMoved.length}`);
  for (const m of jobMoved) rep('  ' + m);
  const radii = tracts.map((t) => t.radius).sort((a, b) => a - b);
  let areaDev = 0;
  for (const m of msoas.values())
    if (Number.isFinite(m.shapeArea) && m.shapeArea > 0) areaDev = Math.max(areaDev, Math.abs(m.areaM2 / m.shapeArea - 1));
  rep(
    `Radius sqrt(area/π): min ${radii[0]} m · median ${q(radii, 0.5)} m · p90 ${q(radii, 0.9)} m · max ${radii[N - 1]} m (geodesic vs ONS BNG area within ${pct(areaDev, 2)})`,
  );
  rep('');
  rep(
    `Land: ${land.length} borough polygons, ${fmt(countVerts(rawLand))} → ${fmt(countVerts(land))} vertices (shared-arc Douglas–Peucker, ${LAND_TOLERANCE_M} m)`,
  );
  rep(
    `  ${MASK_CELL} m mask: ${fmt(landRaw)} land cells (${((landRaw * MASK_CELL * MASK_CELL) / 1e6).toFixed(0)} km²); simplified vs full-res: ${pct(landDiff / landRaw, 2)} land/water cells differ, ${pct(codeDiff / landRaw, 3)} borough codes differ`,
  );
  rep(
    `  enclosed water (holes or slivers) — full-res: ${encRaw.components} components / ${encRaw.cells} cells; simplified: ${enc.components} components / ${enc.cells} cells`,
  );
  for (const e of enc.examples) rep(`    ${e}`);
  for (const l of probeLines) rep(l);
  rep('');
  rep(`od.bin: ${fmt(rowsOut.length)} pairs, largest band count ${fmt(maxCount)} (Uint16 limit 65,535), round trip ok, sorted by home then work`);
  const sizes = ['tracts.json', 'od.bin', 'land.geojson'].map(
    (f) => `${f} ${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`,
  );
  rep(`Output (public/data/${id}): ` + sizes.join(' · '));
  rep(`Attribution: ${ATTRIBUTION}`);
  rep('=========================================================');
  log('');
  for (const l of report) log(l);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const ids = arg ? [arg] : UK_METRO_IDS;
  for (const id of ids) {
    if (!(UK_METRO_IDS as string[]).includes(id)) fail(`Unknown city ${JSON.stringify(id)}: one of ${UK_METRO_IDS.join(', ')}`);
    await build(id as UkMetroId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
