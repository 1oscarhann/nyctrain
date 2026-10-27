/**
 * Save the timelapse as a video (MP4). The replay is drawn frame by frame by the map itself
 * (MapLibre and deck.gl share one canvas), with the company, the date and the network's size on
 * top, an opening title, a closing card and, if wanted, the title music. Encoded in the browser
 * with WebCodecs (H.264 where the browser has it, else VP9 or AV1) and muxed with mp4-muxer:
 * nothing leaves the machine. Main thread only.
 *
 * The film: a 3 s title over the empty city, the replay (sped up so it lasts under ~50 s), a hold
 * on the network as it is now, and an end card.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export const VIDEO = {
  fps: 30,
  /** Largest frame: fits inside 1920×1080, keeping the map's own shape. */
  maxW: 1920,
  maxH: 1080,
  /** Bits per second at 1080p (scaled by area). The map is mostly still, so this is generous. */
  bitrate1080: 9_000_000,
  intro: 3,
  hold: 2.5,
  end: 4.5,
  /** The replay part lasts at most this long (faster than 1× when the game is long). */
  maxReplay: 50,
  sampleRate: 48_000,
} as const;

/** What the film needs from the player: the replay's length and a way to draw any moment of it. */
export interface FilmSource {
  /** Replay seconds at 1×. */
  readonly duration: number;
  /** Show the replay at t (s at 1×; paused) and return the head text. */
  showAt(t: number): { date: string; stats: string };
  /** Draw the map now, synchronously, and return its canvas. */
  draw(): HTMLCanvasElement;
}

export interface FilmInfo {
  company: string;
  /** The company logo as an SVG string (null: no company, the Headway mark is used). */
  logoSvg: string | null;
  city: string;
  /** "Jan 2030 – Mar 2033". */
  span: string;
  /** "1.42 million riders a day" (null before the first day closes). */
  riders: string | null;
  /** Map and data credits, drawn small in a corner (a licence requirement). */
  credits: string;
  /** The music file's URL (null: silent). */
  music: string | null;
}

export interface FilmPlan {
  width: number;
  height: number;
  /** Replay speed (≥ 1). */
  speed: number;
  seconds: number;
  frames: number;
}

export interface FilmResult {
  blob: Blob;
  codec: string;
  seconds: number;
  width: number;
  height: number;
  audio: boolean;
}

export function videoExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/** Even dimensions inside maxW×maxH with the source's shape (never larger than the source). */
export function filmSize(srcW: number, srcH: number, maxW: number = VIDEO.maxW, maxH: number = VIDEO.maxH): { width: number; height: number } {
  const k = Math.min(1, maxW / srcW, maxH / srcH);
  const even = (v: number) => Math.max(2, Math.floor((v * k) / 2) * 2);
  return { width: even(srcW), height: even(srcH) };
}

export function planFilm(duration: number, srcW: number, srcH: number): FilmPlan {
  const { width, height } = filmSize(srcW, srcH);
  const speed = Math.max(1, duration / VIDEO.maxReplay);
  const seconds = VIDEO.intro + duration / speed + VIDEO.hold + VIDEO.end;
  return { width, height, speed, seconds, frames: Math.ceil(seconds * VIDEO.fps) };
}

/** Where the film is at video time vt: the replay time to show and which part it is in. */
export function filmAt(vt: number, duration: number, speed: number): { t: number; part: 'intro' | 'replay' | 'hold' | 'end'; local: number } {
  const replay = duration / speed;
  if (vt < VIDEO.intro) return { t: 0, part: 'intro', local: vt };
  if (vt < VIDEO.intro + replay) return { t: (vt - VIDEO.intro) * speed, part: 'replay', local: vt - VIDEO.intro };
  if (vt < VIDEO.intro + replay + VIDEO.hold) return { t: duration, part: 'hold', local: vt - VIDEO.intro - replay };
  return { t: duration, part: 'end', local: vt - VIDEO.intro - replay - VIDEO.hold };
}

/** A file name from the company: "thames-valley-rapid-transit-timelapse.mp4". */
export function filmFileName(company: string): string {
  const slug = company
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'headway'}-timelapse.mp4`;
}

const VIDEO_CODECS: { mux: 'avc' | 'vp9' | 'av1'; codec: string }[] = [
  { mux: 'avc', codec: 'avc1.640028' }, // High 4.0
  { mux: 'avc', codec: 'avc1.4d0028' }, // Main 4.0
  { mux: 'avc', codec: 'avc1.42e028' }, // Constrained baseline 4.0
  { mux: 'vp9', codec: 'vp09.00.40.08' },
  { mux: 'av1', codec: 'av01.0.08M.08' },
];

/**
 * The first codec that really encodes at this size. isConfigSupported can say yes and the encoder
 * still fail to start (a software H.264 encoder without the High profile, say), so each candidate
 * encodes one blank frame first.
 */
async function pickVideoCodec(width: number, height: number, bitrate: number): Promise<{ mux: 'avc' | 'vp9' | 'av1'; config: VideoEncoderConfig } | null> {
  const blank = document.createElement('canvas');
  blank.width = width;
  blank.height = height;
  blank.getContext('2d')!.fillRect(0, 0, width, height);
  for (const c of VIDEO_CODECS) {
    const config: VideoEncoderConfig = { codec: c.codec, width, height, bitrate, framerate: VIDEO.fps, latencyMode: 'quality', ...(c.mux === 'avc' ? { avc: { format: 'avc' } } : {}) };
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (!s.supported) continue;
      let ok = true;
      let chunks = 0;
      const enc = new VideoEncoder({ output: () => chunks++, error: () => (ok = false) });
      enc.configure(config);
      const f = new VideoFrame(blank, { timestamp: 0 });
      enc.encode(f, { keyFrame: true });
      f.close();
      await enc.flush().catch(() => (ok = false));
      if (enc.state !== 'closed') enc.close();
      if (ok && chunks > 0) return { mux: c.mux, config };
    } catch {
      /* try the next */
    }
  }
  return null;
}

async function pickAudioCodec(): Promise<{ mux: 'aac' | 'opus'; config: AudioEncoderConfig } | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  for (const [mux, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']] as const) {
    const config: AudioEncoderConfig = { codec, sampleRate: VIDEO.sampleRate, numberOfChannels: 2, bitrate: 160_000 };
    try {
      const s = await AudioEncoder.isConfigSupported(config);
      if (s.supported) return { mux, config };
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** The music, looped to the film's length with a fade in and a long fade out, at 48 kHz stereo. */
async function renderMusic(url: string, seconds: number): Promise<AudioBuffer> {
  const bytes = await (await fetch(url)).arrayBuffer();
  const rate = VIDEO.sampleRate;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const buf = await ctx.decodeAudioData(bytes);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(0.85, 1.5);
  gain.gain.setValueAtTime(0.85, Math.max(1.6, seconds - 3.5));
  gain.gain.linearRampToValueAtTime(0, seconds);
  src.connect(gain).connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/** Yield to the page without timer throttling (a hidden tab keeps going). */
function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

function loadImage(svg: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const DISPLAY = '"Big Shoulders Display", "Overpass", system-ui, sans-serif';
const MONO = '"Overpass Mono", ui-monospace, monospace';
const FG = '#EEF2F6';
const AMBER = '#FFB25A';
const MUTED = '#9AA7B5';

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

/** Draws the overlays for one frame (sizes are designed at 1080 and scaled). */
class Overlay {
  constructor(
    private ctx: Ctx,
    private w: number,
    private h: number,
    private info: FilmInfo,
    private logo: HTMLImageElement | null,
  ) {}

  private get k(): number {
    return this.h / 1080;
  }

  private text(s: string, x: number, y: number, font: string, color: string, opts: { align?: CanvasTextAlign; spacing?: number; alpha?: number; shadow?: number } = {}): number {
    const c = this.ctx;
    c.save();
    c.globalAlpha *= opts.alpha ?? 1;
    c.font = font;
    c.fillStyle = color;
    c.textAlign = opts.align ?? 'left';
    c.textBaseline = 'alphabetic';
    if ('letterSpacing' in c) c.letterSpacing = `${(opts.spacing ?? 0).toFixed(1)}px`;
    if (opts.shadow) {
      c.shadowColor = 'rgba(0,0,0,0.75)';
      c.shadowBlur = opts.shadow;
      c.shadowOffsetY = 2 * this.k;
    }
    c.fillText(s, x, y);
    const wd = c.measureText(s).width;
    c.restore();
    return wd;
  }

  /** The always-on bits: a top shade for the head, the credits and the wordmark. */
  chrome(alpha: number): void {
    const c = this.ctx, k = this.k;
    const g = c.createLinearGradient(0, 0, 0, 300 * k);
    g.addColorStop(0, `rgba(6,9,13,${0.62 * alpha})`);
    g.addColorStop(1, 'rgba(6,9,13,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, 300 * k);
    const b = c.createLinearGradient(0, this.h - 120 * k, 0, this.h);
    b.addColorStop(0, 'rgba(6,9,13,0)');
    b.addColorStop(1, `rgba(6,9,13,${0.5 * alpha})`);
    c.fillStyle = b;
    c.fillRect(0, this.h - 120 * k, this.w, 120 * k);
    this.text(this.info.credits, 28 * k, this.h - 24 * k, `400 ${Math.round(14 * k)}px ${MONO}`, 'rgba(238,242,246,0.6)', { alpha });
    this.wordmark(this.w - 32 * k, this.h - 24 * k, 26 * k, alpha * 0.85, 'right');
  }

  /** HEAD · WAY with the amber station square. */
  private wordmark(x: number, y: number, size: number, alpha: number, align: 'right' | 'center'): void {
    const c = this.ctx;
    c.save();
    c.font = `900 ${Math.round(size)}px ${DISPLAY}`;
    if ('letterSpacing' in c) (c as Ctx).letterSpacing = `${(size * 0.12).toFixed(1)}px`;
    const lw = c.measureText('HEAD').width, rw = c.measureText('WAY').width;
    const gap = size * 0.42;
    const total = lw + gap + rw;
    const x0 = align === 'right' ? x - total : x - total / 2;
    c.restore();
    this.text('HEAD', x0, y, `900 ${Math.round(size)}px ${DISPLAY}`, FG, { spacing: size * 0.12, alpha });
    this.text('WAY', x0 + lw + gap, y, `900 ${Math.round(size)}px ${DISPLAY}`, FG, { spacing: size * 0.12, alpha });
    c.save();
    c.globalAlpha *= alpha;
    c.fillStyle = AMBER;
    const sq = size * 0.17;
    c.fillRect(x0 + lw + gap / 2 - sq / 2 - size * 0.06, y - size * 0.42, sq, sq);
    c.restore();
  }

  /** The head over the replay: company · city, the date, the network's size. */
  head(date: string, stats: string, alpha: number): void {
    if (alpha <= 0) return;
    const k = this.k, cx = this.w / 2;
    this.text(`${this.info.company} · ${this.info.city}`.toUpperCase(), cx, 70 * k, `600 ${Math.round(18 * k)}px ${MONO}`, AMBER, { align: 'center', spacing: 4 * k, alpha, shadow: 12 * k });
    this.text(date.toUpperCase(), cx, 152 * k, `800 ${Math.round(84 * k)}px ${DISPLAY}`, FG, { align: 'center', spacing: 3 * k, alpha, shadow: 30 * k });
    this.text(stats, cx, 196 * k, `400 ${Math.round(22 * k)}px ${MONO}`, 'rgba(238,242,246,0.88)', { align: 'center', spacing: 0.5 * k, alpha, shadow: 14 * k });
  }

  /** The opening title over the empty city. */
  intro(local: number): void {
    const k = this.k, cx = this.w / 2, cy = this.h / 2;
    const a = easeOut(clamp01((local - 0.25) / 0.9)) * (1 - clamp01((local - (VIDEO.intro - 0.7)) / 0.7));
    if (a <= 0) return;
    const c = this.ctx;
    c.save();
    c.fillStyle = `rgba(6,9,13,${0.45 * a})`;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
    const rise = (1 - easeOut(clamp01((local - 0.25) / 1.2))) * 16 * k;
    const size = 132 * k;
    if (this.logo) {
      c.save();
      c.globalAlpha = a;
      c.drawImage(this.logo, cx - size / 2, cy - 170 * k + rise, size, size);
      c.restore();
    }
    this.text(this.info.company.toUpperCase(), cx, cy + 50 * k + rise, `900 ${Math.round(96 * k)}px ${DISPLAY}`, FG, { align: 'center', spacing: 6 * k, alpha: a, shadow: 36 * k });
    this.text(`The ${this.info.city} network · ${this.info.span}`.toUpperCase(), cx, cy + 100 * k + rise, `400 ${Math.round(22 * k)}px ${MONO}`, MUTED, { align: 'center', spacing: 5 * k, alpha: a, shadow: 12 * k });
  }

  /** The closing card: logo, name, what was built, riders, then the Headway mark. */
  end(local: number, stats: string): void {
    const k = this.k, cx = this.w / 2, cy = this.h / 2, c = this.ctx;
    const dark = easeOut(clamp01(local / 0.9));
    c.save();
    c.fillStyle = `rgba(6,9,13,${0.86 * dark})`;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
    const out = 1 - clamp01((local - (VIDEO.end - 0.9)) / 0.9);
    const a = easeOut(clamp01((local - 0.4) / 1.0)) * out;
    if (a > 0) {
      const size = 108 * k;
      if (this.logo) {
        c.save();
        c.globalAlpha = a;
        c.drawImage(this.logo, cx - size / 2, cy - 230 * k, size, size);
        c.restore();
      }
      this.text(this.info.company.toUpperCase(), cx, cy - 34 * k, `900 ${Math.round(84 * k)}px ${DISPLAY}`, FG, { align: 'center', spacing: 5 * k, alpha: a });
      const parts = stats.split(' · ');
      this.text(parts.join('   ·   '), cx, cy + 22 * k, `400 ${Math.round(24 * k)}px ${MONO}`, FG, { align: 'center', spacing: 0.5 * k, alpha: a * 0.92 });
      if (this.info.riders) this.text(this.info.riders.toUpperCase(), cx, cy + 66 * k, `600 ${Math.round(22 * k)}px ${MONO}`, AMBER, { align: 'center', spacing: 4 * k, alpha: a });
    }
    const m = easeOut(clamp01((local - 1.3) / 1.0)) * out;
    if (m > 0) this.wordmark(cx, cy + 190 * k, 46 * k, m, 'center');
    // Fade to black at the very end.
    const black = clamp01((local - (VIDEO.end - 0.6)) / 0.6);
    if (black > 0) {
      c.save();
      c.fillStyle = `rgba(0,0,0,${black})`;
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
    }
  }
}

/**
 * Render and encode the film. `onProgress(done, total)` is called as frames go; aborting the
 * signal stops it (the promise rejects with an AbortError).
 */
export async function renderFilm(src: FilmSource, info: FilmInfo, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<FilmResult> {
  if (!videoExportSupported()) throw new Error('This browser can’t make videos (no WebCodecs). Try Chrome, Edge or Safari.');
  const first = src.draw();
  const plan = planFilm(src.duration, first.width, first.height);
  const { width, height, speed, frames } = plan;
  const bitrate = Math.round(VIDEO.bitrate1080 * ((width * height) / (1920 * 1080)) ** 0.85);
  const vc = await pickVideoCodec(width, height, bitrate);
  if (!vc) throw new Error('This browser has no video encoder for MP4 at this size.');
  const ac = info.music ? await pickAudioCodec() : null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: vc.mux, width, height, frameRate: VIDEO.fps },
    ...(ac ? { audio: { codec: ac.mux, numberOfChannels: 2, sampleRate: VIDEO.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failure: unknown = null;
  const abort = () => {
    if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  };

  // Music first (it's quick), so a codec problem shows before the long part.
  let audio = false;
  if (ac && info.music) {
    try {
      const music = await renderMusic(info.music, plan.seconds);
      const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (failure = e) });
      enc.configure(ac.config);
      const L = music.getChannelData(0), R = music.numberOfChannels > 1 ? music.getChannelData(1) : L;
      const block = 4800;
      for (let off = 0; off < music.length; off += block) {
        const n = Math.min(block, music.length - off);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(off, off + n), 0);
        data.set(R.subarray(off, off + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: VIDEO.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / VIDEO.sampleRate) * 1e6), data });
        enc.encode(ad);
        ad.close();
      }
      await enc.flush();
      enc.close();
      audio = !failure;
      failure = null;
    } catch {
      // No music then (the film still saves).
      failure = null;
    }
  }

  // Fonts the overlays use (loaded by the page; this waits for them).
  try {
    await Promise.all([`800 80px ${DISPLAY}`, `900 80px ${DISPLAY}`, `400 20px ${MONO}`, `600 20px ${MONO}`].map((f) => document.fonts.load(f)));
  } catch {
    /* system fonts then */
  }
  const logo = info.logoSvg ? await loadImage(info.logoSvg) : null;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d', { alpha: false }) as Ctx;
  // The last map image, kept so still parts of the film don't redraw the map.
  const mapBuf = document.createElement('canvas');
  mapBuf.width = width;
  mapBuf.height = height;
  const mctx = mapBuf.getContext('2d', { alpha: false })!;
  mctx.imageSmoothingQuality = 'high';
  const overlay = new Overlay(ctx, width, height, info, logo);

  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
  venc.configure(vc.config);
  let lastT = -1;
  let head = { date: '', stats: '' };
  const finalHead = src.showAt(src.duration);
  const dt = 1 / VIDEO.fps;
  for (let i = 0; i < frames; i++) {
    abort();
    const at = filmAt(i * dt, src.duration, speed);
    if (at.t !== lastT) {
      head = src.showAt(at.t);
      const canvas = src.draw();
      // Cover the frame with the map (a window resize mid-export crops rather than stretches).
      const sk = Math.max(width / canvas.width, height / canvas.height);
      const sw = width / sk, sh = height / sk;
      mctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, width, height);
      lastT = at.t;
    }
    ctx.drawImage(mapBuf, 0, 0);
    const chromeIn = at.part === 'intro' ? clamp01((at.local - (VIDEO.intro - 0.8)) / 0.8) : 1;
    overlay.chrome(at.part === 'end' ? 1 - clamp01(at.local / 0.9) : Math.max(0.35, chromeIn));
    if (at.part === 'intro') overlay.intro(at.local);
    else overlay.head(head.date, head.stats, at.part === 'end' ? 1 - clamp01(at.local / 0.6) : at.part === 'replay' ? clamp01(at.local / 0.5) : 1);
    if (at.part === 'end') overlay.end(at.local, finalHead.stats);
    const frame = new VideoFrame(out, { timestamp: Math.round(i * dt * 1e6), duration: Math.round(dt * 1e6) });
    venc.encode(frame, { keyFrame: i % (VIDEO.fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) {
      await new Promise((r) => setTimeout(r, 2));
      abort();
    }
    if (i % 2 === 0) {
      opts.onProgress?.(i + 1, frames);
      await yieldNow();
    }
  }
  await venc.flush();
  venc.close();
  abort();
  muxer.finalize();
  opts.onProgress?.(frames, frames);
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: vc.config.codec, seconds: plan.seconds, width, height, audio };
}
