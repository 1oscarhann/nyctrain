/**
 * Living City text shared by the app shell and the panels (pure, no DOM): pace labels and hints,
 * the "since <start year>" phrase (the start year comes from TIME.startDate, never a literal),
 * toasts, the month report's City section, the tract and station panels' growth lines and the
 * finance panel's value-capture section. Money is in the city's currency, distances in the
 * player's units.
 */
import { GROWTH, TIME, VALUE_CAPTURE, type GrowthPace } from '../balance';
import { city } from '../cities';
import { fmtDate, monthIndex, monthLabel, yearOf } from '../core/calendar';
import { fmtCount, fmtDistance, fmtMoney, getUnits } from '../core/units';
import type { Boomtown, GrowthMonth, GrowthView, TractGrowth } from '../sim/protocol';

export const GROWTH_PACE_LABEL: Record<GrowthPace, string> = { off: 'Off', steady: 'Steady', boom: 'Boom' };

export const GROWTH_PACE_HINT: Record<GrowthPace, string> = {
  off: 'Frozen city, no value capture',
  steady: 'Realistic: well-served areas grow about 5% a year',
  boom: '3× faster growth and land-value capture: easier money',
};

/** "since 2030": the game's start year. */
export function sinceStart(): string {
  return `since ${TIME.startDate.year}`;
}

/** "Jan 2030": the month the game starts in (index charts, the growth legend). */
export function startMonth(): string {
  return monthLabel(0);
}

/** A signed percentage of a fraction: "+6.2%", "−1.0%", "0.0%" (U+2212 for minus, as fmtMoney). */
export function fmtSignedPct(f: number, digits = 1): string {
  const v = Math.abs(f * 100) < 0.5 * 10 ** -digits ? 0 : f * 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;
}

/** A signed count: "+41", "−1.2k". */
export function fmtSignedCount(n: number): string {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${fmtCount(Math.abs(r))}`;
}

/** The district radius in the player's units: "½ mi" (imperial) or "800 m". */
export function districtWord(): string {
  const m = VALUE_CAPTURE.districtRadius;
  if (getUnits() === 'imperial') return Math.abs(m / 1609.344 - 0.5) < 0.02 ? '½ mi' : fmtDistance(m);
  return `${Math.round(m)} m`;
}

/** "12% of the extra property tax" (London: "14% of the extra business rates and council tax"). */
export function captureWords(): string {
  return `${Math.round(VALUE_CAPTURE.captureShare * 100)}% of the extra ${city().valueCaptureTax}`;
}

// ------------------------------------------------------------------ toasts
/** A name at the start of a sentence ("around 36 St" → "Around 36 St"). */
export function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface GrowthToast {
  kind: 'boom' | 'milestone';
  tract: number;
  title: string;
  body: string;
  tone: 'green' | 'amber';
}

/**
 * "Long Island City is booming": "+0.6% this month · +41 residents, +12 jobs · +4.8% since 2030"
 * (a count that rounds to 0 is left out).
 */
export function boomtownToast(b: Boomtown, name: string): GrowthToast {
  const count = (n: number, one: string) => (Math.round(n) === 0 ? '' : `${fmtSignedCount(n)} ${one}${Math.abs(Math.round(n)) === 1 ? '' : 's'}`);
  const counts = [count(b.dRes, 'resident'), count(b.dJobs, 'job')].filter(Boolean);
  return {
    kind: 'boom',
    tract: b.tract,
    title: `${capFirst(name)} is booming`,
    body: [`${fmtSignedPct(b.rate)} this month`, counts.join(', '), `${fmtSignedPct(b.sinceStart)} ${sinceStart()}`].filter(Boolean).join(' · '),
    tone: 'green',
  };
}

/** A milestone: "Astoria has grown 10% since 2030" (green) or "Mott Haven is losing people" (amber). */
export function milestoneToast(m: { tract: number; pct: number }, name: string): GrowthToast {
  if (m.pct > 0) {
    return { kind: 'milestone', tract: m.tract, title: `${capFirst(name)} has grown ${Math.round(m.pct * 100)}% ${sinceStart()}`, body: 'Residents and jobs follow good transit.', tone: 'green' };
  }
  return { kind: 'milestone', tract: m.tract, title: `${capFirst(name)} is losing people`, body: `${fmtSignedPct(m.pct, 0)} ${sinceStart()} · no good transit`, tone: 'amber' };
}

/**
 * A month close's toasts (§2.1): the top boomtown when it is news (it grew at least
 * GROWTH.boomToastMonthlyRate and GROWTH.boomToastMinPeople residents and jobs this month, and
 * it is not `lastBoom`, the tract the last boomtown toast named), then up to two milestones,
 * never the same tract twice. A tract that keeps booming is toasted again at its milestones.
 */
export function growthToasts(gm: GrowthMonth, name: (tract: number) => string, lastBoom: number | null = null): GrowthToast[] {
  const out: GrowthToast[] = [];
  const top = gm.boomtowns[0];
  if (top && top.rate >= GROWTH.boomToastMonthlyRate && top.dRes + top.dJobs >= GROWTH.boomToastMinPeople && top.tract !== lastBoom) out.push(boomtownToast(top, name(top.tract)));
  for (const m of gm.milestones) {
    if (out.length >= 3) break;
    if (out.some((t) => t.tract === m.tract)) continue;
    out.push(milestoneToast(m, name(m.tract)));
  }
  return out;
}

// ------------------------------------------------------------------ month report
/** The month report's City rows: [label, value, tone class]. */
export function cityRows(gm: GrowthMonth): [string, string, string][] {
  const pct = (d: number, now: number) => (now - d > 0 ? d / (now - d) : 0);
  return [
    ['Residents', `${fmtCount(gm.residents)} (${fmtSignedCount(gm.dResidents)}, ${fmtSignedPct(pct(gm.dResidents, gm.residents), 2)})`, gm.dResidents > 0 ? 'hw-green' : gm.dResidents < 0 ? 'hw-red' : ''],
    ['Jobs', `${fmtCount(gm.jobs)} (${fmtSignedCount(gm.dJobs)})`, gm.dJobs > 0 ? 'hw-green' : gm.dJobs < 0 ? 'hw-red' : ''],
    ['Commuters now', `${fmtCount(gm.commuters)} (${gm.agents.toLocaleString()} agents)`, ''],
    ['Value-capture district', `${gm.districtTracts.toLocaleString()} ${city().zoneWord.replace(/ \(.*\)$/, '')} · ${fmtMoney(gm.districtIncrement)} of new value`, ''],
  ];
}

/**
 * Names for a list of tracts (the month report's boomtowns), made distinct: when two share a name
 * ("around Inwood"), each also gets its formal name ("Manhattan tract 297") as a detail.
 */
export function distinctNames(tracts: readonly number[], name: (i: number) => string, formal: (i: number) => string): { name: string; detail: string | null }[] {
  const names = tracts.map(name);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  return names.map((n, k) => {
    const f = formal(tracts[k]);
    return { name: n, detail: (count.get(n) ?? 0) > 1 && f !== n ? f : null };
  });
}

/** A Boomtowns list line: "+0.45%/mo · +4.8% since 2030". */
export function boomtownLine(b: Boomtown): string {
  return `${fmtSignedPct(b.rate, 2)}/mo · ${fmtSignedPct(b.sinceStart)} ${sinceStart()}`;
}

/** The sandbox month toast's body: "1.35M riders a day · +3.7k residents". */
export function sandboxMonthBody(ridersPerDay: number, gm: GrowthMonth | null): string {
  return `${fmtCount(ridersPerDay)} riders a day${gm ? ` · ${fmtSignedCount(gm.dResidents)} residents` : ''}`;
}

/**
 * The year in review's City line, from the growth view's month rows: residents and jobs at the
 * year's last close against the year before (the start for the first year), and the year's growth
 * months (its value capture is on the Money line). Null when no month of that year grew the city.
 */
export function yearCityLine(v: Pick<GrowthView, 'city'> | null, year: number, startYear: number, totals: { residents: number; jobs: number }): string | null {
  if (!v || !v.city.length) return null;
  const rows = v.city.filter((c) => yearOf(c.day) === year);
  if (!rows.length) return null;
  const before = v.city.filter((c) => yearOf(c.day) < year).at(-1);
  const r0 = before?.residents ?? (year <= startYear ? totals.residents : rows[0].residents);
  const j0 = before?.jobs ?? (year <= startYear ? totals.jobs : rows[0].jobs);
  const last = rows[rows.length - 1];
  return `Residents ${fmtCount(last.residents)} (${fmtSignedCount(last.residents - r0)}, ${fmtSignedPct(r0 > 0 ? last.residents / r0 - 1 : 0, 2)}) · jobs ${fmtCount(last.jobs)} (${fmtSignedCount(last.jobs - j0)}) · ${rows.length} growth month${rows.length > 1 ? 's' : ''}`;
}

/** One-time hint in the first month report after an older save is loaded. */
export const MIGRATED_HINT = 'Living City: your city now grows around good transit. Menu → City growth.';

// ------------------------------------------------------------------ tract panel
/**
 * The tract panel's title and subtitle: its name for toasts and reports (a map label or "around
 * <station>"), with the formal name in the subtitle; or the formal name alone.
 */
export function tractPanelTitle(name: string, formal: string, kind: string, id: string, borough: string): { title: string; sub: string } {
  return name && name !== formal ? { title: capFirst(name), sub: `${formal} · ${kind} ${id}` } : { title: formal, sub: `${kind} ${id} · ${borough}` };
}

/** The game's first day without its weekday: "7 Jan 2030". */
export function startDateText(): string {
  return fmtDate(0).replace(/^\S+ /, '');
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 2030": the month `offset` months after the start month (0 = the start month, as monthLabel(0)). */
export function monthAfterStart(offset: number): string {
  const m = TIME.startDate.month + offset;
  return `${MONTH_SHORT[((m % 12) + 12) % 12]} ${TIME.startDate.year + Math.floor(m / 12)}`;
}

/**
 * The tract panel's index chart: the start (= 100) and then one point per stored month close,
 * labelled with the month that closed ("Start", "Jan 2030", "Feb 2030"…), placed on a month axis
 * (`xs`: months since the start; the start month's close is 1), so a month without a close (city
 * growth Off) or one thinned from the history leaves its gap. `label(x)` names any x. A side
 * with nobody at the start has no line (null).
 */
export function indexSeries(tg: Pick<TractGrowth, 'history' | 'residents0' | 'jobs0'>): { xs: number[]; labels: string[]; label: (x: number) => string; res: (number | null)[]; jobs: (number | null)[] } {
  const idx = (v: number, v0: number) => (v0 > 0 ? (v / v0) * 100 : null);
  const m0 = monthIndex(0);
  return {
    xs: [0, ...tg.history.map((p) => monthIndex(p.day) - m0 + 1)],
    labels: ['Start', ...tg.history.map((p) => monthLabel(p.day))],
    label: (x) => (x <= 0 ? 'Start' : monthAfterStart(Math.round(x) - 1)),
    res: [tg.residents0 > 0 ? 100 : null, ...tg.history.map((p) => idx(p.residents, tg.residents0))],
    jobs: [tg.jobs0 > 0 ? 100 : null, ...tg.history.map((p) => idx(p.jobs, tg.jobs0))],
  };
}
/** Residents + jobs growth rate a month at the tract's projected rates. */
export function projectedRate(tg: TractGrowth): number {
  const r = tg.residents, j = tg.jobs;
  return r + j > 0 ? (r * tg.projectedRateRes + j * tg.projectedRateJobs) / (r + j) : 0;
}

/**
 * "Growing 0.4% a month. Residents here save 23 min per commute with your network (city average
 * 9 min)." Job-heavy tracts also name the time saved by people working there.
 */
export function tractGrowthSentence(tg: TractGrowth, pace: GrowthPace): string {
  const parts: string[] = [];
  if (pace === 'off') parts.push('City growth is off (Menu → City growth).');
  else {
    const rate = projectedRate(tg);
    if (Math.abs(rate) < 0.0005) parts.push('Holding steady.');
    else parts.push(`${rate > 0 ? 'Growing' : 'Shrinking'} ${Math.abs(rate * 100).toFixed(rate > -0.01 && rate < 0.01 ? 2 : 1)}% a month.`);
  }
  const avg = `city average ${Math.round(tg.cityBenefit)} min`;
  if (tg.residents0 > 0) {
    parts.push(tg.benefitHome >= 0.5 ? `Residents here save ${Math.round(tg.benefitHome)} min per commute with your network (${avg}).` : `Residents here gain little from your network (${avg}).`);
  }
  if (tg.jobs0 > tg.residents0 && tg.benefitWork >= 0.5) parts.push(`People working here save ${Math.round(tg.benefitWork)} min.`);
  return parts.join(' ');
}

/**
 * "In the value-capture district · $41k/month to the authority" (a partial tract names its share),
 * or "Outside the district: no served station within ½ mi". Before its first month end a district
 * tract has no increment yet, so it says when the first payment comes (`nextClose`: "Jan 2030")
 * rather than "$0/month"; later, a tract with nothing to tax says so.
 */
export function tractValueCaptureLine(tg: TractGrowth, pace: GrowthPace, nextClose?: string): string {
  if (!tg.inDistrict) return `Outside the district: no served station within ${districtWord()}`;
  const part = tg.districtShare < 0.995 ? ` (${Math.max(1, Math.round(tg.districtShare * 100))}% of its area)` : '';
  if (pace === 'off') return `In the value-capture district${part} · nothing is collected while city growth is off`;
  if (!(tg.levy >= 0.5)) {
    return `In the value-capture district${part} · ${tg.history.length ? 'no rise in value to tax yet' : `first payment at the end of ${nextClose ?? 'the month'}`}`;
  }
  return `In the value-capture district${part} · ${fmtMoney(tg.levy)}/month to the authority`;
}

// ------------------------------------------------------------------ station panel and finances
/** Station panel: "$0.4M/month · 6 tracts" (London: "… · 2 areas"). */
export function stationValueCaptureText(levy: number, tracts: number): string {
  const word = city().id === 'london' ? (tracts === 1 ? 'area' : 'areas') : tracts === 1 ? 'tract' : 'tracts';
  return `${fmtMoney(levy)}/month · ${tracts} ${word}`;
}

/** Its tooltip. */
export function stationValueCaptureTip(): string {
  return `${captureWords()} from the ${city().id === 'london' ? 'areas' : 'tracts'} nearest this station, paid at each month end`;
}

/** The finance panel's value-capture heading: "Value capture (Transit Improvement District)"; London names the business rate supplement district. */
export function valueCaptureHeading(): string {
  return `Value capture (${city().valueCaptureDistrict})`;
}

/** The finance panel's value-capture section text. */
export function valueCaptureSection(v: GrowthView | null, lastMonth: number | null, pace: GrowthPace): { body: string; last: string } {
  const n = v ? v.district.reduce((s, x) => s + x, 0) : null;
  const zones = city().id === 'london' ? 'neighbourhood areas' : 'tracts';
  const where = n === null ? `Tracts within ${districtWord()} of a served station` : `${n.toLocaleString()} ${zones} within ${districtWord()} of a served station`;
  const body = `${where}. ${captureWords()} from rising land values is paid to the authority at each month end.`;
  const proj = pace === 'off' ? 'city growth is off' : v ? `projected this month: ${fmtMoney(v.projectedValueCapture)}` : 'projected this month: …';
  return { body, last: `Last month: ${lastMonth === null ? '—' : fmtMoney(lastMonth)} · ${proj}` };
}

/** Hover on the growth overlay: "<b>Astoria</b> · +6.2% since 2030 · click for details". */
export function growthHoverText(u: number): string {
  return `${fmtSignedPct(u)} ${sinceStart()} · click for details`;
}

/** Goals panel progress for the two Living City goals (null when there is nothing to say). */
export function growthGoalProgress(id: string, best: { tract: number; growth: number } | null, bestMonth: number, pace: GrowthPace, name: (i: number) => string): string | null {
  if (pace === 'off') return 'City growth is off (Menu → City growth).';
  if (id === 'boomtown') return best && best.growth > 0 ? `Best so far: ${name(best.tract)} ${fmtSignedPct(best.growth)}` : null;
  if (id === 'value-capture') return bestMonth > 0 ? `Best month so far: ${fmtMoney(bestMonth)}` : null;
  return null;
}
