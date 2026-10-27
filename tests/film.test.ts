import { describe, expect, it } from 'vitest';
import { filmAt, filmFileName, filmSize, planFilm, VIDEO } from '../src/cinematic/timelapseExport';

describe('timelapse video', () => {
  it('fits the map inside 1080p with even sides, never upscaling', () => {
    expect(filmSize(2880, 1800)).toEqual({ width: 1728, height: 1080 });
    expect(filmSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(filmSize(1366, 768)).toEqual({ width: 1366, height: 768 });
    expect(filmSize(1001, 601)).toEqual({ width: 1000, height: 600 });
    // A tall phone canvas keeps its shape.
    const p = filmSize(1170, 2532);
    expect(p.height).toBe(1080);
    expect(p.width % 2).toBe(0);
  });

  it('plays short games at 1× and squeezes long ones under the cap', () => {
    const short = planFilm(12, 1920, 1080);
    expect(short.speed).toBe(1);
    expect(short.seconds).toBeCloseTo(VIDEO.intro + 12 + VIDEO.hold + VIDEO.end);
    expect(short.frames).toBe(Math.ceil(short.seconds * VIDEO.fps));
    const long = planFilm(132, 1920, 1080);
    expect(long.speed).toBeCloseTo(132 / VIDEO.maxReplay);
    expect(long.seconds).toBeCloseTo(VIDEO.intro + VIDEO.maxReplay + VIDEO.hold + VIDEO.end);
  });

  it('walks intro → replay → hold → end card', () => {
    const d = 100, speed = 2;
    expect(filmAt(0, d, speed)).toMatchObject({ part: 'intro', t: 0 });
    expect(filmAt(VIDEO.intro + 10, d, speed)).toMatchObject({ part: 'replay', t: 20 });
    expect(filmAt(VIDEO.intro + 50 + 1, d, speed)).toMatchObject({ part: 'hold', t: d });
    expect(filmAt(VIDEO.intro + 50 + VIDEO.hold + 1, d, speed)).toMatchObject({ part: 'end', t: d });
  });

  it('names the file after the company', () => {
    expect(filmFileName('Thames Valley Rapid Transit')).toBe('thames-valley-rapid-transit-timelapse.mp4');
    expect(filmFileName('Café & Crème Railways!')).toBe('cafe-creme-railways-timelapse.mp4');
    expect(filmFileName('   ')).toBe('headway-timelapse.mp4');
  });
});
