/**
 * The map: MapLibre with the recoloured basemap, the flat ⇄ 3D tilt animation,
 * x-ray building opacity and the deck.gl overlay (interleaved).
 */
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';
import { MAP } from '../balance';
import { city } from '../cities';
import { Emitter } from '../core/emitter';
import { BUILDING_HEIGHT_STATE, BUILDING_LAYER, loadStyle } from './style';

export interface MapViewEvents extends Record<string, unknown> {
  view3d: boolean;
  frame: number;
}

type LayerProvider = () => (Layer | null | false | undefined)[];

export class MapView {
  readonly map: MLMap;
  readonly events = new Emitter<MapViewEvents>();
  private overlay: MapboxOverlay;
  private providers = new Map<string, LayerProvider>();
  private dirty = true;
  private animating = 0;
  private _is3D = false;
  private xray = false;
  private buildingScale = 0;
  private tiltToken = 0;

  private constructor(map: MLMap) {
    this.map = map;
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay);
    map.on('move', () => this.invalidate());
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.animating > 0) this.dirty = true;
      if (this.dirty) {
        this.dirty = false;
        this.events.emit('frame', performance.now());
        this.overlay.setProps({ layers: this.collectLayers() });
      }
    };
    requestAnimationFrame(loop);
  }

  static async create(container: HTMLElement): Promise<MapView> {
    const style = await loadStyle();
    const map = new maplibregl.Map({
      container,
      style,
      center: MAP.startCenter,
      zoom: MAP.startZoom,
      minZoom: MAP.minZoom,
      maxZoom: MAP.maxZoom,
      maxBounds: MAP.bounds,
      maxPitch: 70,
      // Map attribution comes from the OpenFreeMap TileJSON (OpenFreeMap © OpenMapTiles,
      // OpenStreetMap); some cities' data licences add a line (London: ONS, OGL v3.0).
      attributionControl: { compact: false, ...(city().attribution ? { customAttribution: city().attribution } : {}) },
      canvasContextAttributes: { antialias: true },
      fadeDuration: 150,
    });
    map.doubleClickZoom.disable(); // double-click finishes track
    map.keyboard.disable(); // game shortcuts own the keyboard
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    await new Promise<void>((resolve) => map.once('load', () => resolve()));
    return new MapView(map);
  }

  get is3D(): boolean {
    return this._is3D;
  }

  /** Register a function that returns deck.gl layers. Providers are drawn in registration order. */
  addLayers(id: string, provider: LayerProvider): void {
    this.providers.set(id, provider);
    this.invalidate();
  }

  /** Request a deck.gl layer refresh on the next animation frame. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Keep re-rendering every frame while something animates (trains, pulses). */
  beginAnimation(): () => void {
    this.animating++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.animating--;
      }
    };
  }

  private collectLayers(): Layer[] {
    const out: Layer[] = [];
    for (const p of this.providers.values()) {
      for (const l of p()) if (l) out.push(l);
    }
    return out;
  }

  /** Flat ⇄ tilted 3D. Buildings grow from zero while the camera tilts, and sink back going flat. */
  setView3D(on: boolean): void {
    if (on === this._is3D) return;
    this._is3D = on;
    const token = ++this.tiltToken;
    const map = this.map;
    if (on) map.setLayoutProperty(BUILDING_LAYER, 'visibility', 'visible');
    map.easeTo({ pitch: on ? MAP.tiltPitch : 0, duration: MAP.tiltDurationMs, easing: easeInOut });
    const from = this.buildingScale;
    const to = on ? 1 : 0;
    const start = performance.now();
    let lastStep = -1;
    const stop = this.beginAnimation();
    const step = () => {
      if (token !== this.tiltToken) return stop();
      const t = Math.min(1, (performance.now() - start) / MAP.tiltDurationMs);
      // Quantised so building tiles are re-tessellated only a handful of times.
      const s = Math.round(easeInOut(t) * MAP.buildingGrowSteps);
      if (s !== lastStep || t >= 1) {
        lastStep = s;
        this.buildingScale = from + (to - from) * (t >= 1 ? 1 : s / MAP.buildingGrowSteps);
        map.setGlobalStateProperty(BUILDING_HEIGHT_STATE, this.buildingScale);
      }
      if (t < 1) requestAnimationFrame(step);
      else {
        if (!on) map.setLayoutProperty(BUILDING_LAYER, 'visibility', 'none');
        stop();
      }
    };
    requestAnimationFrame(step);
    this.events.emit('view3d', on);
    this.invalidate();
  }

  /** Snap straight to the flat view (no animation) — used when a game starts from the title. */
  resetFlat(): void {
    this.tiltToken++;
    this._is3D = false;
    this.buildingScale = 0;
    this.map.setGlobalStateProperty(BUILDING_HEIGHT_STATE, 0);
    this.map.setLayoutProperty(BUILDING_LAYER, 'visibility', 'none');
    this.map.jumpTo({ pitch: 0 });
    this.events.emit('view3d', false);
    this.invalidate();
  }

  toggleView3D(): void {
    this.setView3D(!this._is3D);
  }

  /** Buildings fade to see-through while building underground. */
  setXray(on: boolean): void {
    if (on === this.xray) return;
    this.xray = on;
    this.map.setPaintProperty(BUILDING_LAYER, 'fill-extrusion-opacity', on ? MAP.xrayOpacity : 1);
  }

  /** Id of the deck.gl object under a client-space point (layers must be pickable). */
  pick(clientPx: [number, number], layerIds: string[], radius = 6): number | null {
    const r = this.map.getCanvas().getBoundingClientRect();
    try {
      const info = this.overlay.pickObject({ x: clientPx[0] - r.left, y: clientPx[1] - r.top, layerIds, radius });
      const obj = info?.object as { id?: number } | undefined;
      return obj && typeof obj.id === 'number' ? obj.id : null;
    } catch {
      return null;
    }
  }

  /** Ground resolution: metres per screen pixel at the map centre. */
  metresPerPixel(): number {
    const lat = this.map.getCenter().lat;
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, this.map.getZoom()));
  }
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
