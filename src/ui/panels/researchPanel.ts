/**
 * Research (U), full screen: the projects in four branches (trains; track & signalling; stations;
 * costs & the lab), what's being worked on with its progress, and one-click refits to the newest
 * trains once a mark is researched.
 */
import { cityResearch } from '../../cities';
import { RESEARCH_BRANCHES, RESEARCH_TUNING, TRAINS, type ResearchDef } from '../../balance';
import { cantStart, researchCost, researchDef, researchSlots, researchStatus, TRAIN_MARKS_BY_RESEARCH } from '../../core/research';
import { stockSpec, validMark } from '../../core/tech';
import { fmtCount, fmtMoney } from '../../core/units';
import type { App } from '../app';
import { h } from '../dom';
import { refitQuote, refitRoute } from '../routeOps';
import { shell, statCard, type Panel } from './common';

export function researchPanel(app: App): Panel {
  const game = app.game;
  const sh = shell('Your company', 'Research', () => game.select(null));
  const summary = h('div', { class: 'stat-grid mgr-summary' });
  const content = h('div');
  sh.body.append(summary, content);

  const start = (d: ResearchDef) => {
    const why = game.startResearch(d.id);
    if (why) app.toast(`Can't start ${d.name}`, why, 'red');
    else app.toast(game.sandbox ? `${d.name} researched` : `Research started: ${d.name}`, game.sandbox ? d.blurb : `${fmtMoney(researchCost(d.id))} · ${d.days} weekdays`, 'green');
  };

  const cancel = async (d: ResearchDef) => {
    const a = game.research.active.find((x) => x.id === d.id);
    if (!a) return;
    const back = a.paid * RESEARCH_TUNING.cancelRefund;
    if (!(await app.confirm(`Stop researching ${d.name}?`, `${a.daysLeft} weekdays of work are left. ${fmtMoney(back)} of the ${fmtMoney(a.paid)} comes back; the rest is gone.`, 'Stop it', true))) return;
    game.cancelResearch(d.id, RESEARCH_TUNING.cancelRefund);
  };

  /** Routes on older trains of a researched mark, and what refitting them all costs. */
  const refits = (d: ResearchDef) => {
    const m = TRAIN_MARKS_BY_RESEARCH.get(d.id);
    if (!m || researchStatus(game.research, d.id) !== 'done') return null;
    const routes = game.routes.list().filter((r) => r.stock === m.stock && validMark(r.stock, r.mark) < m.mark && refitQuote(r));
    return { routes, cost: routes.reduce((t, r) => t + (refitQuote(r)?.cost ?? 0), 0) };
  };

  const card = (d: ResearchDef) => {
    const st = researchStatus(game.research, d.id);
    const why = st === 'ready' ? cantStart(game.research, d.id, game.finance.cash, game.sandbox) : null;
    const cost = researchCost(d.id);
    const active = game.research.active.find((a) => a.id === d.id);
    const m = TRAIN_MARKS_BY_RESEARCH.get(d.id);
    const spec = m ? stockSpec(m.stock, m.mark) : null;
    const foot: (HTMLElement | string | null)[] = [];
    if (st === 'done') foot.push(h('span', { class: 'rs-done' }, '✓ Researched'));
    else if (st === 'active' && active) {
      const f = 1 - active.daysLeft / d.days;
      foot.push(
        h('div', { class: 'rs-bar' }, h('i', { style: `width:${Math.round(f * 100)}%` })),
        h('span', { class: 'hw-muted' }, `${active.daysLeft} weekday${active.daysLeft === 1 ? '' : 's'} left`),
        h('button', { class: 'hw-btn small ghost', onclick: () => cancel(d) }, 'Stop'),
      );
    } else if (st === 'locked') foot.push(h('span', { class: 'hw-muted' }, `Needs ${(d.requires ?? []).filter((r) => researchStatus(game.research, r) !== 'done').map((r) => researchDef(r).name).join(' and ')}`));
    else {
      const b = h('button', { class: `hw-btn small${why ? '' : ' primary'}`, disabled: !!why, title: why ?? '', onclick: () => start(d) }, game.sandbox ? 'Research (free)' : `Research · ${fmtMoney(cost)}`) as HTMLButtonElement;
      foot.push(b, h('span', { class: 'hw-muted' }, game.sandbox ? 'instant in Sandbox' : `${d.days} weekdays`));
      // Busy teams are said once, in the summary; money is said on the card.
      if (why && !/busy/.test(why)) foot.push(h('span', { class: 'rs-why' }, why));
    }
    const r = refits(d);
    return h(
      'div',
      { class: `rs-card ${st}` },
      h('div', { class: 'rs-name' }, d.name),
      h('div', { class: 'rs-blurb' }, d.blurb),
      spec && m ? h('div', { class: 'rs-spec num' }, `${Math.round(spec.topSpeed * 3.6)} km/h · ${spec.accel.toFixed(2)} m/s² · ${fmtCount(spec.capacityComfort)} a car · ${fmtMoney(spec.costPerCar)} a car`) : null,
      h('div', { class: 'rs-foot' }, ...foot),
      r && r.routes.length
        ? h(
            'div',
            { class: 'rs-refit' },
            h('span', { class: 'grow' }, `${r.routes.length} route${r.routes.length === 1 ? '' : 's'} still on older ${TRAINS[m!.stock].name} trains`),
            h('button', {
              class: 'hw-btn small primary',
              disabled: !game.finance.canAfford(r.cost),
              onclick: () => {
                let n = 0;
                for (const x of r.routes) if (refitRoute(app, x.id)) n++;
                if (n) app.refreshPanel();
              },
            }, `Refit all · ${fmtMoney(r.cost)}`),
          )
        : null,
    );
  };

  const render = () => {
    const s = game.research;
    const slots = researchSlots(s);
    const spent = game.finance.history.reduce((t, d) => t + (d.research ?? 0), 0) + (game.finance.today.research ?? 0);
    const fastest = Math.max(...game.routes.list().map((r) => stockSpec(r.stock, r.mark).topSpeed), 0);
    summary.replaceChildren(
      statCard('Researched', `${s.done.length} of ${cityResearch().length}`, undefined, 'projects finished'),
      statCard(
        'Design teams',
        game.sandbox ? '—' : `${s.active.length} of ${slots} busy`,
        s.active.length < slots && !game.sandbox ? 'amber' : undefined,
        game.sandbox
          ? 'research is instant in Sandbox'
          : s.active.length < slots
            ? 'a team is free: start something'
            : s.active.map((a) => `${researchDef(a.id).name}: ${a.daysLeft} weekdays left`).join(' · ') + (slots < 2 ? '. Research a second team to run two.' : ''),
      ),
      statCard('Spent on research', fmtMoney(spent), undefined, 'net of refunds'),
      statCard('Fastest train running', fastest ? `${Math.round(fastest * 3.6)} km/h` : '—', undefined, 'top speed on your routes'),
    );
    content.replaceChildren();
    const grid = h('div', { class: 'rs-grid' });
    for (const b of RESEARCH_BRANCHES) {
      grid.append(h('div', { class: 'rs-col' }, h('div', { class: 'rs-section' }, b.name), ...cityResearch().filter((d) => d.branch === b.id).map(card)));
    }
    content.append(grid);
    content.append(
      h(
        'div',
        { class: 'mgr-foot' },
        h(
          'span',
          { class: 'hw-muted' },
          `Projects are paid for when they start and take weekdays of work; stopping one returns ${Math.round(RESEARCH_TUNING.cancelRefund * 100)}% of its cost. A new train mark is what new trains come as; refit a route to it for ${Math.round(RESEARCH_TUNING.refitShare * 100)}% of the new cars' price (here, in the route panel or in Routes & stations).`,
        ),
      ),
    );
  };
  render();
  return { el: sh.el, full: true, dayEnd: render };
}

