import type { Layer } from '@deck.gl/core';

export type ToolId = 'select' | 'track' | 'station' | 'route' | 'bulldoze';

export interface Pointer {
  /** Local metres. */
  x: number;
  y: number;
  lngLat: [number, number];
  /** Screen pixels within the map canvas. */
  px: [number, number];
  shift: boolean;
  /** Alt (Option) held: the route tool picks the other platform of a cross-platform pair (v2). */
  alt: boolean;
}

export interface Tool {
  readonly id: ToolId;
  /** Buildings go see-through while this tool is active. */
  readonly xray: boolean;
  activate?(): void;
  deactivate?(): void;
  move?(p: Pointer): void;
  click?(p: Pointer): void;
  dblclick?(p: Pointer): void;
  /** Return true to capture a drag (map panning is suspended until mouse up). */
  down?(p: Pointer): boolean;
  drag?(p: Pointer): void;
  up?(p?: Pointer): void;
  /** Return true if the key was handled. */
  key?(e: KeyboardEvent): boolean;
  layers?(): (Layer | null | false)[];
  /** Tool options panel content. */
  options?(): HTMLElement | null;
  leave?(): void;
}
