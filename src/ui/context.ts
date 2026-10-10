import type { Game } from '../core/game';
import type { MapView } from '../map/mapView';
import type { WorldTerrain } from '../construction/terrain';
import type { StationLayers } from '../map/stationLayers';
import type { NetworkLayers } from '../map/networkLayers';
import type { ToolId } from './toolTypes';

/** What tools and panels can reach. Implemented by the App. */
export interface AppContext {
  game: Game;
  view: MapView;
  terrain: WorldTerrain;
  stations: StationLayers;
  network: NetworkLayers;
  /** Show a tooltip near a screen point (null hides it). */
  tip(html: string | null, px?: [number, number]): void;
  toast(title: string, body?: string, tone?: 'green' | 'amber' | 'red'): void;
  confirm(title: string, body: string, ok: string, danger?: boolean): Promise<boolean>;
  /** Screen pixels → metres at the current zoom. */
  tol(px?: number): number;
  nameStation(x: number, y: number): string;
  /** Re-render the active tool's deck layers. */
  redraw(): void;
  setTool(id: ToolId): void;
  /** Re-render the tool options panel. */
  refreshOptions(): void;
}
