/**
 * Airports and universities on the map (src/cities/destinations.ts), and Tokyo's railway terminals
 * (tracts with `terminal`): markers with names, so the places that draw travellers beyond the
 * commute are easy to aim a line at.
 */
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { city } from '../cities';
import { AIRPORTS, CAMPUSES } from '../cities/destinations';

interface Mark {
  name: string;
  pos: [number, number];
  airport: boolean;
  /** A railway terminal: commuters arriving a day. */
  terminal?: boolean;
  size: number;
}

const DEPTH_OFF = { depthCompare: 'always', depthWriteEnabled: false } as const;

export class DestinationLayers {
  private marks: Mark[] = [];
  on = true;

  constructor() {
    const id = city().id;
    this.marks = [
      ...(AIRPORTS[id] ?? []).map((a) => ({ name: a.name, pos: [a.lon, a.lat] as [number, number], airport: true, size: a.perDay })),
      ...(CAMPUSES[id] ?? []).map((c) => ({ name: c.name, pos: [c.lon, c.lat] as [number, number], airport: false, size: c.students })),
    ];
  }

  /** Railway terminals (Tokyo): tracts whose residents are suburban commuters arriving there. */
  setTerminals(tracts: readonly { name?: string; lon: number; lat: number; residents: number; terminal?: string }[]): void {
    this.marks = this.marks.filter((m) => !m.terminal);
    for (const t of tracts) if (t.terminal) this.marks.push({ name: t.name ?? 'Terminal', pos: [t.lon, t.lat], airport: true, terminal: true, size: t.residents });
  }

  layers(zoom: number, light = false): Layer[] {
    if (!this.on) return [];
    // Airports from the regional view; campuses once you're looking at a city.
    const shown = this.marks.filter((m) => m.airport || zoom >= 11.5);
    if (!shown.length) return [];
    const font = city().theme === 'tfl' ? 'Cabin, Overpass, sans-serif' : 'Overpass, sans-serif';
    return [
      new ScatterplotLayer<Mark>({
        id: 'destinations',
        data: shown,
        getPosition: (m) => m.pos,
        getRadius: (m) => (m.airport ? 9 : 6),
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        getFillColor: (m) => (m.terminal ? [92, 220, 205, 70] : m.airport ? [201, 160, 255, 70] : [255, 214, 102, 60]),
        getLineColor: (m) => (m.terminal ? (light ? [0, 120, 110, 255] : [92, 220, 205, 255]) : light ? (m.airport ? [120, 60, 200, 255] : [200, 140, 0, 255]) : m.airport ? [201, 160, 255, 255] : [255, 214, 102, 255]),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        parameters: DEPTH_OFF,
        updateTriggers: { getLineColor: light, getFillColor: light },
      }),
      new TextLayer<Mark>({
        id: 'destination-labels',
        // The national map's small airports wait until you're looking at their region.
        data: shown.filter((m) => (m.airport && (m.size >= 50_000 || zoom >= 7.5)) || zoom >= 12.5),
        getPosition: (m) => m.pos,
        getText: (m) => (m.terminal ? `${m.name} · ${Math.round(m.size / 1000)}k arrive a day` : m.airport ? `${m.name} · ${Math.round(m.size / 1000)}k passengers/day` : `${m.name} · ${Math.round(m.size / 1000)}k students`),
        getSize: (m) => (m.airport ? 12.5 : 11),
        getColor: (m) => (m.terminal ? (light ? [0, 100, 92, 255] : [140, 236, 224, 255]) : light ? (m.airport ? [92, 40, 160, 255] : [140, 92, 0, 255]) : m.airport ? [214, 186, 255, 255] : [255, 222, 140, 255]),
        getPixelOffset: [0, 14],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'top',
        fontFamily: font,
        fontWeight: 700,
        fontSettings: { sdf: true, fontSize: 40, buffer: 6 },
        outlineWidth: 3,
        outlineColor: light ? [250, 249, 245, 235] : [10, 10, 12, 230],
        characterSet: 'auto',
        parameters: DEPTH_OFF,
        updateTriggers: { getColor: light },
      }),
    ];
  }
}
