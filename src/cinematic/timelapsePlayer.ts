/**
 * The timelapse player (docs/v2/cinematic.md §1, §3): replays the network's growth from an empty
 * city to now, month by month, new lines drawing themselves out from the old network, with a
 * date counter. It draws its own deck.gl layers (the App shows only these while it is open, and
 * hides the live network's MapLibre layers); the game is paused, the panels are kept, and the
 * camera goes back where it was on close. Main thread only: nothing reaches the worker.
 *
 * Per frame only the edges drawing in this step get new trimmed paths; the rest of the step's
 * data objects are built once when the step starts.
 */
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { CINEMATIC, MAP, QUAD } from '../balance';
import { city } from '../cities';
import { monthLabel } from '../core/calendar';
import { Emitter } from '../core/emitter';
import { toLonLat } from '../core/geo';
import { timelapseStats } from '../ui/cinematicText';
import type { Game } from '../core/game';
import { lineScale, hexRgb } from '../map/networkLayers';
import type { MapView } from '../map/mapView';
import { h, svgIcon } from '../ui/dom';
import { ICONS } from '../ui/icons';
import { ADDITIVE, GLOW_MIN } from './glow';
import { filmFileName, planFilm, renderFilm, videoExportSupported, type FilmInfo } from './timelapseExport';
import {
  cloneTimelapse,
  cumLengths,
  DRAW_PHASE,
  drawnFraction,
  drawnRange,
  frameStats,
  replayAt,
  replayFrames,
  replayStep,
  slicePts,
  snapshotFrame,
  stepSeconds,
  type ReplayStep,
  type Timelapse,
  type TLFrame,
} from './timelapse';

const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
const offsetExt = new PathStyleExtension({ offset: true });
const dashExt = new PathStyleExtension({ offset: true, dash: true });
const MUTED: [number, number, number, number] = [142, 153, 165, 255];
const AMBER: [number, number, number, number] = [255, 194, 74, 230];

interface TrackDatum {
  path: [number, number][];
  built: boolean;
  /** Drawn sideways offset, px at line scale 1 (a four-track pair's push). */
  off: number;
}
interface RouteDatum {
  path: [number, number][];
  color: [number, number, number, number];
  off: number;
}
interface StationDatum {
  pos: [number, number];
  built: boolean;
  /** 0–1: popping in. */
  scale: number;
}

export interface TimelapseHost {
  root: HTMLElement;
  view: MapView;
  game: Game;
  /** Night factor now (the replayed lines glow at night too). */
  glow(): number;
  /** The App hides the live layers and the chrome and pauses (open), and restores them (close). */
  onOpen(): void;
  onClose(): void;
  /** For the video: the company, its logo, yesterday's riders, the map credits and the music. */
  film(): { company: string; logoSvg: string | null; riders: number | null; credits: string; music: string };
}

export class TimelapsePlayer {
  readonly events = new Emitter<{ change: boolean }>();
  private _open = false;
  private playing = false;
  private t = 0;
  private speed: number = CINEMATIC.timelapseSpeeds[0];
  private tl: Timelapse | null = null;
  private frames: TLFrame[] = [];
  private durations: number[] = [];
  private total = 0;
  private stepIdx = -1;
  private step: ReplayStep | null = null;
  /** The step's data built once: old track, old route pieces, and the new edges' full paths. */
  private stat: { track: TrackDatum[]; routes: RouteDatum[]; stations: StationDatum[] } = { track: [], routes: [], stations: [] };
  private anim: { track: TrackDatum[]; routes: RouteDatum[]; stations: StationDatum[]; p: number } = { track: [], routes: [], stations: [], p: -1 };
  private stopAnim: (() => void) | null = null;
  private offFrame: (() => void) | null = null;
  private lastNow = 0;
  private camera: { center: [number, number]; zoom: number; bearing: number; pitch: number } | null = null;
  private colours = new Map<string, [number, number, number]>();
  // DOM
  private head = h('div', { id: 'tl-head' });
  private kicker = h('div', { class: 'tl-kicker' });
  private dateEl = h('div', { class: 'tl-date num' });
  private statsEl = h('div', { class: 'tl-stats num' });
  private bar = h('div', { id: 'tl-bar', class: 'hw-panel' });
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private speedSeg = h('div', { class: 'seg' });
  // Video export: a card for the options and progress, and a sheet that keeps the map still.
  private exporting: AbortController | null = null;
  private card = h('div', { id: 'tl-export', class: 'hw-panel' });
  private sheet = h('div', { id: 'tl-sheet' });
  private saveBtn: HTMLButtonElement | null = null;

  constructor(private host: TimelapseHost) {
    this.head.append(this.kicker, this.dateEl, this.statsEl);
    this.playBtn = h('button', { class: 'hw-btn ghost small', title: 'Play / pause (Space)', onclick: () => this.togglePlay() }) as HTMLButtonElement;
    this.scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'tl-scrub', 'aria-label': 'Timelapse position' }) as HTMLInputElement;
    this.scrub.addEventListener('input', () => {
      this.playing = false;
      this.seek((Number(this.scrub.value) / 1000) * this.total);
      this.renderControls();
    });
    const close = h('button', { class: 'hw-btn ghost small', title: 'Close (Esc)', onclick: () => this.close() }, svgIcon(ICONS.close));
    if (videoExportSupported()) this.saveBtn = h('button', { class: 'hw-btn small', title: 'Save the timelapse as an MP4 video', onclick: () => this.openExport() }, svgIcon(ICONS.download), 'Save video') as HTMLButtonElement;
    this.bar.append(this.playBtn, this.scrub, this.speedSeg, h('span', { class: 'tl-keys hw-muted' }, 'Space · ← → · Esc'), ...(this.saveBtn ? [this.saveBtn] : []), close);
  }

  get open(): boolean {
    return this._open;
  }

  /** Open the player at the start of the replay and play. */
  show(): void {
    if (this._open) return;
    const g = this.host.game;
    // A clone: the network as it is now joins it as the last frame without touching the save's timelapse.
    const tl = cloneTimelapse(g.timelapse);
    const now = snapshotFrame(tl, g.day, g.network, g.routes);
    this.tl = tl;
    this.frames = replayFrames(tl, now, 0);
    this.durations = this.frames.map((f, i) => (i === 0 ? 0 : stepSeconds(this.frames[i - 1], f, CINEMATIC.timelapseSecondsPerMonth)));
    this.total = this.durations.reduce((a, b) => a + b, 0);
    this.stepIdx = -1;
    this.t = 0;
    this._open = true;
    const map = this.host.view.map;
    const c = map.getCenter();
    this.camera = { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    this.fitNetwork(now);
    this.host.onOpen();
    this.host.root.append(this.head, this.bar);
    this.kicker.textContent = `Timelapse · ${city().name}`;
    this.offFrame = this.host.view.events.on('frame', (t) => this.frame(t));
    this.seek(0);
    this.play(true);
    this.events.emit('change', true);
  }

  close(): void {
    if (!this._open) return;
    this.exporting?.abort();
    this.closeExport();
    this._open = false;
    this.play(false);
    this.offFrame?.();
    this.offFrame = null;
    this.head.remove();
    this.bar.remove();
    this.tl = null;
    this.step = null;
    this.stat = { track: [], routes: [], stations: [] };
    this.anim = { track: [], routes: [], stations: [], p: -1 };
    this.host.onClose();
    const cam = this.camera;
    if (cam) this.host.view.map.easeTo({ ...cam, duration: 600 });
    this.camera = null;
    this.events.emit('change', false);
  }

  /** Keys while open: Space, ← →, Esc (everything else is swallowed). */
  key(e: KeyboardEvent): boolean {
    if (!this._open) return false;
    // While the video renders only Esc does anything (it cancels); with the card open, Esc shuts it.
    if (this.exporting || this.card.isConnected) {
      if (e.key === 'Escape') {
        if (this.exporting) this.exporting.abort();
        else this.closeExport();
      }
      return true;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) this.togglePlay();
        break;
      case 'ArrowLeft':
        this.jump(-1);
        break;
      case 'ArrowRight':
        this.jump(1);
        break;
      case 'Escape':
        this.close();
        break;
    }
    return true;
  }

  private togglePlay(): void {
    if (!this.playing && this.t >= this.total - 1e-6) this.seek(0);
    this.play(!this.playing);
  }

  private play(on: boolean): void {
    this.playing = on;
    if (on && !this.stopAnim) this.stopAnim = this.host.view.beginAnimation();
    if (!on && this.stopAnim) {
      this.stopAnim();
      this.stopAnim = null;
    }
    this.lastNow = performance.now();
    this.renderControls();
    this.host.view.invalidate();
  }

  /** To the start of the previous / next month's step (the end, for the last). */
  private jump(dir: -1 | 1): void {
    const { step, p } = replayAt(this.durations, this.t);
    // The step into frame i starts at the sum of the durations before it; a step's end is the
    // next one's start (the last ends at the total).
    const startOf = (i: number) => this.durations.slice(0, i).reduce((a, b) => a + b, 0);
    const endOf = (i: number) => startOf(i + 1);
    // → shows the next month finished; ← the previous one (or this one's start).
    const target = dir > 0 ? (p < 1 ? endOf(step) : endOf(Math.min(this.frames.length - 1, step + 1))) : p > 0.15 && step > 1 ? endOf(step - 1) : step > 1 ? endOf(step - 2) : 0;
    this.play(false);
    this.seek(target);
  }

  private seek(t: number): void {
    this.t = Math.max(0, Math.min(this.total, t));
    this.update();
  }

  private frame(now: number): void {
    if (!this._open) return;
    const dt = Math.max(0, Math.min(0.1, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (!this.playing) return;
    this.t = Math.min(this.total, this.t + dt * this.speed);
    this.update();
    if (this.t >= this.total) this.play(false);
  }

  /** Recompute the step's data when the step changes, the animated pieces every frame. */
  private update(): void {
    const tl = this.tl;
    if (!tl || this.frames.length < 2) {
      this.renderHead(this.frames[0] ?? null, null, 1);
      this.renderControls();
      return;
    }
    const { step, p } = replayAt(this.durations, this.t);
    if (step !== this.stepIdx) {
      this.stepIdx = step;
      this.step = replayStep(tl, this.frames[step - 1], this.frames[step], MAP.interlineSpacingPx, MAP.routeLineWidthPx, QUAD.pairGapPx);
      this.buildStatic();
      this.anim.p = -1;
    }
    this.buildAnimated(p);
    this.renderHead(this.frames[step - 1], this.frames[step], p);
    this.renderControls();
    this.host.view.invalidate();
  }

  private lonLat(pts: [number, number][]): [number, number][] {
    return pts.map(([x, y]) => toLonLat(x, y));
  }

  private rgba(hex: string, running: boolean): [number, number, number, number] {
    let c = this.colours.get(hex);
    if (!c) this.colours.set(hex, (c = hexRgb(hex)));
    return [c[0], c[1], c[2], running ? 255 : 115];
  }

  /** A four-track pair's drawn push with no routes (px at line scale 1). */
  private trackOff(id: number, flip: boolean): number {
    const away = this.tl?.edges.get(id)?.away ?? 0;
    const push = away * (MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2);
    return flip ? -push : push;
  }

  private buildStatic(): void {
    const tl = this.tl!, st = this.step!;
    const fresh = new Set(st.newEdges.map((n) => n.e.id));
    const track: TrackDatum[] = [];
    for (const e of st.oldEdges) {
      const pts = tl.edges.get(e.id)?.pts;
      if (!pts) continue;
      const L = cumLengths(pts);
      let path = slicePts(pts, 0, L[L.length - 1]);
      if (e.flip) path = path.reverse();
      track.push({ path: this.lonLat(path), built: e.built, off: this.trackOff(e.id, e.flip) });
    }
    const routes: RouteDatum[] = [];
    const shapes = tl.shapes;
    for (const r of st.pieces) {
      if (fresh.has(r.edge)) continue;
      const pts = tl.edges.get(r.edge)?.pts;
      if (!pts) continue;
      let path = slicePts(pts, r.s0, r.s1);
      if (r.flip) path = path.reverse();
      routes.push({ path: this.lonLat(path), color: this.rgba(shapes[r.shape]?.color ?? '#8e99a5', r.running), off: r.offsetPx });
    }
    this.stat = { track, routes, stations: st.stations.filter((s) => s.t <= 0).map((s) => ({ pos: toLonLat(s.x, s.y), built: s.built, scale: 1 })) };
  }

  private buildAnimated(p: number): void {
    const tl = this.tl!, st = this.step!;
    // Nothing moves in the hold after the draw phase: keep the objects.
    const q = Math.min(1, p / DRAW_PHASE);
    if (this.anim.p >= 0 && Math.min(1, this.anim.p / DRAW_PHASE) === q) return;
    this.anim.p = p;
    const track: TrackDatum[] = [];
    const drawn = new Map<number, [number, number]>();
    for (const { e, slot } of st.newEdges) {
      const pts = tl.edges.get(e.id)?.pts;
      if (!pts) continue;
      const f = drawnFraction(slot, p);
      if (f <= 0) continue;
      const L = cumLengths(pts);
      const range = drawnRange(L[L.length - 1], slot, f);
      drawn.set(e.id, range);
      let path = slicePts(pts, range[0], range[1]);
      if (e.flip) path = path.reverse();
      track.push({ path: this.lonLat(path), built: e.built, off: this.trackOff(e.id, e.flip) });
    }
    const routes: RouteDatum[] = [];
    for (const r of st.pieces) {
      const range = drawn.get(r.edge);
      if (!range) continue;
      const a = Math.max(r.s0, range[0]), b = Math.min(r.s1, range[1]);
      if (b - a < 0.5) continue;
      const pts = tl.edges.get(r.edge)!.pts;
      let path = slicePts(pts, a, b);
      if (r.flip) path = path.reverse();
      routes.push({ path: this.lonLat(path), color: this.rgba(tl.shapes[r.shape]?.color ?? '#8e99a5', r.running), off: r.offsetPx });
    }
    const stations: StationDatum[] = [];
    for (const s of st.stations) {
      if (s.t <= 0 || q < s.t) continue;
      stations.push({ pos: toLonLat(s.x, s.y), built: s.built, scale: Math.min(1, (q - s.t) / 0.08) });
    }
    this.anim = { track, routes, stations, p };
  }

  private renderHead(from: TLFrame | null, to: TLFrame | null, p: number): void {
    const tl = this.tl;
    if (!tl || !to || !from) {
      this.dateEl.textContent = monthLabel(this.host.game.day);
      this.statsEl.textContent = 'Nothing built yet: build track and the timelapse records your network at every month end';
      return;
    }
    const q = Math.min(1, p / DRAW_PHASE);
    if (!to.edges.length && !from.edges.length) {
      this.dateEl.textContent = monthLabel(to.day);
      this.statsEl.textContent = 'Nothing built yet: build track and the timelapse records your network at every month end';
      return;
    }
    const day = Math.round(from.day + (to.day - from.day) * q);
    this.dateEl.textContent = this.stepIdx === this.frames.length - 1 && q >= 1 ? `${monthLabel(day)} · now` : monthLabel(day);
    const a = frameStats(tl, from), b = frameStats(tl, to);
    const lerp = (x: number, y: number) => Math.round(x + (y - x) * q);
    const km = a.trackM + (b.trackM - a.trackM) * q;
    const n = lerp(a.stations, b.stations), r = q >= 1 ? b.routes : a.routes;
    this.statsEl.textContent = timelapseStats(km, n, r);
  }

  private renderControls(): void {
    this.playBtn.replaceChildren(svgIcon(this.playing ? ICONS.pause : ICONS.play));
    this.scrub.value = String(this.total > 0 ? Math.round((this.t / this.total) * 1000) : 1000);
    this.speedSeg.replaceChildren(
      ...CINEMATIC.timelapseSpeeds.map((s) => h('button', { class: s === this.speed ? 'on' : '', onclick: () => { this.speed = s; this.renderControls(); } }, `${s}×`)),
    );
  }

  /** Frame the final network (keeping the bearing and pitch). */
  private fitNetwork(now: TLFrame, duration = 900): void {
    const tl = this.tl;
    if (!tl) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of now.edges) {
      const pts = tl.edges.get(e.id)?.pts;
      if (!pts) continue;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]);
        x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]);
        y1 = Math.max(y1, pts[i + 1]);
      }
    }
    if (!Number.isFinite(x0)) return;
    const map = this.host.view.map;
    const pad = 400;
    const sw = toLonLat(x0 - pad, y0 - pad), ne = toLonLat(x1 + pad, y1 + pad);
    // Room for the date at the top and the controls at the bottom, scaled down on small screens.
    const cw = map.getContainer().clientWidth || 1280, ch = map.getContainer().clientHeight || 800;
    const padding = { top: Math.min(140, ch * 0.2), bottom: Math.min(120, ch * 0.14), left: Math.min(60, cw * 0.06), right: Math.min(60, cw * 0.06) };
    map.fitBounds([sw, ne], { padding, bearing: map.getBearing(), pitch: map.getPitch(), duration, maxZoom: 15 });
  }

  // ------------------------------------------------------------------ save as video
  private openExport(): void {
    if (this.exporting || !this._open) return;
    this.play(false);
    const canvas = this.host.view.map.getCanvas();
    const plan = planFilm(this.total, canvas.width, canvas.height);
    const film = this.host.film();
    const music = h('input', { type: 'checkbox' }) as HTMLInputElement;
    music.checked = true;
    const secs = Math.round(plan.seconds);
    this.card.replaceChildren(
      h('div', { class: 'tl-ex-title' }, 'Save as video'),
      h(
        'div',
        { class: 'hw-muted tl-ex-text' },
        `An MP4 of ${film.company} growing, month by month: ${secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s`} at ${plan.width} × ${plan.height}${plan.speed > 1.05 ? `, played at ${plan.speed.toFixed(1)}×` : ''}. It renders here in your browser; keep this tab open.`,
      ),
      h('label', { class: 'found-check tl-ex-check' }, music, ' Music: “Lights at Night” (CC0)'),
      h('div', { class: 'tl-ex-foot' }, h('button', { class: 'hw-btn small ghost', onclick: () => this.closeExport() }, 'Cancel'), h('button', { class: 'hw-btn small primary', onclick: () => void this.runExport(music.checked) }, 'Save video')),
    );
    this.host.root.append(this.sheet, this.card);
  }

  private closeExport(): void {
    this.card.remove();
    this.sheet.remove();
    this.host.root.classList.remove('tl-exporting');
  }

  private async runExport(withMusic: boolean): Promise<void> {
    if (this.exporting) return;
    const ac = new AbortController();
    this.exporting = ac;
    const keepT = this.t;
    const film = this.host.film();
    const bar = h('div', { class: 'tl-ex-bar' }, h('i'));
    const label = h('div', { class: 'tl-ex-text num' }, 'Getting the map ready…');
    this.card.replaceChildren(h('div', { class: 'tl-ex-title' }, 'Rendering your timelapse'), label, bar, h('div', { class: 'tl-ex-foot' }, h('span', { class: 'hw-muted tl-ex-hint' }, 'Esc cancels'), h('button', { class: 'hw-btn small ghost', onclick: () => ac.abort() }, 'Cancel')));
    this.host.root.classList.add('tl-exporting');
    const last = this.frames[this.frames.length - 1];
    if (last) this.fitNetwork(last, 0);
    await this.host.view.tilesLoaded();
    const info: FilmInfo = {
      company: film.company,
      logoSvg: film.logoSvg,
      city: city().name,
      span: `${monthLabel(this.frames[0]?.day ?? this.host.game.day)} – ${monthLabel(this.host.game.day)}`,
      riders: film.riders && film.riders > 0 ? `${Math.round(film.riders).toLocaleString('en-GB')} journeys a day` : null,
      credits: film.credits,
      music: withMusic ? film.music : null,
    };
    const t0 = performance.now();
    try {
      const res = await renderFilm(
        {
          duration: this.total,
          showAt: (t) => {
            this.seek(t);
            return { date: this.dateEl.textContent ?? '', stats: this.statsEl.textContent ?? '' };
          },
          draw: () => this.host.view.drawNow(),
        },
        info,
        {
          signal: ac.signal,
          onProgress: (done, total) => {
            const f = done / total;
            (bar.firstChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
            const el = (performance.now() - t0) / 1000;
            const left = f > 0.03 ? Math.max(0, Math.round((el / f) * (1 - f))) : null;
            label.textContent = `${Math.round(f * 100)}%${left !== null ? ` · about ${left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`} left` : ''}`;
          },
        },
      );
      const name = filmFileName(film.company);
      const url = URL.createObjectURL(res.blob);
      const a = h('a', { href: url, download: name }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      const mb = res.blob.size / 1e6;
      this.card.replaceChildren(
        h('div', { class: 'tl-ex-title' }, 'Video saved'),
        h('div', { class: 'hw-muted tl-ex-text' }, `${name} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB · ${Math.round(res.seconds)} s${res.audio ? ' with music' : withMusic ? ' (no music: this browser can’t encode audio)' : ''}. Check your downloads.`),
        h('div', { class: 'tl-ex-foot' }, h('a', { class: 'hw-btn small ghost', href: url, download: name }, 'Download again'), h('button', { class: 'hw-btn small primary', onclick: () => this.closeExport() }, 'Done')),
      );
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === 'AbortError';
      if (cancelled) this.closeExport();
      else
        this.card.replaceChildren(
          h('div', { class: 'tl-ex-title' }, 'Couldn’t make the video'),
          h('div', { class: 'hw-muted tl-ex-text' }, e instanceof Error ? e.message : String(e)),
          h('div', { class: 'tl-ex-foot' }, h('button', { class: 'hw-btn small primary', onclick: () => this.closeExport() }, 'OK')),
        );
    } finally {
      this.exporting = null;
      this.host.root.classList.remove('tl-exporting');
      if (this._open) this.seek(keepT);
    }
  }

  /** The replay's deck.gl layers (the App draws only these while the player is open). */
  layers(): Layer[] {
    if (!this._open || !this.step) return [];
    const k = lineScale(this.host.view.map.getZoom());
    const tw = 3 * k, rw = MAP.routeLineWidthPx * k;
    const glow = this.host.glow();
    const out: (Layer | false)[] = [];
    const track = (id: string, data: TrackDatum[]) =>
      data.length > 0 &&
      new PathLayer<TrackDatum, PathStyleExtensionProps<TrackDatum>>({
        id,
        data,
        getPath: (d) => d.path,
        getColor: (d) => (d.built ? MUTED : AMBER),
        getWidth: tw,
        widthUnits: 'pixels',
        getOffset: (d) => d.off / 3,
        getDashArray: (d) => (d.built ? [0, 0] : [3, 2]),
        dashJustified: true,
        extensions: [dashExt],
        parameters: DEPTH,
      });
    const routes = (id: string, data: RouteDatum[]) => [
      glow >= GLOW_MIN &&
        data.length > 0 &&
        new PathLayer<RouteDatum, PathStyleExtensionProps<RouteDatum>>({
          id: `${id}-glow`,
          data,
          getPath: (d) => d.path,
          getColor: (d) => [d.color[0], d.color[1], d.color[2], Math.round(d.color[3] * 0.4)],
          getWidth: rw + 10 * k,
          widthUnits: 'pixels',
          capRounded: true,
          getOffset: (d) => d.off / (MAP.routeLineWidthPx + 10),
          extensions: [offsetExt],
          opacity: glow,
          parameters: ADDITIVE,
        }),
      data.length > 0 &&
        new PathLayer<RouteDatum, PathStyleExtensionProps<RouteDatum>>({
          id,
          data,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: rw,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          getOffset: (d) => d.off / MAP.routeLineWidthPx,
          extensions: [offsetExt],
          parameters: DEPTH,
        }),
    ];
    const stations = (id: string, data: StationDatum[]) =>
      data.length > 0 &&
      new ScatterplotLayer<StationDatum>({
        id,
        data,
        getPosition: (d) => d.pos,
        getRadius: (d) => 4.5 * k * d.scale,
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: [255, 255, 255, 255],
        getLineColor: (d) => (d.built ? [22, 27, 33, 255] : [255, 194, 74, 255]),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        parameters: DEPTH,
        updateTriggers: { getRadius: k },
      });
    out.push(track('tl-track', this.stat.track), track('tl-track-new', this.anim.track));
    out.push(...routes('tl-routes', this.stat.routes), ...routes('tl-routes-new', this.anim.routes));
    out.push(stations('tl-stations', this.stat.stations), stations('tl-stations-new', this.anim.stations));
    return out.filter(Boolean) as Layer[];
  }

  destroy(): void {
    if (this._open) this.close();
  }
}
