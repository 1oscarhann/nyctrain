/**
 * Title scene data from a map's real data: its land (borough or district outlines, water left
 * out), one dot per few hundred residents (where people live) and per few hundred jobs (where
 * they go), and the title lines. Everything in screen-ish metres around the scene's centre
 * (x east, y south). Pure and deterministic, so the preview and the game draw the same city.
 */
import type { TitleSceneDef } from './titleLines';

export interface SceneData {
  /** Land rings, flattened [x0, y0, x1, y1, …] in metres. */
  land: number[][];
  /** Resident dots and job dots, flattened [x, y, …]. */
  homes: number[];
  jobs: number[];
  lines: { color: string; pts: [number, number][]; stops: number[] }[];
  /** The screen's long side, metres. */
  span: number;
  /** People per dot (for the caption). */
  perDot: number;
}

interface TractLike {
  lon: number;
  lat: number;
  radius: number;
  residents: number;
  jobs: number;
}

type Ring = [number, number][];
interface LandLike {
  features: { geometry: { type: string; coordinates: unknown } }[];
}

function projector(center: [number, number]) {
  const k = Math.cos((center[1] * Math.PI) / 180);
  return (lon: number, lat: number): [number, number] => [(lon - center[0]) * 111320 * k, -(lat - center[1]) * 110540];
}

/** Douglas–Peucker on a ring (tolerance in metres). */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > best) ((best = d), (bi = i));
    }
    if (best > t2 && bi > 0) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A small seeded RNG (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catmull–Rom through the stops, so lines curve like track; returns the polyline and each stop's index. */
function smoothLine(stops: [number, number][], seg = 14): { pts: [number, number][]; stops: number[] } {
  const pts: [number, number][] = [];
  const idx: number[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const p0 = stops[Math.max(0, i - 1)], p1 = stops[i], p2 = stops[i + 1], p3 = stops[Math.min(stops.length - 1, i + 2)];
    idx.push(pts.length);
    for (let j = 0; j < seg; j++) {
      const t = j / seg, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  idx.push(pts.length);
  pts.push(stops[stops.length - 1]);
  return { pts, stops: idx };
}

export function buildSceneData(def: TitleSceneDef, land: LandLike, tracts: TractLike[], opts: { maxDots?: number } = {}): SceneData {
  const P = projector(def.center);
  const span = def.spanKm * 1000;
  const reach = span * 0.9;
  const tol = span / 2400;
  const out: number[][] = [];
  const addRing = (ring: Ring) => {
    const pts = simplify(ring.map(([lon, lat]) => P(lon, lat)), tol);
    if (pts.length < 3) return;
    // Skip rings far off screen.
    if (!pts.some(([x, y]) => Math.abs(x) < reach && Math.abs(y) < reach)) return;
    const flat: number[] = [];
    for (const [x, y] of pts) flat.push(Math.round(x), Math.round(y));
    out.push(flat);
  };
  for (const f of land.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') for (const r of g.coordinates as Ring[]) addRing(r);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates as Ring[][]) for (const r of poly) addRing(r);
  }
  // Dots: one per perDot people, scattered over each area (more spread for bigger areas).
  const rand = rng(1885);
  const homes: number[] = [];
  const jobs: number[] = [];
  const max = opts.maxDots ?? 14000;
  for (const t of tracts) {
    const [cx, cy] = P(t.lon, t.lat);
    if (Math.abs(cx) > reach || Math.abs(cy) > reach) continue;
    const put = (arr: number[], n: number, spread: number) => {
      let k = n / def.perDot;
      while (k > 0) {
        if (k < 1 && rand() > k) break;
        const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * t.radius * spread;
        arr.push(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r));
        k -= 1;
      }
    };
    put(homes, t.residents, 0.95);
    put(jobs, t.jobs, 0.6);
  }
  const thin = (arr: number[], cap: number) => {
    const n = arr.length / 2;
    if (n <= cap) return arr;
    const keep: number[] = [];
    const step = n / cap;
    for (let i = 0; i < cap; i++) {
      const j = Math.floor(i * step);
      keep.push(arr[j * 2], arr[j * 2 + 1]);
    }
    return keep;
  };
  const lines = def.lines.map((l) => {
    const s = smoothLine(l.stops.map(([lon, lat]) => P(lon, lat)));
    return { color: l.color, pts: s.pts.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]), stops: s.stops };
  });
  return { land: out, homes: thin(homes, Math.round(max * 0.62)), jobs: thin(jobs, Math.round(max * 0.38)), lines, span, perDot: def.perDot };
}
