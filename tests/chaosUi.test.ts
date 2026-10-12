/**
 * City chaos on the main thread (no DOM): the alert feed behind the ticker, the Service alerts
 * panel and the map markers, in both cities and both unit systems.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CHAOS } from '../src/balance';
import { applyCity } from '../src/cities';
import { announcedEvents, eventsForDay, MAX_VENUES, weatherForDay } from '../src/core/cityCalendar';
import { Game } from '../src/core/game';
import { fmtMoney, setUnits } from '../src/core/units';
import type { Terrain } from '../src/construction/validate';
import type { World } from '../src/data/world';
import type { Alert, CompiledNetwork, DayChaosInfo, EventOutcome } from '../src/sim/protocol';
import { AlertFeed, describeAlert, eventWhen, nextDayWord, outcomeText, plainDetail, RECENT, wrapUpToasts, type RouteRef } from '../src/ui/alertFeed';

const D = 86400;
const H = 3600;
const routes: Record<number, RouteRef> = { 1: { id: 1, bullet: 'A', color: '#00f', name: '8 Av' }, 2: { id: 2, bullet: 'C', color: '#00f', name: 'CPW' } };
const ref = (id: number) => routes[id];

function game(level = CHAOS.defaultLevel, seed = 7): Game {
  return new Game({} as World, {} as Terrain, { sandbox: true, fare: 3, chaos: level, chaosSeed: seed });
}

function alert(over: Partial<Alert>): Alert {
  return { id: 1001, kind: 'signal', status: 'active', day: 1, start: D + 8 * H, until: D + 8.5 * H, severity: 2, place: '34 St', routes: [1, 2], ...over };
}

afterAll(() => {
  applyCity('nyc');
  setUnits('imperial');
});

describe('alert text', () => {
  it('composes titles and details in the player’s units', () => {
    applyCity('nyc');
    setUnits('imperial');
    const sig = describeAlert(alert({ crawl: 15 / 3.6, towards: 'Atlantic Av' }), ref);
    expect(sig.title).toBe('Signal problem near 34 St');
    expect(sig.detail).toBe('trains crawl at 9 mph towards Atlantic Av');
    expect(sig.when).toBe('until 08:30');
    expect(sig.tone).toBe('amber');
    expect(plainDetail(sig)).toBe('A C trains crawl at 9 mph towards Atlantic Av');
    setUnits('metric');
    expect(describeAlert(alert({ crawl: 15 / 3.6 }), ref).detail).toBe('trains crawl at 15 km/h');
    const brk = describeAlert(alert({ kind: 'breakdown', severity: 3, place: 'between Marcy Av and Flushing Av', routes: [2], trainId: 4 }), ref);
    expect(brk.title).toBe('Train breakdown between Marcy Av and Flushing Av');
    expect(brk.tone).toBe('red');
    expect(brk.when).toBe('~08:30');
    const cleared = describeAlert(alert({ kind: 'police', severity: 3, status: 'cleared', until: D + 8 * H + 31 * 60, stationId: 9 }), ref);
    expect(cleared.title).toBe('Police activity at 34 St');
    expect(cleared.when).toBe('cleared after 31 min');
    expect(cleared.tone).toBe('green');
    expect(describeAlert(alert({ status: 'cleared', reason: 'track removed' }), ref).when).toBe('ended: track removed');
    const snow = describeAlert(alert({ id: 1000, kind: 'weather', status: 'info', severity: 1, routes: [], weather: { kind: 'snow', severity: 1, carried: false } }), ref);
    expect(snow.title).toBe('Heavy snow');
    expect(snow.detail).toContain('elevated and street-level trains ≤ 50 km/h');
    expect(snow.detail).toContain('walking 25% slower');
    expect(snow.detail).toContain('driving 40% slower');
    setUnits('imperial');
    expect(describeAlert(alert({ id: 1000, kind: 'weather', status: 'info', weather: { kind: 'snow', severity: 1, carried: false } }), ref).detail).toContain('≤ 31 mph');
  });

  it('says "Mon" rather than "Tomorrow" across a weekend', () => {
    // Day 4 is Friday 11 Jan 2030; day 5 is Monday.
    expect(nextDayWord(3)).toBe('Tomorrow');
    expect(nextDayWord(4)).toBe('Mon');
    expect(eventWhen({ day: 4, start: 20 * H }, 3)).toBe('Tomorrow 20:00');
    expect(eventWhen({ day: 5, start: 20 * H }, 4)).toBe('Mon 14 Jan 20:00');
    expect(eventWhen({ day: 4, start: 20 * H }, 4)).toBe('Tonight 20:00');
    expect(eventWhen({ day: 4, start: 11 * H }, 4)).toBe('Today 11:00');
  });
});

describe('alert feed', () => {
  it('tracks active incidents, closed stations and alerted trains through their life cycle', () => {
    applyCity('nyc');
    const feed = new AlertFeed(game());
    feed.rollDay(1, D + 6 * H);
    expect(feed.upsert(alert({ id: 1001, kind: 'police', severity: 3, stationId: 9 }))).toBe('new');
    feed.upsert(alert({ id: 1002, kind: 'breakdown', severity: 3, trainId: 4, start: D + 8.2 * H }));
    feed.upsert(alert({ id: 1003, kind: 'signal', start: D + 8.4 * H }));
    expect(feed.activeCount()).toBe(3);
    // Most severe first, then newest.
    expect(feed.active().map((a) => a.id)).toEqual([1002, 1001, 1003]);
    expect([...feed.closedStations()]).toEqual([9]);
    expect([...feed.alertedTrains()]).toEqual([4]);
    expect(feed.activeFor({ stationId: 9 })?.id).toBe(1001);
    expect(feed.activeFor({ trainId: 4 })?.id).toBe(1002);
    expect(feed.activeOnRoute(2).length).toBe(3);
    const v = feed.version;
    expect(feed.upsert(alert({ id: 1001, kind: 'police', severity: 3, stationId: 9, status: 'cleared', until: D + 8.6 * H }))).toBe('update');
    expect(feed.version).toBeGreaterThan(v);
    expect(feed.closedStations().size).toBe(0);
    expect(feed.earlier(D + 9 * H).map((a) => a.id)).toEqual([1001]);
  });

  it('orders the ticker: incidents, today’s events, weather, forecast, announcements, then recent news', () => {
    applyCity('nyc');
    const g = game('normal', 11);
    const feed = new AlertFeed(g);
    // A day with an event today and one announced.
    let day = -1;
    for (let d = 1; d < 400 && day < 0; d++) if (eventsForDay(11, d, 'normal').length && announcedEvents(11, d, 'normal').some((e) => e.day > d)) day = d;
    expect(day).toBeGreaterThan(0);
    const now = day * D + 9 * H;
    feed.rollDay(day, now);
    const today = eventsForDay(11, day, 'normal');
    const info: DayChaosInfo = {
      day,
      level: 'normal',
      weather: { kind: 'rain', severity: 0.9, carried: false },
      mods: { walkSpeed: 1, walkPenalty: 0, driveSpeed: 1, outdoorSpeed: 1, dwell: 1, crowd: 1 },
      events: today.map((e) => ({ id: e.id, label: e.label, venue: e.venue, attendance: e.attendance, start: e.start, end: e.end, byTransit: 9400, byDrive: 5000, byWalk: 1000, overflow: 0 })),
    };
    feed.setInfo(info);
    feed.upsert(alert({ id: day * 1000 + 1, day, start: now - 600, until: now + 1800 }));
    feed.upsert(alert({ id: day * 1000 + 2, day, kind: 'sick', severity: 1, start: now - 3000, status: 'cleared', until: now - 1200, trainId: 3 }));
    const items = feed.tickerItems(now, ref);
    const kinds = items.map((i) => i.key[0]);
    expect(kinds[0]).toBe('a');
    expect(items[0].tone).toBe('amber');
    expect(kinds.indexOf('e')).toBeGreaterThan(0);
    expect(kinds.indexOf('w')).toBeGreaterThan(kinds.indexOf('e'));
    expect(kinds.indexOf('n')).toBeGreaterThan(kinds.indexOf('w'));
    expect(items[items.length - 1].tone).toBe('green');
    expect(items.find((i) => i.key[0] === 'e')!.text).toContain('~9.4k by subway');
    expect(items.find((i) => i.key === 'w')!.text).toMatch(/^Heavy rain: walking 7% slower/);
    expect(items.length).toBeLessThanOrEqual(10);
    // The cleared item drops off after 90 game minutes; nothing shows when chaos is off.
    expect(feed.tickerItems(now + RECENT, ref).some((i) => i.key === `a${day * 1000 + 2}`)).toBe(false);
    g.chaos.level = 'off';
    feed.setInfo({ ...info, level: 'off', events: [] });
    expect(feed.off).toBe(true);
    expect(feed.tickerItems(now, ref)).toEqual([]);
  });

  it('announces events only as they enter the window, not on the first roll', () => {
    applyCity('nyc');
    const feed = new AlertFeed(game('wild', 3));
    expect(feed.rollDay(10, 10 * D)).toEqual([]);
    let fresh: { day: number }[] = [];
    for (let d = 11; d < 60 && !fresh.length; d++) fresh = feed.rollDay(d, d * D);
    expect(fresh.length).toBeGreaterThan(0);
    // Already-seen events are not announced again.
    const d = feed.day;
    expect(feed.rollDay(d, d * D + 60)).toEqual([]);
  });
});

describe('event service and wrap-ups', () => {
  it('cancels only service whose event a level change took off the calendar', () => {
    applyCity('nyc');
    const seed = 3;
    // A day whose announced events at Wild include one that Calm doesn't have.
    let day = 1;
    const ids = (lv: 'wild' | 'calm', d: number) => announcedEvents(seed, d, lv).filter((e) => e.day > d).map((e) => e.id);
    while (!ids('wild', day).some((id) => !ids('calm', day).includes(id))) day++;
    const g = game('wild', seed);
    const feed = new AlertFeed(g);
    feed.rollDay(day, day * D + 10 * H);
    const gone = ids('wild', day).find((id) => !ids('calm', day).includes(id))!;
    const stays = ids('calm', day)[0];
    const svc = (eventId: number, from: number) => g.addService({ routeId: 1, from, to: from + 2 * H, headwayMin: 3, eventId });
    const a = svc(gone, day * D + 20 * H);
    if (stays !== undefined) svc(stays, day * D + 20 * H);
    // Service for yesterday's event, still running after midnight, is left alone.
    svc((day - 1) * MAX_VENUES + 2, day * D - H);
    expect(feed.orphanService(g.chaos.service)).toEqual([]);
    g.setChaosLevel('calm');
    expect(feed.orphanService(g.chaos.service)).toEqual([a]);
  });

  it("shows today at today's level after a mid-day load, before the worker's 3 am info comes in", () => {
    applyCity('nyc');
    const seed = 2030;
    // A day whose weather or events differ between Wild and Off (Off: clear, none).
    let day = 1;
    while (weatherForDay(seed, day, 'wild').kind === 'clear' && !eventsForDay(seed, day, 'wild').length) day++;
    const g = game('wild', seed);
    g.setChaosLevel('off');
    // Loaded at 10:00: Wild today (as the worker planned it at 3 am), Off from the next 3 am.
    g.time = day * D + 10 * H;
    const feed = new AlertFeed(g);
    feed.rollDay(day, g.time);
    expect(feed.levels()).toEqual({ today: 'wild', next: 'off' });
    expect(feed.off).toBe(false);
    expect(feed.weather()).toEqual(weatherForDay(seed, day, 'wild'));
    expect(feed.events().filter((e) => e.day === day).map((e) => e.id)).toEqual(eventsForDay(seed, day, 'wild').map((e) => e.id));
    // Before 3 am the calendar follows the level 3 am will apply.
    g.time = day * D + 1 * H;
    expect(feed.weather()).toEqual(weatherForDay(seed, day, 'off'));
    expect(feed.events().filter((e) => e.day === day)).toEqual([]);
  });

  it('toasts a wrap-up only where fans could come by train', () => {
    applyCity('nyc');
    const out = (byTransit: number): EventOutcome => ({ id: 18, label: 'Midtown arena game', attendance: 19_400, byTransit, arrived: byTransit, late: 0, gaveUp: 0, avgTripMin: 40 });
    const wrap = (byTransit: number) => alert({ id: 1900, kind: 'event', status: 'info', severity: 1, routes: [], eventId: 18, pos: [0, 0], outcome: out(byTransit) });
    const net = (x: number) => ({ version: 1, stations: [{ id: 5, x, y: 0, name: '34 St', group: 0 }], routes: [], trackCount: 0, lockCount: 0 }) as unknown as CompiledNetwork;
    expect(wrapUpToasts(wrap(7320), null)).toBe(true);
    // Nobody came: toast only if a station is within the access walk (the player can do something).
    expect(wrapUpToasts(wrap(0), net(900))).toBe(true);
    expect(wrapUpToasts(wrap(0), net(6600))).toBe(false);
    expect(wrapUpToasts(wrap(0), null)).toBe(false);
    expect(wrapUpToasts(alert({}), net(0))).toBe(false);
  });
});

describe('London', () => {
  it('shows London venues, metro wording and pounds', () => {
    applyCity('london');
    const g = game('wild', 21);
    const feed = new AlertFeed(g);
    feed.rollDay(0, 6 * H);
    const labels = new Set<string>();
    for (let d = 0; d < 260; d++) for (const e of eventsForDay(21, d, 'wild')) labels.add(e.label);
    expect(labels.has('Greenwich arena concert')).toBe(true);
    expect([...labels].some((l) => /Midtown|Brooklyn|Bronx/.test(l))).toBe(false);
    const ev = eventsForDay(21, [...Array(260).keys()].find((d) => eventsForDay(21, d, 'wild').length)!, 'wild')[0];
    feed.upsert({
      id: ev.day * 1000 + 900,
      kind: 'event',
      status: 'info',
      day: ev.day,
      start: ev.day * D + ev.end + 2 * H,
      until: ev.day * D + ev.end + 2 * H,
      severity: 1,
      place: 'Greenwich peninsula arena',
      routes: [],
      eventId: ev.id,
      outcome: { id: ev.id, label: ev.label, attendance: ev.attendance, byTransit: 9420, arrived: 9000, late: 610, gaveUp: 120, avgTripMin: 40 },
    });
    const t = describeAlert(feed.get(ev.day * 1000 + 900)!, ref);
    expect(t.detail).toBe('9,420 came by metro · 610 arrived late · 120 gave up');
    // An event no station reaches: nobody came by train (not "0 came by metro").
    expect(outcomeText({ id: ev.id, label: ev.label, attendance: ev.attendance, byTransit: 0, arrived: 0, late: 0, gaveUp: 0, avgTripMin: 0 })).toBe('No fans came by metro');
    expect(fmtMoney(12_000)).toBe('£12k');
    applyCity('nyc');
    expect(fmtMoney(12_000)).toBe('$12k');
  });
});
