/**
 * Cinematic (v2, docs/v2/cinematic.md) runtime pieces that are pure or can run against a fake
 * map: the settings, the timelapse replay (frames, timing, draw-in, stations popping up), the copy
 * in both cities (follow chip, photo caption, timelapse counters, units), the day/night runtime's
 * paint pushes (only on change; Always day is the old map), the drawn train pose the follow-cam
 * locks on (interline and four-track offsets, track height), and the lit-window pattern.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { CINEMATIC, MAP, QUAD, type TrackLevel } from '../src/balance';
import { applyCity } from '../src/cities';
import { Game } from '../src/core/game';
import { setUnits } from '../src/core/units';
import { SECONDS_PER_DAY } from '../src/core/calendar';
import { pickEdge } from '../src/construction/pick';
import type { StrokePoint } from '../src/construction/types';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { defaultHeadways } from '../src/routes/routeSet';
import type { CRouteDir } from '../src/sim/protocol';
import { BUILDING_LAYER } from '../src/map/style';
import { DAY, NIGHT } from '../src/cinematic/palette';
import { Daylight, WINDOWS_IMAGE, windowsImage } from '../src/cinematic/daylight';
import { DEFAULT_PREFS, parsePrefs, storePrefs } from '../src/cinematic/prefs';
import { photoCaption } from '../src/cinematic/photoMode';
import {
  cloneTimelapse,
  DRAW_PHASE,
  drawnFraction,
  drawnRange,
  frameStats,
  nearestOnPts,
  recordFrame,
  replayAt,
  replayFrames,
  replayStep,
  snapshotFrame,
  stepSeconds,
  type TLFrame,
} from '../src/cinematic/timelapse';
import { captionText, followStatus, timelapseStats } from '../src/ui/cinematicText';
import { drawnTrainPose } from '../src/trains/trainPose';

const dry: Terrain = { isWater: () => false, density: () => 0 };
const P = (x: number, y: number, level: TrackLevel = 'deep'): StrokePoint => ({ x, y, level });
const none = { kind: 'none' } as const;

afterEach(() => {
  applyCity('nyc');
  setUnits('imperial');
});

function lineGame() {
  const game = new Game({} as World, dry, { sandbox: true, fare: 3 });
  const n = game.network;
  n.addStroke([P(0, 0), P(1200, 400), P(2600, 0)], 'heavy', none, none);
  const at = (x: number, y: number, name: string) => {
    const hit = pickEdge(n, x, y, 60);
    if (!hit) throw new Error('no track');
    return n.addStation(hit.edge, hit.u, 8, name).id;
  };
  const s = [at(100, 33, 'A'), at(600, 200, 'B'), at(2400, 57, 'C')];
  if (!game.build(true).ok) throw new Error('build');
  const r = game.routes.create({ name: 'Line', bullet: 'L', color: '#E8443A', cls: 'heavy', stops: s, cars: 8, headways: defaultHeadways() });
  return { game, stations: s, route: r };
}

/** The line extended east by 2.2 km with one more station near its far end. */
function extend(game: Game): number {
  const n = game.network;
  const end = [...n.nodes.values()].find((x) => Math.hypot(x.x - 2600, x.y) < 1)!.id;
  n.addStroke([P(2600, 0), P(3600, -400), P(4800, -400)], 'heavy', { kind: 'node', node: end }, none);
  const hit = pickEdge(n, 4700, -400, 60)!;
  const id = n.addStation(hit.edge, hit.u, 8, 'D').id;
  game.build(true);
  return id;
}

// ------------------------------------------------------------------------------------------
describe('cinematic settings', () => {
  it('parse field by field with the defaults for anything missing or malformed', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('cycle')).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ dayNight: 'cycle', windows: true, letterbox: true, caption: true });
    expect(parsePrefs({ dayNight: 'day', windows: false, letterbox: 'yes', caption: false })).toEqual({ dayNight: 'day', windows: false, letterbox: true, caption: false });
    expect(parsePrefs({ dayNight: 'night' }).dayNight).toBe('cycle');
    // No localStorage here: storing still answers with the merged settings, and nothing throws.
    expect(storePrefs({ windows: false })).toMatchObject({ windows: false, dayNight: 'cycle' });
  });
});

// ------------------------------------------------------------------------------------------
describe('the timelapse replay', () => {
  const f = (day: number): TLFrame => ({ day, edges: [], stations: [], routes: [] });

  it('runs from an empty city to the network now; a frame of the same day is replaced by now', () => {
    const tl = { edges: new Map(), stations: new Map(), shapes: [], frames: [f(18), f(39)] };
    expect(replayFrames(tl, f(40)).map((x) => x.day)).toEqual([0, 18, 39, 40]);
    expect(replayFrames(tl, f(39)).map((x) => x.day)).toEqual([0, 18, 39]);
    expect(replayFrames(tl, f(39))[2]).not.toBe(tl.frames[1]);
    // An older save (empty timelapse): one step from nothing to now.
    expect(replayFrames({ ...tl, frames: [] }, f(250)).map((x) => x.day)).toEqual([0, 250]);
    // Nothing at all: just the empty start.
    expect(replayFrames({ ...tl, frames: [] }, null)).toHaveLength(1);
  });

  it('a step lasts its months at 1× (⅔ to 3 months’ worth); the position walks the steps', () => {
    const spm = CINEMATIC.timelapseSecondsPerMonth;
    expect(stepSeconds(f(0), f(22), spm)).toBeCloseTo((22 / 21.75) * spm, 9);
    expect(stepSeconds(f(39), f(40), spm)).toBeCloseTo(0.6 * spm, 9);
    expect(stepSeconds(f(0), f(500), spm)).toBeCloseTo(3 * spm, 9);
    const d = [0, 1, 2, 0.5];
    expect(replayAt(d, 0)).toEqual({ step: 1, p: 0 });
    expect(replayAt(d, 0.5)).toEqual({ step: 1, p: 0.5 });
    expect(replayAt(d, 2)).toEqual({ step: 2, p: 0.5 });
    expect(replayAt(d, 3.25)).toEqual({ step: 3, p: 0.5 });
    expect(replayAt(d, 99)).toEqual({ step: 3, p: 1 });
    expect(replayAt([0], 1)).toEqual({ step: 1, p: 1 });
  });

  it('an edge draws in over its slot of the draw phase, from its starting end, then holds', () => {
    const slot = { t0: 0.25, t1: 0.75, fromA: false };
    expect(drawnFraction(slot, 0)).toBe(0);
    expect(drawnFraction(slot, 0.25 * DRAW_PHASE)).toBe(0);
    expect(drawnFraction(slot, 0.5 * DRAW_PHASE)).toBeCloseTo(0.5, 9);
    expect(drawnFraction(slot, 0.75 * DRAW_PHASE)).toBe(1);
    expect(drawnFraction(slot, 1)).toBe(1);
    expect(drawnFraction({ t0: 0.4, t1: 0.4, fromA: true }, 0.39 * DRAW_PHASE)).toBe(0);
    expect(drawnFraction({ t0: 0.4, t1: 0.4, fromA: true }, 0.41 * DRAW_PHASE)).toBe(1);
    expect(drawnRange(200, { t0: 0, t1: 1, fromA: true }, 0.25)).toEqual([0, 50]);
    expect(drawnRange(200, { t0: 0, t1: 1, fromA: false }, 0.25)).toEqual([150, 200]);
  });

  it('a step: old track whole from the start, new track drawing out from it, its station popping up as the line reaches it', () => {
    const { game } = lineGame();
    const f0 = game.recordTimelapse(18);
    const d = extend(game);
    // The player's own clone: recording "now" never touches the save's timelapse.
    const clone = cloneTimelapse(game.timelapse);
    const now = snapshotFrame(clone, 39, game.network, game.routes);
    expect(game.timelapse.edges.size).toBe(f0.edges.length);
    expect(clone.edges.size).toBeGreaterThan(game.timelapse.edges.size);
    const frames = replayFrames(clone, now);
    const first = replayStep(clone, frames[0], frames[1], MAP.interlineSpacingPx, MAP.routeLineWidthPx, QUAD.pairGapPx);
    // From the empty city everything is new and stations appear along the draw.
    expect(first.oldEdges).toEqual([]);
    expect(first.newEdges.length).toBe(f0.edges.length);
    const second = replayStep(clone, frames[1], frames[2], MAP.interlineSpacingPx, MAP.routeLineWidthPx, QUAD.pairGapPx);
    expect(second.newEdges.length).toBeGreaterThan(0);
    expect(second.oldEdges.length + second.newEdges.length).toBe(now.edges.length);
    // A, B, C were there before (t = 0); D, near the far end, comes late in the draw.
    const tOf = new Map(second.stations.map((s) => [s.id, s.t]));
    expect([...tOf.entries()].filter(([id]) => id !== d).every(([, t]) => t === 0)).toBe(true);
    expect(tOf.get(d)!).toBeGreaterThan(0.6);
    expect(tOf.get(d)!).toBeLessThanOrEqual(1);
    // The route's pieces are the frame's (one route, interlined offset 0 on its own track).
    expect(second.pieces.length).toBeGreaterThan(0);
    expect(second.pieces.every((p) => p.offsetPx === 0)).toBe(true);
  });

  it('nearest point on a point list: distance, distance along, length', () => {
    const pts = [0, 0, 100, 0, 100, 100];
    expect(nearestOnPts(pts, 50, 10)).toEqual({ d: 10, s: 50, L: 200 });
    expect(nearestOnPts(pts, 120, 150)).toMatchObject({ s: 200, L: 200 });
    expect(nearestOnPts(pts, 120, 150).d).toBeCloseTo(Math.hypot(20, 50), 9);
  });

  it('a month-close frame per month: the save keeps the network the replay shows', () => {
    const { game } = lineGame();
    recordFrame(game.timelapse, 18, game.network, game.routes);
    extend(game);
    recordFrame(game.timelapse, 38, game.network, game.routes);
    const frames = replayFrames(game.timelapse, snapshotFrame(cloneTimelapse(game.timelapse), 40, game.network, game.routes));
    expect(frames.map((x) => x.day)).toEqual([0, 18, 38, 40]);
    expect(frames[3].edges).toEqual(frames[2].edges);
  });
});

// ------------------------------------------------------------------------------------------
describe('cinematic copy in both cities', () => {
  const base = { held: false, dwelling: false, next: '96 St', terminal: 'Inwood', people: 1240, now: 8 * 3600 };

  it('the follow chip: incidents first, then holds and closures, then the ride', () => {
    expect(followStatus(base)).toEqual({ text: 'Next 96 St · Towards Inwood · 1,240 on board', tone: null });
    expect(followStatus({ ...base, dwelling: true }).text).toBe('At 96 St · Towards Inwood · 1,240 on board');
    expect(followStatus({ ...base, held: true })).toEqual({ text: 'Held at 96 St for an even gap · Towards Inwood · 1,240 on board', tone: 'amber' });
    expect(followStatus({ ...base, nextClosed: true })).toEqual({ text: '96 St is closed: running through · Towards Inwood · 1,240 on board', tone: 'red' });
    expect(followStatus({ ...base, held: true, incident: { kind: 'breakdown', place: 'between 86 St and 96 St', until: 8 * 3600 + 900 } })).toEqual({
      text: 'Stalled: mechanical problem, moving again ~08:15 · Towards Inwood · 1,240 on board',
      tone: 'red',
    });
    expect(followStatus({ ...base, incident: { kind: 'sick', place: '86 St', until: 8 * 3600 + 300 } }).text).toBe('Held at 86 St: sick passenger, ~5 min · Towards Inwood · 1,240 on board');
  });

  it('the photo caption names the city and the weather; the clock is the city’s', () => {
    const t = 1 * SECONDS_PER_DAY + 18 * 3600 + 42 * 60;
    expect(photoCaption(t)).toBe('Tue 8 Jan 2030 · 18:42 · New York');
    applyCity('london');
    expect(photoCaption(t)).toBe('Tue 8 Jan 2030 · 18:42 · London');
    expect(photoCaption(t, 'London', { kind: 'snow', severity: 0.9, carried: false })).toBe('Tue 8 Jan 2030 · 18:42 · London · Heavy snow');
    expect(captionText(1, 0, 'London', { kind: 'clear', severity: 0, carried: false })).toBe('Tue 8 Jan 2030 · 00:00 · London');
    expect(captionText(1, 0, 'New York', { kind: 'rain', severity: 0.6, carried: false })).toBe('Tue 8 Jan 2030 · 00:00 · New York · Rain');
  });

  it('the timelapse counter in each city’s units', () => {
    setUnits('imperial');
    expect(timelapseStats(16093, 12, 2)).toBe('10.00 mi of track · 12 stations · 2 routes running');
    expect(timelapseStats(40000, 30, 4)).toBe('24.9 mi of track · 30 stations · 4 routes running');
    setUnits('metric');
    expect(timelapseStats(16093, 1, 1)).toBe('16.1 km of track · 1 station · 1 route running');
    expect(timelapseStats(0, 0, 0)).toBe('0 m of track · 0 stations · 0 routes running');
  });
});

// ------------------------------------------------------------------------------------------
describe('day and night on the map (a fake MapLibre map)', () => {
  function fakeMap() {
    const layers = [
      { id: 'background', type: 'background' },
      { id: 'water', type: 'fill' },
      { id: 'label_city', type: 'symbol' },
      { id: BUILDING_LAYER, type: 'fill-extrusion' },
      { id: 'hw-route-deep', type: 'line' },
      { id: 'hw-labels', type: 'symbol' },
    ];
    const calls = { paint: [] as [string, string, unknown][], light: 0, sky: 0, images: 0 };
    const map = {
      getStyle: () => ({ layers }),
      hasImage: () => calls.images > 0,
      addImage: () => void calls.images++,
      getLayer: (id: string) => layers.find((l) => l.id === id),
      setPaintProperty: (l: string, p: string, v: unknown) => void calls.paint.push([l, p, v]),
      setLight: () => void calls.light++,
      setSky: () => void calls.sky++,
    };
    return { map: map as unknown as MLMap, calls };
  }
  const T = (day: number, h: number, m = 0) => day * SECONDS_PER_DAY + h * 3600 + m * 60;

  it('pushes paint only when the palette moves: nothing on the day and night plateaus, the windows twice a day', () => {
    applyCity('nyc');
    const { map, calls } = fakeMap();
    const nights: number[] = [];
    const d = Daylight.for(map, { mode: 'cycle', windows: true, onNight: (n) => nights.push(n) });
    expect(Daylight.for(map, { mode: 'cycle', windows: true, onNight: (n) => nights.push(n) })).toBe(d);
    expect(calls.images).toBe(1);
    // Noon: the style already shows the Day palette; only the light swings to the sun.
    d.tick(T(1, 12), null);
    expect(calls.paint).toEqual([]);
    expect(calls.light).toBe(1);
    d.tick(T(1, 12, 1), null);
    expect(calls.paint).toEqual([]);
    expect(calls.light).toBe(1);
    // Night: every bound key once (the game's own 'hw-' layers keep their colours), the windows on.
    d.tick(T(1, 21), null);
    const props = calls.paint.map(([l, p]) => `${l}.${p}`);
    expect(props).toEqual(expect.arrayContaining(['background.background-color', 'water.fill-color', 'label_city.text-color', 'label_city.text-halo-color', `${BUILDING_LAYER}.fill-extrusion-color`, `${BUILDING_LAYER}.fill-extrusion-pattern`]));
    expect(props.some((p) => p.startsWith('hw-route') || p.startsWith('hw-labels'))).toBe(false);
    expect(calls.paint.find(([l]) => l === 'background')![2]).toBe(NIGHT.colours.land);
    expect(calls.paint.find(([, p]) => p === 'fill-extrusion-pattern')![2]).toBe(WINDOWS_IMAGE);
    expect(calls.sky).toBe(1);
    expect(nights.at(-1)).toBe(1);
    expect(d.windowsLit).toBe(true);
    const n = calls.paint.length;
    d.tick(T(1, 22, 30), null);
    d.tick(T(2, 2), null);
    expect(calls.paint.length).toBe(n);
    // Always day: the old map back in one go (no pattern), then nothing at all.
    d.setMode('day');
    d.tick(T(2, 3), null);
    expect(calls.paint.find(([l], i) => i >= n && l === 'background')![2]).toBe(DAY.colours.land);
    expect(calls.paint.filter(([, p], i) => i >= n && p === 'fill-extrusion-pattern').map(([, , v]) => v)).toEqual([undefined]);
    expect(nights.at(-1)).toBe(0);
    const m = calls.paint.length, lights = calls.light;
    for (let h = 4; h < 24; h += 2) d.tick(T(2, h), null);
    expect(calls.paint.length).toBe(m);
    expect(calls.light).toBe(lights);
  });

  it('a twilight at 1× updates a few times a game minute at most, and weather tints the night', () => {
    applyCity('london');
    const { map, calls } = fakeMap();
    const d = Daylight.for(map, { mode: 'cycle', windows: false });
    d.tick(T(1, 12), null);
    const before = calls.paint.length;
    // London sunset on 8 Jan 2030 is about 16:10: a tick every 15 game seconds for an hour (4 Hz at 1×).
    let ticks = 0;
    for (let s = T(1, 15, 45); s < T(1, 16, 45); s += 15, ticks++) d.tick(s, null);
    const pushes = calls.paint.length - before;
    expect(pushes).toBeGreaterThan(0);
    // Far fewer than one push per binding per tick.
    expect(pushes).toBeLessThan(ticks * 2);
    expect(d.windowsLit).toBe(false);
    const k = calls.paint.length;
    d.tick(T(1, 22), { kind: 'snow', severity: 1 });
    const bg = calls.paint.slice(k).find(([l]) => l === 'background')?.[2];
    expect(bg).toBeDefined();
    expect(bg).not.toBe(NIGHT.colours.land);
  });

  it('the lit-window pattern is the same in every session, about a quarter of the windows lit', () => {
    const a = windowsImage(), b = windowsImage();
    expect(a.width).toBe(64);
    expect([...a.data]).toEqual([...b.data]);
    let lit = 0, cells = 0;
    for (let gy = 0; gy < 8; gy++)
      for (let gx = 0; gx < 8; gx++) {
        const i = ((gy * 8 + 2) * 64 + gx * 8 + 3) * 4;
        cells++;
        if (a.data[i] > 150) lit++;
      }
    expect(lit / cells).toBeGreaterThan(0.12);
    expect(lit / cells).toBeLessThan(0.4);
  });
});

// ------------------------------------------------------------------------------------------
describe('the follow-cam locks on the train as drawn', () => {
  /** A 1 km route direction east along y = 0, at height z, on one edge (5) travelled a→b or b→a. */
  const dir = (z: number, edgeDir: 0 | 1): CRouteDir =>
    ({
      xs: Float64Array.from([0, 500, 1000]),
      ys: Float64Array.from([0, 0, 0]),
      zs: Float64Array.from([z, z, z]),
      cum: Float64Array.from([0, 500, 1000]),
      length: 1000,
      elems: [{ s0: 0, s1: 1000, edge: 5, edgeDir }],
    }) as unknown as CRouteDir;

  it('its middle, its heading, its interline or pair offset (px → m at the centre) and track height', () => {
    // Route 7 is drawn 6 px right of the edge's a→b direction; trains keep 1.6 px to their right.
    const offsets = new Map([['5:7', 6]]);
    const p = drawnTrainPose(dir(8, 0), 500, 100, 7, offsets, 1, 0.5, true);
    expect(p.x).toBeCloseTo(450, 9);
    expect(p.heading).toBeCloseTo(90, 9);
    // Right of east is south: (6 + 1.6) px × 0.5 m.
    expect(p.y).toBeCloseTo(-3.8, 9);
    expect(p.z).toBe(8);
    // Travelling b→a on the edge, the same drawn line is on the left of travel.
    expect(drawnTrainPose(dir(8, 1), 500, 100, 7, offsets, 1, 0.5, true).y).toBeCloseTo((-6 + 1.6) * -0.5, 9);
    // At line scale 1.5 the px offset grows; in 2D (and underground) the camera aims at the ground.
    expect(drawnTrainPose(dir(8, 0), 500, 100, 7, offsets, 1.5, 0.5, true).y).toBeCloseTo(-(9 + 1.6) * 0.5, 9);
    expect(drawnTrainPose(dir(8, 0), 500, 100, 7, offsets, 1, 0.5, false).z).toBe(0);
    expect(drawnTrainPose(dir(-20, 0), 500, 100, 7, offsets, 1, 0.5, true).z).toBe(0);
    // A train still pulling out of the first stop: its middle is clamped to the path.
    expect(drawnTrainPose(dir(0, 0), 20, 100, 7, offsets, 1, 0.5, true).x).toBeCloseTo(0, 9);
  });
});

describe('the timelapse counter', () => {
  it('counts a cross-platform pair as one station and a four-track section’s two pairs as one length', () => {
    const tl = {
      edges: new Map([
        [1, { pts: new Int32Array([0, 0, 1000, 0]), away: 1 as const }],
        [2, { pts: new Int32Array([0, 9, 1000, 9]), away: -1 as const }],
        [3, { pts: new Int32Array([1000, 0, 2000, 0]), away: 0 as const }],
      ]),
      stations: new Map([
        [10, { x: 500, y: 0 }],
        [11, { x: 500, y: 9 }],
        [12, { x: 1500, y: 0 }],
      ]),
      shapes: [],
      frames: [],
    };
    const f: TLFrame = { day: 0, edges: [1, 2, 3].map((id) => ({ id, built: true, flip: false })), stations: [10, 11, 12].map((id) => ({ id, built: true })), routes: [] };
    expect(frameStats(tl, f)).toEqual({ trackM: 2000, stations: 2, routes: 0 });
  });
});
