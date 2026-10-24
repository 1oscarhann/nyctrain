/**
 * Cinematic (v2, docs/v2/cinematic.md), owned by the App: the day/night cycle and the night glow,
 * the follow-cam, photo mode and the timelapse player, their keys and their settings. Main thread
 * only: it reads game state and the latest snapshot and never sends anything to the worker, so
 * the simulation is the same with all of it in use.
 *
 * Hooks for other features (Commuter stories):
 * - `follow.follow({ kind: 'point', label, pose })` follows anything that can say where it is
 *   each frame; `follow.follow({ kind: 'train', id })` a train; `follow.events.on('change')`;
 * - `trainPose(id, now)` is a train's pose as drawn (interpolated, interline and pair offsets);
 * - photo mode and the timelapse hide the chrome with a class on the root and keep the panels;
 *   `chromeHidden` and `events.on('chrome')` tell a feature when its own chrome should hide.
 */
import type { Map as MLMap } from 'maplibre-gl';
import { CINEMATIC } from '../balance';
import { Emitter } from '../core/emitter';
import { lineScale } from '../map/networkLayers';
import { SNAP_HELD } from '../sim/protocol';
import { drawnTrainPose } from '../trains/trainPose';
import { bullet, h, svgIcon } from '../ui/dom';
import { ICONS } from '../ui/icons';
import type { App } from '../ui/app';
import { followStatus } from '../ui/cinematicText';
import type { FollowPose } from './chase';
import { Daylight, type DayNightMode } from './daylight';
import { FollowCam, type FollowEndReason, type FollowTarget } from './followCam';
import { PhotoMode } from './photoMode';
import { loadPrefs, storePrefs, type CinematicPrefs } from './prefs';
import { TimelapsePlayer } from './timelapsePlayer';
import type { WeatherTint } from './palette';

export type { FollowPose, FollowTarget };

/** The providers photo mode leaves out: the tool's previews and the selection's own drawings. */
const PHOTO_HIDDEN = ['tool', 'flows', 'route-pattern'];
/** Keys photo mode passes on to the App (pause, speeds, the tilt). */
const PHOTO_PASS = new Set([' ', '1', '2', '3', '4', 'v', 'V']);

export class Cinematic {
  readonly prefs: CinematicPrefs;
  readonly daylight: Daylight;
  readonly follow: FollowCam;
  readonly photo: PhotoMode;
  readonly timelapse: TimelapsePlayer;
  /** chrome: true while photo mode or the timelapse hides the UI. */
  readonly events = new Emitter<{ chrome: boolean }>();
  private night = 0;
  private chip = h('div', { id: 'follow-chip', class: 'hw-panel' });
  private chipKey = '';
  private speedBefore: number | null = null;
  private hiddenLayers: string[] = [];

  constructor(private app: App) {
    this.prefs = loadPrefs();
    const view = app.view;
    this.daylight = Daylight.for(view.map, {
      mode: this.prefs.dayNight,
      windows: this.prefs.windows,
      onNight: (n) => {
        this.night = n;
        app.network.setGlow(n);
        view.invalidate();
      },
    });
    this.follow = new FollowCam({ view, trainPose: (id, now) => this.trainPose(id, now), gameTime: () => this.gameTime() });
    this.follow.events.on('change', ({ target, reason }) => this.onFollow(target, reason));
    this.photo = new PhotoMode(app.root, view.map.getContainer(), { letterbox: this.prefs.letterbox, caption: this.prefs.caption }, (p) => storePrefs(p));
    this.photo.events.on('change', () => this.onChrome());
    this.timelapse = new TimelapsePlayer({
      root: app.root,
      view,
      game: app.game,
      glow: () => this.glow,
      onOpen: () => this.onTimelapse(true),
      onClose: () => this.onTimelapse(false),
    });
    view.addLayers('timelapse', () => this.timelapse.layers());
    app.root.append(this.chip);
    this.chip.style.display = 'none';
    // The first palette at once (a game starting on the title screen's map takes it over).
    this.tick();
  }

  /** Night factor for the glow layers (0 by day and in Always day). */
  get glow(): number {
    return this.daylight.mode !== 'cycle' ? 0 : this.night;
  }

  /** Photo mode or the timelapse hides the chrome. */
  get chromeHidden(): boolean {
    return this.photo.active || this.timelapse.open;
  }

  /** The weather in force now as a palette tint (clear with chaos off). */
  private weather(): WeatherTint | null {
    const w = this.app.feed.weather();
    return w.kind === 'clear' ? null : { kind: w.kind, severity: w.severity };
  }

  /** Interpolated game time (the game's own clock until the first snapshot arrives, e.g. right after a load). */
  gameTime(): number {
    return this.app.sim.latest ? this.app.sim.time() : this.app.game.time;
  }

  /** A few times a second (App's 250 ms interval): the palette, the caption and the follow chip. */
  tick(): void {
    const t = this.gameTime();
    this.daylight.tick(t, this.weather());
    if (this.photo.active) this.photo.tick(t, this.app.feed.weather());
    this.renderChip();
  }

  // ------------------------------------------------------------------ settings
  setDayNight(mode: DayNightMode): void {
    storePrefs({ dayNight: mode });
    this.prefs.dayNight = mode;
    this.daylight.setMode(mode);
    this.tick();
  }

  setWindows(on: boolean): void {
    storePrefs({ windows: on });
    this.prefs.windows = on;
    this.daylight.setWindows(on);
    this.tick();
  }

  // ------------------------------------------------------------------ follow-cam
  /**
   * A train's pose as the map draws it: interpolated between snapshots, its middle on its route
   * direction, moved sideways by its drawn interline and four-track pair offset (px at this zoom,
   * as metres at the screen centre). Null when the train is not in the latest snapshot.
   */
  trainPose(id: number, now = performance.now()): FollowPose | null {
    const app = this.app;
    const tv = app.sim.trainView(id, now);
    if (!tv) return null;
    const r = app.compiledRoute(tv.route);
    const dir = r?.dirs[tv.dir];
    if (!r || !dir || !dir.cum.length) return null;
    return drawnTrainPose(dir, tv.s, r.trainLength, r.id, app.network.routeOffsets, lineScale(app.view.map.getZoom()), app.view.metresPerPixel(), app.view.is3D);
  }

  /** Follow a train (the train panel's Follow, F); the same train again stops. */
  toggleFollowTrain(id: number): void {
    if (this.follow.trainId === id) this.follow.stop('user');
    else if (!this.timelapse.open) this.follow.follow({ kind: 'train', id });
  }

  private onFollow(target: FollowTarget | null, reason?: FollowEndReason): void {
    if (!target && reason === 'lost') this.app.toast('Stopped following', 'The train left service (a turnaround or a timetable change).', 'amber');
    this.chipKey = '';
    this.renderChip();
    // The train panel's Follow button.
    if (this.app.game.selection?.kind === 'train') this.app.refreshPanel();
  }

  /** The chip under the top bar while following: who, where and any incident or hold. */
  private renderChip(): void {
    const t = this.follow.target;
    const show = !!t && !this.chromeHidden;
    this.chip.style.display = show ? '' : 'none';
    if (!show || !t) return;
    let title: Node | string = t.kind === 'point' ? t.label : 'Train';
    let text = '';
    let tone: string | null = null;
    if (t.kind === 'train') {
      const app = this.app;
      const tv = app.sim.trainView(t.id);
      const r = tv ? app.compiledRoute(tv.route) : null;
      if (tv && r) {
        const dir = r.dirs[tv.dir];
        const st = app.compiled?.net.stations;
        const stopIdx = Math.min(tv.nextStop, dir.stopStation.length - 1);
        const nextSt = st?.[dir.stopStation[stopIdx]];
        const inc = app.feed.activeFor({ trainId: t.id });
        const closed = app.feed.closedStations();
        const s = followStatus({
          held: tv.state === SNAP_HELD,
          dwelling: tv.state === 2,
          next: nextSt?.name ?? '',
          terminal: st?.[dir.stopStation[dir.stopStation.length - 1]]?.name ?? '',
          people: tv.load * app.agentScale,
          incident: inc && (inc.kind === 'breakdown' || inc.kind === 'sick') ? { kind: inc.kind, place: inc.place, until: inc.until } : null,
          nextClosed: nextSt ? closed.has(nextSt.id) : false,
          now: app.sim.time(),
        });
        title = h('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, bullet(r.color, r.bullet, 18, !!r.express, r.shape), r.name);
        text = s.text;
        tone = s.tone;
      } else text = 'Turning round at the terminal: the camera waits for its next departure';
    }
    const key = `${t.kind === 'train' ? t.id : t.label}|${text}|${tone}`;
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.chip.replaceChildren(
      h('span', { class: 'fc-icon' }, svgIcon(ICONS.follow)),
      h('div', { class: 'fc-text' }, h('div', { class: 'fc-title' }, 'Following ', title), h('div', { class: `fc-status ${tone ? 'hw-' + tone : 'hw-muted'}` }, text)),
      h('button', { class: 'hw-btn small', title: 'Stop following (Esc)', onclick: () => this.follow.stop('user') }, 'Stop'),
    );
  }

  // ------------------------------------------------------------------ chrome: photo mode and the timelapse
  private onChrome(): void {
    const app = this.app;
    const hidden = this.chromeHidden;
    app.tools.suspended = hidden;
    app.trains.hideSelection = this.photo.active;
    app.view.setHidden(this.photo.active ? PHOTO_HIDDEN : []);
    if (app.view.map.getLayer('hw-hilite')) app.view.map.setLayoutProperty('hw-hilite', 'visibility', this.photo.active ? 'none' : 'visible');
    app.tooltip.show(null);
    if (this.photo.active) this.photo.tick(this.gameTime(), app.feed.weather());
    this.renderChip();
    this.events.emit('chrome', hidden);
  }

  private onTimelapse(open: boolean): void {
    const app = this.app;
    const map = app.view.map;
    if (open) {
      this.follow.stop('timelapse');
      this.photo.toggle(false);
      app.root.classList.add('hw-timelapse');
      // The game waits while the replay plays (the sim is only paused; nothing else changes).
      this.speedBefore = app.speedIndex;
      if (app.speedIndex >= 0) app.setSpeedIndex(-1);
      this.hiddenLayers = [...app.network.layerIds(), ...app.elevated.layerIds()].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      for (const id of this.hiddenLayers) map.setLayoutProperty(id, 'visibility', 'none');
      app.view.setSolo('timelapse');
    } else {
      app.root.classList.remove('hw-timelapse');
      for (const id of this.hiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
      this.hiddenLayers = [];
      app.view.setSolo(null);
      if (this.speedBefore !== null && this.speedBefore >= 0) app.setSpeedIndex(this.speedBefore);
      this.speedBefore = null;
    }
    this.onChrome();
  }

  openTimelapse(): void {
    if (this.timelapse.open) return;
    this.timelapse.show();
  }

  /** A month closed: the network as it is goes into the timelapse (the save keeps it). */
  recordMonth(day: number): void {
    this.app.game.recordTimelapse(day);
  }

  // ------------------------------------------------------------------ keys
  /**
   * Keys first offered to Cinematic. The timelapse takes every key while open; photo mode its own
   * (P, L, C, F, Esc) and passes Space, 1–4 and V on, swallowing the rest; otherwise P opens photo
   * mode, F follows the selected train (Select tool) and Esc stops following. True: consumed.
   */
  key(e: KeyboardEvent): boolean {
    if (this.timelapse.open) return this.timelapse.key(e);
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (this.photo.active) {
      if (mod) return true;
      switch (k) {
        case 'p':
        case 'P':
        case 'Escape':
          this.photo.toggle(false);
          return true;
        case 'l':
        case 'L':
          this.photo.setLetterbox();
          return true;
        case 'c':
        case 'C':
          this.photo.setCaption();
          this.photo.tick(this.gameTime(), this.app.feed.weather());
          return true;
        case 'f':
        case 'F':
          this.followKey();
          return true;
        default:
          return !PHOTO_PASS.has(k);
      }
    }
    if (mod) return false;
    if (k === 'p' || k === 'P') {
      this.photo.toggle(true);
      return true;
    }
    if (k === 'Escape' && this.follow.following) {
      this.follow.stop('user');
      return true;
    }
    if ((k === 'f' || k === 'F') && this.app.tools.active?.id === 'select') return this.followKey();
    return false;
  }

  /** F: follow the selected train, or stop following. */
  private followKey(): boolean {
    const sel = this.app.game.selection;
    if (sel?.kind === 'train') {
      this.toggleFollowTrain(sel.id);
      return true;
    }
    if (this.follow.following) {
      this.follow.stop('user');
      return true;
    }
    return false;
  }

  destroy(): void {
    this.timelapse.destroy();
    this.follow.destroy();
    this.photo.destroy();
    this.chip.remove();
  }
}

/** The title screen's light: a fixed blue hour over the skyline, windows lit (Always day: the plain map). */
export function titleLight(map: MLMap): void {
  const prefs = loadPrefs();
  const d = Daylight.for(map, { mode: prefs.dayNight, windows: prefs.windows });
  if (prefs.dayNight !== 'cycle') d.tick(0, null);
  else d.applyAt({ altitude: CINEMATIC.titleSunAltitude, azimuth: CINEMATIC.titleSunAzimuth, morning: false }, null);
}
