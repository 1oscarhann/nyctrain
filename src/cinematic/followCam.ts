/**
 * Follow-cam (docs/v2/cinematic.md §1, §3): locks the camera to a train or to any moving point.
 * In 3D a chase camera behind and above the target, aimed at its track height, its bearing eased
 * to the target's heading; in 2D a centre lock. One jumpTo per frame while following, nothing
 * otherwise. Esc (the App), dragging, rotating or pitching the map by hand end it; the wheel sets
 * the chase distance (3D) or the zoom (2D).
 *
 * Hooks for other features (Commuter stories): follow({ kind: 'point', label, pose }) follows
 * anything that can say where it is each frame; `events.on('change')` reports starts and ends.
 */
import type { MapMouseEvent, MapLibreEvent } from 'maplibre-gl';
import { CINEMATIC, MAP } from '../balance';
import { Emitter } from '../core/emitter';
import { toLonLat } from '../core/geo';
import type { MapView } from '../map/mapView';
import { chaseCentre, distanceForZoom, easeAngle, easeValue, zoomForDistance, type FollowPose } from './chase';

export type { FollowPose };

export type FollowTarget =
  | { kind: 'train'; id: number }
  /** Anything that moves: `pose` is asked every frame (null: lost for now). */
  | { kind: 'point'; label: string; pose: (now: number) => FollowPose | null };

export type FollowEndReason = 'user' | 'drag' | 'lost' | 'replaced' | 'timelapse';

export interface FollowEvents extends Record<string, unknown> {
  change: { target: FollowTarget | null; reason?: FollowEndReason };
}

export interface FollowHost {
  view: MapView;
  /** A train's pose as drawn (interpolated, with its lateral offset), or null when it is not in the snapshot. */
  trainPose(id: number, now: number): FollowPose | null;
  /** Interpolated game time (s): a lost target is waited for CINEMATIC.followLostGameSec. */
  gameTime(): number;
}

export class FollowCam {
  readonly events = new Emitter<FollowEvents>();
  private _target: FollowTarget | null = null;
  private stopAnim: (() => void) | null = null;
  private last = 0;
  private bearing = 0;
  private pitch = 0;
  /** Chase distance the camera eases to (m), and where it is now. */
  private distance: number = CINEMATIC.chaseDistance;
  private dist = CINEMATIC.chaseDistance;
  private lostSince: number | null = null;
  private limits: { pitch: number; zoom: number } | null = null;
  private offFrame: (() => void) | null = null;
  private destroyed = false;

  constructor(private host: FollowHost) {
    const map = host.view.map;
    map.on('dragstart', this.onUserMove);
    map.on('rotatestart', this.onUserTurn);
    map.on('pitchstart', this.onUserTurn);
    map.getCanvasContainer().addEventListener('wheel', this.onWheel, { capture: true, passive: false });
  }

  get target(): FollowTarget | null {
    return this._target;
  }

  get following(): boolean {
    return this._target !== null;
  }

  /** The followed train's id, or null. */
  get trainId(): number | null {
    return this._target?.kind === 'train' ? this._target.id : null;
  }

  follow(target: FollowTarget): void {
    const map = this.host.view.map;
    if (this._target) this.end('replaced', false);
    this._target = target;
    this.lostSince = null;
    this.last = performance.now();
    this.bearing = map.getBearing();
    this.pitch = map.getPitch();
    // Start from where the camera is (no closer than the minimum), easing in to the default.
    const lat = map.getCenter().lat;
    const h = map.getCanvas().clientHeight || 800;
    this.dist = Math.max(CINEMATIC.chaseDistanceMin, Math.min(CINEMATIC.chaseDistanceMax * 4, distanceForZoom(map.getZoom(), h, lat)));
    this.distance = Math.min(CINEMATIC.chaseDistance, this.dist);
    if (!this.limits) {
      this.limits = { pitch: map.getMaxPitch(), zoom: map.getMaxZoom() };
      map.setMaxPitch(CINEMATIC.chaseMaxPitch);
      map.setMaxZoom(CINEMATIC.chaseMaxZoom);
    }
    this.stopAnim ??= this.host.view.beginAnimation();
    this.offFrame ??= this.host.view.events.on('frame', (now) => this.update(now));
    this.events.emit('change', { target });
  }

  /** Stop following (Esc, the train panel, another feature). */
  stop(reason: FollowEndReason = 'user'): void {
    if (this._target) this.end(reason, true);
  }

  private end(reason: FollowEndReason, settle: boolean): void {
    this._target = null;
    this.lostSince = null;
    if (settle) {
      this.stopAnim?.();
      this.stopAnim = null;
      this.offFrame?.();
      this.offFrame = null;
      const map = this.host.view.map;
      const lim = this.limits;
      this.limits = null;
      if (lim) {
        // Back inside the usual limits smoothly, then restore them.
        const pitch = Math.min(map.getPitch(), this.host.view.is3D ? MAP.tiltPitch : 0);
        const zoom = Math.min(map.getZoom(), lim.zoom);
        map.easeTo({ pitch, zoom, duration: 500 });
        const restore = () => {
          if (this.limits || this.destroyed) return; // following again
          if (map.getMaxPitch() !== lim.pitch) map.setMaxPitch(lim.pitch);
          if (map.getMaxZoom() !== lim.zoom) map.setMaxZoom(lim.zoom);
        };
        map.once('moveend', restore);
        setTimeout(restore, 800);
      }
    }
    this.events.emit('change', { target: null, reason });
  }

  private pose(now: number): FollowPose | null {
    const t = this._target;
    if (!t) return null;
    return t.kind === 'train' ? this.host.trainPose(t.id, now) : t.pose(now);
  }

  /** Once per frame while following (MapView's frame event, before the layers are collected). */
  private update(now: number): void {
    if (!this._target) return;
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const p = this.pose(now);
    if (!p) {
      const t = this.host.gameTime();
      this.lostSince ??= t;
      if (t - this.lostSince > CINEMATIC.followLostGameSec) this.stop('lost');
      return;
    }
    this.lostSince = null;
    const view = this.host.view;
    const map = view.map;
    const is3D = view.is3D;
    this.pitch = easeValue(this.pitch, is3D ? CINEMATIC.chasePitch : 0, dt, CINEMATIC.chasePitchTau);
    if (is3D) {
      this.bearing = easeAngle(this.bearing, p.heading, dt, CINEMATIC.chaseBearingTau);
      this.dist = easeValue(this.dist, this.distance, dt, 0.6);
      const c = chaseCentre({ ...p, heading: this.bearing }, this.pitch, CINEMATIC.chaseLookAhead);
      const [lon, lat] = toLonLat(c.x, c.y);
      const zoom = Math.min(CINEMATIC.chaseMaxZoom, zoomForDistance(this.dist, map.getCanvas().clientHeight || 800, lat));
      map.jumpTo({ center: [lon, lat], zoom, bearing: this.bearing, pitch: this.pitch });
    } else {
      // 2D: centre lock; the bearing and zoom stay the player's.
      this.bearing = map.getBearing();
      const [lon, lat] = toLonLat(p.x, p.y);
      map.jumpTo({ center: [lon, lat], pitch: this.pitch });
    }
  }

  private onUserMove = () => {
    if (this._target) this.stop('drag');
  };

  private onUserTurn = (e: MapLibreEvent<MouseEvent | TouchEvent | WheelEvent | undefined>) => {
    // Our own jumpTo rotates and pitches too, without an originalEvent.
    if (this._target && (e as MapMouseEvent).originalEvent) this.stop('drag');
  };

  private onWheel = (e: WheelEvent) => {
    if (!this._target) return;
    e.preventDefault();
    e.stopPropagation();
    const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))));
    if (this.host.view.is3D) this.distance = Math.max(CINEMATIC.chaseDistanceMin, Math.min(CINEMATIC.chaseDistanceMax, this.distance * k));
    else {
      const map = this.host.view.map;
      map.setZoom(Math.max(map.getMinZoom(), Math.min(MAP.maxZoom, map.getZoom() - Math.log2(k))));
    }
  };

  destroy(): void {
    const map = this.host.view.map;
    this.destroyed = true;
    this._target = null;
    this.stopAnim?.();
    this.offFrame?.();
    map.off('dragstart', this.onUserMove);
    map.off('rotatestart', this.onUserTurn);
    map.off('pitchstart', this.onUserTurn);
    map.getCanvasContainer().removeEventListener('wheel', this.onWheel, { capture: true });
  }
}
