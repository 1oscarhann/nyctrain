/**
 * Headway — Japan high-speed data pipeline: intercity travel between the 207 living areas of the
 * 2015 national passenger survey, spread over every municipality of the four main islands.
 *
 *   npm run data:japan
 *
 * Premise: Japan, but the Shinkansen was never built (nor the airport rail links). The trips are
 * real; the high-speed network is the player's.
 *
 * Inputs (cached in scripts/.cache/japan/; all parsed as untrusted data)
 *   MLIT 2015 全国幹線旅客純流動調査 (inter-regional passenger survey): trips a weekday between the 207
 *     生活圏 (living areas) by purpose and main mode, home area → destination (001297411.csv).
 *     Every trip that leaves a prefecture, both legs of each journey.
 *   MLIT 国土数値情報 N03 administrative areas (2024-01-01), per prefecture: municipality polygons.
 *   Statistics Bureau 2020 Census, 500 m mesh population (e-Stat T001141).
 *   MLIT 国土数値情報 G04-a elevation and slope, 1 km (third-order) mesh (2011).
 *   MIC 全国地方公共団体コード (2024-01-01): municipality names in kana, for the romanised names.
 *
 * Tracts are municipalities (wards of the 20 designated cities merged into their city; Tokyo's 23
 * special wards kept), placed at their residents' centroid. Each area's trips are spread over its
 * municipalities by population at both ends, in lumps of LUMP people. A trip there and back is one
 * agent: residents of a tract = people from there travelling that day, jobs = visitors to it.
 * Earnings bands are trip purposes: private and other (visiting family, shopping, unknown), sightseeing,
 * business. The survey has no trips inside a prefecture or a metropolitan area; area pairs there at
 * least GRAVITY_MIN_KM apart get modelled trips (a Poisson gravity model fitted to the survey's own
 * pairs), so Fukuoka–Kitakyushu or Shizuoka–Hamamatsu are not empty.
 *
 * Outputs in public/data/japan/ (src/data/types.ts, odFormat.ts, world.ts, landMask.ts, and
 * src/data/relief.ts): tracts.json, od.bin, land.geojson, relief.bin.
 *
 * Attribution: 国土数値情報 (行政区域データ, 標高・傾斜度3次メッシュデータ), MLIT; 全国幹線旅客純流動調査, MLIT;
 * 2020 Census mesh statistics, Statistics Bureau of Japan (e-Stat); 全国地方公共団体コード, MIC.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { encodeOD } from '../src/data/odFormat';
import type { TractRecord, TractsFile } from '../src/data/types';
import type { LandCollection } from '../src/data/world';
import { JP_PREFECTURES } from '../src/cities/japanRegions';
import { JP_DROP_MUNICIPALITIES, JP_METROS, JP_ZONES, type JpZone } from './japanZones';
import { RELIEF_GRID, encodeRelief } from '../src/data/relief';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache', 'japan');
const OUT = join(ROOT, 'public', 'data', 'japan');

const OD_URL = 'https://www.mlit.go.jp/common/001297411.csv';
const N03_URL = (p: string) => `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_${p}_GML.zip`;
const POP_URL = (m: string) => `https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001141&code=${m}&downloadType=2`;
const G04_URL = (m: string) => `https://nlftp.mlit.go.jp/ksj/gml/data/G04-a/G04-a-11/G04-a-11_${m}-jgd_GML.zip`;
const CODES_URL = 'https://www.soumu.go.jp/main_content/000925835.xlsx';
/** mapshaper (topology-aware dissolve and simplify) for the municipality and prefecture outlines. */
const MAPSHAPER = process.env.MAPSHAPER ?? 'npx -y mapshaper@0.6.121';

const SOURCE =
  'MLIT 2015 inter-regional passenger survey (207 living areas, weekday, home → destination), spread over municipalities by 2020 Census 500 m mesh population; intra-prefecture and intra-metro pairs ≥ 40 km gravity-modelled';
const BANDS = ['Private and other trips (visiting, shopping, unknown purpose)', 'Sightseeing', 'Business'];

/** People per lump when an area pair's journeys are spread over its municipalities. */
const LUMP = 10;
/**
 * Modelled trips for missing area pairs at least this far apart (km, between population centroids):
 * inside a prefecture from 40 km; inside a metro area from 60 km (closer, its commuter railways
 * already do the job: Tokyo–Chiba is not high-speed business).
 */
const GRAVITY_MIN_KM = { pref: 40, metro: 60 };
/** The gravity model is fitted on survey pairs in this distance range (km). */
const GRAVITY_FIT_KM: [number, number] = [30, 300];
/** First-order meshes tried (the survey's main islands; Okinawa is beyond them). */
const MESH_LAT = [45, 68];
const MESH_LON = [28, 46];
/** Land polygons: Douglas–Peucker interval (m) and the smallest island kept (km²). */
const LAND_INTERVAL_M = 100;
const LAND_MIN_ISLAND_KM2 = 0.5;
/** The map's south edge: Tokyo's Ogasawara and Okinotori islands (and anything else south) are left out. */
const MAP_SOUTH = 30.0;

// ---------------------------------------------------------------------------- helpers

const report: string[] = [];
const log = (msg: string) => process.stdout.write(msg + '\n');
const rep = (msg = '') => report.push(msg);
function fail(msg: string): never {
  throw new Error(msg);
}
const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number, d = 1) => (100 * x).toFixed(d) + '%';
const rel = (p: string) => p.replace(ROOT + '/', '');

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function download(url: string, dest: string, minBytes: number): Promise<boolean> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) return true;
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (res.status === 404) return false;
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) fail(`response too small (${buf.length} bytes) for ${url}`);
  writeFileSync(dest, buf);
  log(`  saved   ${(buf.length / 1e6).toFixed(1)} MB → ${rel(dest)}`);
  return true;
}

/** Minimal ZIP reader (stored / deflate, no ZIP64): the first entry whose name matches. */
function zipEntry(buf: Buffer, match: (name: string) => boolean, what: string): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(`${what}: not a zip file`);
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < entries; e++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail(`${what}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nLen = buf.readUInt16LE(p + 28);
    const xLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nLen);
    p += 46 + nLen + xLen + cLen;
    if (!match(name)) continue;
    if (size > 600 * 1024 * 1024) fail(`${what}: entry too large`);
    if (buf.readUInt32LE(lho) !== 0x04034b50) fail(`${what}: bad local header`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(raw);
    if (method === 8) return inflateRawSync(raw, { maxOutputLength: size + 1 });
    fail(`${what}: unsupported compression ${method}`);
  }
  fail(`${what}: no matching entry`);
}

const sjis = new TextDecoder('shift_jis');

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

/** A first sheet of an .xlsx workbook as rows of strings (shared strings and inline values). */
function xlsxRows(buf: Buffer, sheet = 1): string[][] {
  const xml = (name: string) => zipEntry(buf, (n) => n === name, name).toString('utf8');
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared: string[] = [];
  // (Japanese workbooks carry phonetic runs, <rPh>, inside a string: not part of its text.)
  for (const si of xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g))
    shared.push(unesc([...si[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  const rows: string[][] = [];
  for (const row of xml(`xl/worksheets/sheet${sheet}.xml`).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...c[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] ?? '')?.[1] ?? '';
      cells[col] = /t="s"/.test(c[2]) ? shared[Number(v)] ?? '' : unesc(v);
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

/** dBASE III table (G04-a attributes): rows of trimmed strings by field name. */
function dbfRows(buf: Buffer): Record<string, string>[] {
  const n = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let p = 32; p < headerLen - 1 && buf[p] !== 0x0d; p += 32) fields.push({ name: buf.toString('latin1', p, p + 11).replace(/\0.*$/, ''), len: buf[p + 16] });
  const out: Record<string, string>[] = [];
  for (let r = 0; r < n; r++) {
    let p = headerLen + r * recLen;
    if (buf[p] === 0x2a) continue; // deleted
    p++;
    const rec: Record<string, string> = {};
    for (const f of fields) {
      rec[f.name] = buf.toString('latin1', p, p + f.len).trim();
      p += f.len;
    }
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------- mesh codes

/** South-west corner (lon, lat) and size of a Japanese standard grid square from its code (4, 6, 8 or 9 digits). */
function meshCell(code: string): { lon: number; lat: number; dLon: number; dLat: number } {
  if (!/^\d{4,9}$/.test(code)) fail(`bad mesh code ${code}`);
  let lat = Number(code.slice(0, 2)) / 1.5;
  let lon = Number(code.slice(2, 4)) + 100;
  let dLat = 2 / 3, dLon = 1;
  if (code.length >= 6) {
    lat += Number(code[4]) / 12;
    lon += Number(code[5]) / 8;
    dLat = 1 / 12;
    dLon = 1 / 8;
  }
  if (code.length >= 8) {
    lat += Number(code[6]) / 120;
    lon += Number(code[7]) / 80;
    dLat = 1 / 120;
    dLon = 1 / 80;
  }
  if (code.length === 9) {
    const q = Number(code[8]);
    if (q < 1 || q > 4) fail(`bad half-mesh code ${code}`);
    if (q >= 3) lat += 1 / 240;
    if (q === 2 || q === 4) lon += 1 / 160;
    dLat = 1 / 240;
    dLon = 1 / 160;
  }
  return { lon, lat, dLon, dLat };
}

// ---------------------------------------------------------------------------- romanised names

const KANA: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n', ヴ: 'vu',
};
const SMALL_Y: Record<string, string> = { ャ: 'a', ュ: 'u', ョ: 'o' };
const SMALL_V: Record<string, string> = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };
/** Readings the long-vowel rules get wrong (おお inside a word is sometimes one long ō, sometimes two). */
const ROMAJI_FIX: Record<string, string> = { Kooriyama: 'Koriyama', Kooriyamashi: 'Koriyama', Oozu: 'Ozu', Ooita: 'Oita', Oosaka: 'Osaka' };

/** Modified Hepburn without macrons ("Tōkyō" → "Tokyo"), from a katakana reading. */
export function romaji(kana: string): string {
  const k = kana.normalize('NFKC').replace(/[\s　・]/g, '');
  let out = '';
  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    if (c === 'ー') continue;
    if (c === 'ッ') {
      const next = KANA[k[i + 1]] ?? '';
      out += next.startsWith('ch') ? 't' : next[0] ?? '';
      continue;
    }
    let s = KANA[c];
    if (s === undefined) {
      if (SMALL_V[c] && out) {
        out = out.replace(/[aiueo]$/, '') + SMALL_V[c];
        continue;
      }
      fail(`unexpected kana ${JSON.stringify(c)} in ${JSON.stringify(kana)}`);
    }
    const y = SMALL_Y[k[i + 1]];
    if (y) {
      s = s === 'shi' ? 'sh' + y : s === 'chi' ? 'ch' + y : s === 'ji' ? 'j' + y : s.replace(/i$/, '') + 'y' + y;
      i++;
    }
    out += s;
  }
  out = out.replace(/ou/g, 'o').replace(/uu/g, 'u').replace(/^oo/, 'o');
  const name = out.charAt(0).toUpperCase() + out.slice(1);
  return ROMAJI_FIX[name] ?? name;
}

/** The reading without the 市 / 町 / 村 / 区 suffix. */
function stripSuffix(kanji: string, kana: string): string {
  const k = kana.normalize('NFKC').replace(/[\s　]/g, '');
  const last = kanji.slice(-1);
  if (last === '市' && k.endsWith('シ')) return k.slice(0, -1);
  if (last === '区' && k.endsWith('ク')) return k.slice(0, -1);
  if (last === '町') return k.endsWith('マチ') ? k.slice(0, -2) : k.endsWith('チョウ') ? k.slice(0, -3) : k;
  if (last === '村') return k.endsWith('ムラ') ? k.slice(0, -2) : k.endsWith('ソン') ? k.slice(0, -2) : k;
  return k;
}

// ---------------------------------------------------------------------------- polygons

interface Muni {
  code: string;
  pref: number;
  sub: string;
  county: string;
  name: string;
  km2: number;
  polys: Position[][][];
  /** Designated-city wards merge into the city (its code); everything else is its own tract. */
  tract: string;
}

function polysOf(g: Polygon | MultiPolygon | null): Position[][][] {
  if (!g) return [];
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

/** Scanline fill of polygons (even–odd per polygon) into a lon/lat grid. */
class LonLatGrid {
  readonly cols: number;
  readonly rows: number;
  readonly data: Uint16Array;
  constructor(readonly lon0: number, readonly lat0: number, readonly dLon: number, readonly dLat: number, lon1: number, lat1: number) {
    this.cols = Math.round((lon1 - lon0) / dLon);
    this.rows = Math.round((lat1 - lat0) / dLat);
    this.data = new Uint16Array(this.cols * this.rows);
  }
  fill(polys: Position[][][], value: number): void {
    const { lon0, lat0, dLon, dLat, cols, rows } = this;
    for (const poly of polys) {
      const edges: number[] = [];
      let r0 = rows, r1 = -1;
      for (const ring of poly)
        for (let i = 0; i + 1 < ring.length; i++) {
          const [xa, ya] = ring[i], [xb, yb] = ring[i + 1];
          if (ya === yb) continue;
          edges.push(xa, ya, xb, yb);
          r0 = Math.min(r0, Math.max(0, Math.ceil((Math.min(ya, yb) - lat0) / dLat - 0.5)));
          r1 = Math.max(r1, Math.min(rows - 1, Math.floor((Math.max(ya, yb) - lat0) / dLat - 0.5)));
        }
      const xs: number[] = [];
      for (let r = r0; r <= r1; r++) {
        const y = lat0 + (r + 0.5) * dLat;
        xs.length = 0;
        for (let e = 0; e < edges.length; e += 4) {
          const ya = edges[e + 1], yb = edges[e + 3];
          if ((ya <= y && yb > y) || (yb <= y && ya > y)) xs.push(edges[e] + ((y - ya) / (yb - ya)) * (edges[e + 2] - edges[e]));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] - lon0) / dLon - 0.5));
          const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - lon0) / dLon - 0.5));
          for (let c = c0; c <= c1; c++) this.data[r * cols + c] = value;
        }
      }
    }
  }
  cellOf(lon: number, lat: number): number {
    const c = Math.floor((lon - this.lon0) / this.dLon), r = Math.floor((lat - this.lat0) / this.dLat);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }
}

// ---------------------------------------------------------------------------- inputs

function mapshaper(args: string): void {
  execFileSync('bash', ['-c', `${MAPSHAPER} ${args}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4000' } });
}

async function prefectureOutlines(): Promise<void> {
  mkdirSync(join(CACHE, 'n03'), { recursive: true });
  mkdirSync(join(CACHE, 'ms'), { recursive: true });
  for (const { code } of JP_PREFECTURES) {
    const p = String(code).padStart(2, '0');
    const muni = join(CACHE, 'ms', `muni_${p}.json`), pref = join(CACHE, 'ms', `pref_${p}.json`);
    if (existsSync(muni) && existsSync(pref)) continue;
    const gj = join(CACHE, 'n03', `N03_${p}.geojson`);
    if (!existsSync(gj)) {
      const zip = join(CACHE, 'n03', `N03_${p}.zip`);
      if (!(await download(N03_URL(p), zip, 100_000))) fail(`N03 ${p}: not found`);
      writeFileSync(gj, zipEntry(readFileSync(zip), (n) => n.endsWith('.geojson'), zip));
    }
    log(`  mapshaper prefecture ${p}`);
    mapshaper(`-i ${gj} -dissolve N03_007 copy-fields=N03_001,N03_002,N03_003,N03_004 -each 'km2=this.area/1e6' -simplify dp interval=30 keep-shapes -o ${muni} format=geojson precision=0.00001`);
    mapshaper(`-i ${gj} -dissolve N03_001 -simplify dp interval=${LAND_INTERVAL_M} keep-shapes -filter-islands min-area=${LAND_MIN_ISLAND_KM2}km2 -o ${pref} format=geojson precision=0.0001`);
  }
}

async function meshFiles(): Promise<{ pop: string[]; g04: string[] }> {
  mkdirSync(join(CACHE, 'pop'), { recursive: true });
  mkdirSync(join(CACHE, 'g04'), { recursive: true });
  const pop: string[] = [], g04: string[] = [];
  for (let p = MESH_LAT[0]; p <= MESH_LAT[1]; p++)
    for (let u = MESH_LON[0]; u <= MESH_LON[1]; u++) {
      const m = `${p}${u}`;
      const pt = join(CACHE, 'pop', `${m}.txt`), pn = join(CACHE, 'pop', `${m}.none`);
      if (!existsSync(pt) && !existsSync(pn)) {
        const zip = join(CACHE, 'pop', `${m}.zip`);
        if (await download(POP_URL(m), zip, 100)) writeFileSync(pt, zipEntry(readFileSync(zip), (n) => n.endsWith('.txt'), zip));
        else writeFileSync(pn, '');
      }
      if (existsSync(pt)) pop.push(pt);
      const gd = join(CACHE, 'g04', `${m}.dbf`), gn = join(CACHE, 'g04', `${m}.none`);
      if (!existsSync(gd) && !existsSync(gn)) {
        const zip = join(CACHE, 'g04', `${m}.zip`);
        if (await download(G04_URL(m), zip, 100)) writeFileSync(gd, zipEntry(readFileSync(zip), (n) => n.endsWith('TertiaryMesh.dbf'), zip));
        else writeFileSync(gn, '');
      }
      if (existsSync(gd)) g04.push(gd);
    }
  return { pop, g04 };
}

/** Municipality code (5 digits) → romanised name, and designated-city ward → city. */
function codeTable(buf: Buffer): { names: Map<string, string>; wardCity: Map<string, string> } {
  const names = new Map<string, string>();
  const add = (code6: string, kanji: string, kana: string) => {
    if (!/^\d{6}$/.test(code6) || !kanji || !kana) return;
    names.set(code6.slice(0, 5), romaji(stripSuffix(kanji, kana)));
  };
  for (const r of xlsxRows(buf, 1).slice(1)) add(r[0], r[2], r[4]);
  const wardCity = new Map<string, string>();
  let city = '';
  for (const r of xlsxRows(buf, 2).slice(1)) {
    const code = r[0]?.slice(0, 5), kanji = r[2] ?? '';
    if (!code || !/^\d{5}$/.test(code)) continue;
    if (/市$/.test(kanji)) {
      city = code;
      add(r[0], kanji, r[4]);
    } else if (/区$/.test(kanji) && city) wardCity.set(code, city);
  }
  if (names.size < 1700) fail(`code list: only ${names.size} names`);
  if (wardCity.size < 170) fail(`code list: only ${wardCity.size} designated-city wards`);
  return { names, wardCity };
}

// ---------------------------------------------------------------------------- build

async function main(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  log('Inputs');
  const odPath = join(CACHE, 'od207_weekday_kr.csv');
  if (!(await download(OD_URL, odPath, 1_000_000))) fail('survey OD: not found');
  const codesPath = join(CACHE, 'soumu', '000925835.xlsx');
  mkdirSync(dirname(codesPath), { recursive: true });
  if (!(await download(CODES_URL, codesPath, 50_000))) fail('code list: not found');
  await prefectureOutlines();
  const meshes = await meshFiles();
  log(`  ${meshes.pop.length} population meshes, ${meshes.g04.length} elevation meshes`);

  // ---- municipalities
  const { names, wardCity } = codeTable(readFileSync(codesPath));
  const dropNames = new Map(JP_DROP_MUNICIPALITIES.map((d) => [d.pref, new Set(d.names)]));
  const munis: Muni[] = [];
  for (const { code: pc } of JP_PREFECTURES) {
    const fc = JSON.parse(readFileSync(join(CACHE, 'ms', `muni_${String(pc).padStart(2, '0')}.json`), 'utf8')) as { features: Feature<Polygon | MultiPolygon, Record<string, unknown>>[] };
    for (const f of fc.features) {
      const p = f.properties;
      const code = String(p.N03_007 ?? '');
      const name = String(p.N03_004 ?? '');
      if (!/^\d{5}$/.test(code) || !name || name === '所属未定地') continue;
      if (Number(code.slice(0, 2)) !== pc) fail(`municipality ${code} in prefecture ${pc}`);
      if (dropNames.get(pc)?.has(name)) continue;
      const polys = polysOf(f.geometry).filter((poly) => poly[0].some(([, lat]) => lat >= MAP_SOUTH));
      if (!polys.length) continue;
      munis.push({ code, pref: pc, sub: String(p.N03_002 ?? ''), county: String(p.N03_003 ?? ''), name, km2: Number(p.km2) || 0, polys, tract: wardCity.get(code) ?? code });
    }
  }
  log(`  ${munis.length} municipalities and wards`);

  // ---- population: each 500 m mesh to the municipality under its centre
  const grid = new LonLatGrid(128, 30, 1 / 160, 1 / 240, 146.5, 46);
  munis.forEach((m, i) => grid.fill(m.polys, i + 1));
  const mPop = new Float64Array(munis.length), mLon = new Float64Array(munis.length), mLat = new Float64Array(munis.length);
  let meshPop = 0, unplaced = 0, nearPlaced = 0;
  for (const file of meshes.pop) {
    const lines = sjis.decode(readFileSync(file)).split(/\r?\n/);
    for (const ln of lines.slice(2)) {
      const c = ln.split(',');
      if (c.length < 5 || !/^\d{9}$/.test(c[0]) || !/^\d+$/.test(c[4])) continue;
      const v = Number(c[4]);
      if (!v) continue;
      meshPop += v;
      const cell = meshCell(c[0]);
      const lon = cell.lon + cell.dLon / 2, lat = cell.lat + cell.dLat / 2;
      let k = grid.cellOf(lon, lat);
      let m = k >= 0 ? grid.data[k] : 0;
      if (!m && k >= 0) {
        // Coastal squares whose centre is just offshore: the commonest municipality around.
        const votes = new Map<number, number>();
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const kk = k + dr * grid.cols + dc;
            const x = kk >= 0 && kk < grid.data.length ? grid.data[kk] : 0;
            if (x) votes.set(x, (votes.get(x) ?? 0) + 1);
          }
        m = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
        if (m) nearPlaced += v;
      }
      if (!m) {
        unplaced += v;
        continue;
      }
      mPop[m - 1] += v;
      mLon[m - 1] += lon * v;
      mLat[m - 1] += lat * v;
    }
  }
  rep(`Population (2020 Census 500 m mesh): ${fmt(meshPop)} on the map's meshes; ${fmt(unplaced)} not on a kept municipality (dropped islands, offshore), ${fmt(nearPlaced)} placed from a neighbouring square`);

  // ---- tracts: municipalities, designated-city wards merged
  interface TractB {
    id: string;
    pref: number;
    sub: string;
    name: string;
    pop: number;
    lon: number;
    lat: number;
    km2: number;
    zone: number;
  }
  const byTract = new Map<string, TractB>();
  munis.forEach((m, i) => {
    let t = byTract.get(m.tract);
    if (!t) byTract.set(m.tract, (t = { id: m.tract, pref: m.pref, sub: m.sub, name: names.get(m.tract) ?? fail(`no name for ${m.tract} ${m.name}`), pop: 0, lon: 0, lat: 0, km2: 0, zone: 0 }));
    t.pop += mPop[i];
    t.lon += mLon[i];
    t.lat += mLat[i];
    t.km2 += m.km2;
  });
  const tractsB = [...byTract.values()].filter((t) => t.pop > 0);
  for (const t of tractsB) {
    t.lon /= t.pop;
    t.lat /= t.pop;
  }
  // A name in more than one prefecture: the biggest keeps it, the others get their prefecture in
  // brackets ("Fuchu" in Tokyo, "Fuchu (Hiroshima)"; "Yokohama", "Yokohama (Aomori)").
  const prefName = new Map(JP_PREFECTURES.map((p) => [p.code, p.name]));
  const biggest = new Map<string, TractB>();
  for (const t of tractsB) if ((biggest.get(t.name)?.pop ?? -1) < t.pop) biggest.set(t.name, t);
  for (const t of tractsB) if (biggest.get(t.name) !== t) t.name = `${t.name} (${prefName.get(t.pref)})`;

  // ---- zones
  const zoneByCode = new Map(JP_ZONES.map((z) => [z.code, z]));
  const kept = JP_ZONES.filter((z) => !z.drop);
  const near = (lon: number, lat: number, zs: JpZone[]) => {
    let best: JpZone | null = null, bd = Infinity;
    for (const z of zs) {
      const d = haversineKm(lon, lat, z.seed[0], z.seed[1]);
      if (d < bd) [best, bd] = [z, d];
    }
    return best ?? fail(`no zone for ${lon},${lat}`);
  };
  for (const t of tractsB) {
    if (t.pref === 13) t.zone = Number(t.id) <= 13123 ? 131 : 132;
    else if (t.pref === 1) {
      const cands = kept.filter((z) => z.pref === 1 && z.sub!.some((s) => t.sub.startsWith(s)));
      if (!cands.length) fail(`Hokkaido ${t.id}: no zone for subprefecture ${t.sub}`);
      t.zone = near(t.lon, t.lat, cands).code;
    } else t.zone = near(t.lon, t.lat, kept.filter((z) => z.pref === t.pref)).code;
  }
  tractsB.sort((a, b) => a.id.localeCompare(b.id));
  const zoneTracts = new Map<number, number[]>();
  tractsB.forEach((t, i) => (zoneTracts.get(t.zone) ?? zoneTracts.set(t.zone, []).get(t.zone)!).push(i));
  for (const z of kept) if (!zoneTracts.get(z.code)?.length) fail(`zone ${z.code} ${z.name}: no municipalities`);
  const zPop = new Map<number, number>(), zLon = new Map<number, number>(), zLat = new Map<number, number>();
  for (const [z, ids] of zoneTracts) {
    const p = ids.reduce((a, i) => a + tractsB[i].pop, 0);
    zPop.set(z, p);
    zLon.set(z, ids.reduce((a, i) => a + tractsB[i].lon * tractsB[i].pop, 0) / p);
    zLat.set(z, ids.reduce((a, i) => a + tractsB[i].lat * tractsB[i].pop, 0) / p);
  }
  writeFileSync(join(CACHE, 'tract-zones.json'), JSON.stringify(tractsB.map((t) => [t.id, t.name, t.lon, t.lat, t.zone, Math.round(t.pop)])));
  rep(`Tracts: ${tractsB.length} municipalities (${fmt(tractsB.reduce((a, t) => a + t.pop, 0))} people) in ${kept.length} survey areas`);

  // ---- survey trips: [home zone, destination zone] → trips by band
  const PURPOSE: Record<string, number> = { 仕事: 2, 観光: 1, '私用・帰省': 0, その他: 0, 不明: -1 };
  const trips = new Map<string, [number, number, number, number]>(); // bands 0..2, unknown
  let surveyTotal = 0, droppedTrips = 0;
  for (const ln of sjis.decode(readFileSync(odPath)).split(/\r?\n/).slice(2)) {
    const c = parseCsvLine(ln);
    if (c.length < 19 || !/^\d+$/.test(c[0]) || !/^\d+$/.test(c[3])) continue;
    const o = Number(c[0]), d = Number(c[3]);
    const v = Number(c[18] || 0);
    if (!Number.isFinite(v) || v < 0) fail(`bad trip count ${c[18]}`);
    if (!v) continue;
    const b = PURPOSE[c[7]];
    if (b === undefined) fail(`unknown purpose ${c[7]}`);
    surveyTotal += v;
    if (!zoneByCode.has(o) || !zoneByCode.has(d)) fail(`unknown zone ${o} or ${d}`);
    if (zoneByCode.get(o)!.drop || zoneByCode.get(d)!.drop) {
      droppedTrips += v;
      continue;
    }
    const key = `${o}-${d}`;
    const row = trips.get(key) ?? trips.set(key, [0, 0, 0, 0]).get(key)!;
    row[b < 0 ? 3 : b] += v;
  }
  const bandTotals = [0, 0, 0];
  for (const r of trips.values()) for (let b = 0; b < 3; b++) bandTotals[b] += r[b];
  const bandShare = bandTotals.map((x) => x / bandTotals.reduce((a, y) => a + y, 0));
  for (const r of trips.values()) {
    const known = r[0] + r[1] + r[2];
    for (let b = 0; b < 3; b++) r[b] += r[3] * (known > 0 ? r[b] / known : bandShare[b]);
    r[3] = 0;
  }
  rep(`Survey: ${fmt(surveyTotal)} trips a weekday; ${fmt(droppedTrips)} to or from islands off the map (${pct(droppedTrips / surveyTotal)})`);

  // ---- modelled trips where the survey has none (inside a prefecture or a metro area)
  // Survey 'prefectures': Hokkaido is four (zones 1x, 48x, 49x, 50x), the rest their JIS code (zone ÷ 10).
  const prefGroup = (z: number) => Math.floor(z / 10);
  const metroOf = (z: number) => JP_METROS.findIndex((m) => m.includes(zoneByCode.get(z)!.pref));
  const excluded = (a: number, b: number) => prefGroup(a) === prefGroup(b) || (metroOf(a) >= 0 && metroOf(a) === metroOf(b));
  const zKm = (a: number, b: number) => haversineKm(zLon.get(a)!, zLat.get(a)!, zLon.get(b)!, zLat.get(b)!);
  // Poisson regression ln E[T] = β0 + β1 ln Pa + β2 ln Pb + β3 ln d over every observable pair in the fit range.
  const X: number[][] = [], Y: number[] = [];
  for (const a of kept)
    for (const b of kept) {
      if (a.code === b.code || excluded(a.code, b.code)) continue;
      const d = zKm(a.code, b.code);
      if (d < GRAVITY_FIT_KM[0] || d > GRAVITY_FIT_KM[1]) continue;
      const r = trips.get(`${a.code}-${b.code}`);
      X.push([1, Math.log(zPop.get(a.code)! / 1e5), Math.log(zPop.get(b.code)! / 1e5), Math.log(d / 100)]);
      Y.push(r ? r[0] + r[1] + r[2] : 0);
    }
  const beta = poisson(X, Y);
  rep(`Gravity model on ${fmt(X.length)} survey pairs ${GRAVITY_FIT_KM[0]}–${GRAVITY_FIT_KM[1]} km: trips = ${Math.exp(beta[0]).toFixed(1)} × (Pa/100k)^${beta[1].toFixed(2)} × (Pb/100k)^${beta[2].toFixed(2)} × (d/100 km)^${beta[3].toFixed(2)}`);
  // Purpose mix of survey trips at these distances.
  const fitMix = [0, 0, 0];
  for (const [key, r] of trips) {
    const [a, b] = key.split('-').map(Number);
    const d = zKm(a, b);
    if (d >= GRAVITY_MIN_KM.pref && d <= GRAVITY_FIT_KM[1]) for (let k = 0; k < 3; k++) fitMix[k] += r[k];
  }
  const mixSum = fitMix.reduce((a, b) => a + b, 0);
  let modelled = 0, modelledPairs = 0;
  const examples: string[] = [];
  for (const a of kept)
    for (const b of kept) {
      if (a.code === b.code || !excluded(a.code, b.code) || trips.has(`${a.code}-${b.code}`)) continue;
      const d = zKm(a.code, b.code);
      const metro = metroOf(a.code) >= 0 && metroOf(a.code) === metroOf(b.code);
      if (d < (metro ? GRAVITY_MIN_KM.metro : GRAVITY_MIN_KM.pref)) continue;
      const t = Math.exp(beta[0] + beta[1] * Math.log(zPop.get(a.code)! / 1e5) + beta[2] * Math.log(zPop.get(b.code)! / 1e5) + beta[3] * Math.log(d / 100));
      if (t < 1) continue;
      trips.set(`${a.code}-${b.code}`, [(t * fitMix[0]) / mixSum, (t * fitMix[1]) / mixSum, (t * fitMix[2]) / mixSum, 0]);
      modelled += t;
      modelledPairs++;
      if (process.env.JP_DEBUG) log(`model ${a.name}–${b.name} ${Math.round(d)} km ${Math.round(t)} ${metro ? 'metro' : 'pref'}`);
      if (['Fukuoka-Kitakyushu', 'Shizuoka-Hamamatsu', 'Tokyo 23 wards-Odawara', 'Osaka-Himeji', 'Sapporo-Tomakomai', 'Nagoya-Toyohashi'].includes(`${a.name}-${b.name}`)) examples.push(`${a.name}–${b.name} ${fmt(t)}`);
    }
  rep(`Modelled: ${fmt(modelled)} trips on ${modelledPairs} area pairs inside a prefecture (≥ ${GRAVITY_MIN_KM.pref} km apart) or a metro area (≥ ${GRAVITY_MIN_KM.metro} km): ${examples.join(', ')}`);

  // ---- spread over municipalities: a journey there and back is one agent (half the trips)
  const rand = rng(20151001);
  const weights = (ids: number[]) => {
    const cum = new Float64Array(ids.length);
    let s = 0;
    ids.forEach((i, k) => (cum[k] = s += tractsB[i].pop));
    return { ids, cum, total: s };
  };
  const pick = (w: ReturnType<typeof weights>) => {
    const x = rand() * w.total;
    let lo = 0, hi = w.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (w.cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return w.ids[lo];
  };
  const zw = new Map([...zoneTracts].map(([z, ids]) => [z, weights(ids)]));
  const pairs = new Map<number, [number, number, number]>();
  let journeys = 0;
  const keys = [...trips.keys()].sort();
  for (const key of keys) {
    const r = trips.get(key)!;
    const [a, b] = key.split('-').map(Number);
    const wa = zw.get(a)!, wb = zw.get(b)!;
    for (let band = 0; band < 3; band++) {
      const lumps = r[band] / 2 / LUMP;
      let n = Math.floor(lumps);
      if (rand() < lumps - n) n++;
      for (let k = 0; k < n; k++) {
        const h = pick(wa), w = pick(wb);
        const pk = h * 65536 + w;
        const row = pairs.get(pk) ?? pairs.set(pk, [0, 0, 0]).get(pk)!;
        row[band] += LUMP;
        journeys += LUMP;
      }
    }
  }
  const rows = [...pairs.entries()].sort((x, y) => x[0] - y[0]).map(([k, se]) => ({ h: Math.floor(k / 65536), w: k % 65536, se }));
  if (rows.some((r) => r.se.some((c) => c > 65535))) fail('a pair exceeds the od.bin count limit');
  const residents = new Float64Array(tractsB.length), jobs = new Float64Array(tractsB.length);
  for (const r of rows) {
    const s = r.se[0] + r.se[1] + r.se[2];
    residents[r.h] += s;
    jobs[r.w] += s;
  }
  rep(`Journeys (there and back): ${fmt(journeys)} a weekday on ${fmt(rows.length)} municipality pairs (lumps of ${LUMP}); bands ${bandShare.map((x) => pct(x, 0)).join(' / ')} private / sightseeing / business`);

  // ---- distance profile
  const dist = [0, 0, 0, 0, 0, 0];
  const edges = [50, 100, 200, 400, 700];
  for (const r of rows) {
    const h = tractsB[r.h], w = tractsB[r.w];
    const d = haversineKm(h.lon, h.lat, w.lon, w.lat);
    let k = edges.findIndex((e) => d < e);
    if (k < 0) k = edges.length;
    dist[k] += r.se[0] + r.se[1] + r.se[2];
  }
  rep(`Journey lengths (straight line): <50 km ${pct(dist[0] / journeys)}, 50–100 ${pct(dist[1] / journeys)}, 100–200 ${pct(dist[2] / journeys)}, 200–400 ${pct(dist[3] / journeys)}, 400–700 ${pct(dist[4] / journeys)}, ≥700 ${pct(dist[5] / journeys)}`);

  // ---- tracts.json
  const tracts: TractRecord[] = tractsB.map((t, i) => ({
    id: t.id,
    borough: prefName.get(t.pref)!,
    name: t.name,
    lat: Math.round(t.lat * 1e5) / 1e5,
    lon: Math.round(t.lon * 1e5) / 1e5,
    radius: Math.round(Math.sqrt((Math.max(t.km2, 0.5) * 1e6) / Math.PI)),
    residents: residents[i],
    jobs: jobs[i],
    pop: Math.round(t.pop),
  }));
  const file: TractsFile = { version: 1, synthetic: false, year: 2015, source: SOURCE, bands: BANDS, tracts };
  writeFileSync(join(OUT, 'tracts.json'), JSON.stringify(file));
  writeFileSync(join(OUT, 'od.bin'), encodeOD(tracts.length, rows));

  // ---- land.geojson: one feature per prefecture
  const land: LandCollection = { type: 'FeatureCollection', features: [] };
  for (const p of JP_PREFECTURES) {
    const fc = JSON.parse(readFileSync(join(CACHE, 'ms', `pref_${String(p.code).padStart(2, '0')}.json`), 'utf8')) as { features: Feature<Polygon | MultiPolygon>[] };
    const polys = fc.features.flatMap((f) => polysOf(f.geometry)).filter((poly) => poly[0].some(([lon, lat]) => lat >= MAP_SOUTH && lon >= 128));
    if (!polys.length) fail(`prefecture ${p.code}: no land`);
    land.features.push({ type: 'Feature', properties: { code: p.code, borough: p.name }, geometry: { type: 'MultiPolygon', coordinates: polys } });
  }
  writeFileSync(join(OUT, 'land.geojson'), JSON.stringify(land));

  // ---- relief.bin: mean slope and elevation of each 1 km square
  const R = RELIEF_GRID;
  const slope = new Uint8Array(R.cols * R.rows), elev = new Uint8Array(R.cols * R.rows);
  let squares = 0;
  for (const f of meshes.g04)
    for (const r of dbfRows(readFileSync(f))) {
      const code = r.G04a_001;
      if (!/^\d{8}$/.test(code)) continue;
      const cell = meshCell(code);
      const c = Math.round((cell.lon - R.lon0) / R.dLon), rr = Math.round((cell.lat - R.lat0) / R.dLat);
      if (c < 0 || rr < 0 || c >= R.cols || rr >= R.rows) continue;
      const s = Number(r.G04a_010), e = Number(r.G04a_002);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e < -100 || e > 4000) continue;
      slope[rr * R.cols + c] = Math.min(255, 1 + Math.round(Math.max(0, s) * 8));
      elev[rr * R.cols + c] = Math.min(255, Math.max(0, Math.round(e / 16)));
      squares++;
    }
  writeFileSync(join(OUT, 'relief.bin'), encodeRelief(slope, elev, deflateRawSync));
  rep(`Relief: ${fmt(squares)} 1 km squares with elevation and slope`);

  // ---- report
  const top = tracts.map((t, i) => ({ t, n: residents[i] + jobs[i] })).sort((a, b) => b.n - a.n).slice(0, 12);
  rep(`Busiest tracts (journeys from + to): ${top.map(({ t, n }) => `${t.name} ${fmt(n)}`).join(', ')}`);
  const sizes = ['tracts.json', 'od.bin', 'land.geojson', 'relief.bin'].map((f) => `${f} ${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`);
  rep(`Wrote ${sizes.join(', ')}`);
  log('\n' + report.join('\n'));
}

/** Poisson regression by Newton–Raphson (IRLS) on a small design matrix. */
function poisson(X: number[][], Y: number[]): number[] {
  const k = X[0].length;
  const ybar = Y.reduce((a, b) => a + b, 0) / Y.length;
  let beta = Array.from({ length: k }, (_, i) => (i === 0 ? Math.log(ybar + 1e-9) : 0));
  for (let it = 0; it < 60; it++) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let n = 0; n < X.length; n++) {
      const x = X[n];
      const mu = Math.exp(x.reduce((a, xi, i) => a + xi * beta[i], 0));
      for (let i = 0; i < k; i++) {
        g[i] += (Y[n] - mu) * x[i];
        for (let j = 0; j < k; j++) H[i][j] += mu * x[i] * x[j];
      }
    }
    const step = solve(H, g);
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return beta;
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
