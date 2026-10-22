/**
 * Basemap style: OpenFreeMap Positron, loaded at runtime and recoloured to the dusk-slate palette.
 * Real-world rapid transit is hidden — in these cities nobody ever built a metro.
 */
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
  FillExtrusionLayerSpecification,
  SkySpecification,
} from 'maplibre-gl';
import { MAP } from '../balance';
import { DAY, type ColourKey } from '../cinematic/palette';

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

/** The fill-extrusion light of the basemap as before Cinematic ("Always day" keeps it). */
export const DAY_LIGHT = { anchor: 'map' as const, position: [1.5, 315, 38] as [number, number, number], color: DAY.colours.light, intensity: DAY.lightIntensity };

/** The sky of a palette (MapLibre's sky; it shows only above the horizon). */
export function skyOf(c: { sky: string; horizon: string; fog: string }): SkySpecification {
  return { 'sky-color': c.sky, 'horizon-color': c.horizon, 'fog-color': c.fog, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4 };
}

function daySky(): SkySpecification {
  return skyOf(DAY.colours);
}

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

/** A basemap paint property that follows a palette colour (docs/v2/cinematic.md §3). */
export interface PaintBinding {
  layer: string;
  prop: string;
  key: ColourKey;
}

const LINE = (key: ColourKey): [string, ColourKey][] => [['line-color', key]];
const FILL = (key: ColourKey): [string, ColourKey][] => [['fill-color', key]];
const WATER_TEXT: [string, ColourKey][] = [['text-color', 'waterLabel'], ['text-halo-color', 'waterLabelHalo']];

/**
 * Which palette colours a layer's paint follows: one table for the initial recolour (the Day
 * palette, the basemap as before) and for the day/night cycle's runtime updates.
 */
export function bindingsFor(layer: { id: string; type: string }): [prop: string, key: ColourKey][] {
  switch (layer.id) {
    case 'background':
      return [['background-color', 'land']];
    case 'park':
    case 'landcover_wood':
    case 'hw-cemetery':
    case 'hw-grass':
      return FILL('park');
    case 'water':
      return FILL('water');
    case 'waterway':
      return LINE('water');
    case 'building':
      return [['fill-color', 'block'], ['fill-outline-color', 'blockLine']];
    case BUILDING_LAYER:
      return [['fill-extrusion-color', 'roof']];
    case 'tunnel_motorway_inner':
    case 'aeroway-taxiway':
    case 'aeroway-runway-casing':
    case 'highway_path':
    case 'highway_minor':
    case 'railway':
      return LINE('street');
    case 'aeroway-area':
      return FILL('street');
    case 'aeroway-runway':
    case 'highway_major_inner':
    case 'highway_major_subtle':
    case 'highway_motorway_inner':
    case 'highway_motorway_subtle':
    case 'highway_motorway_bridge_inner':
      return LINE('avenue');
    case 'road_area_pier':
      return FILL('land');
    case 'road_pier':
    case 'highway_motorway_bridge_casing':
      return LINE('land');
    case 'water_name_point_label':
    case 'waterway_line_label':
    case 'water_name_line_label':
      return WATER_TEXT;
    default:
      // The basemap's own labels (the game's layers are 'hw-' and keep their colours).
      return layer.type === 'symbol' && !layer.id.startsWith('hw-') ? [['text-color', 'label'], ['text-halo-color', 'labelHalo']] : [];
  }
}

/** Every palette binding of a style's layers. */
export function styleBindings(layers: readonly { id: string; type: string }[]): PaintBinding[] {
  return layers.flatMap((l) => bindingsFor(l).map(([prop, key]) => ({ layer: l.id, prop, key })));
}

function recolour(layer: AnyLayer): AnyLayer | null {
  if (HIDE.has(layer.id)) return null;
  const C = DAY.colours;
  for (const [prop, key] of bindingsFor(layer)) paint(layer, { [prop]: C[key] });
  switch (layer.id) {
    case 'water':
      paint(layer, { 'fill-antialias': true });
      break;
    case 'tunnel_motorway_inner':
      paint(layer, { 'line-opacity': 0.5 });
      break;
    case 'highway_path':
      paint(layer, { 'line-opacity': 0.6 });
      break;
    case 'highway_minor':
      paint(layer, { 'line-opacity': 1 });
      break;
    case 'railway':
      paint(layer, { 'line-opacity': 0.8 });
      break;
    case 'water_name_point_label':
      // Ponds and fountains are clutter at planning zooms.
      layer.minzoom = 15.5;
      paint(layer, { 'text-halo-width': 1.2 });
      break;
    case 'waterway_line_label':
    case 'water_name_line_label':
      paint(layer, { 'text-halo-width': 1.2 });
      break;
    default:
      if (layer.type === 'symbol') {
        paint(layer, { 'text-halo-width': 1.2, 'text-halo-blur': 0.5 });
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
      // One colour (no data-driven ramp), so the day/night cycle changes a uniform, not the tiles.
      'fill-extrusion-color': DAY.colours.roof,
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
    paint: { 'fill-color': DAY.colours.park },
  } as AnyLayer, {
    id: 'hw-grass',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'grass'],
    paint: { 'fill-color': DAY.colours.park, 'fill-opacity': 0.8 },
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
  // (The day/night cycle moves it with the sun: cinematic/daylight.ts.)
  style.light = { ...DAY_LIGHT };
  // The sky shows only above the horizon (the follow-cam's chase pitch); its colours follow the palette.
  style.sky = daySky();
  return style;
}
