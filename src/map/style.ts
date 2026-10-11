/**
 * Basemap style: OpenFreeMap Positron, loaded at runtime and recoloured to the dusk-slate palette.
 * Real-world rapid transit is hidden — in these cities nobody ever built a metro.
 */
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
  FillExtrusionLayerSpecification,
} from 'maplibre-gl';
import { MAP } from '../balance';

export const POSITRON_URL = 'https://tiles.openfreemap.org/styles/positron';

export const BASEMAP = {
  harbour: '#1E3A4C',
  slate: '#2B3138',
  park: '#2F3D33',
  street: '#3A424B',
  avenue: '#4A535D',
  block: '#343B44',
  roof: '#3E4650',
  label: '#9AA5B1',
};

export const BUILDING_SOURCE = 'hw-buildings';
export const BUILDING_LAYER = 'hw-building-3d';
/** Global-state key multiplying building heights (0 = flat, 1 = full height). */
export const BUILDING_HEIGHT_STATE = 'hwBuildingScale';

export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

type AnyLayer = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };

const HIDE = new Set([
  'landcover_ice_shelf',
  'landcover_glacier',
  'landuse_residential',
  'tunnel_motorway_casing',
  'highway_major_casing',
  'highway_motorway_casing',
  'railway_transit',
  'railway_transit_dashline',
  'railway_service',
  'railway_service_dashline',
  'railway_dashline',
  'boundary_3',
  'boundary_2',
  'boundary_disputed',
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
  'label_country_1',
  'label_country_2',
  'label_country_3',
  'label_state',
]);

function paint(layer: AnyLayer, props: Record<string, unknown>) {
  layer.paint = { ...(layer.paint ?? {}), ...props };
}

function recolour(layer: AnyLayer): AnyLayer | null {
  if (HIDE.has(layer.id)) return null;
  const P = BASEMAP;
  switch (layer.id) {
    case 'background':
      paint(layer, { 'background-color': P.slate });
      break;
    case 'park':
    case 'landcover_wood':
      paint(layer, { 'fill-color': P.park });
      break;
    case 'water':
      paint(layer, { 'fill-color': P.harbour, 'fill-antialias': true });
      break;
    case 'waterway':
      paint(layer, { 'line-color': P.harbour });
      break;
    case 'building':
      paint(layer, { 'fill-color': P.block, 'fill-outline-color': '#2F353D' });
      break;
    case 'tunnel_motorway_inner':
      paint(layer, { 'line-color': P.street, 'line-opacity': 0.5 });
      break;
    case 'aeroway-taxiway':
    case 'aeroway-runway-casing':
      paint(layer, { 'line-color': P.street });
      break;
    case 'aeroway-area':
      paint(layer, { 'fill-color': P.street });
      break;
    case 'aeroway-runway':
      paint(layer, { 'line-color': P.avenue });
      break;
    case 'road_area_pier':
      paint(layer, { 'fill-color': P.slate });
      break;
    case 'road_pier':
      paint(layer, { 'line-color': P.slate });
      break;
    case 'highway_path':
      paint(layer, { 'line-color': P.street, 'line-opacity': 0.6 });
      break;
    case 'highway_minor':
      paint(layer, { 'line-color': P.street, 'line-opacity': 1 });
      break;
    case 'highway_major_inner':
    case 'highway_major_subtle':
    case 'highway_motorway_inner':
    case 'highway_motorway_subtle':
    case 'highway_motorway_bridge_inner':
      paint(layer, { 'line-color': P.avenue });
      break;
    case 'highway_motorway_bridge_casing':
      paint(layer, { 'line-color': P.slate });
      break;
    case 'railway':
      paint(layer, { 'line-color': P.street, 'line-opacity': 0.8 });
      break;
    case 'water_name_point_label':
      // Ponds and fountains are clutter at planning zooms.
      layer.minzoom = 15.5;
      paint(layer, { 'text-color': '#5F7F92', 'text-halo-color': P.harbour, 'text-halo-width': 1.2 });
      break;
    case 'waterway_line_label':
    case 'water_name_line_label':
      paint(layer, { 'text-color': '#5F7F92', 'text-halo-color': P.harbour, 'text-halo-width': 1.2 });
      break;
    default:
      if (layer.type === 'symbol') {
        paint(layer, {
          'text-color': P.label,
          'text-halo-color': P.slate,
          'text-halo-width': 1.2,
          'text-halo-blur': 0.5,
        });
        if (layer.id.startsWith('label_city') || layer.id === 'label_town') {
          // City-scale labels are noise when you're planning inside the city.
          layer.maxzoom = 11;
        }
      }
  }
  return layer;
}

export function buildingLayer(): FillExtrusionLayerSpecification {
  const scale: ExpressionSpecification = ['global-state', BUILDING_HEIGHT_STATE];
  return {
    id: BUILDING_LAYER,
    type: 'fill-extrusion',
    source: BUILDING_SOURCE,
    'source-layer': 'building',
    minzoom: MAP.buildingMinZoom,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'render_height'], 0],
        0,
        BASEMAP.block,
        120,
        BASEMAP.roof,
      ],
      'fill-extrusion-height': ['*', ['coalesce', ['get', 'render_height'], 0], scale],
      'fill-extrusion-base': ['*', ['coalesce', ['get', 'render_min_height'], 0], scale],
      'fill-extrusion-vertical-gradient': true,
      'fill-extrusion-opacity': 1,
      'fill-extrusion-opacity-transition': { duration: 350, delay: 0 },
    },
  };
}

/** Fetch Positron and return the recoloured style with the 3D building layer added. */
export async function loadStyle(): Promise<StyleSpecification> {
  const res = await fetch(POSITRON_URL);
  if (!res.ok) throw new Error(`Basemap style: HTTP ${res.status}`);
  const style = (await res.json()) as StyleSpecification;
  const layers: AnyLayer[] = [];
  for (const l of style.layers as AnyLayer[]) {
    const out = recolour(l);
    if (out) layers.push(out);
  }
  // Cemeteries and city grass read as parks.
  const parkIdx = layers.findIndex((l) => l.id === 'park');
  layers.splice(parkIdx + 1, 0, {
    id: 'hw-cemetery',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'cemetery'],
    paint: { 'fill-color': BASEMAP.park },
  } as AnyLayer, {
    id: 'hw-grass',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'grass'],
    paint: { 'fill-color': BASEMAP.park, 'fill-opacity': 0.8 },
  } as AnyLayer);

  // Separate source for buildings: changing the height multiplier re-tessellates only buildings,
  // not every road and label.
  const omt = style.sources.openmaptiles as { type: 'vector'; url: string };
  style.sources[BUILDING_SOURCE] = { type: 'vector', url: omt.url };
  delete (style.sources as Record<string, unknown>).ne2_shaded;

  // 3D buildings go above roads but below labels.
  const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
  layers.splice(firstSymbol, 0, buildingLayer() as AnyLayer);

  style.layers = layers;
  (style as StyleSpecification & { state?: Record<string, { default: unknown }> }).state = {
    [BUILDING_HEIGHT_STATE]: { default: 0 },
  };
  // One directional light from the northwest; fairly overhead so roofs read lighter than walls.
  style.light = { anchor: 'map', position: [1.5, 315, 38], color: '#fff6ea', intensity: 0.62 };
  return style;
}
