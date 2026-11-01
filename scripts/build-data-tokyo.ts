/**
 * Headway — Tokyo subway data pipeline: the 2020 Census commute into and around the 23 special
 * wards, spread over their ~900 towns (町), plus the suburban commuters arriving at the railway
 * terminals on the edge of the centre.
 *
 *   npm run data:tokyo
 *
 * Premise: Tokyo with its suburban railways but no subway, no Yamanote loop and no through-running
 * (src/cities/tokyoRegions.ts TK_TERMINALS). The commute is real; the network across town is the
 * player's.
 *
 * Inputs (cached in scripts/.cache/tokyo/; all parsed as untrusted data)
 *   Tokyo Metropolitan Government, 2020 daytime population (令和2年国勢調査による東京都の昼間人口):
 *     table 7-2: commuters 15+ (not working at home) by workplace and residence municipality,
 *       with residents of each neighbouring prefecture, and the wards' residents working there;
 *     table 11: daytime and night-time population of every town and chome.
 *   Statistics Bureau, 2020 Census small-area boundaries (小地域, e-Stat): chome polygons with
 *     their night-time population.
 *   MLIT 国土数値情報 L03-b 100 m land use (2021): river and lake squares, erased from the land
 *     (the census polygons run to the middle of the Sumida and the Arakawa).
 *   Japan Post KEN_ALL_ROME: official romanised town names.
 *
 * Tracts are towns (町; chome merged), placed at the centre of their residents and jobs. Residents
 * weight by night-time population; jobs by a daytime proxy, max(5% of D, D − 0.55·N) for daytime
 * population D and night-time population N (people commuting in, roughly). Each ward pair's
 * commuters are spread over its town pairs by residents × jobs × exp(−distance / PAIR_DECAY_M), in
 * lumps of LUMP people. Commuters from outside the wards (the Tama area and the neighbouring
 * prefectures) arrive at a terminal tract (TK_TERMINALS) chosen by direction and by how near it is
 * to their office; the wards' own residents working outside leave from one.
 *
 * Earnings bands: the census flow table has no income, so each home's commuters are split into
 * three bands from approximate taxable income per taxpayer of the home ward (MIC 市町村税課税状況等の調,
 * 2020, rounded) with an ordered logit, as the London pipeline does: lowest ~30%, middle ~40%,
 * top ~30%.
 *
 * Outputs in public/data/tokyo/ (src/data/types.ts, odFormat.ts, world.ts, landMask.ts):
 * tracts.json, od.bin, land.geojson.
 *
 * Attribution: 東京都の昼間人口 (令和2年), 東京都総務局統計部; 国勢調査 小地域境界 (令和2年), 総務省統計局
 * (e-Stat); 国土数値情報 土地利用細分メッシュ, MLIT; 住所の郵便番号 (ローマ字), 日本郵便.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { encodeOD } from '../src/data/odFormat';
import type { TractRecord, TractsFile } from '../src/data/types';
import type { LandCollection } from '../src/data/world';
import { TK_TERMINALS, TK_WARDS, type TkDirection } from '../src/cities/tokyoRegions';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache', 'tokyo');
const OUT = join(ROOT, 'public', 'data', 'tokyo');

const COMMUTE_URL = 'https://www.toukei.metro.tokyo.lg.jp/tyukanj/2020/tj20zv0702.csv';
const DAYTIME_URL = 'https://www.toukei.metro.tokyo.lg.jp/tyukanj/2020/tj20zv1100.csv';
const SMALL_AREA_URL = 'https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=13&coordSys=1&format=shape&downloadType=5&datum=2011';
const LANDUSE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/L03-b/L03-b-21/L03-b-21_5339-jgd2011_GML.zip';
const ROMAJI_URL = 'https://www.post.japanpost.jp/service/search/zipcode/download/roman/KEN_ALL_ROME.zip';
/** mapshaper (topology-aware dissolve, erase and simplify) for the ward outlines. */
const MAPSHAPER = process.env.MAPSHAPER ?? 'npx -y mapshaper@0.6.121';

const SOURCE =
  '2020 Census commuting (15+, not working at home) by ward of residence and workplace, Tokyo Metropolitan Government; spread over towns by night-time population and a daytime-population jobs proxy; commuters from outside the 23 wards arrive at suburban railway terminals';
const BANDS = ['B1 lower-income ~30% (modelled from home ward income)', 'B2 middle-income ~40% (modelled)', 'B3 higher-income ~30% (modelled)'];

/** People per lump when a ward pair's commuters are spread over its town pairs. */
const LUMP = 4;
/** Town pairs inside a ward pair: weight × exp(−d / PAIR_DECAY_M). */
const PAIR_DECAY_M = 5000;
/** Terminal choice: share × exp(−distance to the office / TERMINAL_DECAY_M). */
const TERMINAL_DECAY_M = 4000;
/** A terminal tract's radius (the station and its forecourt), m. */
const TERMINAL_RADIUS_M = 250;
/** River squares (100 m) erased from the land: connected runs at least this long (moats and ponds smaller are left). */
const RIVER_MIN_CELLS = 4;
/** Land outlines: Douglas–Peucker interval (m) and the smallest island kept (km²). */
const LAND_INTERVAL_M = 15;
const LAND_MIN_ISLAND_KM2 = 0.02;
/** Jobs proxy: max(JOB_FLOOR·D, D − JOB_OUT·N). */
const JOB_FLOOR = 0.05;
const JOB_OUT = 0.55;
/** Ward bounding box for the land-use squares (lon0, lat0, lon1, lat1). */
const BBOX = [139.55, 35.48, 139.95, 35.84];

/**
 * Taxable income per taxpayer, ¥ thousand (MIC 市町村税課税状況等の調, 2020, rounded to ¥100k): the
 * band model's home incomes. Commuters from outside the wards take their side's rough average.
 */
const WARD_INCOME: Record<string, number> = {
  Chiyoda: 9700, Chuo: 6900, Minato: 11600, Shinjuku: 5300, Bunkyo: 6200, Taito: 4300, Sumida: 3800, Koto: 4300,
  Shinagawa: 4800, Meguro: 6200, Ota: 4100, Setagaya: 5400, Shibuya: 8800, Nakano: 4200, Suginami: 4700, Toshima: 4500,
  Kita: 3700, Arakawa: 3600, Itabashi: 3600, Nerima: 4100, Adachi: 3400, Katsushika: 3500, Edogawa: 3600,
};
const DIRECTION_INCOME: Record<TkDirection, number> = { kanagawa: 4100, saitama: 3600, chiba: 3600, north: 3300, tama: 4000, other: 3600 };
/** Band model (pipeline parameters): see scripts/build-data-london.ts. */
const BAND_MODEL = { logSd: 0.7, targetLow: 0.3, targetHigh: 0.3 } as const;
const BAND_SCALE = (BAND_MODEL.logSd * Math.sqrt(3)) / Math.PI;

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

function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
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

async function download(url: string, dest: string, minBytes: number): Promise<void> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) return;
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) fail(`response too small (${buf.length} bytes) for ${url}`);
  writeFileSync(dest, buf);
  log(`  saved   ${(buf.length / 1e6).toFixed(1)} MB → ${rel(dest)}`);
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

/** A CSV of the Tokyo statistics (UTF-8, with or without a BOM; Shift_JIS as a fallback). */
function readCsv(path: string): string[][] {
  const buf = readFileSync(path);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf);
  return text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
}

/** A table cell as a count: "-", "…", "X" and blanks are 0. */
const num = (s: string | undefined) => (s && /^\d+$/.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : 0);

/** dBASE III table: rows of trimmed strings by field name. */
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

function mapshaper(args: string): void {
  execFileSync('bash', ['-c', `${MAPSHAPER} ${args}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4000' } });
}

function polysOf(g: Polygon | MultiPolygon | null): Position[][][] {
  if (!g) return [];
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

// ---------------------------------------------------------------------------- names

const KANJI_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Kanji numerals up to 99 ("二十三" → 23). */
function kanjiNumber(s: string): number {
  let n = 0;
  let cur = 0;
  for (const c of s) {
    if (c === '十') {
      n += (cur || 1) * 10;
      cur = 0;
    } else cur = KANJI_DIGIT[c] ?? fail(`kanji number ${s}`);
  }
  return n + cur;
}

/** A place name for matching across sources: width, chome numerals and the ケ/が/ヶ and の/ノ/之 spellings unified. */
function normName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/([一二三四五六七八九十]+)丁目$/, (_, k: string) => `${kanjiNumber(k)}丁目`)
    .replace(/[ヶケがガ]/g, 'ケ')
    .replace(/[のノ之]/g, 'ノ')
    .replace(/鴬/g, '鶯')
    .replace(/涛/g, '濤');
}

/** A chome's town: the name without "N丁目". */
const townOf = (chome: string) => chome.replace(/[一二三四五六七八九十0-9０-９]+丁目$/, '');

const PREFIX: Record<string, string> = { 東: 'HIGASHI', 西: 'NISHI', 南: 'MINAMI', 北: 'KITA', 上: 'KAMI', 下: 'SHIMO', 中: 'NAKA', 元: 'MOTO', 新: 'SHIN' };

const SUFFIX: Record<string, string> = { 東: 'HIGASHI', 西: 'NISHI', 南: 'MINAMI', 北: 'KITA' };

/** Japan Post's romaji, made readable: "MARUNOCHI" → "MARUNOUCHI", "KUDAMMINAMI" → "KUDANMINAMI". */
function fixRomaji(kanji: string, roman: string): string {
  let r = roman.toUpperCase();
  // Japan Post folds の内 ("no-uchi") to NOCHI.
  if (/[のノ之]内/.test(kanji)) r = r.replace(/NOCHI/, 'NOUCHI');
  return r.replace(/MM/g, 'NM');
}

/** Longest common prefix of some strings. */
function commonPrefix(xs: string[]): string {
  let p = xs[0] ?? '';
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Word breaks a reader expects, from the shape of the ward's other town names: a direction or
 * 上/下/中/元/新 prefix on a name that stands alone or has siblings ("Nishi-Shinjuku", "Naka-Meguro",
 * "Shin-Kiba"), a direction suffix ("Omori-Kita", "Kudan-Minami"), and a town's name inside a longer
 * one ("Ikebukuro-Honcho", "Kanda-Awajicho", "Ichigaya-Takajomachi"). Then title case.
 */
function styleRomaji(kanji: string, r: string, ward: { kanji: string; raw: string }[], allTowns: Set<string>, rests: Map<string, Set<string>>): string {
  const cap = (w: string) => w.split('-').map((x) => x.charAt(0) + x.slice(1).toLowerCase()).join('-');
  const p = PREFIX[kanji[0]];
  const rest = kanji.slice(1);
  if (p && rest.length >= 2 && r.startsWith(p) && r.length > p.length + 2 && (allTowns.has(rest) || (rests.get(rest)?.size ?? 0) > 1))
    return `${cap(p)}-${cap(r.slice(p.length))}`;
  if (r.includes('-')) return cap(r);
  const sfx = SUFFIX[kanji[kanji.length - 1]];
  const stem = kanji.slice(0, -1);
  if (sfx && stem.length >= 2 && r.endsWith(sfx) && r.length > sfx.length + 2 && ward.some((t) => t.kanji !== kanji && (t.kanji === stem || t.kanji.startsWith(stem))))
    return `${cap(r.slice(0, -sfx.length))}-${cap(sfx)}`;
  for (let k = kanji.length - 2; k >= 2; k--) {
    const P = kanji.slice(0, k);
    const exact = ward.find((t) => t.kanji === P);
    let rp = exact?.raw ?? '';
    if (!exact) {
      const sibs = ward.filter((t) => t.kanji !== kanji && t.kanji.startsWith(P) && t.kanji.length >= P.length + 2);
      if (sibs.length < 2) continue;
      rp = commonPrefix([r, ...sibs.map((t) => t.raw)]);
      if (rp.length < 3) continue;
    }
    if (r.startsWith(rp) && r.length > rp.length + 2) return `${cap(rp)}-${cap(r.slice(rp.length))}`;
  }
  return cap(r);
}

// ---------------------------------------------------------------------------- build

interface Chome {
  city: number;
  town: string;
  name: string;
  n: number;
  d: number;
  j: number;
  x: number;
  y: number;
  m2: number;
}

interface Town {
  id: string;
  ward: number;
  kanji: string;
  name: string;
  n: number;
  j: number;
  lon: number;
  lat: number;
  m2: number;
}

async function main(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  log('Inputs');
  const commutePath = join(CACHE, 'tj20zv0702.csv');
  const daytimePath = join(CACHE, 'tj20zv1100.csv');
  const smallZip = join(CACHE, 'estat_r2ka13.zip');
  const landuseZip = join(CACHE, 'L03-b-21_5339.zip');
  const romajiZip = join(CACHE, 'rome.zip');
  await download(COMMUTE_URL, commutePath, 10_000);
  await download(DAYTIME_URL, daytimePath, 300_000);
  await download(SMALL_AREA_URL, smallZip, 1_000_000);
  await download(LANDUSE_URL, landuseZip, 1_000_000);
  await download(ROMAJI_URL, romajiZip, 500_000);

  // ---- small areas → GeoJSON (the 23 wards)
  const raw = join(CACHE, 'wards_raw.json');
  if (!existsSync(raw)) {
    const shp = join(CACHE, 'shp');
    mkdirSync(shp, { recursive: true });
    const zip = readFileSync(smallZip);
    for (const ext of ['shp', 'shx', 'dbf', 'prj']) writeFileSync(join(shp, `r2ka13.${ext}`), zipEntry(zip, (n) => n.toLowerCase().endsWith(`.${ext}`), smallZip));
    log('  mapshaper small areas');
    mapshaper(`-i ${join(shp, 'r2ka13.shp')} encoding=shiftjis -filter 'PREF=="13" && Number(CITY)>=101 && Number(CITY)<=123' -o ${raw} format=geojson precision=0.000001`);
  }

  // ---- rivers: 100 m land-use squares of river and lake, in connected runs
  const rivers = join(CACHE, 'rivers.json');
  if (!existsSync(rivers)) {
    const rows = dbfRows(zipEntry(readFileSync(landuseZip), (n) => n.endsWith('.dbf'), landuseZip));
    const cells = new Set<number>();
    const key = (i: number, j: number) => i * 4096 + j;
    for (const r of rows) {
      const code = r.L03b_001;
      if (r.L03b_002 !== '1100' || !/^\d{10}$/.test(code)) continue;
      const lat = Number(code.slice(0, 2)) / 1.5 + Number(code[4]) / 12 + Number(code[6]) / 120 + Number(code[8]) / 1200;
      const lon = Number(code.slice(2, 4)) + 100 + Number(code[5]) / 8 + Number(code[7]) / 80 + Number(code[9]) / 800;
      if (lon < BBOX[0] || lon > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) continue;
      cells.add(key(Math.round((lon - BBOX[0]) * 800), Math.round((lat - BBOX[1]) * 1200)));
    }
    const seen = new Set<number>();
    const features: Feature<Polygon>[] = [];
    for (const k0 of cells) {
      if (seen.has(k0)) continue;
      const comp: number[] = [];
      const stack = [k0];
      seen.add(k0);
      while (stack.length) {
        const k = stack.pop()!;
        comp.push(k);
        const i = Math.floor(k / 4096), j = k % 4096;
        for (let di = -1; di <= 1; di++)
          for (let dj = -1; dj <= 1; dj++) {
            const nk = key(i + di, j + dj);
            if (cells.has(nk) && !seen.has(nk)) {
              seen.add(nk);
              stack.push(nk);
            }
          }
      }
      if (comp.length < RIVER_MIN_CELLS) continue;
      for (const k of comp) {
        const x = BBOX[0] + Math.floor(k / 4096) / 800, y = BBOX[1] + (k % 4096) / 1200;
        features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 1 / 800, y], [x + 1 / 800, y + 1 / 1200], [x, y + 1 / 1200], [x, y]]] } });
      }
    }
    const cellsPath = join(CACHE, 'river_cells.json');
    writeFileSync(cellsPath, JSON.stringify({ type: 'FeatureCollection', features }));
    log(`  mapshaper rivers (${features.length} squares)`);
    mapshaper(`-i ${cellsPath} -dissolve -o ${rivers} format=geojson`);
  }

  // ---- land: wards without water areas and rivers
  const landWards = join(CACHE, 'land_wards.json');
  if (!existsSync(landWards)) {
    log('  mapshaper land');
    mapshaper(`-i ${raw} -filter 'HCODE==8101' -dissolve CITY -erase ${rivers} -simplify dp interval=${LAND_INTERVAL_M} keep-shapes -filter-islands min-area=${LAND_MIN_ISLAND_KM2}km2 -o ${landWards} format=geojson precision=0.00001`);
  }

  // ---- table 11: daytime and night-time population by town and chome
  const t11 = readCsv(daytimePath);
  const day = new Map<string, { d: number; n: number }>();
  const townDay = new Map<string, { d: number; n: number }>();
  for (const r of t11.slice(1)) {
    const city = Number(r[2]);
    if (!(city >= 101 && city <= 123)) continue;
    const level = r[10];
    const v = { d: num(r[16]), n: num(r[19]) };
    if (level === '50') day.set(`${city}|${normName(r[14])}`, v);
    else if (level === '41') {
      day.set(`${city}|${normName(r[13])}`, v);
      townDay.set(`${city}|${normName(r[13])}`, v);
    } else if (level === '40') townDay.set(`${city}|${normName(r[13])}`, v);
  }

  // ---- chomes
  const fc = JSON.parse(readFileSync(raw, 'utf8')) as { features: Feature<Polygon | MultiPolygon, Record<string, unknown>>[] };
  const chomes: Chome[] = [];
  let matchedN = 0, totalN = 0;
  for (const f of fc.features) {
    const p = f.properties;
    if (Number(p.HCODE) !== 8101) continue;
    const city = Number(p.CITY);
    const name = String(p.S_NAME ?? '');
    const kihon1 = String(p.KIHON1 ?? '');
    if (!name || !/^\d{4}$/.test(kihon1)) continue;
    const n = Number(p.JINKO) || 0;
    totalN += n;
    const m = day.get(`${city}|${normName(name)}`);
    if (m) matchedN += n;
    chomes.push({ city, town: kihon1, name, n, d: m ? m.d : -1, j: 0, x: Number(p.X_CODE), y: Number(p.Y_CODE), m2: Number(p.AREA) || 0 });
  }
  // Unmatched chomes share what is left of their town's daytime population, by residents.
  const byTown = new Map<string, Chome[]>();
  // A town is its name in a ward (a few names carry two town codes, as 四谷 in Shinjuku does).
  for (const c of chomes) {
    const k = `${c.city}|${normName(townOf(c.name))}`;
    (byTown.get(k) ?? byTown.set(k, []).get(k)!).push(c);
  }
  let dTotal = 0, dFromTown = 0;
  for (const cs of byTown.values()) {
    const open = cs.filter((c) => c.d < 0);
    if (open.length) {
      const t = townDay.get(`${cs[0].city}|${normName(townOf(cs[0].name))}`);
      const left = t ? Math.max(0, t.d - cs.filter((c) => c.d >= 0).reduce((a, c) => a + c.d, 0)) : -1;
      const w = open.reduce((a, c) => a + Math.max(c.n, 1), 0);
      for (const c of open) c.d = left >= 0 ? (left * Math.max(c.n, 1)) / w : c.n;
      if (left >= 0) dFromTown += left;
    }
    for (const c of cs) {
      c.j = Math.max(JOB_FLOOR * c.d, c.d - JOB_OUT * c.n);
      dTotal += c.d;
    }
  }
  rep(`Small areas: ${fmt(chomes.length)} chomes, ${fmt(totalN)} residents; ${pct(matchedN / totalN)} of residents in chomes matched to table 11 by name, ${fmt(dFromTown)} daytime people shared from town totals; daytime population ${fmt(dTotal)}`);

  // ---- romanised town names (Japan Post)
  const rome = new TextDecoder('shift_jis').decode(zipEntry(readFileSync(romajiZip), (n) => /KEN_ALL_ROME\.CSV$/i.test(n), romajiZip));
  const romaji = new Map<string, string>();
  const wardByJa = new Map(TK_WARDS.map((w) => [w.ja, w.code + 100]));
  for (const ln of rome.split(/\r?\n/)) {
    const c = parseCsvLine(ln);
    if (c.length < 7 || c[1] !== '東京都') continue;
    const city = wardByJa.get(c[2]);
    if (!city) continue;
    // "大手町　（次のビルを除く）", "大手町　ＪＡビル（１階）": the town is before the space. But
    // "赤城　下町" (AKAGI SHITAMACHI) is one town in two words: file it under both.
    const kanjiAll = c[3].split(/[（(]/)[0].trim();
    const romanAll = c[6].split('(')[0].trim();
    const kanji = kanjiAll.split(/[\s　]/)[0];
    // "田園調布南" is DENENCHOFU MINAMI: one word in kanji, two in romaji.
    const roman = /[\s　]/.test(kanjiAll) ? romanAll.split(/\s/)[0] : romanAll.split(/\s+/).join('-');
    if (!kanji || !roman || kanji === '以下に掲載がない場合') continue;
    const k = `${city}|${normName(kanji)}`;
    if (!romaji.has(k)) romaji.set(k, roman);
    const words = kanjiAll.split(/[\s　]+/), rwords = romanAll.split(/\s+/);
    if (words.length === 2 && rwords.length === 2 && !/[Ａ-Ｚａ-ｚビルタワー]/.test(words[1])) {
      const k2 = `${city}|${normName(words.join(''))}`;
      if (!romaji.has(k2)) romaji.set(k2, rwords.join('-'));
    }
  }

  // ---- towns
  const towns: Town[] = [];
  for (const [key, cs] of byTown) {
    const city = key.split('|')[0];
    const kihon1 = cs.map((c) => c.town).sort()[0];
    const n = cs.reduce((a, c) => a + c.n, 0), j = cs.reduce((a, c) => a + c.j, 0), m2 = cs.reduce((a, c) => a + c.m2, 0);
    if (n + j < 20) continue;
    const wsum = cs.reduce((a, c) => a + c.n + c.j, 0);
    const lon = cs.reduce((a, c) => a + c.x * (c.n + c.j), 0) / wsum, lat = cs.reduce((a, c) => a + c.y * (c.n + c.j), 0) / wsum;
    towns.push({ id: `${city}${kihon1}`, ward: Number(city) - 100, kanji: townOf(cs[0].name), name: '', n, j, lon, lat, m2 });
  }
  const allTowns = new Set(towns.map((t) => t.kanji));
  const rests = new Map<string, Set<string>>();
  for (const t of towns) if (PREFIX[t.kanji[0]] && t.kanji.length >= 3) (rests.get(t.kanji.slice(1)) ?? rests.set(t.kanji.slice(1), new Set()).get(t.kanji.slice(1))!).add(t.kanji[0]);
  const unnamed: string[] = [];
  const rawRomaji = towns.map((t) => {
    const r = romaji.get(`${t.ward + 100}|${normName(t.kanji)}`) ?? TOWN_ROMAJI[t.kanji];
    if (!r) unnamed.push(`${t.ward + 100} ${t.kanji}`);
    return r ? fixRomaji(t.kanji, r) : '';
  });
  const inWard = new Map<number, { kanji: string; raw: string }[]>();
  towns.forEach((t, i) => rawRomaji[i] && (inWard.get(t.ward) ?? inWard.set(t.ward, []).get(t.ward)!).push({ kanji: t.kanji, raw: rawRomaji[i] }));
  towns.forEach((t, i) => (t.name = rawRomaji[i] ? styleRomaji(t.kanji, rawRomaji[i], inWard.get(t.ward)!, allTowns, rests) : t.id));
  if (unnamed.length) log(`  no romanised name for ${unnamed.length} towns: ${unnamed.join(', ')}`);
  if (unnamed.length > 5) fail('too many towns without a romanised name: add them to TOWN_ROMAJI');
  const wardName = new Map(TK_WARDS.map((w) => [w.code, w.name]));
  // A name in more than one ward: the busiest keeps it, the others get their ward in brackets.
  const best = new Map<string, Town>();
  for (const t of towns) if ((best.get(t.name)?.n ?? -1) + (best.get(t.name)?.j ?? 0) < t.n + t.j) best.set(t.name, t);
  for (const t of towns) if (best.get(t.name) !== t) t.name = `${t.name} (${wardName.get(t.ward)})`;
  towns.sort((a, b) => a.id.localeCompare(b.id));
  rep(`Towns: ${towns.length} (${fmt(towns.reduce((a, t) => a + t.n, 0))} residents, jobs proxy ${fmt(towns.reduce((a, t) => a + t.j, 0))})`);

  // ---- tract list: towns, then terminals
  const NT = towns.length;
  interface Pt {
    lon: number;
    lat: number;
  }
  const pts: Pt[] = [...towns, ...TK_TERMINALS];
  const NTerm = TK_TERMINALS.length;
  const dist = (a: number, b: number) => haversineM(pts[a].lon, pts[a].lat, pts[b].lon, pts[b].lat);
  const wardTowns = new Map<number, number[]>();
  towns.forEach((t, i) => (wardTowns.get(t.ward) ?? wardTowns.set(t.ward, []).get(t.ward)!).push(i));

  // ---- table 7-2: commuters by workplace (rows) and residence (columns)
  const t72 = readCsv(commutePath);
  const head = t72[0];
  const col = (label: string) => head.findIndex((h) => h === label);
  const wardCol = new Map<number, number>();
  for (const w of TK_WARDS) {
    const c = col(`常住地／${w.ja}（人）`);
    if (c < 0) fail(`table 7-2: no column for ${w.ja}`);
    wardCol.set(w.code, c);
  }
  const dirCols: [TkDirection, string][] = [
    ['tama', '常住地／市部（人）'], ['tama', '常住地／郡部（人）'],
    ['north', '常住地が他道府県／関東地方／茨城県（人）'], ['north', '常住地が他道府県／関東地方／栃木県（人）'], ['north', '常住地が他道府県／関東地方／群馬県（人）'],
    ['saitama', '常住地が他道府県／関東地方／埼玉県（人）'], ['chiba', '常住地が他道府県／関東地方／千葉県（人）'], ['kanagawa', '常住地が他道府県／関東地方／神奈川県（人）'],
    ['other', '常住地が他道府県／他の道府県（人）'],
  ];
  for (const [, label] of dirCols) if (col(label) < 0) fail(`table 7-2: no column ${label}`);
  const rowOf = (code: string) => t72.find((r) => r[1] === code) ?? fail(`table 7-2: no row ${code}`);
  const flows: { kind: 'ward'; h: number; w: number; n: number }[] = [];
  const inbound: { w: number; dir: TkDirection; n: number }[] = [];
  const outbound: { h: number; dir: TkDirection; n: number }[] = [];
  for (const w of TK_WARDS) {
    const r = rowOf(String(13100 + w.code));
    for (const h of TK_WARDS) flows.push({ kind: 'ward', h: h.code, w: w.code, n: num(r[wardCol.get(h.code)!]) });
    for (const [dir, label] of dirCols) inbound.push({ w: w.code, dir, n: num(r[col(label)]) });
  }
  const outRows: [TkDirection, string][] = [['tama', '13200'], ['tama', '13300'], ['north', '08000'], ['north', '09000'], ['north', '10000'], ['saitama', '11000'], ['chiba', '12000'], ['kanagawa', '14000']];
  for (const [dir, code] of outRows) {
    const r = rowOf(code);
    for (const h of TK_WARDS) outbound.push({ h: h.code, dir, n: num(r[wardCol.get(h.code)!]) });
  }
  const otherRow = t72.find((r) => r[2] === '従業地・通学地／関東地方以外の道府県') ?? fail('table 7-2: no row for the other prefectures');
  for (const h of TK_WARDS) outbound.push({ h: h.code, dir: 'other', n: num(otherRow[wardCol.get(h.code)!]) });
  const sum = <T extends { n: number }>(xs: T[]) => xs.reduce((a, x) => a + x.n, 0);
  const wardsTotal = num(rowOf('13100')[col('常住地／区部（人）')]);
  if (Math.abs(sum(flows) - wardsTotal) > 10) fail(`table 7-2: ward flows ${sum(flows)} ≠ total ${wardsTotal}`);
  const dirTotals = new Map<TkDirection, number>();
  for (const x of inbound) dirTotals.set(x.dir, (dirTotals.get(x.dir) ?? 0) + x.n);
  rep(`Commuters (table 7-2): ${fmt(sum(flows))} between the wards; ${fmt(sum(inbound))} into them from outside (${[...dirTotals].map(([d, n]) => `${d} ${fmt(n)}`).join(', ')}); ${fmt(sum(outbound))} of their residents out`);

  // ---- terminal choice for a town and a direction
  const termShare = (i: number, dir: TkDirection): number[] => {
    const ws = TK_TERMINALS.map((t, k) => (t.from[dir] ?? 0) * Math.exp(-dist(i, NT + k) / TERMINAL_DECAY_M));
    const s = ws.reduce((a, b) => a + b, 0);
    if (!(s > 0)) fail(`no terminal for ${dir}`);
    return ws.map((w) => w / s);
  };

  // ---- spread over town pairs, in lumps
  const rand = rng(20201001);
  const pairs = new Map<number, number>();
  const add = (h: number, w: number, n: number) => pairs.set(h * 65536 + w, (pairs.get(h * 65536 + w) ?? 0) + n);
  const draw = (cells: { a: number; b: number; w: number }[], total: number) => {
    const lumps = total / LUMP;
    let n = Math.floor(lumps);
    if (rand() < lumps - n) n++;
    if (!n) return;
    const cum = new Float64Array(cells.length);
    let s = 0;
    cells.forEach((c, k) => (cum[k] = s += c.w));
    if (!(s > 0)) fail('no weight to spread commuters over');
    for (let k = 0; k < n; k++) {
      const x = rand() * s;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      add(cells[lo].a, cells[lo].b, LUMP);
    }
  };
  for (const f of flows) {
    if (!f.n) continue;
    const cells: { a: number; b: number; w: number }[] = [];
    for (const i of wardTowns.get(f.h)!) for (const j of wardTowns.get(f.w)!) cells.push({ a: i, b: j, w: towns[i].n * towns[j].j * Math.exp(-dist(i, j) / PAIR_DECAY_M) });
    draw(cells, f.n);
  }
  const termDir = TK_TERMINALS.map(() => new Map<TkDirection, number>());
  for (const x of inbound) {
    if (!x.n) continue;
    const cells: { a: number; b: number; w: number }[] = [];
    for (const j of wardTowns.get(x.w)!) termShare(j, x.dir).forEach((q, k) => q > 0 && cells.push({ a: NT + k, b: j, w: towns[j].j * q }));
    const before = new Map(TK_TERMINALS.map((_, k) => [k, 0]));
    for (const c of cells) before.set(c.a - NT, before.get(c.a - NT)! + c.w);
    const tw = [...before.values()].reduce((a, b) => a + b, 0);
    before.forEach((w, k) => termDir[k].set(x.dir, (termDir[k].get(x.dir) ?? 0) + (x.n * w) / tw));
    draw(cells, x.n);
  }
  for (const x of outbound) {
    if (!x.n) continue;
    const cells: { a: number; b: number; w: number }[] = [];
    for (const i of wardTowns.get(x.h)!) termShare(i, x.dir).forEach((q, k) => q > 0 && cells.push({ a: i, b: NT + k, w: towns[i].n * q }));
    draw(cells, x.n);
  }

  // ---- earnings bands from the home's income
  const N = NT + NTerm;
  const homeTotal = new Float64Array(N), workTotal = new Float64Array(N);
  for (const [k, n] of pairs) {
    homeTotal[Math.floor(k / 65536)] += n;
    workTotal[k % 65536] += n;
  }
  const mu = new Float64Array(N);
  towns.forEach((t, i) => (mu[i] = Math.log(WARD_INCOME[wardName.get(t.ward)!] ?? fail(`no income for ward ${t.ward}`))));
  TK_TERMINALS.forEach((_, k) => {
    let s = 0, w = 0;
    for (const [dir, n] of termDir[k]) {
      s += n * Math.log(DIRECTION_INCOME[dir]);
      w += n;
    }
    mu[NT + k] = w > 0 ? s / w : Math.log(3800);
  });
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
  const totalCommuters = homeTotal.reduce((a, b) => a + b, 0);
  const shareBelow = (t: number) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += homeTotal[i] * sigmoid((t - mu[i]) / BAND_SCALE);
    return s / totalCommuters;
  };
  const solveT = (target: number) => {
    let lo = Math.log(100), hi = Math.log(100_000);
    for (let k = 0; k < 100; k++) {
      const mid = (lo + hi) / 2;
      if (shareBelow(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const t1 = solveT(BAND_MODEL.targetLow), t2 = solveT(1 - BAND_MODEL.targetHigh);
  const shares = Array.from(mu, (m) => {
    const pL = sigmoid((t1 - m) / BAND_SCALE), pH = 1 - sigmoid((t2 - m) / BAND_SCALE);
    return [pL, 1 - pL - pH, pH];
  });
  // Integer split per home (largest deficit first, destinations in a fixed hash order).
  const byHome: number[][] = Array.from({ length: N }, () => []);
  for (const k of pairs.keys()) byHome[Math.floor(k / 65536)].push(k % 65536);
  const hashOrder = (h: number, w: number) => (Math.imul(w + 1, 0x9e3779b1) ^ Math.imul(h + 7, 0x85ebca6b)) >>> 0;
  const rows: { h: number; w: number; se: [number, number, number] }[] = [];
  for (let h = 0; h < N; h++) {
    const p = shares[h];
    const assigned = [0, 0, 0];
    let s = 0;
    for (const w of byHome[h].sort((a, b) => hashOrder(h, a) - hashOrder(h, b))) {
      const n = pairs.get(h * 65536 + w)!;
      const se: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < n; k++) {
        s++;
        let b = 0, bestD = -Infinity;
        for (let q = 0; q < 3; q++) {
          const d = p[q] * s - assigned[q];
          if (d > bestD + 1e-12) {
            bestD = d;
            b = q;
          }
        }
        assigned[b]++;
        se[b]++;
      }
      rows.push({ h, w, se });
    }
  }
  rows.sort((a, b) => a.h - b.h || a.w - b.w);
  const maxCount = rows.reduce((m, r) => Math.max(m, ...r.se), 0);
  if (maxCount > 65535) fail(`a band count of ${maxCount} does not fit od.bin's Uint16`);
  const bandTotals = [0, 1, 2].map((b) => rows.reduce((a, r) => a + r.se[b], 0));
  rep(`Bands: ${bandTotals.map((v) => `${fmt(v)} (${pct(v / totalCommuters)})`).join(' / ')}; thresholds ≈ ¥${fmt(Math.exp(t1))}k and ¥${fmt(Math.exp(t2))}k`);

  // ---- tracts.json
  const tracts: TractRecord[] = [];
  towns.forEach((t, i) => {
    tracts.push({
      id: t.id,
      borough: wardName.get(t.ward)!,
      name: t.name,
      lat: Math.round(t.lat * 1e5) / 1e5,
      lon: Math.round(t.lon * 1e5) / 1e5,
      radius: Math.round(Math.sqrt(Math.max(t.m2, 20_000) / Math.PI)),
      residents: homeTotal[i],
      jobs: workTotal[i],
    });
  });
  // A terminal is as dense to build through as the town around it.
  TK_TERMINALS.forEach((tm, k) => {
    let near = 0, bd = Infinity;
    towns.forEach((_, i) => {
      const d = dist(i, NT + k);
      if (d < bd) [near, bd] = [i, d];
    });
    const nt = tracts[near];
    const density = (nt.residents + nt.jobs) / ((Math.PI * nt.radius * nt.radius) / 1e6);
    const from = [...termDir[k]].filter(([, n]) => n >= 1000).sort((a, b) => b[1] - a[1]).map(([d]) => DIRECTION_WORDS[d]);
    tracts.push({
      id: tm.id,
      borough: wardName.get(tm.ward)!,
      name: `${tm.name} Terminal`,
      lat: tm.lat,
      lon: tm.lon,
      radius: TERMINAL_RADIUS_M,
      residents: homeTotal[NT + k],
      jobs: workTotal[NT + k],
      pop: Math.round((density * Math.PI * TERMINAL_RADIUS_M ** 2) / 1e6),
      terminal: `The end of ${tm.lines}, from ${listWords(from)}`,
    });
  });
  const file: TractsFile = { version: 1, synthetic: false, year: 2020, source: SOURCE, bands: BANDS, tracts };
  writeFileSync(join(OUT, 'tracts.json'), JSON.stringify(file));
  writeFileSync(join(OUT, 'od.bin'), encodeOD(tracts.length, rows));
  rep(`Pairs: ${fmt(rows.length)} town pairs (lumps of ${LUMP}), largest band count ${fmt(maxCount)}; ${fmt(totalCommuters)} commuters`);
  rep(`Terminals (arrivals / departures): ${TK_TERMINALS.map((t, k) => `${t.name} ${fmt(homeTotal[NT + k])} / ${fmt(workTotal[NT + k])}`).join(', ')}`);

  // ---- land.geojson: one feature per ward
  const lw = JSON.parse(readFileSync(landWards, 'utf8')) as { features: Feature<Polygon | MultiPolygon, Record<string, unknown>>[] };
  const land: LandCollection = { type: 'FeatureCollection', features: [] };
  for (const w of TK_WARDS) {
    const polys = lw.features.filter((f) => Number(f.properties.CITY) === 100 + w.code).flatMap((f) => polysOf(f.geometry));
    if (!polys.length) fail(`ward ${w.name}: no land`);
    land.features.push({ type: 'Feature', properties: { code: w.code, borough: w.name }, geometry: { type: 'MultiPolygon', coordinates: polys } });
  }
  writeFileSync(join(OUT, 'land.geojson'), JSON.stringify(land));

  // ---- report
  const dens = (i: number) => (tracts[i].residents + tracts[i].jobs) / ((Math.PI * tracts[i].radius ** 2) / 1e6);
  const top = tracts.map((t, i) => ({ t, i })).filter(({ i }) => i < NT).sort((a, b) => b.t.jobs - a.t.jobs).slice(0, 12);
  rep(`Most jobs: ${top.map(({ t }) => `${t.name} ${fmt(t.jobs)}`).join(', ')}`);
  const densest = tracts.map((t, i) => ({ t, i })).filter(({ i }) => i < NT).sort((a, b) => dens(b.i) - dens(a.i)).slice(0, 6);
  rep(`Densest towns (residents + jobs per km²): ${densest.map(({ t, i }) => `${t.name} ${fmt(dens(i))}`).join(', ')}`);
  const lens = [0, 0, 0, 0, 0];
  const edges = [1000, 3000, 6000, 12_000];
  for (const r of rows) {
    const d = dist(r.h, r.w);
    let k = edges.findIndex((e) => d < e);
    if (k < 0) k = edges.length;
    lens[k] += r.se[0] + r.se[1] + r.se[2];
  }
  rep(`Commute lengths (straight line): <1 km ${pct(lens[0] / totalCommuters)}, 1–3 ${pct(lens[1] / totalCommuters)}, 3–6 ${pct(lens[2] / totalCommuters)}, 6–12 ${pct(lens[3] / totalCommuters)}, ≥12 ${pct(lens[4] / totalCommuters)}`);
  const sizes = ['tracts.json', 'od.bin', 'land.geojson'].map((f) => `${f} ${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`);
  rep(`Wrote ${sizes.join(', ')}`);
  log('\n' + report.join('\n'));
}

const DIRECTION_WORDS: Record<TkDirection, string> = { kanagawa: 'Kanagawa', saitama: 'Saitama', chiba: 'Chiba', north: 'Ibaraki, Tochigi and Gunma', tama: 'the Tama area', other: 'further afield' };
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Towns Japan Post files under another spelling (the census name → Japan Post romaji). */
const TOWN_ROMAJI: Record<string, string> = { 三崎町: 'MISAKICHO', 猿楽町: 'SARUGAKUCHO', '多摩川河川敷（上流）': 'TAMAGAWA-KASENJIKI' };

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
