/**
 * The tunnel-only zone on the map (core/zones.ts): a faint wash and a dashed edge, stronger while a
 * building tool is out, with its name along the top.
 */
import { PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { tunnelZone } from '../core/zones';

const dash = new PathStyleExtension({ dash: true });
const DEPTH_OFF = { depthCompare: 'always', depthWriteEnabled: false } as const;

export function zoneLayers(building: boolean, light: boolean): Layer[] {
  const z = tunnelZone();
  if (!z) return [];
  const ring = [...z.ll, z.ll[0]];
  const col: [number, number, number] = light ? [200, 90, 20] : [255, 150, 70];
  const top = z.ll.reduce((a, b) => (b[1] > a[1] ? b : a));
  return [
    new PolygonLayer({
      id: 'tunnel-zone-fill',
      data: [{ ring }],
      getPolygon: (d: { ring: [number, number][] }) => d.ring,
      getFillColor: [...col, building ? 26 : 10] as [number, number, number, number],
      stroked: false,
      pickable: false,
      parameters: DEPTH_OFF,
      updateTriggers: { getFillColor: [building, light] },
    }),
    new PathLayer({
      id: 'tunnel-zone-edge',
      data: [{ ring }],
      getPath: (d: { ring: [number, number][] }) => d.ring,
      getColor: [...col, building ? 230 : 120] as [number, number, number, number],
      getWidth: building ? 2.5 : 1.5,
      widthUnits: 'pixels',
      getDashArray: [6, 4],
      dashJustified: true,
      extensions: [dash],
      parameters: DEPTH_OFF,
      updateTriggers: { getColor: [building, light], getWidth: building },
    } as never),
    new TextLayer({
      id: 'tunnel-zone-label',
      data: [{ pos: top }],
      getPosition: (d: { pos: [number, number] }) => d.pos,
      getText: () => `${z.name} · tunnels only`,
      getSize: building ? 13 : 11,
      getColor: [...col, building ? 255 : 170] as [number, number, number, number],
      getPixelOffset: [0, -10],
      fontWeight: 700,
      fontFamily: 'Cabin, Overpass, sans-serif',
      outlineWidth: 3,
      outlineColor: light ? [250, 249, 245, 230] : [10, 10, 12, 220],
      fontSettings: { sdf: true, fontSize: 40, buffer: 6 },
      parameters: DEPTH_OFF,
      updateTriggers: { getSize: building, getColor: [building, light] },
    }),
  ];
}
