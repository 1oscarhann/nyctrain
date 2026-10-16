/**
 * Living City on the main thread (no DOM): the wording, currency, units and numbers of the
 * toasts, the month report's City section, the tract, station and finance panels, the goals and
 * the year in review; the growth overlay's ramp and columns; tract names (map labels, stations,
 * the formal fallback) — in both cities.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { GROWTH, MAP, TIME } from '../src/balance';
import { applyCity } from '../src/cities';
import { isNewMonth } from '../src/core/calendar';
import { setUnits } from '../src/core/units';
import { columnHeight, columnRadiusClass, GROWTH_RAMP_SPAN, growthLegendEnds, growthSpan, growthT, tractGrowthSince, tractPeopleAdded } from '../src/map/growthMath';
import { placeClasses, tractPlaceClasses } from '../src/map/naming';
import { formalTractName, PlaceIndex, TRACT_NAME_RADIUS, tractName, tractNameRadius } from '../src/map/placeNames';
import type { Boomtown, GrowthMonth, GrowthView, TractGrowth } from '../src/sim/protocol';
import { loadWorldFromDisk } from '../scripts/nodeData';
import {
  boomtownLine,
  boomtownToast,
  captureWords,
  cityRows,
  districtWord,
  distinctNames,
  fmtSignedCount,
  fmtSignedPct,
  growthGoalProgress,
  growthHoverText,
  growthToasts,
  indexSeries,
  milestoneToast,
  monthAfterStart,
  sandboxMonthBody,
  sinceStart,
  startDateText,
  startMonth,
  stationValueCaptureText,
  stationValueCaptureTip,
  tractGrowthSentence,
  tractPanelTitle,
  tractValueCaptureLine,
  valueCaptureHeading,
  valueCaptureSection,
  yearCityLine,
} from '../src/ui/livingCity';

afterAll(() => applyCity('nyc'));

/** The game days whose following midnight closes a month: [0] is 31 Jan 2030, [12] 31 Jan 2031. */
const MONTH_ENDS: number[] = [];
for (let d = 0; MONTH_ENDS.length < 30; d++) if (isNewMonth(d + 1)) MONTH_ENDS.push(d);
afterEach(() => setUnits('imperial'));

const boom = (over: Partial<Boomtown> = {}): Boomtown => ({ tract: 7, rate: 0.006, dRes: 41.2, dJobs: 12.4, sinceStart: 0.048, ...over });

function month(over: Partial<GrowthMonth> = {}): GrowthMonth {
  return {
    day: 18,
    label: 'Jan 2030',
    pace: 'steady',
    residents: 2_856_054,
    jobs: 2_856_054,
    dResidents: 2_860,
    dJobs: 2_860,
    agents: 285_544,
    commuters: 2_855_440,
    valueCapture: 421_559,
    districtTracts: 211,
    districtIncrement: 1.73e9,
    stationLevy: { 3: 40_000 },
    benefitMean: 7.9,
    boomtowns: [boom({ tract: 1 }), boom({ tract: 2, rate: 0.005 })],
    milestones: [],
    maxTractGrowth: 0.048,
    ...over,
  };
}

function tg(over: Partial<TractGrowth> = {}): TractGrowth {
  return {
    residents0: 1500,
    jobs0: 120,
    residents: 1530,
    jobs: 121,
    history: [],
    benefitHome: 23.4,
    benefitWork: 3,
    cityBenefit: 9.2,
    projectedRateRes: 0.004,
    projectedRateJobs: 0.002,
    premium: 0.012,
    inDistrict: true,
    districtShare: 1,
    nearestStation: 3,
    levy: 41_000,
    ...over,
  };
}

describe('Living City text (New York)', () => {
  it('says since the start year, with a real minus sign and signed counts', () => {
    applyCity('nyc');
    expect(sinceStart()).toBe(`since ${TIME.startDate.year}`);
    expect(startMonth()).toBe('Jan 2030');
    expect(startDateText()).toBe('7 Jan 2030');
    expect(fmtSignedPct(0.062)).toBe('+6.2%');
    expect(fmtSignedPct(-0.01)).toBe('−1.0%');
    expect(fmtSignedPct(0.0001)).toBe('0.0%');
    expect(fmtSignedPct(0.0043, 2)).toBe('+0.43%');
    expect(fmtSignedCount(41.4)).toBe('+41');
    expect(fmtSignedCount(-12_345)).toBe('−12k');
    expect(fmtSignedCount(0.3)).toBe('0');
  });

  it('gives the district radius in the player’s units', () => {
    applyCity('nyc');
    setUnits('imperial');
    expect(districtWord()).toBe('½ mi');
    setUnits('metric');
    expect(districtWord()).toBe('800 m');
  });

  it('builds the boomtown toast, leaving out a count that rounds to nothing', () => {
    applyCity('nyc');
    const t = boomtownToast(boom(), 'Long Island City');
    expect(t).toEqual({ kind: 'boom', tract: 7, title: 'Long Island City is booming', body: '+0.6% this month · +41 residents, +12 jobs · +4.8% since 2030', tone: 'green' });
    expect(boomtownToast(boom({ dJobs: 0.17, dRes: 7, rate: 0.0043, sinceStart: 0.0043 }), 'around Inwood')).toMatchObject({ title: 'Around Inwood is booming', body: '+0.4% this month · +7 residents · +0.4% since 2030' });
    expect(boomtownToast(boom({ dJobs: 1.2, dRes: 77 }), 'Bow').body).toBe('+0.6% this month · +77 residents, +1 job · +4.8% since 2030');
  });

  it('builds milestone toasts for growth (green) and decline (amber)', () => {
    applyCity('nyc');
    expect(milestoneToast({ tract: 4, pct: 0.1 }, 'Astoria')).toMatchObject({ title: 'Astoria has grown 10% since 2030', tone: 'green' });
    expect(milestoneToast({ tract: 5, pct: -0.05 }, 'Mott Haven')).toMatchObject({ title: 'Mott Haven is losing people', body: '−5% since 2030 · no good transit', tone: 'amber' });
  });

  it('picks at most three toasts: the top boomtown when it grew enough, then milestones, each tract once', () => {
    applyCity('nyc');
    const name = (i: number) => `T${i}`;
    const ms = [
      { tract: 1, pct: 0.1 },
      { tract: 8, pct: 0.25 },
      { tract: 9, pct: -0.05 },
      { tract: 10, pct: 0.1 },
    ];
    const all = growthToasts(month({ milestones: ms }), name);
    expect(all.map((t) => t.tract)).toEqual([1, 8, 9]);
    expect(all[0].title).toBe('T1 is booming');
    // A quiet month: no boomtown toast, milestones only.
    const quiet = growthToasts(month({ boomtowns: [boom({ tract: 1, rate: GROWTH.boomToastMonthlyRate * 0.9 })], milestones: ms.slice(0, 2) }), name);
    expect(quiet.map((t) => t.title)).toEqual(['T1 has grown 10% since 2030', 'T8 has grown 25% since 2030']);
    expect(growthToasts(month({ boomtowns: [], milestones: [] }), name)).toEqual([]);
    // Single-digit gains are no news, however fast the rate: +7 residents in a tract of 1,600.
    expect(growthToasts(month({ boomtowns: [boom({ tract: 1, rate: 0.0043, dRes: 7, dJobs: 0.2 })] }), name)).toEqual([]);
    expect(growthToasts(month({ boomtowns: [boom({ tract: 1, dRes: GROWTH.boomToastMinPeople - 5, dJobs: 5 })] }), name).map((t) => t.kind)).toEqual(['boom']);
    // The tract the last boomtown toast named is not toasted again (its milestones still are).
    expect(growthToasts(month(), name, 1)).toEqual([]);
    expect(growthToasts(month({ milestones: [{ tract: 1, pct: 0.1 }] }), name, 1).map((t) => [t.kind, t.title])).toEqual([['milestone', 'T1 has grown 10% since 2030']]);
    expect(growthToasts(month(), name, 2).map((t) => t.title)).toEqual(['T1 is booming']);
  });

  it('fills the month report’s City rows in dollars and census tracts', () => {
    applyCity('nyc');
    const rows = cityRows(month());
    expect(rows.map((r) => r[0])).toEqual(['Residents', 'Jobs', 'Commuters now', 'Value-capture district']);
    expect(rows[0][1]).toBe('2.86M (+2,860, +0.10%)');
    expect(rows[0][2]).toBe('hw-green');
    expect(rows[2][1]).toBe('2.86M (285,544 agents)');
    expect(rows[3][1]).toBe('211 census tracts · $1.73B of new value');
    expect(cityRows(month({ dResidents: -50 }))[0][2]).toBe('hw-red');
    expect(boomtownLine(boom())).toBe('+0.60%/mo · +4.8% since 2030');
    expect(sandboxMonthBody(1_350_000, month())).toBe('1.35M riders a day · +2,860 residents');
    expect(sandboxMonthBody(1_350_000, null)).toBe('1.35M riders a day');
  });

  it('makes repeated boomtown names distinct with the formal name', () => {
    const names: Record<number, string> = { 1: 'around Inwood', 2: 'around Inwood', 3: 'Astoria', 4: 'Queens tract 57' };
    const out = distinctNames([1, 2, 3, 4], (i) => names[i], (i) => (i === 4 ? 'Queens tract 57' : `Manhattan tract ${i}`));
    expect(out).toEqual([
      { name: 'around Inwood', detail: 'Manhattan tract 1' },
      { name: 'around Inwood', detail: 'Manhattan tract 2' },
      { name: 'Astoria', detail: null },
      { name: 'Queens tract 57', detail: null },
    ]);
  });

  it('writes the tract panel’s growth sentence and value-capture line', () => {
    applyCity('nyc');
    expect(tractGrowthSentence(tg({ projectedRateJobs: 0.004 }), 'steady')).toBe('Growing 0.40% a month. Residents here save 23 min per commute with your network (city average 9 min).');
    expect(tractGrowthSentence(tg({ projectedRateRes: -0.003, projectedRateJobs: -0.003, benefitHome: 0.1 }), 'steady')).toBe('Shrinking 0.30% a month. Residents here gain little from your network (city average 9 min).');
    expect(tractGrowthSentence(tg({ projectedRateRes: 0, projectedRateJobs: 0 }), 'steady')).toMatch(/^Holding steady\./);
    expect(tractGrowthSentence(tg(), 'off')).toMatch(/^City growth is off \(Menu → City growth\)\./);
    // A job centre also names the time saved by the people working there.
    expect(tractGrowthSentence(tg({ residents0: 100, jobs0: 40_000, residents: 100, jobs: 40_400, benefitWork: 27.2 }), 'steady')).toMatch(/People working here save 27 min\.$/);
    expect(tractValueCaptureLine(tg(), 'steady')).toBe('In the value-capture district · $41k/month to the authority');
    expect(tractValueCaptureLine(tg({ districtShare: 0.83, levy: 1113 }), 'steady')).toBe('In the value-capture district (83% of its area) · $1,113/month to the authority');
    expect(tractValueCaptureLine(tg({ inDistrict: false }), 'steady')).toBe('Outside the district: no served station within ½ mi');
    expect(tractValueCaptureLine(tg(), 'off')).toMatch(/nothing is collected while city growth is off$/);
    // Before the first month end there is no increment yet: not "$0/month", but when it starts.
    expect(tractValueCaptureLine(tg({ districtShare: 0.83, levy: 0 }), 'steady', 'Jan 2030')).toBe('In the value-capture district (83% of its area) · first payment at the end of Jan 2030');
    expect(tractValueCaptureLine(tg({ levy: 0.2, history: [{ day: 18, residents: 1500, jobs: 120 }] }), 'steady', 'Feb 2030')).toBe('In the value-capture district · no rise in value to tax yet');
    setUnits('metric');
    expect(tractValueCaptureLine(tg({ inDistrict: false }), 'steady')).toBe('Outside the district: no served station within 800 m');
  });

  it('titles the tract panel with its toast name and keeps the formal name below', () => {
    expect(tractPanelTitle('around Inwood', 'Manhattan tract 307', 'Census tract', '36061030700', 'Manhattan')).toEqual({ title: 'Around Inwood', sub: 'Manhattan tract 307 · Census tract 36061030700' });
    expect(tractPanelTitle('Manhattan tract 307', 'Manhattan tract 307', 'Census tract', '36061030700', 'Manhattan')).toEqual({ title: 'Manhattan tract 307', sub: 'Census tract 36061030700 · Manhattan' });
  });

  it('labels the index chart from the start, one point per month end', () => {
    applyCity('nyc');
    const [jan, feb] = MONTH_ENDS;
    const s = indexSeries({ residents0: 1000, jobs0: 0, history: [{ day: jan, residents: 1004, jobs: 0 }, { day: feb, residents: 1010, jobs: 0 }] });
    expect(s.labels).toEqual(['Start', 'Jan 2030', 'Feb 2030']);
    expect(s.res[0]).toBe(100);
    expect(s.res[2]).toBeCloseTo(101, 9);
    expect(s.jobs).toEqual([null, null, null]);
    expect(s.xs).toEqual([0, 1, 2]);
    // A month with growth Off stores no snapshot: the axis keeps its place (Mar → May is two months).
    const mar = MONTH_ENDS[2], may = MONTH_ENDS[4];
    const t = indexSeries({ residents0: 1000, jobs0: 500, history: [jan, feb, mar, may].map((day, k) => ({ day, residents: 1000 + k, jobs: 500 })) });
    expect(t.xs).toEqual([0, 1, 2, 3, 5]);
    expect(t.labels).toEqual(['Start', 'Jan 2030', 'Feb 2030', 'Mar 2030', 'May 2030']);
    expect([0, 1, 4, 5, 13].map(t.label)).toEqual(['Start', 'Jan 2030', 'Apr 2030', 'May 2030', 'Jan 2031']);
    expect(monthAfterStart(-1)).toBe('Dec 2029');
  });

  it('writes the station panel and finance value-capture lines', () => {
    applyCity('nyc');
    expect(stationValueCaptureText(400_000, 6)).toBe('$400k/month · 6 tracts');
    expect(stationValueCaptureText(38_775, 1)).toBe('$39k/month · 1 tract');
    expect(stationValueCaptureTip()).toBe('12% of the extra property tax from the tracts nearest this station, paid at each month end');
    expect(valueCaptureHeading()).toBe('Value capture (Transit Improvement District)');
    expect(captureWords()).toBe('12% of the extra property tax');
    const v = { district: new Uint8Array([1, 0, 1, 1]), projectedValueCapture: 1.8e6 } as unknown as GrowthView;
    expect(valueCaptureSection(v, 403_000, 'steady')).toEqual({
      body: '3 tracts within ½ mi of a served station. 12% of the extra property tax from rising land values is paid to the authority at each month end.',
      last: 'Last month: $403k · projected this month: $1.8M',
    });
    expect(valueCaptureSection(null, null, 'steady').last).toBe('Last month: — · projected this month: …');
    expect(valueCaptureSection(v, 0, 'off').last).toBe('Last month: $0 · city growth is off');
    expect(growthHoverText(0.062)).toBe('+6.2% since 2030 · click for details');
  });

  it('reports goal progress', () => {
    applyCity('nyc');
    const name = (i: number) => (i === 3 ? 'Astoria' : '?');
    expect(growthGoalProgress('boomtown', { tract: 3, growth: 0.044 }, 0, 'steady', name)).toBe('Best so far: Astoria +4.4%');
    expect(growthGoalProgress('boomtown', null, 0, 'steady', name)).toBeNull();
    expect(growthGoalProgress('value-capture', null, 7.7e6, 'boom', name)).toBe('Best month so far: $7.7M');
    expect(growthGoalProgress('value-capture', null, 0, 'off', name)).toBe('City growth is off (Menu → City growth).');
  });

  it('sums the year in review’s City line against the start, then the year before', () => {
    applyCity('nyc');
    const city = [
      { day: MONTH_ENDS[0], residents: 2_856_000, jobs: 2_856_000, valueCapture: 4e5 },
      { day: MONTH_ENDS[1], residents: 2_859_000, jobs: 2_859_000, valueCapture: 8e5 },
      { day: MONTH_ENDS[12], residents: 2_880_000, jobs: 2_881_000, valueCapture: 9e6 },
    ];
    const totals = { residents: 2_853_194, jobs: 2_853_194 };
    expect(yearCityLine({ city }, 2030, 2030, totals)).toBe('Residents 2.86M (+5,806, +0.20%) · jobs 2.86M (+5,806) · 2 growth months');
    expect(yearCityLine({ city }, 2031, 2030, totals)).toBe('Residents 2.88M (+21k, +0.73%) · jobs 2.88M (+22k) · 1 growth month');
    expect(yearCityLine({ city }, 2032, 2030, totals)).toBeNull();
    expect(yearCityLine(null, 2030, 2030, totals)).toBeNull();
  });
});

describe('Living City text (London)', () => {
  it('uses pounds, neighbourhood areas and business rates', () => {
    applyCity('london');
    expect(sinceStart()).toBe(`since ${TIME.startDate.year}`);
    expect(captureWords()).toBe('14% of the extra business rates and council tax');
    expect(cityRows(month({ districtTracts: 40, districtIncrement: 2.5e9 }))[3][1]).toBe('40 neighbourhood areas · £2.50B of new value');
    expect(stationValueCaptureText(250_000, 2)).toBe('£250k/month · 2 areas');
    expect(stationValueCaptureText(25_000, 1)).toBe('£25k/month · 1 area');
    expect(stationValueCaptureTip()).toMatch(/from the areas nearest this station/);
    expect(tractValueCaptureLine(tg({ levy: 52_000 }), 'steady')).toBe('In the value-capture district · £52k/month to the authority');
    const v = { district: new Uint8Array([1, 1]), projectedValueCapture: 3e5 } as unknown as GrowthView;
    expect(valueCaptureSection(v, 2e5, 'steady').body).toMatch(/^2 neighbourhood areas within ½ mi of a served station\. 14% of the extra business rates and council tax/);
    // The heading names London's precedent, not the US tax-increment district.
    expect(valueCaptureHeading()).toBe('Value capture (business rate supplement district)');
    expect(growthGoalProgress('value-capture', null, 4.5e6, 'steady', () => '')).toBe('Best month so far: £4.5M');
  });

  it('names places from London’s classes, villages and hamlets included', () => {
    applyCity('london');
    expect(placeClasses()).toEqual(['neighbourhood', 'quarter', 'suburb', 'village', 'hamlet']);
    // Tract names also take London's towns (station names do not).
    expect(tractPlaceClasses()).toEqual(['neighbourhood', 'quarter', 'suburb', 'village', 'hamlet', 'town']);
    applyCity('nyc');
    expect(placeClasses()).toEqual(['neighbourhood', 'quarter', 'suburb']);
    expect(tractPlaceClasses()).toEqual(['neighbourhood', 'quarter', 'suburb']);
  });
});

describe('tract names', () => {
  it('keeps place labels in a grid, deduplicated across tiles, nearest within the radius', () => {
    const p = new PlaceIndex();
    expect(p.add('Astoria', 1000, 1000)).toBe(true);
    expect(p.add('Astoria', 1040, 1010)).toBe(false); // the same label from a neighbouring tile
    expect(p.add('Ditmars', 2500, 1000)).toBe(true);
    expect(p.size).toBe(2);
    expect(p.nearest(1100, 1000)).toBe('Astoria');
    expect(p.nearest(2100, 1000)).toBe('Ditmars');
    expect(p.nearest(1000 + TRACT_NAME_RADIUS + 50, 1000)).toBe('Ditmars');
    expect(p.nearest(9000, 9000)).toBeNull();
    expect(p.nearest(-5000, -5000, 100)).toBeNull();
  });

  it('falls back from a map label to the nearest served station, then the formal name', () => {
    const p = new PlaceIndex();
    p.add('Long Island City', 0, 0);
    const nyc = { name: undefined, borough: 'Queens', id: '36081005700', x: 0, y: 0 };
    const served = [{ name: '36 St', x: 1800, y: 0 }, { name: 'Far', x: 5000, y: 0 }];
    expect(tractName(nyc, p, served)).toBe('Long Island City');
    expect(tractName({ ...nyc, x: 2500 }, p, served)).toBe('around 36 St');
    expect(tractName({ ...nyc, x: 20_000 }, p, served)).toBe('Queens tract 57');
    expect(tractName({ ...nyc, x: 20_000 }, null, [])).toBe('Queens tract 57');
    // London MSOAs keep their own names ("Camden 028").
    expect(tractName({ name: 'Camden 028', borough: 'Camden', id: 'E02000193', x: 20_000, y: 0 }, p, served)).toBe('Camden 028');
    expect(formalTractName({ borough: 'Manhattan', id: '36061030700' })).toBe('Manhattan tract 307');
  });

  it('does not name a tract after a label or station in another borough (across a river)', () => {
    const p = new PlaceIndex();
    p.add('Hughesfield Estate', 600, 0, 2); // Lewisham, south bank
    p.add('Millwall', 1100, 0, 1); // Tower Hamlets
    const t = { name: 'Tower Hamlets 031', borough: 'Tower Hamlets', id: 'E02000894', x: 0, y: 0 };
    expect(p.nearest(0, 0)).toBe('Hughesfield Estate');
    expect(p.nearest(0, 0, TRACT_NAME_RADIUS, 1)).toBe('Millwall');
    expect(tractName(t, p, [], 1)).toBe('Millwall');
    expect(tractName(t, p, [], 0)).toBe('Hughesfield Estate'); // the tract's borough unknown
    const q = new PlaceIndex();
    q.add('Deptford', 300, 0, 2);
    const served = [{ name: 'North Greenwich', x: 400, y: 0, region: 3 }, { name: 'Island Gardens', x: 900, y: 0, region: 1 }];
    expect(tractName(t, q, served, 1)).toBe('around Island Gardens');
    expect(tractName(t, q, served.slice(0, 1), 1)).toBe('Tower Hamlets 031');
    // The search reaches TRACT_NAME_RADIUS beyond the zone's edge: a London MSOA of radius 417 m
    // is named after a station 1,470 m from its centre (Canary Wharf from Tower Hamlets 031).
    const cw = [{ name: 'Canary Wharf', x: 0, y: 1470, region: 1 }];
    expect(tractName(t, new PlaceIndex(), cw, 1)).toBe('Tower Hamlets 031');
    expect(tractNameRadius(417)).toBe(TRACT_NAME_RADIUS + 417);
    expect(tractName({ ...t, radius: 417 }, new PlaceIndex(), cw, 1)).toBe('around Canary Wharf');
    const far = new PlaceIndex();
    far.add('Cubitt Town', 0, -1500, 1);
    expect(tractName({ ...t, radius: 417 }, far, cw, 1)).toBe('Cubitt Town');
    // A label with no known borough (on the boundary) still counts.
    q.add('Docklands', 200, 0, 0);
    expect(tractName(t, q, served, 1)).toBe('Docklands');
    expect(formalTractName({ borough: 'Brooklyn', id: '36047000502' })).toBe('Brooklyn tract 5.02');
  });
});

describe('growth overlay arithmetic', () => {
  const tract = { index: 0, residents: 1000, jobs: 3000 };
  const view = { mRes: new Float32Array([1.1]), mJobs: new Float32Array([1]) };

  it('measures residents + jobs growth and the people added', () => {
    expect(tractGrowthSince(tract, view)).toBeCloseTo(0.025, 6);
    expect(tractPeopleAdded(tract, view)).toBeCloseTo(100, 3);
    expect(tractGrowthSince(tract, null)).toBe(0);
    expect(tractGrowthSince({ index: 0, residents: 0, jobs: 0 }, view)).toBe(0);
  });

  it('places growth on the diverging ramp around a neutral centre', () => {
    expect(growthT(0)).toBe(0.5);
    expect(growthT(Number.NaN)).toBe(0.5);
    expect(growthT(GROWTH_RAMP_SPAN)).toBe(1);
    expect(growthT(1)).toBe(1);
    expect(growthT(-GROWTH_RAMP_SPAN)).toBe(0);
    expect(growthT(0.05)).toBeGreaterThan(0.5);
    expect(growthT(0.05)).toBeLessThan(growthT(0.1));
    expect(growthT(-0.05)).toBeCloseTo(1 - growthT(0.05), 12);
    // A narrower span puts the same change further out.
    expect(growthT(0.004, 0.02)).toBeGreaterThan(growthT(0.004));
    expect(growthT(0.02, 0.02)).toBe(1);
  });

  it('widens the ramp’s span in steps as the city changes, and labels its ends', () => {
    expect(growthSpan(0)).toBe(0.02);
    expect(growthSpan(0.004)).toBe(0.02);
    expect(growthSpan(0.02)).toBe(0.02);
    expect(growthSpan(0.021)).toBe(0.05);
    expect(growthSpan(0.09)).toBe(0.1);
    expect(growthSpan(0.5)).toBe(0.2);
    expect(growthLegendEnds(0.02)).toEqual(['−2%', '+2%+']);
    expect(growthLegendEnds(0.2)).toEqual(['−20%', '+20%+']);
  });

  it('groups 3D columns in 25 m radius classes', () => {
    expect(columnRadiusClass(5)).toBe(25);
    expect(columnRadiusClass(140)).toBe(150);
    expect(columnRadiusClass(250)).toBe(250);
  });

  for (const id of ['nyc', 'london'] as const) {
    it(`${id}: a typical Steady boomtown's column stands tens of metres after 2–3 months; none is absurd at the ×2 bound`, () => {
      applyCity(id);
      const world = loadWorldFromDisk();
      const sizes = world.tracts.map((t) => t.residents + t.jobs).filter((n) => n >= GROWTH.minTractPeople).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)];
      // Steady's boomtowns grow ≈ 0.3–0.45% a month.
      expect(columnHeight(median * (1.003 ** 2 - 1))).toBeGreaterThanOrEqual(15);
      expect(columnHeight(median * (1.0035 ** 3 - 1))).toBeGreaterThanOrEqual(20);
      // Up to a few hundred metres when a median tract has doubled; the largest are capped.
      expect(columnHeight(median)).toBeGreaterThan(200);
      expect(columnHeight(median)).toBeLessThanOrEqual(MAP.growthColumnMaxMetres);
      expect(columnHeight(sizes[sizes.length - 1])).toBe(MAP.growthColumnMaxMetres);
      expect(columnHeight(MAP.growthColumnMinPeople - 1)).toBe(0);
      // Monotone.
      expect(columnHeight(100)).toBeGreaterThan(columnHeight(50));
    });
  }
});
