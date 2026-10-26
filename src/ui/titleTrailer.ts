/**
 * The title screen trailer (canvas 2D, no map tiles): a slow, letterboxed loop through the maps,
 * about 30 seconds each, on their real data:
 *   1. Establish: the city rises out of the dark; a dot per few hundred residents ripples out.
 *   2. Draw: the lines draw themselves one by one as the camera pushes in.
 *   3. Follow: a dissolve to a tracking shot, riding with one train through its stations.
 *   4. Rush hour: a dissolve back to wide, every line streaming with passengers; fade to black.
 * The camera is a pure function of time (dissolves render both shots). Captions are the host's:
 * onShot says which shot is up. Respects prefers-reduced-motion (a still of the finished network).
 */
import type { SceneData } from './titleData';

const COL = {
  water: '#03080c',
  waterGlow: '#0a1622',
  land: '#141e28',
  landEdge: '#22303d',
  home: '111, 132, 156',
  job: '255, 178, 92',
  station: '#F4F6F8',
};

/** Shot start times within a city's sequence, seconds. */
export const SHOT_TIMES = [0, 7.5, 15, 22.5];
export const CITY_T = 30.5;
/** Dissolve length around the cuts into shots 3 and 4. */
const DISSOLVE = 1.6;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
const backOut = (t: number) => 1 + 2.9 * (t - 1) ** 3 + 1.9 * (t - 1) ** 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Train {
  s: number;
  dir: 1 | -1;
  wait: number;
  next: number;
}

interface Line {
  color: string;
  path: Path2D;
  pts: [number, number][];
  cum: number[];
  length: number;
  stopS: number[];
  start: number;
  dur: number;
  trains: Train[];
  flow: number[];
}

interface Prepared {
  data: SceneData;
  land: Path2D;
  lines: Line[];
  homeT: Float32Array;
  jobT: Float32Array;
  follow: { line: number; train: number };
  pings: { x: number; y: number; t: number; color: string }[];
}

interface Cam {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface TrailerCity {
  id: string;
  data: SceneData;
}

export interface TrailerOptions {
  /** Where the picture's centre sits across the screen (0–1), read every frame (eases itself). */
  focusX?: () => number;
  /** Letterbox bar height as a share of the screen height, read every frame. */
  letterbox?: () => number;
  reducedMotion?: boolean;
  /** Film grain (default on; off for video, where it would bloat the file). */
  grain?: boolean;
  /** Step the clock by hand (frame-by-frame rendering of the trailer video) instead of in real time. */
  manual?: boolean;
  /** A new shot (city id, shot 0–3; −1 as the sequence fades out), for captions. */
  onShot?: (city: string, shot: number) => void;
}

export class TitleTrailer {
  private ctx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private prepared = new Map<string, Prepared>();
  private idx = 0;
  private t0 = 0;
  private last = 0;
  private raf = 0;
  private shot = -2;
  private ending = false;
  private focus = 0.5;
  private bar = 0.075;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private grain: HTMLCanvasElement;
  private ro: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private cities: TrailerCity[],
    private opts: TrailerOptions = {},
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d', { alpha: false })!;
    this.grain = makeGrain();
    this.focus = opts.focusX?.() ?? 0.5;
    this.bar = opts.letterbox?.() ?? 0.075;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.t0 = this.now();
    if (!opts.manual) this.loop();
  }

  /** Cut straight to a city's sequence. */
  jumpTo(id: string): void {
    const i = this.cities.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.prepared.delete(this.cities[this.idx].id);
    this.prepared.delete(id);
    this.idx = i;
    this.t0 = this.now();
    this.shot = -2;
  }

  get city(): string {
    return this.cities[this.idx].id;
  }

  /** How far through the current map's sequence (0–1). */
  get progress(): number {
    return Math.min(1, (this.now() - this.t0) / CITY_T);
  }

  /** Seconds into the current map's sequence. */
  get time(): number {
    return this.now() - this.t0;
  }

  /** Manual mode: advance the clock by dt seconds and draw one frame. */
  step(dt: number): void {
    this.clock += dt;
    this.frame();
  }

  private clock = 0;
  private now(): number {
    return this.opts.manual ? this.clock : performance.now() / 1000;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    for (const c of [this.canvas, this.buf]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
  }

  private prepare(c: TrailerCity): Prepared {
    const hit = this.prepared.get(c.id);
    if (hit) return hit;
    const d = c.data;
    const land = new Path2D();
    for (const r of d.land) {
      land.moveTo(r[0], r[1]);
      for (let i = 2; i < r.length; i += 2) land.lineTo(r[i], r[i + 1]);
      land.closePath();
    }
    const R = d.span * 0.6;
    const ripple = (arr: number[], from: number, over: number) => {
      const out = new Float32Array(arr.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = from + over * Math.min(1, Math.hypot(arr[i * 2], arr[i * 2 + 1]) / R) + (((i * 9301 + 49297) % 233280) / 233280) * 0.6;
      return out;
    };
    const lines: Line[] = d.lines.map((l, i) => {
      const path = new Path2D();
      const cum = [0];
      l.pts.forEach(([x, y], k) => {
        if (!k) path.moveTo(x, y);
        else {
          path.lineTo(x, y);
          cum.push(cum[k - 1] + Math.hypot(x - l.pts[k - 1][0], y - l.pts[k - 1][1]));
        }
      });
      const length = cum[cum.length - 1];
      const stopS = l.stops.map((k) => cum[k]);
      const n = Math.max(2, Math.round(length / (d.span * 0.2)));
      const trains: Train[] = Array.from({ length: n }, (_, j) => {
        const s = (length * (j + 0.35)) / n;
        const dir = (j % 2 ? -1 : 1) as 1 | -1;
        return { s, dir, wait: 0, next: nextStop(stopS, s, dir) };
      });
      const flow = Array.from({ length: Math.round(length / (d.span * 0.011)) }, (_, j) => ((j * 7919) % 1000) / 1000);
      return { color: l.color, path, pts: l.pts, cum, length, stopS, start: SHOT_TIMES[1] + 0.3 + i * 0.95, dur: 2.4, trains, flow };
    });
    let li = 0;
    lines.forEach((l, i) => l.length > lines[li].length && (li = i));
    const L = lines[li];
    let ti = 0, best = Infinity;
    L.trains.forEach((tr, j) => {
      const dd = Math.abs(tr.s - L.length * 0.22);
      if (dd < best) ((best = dd), (ti = j));
    });
    L.trains[ti].dir = 1;
    L.trains[ti].next = nextStop(L.stopS, L.trains[ti].s, 1);
    const p: Prepared = { data: d, land, lines, homeT: ripple(d.homes, 0.9, 3.6), jobT: ripple(d.jobs, 2.0, 3.0), follow: { line: li, train: ti }, pings: [] };
    this.prepared.set(c.id, p);
    return p;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.frame();
  };

  private frame(): void {
    const now = this.now();
    const dt = Math.min(0.05, now - (this.last || now));
    this.last = now;
    let t = now - this.t0;
    if (this.opts.reducedMotion) t = SHOT_TIMES[3] + 3;
    else if (t >= CITY_T) {
      this.prepared.delete(this.city);
      this.idx = (this.idx + 1) % this.cities.length;
      this.t0 = now;
      t = 0;
      this.shot = -2;
    }
    const shot = t >= SHOT_TIMES[3] ? 3 : t >= SHOT_TIMES[2] ? 2 : t >= SHOT_TIMES[1] ? 1 : 0;
    if (shot !== this.shot) {
      this.shot = shot;
      this.opts.onShot?.(this.city, shot);
    }
    if (!this.opts.reducedMotion && t >= CITY_T - 1.6 && !this.ending) {
      this.ending = true;
      this.opts.onShot?.(this.city, -1);
    }
    if (t < CITY_T - 1.6) this.ending = false;
    // Framing eases towards what the host wants (the menu opening and closing).
    const f = 1 - Math.exp(-dt * 2.2);
    this.focus = lerp(this.focus, this.opts.focusX?.() ?? 0.5, f);
    this.bar = lerp(this.bar, this.opts.letterbox?.() ?? 0.075, f);
    const p = this.prepare(this.cities[this.idx]);
    this.update(p, t, this.opts.reducedMotion ? 0 : dt);
    this.render(p, t);
  }

  private update(p: Prepared, t: number, dt: number): void {
    const d = p.data;
    const speed = d.span / 40;
    const ft = p.lines[p.follow.line].trains[p.follow.train];
    for (const l of p.lines) {
      if (t < l.start + l.dur) continue;
      for (const tr of l.trains) {
        if (tr.wait > 0) {
          tr.wait -= dt;
          continue;
        }
        const step = speed * dt;
        if ((tr.next - tr.s) * tr.dir <= step) {
          tr.s = tr.next;
          tr.wait = tr === ft ? 0.9 : 1.4;
          const [x, y] = at(l, tr.s);
          if (dt > 0) p.pings.push({ x, y, t, color: l.color });
          if (tr.s >= l.length - 1 || tr.s <= 1) tr.dir = (tr.dir * -1) as 1 | -1;
          tr.next = nextStop(l.stopS, tr.s, tr.dir);
        } else tr.s += step * tr.dir;
      }
      for (let i = 0; i < l.flow.length; i++) l.flow[i] = (l.flow[i] + (dt * speed * 2.2) / l.length) % 1;
    }
    p.pings = p.pings.filter((g) => t - g.t < 1.6);
  }

  /** The camera of a shot at time t (pure: dissolves evaluate two shots at once). */
  private camera(p: Prepared, shot: number, t: number): Cam {
    const d = p.data;
    const k = (a: number, b: number) => clamp01((t - a) / (b - a));
    if (shot === 0) {
      const q = sine(k(0, SHOT_TIMES[1] + 1));
      return { x: lerp(d.span * 0.06, 0, q), y: lerp(d.span * 0.03, 0, q), z: lerp(0.7, 0.9, q), r: lerp(0.04, 0, q) };
    }
    if (shot === 1) {
      const q = sine(k(SHOT_TIMES[1], SHOT_TIMES[2] + DISSOLVE / 2));
      return { x: 0, y: 0, z: lerp(0.9, 1.1, q), r: lerp(0, -0.04, q) };
    }
    if (shot === 2) {
      const l = p.lines[p.follow.line];
      const tr = l.trains[p.follow.train];
      const [x, y] = at(l, tr.s);
      // Heading over a stretch of track either side, so the tilt never twitches.
      const span = d.span * 0.05;
      const [ax, ay] = at(l, Math.max(0, tr.s - span));
      const [bx, by] = at(l, Math.min(l.length, tr.s + span));
      const dx = (bx - ax) * tr.dir, dy = (by - ay) * tr.dir;
      const q = sine(k(SHOT_TIMES[2] - DISSOLVE / 2, SHOT_TIMES[3] + DISSOLVE / 2));
      return { x, y, z: lerp(3.3, 2.7, q), r: -0.4 * Math.atan2(dy, Math.abs(dx) + 1e-6) };
    }
    const q = sine(k(SHOT_TIMES[3] - DISSOLVE / 2, CITY_T));
    return { x: 0, y: d.span * 0.01, z: lerp(1.04, 0.84, q), r: lerp(0.03, -0.015, q) };
  }

  private render(p: Prepared, t: number): void {
    const { ctx, w, h, dpr } = this;
    const shot = t >= SHOT_TIMES[3] ? 3 : t >= SHOT_TIMES[2] ? 2 : t >= SHOT_TIMES[1] ? 1 : 0;
    // Dissolves: around the starts of shots 3 and 4, both shots render and cross-fade.
    let from = -1, mix = 1;
    for (const b of [2, 3]) {
      const tb = SHOT_TIMES[b];
      if (!this.opts.reducedMotion && t >= tb - DISSOLVE / 2 && t < tb + DISSOLVE / 2) {
        from = b - 1;
        mix = sine((t - (tb - DISSOLVE / 2)) / DISSOLVE);
      }
    }
    const to = from >= 0 ? from + 1 : shot;
    this.world(ctx, p, t, this.camera(p, to, t));
    if (from >= 0 && mix < 1) {
      this.world(this.bctx, p, t, this.camera(p, from, t));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - mix;
      ctx.drawImage(this.buf, 0, 0);
      ctx.globalAlpha = 1;
    }
    // Finish: grain, letterbox, fades.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.opts.reducedMotion && this.opts.grain !== false) {
      ctx.globalAlpha = 0.065;
      const ox = Math.floor(Math.random() * 128), oy = Math.floor(Math.random() * 128);
      ctx.fillStyle = ctx.createPattern(this.grain, 'repeat')!;
      ctx.translate(-ox, -oy);
      ctx.fillRect(ox, oy, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
    }
    const bar = Math.round(h * this.bar);
    ctx.fillStyle = '#000';
    if (bar > 0) {
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);
    }
    if (!this.opts.reducedMotion) {
      const black = Math.max(1 - easeOut(clamp01(t / 2)), easeInOut(clamp01((t - (CITY_T - 1.6)) / 1.6)));
      if (black > 0) {
        ctx.globalAlpha = black;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    }
  }

  private world(ctx: CanvasRenderingContext2D, p: Prepared, t: number, cam: Cam): void {
    const { w, h, dpr } = this;
    const d = p.data;
    const k = (a: number, b: number) => clamp01((t - a) / (b - a));
    const cx = w * this.focus, cy = h / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.water;
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(cx, cy * 0.9, 0, cx, cy * 0.9, Math.max(w, h) * 0.75);
    g.addColorStop(0, COL.waterGlow);
    g.addColorStop(1, COL.water);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const s = (Math.max(w, h) / d.span) * cam.z;
    const cos = Math.cos(cam.r), sin = Math.sin(cam.r);
    ctx.setTransform(dpr * s * cos, dpr * s * sin, -dpr * s * sin, dpr * s * cos, dpr * cx, dpr * cy);
    ctx.translate(-cam.x, -cam.y);
    const px = 1 / s;
    const close = cam.z > 2;

    ctx.globalAlpha = easeOut(k(0, 2.4));
    ctx.fillStyle = COL.land;
    ctx.fill(p.land);
    ctx.strokeStyle = COL.landEdge;
    ctx.lineWidth = px * 0.8;
    ctx.stroke(p.land);
    ctx.globalAlpha = 1;

    const rush = t >= SHOT_TIMES[3] - DISSOLVE / 2 ? 0.55 + 0.45 * Math.sin((t - SHOT_TIMES[3]) * 1.6) ** 2 : 0;
    const dots = (arr: number[], times: Float32Array, rgb: string, size: number, alpha: number) => {
      const done = t > 6.6;
      const B = done ? 1 : 6;
      for (let b = 0; b < B; b++) {
        const lo = b / B, hi = (b + 1) / B;
        ctx.fillStyle = `rgba(${rgb}, ${(alpha * (done ? 1 : hi)).toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < times.length; i++) {
          const a = done ? 1 : clamp01((t - times[i]) / 0.9);
          if (a <= lo || a > hi) continue;
          ctx.rect(arr[i * 2] - size / 2, arr[i * 2 + 1] - size / 2, size, size);
        }
        ctx.fill();
      }
    };
    dots(d.homes, p.homeT, COL.home, px * (close ? 2.6 : 1.7), 0.55);
    ctx.globalCompositeOperation = 'lighter';
    dots(d.jobs, p.jobT, COL.job, px * (close ? 2.2 : 1.5), 0.36 + 0.24 * rush);
    ctx.globalCompositeOperation = 'source-over';

    const lw = px * Math.max(3.2, Math.min(5.5, w / 300)) * (close ? 1.45 : 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const l of p.lines) {
      const q = easeInOut(k(l.start, l.start + l.dur));
      if (q <= 0) continue;
      ctx.setLineDash(q < 1 ? [l.length * q, l.length + 1] : []);
      ctx.strokeStyle = COL.water;
      ctx.lineWidth = lw + px * 3;
      ctx.stroke(l.path);
      ctx.strokeStyle = l.color;
      ctx.lineWidth = lw;
      ctx.stroke(l.path);
      ctx.setLineDash([]);
    }
    if (rush > 0) {
      ctx.globalCompositeOperation = 'lighter';
      const on = clamp01((t - (SHOT_TIMES[3] - DISSOLVE / 2)) / 1.5);
      for (const l of p.lines) {
        ctx.fillStyle = l.color;
        ctx.globalAlpha = 0.7 * on;
        ctx.beginPath();
        l.flow.forEach((f, i) => {
          const [x, y] = at(l, (i % 2 ? f : 1 - f) * l.length);
          ctx.moveTo(x + px * 1.6, y);
          ctx.arc(x, y, px * 1.6, 0, Math.PI * 2);
        });
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    for (const l of p.lines) {
      const head = l.length * easeInOut(k(l.start, l.start + l.dur));
      for (const ss of l.stopS) {
        if (head < ss - 1) continue;
        const kk = clamp01((t - (l.start + (ss / l.length) * l.dur * 0.85)) / 0.5);
        const r = px * (close ? 6 : 4.2) * (kk >= 1 ? 1 : backOut(kk));
        if (r <= 0) continue;
        const [x, y] = at(l, Math.min(ss, l.length));
        ctx.beginPath();
        ctx.arc(x, y, r + px * 1.7, 0, Math.PI * 2);
        ctx.fillStyle = l.color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = COL.station;
        ctx.fill();
      }
    }
    for (const g2 of p.pings) {
      const a = (t - g2.t) / 1.6;
      ctx.beginPath();
      ctx.arc(g2.x, g2.y, px * (6 + 26 * easeOut(a)), 0, Math.PI * 2);
      ctx.strokeStyle = g2.color;
      ctx.globalAlpha = 0.55 * (1 - a);
      ctx.lineWidth = px * 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const l of p.lines) {
      const on = k(l.start + l.dur, l.start + l.dur + 0.8);
      if (on <= 0) continue;
      for (const tr of l.trains) {
        const len = px * (close ? 26 : 15);
        const [ax, ay] = at(l, Math.max(0, tr.s - len * tr.dir * 0.5));
        const [bx, by] = at(l, Math.min(l.length, tr.s + len * tr.dir * 0.5));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = l.color;
        ctx.globalAlpha = on * 0.3;
        ctx.lineWidth = lw * 3.4;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = on;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = lw * 1.25;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.32, cx, cy, Math.max(w, h) * 0.78);
    v.addColorStop(0, 'rgba(3, 7, 11, 0)');
    v.addColorStop(1, 'rgba(3, 7, 11, 0.82)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }
}

function nextStop(stopS: number[], s: number, dir: 1 | -1): number {
  if (dir > 0) return stopS.find((v) => v > s + 1) ?? stopS[stopS.length - 1];
  for (let i = stopS.length - 1; i >= 0; i--) if (stopS[i] < s - 1) return stopS[i];
  return stopS[0];
}

function at(l: { cum: number[]; pts: [number, number][] }, s: number): [number, number, number] {
  let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (l.cum[m] < s) lo = m;
    else hi = m;
  }
  const seg = l.cum[hi] - l.cum[lo] || 1;
  const f = Math.max(0, Math.min(1, (s - l.cum[lo]) / seg));
  const [ax, ay] = l.pts[lo], [bx, by] = l.pts[hi];
  return [ax + (bx - ax) * f, ay + (by - ay) * f, Math.atan2(by - ay, bx - ax)];
}

function makeGrain(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}
