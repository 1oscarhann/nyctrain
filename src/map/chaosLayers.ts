/**
 * City chaos on the map (deck.gl): venue markers for today's and announced events, signal
 * problems as amber dashed segments, a faint access ring round a focused venue, and pulsing
 * incident markers. A handful of objects, rebuilt only when the alert feed changes; the pulse
 * reads performance.now() like the station crowding halo.
 */
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { EVENTS } from '../balance';
import { cityBalance } from '../cities';
import { fmtClock } from '../core/units';
import { toLonLat } from '../core/geo';
import type { Alert } from '../sim/protocol';
import type { FeedEvent } from '../ui/alertFeed';
import { fmtK, shortDate } from '../ui/alertFeed';

const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
const dashExt = new PathStyleExtension({ dash: true });
/** Lavender: events everywhere in the UI. */
export const EVENT_RGB: [number, number, number] = [201, 160, 255];
const INK: [number, number, number] = [22, 27, 33];
const RED: [number, number, number] = [255, 93, 93];
const AMBER: [number, number, number] = [255, 194, 74];

export interface VenueMarker {
  /** City event id (picking). */
  id: number;
  pos: [number, number];
  today: boolean;
  radius: number;
  text: string;
}

export interface IncidentMarker {
  /** Alert id (picking). */
  id: number;
  pos: [number, number];
  severity: number;
}

interface SignalSeg {
  id: number;
  path: [number, number][];
}

export class ChaosLayers {
  private venues: VenueMarker[] = [];
  private incidents: IncidentMarker[] = [];
  private signals: SignalSeg[] = [];
  private ring: { pos: [number, number] } | null = null;
  private version = 0;

  /** Venue markers: the soonest event at each venue (today's first). */
  setEvents(events: FeedEvent[], today: number, focusEvent: number | null): void {
    const cc = cityBalance().chaos;
    const byVenue = new Map<number, FeedEvent>();
    for (const e of events) {
      const cur = byVenue.get(e.venue);
      if (!cur || e.day < cur.day) byVenue.set(e.venue, e);
    }
    this.venues = [...byVenue.values()].map((e) => {
      const v = cc.venues[e.venue];
      const isToday = e.day === today;
      return {
        id: e.id,
        pos: [v.lon, v.lat] as [number, number],
        today: isToday,
        radius: 6 + 8 * Math.sqrt(e.attendance / 50_000),
        // "•", not "·": the deck.gl glyph atlas leaves the middle dot blank.
        text: isToday ? `${e.label} • ${fmtK(e.attendance)} • ${fmtClock(e.start)}` : `${shortDate(e.day).slice(0, 3)} • ${e.label} • ${fmtK(e.attendance)}`,
      };
    });
    const f = focusEvent !== null ? events.find((e) => e.id === focusEvent) : undefined;
    this.ring = f ? { pos: [cc.venues[f.venue].lon, cc.venues[f.venue].lat] } : null;
    this.version++;
  }

  /** Incident markers and signal segments from the active alerts. */
  setAlerts(active: Alert[]): void {
    this.incidents = active.filter((a) => a.pos).map((a) => ({ id: a.id, pos: toLonLat(a.pos![0], a.pos![1]), severity: a.severity }));
    this.signals = active.filter((a) => a.kind === 'signal' && a.path && a.path.length > 1).map((a) => ({ id: a.id, path: a.path!.map((p) => toLonLat(p[0], p[1])) }));
    this.version++;
  }

  get hasIncidents(): boolean {
    return this.incidents.length > 0;
  }

  /** Under the trains: signal segments, the focused venue's ring and venue markers (labels: venueLabelLayers). */
  venueLayers(): Layer[] {
    const v = this.version;
    const out: Layer[] = [];
    if (this.signals.length) {
      out.push(
        new PathLayer<SignalSeg, PathStyleExtensionProps<SignalSeg>>({
          id: 'chaos-signal-casing',
          data: this.signals,
          getPath: (d) => d.path,
          getColor: [...INK, 200],
          getWidth: 9,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          parameters: DEPTH,
          updateTriggers: { getPath: v },
        }),
        new PathLayer<SignalSeg, PathStyleExtensionProps<SignalSeg>>({
          id: 'chaos-signals',
          data: this.signals,
          getPath: (d) => d.path,
          getColor: [...AMBER, 255],
          getWidth: 6,
          widthUnits: 'pixels',
          getDashArray: [2, 1.4],
          dashJustified: true,
          extensions: [dashExt],
          parameters: DEPTH,
          updateTriggers: { getPath: v },
        }),
      );
    }
    if (this.ring) {
      out.push(
        new ScatterplotLayer<{ pos: [number, number] }>({
          id: 'chaos-venue-ring',
          data: [this.ring],
          getPosition: (d) => d.pos,
          getRadius: EVENTS.venueAccess,
          radiusUnits: 'meters',
          getFillColor: [...EVENT_RGB, 22],
          stroked: true,
          getLineColor: [...EVENT_RGB, 150],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          parameters: DEPTH,
          updateTriggers: { getPosition: v },
        }),
      );
    }
    if (this.venues.length) {
      out.push(
        new ScatterplotLayer<VenueMarker>({
          id: 'chaos-venues',
          data: this.venues,
          getPosition: (d) => d.pos,
          getRadius: (d) => d.radius,
          radiusUnits: 'pixels',
          getFillColor: (d) => [...EVENT_RGB, d.today ? 255 : 140],
          stroked: true,
          getLineColor: (d) => [...INK, d.today ? 255 : 170],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          // Round dots facing the camera in 3D, not ellipses on the ground.
          billboard: true,
          pickable: true,
          parameters: DEPTH,
          updateTriggers: { getPosition: v, getRadius: v, getFillColor: v, getLineColor: v },
        }),
      );
    }
    return out;
  }

  /**
   * Venue labels from zoom 11.5, drawn above the stations and trains (a station label or a
   * passing train would otherwise cover them), above the dot: station labels sit to the right.
   */
  venueLabelLayers(zoom: number): Layer[] {
    if (!this.venues.length || zoom < 11.5) return [];
    const v = this.version;
    return [
      new TextLayer<VenueMarker>({
        id: 'chaos-venue-labels',
        data: this.venues,
        getPosition: (d) => d.pos,
        getText: (d) => d.text,
        getSize: 12,
        getColor: (d) => [...EVENT_RGB, d.today ? 255 : 170],
        getPixelOffset: (d) => [0, -(d.radius + 6)],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        fontFamily: 'Overpass, sans-serif',
        fontWeight: 700,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        outlineWidth: 3,
        outlineColor: [...INK, 235],
        characterSet: 'auto',
        parameters: DEPTH,
        updateTriggers: { getText: v, getColor: v, getPixelOffset: v, getPosition: v },
      }),
    ];
  }

  /** Above the stations: pulsing halo, a solid dot (red for severity 3) and a "!" glyph. */
  incidentLayers(time: number): Layer[] {
    if (!this.incidents.length) return [];
    const v = this.version;
    const pulse = (time % 1600) / 1600;
    const q = Math.round(pulse * 40);
    const col = (d: IncidentMarker) => (d.severity >= 3 ? RED : AMBER);
    return [
      new ScatterplotLayer<IncidentMarker>({
        id: 'chaos-incident-halo',
        data: this.incidents,
        getPosition: (d) => d.pos,
        getRadius: 10 + 10 * pulse,
        radiusUnits: 'pixels',
        getFillColor: (d) => [...col(d), 150 * (1 - pulse)],
        // Face the camera in 3D, so the marker and its "!" stay round and readable when tilted.
        billboard: true,
        parameters: DEPTH,
        updateTriggers: { getRadius: q, getFillColor: [v, q], getPosition: v },
      }),
      new ScatterplotLayer<IncidentMarker>({
        id: 'chaos-incidents',
        data: this.incidents,
        getPosition: (d) => d.pos,
        getRadius: 8,
        radiusUnits: 'pixels',
        getFillColor: (d) => [...col(d), 255],
        stroked: true,
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        billboard: true,
        pickable: true,
        parameters: DEPTH,
        updateTriggers: { getFillColor: v, getPosition: v },
      }),
      new TextLayer<IncidentMarker>({
        id: 'chaos-incident-glyph',
        data: this.incidents,
        getPosition: (d) => d.pos,
        getText: () => '!',
        getSize: 14,
        getColor: (d) => (d.severity >= 3 ? [255, 255, 255, 255] : [...INK, 255]),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: 'Overpass, sans-serif',
        fontWeight: 800,
        characterSet: ['!'],
        parameters: DEPTH,
        updateTriggers: { getColor: v, getPosition: v },
      }),
    ];
  }
}
