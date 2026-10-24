/**
 * Express service and four-track sections on the main thread (v2, docs/v2/express-quad.md §2):
 * the wording of the track tool's four-track and crossover previews, the station and bulldoze
 * tools' cross-platform texts, and the route panel's Service section and Line list. Pure, no DOM:
 * distances follow the units setting and money the city's currency, in both cities.
 */
import { trackClassName } from '../core/trackNames';
import { MAP, QUAD, type TrackClass, type TrackLevel } from '../balance';
import { cap } from '../construction/describe';
import type { Network } from '../construction/network';
import { gapTag, isGapEnd, partnerPoint, quadEndPartner, type QuadResult } from '../construction/quad';
import type { QuadRole, Station } from '../construction/types';
import { LEVEL_NAMES, type EdgeReport } from '../construction/validate';
import { fmtCount, fmtDistance, fmtMoney, fmtSpeed } from '../core/units';
import { partnerOf, quadRole, type AlongStation } from '../routes/express';
import type { Route } from '../routes/types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const SIDE_LABEL: Record<1 | -1, string> = { 1: 'right', [-1]: 'left' } as Record<1 | -1, string>;

/**
 * Track and station tool previews push each pair of a four-track section this many px away from
 * the other, as the map does for a pair carrying one route (NetworkLayers' quadOffsets): 9 m is
 * under a pixel at city zooms, so the pairs would otherwise draw on top of each other.
 */
export const PREVIEW_PAIR_PX = MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2;

/** Preview colours by part of a four-track stroke (§2.1). */
export const QUAD_COLORS = {
  local: [76, 208, 138, 255] as [number, number, number, number],
  express: [92, 200, 255, 255] as [number, number, number, number],
  link: [200, 210, 220, 255] as [number, number, number, number],
  double: [76, 208, 138, 255] as [number, number, number, number],
  invalid: [255, 93, 93, 255] as [number, number, number, number],
};

/** What each new edge of a four-track stroke is: a pair, a connector, or the double track before a fan's turnout. */
export function strokeRoles(res: QuadResult): Map<number, QuadRole | 'double'> {
  const m = new Map<number, QuadRole | 'double'>();
  for (const id of res.double) m.set(id, 'double');
  for (const id of res.local) m.set(id, 'local');
  for (const id of res.express) m.set(id, 'express');
  for (const id of res.links) m.set(id, 'link');
  return m;
}

/**
 * The connectors among some link edges, by kind. A connector is a run of link edges sharing nodes
 * (lead, diagonal, lead). A turnout ends on a pair's end node (degree 2: the other pair starts
 * there); a scissors is two connectors that cross with no node between them, each ending on
 * junctions (degree 3) at both ends.
 */
export function connectorKinds(net: Network, links: readonly number[]): { turnouts: number; scissors: number } {
  const set = new Set(links);
  const seen = new Set<number>();
  let turnouts = 0, halves = 0;
  for (const id of links) {
    if (seen.has(id) || !net.edges.has(id)) continue;
    const stack = [id];
    seen.add(id);
    // The run's outer nodes: those not shared with another link edge of the run.
    const touches = new Map<number, number>();
    while (stack.length) {
      const e = net.edges.get(stack.pop()!)!;
      for (const node of [e.a, e.b]) {
        touches.set(node, (touches.get(node) ?? 0) + 1);
        for (const o of net.incident(node))
          if (set.has(o) && !seen.has(o)) {
            seen.add(o);
            stack.push(o);
          }
      }
    }
    const ends = [...touches].filter(([, k]) => k === 1).map(([node]) => node);
    if (ends.some((node) => net.degree(node) < 3)) turnouts++;
    else halves++;
  }
  return { turnouts, scissors: Math.ceil(halves / 2) };
}

/** "1 turnout, 2 scissors" (the track tool's preview). */
export function connectorText(k: { turnouts: number; scissors: number }): string {
  const parts: string[] = [];
  if (k.turnouts) parts.push(`${k.turnouts} turnout${k.turnouts > 1 ? 's' : ''}`);
  if (k.scissors) parts.push(`${k.scissors} scissors`);
  return parts.join(', ');
}

/** Hover text of the track tool in four-track mode before the first click (§2.1). */
export function quadHoverTip(net: Network, snap: { kind: 'none' } | { kind: 'node'; node: number } | { kind: 'edge'; edge: number; u: number }, level: TrackLevel, side: 1 | -1): string {
  if (snap.kind === 'none') return `<div class="hw-muted">Click to start four-track ${LEVEL_NAMES[level]} · express pair on the ${SIDE_LABEL[side]} (<span class="kbd">F</span> flips)</div>`;
  if (snap.kind === 'node' && quadEndPartner(net, snap.node)) return `<div class="hw-green">Click to extend the four-track section</div>`;
  if (snap.kind === 'node' && isGapEnd(net, snap.node)) {
    const role = gapTag(net, snap.node)!.role;
    return `<div class="hw-green">Click, then the other end of the gap, to restore the ${role} pair along the ${role === 'local' ? 'express' : 'local'} pair</div>`;
  }
  return `<div class="hw-muted">Click to branch four tracks off here · the express pair splits off through a turnout</div>`;
}

/** Curves above this radius (m) aren't worth a tooltip row. */
const TIGHT_CURVE_SHOWN = 3000;

interface Sum {
  length: number;
  cost: number;
}
function sum(reports: Map<number, EdgeReport>, ids: readonly number[]): Sum {
  let length = 0, cost = 0;
  for (const id of ids) {
    const r = reports.get(id);
    if (!r) continue;
    length += r.length;
    cost += r.cost;
  }
  return { length, cost };
}

/**
 * The track tool's tooltip while drawing four tracks (§2.1): each pair's length and cost, the
 * connectors, the tightest curve (and on which pair), the total, then the first error (red), the
 * non-fatal problems (amber) and the keys. `res` is the preview on a clone; refused strokes give
 * the reason in red.
 */
export function quadStrokeTip(net: Network, res: QuadResult, reports: Map<number, EdgeReport>, level: TrackLevel, cls: TrackClass): string {
  const title = `<div class="title">Four-track · ${cap(LEVEL_NAMES[level])} · ${trackClassName(cls)}</div>`;
  const keys = `<div class="hw-muted" style="margin-top:3px">Double-click or <span class="kbd">Enter</span> to finish · <span class="kbd">F</span> flips the express side · <span class="kbd">Q</span> back to two tracks</div>`;
  if (!res.ok) return title + `<div class="reason hw-red">${esc(res.fatal ?? 'Can’t build four tracks here')}</div>` + `<div class="hw-muted" style="margin-top:3px"><span class="kbd">Q</span> back to two tracks</div>`;
  const row = (label: string, value: string, note = '') => `<div class="row"><span class="hw-muted">${label}</span><span class="num">${value}${note ? ` <span class="hw-muted">${note}</span>` : ''}</span></div>`;
  const loc = sum(reports, res.local), exp = sum(reports, res.express), lnk = sum(reports, res.links), dbl = sum(reports, res.double);
  const total = loc.cost + exp.cost + lnk.cost + dbl.cost;
  const lines = [title];
  if (res.double.length) lines.push(row('Double track', `${fmtDistance(dbl.length)} · ${fmtMoney(dbl.cost)}`));
  lines.push(row('Local pair', `${fmtDistance(loc.length)} · ${fmtMoney(loc.cost)}`));
  lines.push(row(`Express pair <span class="hw-muted" style="opacity:.7">×${QUAD.secondPairCostFactor}</span>`, `${fmtDistance(exp.length)} · ${fmtMoney(exp.cost)}`));
  const k = connectorKinds(net, res.links);
  if (k.turnouts || k.scissors) lines.push(row('Turnouts/crossovers', `${connectorText(k)} · ${fmtMoney(lnk.cost)}`));
  // Tightest curve on either pair (the inner one on a bend).
  let tight: { r: number; v: number; role: 'local' | 'express' } | null = null;
  for (const role of ['local', 'express'] as const)
    for (const id of res[role]) {
      const r = reports.get(id);
      if (r && isFinite(r.minRadius) && (!tight || r.minRadius < tight.r)) tight = { r: r.minRadius, v: r.speedLimit, role };
    }
  // Only curves that matter (gentle bends of a few kilometres are as good as straight).
  if (tight && tight.r < TIGHT_CURVE_SHOWN) lines.push(row('Tightest curve', `${fmtDistance(tight.r, true)} · ${fmtSpeed(tight.v)}`, `(${tight.role} pair)`));
  lines.push(row('Line so far', fmtMoney(total)));
  const firstErr = res.edges.map((id) => reports.get(id)).find((r) => r && !r.ok)?.errors[0];
  if (firstErr) lines.push(`<div class="reason hw-red">${esc(firstErr)}</div>`);
  for (const p of res.problems) lines.push(`<div class="reason hw-amber">${esc(p)}</div>`);
  lines.push(keys);
  return lines.join('');
}

/** Crossover mode's hover text (§2.1): a valid scissors with its length and cost, or why not. */
export function crossoverTip(c: { ok: true; cost: number; error?: string } | { ok: false; reason: string } | null): string {
  if (!c) return `<div class="hw-muted">Hover over a four-track section to place a scissors crossover</div>`;
  if (!c.ok) return `<div class="title">Scissors crossover</div><div class="reason hw-red">${esc(c.reason)}</div>`;
  const head = `<div class="title">Scissors crossover · ${fmtDistance(QUAD.crossoverLength, true)} · ${fmtMoney(c.cost)}</div><div class="hw-muted">Trains can switch pairs in both directions</div>`;
  return head + (c.error ? `<div class="reason hw-red">${esc(c.error)}</div>` : `<div class="hw-green" style="margin-top:3px">Click to place · <span class="kbd">Esc</span> or <span class="kbd">X</span> to stop</div>`);
}

/** "local" / "express" for a platform on a four-track section (null on ordinary track). */
export function pairWord(net: Network, stationId: number): 'local' | 'express' | null {
  const r = quadRole(net, stationId);
  return r === 'local' || r === 'express' ? r : null;
}

/** The station tool's hover modes on four tracks (§2.2). */
export type StationHoverMode =
  | { kind: 'pair'; partnerEdge: number; partnerU: number }
  | { kind: 'link'; existing: Station }
  | { kind: 'single' };

/**
 * A lone platform on the other pair of the same four-track section whose opposite point on the
 * hovered pair lies within QUAD.pairLinkDistance of (x, y): the new platform pairs up with it,
 * aligned opposite it.
 */
export function linkCandidate(net: Network, edge: number, x: number, y: number): { existing: Station; edge: number; u: number } | null {
  const t = net.edges.get(edge)?.quad;
  if (!t || t.role === 'link') return null;
  let best: { existing: Station; edge: number; u: number; d: number } | null = null;
  for (const s of net.stations.values()) {
    if (s.pair !== undefined) continue;
    const q = net.edges.get(s.edge)?.quad;
    if (!q || q.g !== t.g || q.role === t.role || q.role === 'link') continue;
    const p = net.stationPos(s);
    if (Math.hypot(p.x - x, p.y - y) > QUAD.pairLinkDistance + QUAD.spacing) continue;
    const pp = partnerPoint(net, s.edge, s.u);
    if (!pp) continue;
    const d = Math.hypot(pp.x - x, pp.y - y);
    if (d <= QUAD.pairLinkDistance && (!best || d < best.d)) best = { existing: s, edge: pp.edge, u: pp.u, d };
  }
  return best && { existing: best.existing, edge: best.edge, u: best.u };
}

/** Station tool tooltip on a four-track section. Costs are already summed by the caller. */
export function stationQuadTip(o: {
  mode: StationHoverMode;
  role: 'local' | 'express';
  level: TrackLevel | null;
  cars: number;
  cost: number;
  days: number;
  error?: string;
}): string {
  const lvl = o.level ? cap(LEVEL_NAMES[o.level]) : '';
  const other = o.role === 'local' ? 'express' : 'local';
  const row = (label: string, value: string) => `<div class="row"><span class="hw-muted">${label}</span><span class="num">${value}</span></div>`;
  const lines: string[] = [];
  if (o.mode.kind === 'pair') {
    lines.push(`<div class="title">Cross-platform station · ${lvl} · ${o.cars} cars</div>`);
    lines.push(row('Platforms', 'local + express'));
    lines.push(row('Cost', `${fmtMoney(o.cost)} <span class="hw-muted">(2 platforms at ${Math.round(QUAD.pairPlatformCostShare * 100)}%)</span>`));
  } else if (o.mode.kind === 'link') {
    lines.push(`<div class="title">${esc(o.mode.existing.name)} · ${o.role} platform · ${o.cars} cars</div>`);
    lines.push(row('Cost', `${fmtMoney(o.cost)} <span class="hw-muted">(${Math.round(QUAD.pairPlatformCostShare * 100)}%: shared entrances)</span>`));
  } else {
    lines.push(`<div class="title">${lvl} station · ${o.cars} cars · ${o.role} pair only</div>`);
    lines.push(row('Cost', fmtMoney(o.cost)));
  }
  lines.push(row('Build time', `${o.days} days`));
  if (o.error) {
    lines.push(`<div class="reason hw-red">${esc(o.error)}</div>`);
    return lines.join('');
  }
  if (o.mode.kind === 'pair') lines.push(`<div class="hw-green" style="margin-top:3px">Click to place · <span class="hw-muted">Shift-click: only this pair</span></div>`);
  else if (o.mode.kind === 'link') lines.push(`<div class="hw-green" style="margin-top:3px">Click to add the ${o.role} platform to ${esc(o.mode.existing.name)} (cross-platform)</div>`);
  else {
    lines.push(`<div class="hw-muted">${o.role === 'local' ? 'Local-only stop: expresses run past on the other pair' : `Express-only platform: locals run past on the ${other} pair`}</div>`);
    lines.push(`<div class="hw-green" style="margin-top:3px">Click to place one platform</div>`);
  }
  return lines.join('');
}

/** The bulldoze tool on a platform of a cross-platform pair (§2.2). */
export function bulldozePairTip(o: { name: string; blueprint: boolean; refund: number; shift: boolean; blocked: string | null }): string {
  const title = `<div class="title">${esc(o.name)} · cross-platform</div>`;
  if (o.blocked) return title + `<div class="reason hw-red">${esc(o.blocked)} — remove it from the route first</div>`;
  if (o.shift) return title + (o.blueprint ? `<div class="hw-green">Click to remove just this platform (free)</div>` : `<div class="hw-amber">Click to demolish just this platform · refund ${fmtMoney(o.refund)}</div>`);
  return title + (o.blueprint ? `<div class="hw-green">Click to remove both platforms (free)</div>` : `<div class="hw-amber">Demolish both platforms of ${esc(o.name)} · refund ${fmtMoney(o.refund)}</div>`) + `<div class="hw-muted">Shift-click: just this platform</div>`;
}

// ------------------------------------------------------------------------------ route panel

/** One row of the route panel's Line list (§2.3). */
export interface LineRow {
  station: number;
  partner?: number;
  name: string;
  served: boolean;
  /** 1-based stop number (served rows). */
  stopNo: number;
  terminal: boolean;
  /** Skipped rows: "passes" (on the route's own track) or "on the local pair" (beside it). */
  tag: string;
  /** Other routes calling at this station complex. */
  others: Route[];
}

/** The Line list rows: every station along the line in direction-0 order, served or skipped. */
export function lineRows(net: Network, r: Route, routes: readonly Route[], along: readonly AlongStation[]): LineRow[] {
  return along.map((a) => {
    const ids = a.partner !== undefined ? [a.station, a.partner] : [a.station];
    const others = routes.filter((o) => o.id !== r.id && o.stops.some((s) => ids.includes(s)));
    let tag = '';
    if (!a.served) {
      if (a.where === 'beside') tag = `on the ${pairWord(net, a.station) ?? 'other'} pair`;
      else tag = 'passes';
    }
    return {
      station: a.station,
      ...(a.partner !== undefined ? { partner: a.partner } : {}),
      name: net.stations.get(a.station)?.name ?? '?',
      served: a.served,
      stopNo: a.served ? r.stops.indexOf(a.station) + 1 : 0,
      terminal: a.terminal,
      tag,
      others,
    };
  });
}

/** "Skips 5 stations" (the route editor and the Service section), or null when it stops everywhere. */
export function skipsText(along: readonly AlongStation[]): string | null {
  const n = along.filter((a) => !a.served).length;
  return n ? `Skips ${n} station${n > 1 ? 's' : ''}` : null;
}

/** The Overtakes card's value: yesterday's report, else today so far, else a dash. */
export function overtakesValue(yesterday: number | undefined, today: number | undefined): string {
  if (yesterday !== undefined) return fmtCount(yesterday);
  if (today !== undefined && today > 0) return `${fmtCount(today)} today`;
  return '—';
}

export const OVERTAKES_TIP = 'How many times this route’s trains passed another route’s train between two cross-platform stations both call at (yesterday). An express on its own pair overtakes the local it would otherwise queue behind.';

export const SERVICE_TIP = {
  local: 'Calls at the local platform of cross-platform stations. Round bullet.',
  express: 'Calls at the express platform of cross-platform stations and is drawn with a lozenge bullet. Its trains have a light outline on the map.',
  pattern: 'Local platforms of cross-platform stations become their express platforms, and local-only stops on four-track sections are dropped. Terminals stay. The route runs as an express.',
  allStops: 'Stop at every station along the line, at the local platform of cross-platform stations. Terminals stay. The route runs as a local.',
};

/** True when a route runs on any four-track section (the Service buttons have something to do). */
export function routeOnQuad(net: Network, stops: readonly number[]): boolean {
  return stops.some((s) => quadRole(net, s) !== null || partnerOf(net, s) !== null);
}

// ------------------------------------------------------------------------------ station panel

/** The worker's 'station' reply. */
export interface StationDetail {
  hourlyToday: number[];
  hourlyYesterday: number[];
  leftToday: number;
  leftYesterday: number;
  waiting: number;
  from: { tract: number; count: number }[];
  to: { tract: number; count: number }[];
}

/** Both platforms of a cross-platform station as one: hourly and left-behind summed, flows merged by tract. */
export function mergeDetails(ds: readonly StationDetail[]): StationDetail {
  const sumArr = (k: 'hourlyToday' | 'hourlyYesterday') => ds[0][k].map((_, i) => ds.reduce((t, d) => t + (d[k][i] ?? 0), 0));
  const flows = (k: 'from' | 'to') => {
    const m = new Map<number, number>();
    for (const d of ds) for (const f of d[k]) m.set(f.tract, (m.get(f.tract) ?? 0) + f.count);
    return [...m].map(([tract, count]) => ({ tract, count })).sort((a, b) => b.count - a.count || a.tract - b.tract);
  };
  return {
    hourlyToday: sumArr('hourlyToday'),
    hourlyYesterday: sumArr('hourlyYesterday'),
    leftToday: ds.reduce((t, d) => t + d.leftToday, 0),
    leftYesterday: ds.reduce((t, d) => t + d.leftYesterday, 0),
    waiting: ds.reduce((t, d) => t + d.waiting, 0),
    from: flows('from'),
    to: flows('to'),
  };
}

/**
 * Edges under construction that get a progress label on the map. On a four-track section the two
 * pairs run 9 m apart with about the same midpoints, so an express edge whose local partner (at
 * its midpoint) is under construction too is labelled once, by the local edge; connectors are
 * labelled only when no pair of their group is (they sit inside the four-track box).
 */
export function constructionLabelEdges(net: Network): number[] {
  const building = new Set<number>();
  const groups = new Set<number>();
  for (const e of net.edges.values()) {
    if (e.status !== 'construction') continue;
    building.add(e.id);
    if (e.quad && e.quad.role !== 'link') groups.add(e.quad.g);
  }
  const out: number[] = [];
  for (const id of building) {
    const t = net.edges.get(id)!.quad;
    if (t?.role === 'link' && groups.has(t.g)) continue;
    if (t?.role === 'express') {
      const p = partnerPoint(net, id, net.geom(id).length / 2);
      if (p && building.has(p.edge)) continue;
    }
    out.push(id);
  }
  return out;
}

/** Two stop lists are the same, in order. */
export function sameStopList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A Service edit (Skip, Stop here, Local / Express, Express pattern, All stops) that would change
 * nothing: the same stops and the same kind. The route panel then edits nothing and restarts no trains.
 */
export function serviceEditNoop(r: Pick<Route, 'stops' | 'express'>, stops: readonly number[], express?: boolean): boolean {
  return sameStopList(stops, r.stops) && (express === undefined || express === !!r.express);
}

/** Bulldoze tool: hovering one pair of a four-track section says how to put it back. */
export function bulldozePairEdgeHint(role: QuadRole | undefined): string {
  if (role !== 'local' && role !== 'express') return '';
  return `<div class="hw-muted">The ${role} pair of a four-track section: to put it back, draw four tracks (<span class="kbd">Q</span>) from one end of the gap to the other</div>`;
}
