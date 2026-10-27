/**
 * Commuter stories (v2): every line of copy, pure so it is tested in both cities (currency, units,
 * the city's words). Names of tracts, stations and routes come from the caller's context.
 */
import type { CityId } from '../balance';
import { fmtDate } from '../core/calendar';
import { fmtClock, fmtDistance, fmtFare, fmtMinutes, fmtMoney } from '../core/units';
import type { DayStory, StoryPlan, StoryWho, TraceData, TraceEvent } from '../sim/protocol';
import type { RideState } from './ridePose';

export type Tone = 'green' | 'amber' | 'red' | null;

export interface RouteInfo {
  bullet: string;
  name: string;
  express?: boolean;
}

/** Names the copy needs, from the game (tests pass their own). */
export interface StoryCtx {
  city: CityId;
  /** "subway" / "metro". */
  transitWord: string;
  tract(i: number): string;
  station(id: number): string;
  route(id: number): RouteInfo | undefined;
}

/** A taxi in each city's word. */
export const cabWord = (city: CityId) => (city === 'london' ? 'taxi' : 'cab');

export const BAND_LABEL = ['lower-income', 'middle-income', 'higher-income'] as const;

const r = (ctx: StoryCtx, id: number) => {
  const x = ctx.route(id);
  return x ? `the ${x.bullet}${x.express ? ' express' : ''}` : 'a train';
};
const min = (s: number) => fmtMinutes(Math.max(0, s));
const clock = (t: number) => fmtClock(t);

/** "Astoria → Midtown · middle-income" (an event-goer: "Bexley → Greenwich arena concert"). */
export function storySubtitle(who: StoryWho, ctx: StoryCtx): string {
  if (who.event) return `${ctx.tract(who.home)} → ${who.event.label}`;
  return `${ctx.tract(who.home)} → ${ctx.tract(who.work)} · ${BAND_LABEL[who.band] ?? ''}`;
}

/** The legs as a sentence: "the N from 36 St to 34 St, then the 7 to Grand Central". */
export function legsText(legs: ArrayLike<number>, ctx: StoryCtx): string {
  const parts: string[] = [];
  for (let i = 0; i + 2 < legs.length; i += 3) {
    const leg = `${r(ctx, legs[i])}${i === 0 ? ` from ${ctx.station(legs[i + 1])}` : ''} to ${ctx.station(legs[i + 2])}`;
    parts.push(i === 0 ? leg : `then ${leg}`);
  }
  return parts.join(', ');
}

/** One line of the timeline (the time is shown beside it). `name` is the rider's first name. */
export function eventText(e: TraceEvent, ctx: StoryCtx, name: string, who?: StoryWho): string {
  const cab = cabWord(ctx.city);
  switch (e.k) {
    case 'day':
      return fmtDate(e.day);
    case 'walk': {
      const dur = min(e.t1 - e.t);
      const st = ctx.station(e.station);
      if (e.why === 'access') {
        const from = e.pm ? (who?.event ? `the ${who.event.label.toLowerCase()}` : `work in ${who ? ctx.tract(who.work) : 'town'}`) : `home in ${who ? ctx.tract(who.home) : 'the neighbourhood'}`;
        return e.j ? `Walking to ${st} (joined here)` : `Leaves ${from}, walking ${dur} to ${st}`;
      }
      if (e.why === 'transfer') return `Walks ${dur} to change at ${st}`;
      if (e.why === 'across') return `Steps across the platform at ${st}`;
      const to = e.pm ? `home${who ? ` to ${ctx.tract(who.home)}` : ''}` : who?.event ? `to the ${who.event.label.toLowerCase()}` : `to work${who ? ` in ${ctx.tract(who.work)}` : ''}`;
      return `Walks ${dur} ${to}`;
    }
    case 'drive':
      return `Drives instead: no ${ctx.transitWord} route any more (${min(e.t1 - e.t)})`;
    case 'wait':
      return `${e.j ? 'Joined while waiting' : 'Waiting'} at ${ctx.station(e.station)} for ${r(ctx, e.route)} towards ${ctx.station(e.towards)}`;
    case 'closed':
      return e.cab ? `${ctx.station(e.station)} is closed by police activity: takes a ${cab}` : `${ctx.station(e.station)} is closed by police activity: waits outside until ${clock(e.until)}`;
    case 'board': {
      if (e.j) return `Riding ${r(ctx, e.route)} to ${ctx.station(e.alight)} (joined here)`;
      const full = e.cap > 0 ? Math.round((e.load / e.cap) * 100) : 0;
      const waited = e.waited >= 60 ? ` after ${min(e.waited)}` : '';
      const fare = e.fare > 0 ? ` · pays ${fmtFare(e.fare)}` : ' · free transfer';
      const either = e.either ? ' (the first train of either)' : '';
      return `Boards ${r(ctx, e.route)}${either} at ${ctx.station(e.station)}${waited}${fare} · ${full}% full`;
    }
    case 'left':
      return `A full train left ${name} behind at ${ctx.station(e.station)}`;
    case 'alight':
      return `Gets off at ${ctx.station(e.station)}`;
    case 'switch':
      return `Changes across the platform at ${ctx.station(e.station)} to ${r(ctx, e.route)}, quicker to ${ctx.station(e.alight)}`;
    case 'across':
      return `Steps across to wait for ${r(ctx, e.route)}, due ${clock(e.eta)}`;
    case 'past':
      return `${ctx.station(e.station)} is closed: the train runs through, ${name} rides on to the next stop`;
    case 'held':
      return `The train is held at ${ctx.station(e.station)} for an even gap`;
    case 'incident':
      return e.kind === 'stalled' ? `The train has broken down: moving again ~${clock(e.until)}` : `A passenger is taken ill: the train will wait at ${ctx.station(e.station)}`;
    case 'giveup':
      return `Gives up at ${ctx.station(e.station)} after ${min(e.waited)}`;
    case 'cab': {
      const why = e.why === 'giveup' || e.why === 'closed' ? '' : e.why === 'evacuated' ? ': the train was taken out of service' : e.why === 'crowded' ? ': the station was too crowded to get in' : `: the ${ctx.transitWord} no longer goes their way`;
      return `Takes a ${cab}${why} (arrives ~${clock(e.t1)})`;
    }
    case 'arrive': {
      const how = e.boarded ? `${min(e.dur)} door to door` : `${min(e.dur)}, without the ${ctx.transitWord}`;
      if (e.pm) return `Home · ${how}`;
      return who?.event ? `At the ${who.event.label.toLowerCase()} · ${how}` : `At work · ${how}`;
    }
    case 'stuck':
      return `Still travelling when the day ended: home by other means`;
    case 'regen':
      return `The month closed and the city grew: still living in ${who ? ctx.tract(who.home) : 'the same place'}`;
  }
}

/** Tone of a timeline line (incidents and give-ups stand out). */
export function eventTone(e: TraceEvent): Tone {
  switch (e.k) {
    case 'left':
    case 'held':
    case 'across':
    case 'switch':
      return 'amber';
    case 'closed':
    case 'past':
    case 'giveup':
    case 'cab':
    case 'incident':
    case 'stuck':
      return 'red';
    case 'arrive':
      return e.boarded ? 'green' : null;
    default:
      return null;
  }
}

/** Live info about the train being ridden (from the snapshot), for the status line. */
export interface RidingInfo {
  route: number;
  next: string;
  terminal: string;
  /** People on board and comfortable capacity. */
  people: number;
  cap: number;
  held: boolean;
  dwelling: boolean;
}

/** The status line: what the rider is doing right now. */
export function statusText(tr: TraceData, st: RideState, now: number, ctx: StoryCtx, name: string, riding: RidingInfo | null): { text: string; tone: Tone } {
  const plan = tr.plan;
  if (tr.ended === 'moved') return { text: `${name}'s household moved away when the city changed at the month end`, tone: 'amber' };
  if (tr.ended === 'eventOver') return { text: `${name}'s evening out is over`, tone: null };
  const cab = cabWord(ctx.city);
  switch (st.kind) {
    case 'walk': {
      const left = Math.max(0, st.until - now);
      const to = st.station >= 0 ? ctx.station(st.station) : st.pm ? 'home' : tr.who.event ? `the ${tr.who.event.label.toLowerCase()}` : 'work';
      return { text: `Walking to ${to} · ${left >= 60 ? `${Math.round(left / 60)} min to go` : 'nearly there'}`, tone: null };
    }
    case 'wait': {
      const e = st.event;
      if (e?.k === 'closed') return { text: `${ctx.station(e.station)} is closed: waiting outside until ${clock(e.until)}`, tone: 'red' };
      const since = waitSince(tr.events, st);
      const w = since !== null ? Math.max(0, now - since) : 0;
      const route = e && e.k === 'wait' ? ` for ${r(ctx, e.route)}` : '';
      return { text: `Waiting at ${ctx.station(st.station)}${route} · ${w >= 60 ? `${Math.round(w / 60)} min so far` : 'just arrived'}`, tone: w >= 15 * 60 ? 'red' : w >= 8 * 60 ? 'amber' : null };
    }
    case 'ride': {
      if (!riding) return { text: `On the train`, tone: null };
      const full = riding.cap > 0 ? riding.people / riding.cap : 0;
      const load = ` · ${Math.round(full * 100)}% full`;
      const where = riding.held ? `held at ${riding.next} for an even gap` : riding.dwelling ? `at ${riding.next}` : `next ${riding.next}`;
      return { text: `On ${r(ctx, riding.route)} towards ${riding.terminal} · ${where}${load}`, tone: riding.held ? 'amber' : full > 1.4 ? 'red' : full > 1 ? 'amber' : null };
    }
    case 'car':
      return { text: `In a ${st.event?.k === 'drive' ? 'car' : cab}, ${st.pm ? 'heading home' : 'on the way'} · arrives ~${clock(st.until)}`, tone: st.event?.k === 'cab' ? 'red' : null };
    case 'work': {
      const back = homeTime(tr, now);
      const at = tr.who.event ? `At the ${tr.who.event.label.toLowerCase()}` : `At work in ${ctx.tract(tr.who.work)}`;
      return { text: back ? `${at} · heads home ~${clock(back)}` : at, tone: null };
    }
    case 'home': {
      const done = tr.events.some((e, i) => e.k === 'arrive' && e.pm && i > lastDayIndex(tr.events, now));
      if (done) return { text: `Home in ${ctx.tract(tr.who.home)} for the night`, tone: null };
      if (plan.mode !== 2) return { text: `${modeWord(plan.mode, ctx)} today: no ride along until a day ${name} takes the ${ctx.transitWord}`, tone: 'amber' };
      return plan.depart > now ? { text: `At home in ${ctx.tract(tr.who.home)} · leaves ~${clock(plan.depart)}`, tone: null } : { text: `At home in ${ctx.tract(tr.who.home)} · leaves tomorrow ~${clock(plan.depart)}`, tone: null };
    }
    case 'ended':
      return { text: `The story is over`, tone: null };
  }
}

function lastDayIndex(events: readonly TraceEvent[], now: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].k === 'day' && events[i].t <= now) return i;
  return -1;
}

/** When the rider started waiting on this platform (null: unknown). */
function waitSince(events: readonly TraceEvent[], st: RideState): number | null {
  const e = st.event;
  if (!e) return null;
  for (let i = events.indexOf(e); i >= 0; i--) {
    const x = events[i];
    if (x.k === 'wait') return x.t;
    if (x.k === 'board' || x.k === 'alight' || x.k === 'walk') return null;
  }
  return null;
}

/** When they head home (morning arrival + their stay), if known. */
function homeTime(tr: TraceData, now: number): number | null {
  const ev = tr.events;
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i];
    if (e.t > now) continue;
    if (e.k === 'arrive' && !e.pm) return tr.who.event ? tr.plan.depart + tr.plan.stay : e.t + tr.plan.stay;
    if (e.k === 'day') break;
  }
  return null;
}

/** "Walk", "Drive" or the city's transit word, capitalised. */
export function modeWord(mode: number, ctx: StoryCtx): string {
  return mode === 0 ? 'Walking' : mode === 1 ? 'Driving' : ctx.transitWord[0].toUpperCase() + ctx.transitWord.slice(1);
}

export interface WhyRow {
  mode: number;
  label: string;
  /** Generalised minutes (null: not an option). */
  minutes: number | null;
  detail: string;
  chosen: boolean;
}

/** Why this mode: each mode's generalised cost as mode choice weighed it, and its parts. */
export function whyRows(plan: StoryPlan, ctx: StoryCtx, distanceM?: number): WhyRow[] {
  const vot = `${fmtMoney(plan.vot)}/h`;
  const rows: WhyRow[] = [];
  const t = plan.transit;
  rows.push({
    mode: 2,
    label: modeWord(2, ctx),
    minutes: plan.costs[2],
    detail: t
      ? `${Math.round(t.min)} min door to door (${t.observed ? 'as it went yesterday' : 'by the timetable'})${t.transfers > 0.01 ? ` + ${t.transfers >= 0.99 && t.transfers <= 1.01 ? 'a change' : `${t.transfers.toFixed(1)} changes`} (${Math.round(t.transferMin)} min)` : ''}${t.crowdMin >= 0.5 ? ` + crowding ${Math.round(t.crowdMin)} min` : ''} + the ${fmtFare(t.fare)} fare (${Math.round(t.fareMin)} min at ${vot})`
      : `No ${ctx.transitWord} route between home and work`,
    chosen: plan.mode === 2,
  });
  const d = plan.drive;
  rows.push({
    mode: 1,
    label: 'Drive',
    minutes: plan.costs[1],
    detail: d ? `${Math.round(d.min)} min with parking + ${fmtMoney(d.money)} running and parking costs (${Math.round(d.moneyMin)} min) + ${Math.round(d.constant)} min for keeping and using a car` : '—',
    chosen: plan.mode === 1,
  });
  const w = plan.walk;
  rows.push({
    mode: 0,
    label: 'Walk',
    minutes: plan.costs[0],
    detail: w ? `${Math.round(w.min)} min on foot${w.penalty > 0 ? ` + ${Math.round(w.penalty)} min for the weather` : ''}` : distanceM !== undefined ? `Too far to walk (${fmtDistance(distanceM)})` : 'Too far to walk',
    chosen: plan.mode === 0,
  });
  return rows;
}

/** "People like Amara: 34% subway · 60% drive · 6% walk". */
export function sharesText(plan: StoryPlan, ctx: StoryCtx, name: string): string {
  const s = plan.shares;
  if (!s) return '';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `People like ${name} (same home, work and income): ${pct(s[2])} ${ctx.transitWord} · ${pct(s[1])} drive · ${pct(s[0])} walk`;
}

/** "Leaves ~08:12 · the N from 36 St to 34 St · 32 min by the timetable". */
export function planText(plan: StoryPlan, ctx: StoryCtx, pm = false): string {
  const trip = pm ? plan.pm : plan.am;
  if (!trip) return `No ${ctx.transitWord} route for this trip`;
  return `${legsText(trip.legs, ctx)} · ${min(trip.time)} by the timetable`;
}

/** The commuter of the day toast: title and body (rider's first name and the day's numbers). */
export function dayStoryText(s: DayStory, ctx: StoryCtx, name: string): { title: string; body: string } {
  const legs = s.legs.length ? legsText(s.legs, ctx) : '';
  const from = ctx.tract(s.who.home);
  switch (s.cat) {
    case 'saved':
    case 'cross': {
      const alt = s.altMode === 0 ? 'walking' : 'driving';
      const trip = s.pm ? `home to ${from}` : `from ${from} to ${ctx.tract(s.who.work)}`;
      const lead = s.cat === 'cross' ? `changed across the platform and saved` : 'saved';
      return { title: `Commuter of the day: ${name}`, body: `${name} ${lead} ${min(s.value)} against ${alt}: ${trip} in ${min(s.t1 - s.t0)} (${legs}). Ride along tomorrow?` };
    }
    case 'wait':
      return { title: `Commuter of the day: ${name}`, body: `${name} waited ${min(s.value)} at ${ctx.station(s.station ?? -1)} for ${r(ctx, s.route ?? -1)}${s.left ? ', left behind by a full train' : ''}. Ride along tomorrow?` };
    case 'fan':
      return { title: `Fan of the day: ${name}`, body: `${name} came from ${from} to the ${s.who.event?.label.toLowerCase() ?? 'event'} by ${ctx.transitWord}: ${min(s.value)} (${legs})${s.late ? ', arriving after the start' : ''}.` };
  }
}

/** Which of the day's stories to toast (an event-goer on event days, else rotating by day), if notable. */
export function pickDayStory(stories: readonly DayStory[], day: number, thresholds: { saved: number; wait: number; fan: number }): DayStory | null {
  const ok = (s: DayStory) => (s.cat === 'saved' || s.cat === 'cross' ? s.value >= thresholds.saved : s.cat === 'wait' ? s.value >= thresholds.wait : s.value >= thresholds.fan);
  const good = stories.filter(ok);
  if (!good.length) return null;
  const fan = good.find((s) => s.cat === 'fan');
  if (fan && day % 2 === 0) return fan;
  const order: DayStory['cat'][] = ['saved', 'wait', 'cross', 'fan'];
  const rot = order.slice(day % order.length).concat(order.slice(0, day % order.length));
  for (const c of rot) {
    const s = good.find((x) => x.cat === c);
    if (s) return s;
  }
  return good[0];
}
