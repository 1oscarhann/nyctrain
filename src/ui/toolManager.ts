/**
 * Routes map pointer input to the active tool, handles vertex dragging (suspending map pan),
 * and keeps the deck.gl preview layers and x-ray building opacity in sync.
 */
import type { MapMouseEvent } from 'maplibre-gl';
import { toLocal } from '../core/geo';
import type { MapView } from '../map/mapView';
import type { Pointer, Tool, ToolId } from './toolTypes';

export class ToolManager {
  private tools = new Map<ToolId, Tool>();
  active: Tool | null = null;
  private dragging = false;
  /** Ignore the native click that follows a captured press (only right after it). */
  private suppressUntil = 0;
  onChange: (id: ToolId) => void = () => {};
  /** Extra condition for x-ray (e.g. an underground item is selected). */
  xrayExtra: () => boolean = () => false;

  constructor(private view: MapView) {
    const map = view.map;
    const canvas = map.getCanvasContainer();
    map.on('mousemove', (e) => {
      const p = this.pointer(e);
      if (this.dragging) this.active?.drag?.(p);
      else this.active?.move?.(p);
    });
    map.on('mousedown', (e) => {
      if (e.originalEvent.button !== 0 || !this.active?.down) return;
      if (this.active.down(this.pointer(e))) {
        this.dragging = true;
        map.dragPan.disable();
        e.preventDefault();
      }
    });
    const endDrag = (e?: MapMouseEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.suppressUntil = performance.now() + 80;
      map.dragPan.enable();
      this.active?.up?.(e ? this.pointer(e) : undefined);
    };
    map.on('mouseup', (e) => endDrag(e));
    window.addEventListener('mouseup', () => endDrag());
    map.on('click', (e) => {
      if (performance.now() < this.suppressUntil) return;
      this.active?.click?.(this.pointer(e));
    });
    map.on('dblclick', (e) => {
      e.preventDefault();
      this.active?.dblclick?.(this.pointer(e));
    });
    canvas.addEventListener('mouseleave', () => this.active?.leave?.());
  }

  register(t: Tool): void {
    this.tools.set(t.id, t);
  }

  get(id: ToolId): Tool | undefined {
    return this.tools.get(id);
  }

  set(id: ToolId): void {
    const next = this.tools.get(id) ?? null;
    if (next === this.active) {
      next?.activate?.();
      this.onChange(id);
      return;
    }
    this.active?.deactivate?.();
    this.active = next;
    this.active?.activate?.();
    this.view.map.getCanvas().style.cursor = id === 'select' ? '' : 'crosshair';
    this.refreshXray();
    this.onChange(id);
    this.view.invalidate();
  }

  refreshXray(): void {
    this.view.setXray(!!this.active?.xray || this.xrayExtra());
  }

  key(e: KeyboardEvent): boolean {
    return this.active?.key?.(e) ?? false;
  }

  layers() {
    return this.active?.layers?.() ?? [];
  }

  private pointer(e: MapMouseEvent): Pointer {
    const [x, y] = toLocal(e.lngLat.lng, e.lngLat.lat);
    return { x, y, lngLat: [e.lngLat.lng, e.lngLat.lat], px: [e.originalEvent.clientX, e.originalEvent.clientY], shift: e.originalEvent.shiftKey };
  }
}
