/**
 * Service alerts (A): active incidents, today's weather and the forecast, today's and announced
 * city events (with the inline event service editor), earlier incidents and wrap-ups, and the
 * city chaos level. It re-renders when the alert feed changes, keeping the scroll position and
 * never while the event service editor has focus.
 */
import { CHAOS, EVENTS, OPERATIONS } from '../../balance';
import { city, cityBalance } from '../../cities';
import { fmtDate, SECONDS_PER_DAY } from '../../core/calendar';
import { weatherLabel } from '../../core/cityCalendar';
import { toLocal } from '../../core/geo';
import { fmtClock, fmtCount, fmtDistance, fmtMoney, getUnits } from '../../core/units';
import { defaultWindows, routesNearVenue, serviceEstimate, stationsNear } from '../../routes/eventService';
import type { CRoute, ServiceOverride } from '../../sim/protocol';
import { describeAlert, eventWhen, fmtK, forecastText, LEVEL_HINT, LEVEL_LABEL, outcomeText, weatherEffects, type FeedEvent } from '../alertFeed';
import type { App } from '../app';
import { bullet, h, svgIcon } from '../dom';
import { ICONS, WEATHER_ICON } from '../icons';
import { section, shell, type Panel } from './common';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DAY = SECONDS_PER_DAY;

/** "1,800 car-mi" / "2,900 car-km". */
function fmtCarDistance(km: number): string {
  return getUnits() === 'imperial' ? `${fmtCount(km / 1.609344)} car-mi` : `${fmtCount(km)} car-km`;
}

function venueLocal(ev: FeedEvent): [number, number] {
  const v = cityBalance().chaos.venues[ev.venue];
  return toLocal(v.lon, v.lat);
}

export function alertsPanel(app: App, focus?: number, focusEvent?: number): Panel {
  const game = app.game;
  const feed = app.feed;
  const sh = shell('Service alerts', '', () => game.select(null));
  const body = sh.body;
  /** Event whose service editor is open, and its element (kept across re-renders). */
  let editor: { id: number; el: HTMLElement } | null = null;
  let focusAlert = focus;
  let focusEv = focusEvent ?? null;
  let renderedKey = '';
  let scrolledToFocus = false;
  if (focusEv !== null) app.setFocusEvent(focusEv);

  const now = () => app.sim.time();
  const key = () => `${feed.version}|${game.chaos.level}|${game.chaos.service.length}|${Math.floor(now() / 900)}|${getUnits()}|${app.compiled?.net.version ?? -1}`;

  const fly = (pos?: [number, number]) => {
    if (pos) app.flyTo(pos[0], pos[1]);
  };

  // ------------------------------------------------------------------ incidents
  const alertCard = (id: number, compact = false): HTMLElement | null => {
    const a = feed.get(id);
    if (!a) return null;
    const t = describeAlert(a, app.routeRef);
    const show = (e: Event) => {
      e.stopPropagation();
      if (a.kind === 'police' && a.stationId !== undefined) game.select({ kind: 'station', id: a.stationId });
      else if (a.trainId !== undefined && (a.kind === 'breakdown' || a.kind === 'sick')) game.select({ kind: 'train', id: a.trainId });
      else if (a.routes.length) game.select({ kind: 'route', id: a.routes[0] });
    };
    if (compact) {
      return h(
        'div',
        { class: `alert-row tone-${t.tone}${a.id === focusAlert ? ' focus' : ''}`, 'data-alert': a.id, onclick: () => fly(a.pos) },
        h('span', { class: 'dot' }),
        h('span', { class: 'grow' }, a.kind === 'event' ? `${t.title}: ${t.detail}` : `${a.status === 'cleared' ? '✓ ' : ''}${t.title}`),
        h('span', { class: 'hw-muted num' }, a.kind === 'event' ? t.when : t.when.replace('cleared after ', '')),
      );
    }
    const showBtn = a.routes.length || a.stationId !== undefined || a.trainId !== undefined ? h('button', { class: 'hw-btn small', onclick: show }, 'Show') : null;
    return h(
      'div',
      { class: `alert-card tone-${t.tone}${a.id === focusAlert ? ' focus' : ''}`, 'data-alert': a.id, onclick: () => { focusAlert = a.id; fly(a.pos); render(true); } },
      h('div', { class: 'alert-head' }, h('span', { class: 'alert-title' }, t.title), h('span', { class: 'alert-when num' }, t.when)),
      h(
        'div',
        { class: 'alert-detail' },
        h('span', { class: 'alert-routes' }, ...t.routes.map((r) => bullet(r.color, r.bullet, 16))),
        h('span', { class: 'grow' }, t.routes.length ? t.detail : cap(t.detail)),
        showBtn,
      ),
    );
  };

  // ------------------------------------------------------------------ events
  const eventCard = (ev: FeedEvent): HTMLElement => {
    const net = app.compiled?.net ?? null;
    const today = feed.day;
    const t = now();
    const [vx, vy] = venueLocal(ev);
    const venue = cityBalance().chaos.venues[ev.venue];
    const word = city().transitWord;
    const lines: (HTMLElement | string)[] = [];
    // Who can reach it: stations within the access walk, and the routes serving it.
    const near = net ? stationsNear(net, vx, vy, EVENTS.venueAccess) : [];
    const serving = net ? routesNearVenue(net, vx, vy, EVENTS.serviceRadius) : [];
    if (near.length) {
      const stops = near.slice(0, 3).map((s) => `${s.name} ${fmtDistance(s.dist)}`).join(' · ');
      lines.push(
        h(
          'div',
          { class: 'ev-line' },
          `${venue.name}: ${stops}`,
          serving.length ? h('span', { class: 'ev-serving' }, ' · served by ', ...serving.map((s) => app.routeRef(s.routeId)).filter((r) => !!r).map((r) => bullet(r!.color, r!.bullet, 15))) : null,
        ),
      );
    } else {
      const all = net ? stationsNear(net, vx, vy, Infinity) : [];
      lines.push(
        h(
          'div',
          { class: 'ev-line hw-muted' },
          all.length
            ? `${venue.name}: no station within ${fmtDistance(EVENTS.venueAccess)} (nearest ${all[0].name}, ${fmtDistance(all[0].dist)}). Fans drive or walk.`
            : `${venue.name}: no stations yet. Fans drive or walk.`,
        ),
      );
    }
    // Expected split (3 am), or when it will be known.
    const outcome = feed.outcome(ev.id);
    if (outcome) {
      lines.push(h('div', { class: 'ev-line ev-outcome' }, `✓ ${outcomeText(outcome)}`));
    } else if (ev.split) {
      const s = ev.split;
      const total = Math.max(1, s.byTransit + s.byDrive + s.byWalk);
      lines.push(
        h(
          'div',
          { class: 'ev-line' },
          s.byTransit > 0
            ? [h('b', { class: 'num' }, `~${fmtK(s.byTransit)} by ${word}`), ` (${Math.round((s.byTransit / total) * 100)}%) · `]
            : h('span', { class: 'hw-muted' }, `None by ${word} · `),
          `${fmtK(s.byDrive)} drive · ${fmtK(s.byWalk)} walk`,
          s.overflow > 0 ? h('span', { class: 'hw-amber' }, ` · ${fmtK(s.overflow)} more couldn't fit`) : null,
        ),
      );
    } else {
      lines.push(h('div', { class: 'ev-line hw-muted' }, ev.day === today ? 'Estimate at 3 am' : 'Estimate at 3 am on the day'));
    }
    // Planned event service for it (not yet ended): one row per headway and set of windows, listing its routes.
    const groups = new Map<string, ServiceOverride[]>();
    const svc = game.chaos.service.filter((x) => x.eventId === ev.id && x.to > t);
    for (const o of svc) {
      const wins = svc.filter((x) => x.routeId === o.routeId).sort((a, b) => a.from - b.from);
      const k = `${o.headwayMin}|${wins.map((w) => `${w.from}-${w.to}`).join(',')}`;
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    for (const list of groups.values()) {
      const rids = [...new Set(list.map((o) => o.routeId))];
      const wins = [...new Map(list.map((o) => [`${o.from}-${o.to}`, o])).values()].sort((a, b) => a.from - b.from);
      const refs = rids.map((id) => app.routeRef(id));
      lines.push(
        h(
          'div',
          { class: 'ev-service', title: 'Event service (temporary headway)' },
          svgIcon(ICONS.ticket),
          h('span', { class: 'alert-routes' }, ...refs.map((r, i) => (r ? bullet(r.color, r.bullet, 15) : `route ${rids[i]}`))),
          h('span', { class: 'grow' }, `every ${list[0].headwayMin} min · ${wins.map((o) => `${fmtClock(o.from)}–${fmtClock(o.to)}`).join(', ')}`),
          h('button', {
            class: 'hw-btn ghost small',
            onclick: (e: Event) => {
              e.stopPropagation();
              for (const o of list) app.removeEventService(o.id);
              app.toast('Event service removed', `${refs.map((r) => r?.bullet ?? '?').join(' ')} · ${ev.label}`, 'amber');
            },
          }, 'Remove'),
        ),
      );
    }
    // Event service editor (until the after window has passed).
    const over = t >= ev.day * DAY + ev.end + EVENTS.serviceAfter[1];
    // Only where fans can come by train: a station within the access walk (or a route stopping near).
    const canPlan = !over && !!net && net.routes.length > 0 && (near.length > 0 || serving.length > 0);
    const isOpen = editor?.id === ev.id;
    const btn = canPlan && !isOpen
      ? h('button', {
          class: 'hw-btn small',
          onclick: (e: Event) => {
            e.stopPropagation();
            focusEv = ev.id;
            app.setFocusEvent(ev.id);
            app.flyTo(vx, vy);
            editor = {
              id: ev.id,
              el: serviceEditor(app, ev, () => {
                editor = null;
                render(true);
                // Keep the card (and the service just planned) in view.
                body.querySelector<HTMLElement>(`[data-event="${ev.id}"]`)?.scrollIntoView({ block: 'nearest' });
              }),
            };
            render(true);
          },
        }, svgIcon(ICONS.ticket), 'Event service…')
      : null;
    const card = h(
      'div',
      {
        class: `alert-card tone-event${ev.id === focusEv ? ' focus' : ''}${ev.day > today ? ' future' : ''}`,
        'data-event': ev.id,
        onclick: () => {
          focusEv = ev.id;
          app.setFocusEvent(ev.id);
          app.flyTo(vx, vy);
          render(true);
        },
      },
      h('div', { class: 'alert-head' }, h('span', { class: 'alert-title' }, `${eventWhen(ev, today)} · ${ev.label}`), h('span', { class: 'alert-when num' }, fmtCount(ev.attendance))),
      ...lines,
      btn ? h('div', { class: 'ev-actions' }, btn) : null,
    );
    if (isOpen) card.append(editor!.el);
    else if (!canPlan && !over && !(net && net.routes.length)) card.append(h('div', { class: 'ev-line hw-muted' }, 'Event service needs a running route.'));
    return card;
  };

  // ------------------------------------------------------------------ chaos level
  const levelControl = (): HTMLElement => {
    const lv = feed.levels();
    const seg = h('div', { class: 'seg' });
    for (const l of CHAOS.levels) {
      seg.append(h('button', { class: l === lv.next ? 'on' : '', title: LEVEL_HINT[l], onclick: () => { if (l !== game.chaos.level) app.setChaosLevel(l); } }, LEVEL_LABEL[l]));
    }
    return h(
      'div',
      { class: 'chaos-level' },
      seg,
      h('div', { class: 'opt-hint' }, lv.today !== lv.next ? `Today: ${LEVEL_LABEL[lv.today]}. ${LEVEL_LABEL[lv.next]} applies from 3 am.` : 'Changes apply from 3 am.', ' ', h('span', { class: 'hw-muted' }, LEVEL_HINT[lv.next] + '.')),
    );
  };

  // ------------------------------------------------------------------ render
  const render = (force = false) => {
    const k = key();
    if (!force && k === renderedKey) return;
    renderedKey = k;
    const scroll = body.scrollTop;
    const day = feed.day;
    const w = feed.weather();
    const lv = feed.levels();
    sh.titleEl.textContent = `${fmtDate(Math.max(0, day))} · ${weatherLabel(w)} · ${LEVEL_LABEL[lv.today]} chaos`;
    const out: (HTMLElement | null)[] = [];

    if (feed.off) {
      out.push(h('div', { class: 'hw-muted', style: 'margin:6px 0 10px;line-height:1.5' }, 'City chaos is off: no incidents, always clear weather and no special events. Choose a level below; it applies from 3 am.'));
    } else {
      // Now
      const act = feed.active();
      out.push(section(`Now (${act.length})`));
      if (!act.length) out.push(h('div', { class: 'alert-empty' }, h('span', { class: 'dot' }), 'Good service on all lines.'));
      for (const a of act) out.push(alertCard(a.id));

      // Weather
      out.push(section('Weather'));
      const fx = weatherEffects(w);
      const fc = feed.forecast();
      out.push(
        h(
          'div',
          { class: `alert-card tone-info weather-card${focusAlert === day * 1000 ? ' focus' : ''}`, 'data-alert': day * 1000, 'data-kind': w.kind },
          h('span', { class: 'weather-icon' }, svgIcon(WEATHER_ICON[w.kind])),
          h(
            'div',
            { class: 'grow' },
            h('b', null, `${weatherLabel(w)}${w.carried ? ' (continuing)' : ''}. `),
            fx.length ? `${cap(fx.join('; '))}. ` : 'No effect on trains, walking or driving. ',
            h('span', { class: 'hw-muted' }, `${fc.long}: ${forecastText(fc.f).replace(/ (\d+%)$/, ' ($1)')}.`),
          ),
        ),
      );

      // Events
      const evs = feed.events();
      out.push(section(`Events (${evs.length})`));
      if (!evs.length) out.push(h('div', { class: 'hw-muted', style: 'font-size:12.5px' }, `Nothing announced. Events are announced ${EVENTS.announceDays} days ahead (parades 5).`));
      for (const ev of evs) out.push(eventCard(ev));
      if (evs.length) out.push(h('div', { class: 'opt-hint', style: 'margin-top:4px' }, `Fans come by ${city().transitWord} only from stations within ${fmtDistance(EVENTS.venueAccess)} of the venue.`));

      // Earlier today
      const earlier = feed.earlier(now());
      if (earlier.length) {
        out.push(section('Earlier today'));
        const list = h('div', { class: 'list' });
        for (const a of earlier.slice(0, 30)) {
          const row = alertCard(a.id, true);
          if (row) list.append(row);
        }
        out.push(list);
      }
    }

    // City chaos level
    out.push(section('City chaos'), levelControl());
    body.replaceChildren(...out.filter((x): x is HTMLElement => !!x));
    body.scrollTop = scroll;
    if (!scrolledToFocus && (focusAlert !== undefined || focusEv !== null)) {
      scrolledToFocus = true;
      const el = body.querySelector<HTMLElement>(focusEv !== null ? `[data-event="${focusEv}"]` : `[data-alert="${focusAlert}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  };

  // Open on an event: show its venue.
  if (focusEv !== null) {
    const ev = feed.events().find((e) => e.id === focusEv);
    if (ev) {
      const [x, y] = venueLocal(ev);
      app.flyTo(x, y);
    }
  } else if (focusAlert !== undefined) {
    fly(feed.get(focusAlert)?.pos);
  }
  render(true);
  return {
    el: sh.el,
    update: () => {
      // Never rebuild under the editor while it is being used.
      if (editor && editor.el.contains(document.activeElement)) return;
      render();
    },
    dayEnd: () => render(true),
    destroy: () => app.setFocusEvent(null),
  };
}

// ---------------------------------------------------------------------------
// Event service editor

const STEP = 15 * 60;

/** Minutes, with one decimal under 10 ("3.4", "12"). */
function fmtHeadway(s: number): string {
  const m = s / 60;
  return m < 10 ? String(Math.round(m * 10) / 10) : String(Math.round(m));
}

function timeSelect(value: number, onChange: (v: number) => void): HTMLSelectElement {
  const sel = h('select', { class: 'num', onchange: (e: Event) => onChange(Number((e.target as HTMLSelectElement).value)) }) as HTMLSelectElement;
  for (let t = 0; t <= 26 * 3600; t += STEP) sel.append(h('option', { value: String(t) }, fmtClock(t) + (t >= DAY ? ' +1' : '')));
  sel.value = String(Math.max(0, Math.min(26 * 3600, value)));
  return sel;
}

/** The inline editor under an event card: routes, two windows, a headway, the cost, and Run. */
function serviceEditor(app: App, ev: FeedEvent, close: () => void): HTMLElement {
  const net = app.compiled?.net;
  const routes: CRoute[] = net?.routes ?? [];
  const [vx, vy] = venueLocal(ev);
  const nearIds = net ? routesNearVenue(net, vx, vy, EVENTS.serviceRadius).map((r) => r.routeId) : [];
  const dayStart = ev.day * DAY;
  const wins = defaultWindows(ev);
  const st = {
    routes: new Set<number>(nearIds),
    win: [[...wins[0]], [...wins[1]]] as [number, number][],
    // A window already over is off by default.
    use: wins.map((w) => dayStart + w[1] > app.sim.time()),
    hw: EVENTS.serviceHeadway,
  };
  const el = h('div', { class: 'svc-editor', onclick: (e: Event) => e.stopPropagation() });
  const est = h('div', { class: 'svc-est' });
  const run = h('button', { class: 'hw-btn primary small', onclick: () => submit() }, 'Run event service') as HTMLButtonElement;

  const windows = (): [number, number][] => st.win.filter((_, i) => st.use[i]).map(([a, b]) => [dayStart + a, dayStart + b]);

  const renderEstimate = () => {
    const t = app.sim.time();
    const ws = windows();
    const rows: HTMLElement[] = [];
    let total = 0;
    let problem = '';
    if (!st.routes.size) problem = 'Choose at least one route.';
    else if (!ws.length) problem = 'Choose a window.';
    else if (ws.some(([a, b]) => b <= a)) problem = 'A window ends before it starts.';
    else if (ws.every(([, b]) => b <= t)) problem = 'Those windows are over.';
    for (const r of routes) {
      if (!st.routes.has(r.id)) continue;
      let km = 0, cost = 0, needed = 0, owned = r.fleet, eff = st.hw * 60;
      for (const [a, b] of ws) {
        if (b <= a) continue;
        const e = serviceEstimate(r, a, b, st.hw, app.game.routes.get(r.id)?.control.recoveryPct ?? 0);
        km += e.extraCarKm;
        cost += e.cost;
        needed = e.trainsNeeded;
        owned = e.trainsOwned;
        eff = e.effectiveHeadway;
      }
      total += cost;
      const short = eff > st.hw * 60 + 1;
      rows.push(
        h(
          'div',
          { class: 'svc-row' },
          bullet(r.color, r.bullet, 16),
          h(
            'span',
            { class: 'grow' },
            `${needed} trains needed, ${owned} owned`,
            short ? h('span', { class: 'hw-amber' }, ` → effectively every ~${fmtHeadway(eff)} min`) : null,
            ` · +${fmtCarDistance(km)} ≈ ${fmtMoney(cost)}`,
          ),
        ),
      );
    }
    const before = t < dayStart + 3 * 3600;
    est.replaceChildren(
      ...rows,
      rows.length > 1 ? h('div', { class: 'svc-row' }, h('span', { class: 'grow hw-muted' }, `Total ≈ ${fmtMoney(total)} in train operations`)) : '',
      problem ? h('div', { class: 'warn' }, problem) : '',
      h(
        'div',
        { class: 'opt-hint' },
        before
          ? `Planned before 3 am on the day, event service also brings more fans to the ${city().transitWord}.`
          : `Added on the day, it relieves crowding but doesn't change how many fans come by ${city().transitWord} (that was decided at 3 am).`,
        ' Trains come from each route’s own fleet.',
      ),
    );
    run.disabled = !!problem;
  };

  // Routes
  const routeList = h('div', { class: 'svc-routes' });
  for (const r of routes) {
    const cb = h('input', { type: 'checkbox', checked: st.routes.has(r.id) }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      if (cb.checked) st.routes.add(r.id);
      else st.routes.delete(r.id);
      renderEstimate();
    });
    routeList.append(h('label', { class: 'svc-route' }, cb, bullet(r.color, r.bullet, 16), h('span', { class: 'grow' }, r.name), nearIds.includes(r.id) ? h('span', { class: 'hw-muted', style: 'font-size:11px' }, 'near') : null));
  }
  // Windows
  const winRow = (i: number, label: string) => {
    const cb = h('input', { type: 'checkbox', checked: st.use[i] }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      st.use[i] = cb.checked;
      renderEstimate();
    });
    return h(
      'div',
      { class: 'opt-row' },
      h('label', { class: 'opt-label', style: 'display:inline-flex;align-items:center;gap:5px;min-width:72px' }, cb, label),
      timeSelect(st.win[i][0], (v) => { st.win[i][0] = v; renderEstimate(); }),
      '→',
      timeSelect(st.win[i][1], (v) => { st.win[i][1] = v; renderEstimate(); }),
    );
  };
  const hwSel = h('select', { onchange: (e: Event) => { st.hw = Number((e.target as HTMLSelectElement).value); renderEstimate(); } }) as HTMLSelectElement;
  for (const m of OPERATIONS.headwayChoices.filter((x) => x <= 10)) hwSel.append(h('option', { value: String(m) }, `${m} min`));
  hwSel.value = String(st.hw);

  const submit = () => {
    const t = app.sim.time();
    const list = windows()
      .filter(([a, b]) => b > a && b > t)
      .flatMap(([from, to]) => [...st.routes].map((routeId) => ({ routeId, from, to, headwayMin: st.hw, eventId: ev.id })));
    if (!list.length) return;
    app.addEventService(list);
    const names = [...st.routes].map((id) => app.routeRef(id)?.bullet ?? '?').join(' ');
    app.toast('Event service planned', `${names} every ${st.hw} min · ${ev.label}`, 'green');
    close();
  };

  el.append(
    h('div', { class: 'svc-title' }, 'Event service', h('span', { class: 'hw-muted' }, ` · routes stopping within ${fmtDistance(EVENTS.serviceRadius)} are ticked`)),
    routes.length ? routeList : h('div', { class: 'hw-muted' }, 'No running routes.'),
    winRow(0, 'Before'),
    winRow(1, 'After'),
    h('div', { class: 'opt-row' }, h('span', { class: 'opt-label', style: 'min-width:72px' }, 'Every'), hwSel, h('span', { class: 'opt-hint' }, 'never longer than the route’s own')),
    est,
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, run, h('button', { class: 'hw-btn small', onclick: () => close() }, 'Cancel')),
  );
  renderEstimate();
  return el;
}
