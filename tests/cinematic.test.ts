/**
 * Cinematic (v2, docs/v2/cinematic.md §5): the day/night palette, the sun over both cities, the
 * follow-cam's chase maths, the timelapse's recording, bounds and encoding, and save v7. No world
 * data and no DOM: everything here is a pure function.
 */
import { describe, expect, it } from 'vitest';
import { CINEMATIC, type TrackLevel } from '../src/balance';
import { applyCity } from '../src/cities';
import { Game } from '../src/core/game';
import { metresPerPixel, ORIGIN_LAT } from '../src/core/geo';
import { dateOfDay, monthKey } from '../src/core/calendar';
import { pickEdge } from '../src/construction/pick';
import { addQuadStroke } from '../src/construction/quad';
import type { StrokePoint } from '../src/construction/types';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import { defaultHeadways } from '../src/routes/routeSet';
import { BASEMAP } from '../src/map/style';
import {
  ALT,
  COLOUR_KEYS,
  cyclePalette,
  DAWN,
  DAY,
  DUSK,
  GOLDEN,
  hexToOklab,
  lightPosition,
  mixHex,
  nightFactor,
  NIGHT,
  oklabToHex,
  paletteAt,
  paletteChanges,
  windowsOn,
} from '../src/cinematic/palette';
import { gameSun, gameSunTimes, localToUtcMs, sunPosition, sunTimes, utcOffsetAt, type TimeZone } from '../src/cinematic/solar';
import { angleDelta, chaseCentre, distanceForZoom, easeAngle, cameraToCenterPx, headingAt, poseOnPath, zoomForDistance, type PathLike } from '../src/cinematic/chase';
import {
  boundTimelapse,
  decodeTimelapse,
  decodeVarints,
  drawSchedule,
  emptyTimelapse,
  encodedSize,
  encodeTimelapse,
  encodeVarints,
  frameStats,
  newEdgeIds,
  recordFrame,
  samplePts,
  simplify,
  slicePts,
  thinFrames,
  type TLFrame,
} from '../src/cinematic/timelapse';
import { migrate } from '../src/save/migrate';
import { applySave, buildSave } from '../src/save/serialize';
import { SAVE_VERSION } from '../src/save/format';

const dry: Terrain = { isWater: () => false, density: () => 0 };
const P = (x: number, y: number, level: TrackLevel = 'deep'): StrokePoint => ({ x, y, level });
const none = { kind: 'none' } as const;
const settings = { units: 'metric' as const, agentScale: 10, seed: 1885 };
const L = (h: string) => hexToOklab(h)[0];
const chroma = (h: string) => Math.hypot(hexToOklab(h)[1], hexToOklab(h)[2]);
const hhmm = (s: number) => Math.round(s / 60);

// ------------------------------------------------------------------------------------------
describe('cinematic palette', () => {
  it('Day is the basemap as before; the keyframes sit at their altitudes, dawn before noon and dusk after', () => {
    const b = BASEMAP;
    expect(DAY.colours).toMatchObject({ land: b.slate.toLowerCase(), park: b.park.toLowerCase(), water: b.harbour.toLowerCase(), street: b.street.toLowerCase(), avenue: b.avenue.toLowerCase(), block: b.block.toLowerCase(), label: b.label.toLowerCase(), labelHalo: b.slate.toLowerCase() });
    expect(cyclePalette({ altitude: 40, morning: true })).toBe(DAY);
    expect(cyclePalette({ altitude: ALT.day, morning: false })).toBe(DAY);
    expect(cyclePalette({ altitude: -30, morning: true })).toBe(NIGHT);
    expect(cyclePalette({ altitude: ALT.night, morning: false })).toBe(NIGHT);
    expect(cyclePalette({ altitude: ALT.twilight, morning: true }).colours).toEqual(DAWN.colours);
    expect(cyclePalette({ altitude: ALT.twilight, morning: false }).colours).toEqual(DUSK.colours);
    expect(cyclePalette({ altitude: ALT.golden, morning: false }).colours).toEqual(GOLDEN.colours);
  });

  it('interpolates in OKLab: lightness moves monotonically from night to day; midpoints lie between', () => {
    let prev = -Infinity;
    for (let a = -12; a <= 16; a += 0.5) {
      const l = L(cyclePalette({ altitude: a, morning: true }).colours.land);
      expect(l).toBeGreaterThanOrEqual(prev - 0.004);
      prev = l;
    }
    const mid = mixHex(NIGHT.colours.water, DUSK.colours.water, 0.5);
    expect(L(mid)).toBeGreaterThan(Math.min(L(NIGHT.colours.water), L(DUSK.colours.water)));
    expect(L(mid)).toBeLessThan(Math.max(L(NIGHT.colours.water), L(DUSK.colours.water)));
    expect(mixHex('#123456', '#123456', 0.37)).toBe('#123456');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    // sRGB → OKLab → sRGB is exact for the palette's colours.
    for (const p of [DAY, NIGHT, DAWN, DUSK, GOLDEN]) for (const k of COLOUR_KEYS) expect(oklabToHex(hexToOklab(p.colours[k]))).toBe(p.colours[k]);
  });

  it('the night factor (glow) and lit windows follow the sun, with hysteresis for the windows', () => {
    expect(nightFactor(-10)).toBe(1);
    expect(nightFactor(5)).toBe(0);
    for (let a = -9; a < 3; a += 0.25) expect(nightFactor(a + 0.25)).toBeLessThanOrEqual(nightFactor(a));
    expect(windowsOn(-5, false)).toBe(true);
    expect(windowsOn(-4, false)).toBe(false);
    expect(windowsOn(-4, true)).toBe(true);
    expect(windowsOn(-3, true)).toBe(false);
  });

  it('weather tints: rain greys and darkens, snow whitens the ground by day and by night, heat warms; clear changes nothing', () => {
    for (const a of [30, -15]) {
      const sun = { altitude: a, morning: false };
      const clear = paletteAt(sun, { kind: 'clear', severity: 0 });
      expect(clear).toEqual(cyclePalette(sun));
      const rain = paletteAt(sun, { kind: 'rain', severity: 1 });
      expect(L(rain.colours.land)).toBeLessThan(L(clear.colours.land));
      expect(chroma(rain.colours.park)).toBeLessThan(chroma(clear.colours.park));
      expect(rain.lightIntensity).toBeLessThan(clear.lightIntensity);
      const snow = paletteAt(sun, { kind: 'snow', severity: 1 });
      expect(L(snow.colours.land)).toBeGreaterThan(L(clear.colours.land) + 0.03);
      expect(L(snow.colours.roof)).toBeGreaterThan(L(clear.colours.roof));
      const half = paletteAt(sun, { kind: 'snow', severity: 0.5 });
      expect(L(half.colours.land)).toBeGreaterThan(L(clear.colours.land));
      expect(L(half.colours.land)).toBeLessThan(L(snow.colours.land));
      const heat = paletteAt(sun, { kind: 'heat', severity: 1 });
      expect(hexToOklab(heat.colours.land)[2]).toBeGreaterThan(hexToOklab(clear.colours.land)[2]);
    }
  });

  it('pushes only colours that moved by the threshold; the light follows the sun within bounds', () => {
    expect(paletteChanges(null, DAY)).toEqual([...COLOUR_KEYS]);
    expect(paletteChanges(DAY, DAY)).toEqual([]);
    const nudged = { ...DAY, colours: { ...DAY.colours, land: '#2c3138' } };
    expect(paletteChanges(DAY, nudged, CINEMATIC.minColourDelta)).toEqual([]);
    const moved = { ...DAY, colours: { ...DAY.colours, land: '#2e3138', water: '#1e3a50' } };
    expect(paletteChanges(DAY, moved, CINEMATIC.minColourDelta)).toEqual(['land', 'water']);
    // A whole day at 15-minute steps changes something at most at twilight and dusk.
    const steps = [];
    let prev = cyclePalette({ altitude: -20, morning: true });
    for (let a = -20; a <= 20; a += 0.25) {
      const next = cyclePalette({ altitude: a, morning: true });
      if (paletteChanges(prev, next).length) {
        steps.push(a);
        prev = next;
      }
    }
    expect(steps.every((a) => a > ALT.night && a <= ALT.day + 0.25)).toBe(true);
    expect(lightPosition({ altitude: 70, azimuth: 180 })).toEqual([1.5, 180, 25]);
    expect(lightPosition({ altitude: 3, azimuth: 250.4 })).toEqual([1.5, 250, 78]);
    expect(lightPosition({ altitude: -20, azimuth: 10 })).toEqual([1.5, 10, 70]);
  });
});

// ------------------------------------------------------------------------------------------
describe('the sun over both cities', () => {
  const NY: [number, number, TimeZone] = [40.7128, -74.006, { utcOffset: -5, dst: 'us' }];
  const LDN: [number, number, TimeZone] = [51.5073, -0.1276, { utcOffset: 0, dst: 'eu' }];
  const times = (c: [number, number, TimeZone], y: number, m: number, d: number) => sunTimes(c[2], y, m, d, c[0], c[1]);
  const at = (h: number, min: number) => h * 60 + min;

  it('sunrise and sunset within 5 minutes of the published times (solstices, an equinox, the start date)', () => {
    const cases: [typeof NY, number, number, number, number, number][] = [
      [NY, 2030, 11, 21, at(7, 17), at(16, 32)],
      [NY, 2030, 5, 21, at(5, 25), at(20, 31)],
      [NY, 2030, 2, 20, at(6, 59), at(19, 9)],
      [NY, 2030, 0, 7, at(7, 20), at(16, 43)],
      [LDN, 2030, 11, 21, at(8, 4), at(15, 53)],
      [LDN, 2030, 5, 21, at(4, 43), at(21, 21)],
      [LDN, 2030, 2, 20, at(6, 3), at(18, 13)],
      [LDN, 2030, 0, 7, at(8, 5), at(16, 9)],
    ];
    for (const [c, y, m, d, rise, set] of cases) {
      const t = times(c, y, m, d);
      expect(Math.abs(hhmm(t.sunrise) - rise)).toBeLessThanOrEqual(5);
      expect(Math.abs(hhmm(t.sunset) - set)).toBeLessThanOrEqual(5);
      expect(t.dawn).toBeLessThan(t.sunrise);
      expect(t.dusk).toBeGreaterThan(t.sunset);
    }
  });

  it("London's winter days are much shorter than New York's, its summer days longer", () => {
    const len = (c: typeof NY, m: number, d: number) => {
      const t = times(c, 2030, m, d);
      return (t.sunset - t.sunrise) / 3600;
    };
    expect(len(NY, 11, 21) - len(LDN, 11, 21)).toBeGreaterThan(1.2);
    expect(len(LDN, 5, 21) - len(NY, 5, 21)).toBeGreaterThan(1.3);
    expect(len(LDN, 11, 21)).toBeLessThan(8);
    expect(len(LDN, 5, 21)).toBeGreaterThan(16.5);
  });

  it('daylight saving: US second Sunday of March to first of November, EU last Sundays of March and October', () => {
    const us = NY[2], eu = LDN[2];
    expect(utcOffsetAt(us, 2030, 2, 10, 1.5 * 3600)).toBe(-5);
    expect(utcOffsetAt(us, 2030, 2, 10, 3.5 * 3600)).toBe(-4);
    expect(utcOffsetAt(us, 2030, 10, 3, 0.5 * 3600)).toBe(-4);
    expect(utcOffsetAt(us, 2030, 10, 3, 3 * 3600)).toBe(-5);
    expect(utcOffsetAt(us, 2030, 6, 1, 12 * 3600)).toBe(-4);
    expect(utcOffsetAt(eu, 2030, 2, 31, 0.5 * 3600)).toBe(0);
    expect(utcOffsetAt(eu, 2030, 2, 31, 2.5 * 3600)).toBe(1);
    expect(utcOffsetAt(eu, 2030, 9, 27, 1.5 * 3600)).toBe(1);
    expect(utcOffsetAt(eu, 2030, 9, 27, 3 * 3600)).toBe(0);
    expect(utcOffsetAt(eu, 2030, 0, 7, 12 * 3600)).toBe(0);
    expect(localToUtcMs(us, 2030, 6, 1, 12 * 3600)).toBe(Date.UTC(2030, 6, 1, 16));
  });

  it('the sun is south at solar noon, east in the morning; the game clock is each city’s local time', () => {
    const t = times(NY, 2030, 5, 21);
    const noon = sunPosition(localToUtcMs(NY[2], 2030, 5, 21, t.noon), NY[0], NY[1]);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(1);
    expect(noon.altitude).toBeGreaterThan(72);
    const morning = sunPosition(localToUtcMs(NY[2], 2030, 5, 21, 8 * 3600), NY[0], NY[1]);
    expect(morning.morning).toBe(true);
    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(110);
    applyCity('nyc');
    expect(dateOfDay(0).toISOString().slice(0, 10)).toBe('2030-01-07');
    expect(gameSun(0, 5 * 3600).altitude).toBeLessThan(-12); // a new game starts in the dark
    expect(gameSun(0, 12 * 3600).altitude).toBeGreaterThan(20);
    const nyTimes = gameSunTimes(0);
    applyCity('london');
    try {
      const ldnTimes = gameSunTimes(0);
      // 8 am on 7 January: still twilight in London, already day in New York.
      expect(gameSun(0, 8 * 3600).altitude).toBeLessThan(0);
      expect(ldnTimes.sunrise).toBeGreaterThan(nyTimes.sunrise + 30 * 60);
      expect(ldnTimes.sunset).toBeLessThan(nyTimes.sunset);
    } finally {
      applyCity('nyc');
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('follow-cam maths', () => {
  const line = (pts: [number, number][], zs?: number[]): PathLike => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { xs: pts.map((p) => p[0]), ys: pts.map((p) => p[1]), zs: zs ?? pts.map(() => 0), cum };
  };

  it('heading from the path tangent; a lateral offset goes to the right of travel', () => {
    const north = line([[0, 0], [0, 1000]]);
    expect(headingAt(north, 500)).toBeCloseTo(0, 6);
    const east = line([[0, 0], [1000, 0]]);
    expect(headingAt(east, 500)).toBeCloseTo(90, 6);
    const west = line([[1000, 0], [0, 0]]);
    expect(headingAt(west, 10)).toBeCloseTo(270, 6);
    const p = poseOnPath(north, 500, 6);
    expect(p.x).toBeCloseTo(6, 6);
    expect(p.y).toBeCloseTo(500, 6);
    const q = poseOnPath(east, 500, -6);
    expect(q.y).toBeCloseTo(6, 6);
    // A quarter circle of radius 300 from heading north to heading east: 45° in the middle.
    const arc: [number, number][] = [];
    for (let k = 0; k <= 60; k++) {
      const t = (k / 60) * (Math.PI / 2);
      arc.push([300 - 300 * Math.cos(t), 300 * Math.sin(t)]);
    }
    const c = line(arc);
    expect(headingAt(c, c.cum[c.cum.length - 1] / 2)).toBeCloseTo(45, 1);
    // Ends clamp; height is never below ground.
    expect(poseOnPath(line([[0, 0], [0, 100]], [-25, -25]), 50).z).toBe(0);
    expect(poseOnPath(line([[0, 0], [0, 100]], [8, 8]), 500).y).toBeCloseTo(100, 6);
  });

  it('the chase centre moves ahead so that the point at track height is at the screen centre', () => {
    const pose = { x: 0, y: 0, z: 8, heading: 90 };
    const c = chaseCentre(pose, 45);
    expect(c.x).toBeCloseTo(8, 6);
    expect(c.y).toBeCloseTo(0, 6);
    expect(chaseCentre({ ...pose, z: 0 }, 72, 40).x).toBeCloseTo(40, 6);
    const c72 = chaseCentre(pose, 72);
    expect(c72.x).toBeCloseTo(8 * Math.tan((72 * Math.PI) / 180), 6);
  });

  it('zoom ⇄ chase distance are inverse and match the map’s metres per pixel', () => {
    for (const d of [90, 260, 2500]) {
      const z = zoomForDistance(d, 900, ORIGIN_LAT);
      expect(distanceForZoom(z, 900, ORIGIN_LAT)).toBeCloseTo(d, 6);
      expect(cameraToCenterPx(900) * metresPerPixel(z)).toBeCloseTo(d, 3);
    }
    expect(zoomForDistance(260, 900, ORIGIN_LAT)).toBeGreaterThan(zoomForDistance(520, 900, ORIGIN_LAT));
  });

  it('bearings ease over the shortest turn, across north', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
    const b = easeAngle(350, 10, 0.1, 0.7);
    expect(b > 350 || b < 10).toBe(true);
    expect(easeAngle(350, 10, 100, 0.7)).toBeCloseTo(10, 6);
    expect(easeAngle(NaN, 42, 0.1, 0.7)).toBe(42);
  });
});

// ------------------------------------------------------------------------------------------
function tlGame() {
  const game = new Game({} as World, dry, { sandbox: true, fare: 3 });
  const n = game.network;
  n.addStroke([P(0, 0), P(1200, 400), P(2600, 0)], 'heavy', none, none);
  const at = (x: number, y: number, name: string) => {
    const hit = pickEdge(n, x, y, 60);
    if (!hit) throw new Error('no track');
    return n.addStation(hit.edge, hit.u, 8, name).id;
  };
  const s = [at(100, 33, 'A'), at(600, 200, 'B'), at(2400, 57, 'C')];
  const b = game.build(true);
  if (!b.ok) throw new Error(b.reason);
  const r = game.routes.create({ name: 'Line', bullet: 'L', color: '#E8443A', cls: 'heavy', stops: s, cars: 8, headways: defaultHeadways() });
  return { game, stations: s, route: r };
}

describe('timelapse recording, bounds and encoding', () => {
  it('records the built network: edges with their status and drawing direction, stations, routes that run', () => {
    const { game } = tlGame();
    const f = game.recordTimelapse(18);
    expect(f.day).toBe(18);
    expect(f.edges.length).toBe([...game.network.edges.values()].filter((e) => e.status !== 'blueprint').length);
    expect(f.edges.every((e) => e.built)).toBe(true);
    expect(f.stations.map((s) => s.id)).toEqual([...game.network.stations.keys()].sort((a, b) => a - b));
    expect(f.routes).toEqual([{ shape: 0, running: true }]);
    const shape = game.timelapse.shapes[0];
    expect(shape).toMatchObject({ color: '#e8443a', bullet: 'L', express: false });
    expect(shape.legs.length).toBeGreaterThan(0);
    // Geometry is simplified but within the tolerance of the real track.
    for (const e of f.edges) {
      const g = game.network.geom(e.id);
      const pts = game.timelapse.edges.get(e.id)!.pts;
      expect(pts.length / 2).toBeLessThanOrEqual(g.xs.length);
      expect(Math.hypot(pts[0] - g.xs[0], pts[1] - g.ys[0])).toBeLessThan(1);
    }
    // Blueprints are not recorded; a second frame the same day replaces the first.
    game.network.addStroke([P(2600, 0), P(3600, -500)], 'heavy', { kind: 'node', node: [...game.network.nodes.values()].find((x) => Math.hypot(x.x - 2600, x.y) < 1)!.id }, none);
    game.recordTimelapse(18);
    expect(game.timelapse.frames.length).toBe(1);
    expect(game.timelapse.frames[0].edges.length).toBe(f.edges.length);
  });

  it('a four-track section keeps its pair push side', () => {
    const game = new Game({} as World, dry, { sandbox: true, fare: 3 });
    const q = addQuadStroke(game.network, [P(0, 0), P(3000, 0)], 'heavy', none, none, { side: 1 });
    expect(q.ok).toBe(true);
    game.build(true);
    game.recordTimelapse(1);
    const aways = [...game.timelapse.edges.values()].map((e) => e.away);
    expect(aways.some((a) => a === 1) && aways.some((a) => a === -1)).toBe(true);
  });

  it('encode → decode reproduces every frame, geometry and shape; malformed input decodes empty', () => {
    const { game, route } = tlGame();
    game.recordTimelapse(18);
    game.routes.update(route.id, { color: '#2F7FE0' });
    game.recordTimelapse(39);
    const tl = game.timelapse;
    const back = decodeTimelapse(JSON.parse(JSON.stringify(encodeTimelapse(tl))));
    expect(back.frames).toEqual(tl.frames);
    expect(back.shapes).toEqual(tl.shapes);
    expect([...back.edges.keys()]).toEqual([...tl.edges.keys()].sort((a, b) => a - b));
    for (const [id, e] of tl.edges) {
      expect([...back.edges.get(id)!.pts]).toEqual([...e.pts]);
      expect(back.edges.get(id)!.away).toBe(e.away);
    }
    expect(back.stations).toEqual(new Map([...tl.stations].sort((a, b) => a[0] - b[0])));
    for (const bad of [null, 5, {}, { v: 2, data: '', shapes: [] }, { v: 1, data: '!!!', shapes: [] }, { v: 1, data: encodeTimelapse(tl).data, shapes: [] }]) {
      expect(decodeTimelapse(bad).frames).toEqual([]);
    }
    expect(decodeVarints(encodeVarints([0, 1, 127, 128, 300, 2 ** 40]), 6)).toEqual([0, 1, 127, 128, 300, 2 ** 40]);
    expect(decodeVarints(encodeVarints([0, -1, 1, -64, 64, -(2 ** 33)], true), 6, true)).toEqual([0, -1, 1, -64, 64, -(2 ** 33)]);
  });

  it('is bounded: at most maxFrames (the smallest gaps go first, the ends stay), then a size cap; unused geometry is dropped', () => {
    const frames: TLFrame[] = Array.from({ length: 30 }, (_, i) => ({ day: i * 21 + (i % 3), edges: [], stations: [], routes: [] }));
    const first = frames[0].day, last = frames[29].day;
    thinFrames(frames, 10);
    expect(frames.length).toBe(10);
    expect(frames[0].day).toBe(first);
    expect(frames[9].day).toBe(last);
    const gaps = frames.slice(1).map((f, i) => f.day - frames[i].day);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(2.6);

    const { game } = tlGame();
    for (let m = 0; m < CINEMATIC.timelapseMaxFrames + 15; m++) game.recordTimelapse(m * 21);
    expect(game.timelapse.frames.length).toBe(CINEMATIC.timelapseMaxFrames);
    expect(game.timelapse.frames[0].day).toBe(0);
    const tl = game.timelapse;
    const size = encodedSize(tl);
    boundTimelapse(tl, CINEMATIC.timelapseMaxFrames, Math.floor(size / 3));
    expect(encodedSize(tl)).toBeLessThanOrEqual(Math.floor(size / 3));
    expect(tl.frames.length).toBeGreaterThanOrEqual(2);
    // An edge no frame refers to any more goes from the table.
    tl.edges.set(99999, { pts: new Int32Array([0, 0, 5, 5]), away: 0 });
    boundTimelapse(tl);
    expect(tl.edges.has(99999)).toBe(false);
  });

  it('a 10-year game of monthly frames on a large network stays well inside the save budget', () => {
    const tl = emptyTimelapse();
    const game = new Game({} as World, dry, { sandbox: true, fare: 3 });
    for (let m = 0; m < 120; m++) {
      // One more 2 km line every month (a 240 km network by the end).
      const y = m * 600;
      game.network.addStroke([P(0, y), P(1000, y + 50), P(2000, y)], 'heavy', none, none);
      game.build(true);
      recordFrame(tl, m * 22, game.network, game.routes);
    }
    expect(tl.frames.length).toBe(120);
    expect(encodedSize(tl)).toBeLessThan(CINEMATIC.timelapseMaxBytes);
  });

  it("the player's schedule: new edges draw outward from the old network; split old track is not new", () => {
    const { game } = tlGame();
    const f0 = game.recordTimelapse(18);
    const end = [...game.network.nodes.values()].find((x) => Math.hypot(x.x - 2600, x.y) < 1)!.id;
    game.network.addStroke([P(2600, 0), P(3600, -400), P(4800, -400)], 'heavy', { kind: 'node', node: end }, none);
    game.build(true);
    const f1 = recordFrame(game.timelapse, 39, game.network, game.routes);
    const fresh = newEdgeIds(game.timelapse, f0, f1);
    expect(fresh.length).toBeGreaterThan(0);
    const sched = drawSchedule(game.timelapse, f0, fresh);
    const slots = fresh.map((id) => sched.get(id)!);
    expect(Math.min(...slots.map((s) => s.t0))).toBe(0);
    expect(Math.max(...slots.map((s) => s.t1))).toBeCloseTo(1, 9);
    // The edge touching the old end starts first; the farthest finishes last.
    const touching = fresh.find((id) => {
      const pts = game.timelapse.edges.get(id)!.pts;
      const n = pts.length / 2;
      return Math.hypot(pts[0] - 2600, pts[1]) < 3 || Math.hypot(pts[2 * n - 2] - 2600, pts[2 * n - 1]) < 3;
    })!;
    expect(sched.get(touching)!.t0).toBe(0);
    // No new track: nothing to draw; the first frame draws everything from scratch.
    expect(newEdgeIds(game.timelapse, f1, f1)).toEqual([]);
    expect(newEdgeIds(game.timelapse, null, f0).length).toBe(f0.edges.length);
    const st = frameStats(game.timelapse, f1);
    expect(st.trackM).toBeGreaterThan(2600 + 2000);
    expect(st.stations).toBe(3);
  });

  it('point helpers: simplify keeps the ends and the shape; slices and samples', () => {
    const xs = [0, 10, 20, 30, 40], ys = [0, 0.2, 0, 15, 0];
    expect(simplify(xs, ys, 1)).toEqual([0, 2, 3, 4]);
    const pts = [0, 0, 100, 0, 100, 100];
    expect(slicePts(pts, 50, 150)).toEqual([[50, 0], [100, 0], [100, 50]]);
    expect(samplePts(pts, 40)).toEqual([[0, 0], [40, 0], [80, 0], [100, 20], [100, 60], [100, 100]]);
  });
});

// ------------------------------------------------------------------------------------------
describe('save v7', () => {
  it('migrates a v6 save to an empty timelapse, idempotently; older saves too', () => {
    const { game } = tlGame();
    const save = JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: null })));
    save.version = 6;
    delete save.game.timelapse;
    const m = migrate(save);
    expect(SAVE_VERSION).toBe(7);
    expect(m.version).toBe(7);
    expect(m.migratedFrom).toBe(6);
    expect(decodeTimelapse(m.game.timelapse).frames).toEqual([]);
    const again = migrate(JSON.parse(JSON.stringify({ ...m, version: 6, migratedFrom: undefined })));
    expect(again.game.timelapse).toEqual(m.game.timelapse);
    const back = new Game({} as World, dry, { sandbox: true, fare: 3 });
    applySave(back, m);
    expect(back.timelapse.frames).toEqual([]);
  });

  it("a save round-trips the game's timelapse", () => {
    const { game } = tlGame();
    game.recordTimelapse(18);
    game.recordTimelapse(39);
    const save = migrate(JSON.parse(JSON.stringify(buildSave(game, { name: 't', goals: {} as never, lastReport: null, tutorialDone: true, settings, modeState: null }))));
    expect(save.migratedFrom).toBeUndefined();
    const back = new Game({} as World, dry, { sandbox: true, fare: 3 });
    applySave(back, save);
    expect(back.timelapse.frames).toEqual(game.timelapse.frames);
    expect(back.timelapse.shapes).toEqual(game.timelapse.shapes);
    expect(monthKey(back.timelapse.frames[0].day)).toBe('2030-01');
    // Malformed: an empty timelapse, the rest of the save loads.
    const broken = JSON.parse(JSON.stringify(save));
    broken.game.timelapse = { v: 1, data: 'AAAA', shapes: [[1]] };
    const b2 = new Game({} as World, dry, { sandbox: true, fare: 3 });
    applySave(b2, broken);
    expect(b2.timelapse.frames).toEqual([]);
    expect(b2.network.edges.size).toBe(game.network.edges.size);
  });
});
